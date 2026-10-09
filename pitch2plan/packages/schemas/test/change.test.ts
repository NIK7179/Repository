import { describe, expect, it } from 'vitest';
import {
  PROPOSAL_STATES, PROPOSAL_TRANSITIONS, analyzeNodeFailure, applyChangeOperations, architecturePlanSchema, canTransitionProposal, changeAnalysisSchema, changePlanSchema, checkMigrationInvariants, classifyTaskImpact,
  deterministicReview, diffArchitectures, impactSeverity, mapTasksAcrossPlans, requiresReconfirmation, validateChangeAnalysis, validateReviewOutput, reviewOutputSchema,
  type ArchitectureDiff, type ArchitecturePlan, type DiffInput, type MigTask, type ChangePlan,
} from '../src';

const node = (stableKey: string, name: string, technology: string, slug: string, category: string, o: object = {}) => ({ stableKey, name, technology, technologySlug: slug, category, purpose: `${name} purpose`, description: `${name} description text`, criticality: 'HIGH', managedService: false, deploymentModel: 'SELF_HOSTED', provider: null, configuration: [], risks: [], alternatives: [], replacesStableKey: null, ...o });
const edge = (id: string, s: string, t: string, o: object = {}) => ({ id, sourceStableKey: s, targetStableKey: t, label: `${s} to ${t}`, protocol: 'TLS', communicationType: 'EVENT', dataDescription: 'Transaction events', synchronous: false, criticality: 'HIGH', encrypted: true, ...o });
const decision = (key: string, title: string, nodes: string[], o: object = {}) => ({ key, title, problem: 'A problem that needs a decision here.', decision: `We decided: ${title}.`, rationale: 'Because the requirements need this and the team agreed on it.', status: 'ACCEPTED', confidence: 0.8, nodeStableKeys: nodes, edgeIds: [], driverCodes: [], requirementCodes: [], ...o });
const base = (): ArchitecturePlan => architecturePlanSchema.parse({
  summary: 'Producers publish transaction events to Kafka, a processor enriches them and stores results in object storage.',
  nodes: [node('event-producers', 'Event producers', 'Existing services', 'existing-services', 'APPLICATION_SERVICE'), node('event-stream', 'Event stream', 'Apache Kafka', 'apache-kafka', 'EVENT_STREAM', { criticality: 'CRITICAL', configuration: [{ key: 'retention', value: '7 days' }] }),
    node('stream-processor', 'Stream processor', 'ECS service', 'ecs', 'STREAM_PROCESSOR'), node('analytics-storage', 'Analytics storage', 'Amazon S3', 'amazon-s3', 'OBJECT_STORAGE', { managedService: true, deploymentModel: 'MANAGED_SERVICE', provider: 'AWS' })],
  edges: [edge('producers-stream', 'event-producers', 'event-stream'), edge('stream-processor-in', 'event-stream', 'stream-processor'), edge('processor-storage', 'stream-processor', 'analytics-storage', { communicationType: 'BATCH', protocol: 'HTTPS' })],
  decisions: [decision('adr-001', 'Use Kafka as the event backbone', ['event-stream']), decision('adr-002', 'Run the processor on ECS', ['stream-processor']), decision('adr-003', 'Store results in S3', ['analytics-storage'])],
});
const kinesis = { name: 'Event stream', technology: 'Amazon Kinesis', technologySlug: 'amazon-kinesis', purpose: 'Durable event backbone for transactions', description: 'Managed stream with seven day retention and several consumers.', managedService: true, deploymentModel: 'MANAGED_SERVICE' as const, provider: 'AWS' };
const dec = (title: string) => ({ title, problem: 'A problem that needs a decision here.', decision: `We decided: ${title}.`, rationale: 'Because the requirements need this and the team agreed on it.', status: 'ACCEPTED' as const, confidence: 0.8 });
const plan = (ops: unknown[], extra: object = {}): ChangePlan => changePlanSchema.parse({ summary: 'Replace the Kafka backbone with Amazon Kinesis and update the related decision.', operations: ops, ...extra });
const toDiff = (p: ArchitecturePlan): DiffInput => ({
  nodes: p.nodes.map((n) => ({ ...n })), edges: p.edges.map((e) => ({ edgeKey: e.id, sourceStableKey: e.sourceStableKey, targetStableKey: e.targetStableKey, label: e.label, protocol: e.protocol, communicationType: e.communicationType, dataDescription: e.dataDescription, synchronous: e.synchronous, encrypted: e.encrypted, criticality: e.criticality })),
  decisions: p.decisions.map((d) => ({ key: d.key, title: d.title, decision: d.decision, rationale: d.rationale, status: d.status, nodeStableKeys: d.nodeStableKeys, supersedesKey: d.supersedesKey })),
});

