import { describe, expect, it } from 'vitest';
import { PipelineError, runArchitecturePipeline, DEFAULT_PIPELINE_CONFIG, type PipelineConfig } from '@pitch2plan/domain';
import { critIssue, critic, CODES, decision, edge, fakeAi, goodPlan, input, node, noopPatch } from '../fixtures/architecture';

const reqTexts = [{ code: 'REQ-001', category: 'OTHER', statement: 'Do the thing' }];
const run = (ai: ReturnType<typeof fakeAi>, cfg: Partial<PipelineConfig> = {}, stages: string[] = [], texts = reqTexts) =>
  runArchitecturePipeline(ai, { input: input(), ...CODES, requirementTexts: texts }, { ...DEFAULT_PIPELINE_CONFIG, ...cfg }, { onStage: (s, r) => void stages.push(`${s}:${r}`) });
const orphanPlan = () => goodPlan({ nodes: [node('web', { category: 'CLIENT' }), node('api', { category: 'API' }), node('db', { category: 'DATABASE' }), node('lonely', { category: 'CACHE' })] });

describe('architecture pipeline', () => {
  it('runs planner -> validate -> critic once when the design is clean, with no repair', async () => {
    const stages: string[] = [];
    const ai = fakeAi({});
    const r = await run(ai, {}, stages);
    expect(ai.calls).toEqual(['plan', 'critic']);
    expect(stages).toEqual(['PLANNING:0', 'VALIDATING:0', 'CRITIQUING:0']);
    expect(r.repairs).toBe(0);
    expect(r.issues).toEqual([]);
    expect(r.plan).toEqual(goodPlan());
  });

  it('repairs a structurally broken graph BEFORE asking the critic to review it', async () => {
    const ai = fakeAi({ plans: [orphanPlan()], patches: [() => ({ ...noopPatch([0]), nodes: { add: [], update: [], remove: ['lonely'] } })] });
    const r = await run(ai);
    expect(ai.calls).toEqual(['plan', 'repair', 'critic']);
    expect(r.plan.nodes.map((n) => n.stableKey)).toEqual(['web', 'api', 'db']);
    expect(r.repairs).toBe(1);
    expect(ai.repairInputs[0]!.issues[0]).toMatchObject({ source: 'STRUCTURAL', code: 'ORPHAN_NODE', severity: 'CRITICAL' });
    expect(ai.repairInputs[0]!.mustAddress).toEqual([0]);
    expect(r.issues.filter((i) => i.stage === 'PLAN').map((i) => i.code)).toEqual(['ORPHAN_NODE']); // history is kept
    expect(r.issues.filter((i) => i.stage === 'FINAL')).toEqual([]);
  });

  it('sends a CRITICAL critic finding through the repairer, then runs a FINAL critic on the repaired design', async () => {
    const ai = fakeAi({
      critics: [critic([critIssue({ severity: 'CRITICAL', category: 'MISSING_REQUIREMENT' })]), critic([critIssue({ severity: 'LOW', category: 'OBSERVABILITY', description: 'Consider adding dashboards for operators.' })])],
      patches: [() => ({ ...noopPatch([0]), nodes: { add: [], update: [{ stableKey: 'db', set: { configuration: [{ key: 'replicas', value: '2' }] } }], remove: [] } })],
    });
    const stages: string[] = [];
    const r = await run(ai, {}, stages);
    expect(ai.calls).toEqual(['plan', 'critic', 'repair', 'critic']);
    expect(stages).toEqual(['PLANNING:0', 'VALIDATING:0', 'CRITIQUING:0', 'REPAIRING:1', 'VALIDATING:1', 'CRITIQUING:1']);
    expect(r.plan.nodes.find((n) => n.stableKey === 'db')!.configuration).toEqual([{ key: 'replicas', value: '2' }]);
    expect(r.plan.nodes.find((n) => n.stableKey === 'web')).toEqual(goodPlan().nodes.find((n) => n.stableKey === 'web')); // untouched parts untouched
    expect(r.ai.critics).toHaveLength(2); expect(r.ai.repairers).toHaveLength(1);
    expect(r.issues.map((i) => `${i.stage}:${i.severity}`)).toEqual(['PLAN:CRITICAL', 'FINAL:LOW']);
  });

  it('repairs HIGH issues only in the configured categories', async () => {
    const security = fakeAi({ critics: [critic([critIssue({ severity: 'HIGH', category: 'SECURITY' })]), critic()] });
    await run(security);
    expect(security.calls).toEqual(['plan', 'critic', 'repair', 'critic']);
    const cost = fakeAi({ critics: [critic([critIssue({ severity: 'HIGH', category: 'COST' })])] });
    const r = await run(cost);
    expect(cost.calls).toEqual(['plan', 'critic']); // a HIGH cost concern is reported, not auto-repaired
    expect(r.issues.map((i) => i.category)).toEqual(['COST']);
    const custom = fakeAi({ critics: [critic([critIssue({ severity: 'HIGH', category: 'COST' })]), critic()] });
    await run(custom, { repairHighCategories: ['COST'] });
    expect(custom.calls).toContain('repair');
  });

  it('never loops forever: it stops at the repair cap and FAILS if a CRITICAL issue remains', async () => {
    const ai = fakeAi({ critics: [critic([critIssue({ severity: 'CRITICAL', category: 'SECURITY' })])] }); // the critic never relents
    const err = await run(ai, { maxRepairs: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err.code).toBe('ARCHITECTURE_VALIDATION_FAILED');
    expect(ai.calls).toEqual(['plan', 'critic', 'repair', 'critic', 'repair', 'critic']); // exactly 2 repairs
    expect(err.issues.some((i: { stage: string }) => i.stage === 'FINAL')).toBe(true);
  });

  it('accepts remaining HIGH issues after the cap but records them, rather than hiding them', async () => {
    const ai = fakeAi({ critics: [critic([critIssue({ severity: 'HIGH', category: 'SECURITY' })])] });
    const r = await run(ai, { maxRepairs: 1 });
    expect(r.repairs).toBe(1);
    expect(r.issues.filter((i) => i.stage === 'FINAL').map((i) => i.severity)).toEqual(['HIGH']);
  });

  it('with maxRepairs = 0 a CRITICAL problem fails immediately without calling the repairer', async () => {
    const ai = fakeAi({ plans: [orphanPlan()] });
    await expect(run(ai, { maxRepairs: 0 })).rejects.toBeInstanceOf(PipelineError);
    expect(ai.calls).toEqual(['plan']);
  });

  it('fails when a repair does not actually fix the structure', async () => {
    const ai = fakeAi({ plans: [orphanPlan()], patches: [() => noopPatch([0])] }); // claims to fix it, changes nothing
    await expect(run(ai, { maxRepairs: 2 })).rejects.toMatchObject({ code: 'ARCHITECTURE_VALIDATION_FAILED' });
    expect(ai.calls.filter((c) => c === 'repair')).toHaveLength(2);
    expect(ai.calls).not.toContain('critic'); // a broken graph is never presented for review
  });

  it('includes deterministic semantic findings (no model involved) in the repair input', async () => {
    const plan = goodPlan({ edges: [edge('web-api', 'web', 'api', { encrypted: false }), edge('api-db', 'api', 'db')] });
    const ai = fakeAi({ plans: [plan], patches: [(is) => ({ ...noopPatch(is.map((_, n) => n)), edges: { add: [], update: [{ id: 'web-api', set: { encrypted: true } }], remove: [] } })] });
    const r = await run(ai, {}, [], [{ code: 'REQ-001', category: 'SECURITY', statement: 'Handles sensitive financial data' }]);
    expect(ai.repairInputs[0]!.issues[0]).toMatchObject({ source: 'SEMANTIC', code: 'UNENCRYPTED_SENSITIVE', severity: 'HIGH' });
    expect(r.plan.edges.find((e) => e.id === 'web-api')!.encrypted).toBe(true);
  });

  it('keeps decision links consistent through repairs', async () => {
    const plan = goodPlan({ decisions: [decision('adr-001', { driverCodes: [], requirementCodes: [], nodeStableKeys: ['web', 'api', 'db'] })] });
    const ai = fakeAi({ plans: [plan], patches: [() => ({ ...noopPatch([0]), decisions: { add: [], update: [{ key: 'adr-001', set: { status: 'PROPOSED' as const } }], remove: [] } })] });
    const r = await run(ai);
    expect(r.plan.decisions[0]!.status).toBe('PROPOSED');
  });
});
