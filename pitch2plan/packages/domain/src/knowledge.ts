import { createHash } from 'node:crypto';
import { TECH_DOCS, TRUST_WEIGHT, chunkDocument, injectionScore, techDocsFor, validateSourceUrl, type KnowledgeAvailability } from '@pitch2plan/schemas';
import { DomainError } from './errors';
import { FetchError } from './knowledge-fetcher';
import { detectProductVersion, extractDocument } from './knowledge-extract';
import type { Logger } from './logger';
import type { DocumentFetcher, EmbeddingProvider, IngestionRunRecord, JobQueue, KnowledgeSourceRecord, Repositories } from './ports';
import { KNOWLEDGE_INGEST_JOB, KNOWLEDGE_REFRESH_JOB, KNOWLEDGE_REINDEX_JOB } from './ports';

export interface KnowledgeConfig {
  /** A document not re-checked for this long is flagged STALE_SOURCE: be cautious, not necessarily wrong. */
  staleDays: number;
  /** The scheduler refreshes a source after this many days. */
  refreshDays: number;
  /** A running ingestion with no heartbeat for this long is failed (retryable). */
  runStaleMs: number;
  /** A manual refresh within this window of the last finished run is refused. */
  refreshCooldownMs: number;
  /** After a failed on-demand ingestion, do not auto-retry for this long (the user can still refresh by hand). */
  failureBackoffMs: number;
  maxChunksPerDocument: number;
  reindexBatch: number;
}
export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  staleDays: 30, refreshDays: 7, runStaleMs: 10 * 60_000, refreshCooldownMs: 5 * 60_000, failureBackoffMs: 10 * 60_000, maxChunksPerDocument: 60, reindexBatch: 64,
};