describe('proposal state machine', () => {
  const allowed = new Set(Object.entries(PROPOSAL_TRANSITIONS).flatMap(([a, bs]) => bs.map((b) => `${a}>${b}`)));
  it('permits exactly the declared transitions and nothing else', () => {
    for (const a of PROPOSAL_STATES) for (const b of PROPOSAL_STATES) expect(canTransitionProposal(a, b), `${a}>${b}`).toBe(allowed.has(`${a}>${b}`));
  });
  it('has the safety properties that matter: no state is skipped on the way to APPLIED, and terminal states are terminal', () => {
    expect(canTransitionProposal('READY_FOR_REVIEW', 'APPLYING')).toBe(false); // approval must come first
    expect(canTransitionProposal('DRAFT', 'APPROVED')).toBe(false); expect(canTransitionProposal('ANALYZING', 'APPROVED')).toBe(false); expect(canTransitionProposal('STALE', 'APPROVED')).toBe(false);
    expect(canTransitionProposal('APPROVED', 'APPLIED')).toBe(false); expect(canTransitionProposal('REJECTED', 'DRAFT')).toBe(false); expect(canTransitionProposal('APPLIED', 'DRAFT')).toBe(false);
    expect(PROPOSAL_TRANSITIONS.APPLIED).toEqual([]); expect(PROPOSAL_TRANSITIONS.REJECTED).toEqual([]); expect(PROPOSAL_TRANSITIONS.STALE).toEqual(['REJECTED']);
    for (const s of PROPOSAL_STATES) expect(canTransitionProposal(s, s)).toBe(false);
  });
});

describe('change analysis contract', () => {
  const imp = { direction: 'MIXED', notes: 'Some things improve and some get worse.' };
  const analysis = (o: object = {}) => changeAnalysisSchema.parse({ summary: 'Replace Kafka with Kinesis across the event backbone.', changeType: 'TECHNOLOGY_REPLACEMENT', whatChanges: ['Event backbone technology'], performanceImpact: imp, securityImpact: imp, reliabilityImpact: imp, costImpact: imp, complexityImpact: imp, operationalImpact: imp, migrationImpact: imp, implementationImpact: imp,
    recommendation: { verdict: 'PROCEED_WITH_CAUTION', rationale: 'It fits the AWS preference but needs producer and consumer work.' }, confidence: 0.7, ...o });
  const ctx = { nodeKeys: ['event-stream', 'stream-processor'], edgeIds: ['producers-stream'], decisionKeys: ['adr-001'], driverCodes: ['DRV-001'], requirementCodes: ['REQ-001'], taskKeys: ['provision-event-stream'] };
  it('accepts references that exist and rejects invented components, decisions, requirements, drivers and tasks', () => {
    expect(validateChangeAnalysis(analysis({ affectedNodes: [{ key: 'event-stream', relation: 'DIRECT', reason: 'It is the replaced component' }], affectedTasks: [{ key: 'provision-event-stream', relation: 'DIRECT', reason: 'Provisioning Kafka' }] }), ctx)).toEqual([]);
    const bad = validateChangeAnalysis(analysis({ affectedNodes: [{ key: 'ghost', relation: 'DIRECT', reason: 'Not a real component' }], affectedDecisions: [{ key: 'adr-099', relation: 'DIRECT', reason: 'Not a real decision' }], affectedTasks: [{ key: 'ghost-task', relation: 'POTENTIAL', reason: 'Not a real task at all' }], affectedRequirements: [{ key: 'REQ-099', relation: 'DIRECT', reason: 'Not real' }], affectedDrivers: [{ key: 'DRV-099', relation: 'DIRECT', reason: 'Not real' }] }), ctx);
    expect(bad).toHaveLength(5); expect(bad.join(' ')).toMatch(/ghost/);
  });
  it('validates requirement changes: an ADD names no requirement, MODIFY/REMOVE must name an existing one', () => {
    const rc = (o: object) => ({ kind: 'MODIFY', requirementCode: 'REQ-001', category: 'AVAILABILITY', statement: 'Available across two regions', reason: 'Business expansion', ...o });
    expect(validateChangeAnalysis(analysis({ requirementChanges: [rc({}), rc({ kind: 'ADD', requirementCode: null })] }), ctx)).toEqual([]);
    expect(validateChangeAnalysis(analysis({ requirementChanges: [rc({ kind: 'ADD' })] }), ctx).join()).toMatch(/ADD must not name/);
    expect(validateChangeAnalysis(analysis({ requirementChanges: [rc({ requirementCode: 'REQ-077' })] }), ctx).join()).toMatch(/existing requirement code/);
    expect(validateChangeAnalysis(analysis({ requirementChanges: [rc({ kind: 'REMOVE', requirementCode: null })] }), ctx).join()).toMatch(/existing requirement code/);
  });
  it('forces requirement reconfirmation only when requirements actually change (the deterministic threshold)', () => {
    expect(requiresReconfirmation(analysis())).toBe(false); // a plain technology substitution
    expect(requiresReconfirmation(analysis({ changeType: 'REQUIREMENT_CHANGE' }))).toBe(true);
    expect(requiresReconfirmation(analysis({ requirementChanges: [{ kind: 'ADD', category: 'AVAILABILITY', statement: 'Available across regions', reason: 'Expansion' }] }))).toBe(true);
    expect(requiresReconfirmation(analysis({ changeType: 'CONFIGURATION_CHANGE' }))).toBe(false);
  });
  it('derives severity from facts: completed work, breadth and change type', () => {
    expect(impactSeverity(analysis({ changeType: 'CONFIGURATION_CHANGE' }), { completedTasksAtRisk: 0, directNodes: 0 })).toBe('LOW');
    expect(impactSeverity(analysis(), { completedTasksAtRisk: 3, directNodes: 1 })).toBe('MEDIUM');
    expect(impactSeverity(analysis({ changeType: 'REQUIREMENT_CHANGE', requirementChanges: [{ kind: 'ADD', category: 'AVAILABILITY', statement: 'Multi-region availability', reason: 'x1234' }] }), { completedTasksAtRisk: 6, directNodes: 4 })).toBe('CRITICAL');
  });
  it('separates completed work at risk, direct and potential impact, and possibly reusable work', () => {
    const tasks = [
      { id: '1', key: 'provision-event-stream', title: 'Provision stream', status: 'COMPLETED', taskType: 'INFRASTRUCTURE', componentKeys: ['event-stream'], decisionKeys: ['adr-001'] },
      { id: '2', key: 'configure-stream-processor', title: 'Configure processor', status: 'COMPLETED', taskType: 'CONFIGURATION', componentKeys: ['stream-processor'], decisionKeys: [] },
      { id: '3', key: 'configure-storage', title: 'Configure storage', status: 'COMPLETED', taskType: 'CONFIGURATION', componentKeys: ['analytics-storage'], decisionKeys: [] },
      { id: '4', key: 'monitor-stream', title: 'Monitor stream', status: 'IN_PROGRESS', taskType: 'OBSERVABILITY', componentKeys: ['event-stream'], decisionKeys: [] },
    ];
    const r = classifyTaskImpact(tasks, base().edges.map((e) => ({ source: e.sourceStableKey, target: e.targetStableKey })), ['event-stream'], ['adr-001']);
    expect(r.items.map((i) => `${i.task.key}:${i.relation}`).sort()).toEqual(['configure-stream-processor:POTENTIAL', 'monitor-stream:DIRECT', 'provision-event-stream:DIRECT']); // storage is not adjacent
    expect(r.completedAtRisk.map((i) => i.task.key).sort()).toEqual(['configure-stream-processor', 'provision-event-stream']); expect(r.inProgressAtRisk).toHaveLength(1);
    expect(r.possiblyReusable.map((i) => i.task.key)).toEqual(['configure-stream-processor']); // only a neighbour: may partly carry forward
  });
});

