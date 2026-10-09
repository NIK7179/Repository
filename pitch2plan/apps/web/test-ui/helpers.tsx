import type { Mock } from 'vitest';

export const push = (globalThis as unknown as { __push: Mock }).__push;

export const PITCH = 'I want to create a platform that processes millions of transaction events in real time and detects fraud. Merchants should get alerts when a payment looks suspicious.';

/** A tiny browser-like session: relative URLs resolve to the real server and the auth cookie is carried along. */
export function makeSession() {
  const BASE = process.env.UI_TEST_BASE!;
  let cookie = '';
  const real = globalThis.fetch;
  const f = async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = typeof url === 'string' && url.startsWith('/') ? BASE + url : url;
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const res = await real(u, { ...init, headers });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) { const pair = c.split(';')[0]!; if (pair.startsWith('p2p_session=')) cookie = pair.endsWith('=') ? '' : pair; }
    return res;
  };
  return {
    cookie: () => cookie,
    install() { globalThis.fetch = f as typeof fetch; },
    restore() { globalThis.fetch = real; },
    async api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
      const res = await f(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
      const json = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(json));
      return json.data as T;
    },
    async projectReady(label: string, pitch = PITCH) {
      await this.api('/api/auth/dev-sign-in', { email: `${label}-${Date.now()}@example.com` });
      const { project } = await this.api<{ project: { id: string } }>('/api/projects', { name: `UI ${label}` });
      await this.api(`/api/projects/${project.id}/pitch`, { content: pitch });
      await this.api(`/api/projects/${project.id}/interpret`, {});
      return project.id;
    },
  };
}

type DiscoveryState = { rounds: Array<{ id: string; status: string; questions: Array<{ id: string; answerType: string; options: Array<{ id: string }> }> }> };
/** Takes a project through the real discovery flow over HTTP until its requirements are confirmed. */
export async function confirmedViaApi(session: ReturnType<typeof makeSession>, label: string, pitch = PITCH) {
  const id = await session.projectReady(label, pitch);
  const answers = (s: DiscoveryState) => { const r = s.rounds.find((x) => x.status === 'OPEN')!; return { r, answers: r.questions.map((q) => ({ questionId: q.id, choice: q.answerType === 'FREE_TEXT' ? { kind: 'FREE_TEXT', text: 'No preference' } : { kind: 'OPTIONS', optionIds: [q.options[0]!.id] } })) }; };
  let { state } = await session.api<{ state: DiscoveryState }>(`/api/projects/${id}/discovery/start`, {});
  for (let i = 0; i < 2; i++) {
    const a = answers(state);
    await session.api(`/api/projects/${id}/discovery/rounds/${a.r.id}/answers`, { answers: a.answers });
    ({ state } = await session.api<{ state: DiscoveryState }>(`/api/projects/${id}/discovery/next`, {}));
  }
  const { brief } = await session.api<{ brief: { version: { id: string } } }>(`/api/projects/${id}/brief/generate`, {});
  await session.api(`/api/projects/${id}/brief/confirm`, { briefVersionId: brief.version.id, acceptedUnknownIds: [] });
  return id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function pollUntil<T>(fn: () => Promise<T>, done: (v: T) => boolean, what: string, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (done(v)) return v; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await sleep(500); }
}
/** Confirmed requirements + a READY architecture, driven over HTTP (the server's inline worker runs the job). */
export async function architectureReadyViaApi(session: ReturnType<typeof makeSession>, label: string, pitch = PITCH) {
  const id = await confirmedViaApi(session, label, pitch);
  await session.api(`/api/projects/${id}/architecture/generate`, {});
  await pollUntil(() => session.api<{ architecture: { state: string } }>(`/api/projects/${id}/architecture`), (r) => r.architecture.state === 'READY', 'the architecture');
  return id;
}
type PlanOverview = { implementation: { state: string; plan: { tasks: Array<{ id: string; key: string; title: string }>; next: { taskId: string } | null } | null } };
/** ...plus a generated implementation plan. */
export async function implementationReadyViaApi(session: ReturnType<typeof makeSession>, label: string, pitch = PITCH) {
  const id = await architectureReadyViaApi(session, label, pitch);
  await session.api(`/api/projects/${id}/implementation/generate`, {});
  const o = await pollUntil(() => session.api<PlanOverview>(`/api/projects/${id}/implementation`), (r) => r.implementation.state === 'READY' || r.implementation.state === 'FAILED', 'the implementation plan');
  if (o.implementation.state !== 'READY') throw new Error('implementation generation failed');
  const taskId = (key: string) => o.implementation.plan!.tasks.find((t) => t.key === key)!.id;
  return { id, plan: o.implementation.plan!, taskId };
}
