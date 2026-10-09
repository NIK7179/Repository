import { DomainError } from '@pitch2plan/domain';
import { getEnv } from '@/server/env';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** Indexing diagnostics. Off unless KNOWLEDGE_DIAGNOSTICS=true; answers 404 (not 403) when off so its existence is not advertised. */
export const GET = api({ action: 'knowledge.status' }, async () => {
  if (getEnv().KNOWLEDGE_DIAGNOSTICS !== 'true') throw new DomainError('SOURCE_NOT_FOUND', 'Not found.');
  const o = await getContainer().app.knowledge.access.status();
  return { sources: o.sources.map((s) => ({ technologySlug: s.technologySlug, name: s.name, enabled: s.enabled, documents: s.documents, chunks: s.chunks, embeddingModels: s.embeddingModels, lastIngestedAt: s.lastIngestedAt, lastRun: s.lastRun && { status: s.lastRun.status, kind: s.lastRun.kind, failureCode: s.lastRun.failureCode, finishedAt: s.lastRun.finishedAt } })), retrievals: o.retrievals };
});