describe('applying change operations (the model never writes the architecture)', () => {
  it('REPLACE_NODE keepRole keeps the stableKey and changes only the technology', () => {
    const r = applyChangeOperations(base(), plan([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: true, node: kinesis }]));
    expect(r.errors).toEqual([]);
    const n = r.plan.nodes.find((x) => x.stableKey === 'event-stream')!;
    expect(n).toMatchObject({ technology: 'Amazon Kinesis', technologySlug: 'amazon-kinesis', category: 'EVENT_STREAM', managedService: true, criticality: 'CRITICAL', replacesStableKey: null });
    expect(r.plan.nodes).toHaveLength(4); expect(r.plan.edges).toHaveLength(3); expect(r.renames).toEqual([]);
    expect(r.plan.nodes.find((x) => x.stableKey === 'stream-processor')).toEqual(base().nodes.find((x) => x.stableKey === 'stream-processor')); // everything else is untouched
  });
  it('REPLACE_NODE with a changed role requires a NEW stableKey, records lineage and rewires connections and decisions', () => {
    const r = applyChangeOperations(base(), plan([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: false, newStableKey: 'message-queue', node: { ...kinesis, name: 'Message queue', technology: 'Amazon SQS', technologySlug: 'amazon-sqs', category: 'QUEUE' } }]));
    expect(r.errors).toEqual([]);
    expect(r.plan.nodes.map((n) => n.stableKey)).toContain('message-queue'); expect(r.plan.nodes.map((n) => n.stableKey)).not.toContain('event-stream');
    expect(r.plan.nodes.find((n) => n.stableKey === 'message-queue')).toMatchObject({ replacesStableKey: 'event-stream', category: 'QUEUE' });
    expect(r.plan.edges.filter((e) => e.sourceStableKey === 'message-queue' || e.targetStableKey === 'message-queue')).toHaveLength(2);
    expect(r.plan.decisions.find((d) => d.key === 'adr-001')!.nodeStableKeys).toEqual(['message-queue']); expect(r.renames).toEqual([{ from: 'event-stream', to: 'message-queue' }]);
  });
  it('enforces the stable-key rules explicitly', () => {
    const errs = (ops: unknown[]) => applyChangeOperations(base(), plan(ops)).errors.join(' | ');
    expect(errs([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: true, node: { ...kinesis, category: 'QUEUE' } }])).toMatch(/keepRole=true requires the same category/);
    expect(errs([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: true, newStableKey: 'other-key', node: kinesis }])).toMatch(/keeps the stableKey/);
    expect(errs([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: false, node: kinesis }])).toMatch(/requires a newStableKey/);
    expect(errs([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: false, newStableKey: 'stream-processor', node: kinesis }])).toMatch(/already used/);
    expect(errs([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: true, node: { ...kinesis, technologySlug: 'apache-kafka' } }])).toMatch(/technology is unchanged/);
    expect(errs([{ op: 'REPLACE_NODE', stableKey: 'ghost', keepRole: true, node: kinesis }])).toMatch(/unknown component/);
    expect(errs([{ op: 'ADD_NODE', node: node('event-stream', 'Another stream', 'Xyz queue', 'xyz', 'QUEUE') }])).toMatch(/already used/);
    expect(errs([{ op: 'REMOVE_NODE', stableKey: 'event-producers' }, { op: 'ADD_NODE', node: node('event-producers', 'Producers again', 'Yyy service', 'yyy', 'APPLICATION_SERVICE') }])).toMatch(/never reused/); // a removed key is never reused
    expect(() => changePlanSchema.parse({ summary: 'x'.repeat(30), operations: [{ op: 'UPDATE_NODE', stableKey: 'event-stream', set: { technologySlug: 'new' } }] })).toThrow(); // UPDATE cannot change the technology
    expect(() => changePlanSchema.parse({ summary: 'x'.repeat(30), operations: [{ op: 'UPDATE_NODE', stableKey: 'event-stream', set: { category: 'QUEUE' } }] })).toThrow(); // nor the role
  });
  it('SUPERSEDE_DECISION never deletes history: a NEW key (never reused) records what it supersedes', () => {
    const r = applyChangeOperations(base(), plan([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: true, node: kinesis }, { op: 'SUPERSEDE_DECISION', key: 'adr-001', decision: { ...dec('Use Kinesis as the event backbone'), nodeStableKeys: ['event-stream'] } }]));
    expect(r.errors).toEqual([]);
    expect(r.plan.decisions.map((d) => d.key)).toEqual(['adr-002', 'adr-003', 'adr-004']); expect(r.supersessions).toEqual([{ newKey: 'adr-004', supersedesKey: 'adr-001' }]);
    expect(r.plan.decisions.find((d) => d.key === 'adr-004')).toMatchObject({ supersedesKey: 'adr-001', title: 'Use Kinesis as the event backbone' });
    const twice = applyChangeOperations(base(), plan([{ op: 'SUPERSEDE_DECISION', key: 'adr-001', decision: dec('First replacement') }, { op: 'SUPERSEDE_DECISION', key: 'adr-001', decision: dec('Second replacement') }]));
    expect(twice.errors.join()).toMatch(/already superseded|unknown decision/);
    const added = applyChangeOperations(base(), plan([{ op: 'ADD_DECISION', decision: dec('Add monitoring') }, { op: 'ADD_DECISION', decision: dec('Add alerting') }]));
    expect(added.plan.decisions.map((d) => d.key)).toEqual(['adr-001', 'adr-002', 'adr-003', 'adr-004', 'adr-005']);
  });
  it('cleans up after removals (connections and decision links) and reports it', () => {
    const r = applyChangeOperations(base(), plan([{ op: 'REMOVE_NODE', stableKey: 'stream-processor' }]));
    expect(r.plan.edges.map((e) => e.id)).toEqual(['producers-stream']); expect(r.notes.join()).toMatch(/2 connection\(s\) removed.*stream-processor-in, processor-storage/);
    expect(r.plan.decisions.find((d) => d.key === 'adr-002')!.nodeStableKeys).toEqual([]); // left for validation and the critic to deal with, never silently dropped
  });
  it('updates connections and decisions in place, and never mutates its input', () => {
    const input = base(); const snapshot = JSON.stringify(input);
    const r = applyChangeOperations(input, plan([{ op: 'UPDATE_EDGE', id: 'producers-stream', set: { protocol: 'HTTPS', communicationType: 'STREAM' } }, { op: 'UPDATE_DECISION', key: 'adr-002', set: { rationale: 'Because the team already operates ECS and wants no new platform to run.' } }, { op: 'ADD_EDGE', edge: edge('stream-storage', 'event-stream', 'analytics-storage', { communicationType: 'BATCH' }) }, { op: 'REMOVE_EDGE', id: 'processor-storage' }]));
    expect(r.errors).toEqual([]); expect(r.plan.edges.find((e) => e.id === 'producers-stream')).toMatchObject({ protocol: 'HTTPS', communicationType: 'STREAM' });
    expect(r.plan.edges.map((e) => e.id).sort()).toEqual(['producers-stream', 'stream-processor-in', 'stream-storage']); expect(JSON.stringify(input)).toBe(snapshot);
    expect(applyChangeOperations(base(), plan([{ op: 'ADD_EDGE', edge: edge('x1', 'event-stream', 'ghost') }])).notes.join()).toMatch(/removed because a component they used no longer exists/);
  });
});

