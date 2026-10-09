import { describe, expect, it } from 'vitest';
import {
  applyRepairPatch, architecturePlanSchema, computeComplexity, criticOutputSchema, evaluateSemanticRules, repairPatchSchema, validateArchitectureStructure, validateCriticOutput,
  validatePlanReferences, validateRepairPatch, type ArchitecturePlan, type PlanContext,
} from '../src';

const ctx: PlanContext = { driverCodes: ['DRV-001', 'DRV-002'], requirementCodes: ['REQ-001', 'REQ-002', 'REQ-003'] };
const node = (key: string, over: object = {}) => ({
  stableKey: key, name: key.replace(/-/g, ' '), technology: `Tech ${key}`, technologySlug: `tech-${key}`, category: 'APPLICATION_SERVICE', purpose: 'Does a useful thing', description: 'A component that does a useful thing for the system.',
  criticality: 'MEDIUM', managedService: false, provider: null, deploymentModel: 'CONTAINER', ...over,
});
const edge = (id: string, s: string, t: string, over: object = {}) => ({ id, sourceStableKey: s, targetStableKey: t, label: `${s} to ${t}`, protocol: 'HTTPS', communicationType: 'REQUEST_RESPONSE', dataDescription: 'Requests', synchronous: true, encrypted: true, criticality: 'MEDIUM', ...over });
const decision = (key: string, over: object = {}) => ({
  key, title: `Decision ${key}`, problem: 'There is a problem to solve here.', decision: 'We decided to do the sensible thing.', rationale: 'Because the drivers require it and the alternatives are worse here.',
  status: 'ACCEPTED', confidence: 0.8, driverCodes: ['DRV-001'], requirementCodes: [], nodeStableKeys: ['web'], edgeIds: [], ...over,
});
const plan = (over: Partial<Record<keyof ArchitecturePlan, unknown>> = {}): ArchitecturePlan => architecturePlanSchema.parse({
  summary: 'A simple web application with an API and a database.',
  nodes: [node('web', { category: 'CLIENT' }), node('api', { category: 'API' }), node('db', { category: 'DATABASE', managedService: true, provider: 'AWS', technologySlug: 'aws-rds-postgresql', deploymentModel: 'MANAGED_SERVICE' })],
  edges: [edge('web-api', 'web', 'api'), edge('api-db', 'api', 'db', { communicationType: 'DATABASE', protocol: 'TLS' })],
  decisions: [decision('adr-001', { nodeStableKeys: ['web', 'api'] }), decision('adr-002', { nodeStableKeys: ['db'], driverCodes: ['DRV-002'] })], ...over,
});
const codes = (p: ArchitecturePlan) => validateArchitectureStructure(p, ctx).map((i) => i.code);

describe('architecturePlanSchema', () => {
  it('accepts a good plan and applies defaults', () => { const p = plan(); expect(p.nodes[0]!.configuration).toEqual([]); expect(p.edges[0]!.encrypted).toBe(true); });
  it('rejects bad keys, categories and ranges', () => {
    expect(architecturePlanSchema.safeParse({ ...plan(), nodes: [node('Bad Key')] }).success).toBe(false);
    expect(architecturePlanSchema.safeParse({ ...plan(), nodes: [node('web', { category: 'BLOCKCHAIN' })] }).success).toBe(false);
    expect(architecturePlanSchema.safeParse({ ...plan(), decisions: [decision('adr-001', { confidence: 1.4 })] }).success).toBe(false);
    expect(architecturePlanSchema.safeParse({ ...plan(), decisions: [decision('decision-1')] }).success).toBe(false);
    expect(architecturePlanSchema.safeParse({ ...plan(), decisions: [decision('adr-001', { driverCodes: ['driver-1'] })] }).success).toBe(false);
  });
});

