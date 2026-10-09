import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, createRepositories } from '@pitch2plan/db';
import type { ChunkInput, SaveVersionInput } from '@pitch2plan/domain';
import { makeApp, signUp } from '../helpers';

const prisma = createPrismaClient(process.env.DATABASE_URL!);
const repos = createRepositories(prisma);
const k = repos.knowledge;
afterAll(() => prisma.$disconnect());

const EMB = { provider: 'local', model: 'test', dimensions: 4, version: 'v1' };
const chunk = (i: number, text: string, section: string | null = 'Sec'): ChunkInput => ({ ordinal: i, sectionTitle: section, text, tokenEstimate: Math.ceil(text.length / 4), injectionScore: 0, embedding: [1, 0, 0, 0] });
async function source(slug = 'apache-kafka') {
  return k.upsertSource({ technologySlug: slug, name: `${slug} docs`, sourceType: 'OFFICIAL_DOCS', provider: 'Apache', baseUrl: 'https://kafka.apache.org/', allowedDomains: ['kafka.apache.org'], trustLevel: 1, enabled: true });
}
const input = (sourceId: string, over: Partial<SaveVersionInput> = {}): SaveVersionInput => ({
  sourceId, technologySlug: 'apache-kafka', canonicalUrl: 'https://kafka.apache.org/documentation/', title: '[Test fixture] Kafka', contentHash: 'h1', productVersion: null, publishedAt: null, sourceUpdatedAt: null,
  retrievedAt: new Date(), injectionScore: 0, embedding: EMB, chunks: [chunk(0, 'Consumer lag is the difference between the log end offset and the committed offset.')], ...over,
});

beforeEach(async () => { await prisma.$executeRawUnsafe('TRUNCATE "KnowledgeSource" CASCADE'); });