describe('architecture diff (deterministic, from stored data)', () => {
  const after = (ops: unknown[]) => applyChangeOperations(base(), plan(ops)).plan;
  const diff = (p: ArchitecturePlan, from = base()) => diffArchitectures(toDiff(from), toDiff(p));
  it('reports an identical architecture as all UNCHANGED, with no differences', () => {
    const d = diff(base()); expect(d.summary.sentences).toEqual(['No differences']); expect(d.nodes.every((n) => n.kind === 'UNCHANGED')).toBe(true); expect(d.edges.every((e) => e.kind === 'UNCHANGED')).toBe(true);
  });
  it('classifies a technology replacement as REPLACED and links the unchanged connections to it', () => {
    const d = diff(after([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: true, node: kinesis }, { op: 'SUPERSEDE_DECISION', key: 'adr-001', decision: { ...dec('Use Kinesis as the event backbone'), nodeStableKeys: ['event-stream'] } }]));
    expect(d.nodes.find((n) => n.stableKey === 'event-stream')).toMatchObject({ kind: 'REPLACED', from: { technology: 'Apache Kafka' }, to: { technology: 'Amazon Kinesis' }, changes: ['technology'] });
    expect(d.nodes.filter((n) => n.kind === 'UNCHANGED').map((n) => n.stableKey).sort()).toEqual(['analytics-storage', 'event-producers', 'stream-processor']);
    expect(d.edges.filter((e) => e.touchesChangedComponent).map((e) => e.edgeKey).sort()).toEqual(['producers-stream', 'stream-processor-in']); expect(d.edges.every((e) => e.kind === 'UNCHANGED')).toBe(true);
    expect(d.decisions.find((x) => x.key === 'adr-001')).toMatchObject({ kind: 'SUPERSEDED', supersededBy: 'adr-004' }); expect(d.decisions.find((x) => x.key === 'adr-004')).toMatchObject({ kind: 'ADDED', supersedes: 'adr-001' });
    expect(d.summary.sentences).toEqual(['1 component replaced', '1 decision superseded', '1 decision added']);
  });
  it('classifies a role change (new stableKey) as one REPLACED entry and modifications by field', () => {
    const d = diff(after([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: false, newStableKey: 'message-queue', node: { ...kinesis, name: 'Message queue', technology: 'Amazon SQS', technologySlug: 'amazon-sqs', category: 'QUEUE' } }]));
    expect(d.nodes.filter((n) => n.kind === 'REPLACED')).toEqual([expect.objectContaining({ stableKey: 'message-queue', from: { stableKey: 'event-stream', technology: 'Apache Kafka' }, changes: ['stableKey', 'technology', 'role'] })]);
    expect(d.nodes.some((n) => n.stableKey === 'event-stream' && n.kind === 'REMOVED')).toBe(false);
    const m = diff(after([{ op: 'UPDATE_NODE', stableKey: 'event-stream', set: { criticality: 'MEDIUM', configuration: [{ key: 'retention', value: '14 days' }] } }, { op: 'UPDATE_EDGE', id: 'producers-stream', set: { protocol: 'HTTPS', synchronous: true } }]));
    expect(m.nodes.find((n) => n.stableKey === 'event-stream')).toMatchObject({ kind: 'MODIFIED', changes: ['criticality', 'configuration'] });
    expect(m.edges.find((e) => e.edgeKey === 'producers-stream')).toMatchObject({ kind: 'MODIFIED', changes: ['protocol', 'communication pattern'] });
  });
  it('reports added and removed components and connections', () => {
    const d = diff(after([{ op: 'ADD_NODE', node: node('cache', 'Cache', 'Redis', 'redis', 'CACHE') }, { op: 'ADD_EDGE', edge: edge('processor-cache', 'stream-processor', 'cache') }, { op: 'REMOVE_NODE', stableKey: 'analytics-storage' }]));
    expect(d.nodes.filter((n) => n.kind === 'ADDED' || n.kind === 'REMOVED').map((n) => `${n.kind}:${n.stableKey}`).sort()).toEqual(['ADDED:cache', 'REMOVED:analytics-storage']);
    expect(d.edges.filter((e) => e.kind !== 'UNCHANGED').map((e) => `${e.kind}:${e.edgeKey}`).sort()).toEqual(['ADDED:processor-cache', 'REMOVED:processor-storage']);
  });
  it('is symmetric in counts and is computed purely from its two inputs', () => {
    const v2 = after([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: true, node: kinesis }]);
    expect(JSON.stringify(diff(v2))).toBe(JSON.stringify(diff(v2))); expect(diffArchitectures(toDiff(v2), toDiff(base())).summary.nodes.REPLACED).toBe(1);
  });
});