describe('referential integrity and structural validation', () => {
  it('is clean for a coherent plan', () => { expect(validateArchitectureStructure(plan(), ctx)).toEqual([]); });
  it('rejects duplicate stableKeys', () => { expect(validatePlanReferences(plan({ nodes: [node('web'), node('web'), node('api'), node('db')] }), ctx).join()).toMatch(/Duplicate node stableKey "web"/); });
  it('rejects edges with unknown sources or targets (CRITICAL)', () => {
    const p = plan({ edges: [edge('edge-a', 'web', 'ghost'), edge('edge-b', 'phantom', 'api'), edge('web-api', 'web', 'api'), edge('api-db', 'api', 'db')] });
    const out = validateArchitectureStructure(p, ctx);
    expect(out.filter((i) => i.code === 'BROKEN_REFERENCE').map((i) => i.description).join()).toMatch(/unknown target node "ghost"[\s\S]*unknown source node "phantom"/);
    expect(out.every((i) => i.source === 'STRUCTURAL')).toBe(true);
    expect(out.find((i) => i.code === 'BROKEN_REFERENCE')!.severity).toBe('CRITICAL');
  });
  it('rejects duplicate edge ids and flags accidental duplicate edges', () => {
    expect(validatePlanReferences(plan({ edges: [edge('edge-x', 'web', 'api'), edge('edge-x', 'api', 'db')] }), ctx).join()).toMatch(/Duplicate edge id "edge-x"/);
    expect(codes(plan({ edges: [edge('e1', 'web', 'api'), edge('e2', 'web', 'api'), edge('e3', 'api', 'db')] }))).toContain('DUPLICATE_EDGE');
  });
  it('rejects self-edges', () => { expect(codes(plan({ edges: [edge('web-api', 'web', 'api'), edge('api-db', 'api', 'db'), edge('loop', 'api', 'api')] }))).toContain('SELF_EDGE'); });
  it('flags orphan components unless their category is cross-cutting', () => {
    expect(codes(plan({ nodes: [node('web', { category: 'CLIENT' }), node('api', { category: 'API' }), node('db', { category: 'DATABASE' }), node('lonely', { category: 'CACHE' })], edges: [edge('web-api', 'web', 'api'), edge('api-db', 'api', 'db')] }))).toContain('ORPHAN_NODE');
    const monitoring = plan({ nodes: [node('web', { category: 'CLIENT' }), node('api', { category: 'API' }), node('db', { category: 'DATABASE' }), node('monitoring', { category: 'OBSERVABILITY' })], edges: [edge('web-api', 'web', 'api'), edge('api-db', 'api', 'db')] });
    expect(codes(monitoring)).not.toContain('ORPHAN_NODE');
  });
  it('flags duplicate nodes (exact) and possible duplicates (same technology and category)', () => {
    expect(codes(plan({ nodes: [node('web', { category: 'CLIENT' }), node('api', { name: 'Api', category: 'API', technologySlug: 'x' }), node('api-2', { name: 'API', category: 'API', technologySlug: 'x' }), node('db', { category: 'DATABASE' })] }))).toContain('DUPLICATE_NODE');
    expect(codes(plan({ nodes: [node('web', { category: 'CLIENT' }), node('api', { name: 'Orders API', category: 'API', technologySlug: 'x' }), node('api-2', { name: 'Users API', category: 'API', technologySlug: 'x' }), node('db', { category: 'DATABASE' })] }))).toContain('POSSIBLE_DUPLICATE_NODE');
  });
  it('requires every ACCEPTED decision to link to a driver or requirement, but allows PROPOSED ones without', () => {
    expect(codes(plan({ decisions: [decision('adr-001', { driverCodes: [], requirementCodes: [] })] }))).toContain('DECISION_WITHOUT_DRIVER');
    expect(codes(plan({ decisions: [decision('adr-001', { driverCodes: [], requirementCodes: [], status: 'PROPOSED' }), decision('adr-002', { nodeStableKeys: ['db', 'api'] })] }))).not.toContain('DECISION_WITHOUT_DRIVER');
    expect(codes(plan({ decisions: [decision('adr-001', { driverCodes: [], requirementCodes: ['REQ-002'] })] }))).not.toContain('DECISION_WITHOUT_DRIVER');
  });
  it('rejects decisions that reference unknown drivers, requirements, nodes or edges', () => {
    const msg = validatePlanReferences(plan({ decisions: [decision('adr-001', { driverCodes: ['DRV-009'], requirementCodes: ['REQ-099'], nodeStableKeys: ['nope'], edgeIds: ['nada'] })] }), ctx).join();
    expect(msg).toMatch(/unknown driver "DRV-009"/); expect(msg).toMatch(/unknown requirement "REQ-099"/); expect(msg).toMatch(/unknown node "nope"/); expect(msg).toMatch(/unknown edge "nada"/);
  });
  it('checks provider/technology consistency and decision coverage of important nodes', () => {
    expect(codes(plan({ nodes: [node('web', { category: 'CLIENT' }), node('api', { category: 'API' }), node('db', { category: 'DATABASE', managedService: true, provider: null })] }))).toContain('PROVIDER_MISSING');
    expect(codes(plan({ nodes: [node('web', { category: 'CLIENT' }), node('api', { category: 'API' }), node('db', { category: 'DATABASE', technologySlug: 'aws-rds', provider: 'Google Cloud', managedService: true })] }))).toContain('PROVIDER_MISMATCH');
    expect(codes(plan({ nodes: [node('web', { category: 'CLIENT' }), node('api', { category: 'API' }), node('db', { category: 'DATABASE', criticality: 'CRITICAL' })], decisions: [decision('adr-001', { nodeStableKeys: ['web'] })] }))).toContain('NODE_WITHOUT_DECISION');
  });
  it('allows a single-component architecture', () => { expect(codes(plan({ nodes: [node('app', { category: 'APPLICATION_SERVICE' })], edges: [], decisions: [decision('adr-001', { nodeStableKeys: ['app'] })] }))).toEqual([]); });
});

