/* eslint-disable @typescript-eslint/no-explicit-any -- these tests inspect arbitrary JSON bodies returned by the real server */
import { describe, expect, it } from 'vitest';
import { implementationReadyViaApi, makeSession, pollUntil } from './helpers';

// Real production server, real inline worker, real Postgres, fixture documentation (KNOWLEDGE_FETCHER=fixture). Never mixed with the integration suite.
const BASE = () => process.env.UI_TEST_BASE!;
const owner = makeSession(); const other = makeSession();
type Json = { data?: Record<string, any>; error?: { code: string; message: string } };
async function j(s: ReturnType<typeof makeSession> | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers }; if (body !== undefined) h['content-type'] = 'application/json'; if (s?.cookie()) h.cookie = s.cookie();
  const res = await fetch(BASE() + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json: Json = {}; try { json = JSON.parse(text); } catch { /* sse */ }
  return { status: res.status, json, text };
}
const events = (text: string) => text.split('\n\n').filter(Boolean).map((b) => ({ type: /^event: (.+)$/m.exec(b)![1]!, data: JSON.parse(/^data: (.+)$/m.exec(b)![1]!) as Record<string, any> }));
const PG = 'https://www.postgresql.org/docs/current/runtime-config-connection.html';

describe('knowledge API over HTTP', () => {
  it('requires sign-in everywhere, and the diagnostic view is on only when enabled', async () => {
    owner.install();
    const setup = await (async () => { try { return await implementationReadyViaApi(owner, 'api-know'); } finally { owner.restore(); } })();
    other.install(); try { await other.api('/api/auth/dev-sign-in', { email: `stranger-${Date.now()}@example.com` }); } finally { other.restore(); }
    for (const [m, p] of [['GET', '/api/technologies/postgresql/docs'], ['GET', '/api/knowledge/search?q=tls&technology=postgresql'], ['GET', '/api/knowledge/status'], ['GET', '/api/knowledge/citations/00000000-0000-4000-8000-000000000000'], ['POST', '/api/knowledge/sources/postgresql/refresh'], ['GET', `/api/projects/${setup.id}/components/primary-database/docs`]] as const) {
      expect((await j(null, m, p)).status, `anonymous ${m} ${p}`).toBe(401);
    }
    const status = await j(owner, 'GET', '/api/knowledge/status');
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.json)).not.toMatch(/postgresql:\/\/|DATABASE_URL|password/i); // diagnostics never leak configuration
  });

  it('serves documentation for a technology, a component and a task; unknown things say so honestly', async () => {
    owner.install();
    const { id, taskId } = await (async () => { try { return await implementationReadyViaApi(owner, 'api-know-docs'); } finally { owner.restore(); } })();
    expect((await j(owner, 'GET', '/api/technologies/not-a-tech/docs')).json.data!.docs).toMatchObject({ availability: 'NOT_COVERED', documents: [] });
    const first = (await j(owner, 'GET', '/api/technologies/postgresql/docs')).json.data!.docs;
    expect(['PREPARING', 'READY']).toContain(first.availability);
    const ready = await pollUntil(async () => (await j(owner, 'GET', '/api/technologies/postgresql/docs')).json.data!.docs, (d) => d.availability === 'READY' && d.documents.length > 0, 'postgresql documentation');
    expect(ready.documents.every((x: any) => x.url.startsWith('https://www.postgresql.org/'))).toBe(true);

    const comp = (await j(owner, 'GET', `/api/projects/${id}/components/primary-database/docs`)).json.data!.docs;
    expect(comp.technologies.some((t: any) => t.slug === 'postgresql')).toBe(true);
    const task = (await j(owner, 'GET', `/api/implementation/tasks/${taskId('provision-primary-database')}/docs`)).json.data!.docs;
    expect(task.technologies.some((t: any) => t.slug === 'postgresql')).toBe(true);
    const none = (await j(owner, 'GET', `/api/projects/${id}/components/event-stream/docs`)).json.data!.docs;
    expect(none).toMatchObject({ availability: 'NONE', documents: [] });
    expect((await j(owner, 'GET', `/api/projects/${id}/components/missing/docs`)).json.error!.code).toBe('NODE_NOT_FOUND');

    // Another workspace learns nothing.
    expect((await j(other, 'GET', `/api/projects/${id}/components/primary-database/docs`)).json.error!.code).toBe('PROJECT_NOT_FOUND');
    expect((await j(other, 'GET', `/api/implementation/tasks/${taskId('provision-primary-database')}/docs`)).json.error!.code).toBe('TASK_NOT_FOUND');
    expect((await j(other, 'GET', `/api/knowledge/search?q=tls&technology=postgresql&projectId=${id}`)).json.error!.code).toBe('PROJECT_NOT_FOUND');
  });

  it('validates and answers documentation search', async () => {
    expect((await j(owner, 'GET', '/api/knowledge/search?q=a&technology=postgresql')).json.error!.code).toBe('VALIDATION_ERROR');
    await pollUntil(async () => (await j(owner, 'GET', '/api/technologies/postgresql/docs')).json.data!.docs, (d) => d.availability === 'READY', 'postgresql documentation');
    const hit = await j(owner, 'GET', '/api/knowledge/search?q=How%20do%20I%20require%20TLS%20for%20remote%20clients&technology=postgresql');
    expect(hit.status).toBe(200); expect(hit.json.data!.results[0]).toMatchObject({ url: PG });
    expect((await j(owner, 'GET', '/api/knowledge/search?q=quantum%20hyperdrive&technology=postgresql')).json.data!.results).toEqual([]);
  });

  it('grounds an assistant answer over SSE, and the citation is readable by the owner only', async () => {
    owner.install();
    const { id } = await (async () => { try { return await implementationReadyViaApi(owner, 'api-know-ask'); } finally { owner.restore(); } })();
    await pollUntil(async () => (await j(owner, 'GET', '/api/technologies/postgresql/docs')).json.data!.docs, (d) => d.availability === 'READY', 'postgresql documentation');
    const ask = (message: string) => j(owner, 'POST', '/api/assistant/messages', { projectId: id, scope: 'COMPONENT', scopeId: 'primary-database', message, clientMessageId: `cm-${Math.random().toString(36).slice(2, 12)}` });
    const ev = events((await ask('How do I require TLS for remote clients?')).text);
    expect(ev.at(-1)!.type).toBe('done');
    const m = ev.at(-1)!.data.message.structured;
    expect(m.grounding).toMatchObject({ status: 'GROUNDED' });
    expect(m.citations[0]).toMatchObject({ url: PG, n: 1 });
    const cite = await j(owner, 'GET', `/api/knowledge/citations/${m.citations[0].id}`);
    expect(cite.status).toBe(200); expect(cite.json.data!.citation).toMatchObject({ url: PG, fullText: expect.stringContaining('remote clients') });
    const denied = await j(other, 'GET', `/api/knowledge/citations/${m.citations[0].id}`);
    expect(denied.status).toBe(404); expect(denied.json.error!.code).toBe('CITATION_NOT_FOUND');

    // An off-topic question is never dressed up as grounded.
    const off = events((await ask('How do I tune autovacuum workers?')).text).at(-1)!.data.message.structured;
    expect(off.grounding.status).not.toBe('GROUNDED'); expect(off.citations).toEqual([]);
  });

  it('refresh: unknown source is 404; a real refresh is accepted or rate-limited, never an error', async () => {
    expect((await j(owner, 'POST', '/api/knowledge/sources/not-a-tech/refresh')).json.error!.code).toBe('SOURCE_NOT_FOUND');
    const r = await j(owner, 'POST', '/api/knowledge/sources/postgresql/refresh');
    expect([202, 429]).toContain(r.status);
    if (r.status === 429) expect(r.json.error!.code).toBe('REFRESH_TOO_SOON');
    const cross = await j(owner, 'POST', '/api/knowledge/sources/postgresql/refresh', undefined, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
  });
});