describe('task migration across plans', () => {
  const tk = (key: string, status: string, comps: string[], o: Partial<MigTask> = {}): MigTask => ({ id: `id-${key}`, key, title: `Task ${key.replaceAll('-', ' ')}`, taskType: 'CONFIGURATION', status, componentKeys: comps, decisionKeys: [], ...o });
  const v1 = () => [tk('prepare-environment', 'COMPLETED', [], { taskType: 'SETUP' }), tk('secrets-and-identity', 'COMPLETED', [], { taskType: 'SECURITY' }), tk('provision-event-stream', 'COMPLETED', ['event-stream'], { decisionKeys: ['adr-001'], taskType: 'INFRASTRUCTURE' }),
    tk('configure-event-stream', 'IN_PROGRESS', ['event-stream']), tk('configure-stream-processor', 'COMPLETED', ['stream-processor']), tk('configure-analytics-storage', 'COMPLETED', ['analytics-storage']), tk('integrate-producers-stream', 'COMPLETED', ['event-producers', 'event-stream'], { taskType: 'INTEGRATION' }),
    tk('monitor-analytics-storage', 'NOT_STARTED', ['analytics-storage'], { taskType: 'OBSERVABILITY' })];
  const kafkaToKinesis = (): ArchitectureDiff => diffArchitectures(toDiff(base()), toDiff(applyChangeOperations(base(), plan([{ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: true, node: kinesis }, { op: 'SUPERSEDE_DECISION', key: 'adr-001', decision: { ...dec('Use Kinesis as the event backbone'), nodeStableKeys: ['event-stream'] } }])).plan));
  const outcome = (items: ReturnType<typeof mapTasksAcrossPlans>['items'], key: string, side: 'v1' | 'v2' = 'v1') => items.find((i) => (side === 'v1' ? i.v1TaskId : i.v2TaskId) === `id-${key}`)?.outcome;

  it('carries nothing onto a replaced technology, revalidates neighbours, and carries what is genuinely unchanged', () => {
    const v2 = v1().map((t) => ({ ...t, id: `id-${t.key}`, status: 'NOT_STARTED' }));
    const { items, summary } = mapTasksAcrossPlans(v1(), v2, kafkaToKinesis());
    expect(checkMigrationInvariants(items, v1(), v2)).toEqual([]);
    expect(outcome(items, 'prepare-environment')).toBe('CARRIED_FORWARD'); // a foundation task with no components
    expect(outcome(items, 'secrets-and-identity')).toBe('REQUIRES_REVALIDATION'); // system-wide security work, and the architecture changed
    expect(outcome(items, 'provision-event-stream')).toBe('OBSOLETE'); expect(items.find((i) => i.v2TaskId === 'id-provision-event-stream')).toMatchObject({ outcome: 'NEW' }); // completed Kafka work does not carry onto Kinesis
    expect(outcome(items, 'configure-event-stream')).toBe('OBSOLETE'); // in-progress work on the replaced component is lost too
    expect(outcome(items, 'integrate-producers-stream')).toBe('OBSOLETE');
    expect(outcome(items, 'configure-stream-processor')).toBe('REQUIRES_REVALIDATION'); // its inbound connection's other end changed
    expect(outcome(items, 'configure-analytics-storage')).toBe('CARRIED_FORWARD'); // not adjacent to the change
    expect(outcome(items, 'monitor-analytics-storage')).toBe('UNCHANGED_NOT_STARTED');
    expect(summary).toMatchObject({ carriedForward: 2, requiresRevalidation: 2, obsoleteCompleted: 2, completedInV1: 6, v1Tasks: 8, v2Tasks: 8 });
  });
  it('never claims anything is complete when the change is not understood: a component the diff does not know is treated as gone', () => {
    const v2 = [tk('configure-mystery', 'NOT_STARTED', ['mystery'])]; const r = mapTasksAcrossPlans([tk('configure-mystery', 'COMPLETED', ['mystery'])], v2, kafkaToKinesis());
    expect(r.items.map((i) => i.outcome).sort()).toEqual(['NEW', 'OBSOLETE']);
  });
  it('matches renamed tasks by type, components and title; unmatched work is OBSOLETE or NEW', () => {
    const a = [tk('configure-analytics-storage', 'COMPLETED', ['analytics-storage'], { title: 'Configure and secure Analytics storage' }), tk('old-only', 'COMPLETED', ['analytics-storage'], { taskType: 'TESTING' })];
    const b = [tk('setup-analytics-storage', 'NOT_STARTED', ['analytics-storage'], { title: 'Configure and secure Analytics storage' }), tk('brand-new', 'NOT_STARTED', ['stream-processor'])];
    const { items } = mapTasksAcrossPlans(a, b, kafkaToKinesis());
    expect(checkMigrationInvariants(items, a, b)).toEqual([]);
    expect(items.find((i) => i.v1TaskId === 'id-configure-analytics-storage')).toMatchObject({ outcome: 'CARRIED_FORWARD', v2TaskId: 'id-setup-analytics-storage' });
    expect(items.find((i) => i.v1TaskId === 'id-old-only')).toMatchObject({ outcome: 'OBSOLETE' }); expect(items.find((i) => i.v2TaskId === 'id-brand-new')).toMatchObject({ outcome: 'NEW' });
  });
  it('revalidates (does not carry) when a decision a task carries out was superseded but its component was not replaced', () => {
    const d = diffArchitectures(toDiff(base()), toDiff(applyChangeOperations(base(), plan([{ op: 'SUPERSEDE_DECISION', key: 'adr-002', decision: { ...dec('Run the processor on Lambda'), nodeStableKeys: ['stream-processor'] } }])).plan));
    const a = [tk('configure-stream-processor', 'COMPLETED', ['stream-processor'], { decisionKeys: ['adr-002'] })];
    expect(mapTasksAcrossPlans(a, a.map((t) => ({ ...t, status: 'NOT_STARTED' })), d).items[0]).toMatchObject({ outcome: 'REQUIRES_REVALIDATION' });
  });
  it('carries everything completed when nothing changed, and nothing half-done is ever carried', () => {
    const same = diffArchitectures(toDiff(base()), toDiff(base())); const a = [...v1()];
    const { items } = mapTasksAcrossPlans(a, a.map((t) => ({ ...t, status: 'NOT_STARTED' })), same);
    expect(items.filter((i) => i.outcome === 'CARRIED_FORWARD').map((i) => i.v1Status)).toEqual(Array(items.filter((i) => i.outcome === 'CARRIED_FORWARD').length).fill('COMPLETED'));
    expect(items.find((i) => i.v1TaskId === 'id-configure-event-stream')).toMatchObject({ outcome: 'UNCHANGED_NOT_STARTED' }); // in progress is not carried
  });

  it('PROPERTY: across thousands of random plans and changes, CARRIED_FORWARD never touches anything that changed, and every task is accounted for exactly once', () => {
    let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const comps = ['a', 'b', 'c', 'd', 'e']; const statuses = ['COMPLETED', 'COMPLETED', 'NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'SKIPPED']; const types = ['SETUP', 'CONFIGURATION', 'SECURITY', 'TESTING', 'INTEGRATION', 'OBSERVABILITY'];
    let carried = 0;
    for (let round = 0; round < 3000; round++) {
      const kinds = Object.fromEntries(comps.map((c) => [c, pick(['UNCHANGED', 'UNCHANGED', 'UNCHANGED', 'MODIFIED', 'REPLACED', 'REMOVED'] as const)]));
      const diff: ArchitectureDiff = {
        nodes: comps.map((c) => ({ kind: kinds[c]!, stableKey: c, name: c, changes: [], from: { stableKey: c, technology: 't' }, to: kinds[c] === 'REMOVED' ? null : { stableKey: c, technology: 't2' } })),
        edges: ['a>b', 'b>c', 'c>d', 'd>e'].map((s, i) => { const [x, y] = s.split('>') as [string, string]; return { kind: pick(['UNCHANGED', 'UNCHANGED', 'MODIFIED', 'REMOVED'] as const), edgeKey: `e${i}`, source: x, target: y, label: s, changes: [], touchesChangedComponent: kinds[x] !== 'UNCHANGED' || kinds[y] !== 'UNCHANGED' }; }),
        decisions: ['adr-001', 'adr-002'].map((k) => ({ kind: pick(['UNCHANGED', 'UNCHANGED', 'MODIFIED', 'SUPERSEDED'] as const), key: k, title: k, supersededBy: null, supersedes: null, changes: [] })),
        summary: {} as never,
      };
      const n = 3 + Math.floor(rnd() * 8);
      const a: MigTask[] = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, key: `k${i}`, title: `Task number ${i} for ${i % 3}`, taskType: pick(types), status: pick(statuses), componentKeys: rnd() < 0.2 ? [] : Array.from(new Set([pick(comps), ...(rnd() < 0.3 ? [pick(comps)] : [])])), decisionKeys: rnd() < 0.4 ? [pick(['adr-001', 'adr-002'])] : [] }));
      const b: MigTask[] = [...a.filter(() => rnd() < 0.9).map((t) => ({ ...t, id: `n${t.id}`, status: 'NOT_STARTED' })), ...(rnd() < 0.5 ? [{ id: 'nx', key: 'extra', title: 'Extra work', taskType: 'CODE', status: 'NOT_STARTED', componentKeys: [pick(comps)], decisionKeys: [] }] : [])];
      const { items } = mapTasksAcrossPlans(a, b, diff);
      expect(checkMigrationInvariants(items, a, b)).toEqual([]);
      for (const it of items.filter((x) => x.outcome === 'CARRIED_FORWARD')) {
        carried++; const t = a.find((x) => x.id === it.v1TaskId)!;
        for (const c of t.componentKeys) { expect(kinds[c], `carried ${t.key} on ${c}`).toBe('UNCHANGED'); }
        for (const e of diff.edges) if (t.componentKeys.includes(e.source) || t.componentKeys.includes(e.target)) { expect(e.kind).toBe('UNCHANGED'); expect(e.touchesChangedComponent).toBe(false); }
        for (const d of t.decisionKeys) expect(diff.decisions.find((x) => x.key === d)!.kind).toBe('UNCHANGED');
        expect(t.status).toBe('COMPLETED');
      }
    }
    expect(carried).toBeGreaterThan(200); // the property was exercised, not vacuous
  });
});

