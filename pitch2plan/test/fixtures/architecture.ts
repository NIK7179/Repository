import { architecturePlanSchema, type ArchitecturePlan, type ArchitectureIssue, type PlanInput, type RepairPatch, type CriticOutput } from '@pitch2plan/schemas';
import type { ArchitectureAiPort } from '@pitch2plan/domain';

export const CODES = { driverCodes: ['DRV-001', 'DRV-002'], requirementCodes: ['REQ-001', 'REQ-002', 'REQ-003'] };
export const node = (key: string, over: object = {}) => ({
  stableKey: key, name: key.replace(/-/g, ' '), technology: `Tech ${key}`, technologySlug: `tech-${key}`, category: 'APPLICATION_SERVICE', purpose: 'Does a useful thing', description: 'A component that does a useful thing for the system.',
  criticality: 'MEDIUM', managedService: false, provider: null, deploymentModel: 'CONTAINER', ...over,
});
export const edge = (id: string, s: string, t: string, over: object = {}) => ({ id, sourceStableKey: s, targetStableKey: t, label: `${s} to ${t}`, protocol: 'HTTPS', communicationType: 'REQUEST_RESPONSE', dataDescription: 'Requests', synchronous: true, encrypted: true, criticality: 'MEDIUM', ...over });
export const decision = (key: string, over: object = {}) => ({
  key, title: `Decision ${key}`, problem: 'There is a problem to solve here.', decision: 'We decided to do the sensible thing.', rationale: 'Because the drivers require it and the alternatives are worse here.',
  status: 'ACCEPTED', confidence: 0.8, driverCodes: ['DRV-001'], requirementCodes: [], nodeStableKeys: ['web'], edgeIds: [], ...over,
});
export const goodPlan = (over: Partial<Record<keyof ArchitecturePlan, unknown>> = {}): ArchitecturePlan => architecturePlanSchema.parse({
  summary: 'A simple web application with an API and a database.',
  nodes: [node('web', { category: 'CLIENT' }), node('api', { category: 'API' }), node('db', { category: 'DATABASE', managedService: true, provider: 'AWS', technologySlug: 'aws-rds-postgresql', deploymentModel: 'MANAGED_SERVICE' })],
  edges: [edge('web-api', 'web', 'api'), edge('api-db', 'api', 'db', { communicationType: 'DATABASE', protocol: 'TLS' })],
  decisions: [decision('adr-001', { nodeStableKeys: ['web', 'api'] }), decision('adr-002', { nodeStableKeys: ['db'], driverCodes: ['DRV-002'] })], ...over,
});
const meta = (id: string) => ({ promptId: id, promptVersion: 1, provider: 'fake', model: 'fake', repaired: false });
export const input = (): PlanInput => ({
  context: { workspaceId: 'w', projectId: 'p', userId: 'u' }, project: { name: 'Fixture' }, brief: {},
  requirements: [
    { code: 'REQ-001', category: 'FUNCTIONAL', statement: 'Do the thing', value: null, origin: 'USER_STATED', confidence: null },
    { code: 'REQ-002', category: 'DATA', statement: 'Keep the data', value: null, origin: 'USER_ANSWERED', confidence: null },
    { code: 'REQ-003', category: 'PERFORMANCE', statement: 'Be quick', value: null, origin: 'AI_INFERRED', confidence: 0.6 },
  ],
  drivers: [
    { code: 'DRV-001', name: 'Driver one', description: 'Drives the design', priority: 'HIGH', requirementCodes: ['REQ-001'] },
    { code: 'DRV-002', name: 'Driver two', description: 'Also drives the design', priority: 'MEDIUM', requirementCodes: ['REQ-002', 'REQ-003'] },
  ],
});
export const critic = (issues: CriticOutput['issues'] = []): CriticOutput => ({ assessment: 'A fixture assessment of the design.', issues });
export const critIssue = (over: Partial<CriticOutput['issues'][number]> = {}): CriticOutput['issues'][number] => ({
  severity: 'HIGH', category: 'RELIABILITY', description: 'The database is a single point of failure.', affectedNodeStableKeys: ['db'], affectedDecisionIds: [], relatedRequirementIds: [], recommendation: 'Add a replica with failover.', ...over,
});
export const noopPatch = (indexes: number[]): RepairPatch => ({
  changes: indexes.map((issueIndex) => ({ issueIndex, description: 'Fixed it' })), nodes: { add: [], update: [], remove: [] }, edges: { add: [], update: [], remove: [] }, decisions: { add: [], update: [], remove: [] }, addRisks: [], addAssumptions: [],
});

/** A scripted fake of the AI port. Each queue is consumed in order; the last entry repeats. Records the order of calls. */
export function fakeAi(s: { plans?: ArchitecturePlan[]; critics?: CriticOutput[]; patches?: Array<(issues: ArchitectureIssue[], plan: ArchitecturePlan) => RepairPatch> }) {
  const calls: string[] = [];
  const idx = { plan: 0, critic: 0, patch: 0 };
  const pick = <T>(list: T[], key: keyof typeof idx) => list[Math.min(idx[key]++, list.length - 1)]!;
  const ai: ArchitectureAiPort & { calls: string[]; repairInputs: Array<{ issues: ArchitectureIssue[]; mustAddress: number[] }> } = {
    calls, repairInputs: [],
    async plan() { calls.push('plan'); return { output: pick(s.plans ?? [goodPlan()], 'plan'), ai: meta('P') }; },
    async critique() { calls.push('critic'); return { output: pick(s.critics ?? [critic()], 'critic'), ai: meta('C') }; },
    async repair(i) { calls.push('repair'); ai.repairInputs.push({ issues: i.issues, mustAddress: i.mustAddress }); return { output: pick(s.patches ?? [(is) => noopPatch(is.map((_, n) => n))], 'patch')(i.issues, i.plan), ai: meta('R') }; },
  };
  return ai;
}