describe('semantic rules (rule-based, deliberately incomplete)', () => {
  const rq = (code: string, statement: string) => ({ code, category: 'OTHER', statement });
  it('flags a self-run critical service when availability matters, but not managed or redundant ones', () => {
    const p = plan({ nodes: [node('web', { category: 'CLIENT' }), node('api', { category: 'API', criticality: 'CRITICAL' }), node('db', { category: 'DATABASE', criticality: 'CRITICAL', configuration: [{ key: 'replicas', value: '3' }] })] });
    const out = evaluateSemanticRules(p, [rq('REQ-001', 'It must almost never be down')]);
    expect(out.map((i) => i.affectedNodeStableKeys[0])).toEqual(['api']);
    expect(out[0]).toMatchObject({ source: 'SEMANTIC', category: 'SINGLE_POINT_OF_FAILURE', severity: 'HIGH', relatedRequirementCodes: ['REQ-001'] });
    expect(evaluateSemanticRules(p, [rq('REQ-001', 'Occasional downtime is fine')])).toEqual([]);
  });
  it('flags unencrypted transport only when sensitive data is involved', () => {
    const p = plan({ edges: [edge('web-api', 'web', 'api', { encrypted: false }), edge('api-db', 'api', 'db')] });
    expect(evaluateSemanticRules(p, [rq('REQ-002', 'Handles highly sensitive financial data')]).map((i) => i.code)).toEqual(['UNENCRYPTED_SENSITIVE']);
    expect(evaluateSemanticRules(p, [rq('REQ-002', 'Public content only')])).toEqual([]);
  });
  it('warns, rather than rejects, about provider lock-in when portability is required', () => {
    const out = evaluateSemanticRules(plan(), [rq('REQ-003', 'Must stay cloud-agnostic')]);
    expect(out[0]).toMatchObject({ code: 'LOCK_IN_VS_AGNOSTIC', severity: 'MEDIUM' });
  });
  it('flags heavyweight technology under a tight budget', () => {
    const p = plan({ nodes: [node('web', { category: 'CLIENT' }), node('bus', { category: 'EVENT_STREAM', technologySlug: 'apache-kafka' }), node('db', { category: 'DATABASE' })], edges: [edge('edge-a', 'web', 'bus'), edge('edge-b', 'bus', 'db')], decisions: [decision('adr-001', { nodeStableKeys: ['bus'] })] });
    expect(evaluateSemanticRules(p, [rq('REQ-001', 'Keep it as cheap as possible')])[0]).toMatchObject({ code: 'COMPLEX_FOR_BUDGET', category: 'COST' });
  });
  it('computes a rough complexity heuristic', () => {
    expect(computeComplexity(plan()).label).toBe('LOW');
    const big = plan({ nodes: Array.from({ length: 16 }, (_, i) => node(`n${i}`, { category: i < 4 ? 'EVENT_STREAM' : 'APPLICATION_SERVICE' })), edges: [] });
    expect(computeComplexity(big)).toMatchObject({ label: 'HIGH', heavyweight: 4 });
  });
});

