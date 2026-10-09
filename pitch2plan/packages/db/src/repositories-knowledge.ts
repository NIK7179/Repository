import type { CitationRecord, IngestionRunRecord, KnowledgeCandidate, KnowledgeRepositories, KnowledgeSourceRecord } from '@pitch2plan/domain';
import { sourceTypeSchema } from '@pitch2plan/schemas';
import { z } from 'zod';
import type { PrismaClient } from './client';
import { Prisma } from './generated/client';

const isUnique = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
const json = (v: unknown) => v as Prisma.InputJsonValue;
const strings = z.array(z.string());

const toSource = (s: Prisma.KnowledgeSourceGetPayload<object>): KnowledgeSourceRecord => ({
  id: s.id, technologySlug: s.technologySlug, name: s.name, sourceType: sourceTypeSchema.parse(s.sourceType), provider: s.provider, baseUrl: s.baseUrl,
  allowedDomains: strings.parse(s.allowedDomains), trustLevel: s.trustLevel, enabled: s.enabled, lastIngestedAt: s.lastIngestedAt,
});
const toRun = (r: Prisma.KnowledgeIngestionRunGetPayload<object>): IngestionRunRecord => ({
  id: r.id, sourceId: r.sourceId, kind: r.kind as IngestionRunRecord['kind'], status: r.status as IngestionRunRecord['status'], attempt: r.attempt, failureCode: r.failureCode, failureMessage: r.failureMessage,
  retryable: r.retryable, jobId: r.jobId, stats: (r.stats ?? null) as Record<string, unknown> | null, createdAt: r.createdAt, startedAt: r.startedAt, heartbeatAt: r.heartbeatAt, finishedAt: r.finishedAt,
});
const toCitation = (c: Prisma.KnowledgeCitationGetPayload<object>): CitationRecord => ({
  id: c.id, projectId: c.projectId, userId: c.userId, messageId: c.messageId, n: c.n, chunkId: c.chunkId, documentVersionId: c.documentVersionId, snapshot: c.snapshot as Record<string, unknown>, createdAt: c.createdAt,
});

interface CandidateRow {
  id: string; documentVersionId: string; documentId: string; technologySlug: string; sectionTitle: string | null; text: string; tokenEstimate: number; injectionScore: number; embedding: number[];
  rank: number; documentTitle: string; url: string; productVersion: string | null; retrievedAt: Date; checkedAt: Date; sourceTitle: string; sourceType: string; provider: string; trustLevel: number;
}
const toCandidate = (r: CandidateRow): KnowledgeCandidate => ({
  chunkId: r.id, documentVersionId: r.documentVersionId, documentId: r.documentId, technologySlug: r.technologySlug, sectionTitle: r.sectionTitle, text: r.text, tokenEstimate: r.tokenEstimate,
  injectionScore: r.injectionScore, embedding: (r.embedding ?? []).map(Number), ftsRank: Number(r.rank), documentTitle: r.documentTitle, url: r.url, productVersion: r.productVersion,
  retrievedAt: r.retrievedAt, checkedAt: r.checkedAt, sourceTitle: r.sourceTitle, sourceType: sourceTypeSchema.parse(r.sourceType), provider: r.provider, trustLevel: r.trustLevel,
});
const SELECT = (rank: Prisma.Sql) => Prisma.sql`SELECT c.id, c."documentVersionId", c."documentId", c."technologySlug", c."sectionTitle", c.text, c."tokenEstimate", c."injectionScore", c.embedding, ${rank} AS rank,
  d.title AS "documentTitle", d."canonicalUrl" AS url, v."productVersion", v."retrievedAt", d."checkedAt", s.name AS "sourceTitle", s."sourceType", s.provider, s."trustLevel"
  FROM "KnowledgeChunk" c
  JOIN "KnowledgeDocumentVersion" v ON v.id = c."documentVersionId" AND v.status = 'ACTIVE'
  JOIN "KnowledgeDocument" d ON d.id = c."documentId" AND d.status = 'ACTIVE'
  JOIN "KnowledgeSource" s ON s.id = d."sourceId" AND s.enabled`;

/** Words only: the tsquery is built from sanitized tokens, never from raw user text. */
export const toTsQuery = (terms: string[]): string => [...new Set(terms.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 2))].slice(0, 24).join(' | ');

