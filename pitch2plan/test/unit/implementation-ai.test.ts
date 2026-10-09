import { describe, expect, it } from 'vitest';
import { AIError, LLMGateway, MockLLMProvider, createAssistantAi, createImplementationAi, mockImplPlan, type AIUsageEvent, type LLMProvider, type LLMRequest, type LLMStreamChunk } from '@pitch2plan/ai';
import { STRUCTURED_DELIMITER, type ImplPlanInput, type ImplementationPlan } from '@pitch2plan/schemas';

const node = (stableKey: string, name: string, category: string) => ({ stableKey, name, technology: `${name} tech`, technologySlug: stableKey, category, criticality: 'HIGH', deploymentModel: 'MANAGED_SERVICE', provider: 'AWS', managedService: true, purpose: `${name} purpose`, description: 'd', configuration: [], risks: [], alternatives: [] });
const input: ImplPlanInput = {
  context: { workspaceId: 'w', projectId: 'p', userId: 'u' }, project: { name: 'Demo' }, brief: {},
  requirements: [{ code: 'REQ-001', category: 'FUNCTIONAL', statement: 'Store bookings', origin: 'USER_STATED' }], drivers: [],
  architecture: { summary: 's', assumptions: [], risks: [], nodes: [node('db', 'Database', 'DATABASE'), node('api', 'API', 'API')], edges: [{ id: 'api-db', source: 'api', target: 'db', label: 'reads', protocol: 'TCP', communicationType: 'REQUEST_RESPONSE', dataDescription: 'Booking data', encrypted: true }],
    decisions: [{ key: 'adr-001', title: 'Managed database', status: 'ACCEPTED', decision: 'x', rationale: 'y', nodeStableKeys: ['db'], driverCodes: [], requirementCodes: ['REQ-001'] }] },
};
const good = () => mockImplPlan(input as never) as unknown as { summary: string; phases: unknown[]; tasks: Array<Record<string, unknown>>; componentCoverage: unknown[] };
const make = (provider: LLMProvider, timeoutMs = 5000) => { const usage: AIUsageEvent[] = []; return { usage, gateway: new LLMGateway({ provider, model: 'm', timeoutMs, maxRetries: 0, onUsage: (e) => { usage.push(e); } }) }; };
const str = (x: unknown) => JSON.stringify(x);

describe('implementation planner', () => {
  it('accepts a valid plan, and the prompt is versioned, names the architecture, and carries no instructions from data', async () => {
    const p = new MockLLMProvider({ script: [str(good())] }); const { gateway, usage } = make(p);
    const r = await createImplementationAi(gateway).plan(input);
    expect(r.output.tasks.length).toBeGreaterThan(5); expect(r.ai).toMatchObject({ promptId: 'IMPLEMENTATION_PLANNER', promptVersion: 1, repaired: false });
    expect(p.calls[0]!.system).toContain('PROMPT_ID: IMPLEMENTATION_PLANNER_V1'); expect(p.calls[0]!.system).toMatch(/PROJECT-SPECIFIC, NEVER GENERIC/); expect(p.calls[0]!.system).toMatch(/managed service, do not write install-it-yourself/);
    expect(p.calls[0]!.messages[0]!.content).toContain('<impl_plan_input>'); expect(p.calls[0]!.messages[0]!.content).toContain('Managed database');
    expect(usage).toMatchObject([{ capability: 'IMPLEMENTATION_PLANNER', success: true, promptVersion: 1 }]);
  });
  it('gives the model ONE corrective retry that names the broken reference, then fails with AI_OUTPUT_INVALID', async () => {
    const bad = good(); bad.tasks[3]!.componentKeys = ['no-such-component'];
    const p = new MockLLMProvider({ script: [str(bad), str(bad)] });
    await expect(createImplementationAi(make(p).gateway).plan(input)).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(p.calls).toHaveLength(2); expect(p.calls[1]!.messages.at(-1)!.content).toMatch(/unknown architecture component "no-such-component"/);
    const fixed = new MockLLMProvider({ script: [str(bad), str(good())] });
    expect((await createImplementationAi(make(fixed).gateway).plan(input)).ai.repaired).toBe(true);
  });
  it('rejects malformed output and non-https documentation links', async () => {
    await expect(createImplementationAi(make(new MockLLMProvider({ script: ['I think you should use microservices.'] })).gateway).plan(input)).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    const link = good(); link.tasks[0]!.references = [{ title: 'Docs', url: 'http://insecure.example/docs', sourceType: 'OFFICIAL_DOCS', technology: 'x', version: null }];
    await expect(createImplementationAi(make(new MockLLMProvider({ script: [str(link)] })).gateway).plan(input)).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
  });
});

