/* eslint-disable @typescript-eslint/no-explicit-any -- these tests inspect arbitrary JSON bodies returned by the real server */
import { describe, expect, it } from 'vitest';
import { implementationReadyViaApi, makeSession, pollUntil } from './helpers';

const BASE = () => process.env.UI_TEST_BASE!;
const owner = makeSession(); const other = makeSession();
type Json = { data?: Record<string, any>; error?: { code: string; message: string }; requestId?: string };
async function raw(s: ReturnType<typeof makeSession> | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers }; if (body !== undefined) h['content-type'] = 'application/json'; if (s?.cookie()) h.cookie = s.cookie();
  const res = await fetch(BASE() + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  return res;
}
async function j(s: ReturnType<typeof makeSession> | null, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await raw(s, method, path, body, headers); const text = await res.text();
  let json: Json = {}; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, res };
}
const events = (text: string) => text.split('\n\n').filter(Boolean).map((b) => { const t = /^event: (.+)$/m.exec(b)![1]!; return { type: t, data: JSON.parse(/^data: (.+)$/m.exec(b)![1]!) as Record<string, any> }; });

describe('implementation API over HTTP (real server, real worker, real Postgres)', () => {
  it('generates through the queue, is observable through the shared jobs endpoint, and serves plan, tasks and component views', async () => {
    owner.install();
    const { id, plan, taskId } = await (async () => { try { return await implementationReadyViaApi(owner, 'api-impl'); } finally { owner.restore(); } })();
    const dup = await j(owner, 'POST', `/api/projects/${id}/implementation/generate`);
    expect(dup.status).toBe(409); expect(dup.json.error!.code).toBe('INVALID_STATE'); // a plan already exists for this architecture version

    const overview = (await j(owner, 'GET', `/api/projects/${id}/implementation`)).json.data!.implementation;
    expect(overview).toMatchObject({ state: 'READY', project: { status: 'ARCHITECTURE_READY' }, run: { status: 'SUCCEEDED', currentStage: 'COMPLETE' } });
    const job = await j(owner, 'GET', `/api/jobs/${overview.run.jobId}`); // implementation jobs are visible on the same endpoint as architecture jobs
    expect(job.status).toBe(200); expect(job.json.data!.job).toMatchObject({ status: 'SUCCEEDED', planVersionId: plan.tasks.length > 0 ? overview.plan.version.id : null });
    const byId = await j(owner, 'GET', `/api/implementation/plans/${overview.plan.version.id}`);
    expect(byId.status).toBe(200); expect(byId.json.data!.plan.tasks).toHaveLength(plan.tasks.length); expect(byId.res.headers.get('x-request-id')).toBeTruthy();

    const t = await j(owner, 'GET', `/api/implementation/tasks/${taskId('provision-event-stream')}`);
    expect(t.status).toBe(200); expect(t.json.data!.task).toMatchObject({ canStart: false, readiness: 'WAITING' });
    expect(t.json.data!.task.task).not.toHaveProperty('requirementIds');
    const comp = await j(owner, 'GET', `/api/projects/${id}/components/event-stream/implementation`);
    expect(comp.status).toBe(200); expect(comp.json.data!.component.facts.component.stableKey).toBe('event-stream');
    const decKey = comp.json.data!.component.facts.decisions[0].key as string;
    expect((await j(owner, 'GET', `/api/projects/${id}/decisions/${decKey}/tasks`)).json.data!.tasks.length).toBeGreaterThan(0);
    expect((await j(owner, 'GET', `/api/projects/${id}/components/nope/implementation`)).status).toBe(404);
  });

  it('maps task progress rules to precise HTTP errors', async () => {
    const { id, taskId } = await (async () => { owner.install(); try { return await implementationReadyViaApi(owner, 'api-progress'); } finally { owner.restore(); } })();
    const prep = taskId('prepare-environment'); const later = taskId('provision-primary-database');
    const status = (task: string, body: unknown) => j(owner, 'PATCH', `/api/implementation/tasks/${task}/status`, body);
    expect((await status(prep, { status: 'NOT_A_STATUS' })).status).toBe(400);
    expect((await status(prep, { status: 'COMPLETED' })).json.error!.code).toBe('INVALID_STATE'); // not started
    const unmet = await status(later, { status: 'IN_PROGRESS' });
    expect(unmet.status).toBe(409); expect(unmet.json.error!.message).toMatch(/Finish these first: Prepare the/);
    expect((await status(prep, { status: 'IN_PROGRESS' })).status).toBe(200);
    expect((await j(owner, 'GET', `/api/projects/${id}`)).json.data!.project.status).toBe('IMPLEMENTING');
    const blocked = await status(prep, { status: 'COMPLETED' }); expect(blocked.status).toBe(409); expect(blocked.json.error!.code).toBe('CONFIRMATION_BLOCKED');
    expect((await j(owner, 'POST', `/api/implementation/tasks/${prep}/validate-completion`, { confirmations: [] })).status).toBe(400);
    expect((await j(owner, 'POST', `/api/implementation/tasks/${prep}/validate-completion`, { confirmations: [{ position: 7, confirmed: true }] })).json.error!.code).toBe('VALIDATION_ERROR');
    const v = await j(owner, 'POST', `/api/implementation/tasks/${prep}/validate-completion`, { confirmations: [{ position: 0, confirmed: true }, { position: 1, confirmed: true }] });
    expect(v.status).toBe(200); expect(v.json.data!.validation).toMatchObject({ allConfirmed: true }); expect(v.json.data!.validation.validations.map((x: any) => x.confirmationKind)).toEqual(['USER_CONFIRMED', 'USER_CONFIRMED']);
    const done = await status(prep, { status: 'COMPLETED' }); expect(done.status).toBe(200); expect(done.json.data!.task.task.status).toBe('COMPLETED');
    const step = (await j(owner, 'GET', `/api/implementation/tasks/${later}`)).json.data!.task.task.steps[0].id;
    expect((await j(owner, 'PATCH', `/api/implementation/tasks/${later}/steps/${step}`, { status: 'COMPLETED' })).json.error!.code).toBe('INVALID_STATE'); // not started
  });

  it('requires sign-in, hides other workspaces, and refuses cross-origin changes', async () => {
    const { id, plan, taskId } = await (async () => { owner.install(); try { return await implementationReadyViaApi(owner, 'api-authz'); } finally { owner.restore(); } })();
    await other.api('/api/auth/dev-sign-in', { email: `intruder-${Date.now()}@example.com` });
    const t = taskId('prepare-environment'); const body = { message: 'hi', scope: 'PROJECT', projectId: id, clientMessageId: 'client-msg-0001' };
    const calls: Array<[string, string, unknown?]> = [['GET', `/api/projects/${id}/implementation`], ['POST', `/api/projects/${id}/implementation/generate`], ['GET', `/api/implementation/tasks/${t}`], ['PATCH', `/api/implementation/tasks/${t}/status`, { status: 'IN_PROGRESS' }],
      ['POST', `/api/implementation/tasks/${t}/validate-completion`, { confirmations: [{ position: 0, confirmed: true }] }], ['GET', `/api/projects/${id}/components/event-stream/implementation`], ['POST', '/api/assistant/messages', body], ['GET', `/api/projects/${id}/conversation?scope=PROJECT`]];
    for (const [m, p, b] of calls) expect((await j(null, m, p, b)).status, `anonymous ${m} ${p}`).toBe(401);
    expect((await j(other, 'GET', `/api/projects/${id}/implementation`)).status).toBe(404);
    expect((await j(other, 'POST', `/api/projects/${id}/implementation/generate`)).status).toBe(404);
    for (const [m, p, b] of [['GET', `/api/implementation/tasks/${t}`], ['PATCH', `/api/implementation/tasks/${t}/status`, { status: 'IN_PROGRESS' }], ['POST', `/api/implementation/tasks/${t}/validate-completion`, { confirmations: [{ position: 0, confirmed: true }] }]] as Array<[string, string, unknown?]>) {
      const r = await j(other, m, p, b); expect(r.status, `${m} ${p}`).toBe(404); expect(r.json.error!.code).toBe('TASK_NOT_FOUND');
    }
    expect((await j(other, 'GET', `/api/implementation/plans/${plan.tasks.length ? (await j(owner, 'GET', `/api/projects/${id}/implementation`)).json.data!.implementation.plan.version.id : ''}`)).json.error!.code).toBe('PLAN_NOT_FOUND');
    expect((await j(other, 'GET', `/api/projects/${id}/components/event-stream/implementation`)).status).toBe(404);
    expect((await j(other, 'POST', '/api/assistant/messages', body)).status).toBe(404);
    const cross = await j(owner, 'PATCH', `/api/implementation/tasks/${t}/status`, { status: 'IN_PROGRESS' }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403); expect(cross.json.error!.code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await j(owner, 'GET', `/api/implementation/tasks/${t}`)).json.data!.task.task.status).toBe('NOT_STARTED'); // nothing changed
  });

  it('streams assistant answers as server-sent events, and reports bad requests as ordinary errors BEFORE the stream opens', async () => {
    const { id, taskId } = await (async () => { owner.install(); try { return await implementationReadyViaApi(owner, 'api-sse'); } finally { owner.restore(); } })();
    const ask = (b: object) => raw(owner, 'POST', '/api/assistant/messages', { projectId: id, clientMessageId: `cm-${Math.random().toString(36).slice(2, 12)}`, ...b });
    const res = await ask({ scope: 'TASK', scopeId: taskId('provision-primary-database'), message: 'Why do I need this?' });
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/); expect(res.headers.get('cache-control')).toMatch(/no-store/); expect(res.headers.get('x-request-id')).toBeTruthy();
    const ev = events(await res.text());
    expect(ev[0]!.type).toBe('start'); expect(ev.filter((e) => e.type === 'delta').length).toBeGreaterThan(1); expect(ev.at(-1)!.type).toBe('done');
    const done = ev.at(-1)!.data.message; expect(done.structured.answer).toMatch(/Primary database/); expect(done.role).toBe('ASSISTANT');
    expect(ev.filter((e) => e.type === 'delta').map((e) => e.data.text).join('').trim()).toBe(done.structured.answer);
    expect(JSON.stringify(ev)).not.toContain('<<<STRUCTURED>>>'); // the wire format never leaks the delimiter

    const convo = await j(owner, 'GET', `/api/projects/${id}/conversation?scope=TASK&scopeId=${taskId('provision-primary-database')}`);
    expect(convo.json.data!.messages.map((m: any) => m.role)).toEqual(['USER', 'ASSISTANT']);
    const msgs = await j(owner, 'GET', `/api/conversations/${convo.json.data!.conversation.id}/messages`);
    expect(msgs.status).toBe(200); expect(msgs.json.data!.messages).toHaveLength(2);
    await other.api('/api/auth/dev-sign-in', { email: `reader-${Date.now()}@example.com` });
    expect((await j(other, 'GET', `/api/conversations/${convo.json.data!.conversation.id}/messages`)).json.error!.code).toBe('CONVERSATION_NOT_FOUND');

    for (const [label, body, status, code] of [
      ['unknown task', { scope: 'TASK', scopeId: '00000000-0000-4000-8000-000000000000', message: 'x' }, 404, 'TASK_NOT_FOUND'],
      ['unknown component', { scope: 'COMPONENT', scopeId: 'nope', message: 'x' }, 404, 'NODE_NOT_FOUND'],
      ['missing scope id', { scope: 'TASK', message: 'x' }, 400, 'VALIDATION_ERROR'],
      ['empty message', { scope: 'PROJECT', message: '   ' }, 400, 'VALIDATION_ERROR'],
      ['unknown scope', { scope: 'EVERYTHING', message: 'x' }, 400, 'VALIDATION_ERROR'],
      ['oversized message', { scope: 'PROJECT', message: 'x'.repeat(4001) }, 400, 'VALIDATION_ERROR'],
    ] as Array<[string, object, number, string]>) {
      const r = await ask(body); const text = await r.text();
      expect(r.status, label).toBe(status); expect(r.headers.get('content-type'), label).toMatch(/application\/json/); expect(JSON.parse(text).error.code, label).toBe(code);
    }
    void pollUntil;
  });
});