describe('failure-mode analysis (graph first)', () => {
  const g = (p = base()) => ({ nodes: p.nodes.map((n) => ({ ...n })), edges: p.edges.map((e) => ({ edgeKey: e.id, sourceStableKey: e.sourceStableKey, targetStableKey: e.targetStableKey, communicationType: e.communicationType, synchronous: e.synchronous })), decisions: p.decisions });
  it('computes downstream and upstream impact, critical paths and the blast radius from the graph', () => {
    const a = analyzeNodeFailure(g(), 'event-stream');
    expect(a.directlyAffected.stopReceiving.map((x) => x.stableKey)).toEqual(['stream-processor']); expect(a.directlyAffected.cannotReach.map((x) => x.stableKey)).toEqual(['event-producers']);
    expect(a.downstream.map((x) => x.stableKey).sort()).toEqual(['analytics-storage', 'stream-processor']); expect(a.upstream.map((x) => x.stableKey)).toEqual(['event-producers']);
    expect(a.criticalPaths).toEqual([['Event producers', 'Event stream']]); expect(a.blastRadius).toBe(3);
  });
  it('finds existing and missing mitigation, and flags a single point of failure only when it applies', () => {
    const a = analyzeNodeFailure(g(), 'event-stream');
    expect(a.existingMitigation.join()).toMatch(/Configuration records retention = 7 days/); expect(a.existingMitigation.join()).toMatch(/decoupled by asynchronous/);
    expect(a.missingMitigation.join()).toMatch(/No redundancy or failover is recorded/); expect(a.singlePointOfFailure).toBe(true);
    const redundant = base(); redundant.nodes.find((n) => n.stableKey === 'event-stream')!.configuration.push({ key: 'replication factor', value: '3 across zones' });
    const b = analyzeNodeFailure(g(redundant), 'event-stream'); expect(b.singlePointOfFailure).toBe(false); expect(b.missingMitigation.join()).not.toMatch(/No redundancy/);
    expect(analyzeNodeFailure(g(), 'analytics-storage').existingMitigation.join()).toMatch(/managed service/); expect(() => analyzeNodeFailure(g(), 'ghost')).toThrow(/unknown component/);
  });
});

