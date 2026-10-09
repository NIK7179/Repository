import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARCHITECTURE_JOB } from '@pitch2plan/domain';
import { PgBossJobQueue } from '@pitch2plan/jobs';
import { confirmedProject, makeApp } from '../helpers';

// Uses the REAL pg-boss against the test database (its own schema), not a fake queue.
const queue = new PgBossJobQueue(process.env.DATABASE_URL!, { schema: 'pgboss_test' });
const h = makeApp({}, {}, {}, queue);
let worker: { stop(): Promise<void> } | undefined;

beforeAll(async () => { await h.prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS pgboss_test CASCADE'); });
afterAll(async () => { await worker?.stop(); await queue.stop(); await h.prisma.$disconnect(); });

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 250)); }
}

describe('architecture generation through real pg-boss', () => {
  it('queues a job, refuses a duplicate, and a worker picks it up and finishes the run', async () => {
    const p = await confirmedProject(h);
    const g = await h.app.architecture.generate(p.ctx, p.project.id);
    expect(g.jobId).toMatch(/^[0-9a-f-]{36}$/);
    // Same singletonKey again: the "short" queue policy refuses it (a "standard" queue would accept a duplicate).
    expect(await queue.enqueue(ARCHITECTURE_JOB, { runId: g.generationRunId }, { singletonKey: g.generationRunId })).toBeNull();
    expect((await h.app.architecture.getJob(p.ctx, g.jobId)).status).toBe('QUEUED'); // nobody is consuming yet

    worker = await queue.startWorker(h.app, { sweepEveryMs: 60_000 });
    const done = await waitFor(async () => { const r = await h.repos.architecture.getRun(g.generationRunId); return r && r.status !== 'QUEUED' && r.status !== 'RUNNING' ? r : false; });
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempt: 1, currentStage: 'DONE' });
    expect((await h.app.projects.get(p.ctx, p.project.id)).project.status).toBe('ARCHITECTURE_READY');
    expect(await h.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(1);
    expect((await h.app.architecture.getJob(p.ctx, g.jobId)).versionId).toBe(done.versionId);
  });

  it('survives a job for a run that does not exist, and keeps processing later jobs', async () => {
    const boss = await queue.getBoss();
    const stray = await boss.send(ARCHITECTURE_JOB, { runId: randomUUID() });
    const p = await confirmedProject(h);
    const g = await h.app.architecture.generate(p.ctx, p.project.id);
    const done = await waitFor(async () => { const r = await h.repos.architecture.getRun(g.generationRunId); return r?.status === 'SUCCEEDED' ? r : false; });
    expect(done.status).toBe('SUCCEEDED');
    const job = await waitFor(async () => { const j = await boss.getJobById(ARCHITECTURE_JOB, stray!); return j?.state === 'completed' ? j : false; });
    expect(job.state).toBe('completed'); // handled (as MISSING), not retried forever
  });

  it('recovers stale runs when a worker starts, so a lost job can never leave a project stuck', async () => {
    const quick = makeApp({}, {}, { staleRunMs: 5 }); // its queue drops jobs on the floor: the job is "lost"
    try {
      const p = await confirmedProject(quick);
      const g = await quick.app.architecture.generate(p.ctx, p.project.id);
      expect(await quick.repos.architecture.getRun(g.generationRunId)).toMatchObject({ status: 'QUEUED' });
      await new Promise((r) => setTimeout(r, 30));
      const w = await queue.startWorker(quick.app, { sweepEveryMs: 60_000 }); // starting a worker sweeps immediately
      try {
        const run = await waitFor(async () => { const r = await quick.repos.architecture.getRun(g.generationRunId); return r?.status === 'FAILED' ? r : false; });
        expect(run.failureCode).toBe('GENERATION_TIMED_OUT');
        expect((await quick.app.projects.get(p.ctx, p.project.id)).project.status).toBe('REQUIREMENTS_CONFIRMED');
      } finally { await w.stop(); }
    } finally { await quick.prisma.$disconnect(); }
  });
});

describe('documentation ingestion through real pg-boss', () => {
  it('queues an ingestion on demand, refuses a duplicate, and the worker indexes the documentation', async () => {
    await h.prisma.$executeRawUnsafe('TRUNCATE "KnowledgeSource" CASCADE');
    expect(await h.app.knowledge.ensureIndexed(['apache-kafka'])).toEqual({ 'apache-kafka': 'PREPARING' });
    const run = (await h.app.knowledge.latestRunFor('apache-kafka'))!;
    expect(await queue.enqueue('knowledge.ingest', { runId: run.id }, { singletonKey: run.id })).toBeNull(); // duplicate refused while queued
    worker = await queue.startWorker(h.app, { sweepEveryMs: 60_000 }); // the previous test stopped the shared boss together with its worker
    expect(run.jobId).toMatch(/^[0-9a-f-]{36}$/);
    const done = await waitFor(async () => { const r = await h.app.knowledge.latestRunFor('apache-kafka'); return r && r.status === 'SUCCEEDED' ? r : false; });
    expect(done.attempt).toBe(1);
    expect(await h.app.knowledge.ensureIndexed(['apache-kafka'])).toEqual({ 'apache-kafka': 'READY' });
  });
});