describe('implementation critic and repairer', () => {
  const plan = good() as unknown as ImplementationPlan;
  const critique = (script: string[]) => createImplementationAi(make(new MockLLMProvider({ script })).gateway).critique({ context: input.context, architecture: input.architecture, requirements: input.requirements, plan, precheckIssues: [] });
  it('accepts findings about real tasks and retries findings about tasks that do not exist', async () => {
    const ok = { assessment: 'Mostly sound.', issues: [{ severity: 'HIGH', category: 'SECURITY', description: 'No secrets handling for the database.', taskKeys: [(plan.tasks[2]!.key as string)], componentKeys: ['db'], decisionKeys: [], recommendation: 'Add a secrets task.' }] };
    expect((await critique([str(ok)])).output.issues).toHaveLength(1);
    const ghost = { ...ok, issues: [{ ...ok.issues[0]!, taskKeys: ['ghost-task'] }] };
    await expect(critique([str(ghost), str(ghost)])).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect((await critique([str(ghost), str(ok)])).ai.repaired).toBe(true);
    await expect(critique([str({ assessment: 'x', issues: [{ ...ok.issues[0]!, severity: 'SEVERE' }] })])).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
  });
  it('validates repair patches against the plan, including the plan that results from applying them', async () => {
    const repair = (patch: unknown[]) => createImplementationAi(make(new MockLLMProvider({ script: patch.map(str) })).gateway).repair({ context: input.context, architecture: input.architecture, requirements: input.requirements, plan, mustAddress: [0], issues: [{ source: 'CRITIC', severity: 'CRITICAL', category: 'ORDERING', code: 'X', description: 'Something is wrong.', taskKeys: [], componentKeys: [], decisionKeys: [], recommendation: 'Fix it.' }] });
    const ok = { changes: [{ issueIndex: 0, description: 'Fixed the ordering problem' }], tasks: { update: [{ key: (plan.tasks[2]!.key as string), set: { title: 'A clearer task title' } }] } };
    expect((await repair([ok])).output.tasks.update[0]!.set.title).toBe('A clearer task title');
    await expect(repair([{ changes: [{ issueIndex: 0, description: 'Fix' }], tasks: { update: [{ key: 'ghost', set: { title: 'A clearer task title' } }] } }, { changes: [{ issueIndex: 0, description: 'Fix' }], tasks: { update: [{ key: 'ghost', set: { title: 'A clearer task title' } }] } }])).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    const dangling = { changes: [{ issueIndex: 0, description: 'Add a task' }], tasks: { add: [{ ...plan.tasks[2]!, key: 'new-task', componentKeys: ['phantom'] }] } };
    await expect(repair([dangling, dangling])).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' }); // the patched plan must still reference real things
    await expect(repair([{ changes: [{ issueIndex: 0, description: 'Fix' }], tasks: { update: [{ key: (plan.tasks[2]!.key as string), set: { key: 'renamed' } }] } }, ok])).resolves.toMatchObject({ ai: { repaired: true } }); // unknown fields in "set" are rejected, then fixed
  });
});