describe('critic output validation', () => {
  const crit = (over: object = {}) => ({ severity: 'HIGH', category: 'RELIABILITY', description: 'The database is a single point of failure.', affectedNodeStableKeys: ['db'], affectedDecisionIds: ['adr-002'], relatedRequirementIds: ['REQ-001'], recommendation: 'Add a replica and automatic failover.', ...over });
  it('accepts a grounded critique and rejects references to things that do not exist', () => {
    expect(validateCriticOutput(criticOutputSchema.parse({ assessment: 'Mostly fine, with one reliability gap.', issues: [crit()] }), plan(), ctx)).toEqual([]);
    const bad = criticOutputSchema.parse({ assessment: 'Mostly fine, with one reliability gap.', issues: [crit({ affectedNodeStableKeys: ['ghost'], affectedDecisionIds: ['adr-099'], relatedRequirementIds: ['REQ-099'] })] });
    expect(validateCriticOutput(bad, plan(), ctx).join()).toMatch(/ghost[\s\S]*adr-099[\s\S]*REQ-099/);
  });
  it('rejects unknown severities and categories', () => {
    expect(criticOutputSchema.safeParse({ assessment: 'Fine overall, nothing found.', issues: [crit({ severity: 'SEVERE' })] }).success).toBe(false);
    expect(criticOutputSchema.safeParse({ assessment: 'Fine overall, nothing found.', issues: [crit({ category: 'VIBES' })] }).success).toBe(false);
  });
});