describe('production readiness review', () => {
  it('finds deterministic findings from the stored graph: single points of failure, missing recovery, no DR, no observability', () => {
    const p = base(); const f = deterministicReview({ nodes: p.nodes.map((n) => ({ ...n })), edges: p.edges.map((e) => ({ edgeKey: e.id, sourceStableKey: e.sourceStableKey, targetStableKey: e.targetStableKey, communicationType: e.communicationType, synchronous: e.synchronous })), decisions: p.decisions });
    const by = (area: string) => f.filter((x) => x.area === area);
    expect(by('RELIABILITY').map((x) => x.title)).toContain('Event stream is a single point of failure'); expect(by('RELIABILITY').find((x) => x.nodeKeys[0] === 'event-stream')).toMatchObject({ severity: 'HIGH', requiresArchitectureChange: true, source: 'DETERMINISTIC' });
    expect(by('DISASTER_RECOVERY').map((x) => x.title)).toContain('No multi-region or disaster recovery strategy is recorded'); expect(by('OBSERVABILITY')).toHaveLength(1);
    expect(f.every((x) => x.requiresArchitectureChange === false || x.suggestedChange.length > 0)).toBe(true); // every finding that needs a change says what to propose
  });
  it('validates the model review: known references and a suggested change whenever one is required', () => {
    const o = (f: object) => reviewOutputSchema.parse({ assessment: 'A reasonable architecture with some gaps.', findings: [{ area: 'SECURITY', severity: 'HIGH', title: 'No secrets rotation', description: 'Credentials are never rotated.', recommendation: 'Rotate credentials regularly.', nodeKeys: [], decisionKeys: [], requiresArchitectureChange: false, ...f }] });
    expect(validateReviewOutput(o({}), ['event-stream'], ['adr-001'])).toEqual([]);
    expect(validateReviewOutput(o({ nodeKeys: ['ghost'], decisionKeys: ['adr-099'] }), ['event-stream'], ['adr-001'])).toHaveLength(2);
    expect(validateReviewOutput(o({ requiresArchitectureChange: true }), [], []).join()).toMatch(/no suggestedChange/);
  });
});

