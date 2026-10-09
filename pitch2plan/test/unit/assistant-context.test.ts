import { describe, expect, it } from 'vitest';
import { buildAssistantContext, type AssistantContextInput, type TaskLite } from '@pitch2plan/domain';

const node = (stableKey: string, name: string, category: string, extra: object = {}) => ({ stableKey, name, technology: `${name} tech`, category, purpose: `${name} purpose`, description: `${name} description`, criticality: 'HIGH', provider: 'AWS', managedService: true, deploymentModel: 'MANAGED_SERVICE', configuration: [{ key: 'retention', value: '7 days' }], risks: [], alternatives: [], ...extra });
const task = (id: string, key: string, over: Partial<TaskLite> = {}): TaskLite => ({ id, key, title: `Task ${key}`, status: 'NOT_STARTED', taskType: 'CONFIGURATION', phaseName: 'Event infrastructure', dependsOn: [], componentKeys: ['event-stream'], decisionKeys: ['adr-001'], objective: 'Do the thing', instructions: 'Configure the stream', expectedOutcome: 'Configured', validationSteps: ['It is configured'], securityNotes: [], commonProblems: [], steps: [], ...over });
const base = (over: Partial<AssistantContextInput> = {}): AssistantContextInput => ({
  project: { id: 'p1', name: 'Fraud platform' }, brief: { projectSummary: 'Detect fraud in real time', businessObjective: 'Stop fraud' },
  requirements: [
    { code: 'REQ-001', category: 'TRAFFIC', statement: 'Handle 50M events per day', origin: 'USER_ANSWERED' },
    { code: 'REQ-002', category: 'SECURITY', statement: 'Encrypt financial data in transit', origin: 'USER_ANSWERED' },
    { code: 'REQ-003', category: 'FUNCTIONAL', statement: 'The merchant dashboard is built with React', origin: 'USER_STATED' },
    { code: 'REQ-004', category: 'BUDGET', statement: 'Keep the monthly bill low', origin: 'USER_ANSWERED' },
  ],
  drivers: [{ code: 'DRV-001', name: 'High-volume ingestion', description: 'x', priority: 'CRITICAL', requirementCodes: ['REQ-001'] }, { code: 'DRV-002', name: 'Dashboard', description: 'y', priority: 'LOW', requirementCodes: ['REQ-003'] }],
  architecture: {
    versionNumber: 1, summary: 'Streaming architecture',
    nodes: [node('event-stream', 'Event stream', 'EVENT_STREAM'), node('web-app', 'Merchant dashboard', 'CLIENT', { technology: 'React' }), node('stream-processor', 'Stream processor', 'STREAM_PROCESSOR'), node('analytics-db', 'Analytics store', 'DATABASE')],
    edges: [{ edgeKey: 'e1', sourceStableKey: 'event-stream', targetStableKey: 'stream-processor', label: 'events', protocol: 'TLS', communicationType: 'EVENT', dataDescription: 'Transactions', encrypted: true }, { edgeKey: 'e2', sourceStableKey: 'web-app', targetStableKey: 'analytics-db', label: 'queries', protocol: 'HTTPS', communicationType: 'REQUEST_RESPONSE', dataDescription: 'Reports', encrypted: true }],
    decisions: [{ key: 'adr-001', title: 'Durable event stream with replay', status: 'ACCEPTED', decision: 'Use a managed stream with 7 day replay', rationale: 'Events must not be lost', tradeoffs: ['Cost'], nodeStableKeys: ['event-stream'], driverCodes: ['DRV-001'], requirementCodes: ['REQ-001'] }, { key: 'adr-002', title: 'React dashboard', status: 'ACCEPTED', decision: 'Build the UI in React', rationale: 'Team knows it', tradeoffs: [], nodeStableKeys: ['web-app'], driverCodes: ['DRV-002'], requirementCodes: ['REQ-003'] }],
  },
  plan: { progress: { percent: 20, completed: 1, applicable: 5 }, tasks: [
    task('t-prov', 'provision-event-stream', { status: 'COMPLETED', title: 'Provision the event stream', taskType: 'INFRASTRUCTURE' }),
    task('t-auth', 'configure-event-stream', { status: 'IN_PROGRESS', title: 'Configure authentication', dependsOn: ['provision-event-stream'], steps: [{ id: 's1', sequence: 0, title: 'Create credentials', instruction: 'Create a role', expectedResult: 'Role exists', validation: '', status: 'NOT_STARTED' }, { id: 's2', sequence: 1, title: 'Restrict access', instruction: 'Limit producers', expectedResult: 'Others refused', validation: '', status: 'NOT_STARTED' }] }),
    task('t-prod', 'integrate-producers', { title: 'Connect producers', dependsOn: ['configure-event-stream'] }),
    task('t-ui', 'build-dashboard', { title: 'Build the React dashboard', componentKeys: ['web-app'], decisionKeys: ['adr-002'] }),
  ] },
  scope: { kind: 'TASK', scopeId: 't-auth' }, question: 'How do I configure authentication?', tail: [], ...over,
});
const text = (b: ReturnType<typeof buildAssistantContext>) => JSON.stringify(b.context);