describe('repair patches', () => {
  const patch = (over: object = {}) => repairPatchSchema.parse({ changes: [{ issueIndex: 0, description: 'Fix the problem' }], ...over });
  it('changes only what the patch names and leaves the rest untouched', () => {
    const before = plan();
    const after = applyRepairPatch(before, patch({ nodes: { update: [{ stableKey: 'db', set: { configuration: [{ key: 'replicas', value: '2' }] } }] } }));
    expect(after.nodes.find((n) => n.stableKey === 'db')!.configuration).toEqual([{ key: 'replicas', value: '2' }]);
    expect(after.nodes.filter((n) => n.stableKey !== 'db')).toEqual(before.nodes.filter((n) => n.stableKey !== 'db'));
    expect(after.edges).toEqual(before.edges); expect(after.decisions).toEqual(before.decisions);
    expect(before.nodes.find((n) => n.stableKey === 'db')!.configuration).toEqual([]); // the original is not mutated
  });
  it('REGRESSION: a patch that sets one field leaves every other field of that node, edge and decision exactly as it was', () => {
    const rich = plan({
      nodes: [node('web', { category: 'CLIENT' }), node('api', { category: 'API' }),
        node('db', { category: 'DATABASE', managedService: true, provider: 'AWS', risks: ['Could fill up'], alternatives: [{ technology: 'MongoDB', reasoning: 'Data is relational, so not needed.' }], configuration: [{ key: 'size', value: 'small' }], replacesStableKey: 'old-db' })],
      edges: [edge('web-api', 'web', 'api'), edge('api-db', 'api', 'db', { encrypted: false, communicationType: 'DATABASE' })],
      decisions: [decision('adr-001', { nodeStableKeys: ['web', 'api'], tradeoffs: ['More to run'], consequences: ['Learn it'], requirementCodes: ['REQ-002'], edgeIds: ['web-api'] }), decision('adr-002', { nodeStableKeys: ['db'], driverCodes: ['DRV-002'] })],
    });
    // Parse from RAW json, as a model response would arrive, naming exactly one field per target.
    const raw = { changes: [{ issueIndex: 0, description: 'Tune a single field' }], nodes: { update: [{ stableKey: 'db', set: { configuration: [{ key: 'replicas', value: '2' }] } }] },
      edges: { update: [{ id: 'api-db', set: { encrypted: true } }] }, decisions: { update: [{ key: 'adr-001', set: { confidence: 0.5 } }] } };
    const after = applyRepairPatch(rich, repairPatchSchema.parse(JSON.parse(JSON.stringify(raw))));
    const was = rich.nodes.find((n) => n.stableKey === 'db')!, now = after.nodes.find((n) => n.stableKey === 'db')!;
    expect(now).toEqual({ ...was, configuration: [{ key: 'replicas', value: '2' }] });
    expect(now.provider).toBe('AWS'); expect(now.risks).toEqual(['Could fill up']); expect(now.alternatives).toHaveLength(1); expect(now.replacesStableKey).toBe('old-db');
    expect(after.edges.find((e) => e.id === 'api-db')).toEqual({ ...rich.edges[1]!, encrypted: true });
    expect(after.decisions.find((d) => d.key === 'adr-001')).toEqual({ ...rich.decisions[0]!, confidence: 0.5 });
    expect(validateArchitectureStructure(after, ctx)).toEqual([]);
  });
  it('rejects unknown fields inside "set" (for example trying to change a stableKey)', () => {
    expect(repairPatchSchema.safeParse({ changes: [{ issueIndex: 0, description: 'Sneaky rename' }], nodes: { update: [{ stableKey: 'db', set: { stableKey: 'other' } }] } }).success).toBe(false);
    expect(repairPatchSchema.safeParse({ changes: [{ issueIndex: 0, description: 'Typo field' }], nodes: { update: [{ stableKey: 'db', set: { provder: 'AWS' } }] } }).success).toBe(false);
  });
  it('cascades node removal to edges, decision references and risks', () => {
    const before = plan({ risks: [{ text: 'The database could fill up.', severity: 'LOW', nodeStableKeys: ['db'] }] });
    const after = applyRepairPatch(before, patch({ nodes: { remove: ['db'] } }));
    expect(after.nodes.map((n) => n.stableKey)).toEqual(['web', 'api']);
    expect(after.edges.map((e) => e.id)).toEqual(['web-api']);
    expect(after.decisions.find((d) => d.key === 'adr-002')!.nodeStableKeys).toEqual([]);
    expect(after.risks[0]!.nodeStableKeys).toEqual([]);
  });
  it('adds components, edges, decisions, risks and assumptions', () => {
    const after = applyRepairPatch(plan(), patch({
      nodes: { add: [node('cache', { category: 'CACHE' })] }, edges: { add: [edge('api-cache', 'api', 'cache', { communicationType: 'CACHE' })] },
      decisions: { add: [decision('adr-003', { nodeStableKeys: ['cache'] })] }, addRisks: [{ text: 'Cache invalidation is hard.', severity: 'LOW' }], addAssumptions: ['Traffic is read-heavy'],
    }));
    expect(after.nodes).toHaveLength(4); expect(after.edges).toHaveLength(3); expect(after.decisions).toHaveLength(3); expect(after.risks).toHaveLength(1); expect(after.assumptions).toEqual(['Traffic is read-heavy']);
    expect(validateArchitectureStructure(after, ctx)).toEqual([]);
  });
  it('validates patches against the plan and the issues they must address', () => {
    const p = plan();
    const bad = patch({ nodes: { add: [node('db')], update: [{ stableKey: 'ghost', set: { name: 'x y' } }], remove: ['nope'] }, edges: { remove: ['zzz'] }, decisions: { remove: ['adr-099'] } });
    const msg = validateRepairPatch(bad, p, 1, []).join('\n');
    expect(msg).toMatch(/already exists/); expect(msg).toMatch(/unknown node "ghost"/); expect(msg).toMatch(/unknown node "nope"/); expect(msg).toMatch(/unknown edge "zzz"/); expect(msg).toMatch(/unknown decision "adr-099"/);
    expect(validateRepairPatch(patch({ changes: [{ issueIndex: 5, description: 'Imaginary' }] }), p, 2, []).join()).toMatch(/only 2 issues/);
    expect(validateRepairPatch(patch(), p, 3, [0, 2]).join()).toMatch(/Issue 2 must be addressed/);
    expect(validateRepairPatch(patch(), p, 1, [0])).toEqual([]);
  });
});
