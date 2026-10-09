import {
  DEFAULT_CONTEXT_BUDGET, buildCitations, buildKnowledgeQuery, rankCandidates, selectWithinBudget, isStale, techDocsFor,
  type CitationDraft, type ContextBudget, type DocumentationRef, type KnowledgeAvailability, type KnowledgeContext, type KnowledgeQuery, type RankedCandidate, type VersionNote,
} from '@pitch2plan/schemas';
import type { EmbeddingProvider, Repositories } from './ports';

export interface RetrievalConfig { staleDays: number; candidateLimit: number; budget: ContextBudget; semanticRelevance: number }
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = { staleDays: 30, candidateLimit: 60, budget: DEFAULT_CONTEXT_BUDGET, semanticRelevance: 0.35 };

export interface RetrievalStats {
  candidates: number; relevant: number; selected: number; tokens: number; quarantined: number; sources: number; durationMs: number;
  technologyMatch: boolean; versionMatch: VersionNote | 'NONE';
}
export interface RetrievalResult {
  query: KnowledgeQuery; selected: RankedCandidate[]; citations: CitationDraft[]; texts: Map<string, string>; stats: RetrievalStats;
}

export function createKnowledgeRetriever(deps: { repos: Repositories; embedder: EmbeddingProvider; config?: Partial<RetrievalConfig>; now?: () => Date }) {
  const { repos, embedder } = deps;
  const cfg: RetrievalConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...deps.config };
  const now = deps.now ?? (() => new Date());

  /**
   * Contextual retrieval: the query is built from the project context, not just the raw question. Candidates come from full-text search restricted to the
   * technologies in play; ranking is hybrid; the relevance gate (schemas/knowledge.ts) decides what may be cited; the budget decides how much the model sees.
   */
  async function retrieve(ctx: KnowledgeContext): Promise<RetrievalResult> {
    const started = Date.now();
    const query = buildKnowledgeQuery(ctx);
    const candidates = query.terms.length ? await repos.knowledge.searchCandidates({ technologySlugs: query.technologySlugs, terms: query.terms, limit: cfg.candidateLimit }) : [];
    const [qv] = candidates.length ? await embedder.embed([query.text]) : [[] as number[]];
    const ranked = rankCandidates(candidates, query, qv ?? [], now(), cfg.staleDays, { semanticRelevance: embedder.semantic ? cfg.semanticRelevance : null });
    const { selected, quarantined, tokens } = selectWithinBudget(ranked, cfg.budget);
    const citations = buildCitations(selected);
    const notes = selected.map((s) => s.versionNote);
    return {
      query, selected, citations, texts: new Map(selected.map((s) => [s.chunkId, s.text])),
      stats: {
        candidates: candidates.length, relevant: ranked.filter((r) => r.score.relevant).length, selected: selected.length, tokens, quarantined, sources: new Set(selected.map((s) => s.url)).size, durationMs: Date.now() - started,
        technologyMatch: selected.length > 0 && selected.some((s) => s.technologySlug === query.technologySlugs[0]),
        versionMatch: !selected.length ? 'NONE' : notes.includes('MATCHED') ? 'MATCHED' : notes.includes('MISMATCH') ? 'MISMATCH' : notes.includes('DOC_VERSION_UNKNOWN') ? 'DOC_VERSION_UNKNOWN' : 'NO_VERSION_REQUESTED',
      },
    };
  }

  const toRef = (d: { title: string; url: string; sourceTitle: string; sourceType: DocumentationRef['sourceType']; technologySlug: string; provider: string; productVersion: string | null; checkedAt: Date; sectionTitle?: string | null }): DocumentationRef => ({
    title: d.title, url: d.url, sourceTitle: d.sourceTitle, sourceType: d.sourceType, technologySlug: d.technologySlug, provider: d.provider, version: d.productVersion, sectionTitle: d.sectionTitle ?? null,
    retrievedAt: d.checkedAt.toISOString(), stale: isStale(d.checkedAt, now(), cfg.staleDays),
  });

  /**
   * A few relevant documents for a task/component (never a dump). Documents that matched the context come first; when nothing matches, a small
   * general-reference list for the technology is returned and labelled as such, so the UI never implies a match that does not exist.
   */
  async function documentsFor(ctx: KnowledgeContext, limit = 4): Promise<{ documents: Array<DocumentationRef & { matched: boolean }>; stats: RetrievalStats }> {
    const r = await retrieve({ ...ctx, question: ctx.question || [ctx.stepTitle, ctx.taskTitle, ctx.componentName].filter(Boolean).join(' ') });
    const seen = new Set<string>(); const docs: Array<DocumentationRef & { matched: boolean }> = [];
    for (const c of r.selected) {
      if (seen.has(c.documentId)) continue; seen.add(c.documentId);
      docs.push({ ...toRef({ title: c.documentTitle, url: c.url, sourceTitle: c.sourceTitle, sourceType: c.sourceType, technologySlug: c.technologySlug, provider: c.provider, productVersion: c.productVersion, checkedAt: new Date(c.checkedAt), sectionTitle: c.sectionTitle }), matched: true });
      if (docs.length >= limit) break;
    }
    if (!docs.length) {
      for (const d of await repos.knowledge.listDocuments(r.query.technologySlugs, limit)) docs.push({ ...toRef(d), matched: false });
    }
    return { documents: docs, stats: r.stats };
  }

  return { retrieve, documentsFor, config: cfg, technologyName: (slug: string) => techDocsFor(slug)?.displayName ?? slug };
}
export type KnowledgeRetriever = ReturnType<typeof createKnowledgeRetriever>;
export type { KnowledgeAvailability };