describe('assistant streaming', () => {
  const ask = (gateway: LLMGateway, signal?: AbortSignal, timeoutMs = 5000) => createAssistantAi(gateway, { timeoutMs }).stream({ context: input.context, projectContext: { project: { name: 'Demo' }, focusComponents: [{ name: 'Database', technology: 'Managed PostgreSQL', provider: 'AWS', deploymentModel: 'MANAGED_SERVICE' }] }, history: [], question: 'Why do I need this?', signal });
  const drain = async (it: AsyncIterable<{ type: string; text?: string }>) => { const out: Array<{ type: string; text?: string }> = []; for await (const e of it) out.push(e); return out; };

  it('streams deltas then done, grounds the prompt in the context, and records usage', async () => {
    const p = new MockLLMProvider(); const { gateway, usage } = make(p);
    const events = await drain(ask(gateway));
    expect(events.at(-1)).toMatchObject({ type: 'done', ai: { promptId: 'TASK_ASSISTANT', provider: 'mock' } });
    const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    expect(text).toContain('Database (Managed PostgreSQL on AWS'); expect(text).toContain(STRUCTURED_DELIMITER);
    expect(p.calls[0]!.system).toMatch(/You must NOT change the architecture/); expect(p.calls[0]!.system).toMatch(/Pitch2Plan never runs anything/);
    expect(p.calls[0]!.messages.at(-1)!.content).toContain('<project_context>'); expect(p.calls[0]!.messages.at(-1)!.content).toContain('Question: Why do I need this?');
    expect(usage).toMatchObject([{ capability: 'TASK_ASSISTANT', success: true, promptId: 'TASK_ASSISTANT', promptVersion: 1 }]);
  });
  it('times out a stalled stream, records the failure, and reports a normalized error', async () => {
    // eslint-disable-next-line require-yield -- a stalled provider never produces a chunk; that is the point
    const stalled: LLMProvider = { name: 'stalled', generate: async () => { throw new Error('unused'); }, async *stream(req: LLMRequest): AsyncIterable<LLMStreamChunk> { await new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new Error('aborted')))); } };
    const { gateway, usage } = make(stalled, 60);
    await expect(drain(ask(gateway, undefined, 60))).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(usage).toMatchObject([{ success: false, errorCode: 'AI_TIMEOUT' }]);
  });
  it('stops on cancellation even when the provider ignores the abort signal', async () => {
    const deaf: LLMProvider = { name: 'deaf', generate: async () => { throw new Error('x'); }, async *stream(): AsyncIterable<LLMStreamChunk> { for (const t of ['a', 'b', 'c']) yield { type: 'delta', text: t }; yield { type: 'done', result: { text: 'abc', model: 'm', provider: 'deaf', usage: {} } }; } };
    const { gateway, usage } = make(deaf); const ac = new AbortController(); const seen: string[] = [];
    await expect((async () => { for await (const e of ask(gateway, ac.signal)) { seen.push(e.type); ac.abort(); } })()).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['delta']); expect(usage).toMatchObject([{ success: false, errorCode: 'CANCELLED' }]);
  });
  it('maps provider failures to a safe error and records them; cancellation is not an error', async () => {
    const broken: LLMProvider = { name: 'broken', generate: async () => { throw new Error('x'); }, async *stream(): AsyncIterable<LLMStreamChunk> { yield { type: 'delta', text: 'part' }; throw new AIError('AI_PROVIDER_ERROR', 'api_key=sk-ant-SECRET', true); } };
    const a = make(broken);
    await expect(drain(ask(a.gateway))).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' }); expect(a.usage[0]).toMatchObject({ success: false, errorCode: 'AI_PROVIDER_ERROR' });
    const slow: LLMProvider = { name: 'slow', generate: async () => { throw new Error('x'); }, async *stream(req: LLMRequest): AsyncIterable<LLMStreamChunk> { yield { type: 'delta', text: 'a' }; if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError'); await new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))); } };
    const c = make(slow); const ac = new AbortController(); const seen: string[] = [];
    await expect((async () => { for await (const e of ask(c.gateway, ac.signal)) { seen.push(e.type); ac.abort(); } })()).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['delta']); expect(c.usage[0]).toMatchObject({ success: false, errorCode: 'CANCELLED' });
  });
});