export function createKnowledgeRepositories(prisma: PrismaClient): KnowledgeRepositories {
  const k: KnowledgeRepositories['knowledge'] = {
    async upsertSource(input) {
      const data = { name: input.name, sourceType: input.sourceType, provider: input.provider, baseUrl: input.baseUrl, allowedDomains: json(input.allowedDomains), trustLevel: input.trustLevel, enabled: input.enabled };
      return toSource(await prisma.knowledgeSource.upsert({ where: { technologySlug: input.technologySlug }, create: { technologySlug: input.technologySlug, ...data }, update: data }));
    },
    async findSourceBySlug(slug) { const s = await prisma.knowledgeSource.findUnique({ where: { technologySlug: slug } }); return s ? toSource(s) : null; },
    async findSource(id) { const s = await prisma.knowledgeSource.findUnique({ where: { id } }); return s ? toSource(s) : null; },
    async listSources() { return (await prisma.knowledgeSource.findMany({ orderBy: { technologySlug: 'asc' } })).map(toSource); },

    async saveVersion(input) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await prisma.$transaction(async (tx) => {
            const doc = await tx.knowledgeDocument.upsert({
              where: { sourceId_canonicalUrl: { sourceId: input.sourceId, canonicalUrl: input.canonicalUrl } },
              create: { sourceId: input.sourceId, technologySlug: input.technologySlug, canonicalUrl: input.canonicalUrl, title: input.title, checkedAt: input.retrievedAt },
              update: { title: input.title, status: 'ACTIVE', checkedAt: input.retrievedAt },
            });
            const active = await tx.knowledgeDocumentVersion.findFirst({ where: { documentId: doc.id, status: 'ACTIVE' }, orderBy: { versionNumber: 'desc' } });
            if (active && active.contentHash === input.contentHash) return { documentId: doc.id, versionId: active.id, versionNumber: active.versionNumber, outcome: 'UNCHANGED' as const };
            const latest = await tx.knowledgeDocumentVersion.findFirst({ where: { documentId: doc.id }, orderBy: { versionNumber: 'desc' } });
            if (active) {
              await tx.knowledgeChunk.deleteMany({ where: { documentVersionId: active.id } }); // superseded versions leave the index
              await tx.knowledgeDocumentVersion.update({ where: { id: active.id }, data: { status: 'SUPERSEDED' } });
            }
            const v = await tx.knowledgeDocumentVersion.create({
              data: { documentId: doc.id, versionNumber: (latest?.versionNumber ?? 0) + 1, contentHash: input.contentHash, title: input.title, productVersion: input.productVersion, publishedAt: input.publishedAt,
                sourceUpdatedAt: input.sourceUpdatedAt, retrievedAt: input.retrievedAt, chunkCount: input.chunks.length, injectionScore: input.injectionScore },
            });
            await tx.knowledgeChunk.createMany({
              data: input.chunks.map((c) => ({
                documentVersionId: v.id, documentId: doc.id, technologySlug: input.technologySlug, ordinal: c.ordinal, sectionTitle: c.sectionTitle, text: c.text, tokenEstimate: c.tokenEstimate,
                injectionScore: c.injectionScore, embedding: c.embedding, embeddingProvider: input.embedding.provider, embeddingModel: input.embedding.model, embeddingDimensions: input.embedding.dimensions,
                embeddingVersion: input.embedding.version,
              })),
            });
            return { documentId: doc.id, versionId: v.id, versionNumber: v.versionNumber, outcome: (active || latest ? 'NEW_VERSION' : 'CREATED') as 'NEW_VERSION' | 'CREATED' };
          });
        } catch (e) { if (isUnique(e) && attempt < 2) continue; throw e; } // a concurrent ingest of the same page: re-read and compare hashes
      }
    },
    async markDocumentsRemoved(sourceId, keepUrls) {
      const r = await prisma.knowledgeDocument.updateMany({ where: { sourceId, status: 'ACTIVE', canonicalUrl: { notIn: keepUrls } }, data: { status: 'REMOVED' } });
      return r.count;
    },
    async markSourceIngested(sourceId, at) { await prisma.knowledgeSource.update({ where: { id: sourceId }, data: { lastIngestedAt: at } }); },

    async searchCandidates({ technologySlugs, terms, limit }) {
      const q = toTsQuery(terms);
      if (!q || !technologySlugs.length) return [];
      const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`${SELECT(Prisma.sql`ts_rank(c.tsv, to_tsquery('english', ${q}))`)}
        WHERE c."technologySlug" = ANY(${technologySlugs}::text[]) AND c.tsv @@ to_tsquery('english', ${q})
        ORDER BY rank DESC, c.id ASC LIMIT ${limit}`);
      return rows.map(toCandidate);
    },
    async listDocuments(technologySlugs, limit) {
      if (!technologySlugs.length) return [];
      const docs = await prisma.knowledgeDocument.findMany({
        where: { technologySlug: { in: technologySlugs }, status: 'ACTIVE', source: { enabled: true } },
        include: { source: true, versions: { where: { status: 'ACTIVE' }, take: 1, orderBy: { versionNumber: 'desc' } } }, orderBy: [{ technologySlug: 'asc' }, { canonicalUrl: 'asc' }], take: limit,
      });
      return docs.filter((d) => d.versions[0]).map((d) => {
        const v = d.versions[0]!;
        return { documentId: d.id, versionId: v.id, technologySlug: d.technologySlug, title: d.title, url: d.canonicalUrl, productVersion: v.productVersion, retrievedAt: v.retrievedAt, checkedAt: d.checkedAt,
          sourceTitle: d.source.name, sourceType: sourceTypeSchema.parse(d.source.sourceType), provider: d.source.provider, trustLevel: d.source.trustLevel, chunkCount: v.chunkCount };
      });
    },
    async countActiveDocuments(slug) { return prisma.knowledgeDocument.count({ where: { technologySlug: slug, status: 'ACTIVE' } }); },
    async getChunk(id) {
      const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`${SELECT(Prisma.sql`0::float8`)} WHERE c.id = ${id}::uuid`);
      return rows[0] ? toCandidate(rows[0]) : null;
    },

    async createRun({ sourceId, kind, requestedById }) {
      try { return { run: toRun(await prisma.knowledgeIngestionRun.create({ data: { sourceId, kind, requestedById: requestedById ?? null } })), created: true }; }
      catch (e) {
        if (!isUnique(e)) throw e;
        const active = await prisma.knowledgeIngestionRun.findFirst({ where: { sourceId, status: { in: ['PENDING', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } });
        if (!active) return k.createRun({ sourceId, kind, requestedById });
        return { run: toRun(active), created: false };
      }
    },
    async attachJob(runId, jobId) { await prisma.knowledgeIngestionRun.updateMany({ where: { id: runId, jobId: null }, data: { jobId } }); },
    async findRun(id) { const r = await prisma.knowledgeIngestionRun.findUnique({ where: { id } }); return r ? toRun(r) : null; },
    async latestRun(sourceId) { const r = await prisma.knowledgeIngestionRun.findFirst({ where: { sourceId }, orderBy: { createdAt: 'desc' } }); return r ? toRun(r) : null; },
    async claimRun(id, staleBefore) {
      const now = new Date();
      const r = await prisma.knowledgeIngestionRun.updateMany({
        where: { id, OR: [{ status: 'PENDING' }, { status: 'RUNNING', heartbeatAt: { lt: staleBefore } }] },
        data: { status: 'RUNNING', startedAt: now, heartbeatAt: now, attempt: { increment: 1 }, failureCode: null, failureMessage: null },
      });
      return r.count === 1 ? k.findRun(id) : null;
    },
    async heartbeat(id) { await prisma.knowledgeIngestionRun.updateMany({ where: { id, status: 'RUNNING' }, data: { heartbeatAt: new Date() } }); },
    async finishRun(id, outcome) {
      const data = outcome.ok
        ? { status: 'SUCCEEDED', stats: json(outcome.stats), finishedAt: new Date() }
        : { status: 'FAILED', failureCode: outcome.code, failureMessage: outcome.message.slice(0, 300), retryable: outcome.retryable, finishedAt: new Date() };
      return (await prisma.knowledgeIngestionRun.updateMany({ where: { id, status: 'RUNNING' }, data })).count === 1; // compare-and-set: a finished run never changes again
    },
    async failStaleRuns(staleBefore) {
      const stale = await prisma.knowledgeIngestionRun.findMany({ where: { OR: [{ status: 'RUNNING', heartbeatAt: { lt: staleBefore } }, { status: 'PENDING', createdAt: { lt: staleBefore } }] } });
      const out: IngestionRunRecord[] = [];
      for (const r of stale) {
        const done = await prisma.knowledgeIngestionRun.updateMany({
          where: { id: r.id, status: r.status },
          data: { status: 'FAILED', failureCode: 'STALE_RUN', failureMessage: 'The ingestion stopped responding and was marked failed.', retryable: true, finishedAt: new Date() },
        });
        if (done.count === 1) out.push(toRun({ ...r, status: 'FAILED', failureCode: 'STALE_RUN', retryable: true }));
      }
      return out;
    },
    async sourcesDueForRefresh(olderThan) {
      return (await prisma.knowledgeSource.findMany({ where: { enabled: true, lastIngestedAt: { lt: olderThan }, runs: { none: { status: { in: ['PENDING', 'RUNNING'] } } } } })).map(toSource);
    },

    async chunksNeedingEmbedding(sourceId, currentVersion, limit) {
      return prisma.knowledgeChunk.findMany({
        where: { embeddingVersion: { not: currentVersion }, documentVersion: { status: 'ACTIVE', document: { sourceId } } }, select: { id: true, text: true, sectionTitle: true }, take: limit, orderBy: { id: 'asc' },
      });
    },
    async setEmbeddings(items, meta) {
      await prisma.$transaction(items.map((i) => prisma.knowledgeChunk.update({
        where: { id: i.id }, data: { embedding: i.embedding, embeddingProvider: meta.provider, embeddingModel: meta.model, embeddingDimensions: meta.dimensions, embeddingVersion: meta.version },
      })));
    },

    async saveCitations(items) {
      if (!items.length) return;
      await prisma.knowledgeCitation.createMany({ data: items.map((c) => ({ id: c.id, projectId: c.projectId, userId: c.userId, messageId: c.messageId ?? null, n: c.n, chunkId: c.chunkId, documentVersionId: c.documentVersionId, snapshot: json(c.snapshot) })), skipDuplicates: true });
    },
    async getCitation(id) { const c = await prisma.knowledgeCitation.findUnique({ where: { id } }); return c ? toCitation(c) : null; },
    async listCitations(ids) { return (await prisma.knowledgeCitation.findMany({ where: { id: { in: ids } }, orderBy: { n: 'asc' } })).map(toCitation); },
    async recordRetrieval(i) {
      await prisma.knowledgeRetrievalRun.create({ data: { projectId: i.projectId ?? null, userId: i.userId, scope: i.scope, technologySlugs: json(i.technologySlugs), candidateCount: i.candidateCount, selectedCount: i.selectedCount,
        durationMs: i.durationMs, technologyMatch: i.technologyMatch, versionMatch: i.versionMatch, groundingStatus: i.groundingStatus, citationCount: i.citationCount } });
    },
    async overview() {
      const sources = await prisma.knowledgeSource.findMany({ orderBy: { technologySlug: 'asc' } });
      const out = [];
      for (const s of sources) {
        const [documents, chunks, lastRun, models] = await Promise.all([
          prisma.knowledgeDocument.count({ where: { sourceId: s.id, status: 'ACTIVE' } }),
          prisma.knowledgeChunk.count({ where: { documentVersion: { status: 'ACTIVE', document: { sourceId: s.id } } } }),
          k.latestRun(s.id),
          prisma.knowledgeChunk.findMany({ where: { documentVersion: { status: 'ACTIVE', document: { sourceId: s.id } } }, distinct: ['embeddingModel'], select: { embeddingModel: true } }),
        ]);
        out.push({ ...toSource(s), documents, chunks, lastRun, embeddingModels: models.map((m) => m.embeddingModel) });
      }
      const [total, grounded] = await Promise.all([prisma.knowledgeRetrievalRun.count(), prisma.knowledgeRetrievalRun.count({ where: { groundingStatus: 'GROUNDED' } })]);
      return { sources: out, retrievals: { total, grounded } };
    },
  };
  return { knowledge: k };
}