describe('progress migration: a MODIFIED component alone forces revalidation', () => {
  it('a completed task on a component whose configuration changed (no connection or decision changed) must be re-confirmed, never carried forward', () => {
    const mk = (threshold: string): ArchitecturePlan => { const p = base(); p.nodes.push(node('monitoring', 'Monitoring', 'Amazon CloudWatch', 'amazon-cloudwatch', 'OBSERVABILITY', { configuration: [{ key: 'alarm', value: threshold }] }) as never); return p; };
    const diff = diffArchitectures(toDiff(mk('threshold 80')), toDiff(mk('threshold 60')));
    expect(diff.nodes.find((n) => n.stableKey === 'monitoring')).toMatchObject({ kind: 'MODIFIED' });
    expect(diff.edges.every((e) => e.kind === 'UNCHANGED' && !e.touchesChangedComponent)).toBe(true); // isolates the rule: nothing else could flag the task
    expect(diff.decisions.every((d) => d.kind === 'UNCHANGED')).toBe(true);
    const t = (id: string, status: string): MigTask => ({ id, key: 'monitor-monitoring', title: 'Monitor the monitoring component', taskType: 'OBSERVABILITY', status, componentKeys: ['monitoring'], decisionKeys: [] }) as MigTask;
    const { items } = mapTasksAcrossPlans([t('v1', 'COMPLETED')], [t('v2', 'NOT_STARTED')], diff);
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ outcome: 'REQUIRES_REVALIDATION', v1TaskId: 'v1', v2TaskId: 'v2' }); expect(items[0]!.reason).toMatch(/component "monitoring" was modified/);
    const same = mapTasksAcrossPlans([t('v1', 'COMPLETED')], [t('v2', 'NOT_STARTED')], diffArchitectures(toDiff(mk('threshold 80')), toDiff(mk('threshold 80'))));
    expect(same.items[0]).toMatchObject({ outcome: 'CARRIED_FORWARD' }); // and with NO change, the same task does carry forward
  });
});

describe('migration invariants', () => {
  const t = (id: string, status: string): MigTask => ({ id, key: id, title: id, taskType: 'CONFIGURATION', status, componentKeys: ['x'], decisionKeys: [] }) as MigTask;
  it('refuse to carry forward or re-confirm work that was never completed', () => {
    const v1 = [t('a', 'IN_PROGRESS')], v2 = [t('b', 'NOT_STARTED')];
    expect(checkMigrationInvariants([{ v1TaskId: 'a', v2TaskId: 'b', outcome: 'CARRIED_FORWARD', reason: 'x', v1Status: 'IN_PROGRESS' }], v1, v2)).toContain('only completed work can be carried forward');
    expect(checkMigrationInvariants([{ v1TaskId: 'a', v2TaskId: 'b', outcome: 'REQUIRES_REVALIDATION', reason: 'x', v1Status: 'IN_PROGRESS' }], v1, v2)).toContain('only completed work can require revalidation');
    expect(checkMigrationInvariants([{ v1TaskId: 'a', v2TaskId: 'b', outcome: 'CARRIED_FORWARD', reason: 'x', v1Status: 'COMPLETED' }], [t('a', 'COMPLETED')], v2)).toEqual([]); // the valid case is accepted
  });
});