describe('document versioning', () => {
  it('creates a new version only when the content hash changes', async () => {
    const s = await source();
    const a = await k.saveVersion(input(s.id));
    expect(a.outcome).toBe('CREATED');
    const same = await k.saveVersion(input(s.id));
    expect(same.outcome).toBe('UNCHANGED');
    expect(same.versionId).toBe(a.versionId);
    const changed = await k.saveVersion(input(s.id, { contentHash: 'h2', chunks: [chunk(0, 'Partitions are the unit of parallelism for a topic.')] }));
    expect(changed.outcome).toBe('NEW_VERSION');
    expect(changed.versionNumber).toBe(2);
    expect(await prisma.knowledgeDocumentVersion.count()).toBe(2);
  });

  it('removes superseded chunks from the index but keeps the superseded version row', async () => {
    const s = await source();
    await k.saveVersion(input(s.id));
    await k.saveVersion(input(s.id, { contentHash: 'h2', chunks: [chunk(0, 'Partitions are the unit of parallelism for a topic.')] }));
    const hits = await k.searchCandidates({ technologySlugs: ['apache-kafka'], terms: ['consumer', 'lag'], limit: 10 });
    expect(hits).toHaveLength(0); // the old text is gone from retrieval
    const parts = await k.searchCandidates({ technologySlugs: ['apache-kafka'], terms: ['partitions'], limit: 10 });
    expect(parts).toHaveLength(1);
    const versions = await prisma.knowledgeDocumentVersion.findMany({ orderBy: { versionNumber: 'asc' } });
    expect(versions.map((v) => v.status)).toEqual(['SUPERSEDED', 'ACTIVE']);
  });

  it('refuses to rewrite a version\'s content (database trigger), but allows superseding it', async () => {
    const s = await source();
    const a = await k.saveVersion(input(s.id));
    await expect(prisma.knowledgeDocumentVersion.update({ where: { id: a.versionId }, data: { contentHash: 'tampered' } })).rejects.toThrow(/immutable/);
    await expect(prisma.knowledgeDocumentVersion.update({ where: { id: a.versionId }, data: { status: 'SUPERSEDED' } })).resolves.toBeTruthy();
  });

  it('unchanged content still refreshes checkedAt, so staleness is measured from the last check', async () => {
    const s = await source();
    await k.saveVersion(input(s.id, { retrievedAt: new Date('2026-01-01T00:00:00Z') }));
    await k.saveVersion(input(s.id, { retrievedAt: new Date('2026-10-01T00:00:00Z') }));
    const [d] = await k.listDocuments(['apache-kafka'], 5);
    expect(d!.checkedAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(d!.retrievedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a concurrent ingest of the same page does not create duplicate versions', async () => {
    const s = await source();
    const results = await Promise.all(Array.from({ length: 4 }, () => k.saveVersion(input(s.id))));
    expect(results.filter((r) => r.outcome === 'CREATED')).toHaveLength(1);
    expect(await prisma.knowledgeDocumentVersion.count()).toBe(1);
    expect(await prisma.knowledgeChunk.count()).toBe(1);
  });

  it('pages that disappear are marked REMOVED and leave retrieval', async () => {
    const s = await source();
    await k.saveVersion(input(s.id));
    await k.saveVersion(input(s.id, { canonicalUrl: 'https://kafka.apache.org/other', chunks: [chunk(0, 'Replication factor controls durability of each partition.')] }));
    expect(await k.markDocumentsRemoved(s.id, ['https://kafka.apache.org/documentation/'])).toBe(1);
    expect(await k.searchCandidates({ technologySlugs: ['apache-kafka'], terms: ['replication'], limit: 5 })).toHaveLength(0);
  });
});

describe('full-text candidates', () => {
  it('only returns chunks that share a real term, filtered by technology', async () => {
    const s = await source();
    await k.saveVersion(input(s.id, { chunks: [chunk(0, 'Consumer lag is the difference between offsets.'), chunk(1, 'Bananas are yellow fruit grown in warm climates.', 'Fruit')] }));
    const other = await source('postgresql');
    await k.saveVersion(input(other.id, { technologySlug: 'postgresql', canonicalUrl: 'https://www.postgresql.org/docs/x', chunks: [chunk(0, 'Consumer lag is not a postgres concept but the words match.')] }));
    const hits = await k.searchCandidates({ technologySlugs: ['apache-kafka'], terms: ['consumer', 'lag'], limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.technologySlug).toBe('apache-kafka');
    expect(hits[0]!.ftsRank).toBeGreaterThan(0);
    expect(await k.searchCandidates({ technologySlugs: ['apache-kafka'], terms: ['zebra'], limit: 10 })).toHaveLength(0);
    expect(await k.searchCandidates({ technologySlugs: [], terms: ['consumer'], limit: 10 })).toHaveLength(0);
  });
  it('is safe against tsquery injection in terms', async () => {
    const s = await source();
    await k.saveVersion(input(s.id));
    await expect(k.searchCandidates({ technologySlugs: ['apache-kafka'], terms: ["lag' | !(a & b) ; DROP TABLE x --", ':*', '<->'], limit: 5 })).resolves.toBeDefined();
  });
  it('disabled sources are not searched', async () => {
    const s = await source();
    await k.saveVersion(input(s.id));
    await k.upsertSource({ technologySlug: 'apache-kafka', name: 'x', sourceType: 'OFFICIAL_DOCS', provider: 'Apache', baseUrl: 'https://kafka.apache.org/', allowedDomains: ['kafka.apache.org'], trustLevel: 1, enabled: false });
    expect(await k.searchCandidates({ technologySlugs: ['apache-kafka'], terms: ['consumer'], limit: 5 })).toHaveLength(0);
  });
});

describe('ingestion runs', () => {
  it('allows one active run per source, and a duplicate request returns the existing one', async () => {
    const s = await source();
    const a = await k.createRun({ sourceId: s.id, kind: 'INGEST' });
    const b = await k.createRun({ sourceId: s.id, kind: 'REFRESH' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.run.id).toBe(a.run.id);
    const claimed = await k.claimRun(a.run.id, new Date(Date.now() - 60_000));
    expect(claimed?.status).toBe('RUNNING');
    expect((await k.createRun({ sourceId: s.id, kind: 'INGEST' })).created).toBe(false);
    expect(await k.finishRun(a.run.id, { ok: true, stats: { documents: 1 } })).toBe(true);
    expect((await k.createRun({ sourceId: s.id, kind: 'INGEST' })).created).toBe(true); // finished: a new run is allowed
  });
  it('only one of two workers can claim a run, and a finished run never changes', async () => {
    const s = await source();
    const { run } = await k.createRun({ sourceId: s.id, kind: 'INGEST' });
    const claims = await Promise.all([k.claimRun(run.id, new Date(0)), k.claimRun(run.id, new Date(0))]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await k.finishRun(run.id, { ok: false, code: 'FETCH_FAILED', message: 'boom', retryable: true })).toBe(true);
    expect(await k.finishRun(run.id, { ok: true, stats: {} })).toBe(false);
    expect((await k.findRun(run.id))?.status).toBe('FAILED');
  });
  it('fails stale runs as retryable so a lost job cannot leave documentation "preparing" forever', async () => {
    const s = await source();
    const { run } = await k.createRun({ sourceId: s.id, kind: 'INGEST' });
    await k.claimRun(run.id, new Date(0));
    await prisma.knowledgeIngestionRun.update({ where: { id: run.id }, data: { heartbeatAt: new Date(Date.now() - 3_600_000) } });
    const failed = await k.failStaleRuns(new Date(Date.now() - 60_000));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'FAILED', failureCode: 'STALE_RUN', retryable: true });
  });
});

describe('citations are append-only snapshots (K8)', () => {
  it('stores a snapshot, survives a document refresh, and cannot be updated', async () => {
    const h = makeApp();
    const u = await signUp(h.app, 'cit');
    const p = await h.app.projects.create(u.ctx, { name: 'P' });
    const s = await source();
    const v = await k.saveVersion(input(s.id));
    const [c] = await k.searchCandidates({ technologySlugs: ['apache-kafka'], terms: ['consumer'], limit: 1 });
    const id = randomUUID();
    await k.saveCitations([{ id, projectId: p.id, userId: u.user.id, n: 1, chunkId: c!.chunkId, documentVersionId: v.versionId, snapshot: { title: 'T', url: 'https://kafka.apache.org/documentation/', excerpt: 'x' } }]);
    await k.saveVersion(input(s.id, { contentHash: 'h2', chunks: [chunk(0, 'Something entirely new.')] }));
    const got = await k.getCitation(id);
    expect(got?.snapshot).toMatchObject({ title: 'T' });
    await expect(prisma.knowledgeCitation.update({ where: { id }, data: { n: 9 } })).rejects.toThrow(/append-only/);
    await h.prisma.$disconnect();
  });
});

describe('re-indexing', () => {
  it('finds chunks embedded with another embedding version and updates them', async () => {
    const s = await source();
    await k.saveVersion(input(s.id));
    const todo = await k.chunksNeedingEmbedding(s.id, 'v2', 10);
    expect(todo).toHaveLength(1);
    await k.setEmbeddings([{ id: todo[0]!.id, embedding: [0, 1, 0, 0] }], { provider: 'local', model: 'test2', dimensions: 4, version: 'v2' });
    expect(await k.chunksNeedingEmbedding(s.id, 'v2', 10)).toHaveLength(0);
    expect((await k.overview()).sources[0]!.embeddingModels).toEqual(['test2']);
  });
});