const JOB_BY_KIND = { INGEST: KNOWLEDGE_INGEST_JOB, REFRESH: KNOWLEDGE_REFRESH_JOB, REINDEX: KNOWLEDGE_REINDEX_JOB } as const;
const SAFE_FAILURE: Record<string, string> = {
  URL_NOT_ALLOWED: 'A documentation page was outside the allowed sources and was skipped.', REDIRECT_NOT_ALLOWED: 'A documentation page redirected outside the allowed sources and was skipped.',
  TOO_MANY_REDIRECTS: 'A documentation page redirected too many times.', HTTP_ERROR: 'The documentation server returned an error.', UNSUPPORTED_CONTENT_TYPE: 'A documentation page was not in a readable format.',
  TOO_LARGE: 'A documentation page was too large to index.', TIMEOUT: 'The documentation server did not answer in time.', NETWORK_ERROR: 'The documentation server could not be reached.',
  FIXTURES_DISABLED: 'Fixture documentation is disabled.', NOT_FOUND: 'A documentation page could not be found.', EMPTY_CONTENT: 'A documentation page had no readable content.',
  QUEUE_UNAVAILABLE: 'The background queue was unavailable. Try again shortly.', STALE_RUN: 'The ingestion stopped responding and was marked failed.', INTERNAL_ERROR: 'Indexing failed unexpectedly.',
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export interface KnowledgeDeps { repos: Repositories; fetcher: DocumentFetcher; embedder: EmbeddingProvider; queue: JobQueue; logger: Logger; config?: Partial<KnowledgeConfig>; now?: () => Date }

/** Ingestion, scheduling and availability. Retrieval lives in knowledge-retrieval.ts and is composed in here. */
export function createIngestionService(deps: KnowledgeDeps) {
  const { repos, fetcher, embedder, queue, logger } = deps;
  const cfg: KnowledgeConfig = { ...DEFAULT_KNOWLEDGE_CONFIG, ...deps.config };
  const now = deps.now ?? (() => new Date());

  /** Self-healing: the source row is (re)created from the in-repo registry whenever it is needed, so a wiped table never breaks the app. */
  async function sourceFor(slug: string): Promise<KnowledgeSourceRecord> {
    const t = techDocsFor(slug);
    if (!t) throw new DomainError('SOURCE_NOT_FOUND', 'No documentation source is configured for this technology.');
    const existing = await repos.knowledge.findSourceBySlug(slug);
    if (existing) return existing;
    return repos.knowledge.upsertSource({ technologySlug: t.slug, name: `${t.displayName} documentation`, sourceType: t.sourceType, provider: t.provider, baseUrl: t.root, allowedDomains: t.domains, trustLevel: TRUST_WEIGHT[t.sourceType], enabled: true });
  }

  async function requestIngestion(input: { slug: string; kind?: IngestionRunRecord['kind']; userId?: string | null }): Promise<{ run: IngestionRunRecord; created: boolean }> {
    const source = await sourceFor(input.slug);
    if (!source.enabled) throw new DomainError('INVALID_STATE', 'This documentation source is disabled.');
    const kind = input.kind ?? 'INGEST';
    const { run, created } = await repos.knowledge.createRun({ sourceId: source.id, kind, requestedById: input.userId ?? null });
    if (!created) return { run, created: false };
    try {
      const jobId = await queue.enqueue(JOB_BY_KIND[kind], { runId: run.id }, { singletonKey: run.id });
      if (jobId) await repos.knowledge.attachJob(run.id, jobId);
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e), slug: input.slug }, 'knowledge enqueue failed');
      // Free the "one active run" slot immediately: a queue outage must not block documentation forever.
      await repos.knowledge.claimRun(run.id, new Date(0));
      await repos.knowledge.finishRun(run.id, { ok: false, code: 'QUEUE_UNAVAILABLE', message: SAFE_FAILURE.QUEUE_UNAVAILABLE!, retryable: true });
      return { run: (await repos.knowledge.findRun(run.id))!, created: true };
    }
    return { run: (await repos.knowledge.findRun(run.id))!, created: true };
  }

  async function ingestPages(source: KnowledgeSourceRecord, runId: string): Promise<{ ok: true; stats: Record<string, unknown> } | { ok: false; code: string; retryable: boolean }> {
    const t = techDocsFor(source.technologySlug)!;
    const stats = { pages: 0, created: 0, newVersions: 0, unchanged: 0, chunks: 0, failedPages: [] as Array<{ url: string; code: string }> };
    let firstFailure: { code: string; retryable: boolean } | null = null;
    const kept: string[] = [];
    for (const seed of t.seedUrls) {
      const check = validateSourceUrl(seed, source.allowedDomains);
      if (!check.ok) { stats.failedPages.push({ url: seed, code: 'URL_NOT_ALLOWED' }); firstFailure ??= { code: 'URL_NOT_ALLOWED', retryable: false }; continue; }
      try {
        const doc = await fetcher.fetch(check.url, { allowedDomains: source.allowedDomains });
        const finalCheck = validateSourceUrl(doc.finalUrl, source.allowedDomains); // never trust the fetcher's word for where it ended up
        if (!finalCheck.ok) throw new FetchError('REDIRECT_NOT_ALLOWED', finalCheck.reason);
        const ex = extractDocument(doc.body, doc.contentType);
        const chunks = chunkDocument(ex.text).slice(0, cfg.maxChunksPerDocument);
        if (!chunks.length) throw new FetchError('NOT_FOUND', 'empty');
        const embedded = await embedder.embed(chunks.map((c) => `${c.sectionTitle ?? ''}\n${c.text}`));
        const title = ex.title || t.displayName;
        const scores = chunks.map((c) => injectionScore(c.text));
        const out = await repos.knowledge.saveVersion({
          sourceId: source.id, technologySlug: source.technologySlug, canonicalUrl: finalCheck.url, title, contentHash: hash(ex.text), productVersion: detectProductVersion(source.technologySlug, finalCheck.url, title),
          publishedAt: ex.publishedAt, sourceUpdatedAt: ex.updatedAt ?? doc.lastModified, retrievedAt: now(), injectionScore: Math.max(0, ...scores), embedding: embedder.meta,
          chunks: chunks.map((c, i) => ({ ...c, injectionScore: scores[i]!, embedding: embedded[i]! })),
        });
        stats.pages++; stats.chunks += chunks.length; kept.push(finalCheck.url);
        if (out.outcome === 'CREATED') stats.created++; else if (out.outcome === 'NEW_VERSION') stats.newVersions++; else stats.unchanged++;
      } catch (e) {
        const code = e instanceof FetchError ? e.code : 'INTERNAL_ERROR';
        if (!(e instanceof FetchError)) logger.error({ err: e instanceof Error ? e.message : String(e), slug: source.technologySlug }, 'knowledge page failed');
        stats.failedPages.push({ url: seed, code });
        firstFailure ??= { code: e instanceof FetchError && e.message === 'empty' ? 'EMPTY_CONTENT' : code, retryable: e instanceof FetchError ? e.retryable : false };
      }
      await repos.knowledge.heartbeat(runId);
    }
    // One page failing never discards the others. Pages are only retired when every seed page was read successfully.
    if (!stats.failedPages.length) await repos.knowledge.markDocumentsRemoved(source.id, kept);
    if (!stats.pages) return { ok: false, code: firstFailure?.code ?? 'INTERNAL_ERROR', retryable: firstFailure?.retryable ?? false };
    await repos.knowledge.markSourceIngested(source.id, now());
    return { ok: true, stats };
  }

  async function reindex(source: KnowledgeSourceRecord, runId: string) {
    let updated = 0;
    for (;;) {
      const batch = await repos.knowledge.chunksNeedingEmbedding(source.id, embedder.meta.version, cfg.reindexBatch);
      if (!batch.length) break;
      const vecs = await embedder.embed(batch.map((c) => `${c.sectionTitle ?? ''}\n${c.text}`));
      await repos.knowledge.setEmbeddings(batch.map((c, i) => ({ id: c.id, embedding: vecs[i]! })), embedder.meta);
      updated += batch.length; await repos.knowledge.heartbeat(runId);
    }
    return { ok: true as const, stats: { reindexed: updated, embeddingVersion: embedder.meta.version } };
  }

  return {
    config: cfg, sourceFor, requestIngestion,

    /** Worker entry point. Safe to call twice: only one caller can claim the run, and a finished run never changes. */
    async runIngestion(runId: string): Promise<{ outcome: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' }> {
      const claimed = await repos.knowledge.claimRun(runId, new Date(now().getTime() - cfg.runStaleMs));
      if (!claimed) return { outcome: 'SKIPPED' };
      const source = await repos.knowledge.findSource(claimed.sourceId);
      if (!source || !source.enabled) { await repos.knowledge.finishRun(runId, { ok: false, code: 'NOT_FOUND', message: SAFE_FAILURE.NOT_FOUND!, retryable: false }); return { outcome: 'FAILED' }; }
      try {
        const res = claimed.kind === 'REINDEX' ? await reindex(source, runId) : await ingestPages(source, runId);
        if (res.ok) { await repos.knowledge.finishRun(runId, { ok: true, stats: res.stats }); return { outcome: 'SUCCEEDED' }; }
        await repos.knowledge.finishRun(runId, { ok: false, code: res.code, message: SAFE_FAILURE[res.code] ?? SAFE_FAILURE.INTERNAL_ERROR!, retryable: res.retryable });
        return { outcome: 'FAILED' };
      } catch (e) {
        logger.error({ err: e instanceof Error ? e.message : String(e), runId }, 'knowledge ingestion crashed');
        await repos.knowledge.finishRun(runId, { ok: false, code: 'INTERNAL_ERROR', message: SAFE_FAILURE.INTERNAL_ERROR!, retryable: true });
        return { outcome: 'FAILED' };
      }
    },

    async recoverStale(): Promise<number> { return (await repos.knowledge.failStaleRuns(new Date(now().getTime() - cfg.runStaleMs))).length; },

    async scheduleDueRefreshes(): Promise<number> {
      const due = await repos.knowledge.sourcesDueForRefresh(new Date(now().getTime() - cfg.refreshDays * 86_400_000));
      let n = 0; for (const s of due) { const r = await requestIngestion({ slug: s.technologySlug, kind: 'REFRESH' }); if (r.created) n++; }
      return n;
    },

    /** Where documentation for each technology stands. Never blocks: missing docs enqueue ingestion and report PREPARING. */
    async ensureIndexed(slugs: string[]): Promise<Record<string, KnowledgeAvailability>> {
      const out: Record<string, KnowledgeAvailability> = {};
      for (const slug of [...new Set(slugs)]) {
        if (!techDocsFor(slug)) { out[slug] = 'NOT_COVERED'; continue; }
        try {
          const source = await sourceFor(slug);
          if ((await repos.knowledge.countActiveDocuments(slug)) > 0) { out[slug] = 'READY'; continue; }
          const last = await repos.knowledge.latestRun(source.id);
          if (last && (last.status === 'PENDING' || last.status === 'RUNNING')) { out[slug] = 'PREPARING'; continue; }
          if (last?.status === 'FAILED' && now().getTime() - (last.finishedAt ?? last.createdAt).getTime() < cfg.failureBackoffMs) { out[slug] = 'UNAVAILABLE'; continue; }
          const r = await requestIngestion({ slug });
          out[slug] = r.run.status === 'FAILED' ? 'UNAVAILABLE' : 'PREPARING';
        } catch (e) { logger.warn({ err: e instanceof Error ? e.message : String(e), slug }, 'ensureIndexed failed'); out[slug] = 'UNAVAILABLE'; }
      }
      return out;
    },

    /** Manual refresh with a cooldown, so a button cannot be used to hammer documentation hosts. */
    async refreshSource(slug: string, userId: string): Promise<IngestionRunRecord> {
      const source = await sourceFor(slug);
      const last = await repos.knowledge.latestRun(source.id);
      if (last && (last.status === 'PENDING' || last.status === 'RUNNING')) return last;
      if (last?.finishedAt && now().getTime() - last.finishedAt.getTime() < cfg.refreshCooldownMs) throw new DomainError('REFRESH_TOO_SOON', 'This documentation was refreshed moments ago. Try again in a few minutes.');
      return (await requestIngestion({ slug, kind: 'REFRESH', userId })).run;
    },

    async requestReindex(slug: string): Promise<IngestionRunRecord> { return (await requestIngestion({ slug, kind: 'REINDEX' })).run; },
    async latestRunFor(slug: string): Promise<IngestionRunRecord | null> { const s = await repos.knowledge.findSourceBySlug(slug); return s ? repos.knowledge.latestRun(s.id) : null; },
    registry: () => TECH_DOCS,
  };
}
export type IngestionService = ReturnType<typeof createIngestionService>;
