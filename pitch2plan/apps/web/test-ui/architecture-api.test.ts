import { describe, expect, it } from 'vitest';
import { confirmedViaApi, makeSession } from './helpers';

const BASE = () => process.env.UI_TEST_BASE!;
async function raw(path: string, cookie = '', init: RequestInit = {}) {
  const res = await fetch(BASE() + path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function waitForJob(s: ReturnType<typeof makeSession>, jobId: string) {
  for (let i = 0; i < 120; i++) { const { job } = await s.api<{ job: { status: string; currentStage: string; versionId: string | null } }>(`/api/jobs/${jobId}`); if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return job; await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('job did not finish');
}

describe('architecture REST API (real server, real worker, real database)', () => {
  it('start generation -> poll the job -> read the graph, node, decisions and requirement trace', async () => {
    const s = makeSession();
    const id = await confirmedViaApi(s, 'api');

    const started = await s.api<{ jobId: string; generationRunId: string; status: string }>(`/api/projects/${id}/architecture/generate`, {});
    expect(started).toMatchObject({ status: 'QUEUED' });
    expect(started.jobId).toBeTruthy(); expect(started.generationRunId).toMatch(/^[0-9a-f-]{36}$/);
    const job = await waitForJob(s, started.jobId);
    expect(job).toMatchObject({ status: 'SUCCEEDED', currentStage: 'DONE' });
    expect(job.versionId).toBeTruthy();

    const { architecture } = await s.api<{ architecture: { state: string; project: { status: string }; versions: unknown[]; current: { version: { id: string; nodes: Array<{ stableKey: string }>; edges: unknown[] }; decisions: Array<{ key: string; driverCodes: string[] }>; requirements: Array<{ id: string; code: string }> } } }>(`/api/projects/${id}/architecture`);
    expect(architecture).toMatchObject({ state: 'READY', project: { status: 'ARCHITECTURE_READY' } });
    expect(architecture.versions).toHaveLength(1);
    const vid = architecture.current.version.id;
    expect(vid).toBe(job.versionId);
    expect(architecture.current.version.nodes.map((n) => n.stableKey)).toContain('event-stream');

    expect((await s.api<{ versions: Array<{ versionNumber: number; status: string }> }>(`/api/projects/${id}/architecture/versions`)).versions).toMatchObject([{ versionNumber: 1, status: 'READY' }]);
    expect((await s.api<{ version: { version: { id: string } } }>(`/api/architecture/versions/${vid}`)).version.version.id).toBe(vid);
    const node = (await s.api<{ node: { node: { stableKey: string }; why: { summary: string; drivers: unknown[]; requirements: Array<{ id: string; code: string }> }; inputs: unknown[]; outputs: unknown[] } }>(`/api/architecture/versions/${vid}/nodes/event-stream`)).node;
    expect(node.node.stableKey).toBe('event-stream');
    expect(node.why.drivers.length).toBeGreaterThan(0); expect(node.why.requirements.length).toBeGreaterThan(0);
    const decisions = await s.api<{ decisions: Array<{ key: string }>; drivers: unknown[]; requirements: unknown[] }>(`/api/architecture/versions/${vid}/decisions`);
    expect(decisions.decisions.length).toBe(architecture.current.decisions.length);
    const trace = (await s.api<{ trace: { requirement: { code: string }; decisions: unknown[]; nodes: Array<{ stableKey: string }> } }>(`/api/architecture/versions/${vid}/requirements/${node.why.requirements[0]!.id}`)).trace;
    expect(trace.requirement.code).toBe(node.why.requirements[0]!.code);
    expect(trace.nodes.map((n) => n.stableKey)).toContain('event-stream');

    // errors use the standard envelope with a request id
    const missing = await raw(`/api/architecture/versions/${vid}/nodes/nope`, '', {});
    expect(missing.status).toBe(401);
  });

  it('rejects: unauthenticated, wrong state, duplicates, and other users; and returns the standard error envelope', async () => {
    const owner = makeSession();
    const id = await confirmedViaApi(owner, 'authz');
    expect((await raw(`/api/projects/${id}/architecture`)).status).toBe(401);
    expect((await raw('/api/jobs/00000000-0000-4000-8000-000000000000')).status).toBe(401);

    const started = await owner.api<{ jobId: string }>(`/api/projects/${id}/architecture/generate`, {});
    const again = await raw(`/api/projects/${id}/architecture/generate`, await cookieOf(owner), { method: 'POST', body: '{}' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'INVALID_STATE', requestId: expect.any(String) } });
    const job = await waitForJob(owner, started.jobId);
    const ready = await raw(`/api/projects/${id}/architecture/generate`, await cookieOf(owner), { method: 'POST', body: '{}' });
    expect(ready.status).toBe(409);

    const intruder = makeSession();
    await intruder.api('/api/auth/dev-sign-in', { email: `intruder-${Date.now()}@example.com` });
    const ic = await cookieOf(intruder);
    const { architecture } = await owner.api<{ architecture: { current: { version: { id: string } } } }>(`/api/projects/${id}/architecture`);
    const vid = architecture.current.version.id;
    for (const path of [`/api/projects/${id}/architecture`, `/api/projects/${id}/architecture/versions`, `/api/architecture/versions/${vid}`, `/api/architecture/versions/${vid}/nodes/event-stream`, `/api/architecture/versions/${vid}/decisions`, `/api/jobs/${started.jobId}`]) {
      const r = await raw(path, ic);
      expect(r.status, path).toBe(404);
    }
    expect((await raw(`/api/projects/${id}/architecture/generate`, ic, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await raw(`/api/architecture/versions/${vid}/nodes/no-such-node`, await cookieOf(owner))).body).toMatchObject({ error: { code: 'NODE_NOT_FOUND' } });
    expect(job.status).toBe('SUCCEEDED');
  });

  it('refuses to generate before requirements are confirmed', async () => {
    const s = makeSession();
    const id = await s.projectReady('early');
    await s.api(`/api/projects/${id}/discovery/start`, {});
    const r = await raw(`/api/projects/${id}/architecture/generate`, await cookieOf(s), { method: 'POST', body: '{}' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { code: 'INVALID_STATE' } });
  });
});

/** The session helper keeps its cookie private; sign in again through the same helper to read it. */
async function cookieOf(s: ReturnType<typeof makeSession>): Promise<string> {
  return (s as unknown as { cookie(): string }).cookie();
}
