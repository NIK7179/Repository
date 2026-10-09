import { describe, expect, it } from 'vitest';
import { createKnowledgeRetriever, type EmbeddingProvider, type KnowledgeCandidate, type Repositories } from '@pitch2plan/domain';

const cand = (text: string): KnowledgeCandidate => ({
  chunkId: 'c1', documentVersionId: 'v1', documentId: 'd1', technologySlug: 'aws-msk', sectionTitle: 'S', text, tokenEstimate: 50, injectionScore: 0, embedding: [1, 0], ftsRank: 0.5,
  documentTitle: 'T', url: 'https://docs.aws.amazon.com/x', productVersion: null, retrievedAt: new Date(), checkedAt: new Date(), sourceTitle: 'S', sourceType: 'OFFICIAL_DOCS', provider: 'AWS', trustLevel: 1,
});
const repos = (c: KnowledgeCandidate[]) => ({ knowledge: { searchCandidates: async () => c, listDocuments: async () => [] } }) as unknown as Repositories;
const embedder = (semantic: boolean): EmbeddingProvider => ({ semantic, meta: { provider: 't', model: 't', dimensions: 2, version: 't' }, embed: async (t) => t.map(() => [1, 0]) });
const ctx = { question: 'How do I configure autoscaling for consumers?', technologies: [{ slug: 'aws-msk' }] };

describe('who may vouch for relevance (K2)', () => {
  // The candidate shares ONE of the two topical words ("consumers") and has cosine 1.0 with the query.
  const c = cand('A consumer group shares the partitions of a topic between its members.');
  it('a lexical embedder (semantic: false) cannot make a half-matching chunk relevant, however similar the vectors', async () => {
    const r = await createKnowledgeRetriever({ repos: repos([c]), embedder: embedder(false) }).retrieve(ctx);
    expect(r.stats.candidates).toBe(1);
    expect(r.citations).toEqual([]);
  });
  it('a genuinely semantic embedder may, above the calibrated threshold', async () => {
    const r = await createKnowledgeRetriever({ repos: repos([c]), embedder: embedder(true) }).retrieve(ctx);
    expect(r.citations).toHaveLength(1);
  });
});