describe('ContextBuilder: deterministic context selection', () => {
  it('sends what bears on the task and leaves the unrelated frontend out entirely', () => {
    const b = buildAssistantContext(base());
    const s = text(b);
    expect(s).toContain('Fraud platform'); expect(s).toContain('Event stream'); expect(s).toContain('Stream processor'); // the focus component and its neighbour
    expect(s).toContain('Durable event stream with replay'); expect(s).toContain('REQ-001'); expect(s).toContain('DRV-001');
    expect(s).toContain('Configure authentication'); // the current task
    expect(s).not.toContain('Merchant dashboard'); expect(s).not.toContain('React'); expect(s).not.toContain('REQ-003'); expect(s).not.toContain('adr-002'); expect(s).not.toContain('Analytics store');
    expect(s).not.toContain('Build the React dashboard'); expect(s).not.toContain('REQ-004'); // nor unrelated tasks or a budget requirement nobody asked about
    expect(b.stats.omitted.components).toBe(2);
  });

  it('adds topical requirements only when the question or task is about them', () => {
    expect(text(buildAssistantContext(base({ question: 'Is this configuration secure? How do I authenticate?' })))).toContain('REQ-002'); // security question
    expect(text(buildAssistantContext(base({ question: 'What is the next step?', plan: { ...base().plan!, tasks: base().plan!.tasks.map((t) => (t.id === 't-auth' ? { ...t, title: 'Configure retention' } : t)) } })))).not.toContain('REQ-002');
    expect(text(buildAssistantContext(base({ question: 'Can I make this cheaper?' })))).toContain('REQ-004');
    const secTask = base(); secTask.plan!.tasks.find((t) => t.id === 't-auth')!.taskType = 'SECURITY';
    expect(text(buildAssistantContext({ ...secTask, question: 'What now?' }))).toContain('REQ-002'); // a SECURITY task pulls security requirements in
  });

  it('includes the current step, related tasks with their relationship, and progress', () => {
    const b = buildAssistantContext(base({ scope: { kind: 'TASK', scopeId: 't-auth', stepId: 's2' } }));
    const c = b.context as { currentStep: { title: string }; currentTask: { steps: unknown[] }; relatedTasks: Array<{ title: string; relation: string }>; planProgress: { percent: number } };
    expect(c.currentStep.title).toBe('Restrict access'); expect(c.currentTask.steps).toHaveLength(2);
    expect(c.relatedTasks.map((t) => `${t.relation}:${t.title}`)).toEqual(expect.arrayContaining(['prerequisite:Provision the event stream', 'unblocked by this task:Connect producers']));
    expect(c.planProgress.percent).toBe(20);
    expect(b.refs).toEqual(expect.arrayContaining([{ type: 'task', id: 't-auth' }, { type: 'step', id: 's2' }, { type: 'component', id: 'event-stream' }, { type: 'decision', id: 'adr-001' }, { type: 'requirement', id: 'REQ-001' }]));
    expect(b.refs.some((r) => r.id === 'REQ-003' || r.id === 'web-app')).toBe(false);
  });

  it('scopes a component conversation to that component, and a project conversation to an overview', () => {
    const comp = buildAssistantContext(base({ scope: { kind: 'COMPONENT', scopeId: 'web-app' }, question: 'Why React?' }));
    expect(text(comp)).toContain('React dashboard'); expect(text(comp)).toContain('REQ-003'); expect(text(comp)).not.toContain('Durable event stream'); expect(text(comp)).not.toContain('"currentTask"');
    const proj = buildAssistantContext(base({ scope: { kind: 'PROJECT', scopeId: 'p1' }, question: 'Where are we?' }));
    const c = proj.context as { allComponents: unknown[]; focusComponents: unknown[]; decisions: unknown[] };
    expect(c.allComponents).toHaveLength(4); expect(c.focusComponents).toHaveLength(0); expect(c.decisions).toHaveLength(2);
  });

  it('keeps only a short, truncated conversation tail', () => {
    const tail = Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 ? 'ASSISTANT' : 'USER') as 'USER' | 'ASSISTANT', content: `message ${i} ${'x'.repeat(2000)}` }));
    const t = (buildAssistantContext(base({ tail })).context as { conversationTail: Array<{ content: string }> }).conversationTail;
    expect(t).toHaveLength(6); expect(t[5]!.content).toContain('message 11'); expect(t.every((m) => m.content.length <= 700)).toBe(true); expect(JSON.stringify(t)).not.toContain('message 5 ');
  });

  it('shrinks to fit a budget by dropping the least relevant material, never the focus', () => {
    const big = base({ maxChars: 6000 });
    big.requirements = Array.from({ length: 60 }, (_, i) => ({ code: `REQ-${100 + i}`, category: 'SECURITY', statement: `Security requirement number ${i} ${'detail '.repeat(40)}`, origin: 'USER_ANSWERED' }));
    big.architecture.decisions[0]!.rationale = 'long rationale '.repeat(400); big.architecture.nodes[0]!.description = 'long description '.repeat(300);
    big.plan!.tasks = [...big.plan!.tasks, ...Array.from({ length: 40 }, (_, i) => task(`x${i}`, `extra-${i}`, { title: `Extra ${i}` }))];
    const b = buildAssistantContext({ ...big, question: 'How do I secure this?', tail: Array.from({ length: 8 }, (_, i) => ({ role: 'USER' as const, content: `q${i} ${'y'.repeat(900)}` })) });
    expect(b.stats.level).toBeGreaterThan(0); expect(b.stats.chars).toBeLessThanOrEqual(6000 + 2500); // the focus itself is never dropped
    expect(text(b)).toContain('Configure authentication'); expect(text(b)).toContain('Event stream');
    expect(b.stats.omitted.requirements).toBeGreaterThan(50); expect(b.stats.omitted.tasks).toBeGreaterThan(30);
  });

  it('degrades safely: an unknown task id yields project context, not a crash or someone else\'s data', () => {
    const b = buildAssistantContext(base({ scope: { kind: 'TASK', scopeId: 'ghost' } }));
    expect(b.context).not.toHaveProperty('currentTask'); expect((b.context as { focusComponents: unknown[] }).focusComponents).toEqual([]);
    expect(buildAssistantContext(base({ plan: null })).context).not.toHaveProperty('planProgress');
  });
});
