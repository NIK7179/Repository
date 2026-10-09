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
