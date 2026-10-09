import { z } from 'zod';
import { prioritySchema, requirementCategorySchema } from './discovery';
import {
  architectureDecisionSchema, architectureEdgeSchema, architectureNodeSchema, architecturePlanSchema, configItemSchema, deploymentModelSchema, communicationTypeSchema,
  nodeAlternativeSchema, nodeCategorySchema, REQUIREMENT_CODE, DRIVER_CODE, type ArchitecturePlan,
} from './architecture';

const keySlug = z.string().regex(/^[a-z][a-z0-9-]{1,60}$/, 'use a lowercase kebab-case key');
const techSlug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,60}$/);
const adrKey = z.string().regex(/^adr-\d{3}$/);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

// ====================================================================== proposal lifecycle
export const PROPOSAL_STATES = ['DRAFT', 'ANALYZING', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED', 'APPLYING', 'APPLIED', 'FAILED', 'STALE'] as const;
export const proposalStateSchema = z.enum(PROPOSAL_STATES);
export type ProposalState = z.infer<typeof proposalStateSchema>;
export const PROPOSAL_SOURCES = ['USER_REQUEST', 'ASSISTANT_RECOMMENDATION', 'ARCHITECTURE_REVIEW', 'IMPLEMENTATION_DISCOVERY', 'FUTURE_COST_OPTIMIZATION', 'FUTURE_SECURITY_REVIEW'] as const;
export const proposalSourceSchema = z.enum(PROPOSAL_SOURCES);
/** Sources Phase 5 can create today. The rest are reserved so the model does not change later. */
export const ACTIVE_PROPOSAL_SOURCES = ['USER_REQUEST', 'ASSISTANT_RECOMMENDATION', 'ARCHITECTURE_REVIEW'] as const;
export const CHANGE_TYPES = ['TECHNOLOGY_REPLACEMENT', 'COMPONENT_ADD', 'COMPONENT_REMOVE', 'TOPOLOGY_CHANGE', 'DEPLOYMENT_CHANGE', 'SCALING_CHANGE', 'SECURITY_CHANGE', 'DATA_FLOW_CHANGE', 'REQUIREMENT_CHANGE', 'CONFIGURATION_CHANGE', 'OTHER'] as const;
export const changeTypeSchema = z.enum(CHANGE_TYPES);

/**
 * Enforced in the domain. STALE is terminal except for rejection: a stale proposal is never applied; "rebase" creates a successor proposal against the
 * current version (a proposal's bound architecture version never changes). FAILED may be re-analysed (analysis failed), retried (application failed,
 * approval exists) or edited.
 */
export const PROPOSAL_TRANSITIONS: Record<ProposalState, readonly ProposalState[]> = {
  DRAFT: ['ANALYZING', 'REJECTED', 'STALE'],
  ANALYZING: ['READY_FOR_REVIEW', 'FAILED', 'STALE'],
  READY_FOR_REVIEW: ['APPROVED', 'REJECTED', 'DRAFT', 'STALE'],
  APPROVED: ['APPLYING'],
  APPLYING: ['APPLIED', 'FAILED'],
  FAILED: ['ANALYZING', 'APPLYING', 'DRAFT', 'REJECTED', 'STALE'],
  STALE: ['REJECTED'],
  REJECTED: [],
  APPLIED: [],
};
export const canTransitionProposal = (from: ProposalState, to: ProposalState) => PROPOSAL_TRANSITIONS[from].includes(to);
/** States in which a proposal is still open, so another proposal's success makes it stale. */
export const OPEN_PROPOSAL_STATES: readonly ProposalState[] = ['DRAFT', 'ANALYZING', 'READY_FOR_REVIEW', 'FAILED'];

export const createChangeProposalRequestSchema = z.object({
  requestedChange: text(5, 1500), reason: z.string().trim().max(1000).optional(),
  source: z.enum(ACTIVE_PROPOSAL_SOURCES).default('USER_REQUEST'),
  assistantConversationId: z.uuid().optional(), assistantMessageId: z.uuid().optional(), reviewFindingId: z.uuid().optional(),
});
export const editChangeProposalRequestSchema = z.object({ requestedChange: text(5, 1500), reason: z.string().trim().max(1000).optional() });
export const approveChangeProposalRequestSchema = z.object({ confirmRequirementChanges: z.boolean().default(false), note: z.string().trim().max(500).optional() });
export const rejectChangeProposalRequestSchema = z.object({ note: z.string().trim().max(500).optional() });

// ====================================================================== impact analysis (structured; never prose-only)
const affected = z.object({ key: z.string().trim().min(1).max(80), relation: z.enum(['DIRECT', 'POTENTIAL']), reason: text(5, 300) });
const impact = z.object({ direction: z.enum(['IMPROVES', 'WORSENS', 'NEUTRAL', 'MIXED', 'UNKNOWN']), notes: text(5, 500) });
const riskItem = z.object({ text: text(5, 300), severity: prioritySchema });
export const requirementChangeSchema = z.object({
  kind: z.enum(['ADD', 'MODIFY', 'REMOVE']), requirementCode: z.string().regex(REQUIREMENT_CODE).nullable().default(null),
  category: requirementCategorySchema, statement: text(5, 500), value: z.string().trim().max(200).nullable().default(null), reason: text(5, 300),
});
export type RequirementChange = z.infer<typeof requirementChangeSchema>;

export const changeAnalysisSchema = z.object({
  summary: text(20, 1200), changeType: changeTypeSchema,
  whatChanges: z.array(text(3, 300)).min(1).max(10), whatStaysTheSame: z.array(text(3, 300)).max(10).default([]),
  affectedNodes: z.array(affected).max(20).default([]), affectedEdges: z.array(affected).max(30).default([]), affectedDecisions: z.array(affected).max(15).default([]),
  affectedDrivers: z.array(affected).max(10).default([]), affectedRequirements: z.array(affected).max(15).default([]), affectedTasks: z.array(affected).max(40).default([]),
  requirementChanges: z.array(requirementChangeSchema).max(8).default([]),
  newRisks: z.array(riskItem).max(8).default([]), resolvedRisks: z.array(riskItem).max(8).default([]),
  performanceImpact: impact, securityImpact: impact, reliabilityImpact: impact, costImpact: impact, complexityImpact: impact, operationalImpact: impact, migrationImpact: impact, implementationImpact: impact,
  newWork: z.array(text(3, 300)).max(15).default([]), reusableWork: z.array(text(3, 300)).max(15).default([]),
  recommendation: z.object({ verdict: z.enum(['PROCEED', 'PROCEED_WITH_CAUTION', 'RECONSIDER', 'NOT_RECOMMENDED']), rationale: text(10, 800) }),
  confidence: z.number().min(0).max(1),
});
export type ChangeAnalysis = z.infer<typeof changeAnalysisSchema>;

export interface AnalysisContext {
  nodeKeys: string[]; edgeIds: string[]; decisionKeys: string[]; driverCodes: string[]; requirementCodes: string[]; taskKeys: string[];
}
/** Every reference the model makes must exist. (It is not allowed to invent components, decisions, requirements or tasks.) */
export function validateChangeAnalysis(a: ChangeAnalysis, c: AnalysisContext): string[] {
  const out: string[] = []; const chk = (label: string, list: Array<{ key: string }>, known: string[]) => { const s = new Set(known); for (const it of list) if (!s.has(it.key)) out.push(`${label} references unknown "${it.key}".`); };
  chk('affectedNodes', a.affectedNodes, c.nodeKeys); chk('affectedEdges', a.affectedEdges, c.edgeIds); chk('affectedDecisions', a.affectedDecisions, c.decisionKeys);
  chk('affectedDrivers', a.affectedDrivers, c.driverCodes); chk('affectedRequirements', a.affectedRequirements, c.requirementCodes); chk('affectedTasks', a.affectedTasks, c.taskKeys);
  const reqs = new Set(c.requirementCodes);
  a.requirementChanges.forEach((r, i) => {
    if (r.kind === 'ADD' && r.requirementCode) out.push(`requirementChanges[${i}]: an ADD must not name an existing requirement.`);
    if (r.kind !== 'ADD' && (!r.requirementCode || !reqs.has(r.requirementCode))) out.push(`requirementChanges[${i}]: ${r.kind} must name an existing requirement code.`);
  });
  void DRIVER_CODE; return out;
}
/**
 * Deterministic rule: a change needs the user to RECONFIRM requirements when the analysis proposes any requirement change, or classifies itself
 * as a REQUIREMENT_CHANGE. A pure technology substitution (no requirement change) never forces reconfirmation.
 */
export const requiresReconfirmation = (a: Pick<ChangeAnalysis, 'changeType' | 'requirementChanges'>) => a.changeType === 'REQUIREMENT_CHANGE' || a.requirementChanges.length > 0;

/** Qualitative severity from facts, not from the model's mood. */
export function impactSeverity(a: ChangeAnalysis, facts: { completedTasksAtRisk: number; directNodes: number }): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  let score = 0;
  if (a.changeType === 'REQUIREMENT_CHANGE' || a.changeType === 'TOPOLOGY_CHANGE' || a.changeType === 'DEPLOYMENT_CHANGE') score += 2;
  else if (a.changeType === 'TECHNOLOGY_REPLACEMENT' || a.changeType === 'COMPONENT_REMOVE' || a.changeType === 'DATA_FLOW_CHANGE' || a.changeType === 'SCALING_CHANGE') score += 1;
  score += facts.directNodes >= 3 ? 2 : facts.directNodes >= 1 ? 1 : 0;
  score += facts.completedTasksAtRisk >= 5 ? 2 : facts.completedTasksAtRisk >= 1 ? 1 : 0;
  score += a.requirementChanges.length > 0 ? 1 : 0;
  score += [a.securityImpact, a.reliabilityImpact].some((i) => i.direction === 'WORSENS') ? 1 : 0;
  return score >= 6 ? 'CRITICAL' : score >= 4 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
}

/** What the analysis can say about work already done, computed from the plan and graph (not guessed by the model). */
export interface TaskFact { id: string; key: string; title: string; status: string; taskType: string; componentKeys: string[]; decisionKeys: string[] }
export function classifyTaskImpact(tasks: TaskFact[], edges: Array<{ source: string; target: string }>, directNodes: string[], directDecisions: string[]) {
  const direct = new Set(directNodes); const neighbours = new Set<string>();
  for (const e of edges) { if (direct.has(e.source) && !direct.has(e.target)) neighbours.add(e.target); if (direct.has(e.target) && !direct.has(e.source)) neighbours.add(e.source); }
  const dec = new Set(directDecisions);
  type Rel = 'DIRECT' | 'POTENTIAL';
  const items = tasks.flatMap((t): Array<{ task: TaskFact; relation: Rel }> => {
    const hitsDirect = t.componentKeys.some((k) => direct.has(k)) || t.decisionKeys.some((d) => dec.has(d));
    const hitsNeighbour = !hitsDirect && t.componentKeys.some((k) => neighbours.has(k));
    return hitsDirect ? [{ task: t, relation: 'DIRECT' }] : hitsNeighbour ? [{ task: t, relation: 'POTENTIAL' }] : [];
  });
  const done = (s: string) => s === 'COMPLETED';
  return {
    items,
    completedAtRisk: items.filter((i) => done(i.task.status)), inProgressAtRisk: items.filter((i) => i.task.status === 'IN_PROGRESS'),
    /** Completed work that only touches a neighbour (security, networking, configuration) may partly carry forward. */
    possiblyReusable: items.filter((i) => done(i.task.status) && i.relation === 'POTENTIAL'),
  };
}

// ====================================================================== change operations (the model never writes the architecture)
const nodeReplacementFields = z.object({
  name: nodeNameField(), technology: z.string().trim().min(2).max(120), technologySlug: techSlug, purpose: z.string().trim().min(5).max(300), description: z.string().trim().min(10).max(800),
  managedService: z.boolean(), deploymentModel: deploymentModelSchema, provider: z.string().trim().max(60).nullable().default(null),
  configuration: z.array(configItemSchema).max(12).default([]), risks: z.array(z.string().trim().min(3).max(300)).max(8).default([]), alternatives: z.array(nodeAlternativeSchema).max(5).default([]),
  category: nodeCategorySchema.optional(), criticality: prioritySchema.optional(),
});
function nodeNameField() { return z.string().trim().min(2).max(120); }
// Patch fields are defined WITHOUT defaults (zod's .partial() would re-apply defaults and silently overwrite real values).
const nodePatch = z.object({
  name: nodeNameField(), purpose: z.string().trim().min(5).max(300), description: z.string().trim().min(10).max(800), criticality: prioritySchema, managedService: z.boolean(), deploymentModel: deploymentModelSchema,
  provider: z.string().trim().max(60).nullable(), configuration: z.array(configItemSchema).max(12), risks: z.array(z.string().trim().min(3).max(300)).max(8), alternatives: z.array(nodeAlternativeSchema).max(5),
}).partial().strict();
const edgePatch = z.object({
  label: z.string().trim().min(2).max(120), protocol: z.string().trim().min(2).max(80), communicationType: communicationTypeSchema, dataDescription: z.string().trim().min(3).max(300),
  synchronous: z.boolean(), criticality: prioritySchema, encrypted: z.boolean().nullable(),
}).partial().strict();
const decisionInput = architectureDecisionSchema.omit({ key: true, supersedesKey: true });
const decisionPatch = z.object({
  title: z.string().trim().min(5).max(200), problem: z.string().trim().min(10).max(600), decision: z.string().trim().min(10).max(600), rationale: z.string().trim().min(20).max(1200),
  tradeoffs: z.array(z.string().trim().min(3).max(400)).max(8), consequences: z.array(z.string().trim().min(3).max(400)).max(8), nodeStableKeys: z.array(keySlug).max(15), edgeIds: z.array(keySlug).max(15),
}).partial().strict();

export const changeOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ADD_NODE'), node: architectureNodeSchema }),
  z.object({ op: z.literal('REMOVE_NODE'), stableKey: keySlug }),
  z.object({ op: z.literal('REPLACE_NODE'), stableKey: keySlug, keepRole: z.boolean(), newStableKey: keySlug.nullable().default(null), node: nodeReplacementFields }),
  z.object({ op: z.literal('UPDATE_NODE'), stableKey: keySlug, set: nodePatch }),
  z.object({ op: z.literal('ADD_EDGE'), edge: architectureEdgeSchema }),
  z.object({ op: z.literal('REMOVE_EDGE'), id: keySlug }),
  z.object({ op: z.literal('UPDATE_EDGE'), id: keySlug, set: edgePatch }),
  z.object({ op: z.literal('ADD_DECISION'), decision: decisionInput }),
  z.object({ op: z.literal('SUPERSEDE_DECISION'), key: adrKey, decision: decisionInput }),
  z.object({ op: z.literal('UPDATE_DECISION'), key: adrKey, set: decisionPatch }),
]);
export type ChangeOperation = z.infer<typeof changeOperationSchema>;
export const changePlanSchema = z.object({
  summary: text(20, 1200), operations: z.array(changeOperationSchema).min(1).max(40),
  assumptionsAdded: z.array(text(3, 400)).max(10).default([]), risksAdded: z.array(z.object({ text: text(5, 400), severity: prioritySchema, nodeStableKeys: z.array(keySlug).max(10).default([]) })).max(8).default([]),
});
export type ChangePlan = z.infer<typeof changePlanSchema>;

export interface AppliedChange { plan: ArchitecturePlan; errors: string[]; notes: string[]; supersessions: Array<{ newKey: string; supersedesKey: string }>; renames: Array<{ from: string; to: string }> }

/**
 * Applies the model's operations to a copy of the base architecture. This is the ONLY way a candidate version is built. The rules for stable keys live here:
 *  - REPLACE_NODE keepRole=true: the conceptual role is unchanged, so the stableKey is KEPT and the technology changes (the diff reports REPLACED).
 *    The category must not change and the technology must actually differ.
 *  - REPLACE_NODE keepRole=false: the role itself changes, so a NEW stableKey is required (never equal to an existing one) and the new node records
 *    `replacesStableKey`; edges and decisions that pointed at the old component are rewired to the new key.
 *  - UPDATE_NODE can never change the technology or the category (that is a replacement).
 *  - SUPERSEDE_DECISION never deletes history: V1 keeps the decision; V2 gets a NEW key (never a reused one) with `supersedesKey`.
 * Errors are collected, not thrown, so the model can be asked to correct them.
 */
export function applyChangeOperations(base: ArchitecturePlan, change: ChangePlan): AppliedChange {
  const plan: ArchitecturePlan = structuredClone(base); const errors: string[] = []; const notes: string[] = []; const supersessions: AppliedChange['supersessions'] = []; const renames: AppliedChange['renames'] = [];
  const baseKeys = new Set(base.nodes.map((n) => n.stableKey)); const removed = new Set<string>(); const superseded = new Set<string>();
  const maxAdr = Math.max(0, ...base.decisions.map((d) => Number(d.key.slice(4)))); let nextAdr = maxAdr;
  const newKey = () => `adr-${String(++nextAdr).padStart(3, '0')}`;
  const node = (k: string) => plan.nodes.find((n) => n.stableKey === k);
  change.operations.forEach((op, i) => {
    const at = `operations[${i}] ${op.op}`;
    switch (op.op) {
      case 'ADD_NODE':
        if (node(op.node.stableKey) || removed.has(op.node.stableKey)) errors.push(`${at}: stableKey "${op.node.stableKey}" is already used (stable keys are never reused).`); else plan.nodes.push(op.node);
        break;
      case 'REMOVE_NODE':
        if (!node(op.stableKey)) errors.push(`${at}: unknown component "${op.stableKey}".`); else { plan.nodes = plan.nodes.filter((n) => n.stableKey !== op.stableKey); removed.add(op.stableKey); }
        break;
      case 'REPLACE_NODE': {
        const old = node(op.stableKey);
        if (!old) { errors.push(`${at}: unknown component "${op.stableKey}".`); break; }
        if (op.node.technologySlug === old.technologySlug) { errors.push(`${at}: the technology is unchanged; use UPDATE_NODE.`); break; }
        if (op.keepRole) {
          if (op.node.category && op.node.category !== old.category) { errors.push(`${at}: keepRole=true requires the same category (${old.category}); a changed role needs keepRole=false and a new stableKey.`); break; }
          if (op.newStableKey && op.newStableKey !== old.stableKey) { errors.push(`${at}: keepRole=true keeps the stableKey "${old.stableKey}"; do not provide a different newStableKey.`); break; }
          const { category: _c, criticality: _k, ...rest } = op.node;
          Object.assign(old, rest, { criticality: op.node.criticality ?? old.criticality }); notes.push(`Component "${old.stableKey}" keeps its role; technology ${old.technology} (replaced).`);
        } else {
          if (!op.newStableKey) { errors.push(`${at}: keepRole=false requires a newStableKey.`); break; }
          if (node(op.newStableKey) || removed.has(op.newStableKey) || baseKeys.has(op.newStableKey)) { errors.push(`${at}: newStableKey "${op.newStableKey}" is already used.`); break; }
          const fresh = architectureNodeSchema.safeParse({ ...op.node, stableKey: op.newStableKey, category: op.node.category ?? old.category, criticality: op.node.criticality ?? old.criticality, replacesStableKey: old.stableKey });
          if (!fresh.success) { errors.push(`${at}: replacement is not a valid component (${fresh.error.issues[0]?.message}).`); break; }
          plan.nodes = plan.nodes.map((n) => (n.stableKey === old.stableKey ? fresh.data : n)); removed.add(old.stableKey); renames.push({ from: old.stableKey, to: op.newStableKey });
          for (const e of plan.edges) { if (e.sourceStableKey === old.stableKey) e.sourceStableKey = op.newStableKey; if (e.targetStableKey === old.stableKey) e.targetStableKey = op.newStableKey; }
          for (const d of plan.decisions) d.nodeStableKeys = d.nodeStableKeys.map((k) => (k === old.stableKey ? op.newStableKey! : k));
          for (const r of plan.risks) r.nodeStableKeys = r.nodeStableKeys.map((k) => (k === old.stableKey ? op.newStableKey! : k));
          notes.push(`Component "${old.stableKey}" replaced by new component "${op.newStableKey}" (its role changed).`);
        }
        break;
      }
      case 'UPDATE_NODE': {
        const n = node(op.stableKey); if (!n) { errors.push(`${at}: unknown component "${op.stableKey}".`); break; }
        Object.assign(n, op.set); break;
      }
      case 'ADD_EDGE':
        if (plan.edges.some((e) => e.id === op.edge.id)) errors.push(`${at}: edge id "${op.edge.id}" already exists.`); else plan.edges.push(op.edge); break;
      case 'REMOVE_EDGE':
        if (!plan.edges.some((e) => e.id === op.id)) errors.push(`${at}: unknown connection "${op.id}".`); else plan.edges = plan.edges.filter((e) => e.id !== op.id); break;
      case 'UPDATE_EDGE': {
        const e = plan.edges.find((x) => x.id === op.id); if (!e) { errors.push(`${at}: unknown connection "${op.id}".`); break; }
        Object.assign(e, op.set); break;
      }
      case 'ADD_DECISION': plan.decisions.push({ ...op.decision, key: newKey(), supersedesKey: null }); break;
      case 'SUPERSEDE_DECISION': {
        const d = plan.decisions.find((x) => x.key === op.key);
        if (!d) { errors.push(`${at}: unknown decision "${op.key}".`); break; }
        if (superseded.has(op.key)) { errors.push(`${at}: decision "${op.key}" is already superseded in this change.`); break; }
        const key = newKey(); plan.decisions = plan.decisions.filter((x) => x.key !== op.key); plan.decisions.push({ ...op.decision, key, supersedesKey: op.key });
        superseded.add(op.key); supersessions.push({ newKey: key, supersedesKey: op.key }); break;
      }
      case 'UPDATE_DECISION': {
        const d = plan.decisions.find((x) => x.key === op.key); if (!d) { errors.push(`${at}: unknown decision "${op.key}".`); break; }
        Object.assign(d, op.set); break;
      }
    }
  });
  const live = new Set(plan.nodes.map((n) => n.stableKey));
  const before = plan.edges.length; const dropped = plan.edges.filter((e) => !live.has(e.sourceStableKey) || !live.has(e.targetStableKey));
  plan.edges = plan.edges.filter((e) => live.has(e.sourceStableKey) && live.has(e.targetStableKey));
  if (dropped.length) notes.push(`${before - plan.edges.length} connection(s) removed because a component they used no longer exists: ${dropped.map((e) => e.id).join(', ')}.`);
  const edgeIds = new Set(plan.edges.map((e) => e.id));
  for (const d of plan.decisions) { d.nodeStableKeys = d.nodeStableKeys.filter((k) => live.has(k)); d.edgeIds = d.edgeIds.filter((k) => edgeIds.has(k)); }
  for (const r of plan.risks) r.nodeStableKeys = r.nodeStableKeys.filter((k) => live.has(k));
  plan.summary = change.summary; plan.assumptions = [...plan.assumptions, ...change.assumptionsAdded].slice(0, 15);
  plan.risks = [...plan.risks, ...change.risksAdded.map((r) => ({ ...r, nodeStableKeys: r.nodeStableKeys.filter((k) => live.has(k)) }))].slice(0, 15);
  const parsed = architecturePlanSchema.safeParse(plan);
  if (!parsed.success) errors.push(...parsed.error.issues.slice(0, 5).map((x) => `The resulting architecture is invalid at ${x.path.join('.')}: ${x.message}`));
  return { plan: parsed.success ? parsed.data : plan, errors, notes, supersessions, renames };
}

// ====================================================================== deterministic architecture diff (from stored data, never invented)
export type DiffKind = 'ADDED' | 'REMOVED' | 'MODIFIED' | 'UNCHANGED' | 'REPLACED';
export interface DiffNode { stableKey: string; name: string; technology: string; technologySlug: string; category: string; purpose: string; description: string; criticality: string; managedService: boolean; provider: string | null; deploymentModel: string; configuration: Array<{ key: string; value: string }>; replacesStableKey: string | null }
export interface DiffEdge { edgeKey: string; sourceStableKey: string; targetStableKey: string; label: string; protocol: string; communicationType: string; dataDescription: string; synchronous: boolean; encrypted: boolean | null; criticality: string }
export interface DiffDecision { key: string; title: string; decision: string; rationale: string; status: string; nodeStableKeys: string[]; supersedesKey: string | null }
export interface DiffInput { nodes: DiffNode[]; edges: DiffEdge[]; decisions: DiffDecision[] }
export interface NodeDiffEntry { kind: DiffKind; stableKey: string; name: string; changes: string[]; from: { stableKey: string; technology: string } | null; to: { stableKey: string; technology: string } | null }
export interface EdgeDiffEntry { kind: DiffKind; edgeKey: string; source: string; target: string; label: string; changes: string[]; touchesChangedComponent: boolean }
export interface DecisionDiffEntry { kind: 'ADDED' | 'REMOVED' | 'MODIFIED' | 'UNCHANGED' | 'SUPERSEDED'; key: string; title: string; supersededBy: string | null; supersedes: string | null; changes: string[] }
export interface ArchitectureDiff {
  nodes: NodeDiffEntry[]; edges: EdgeDiffEntry[]; decisions: DecisionDiffEntry[];
  summary: { nodes: Record<DiffKind, number>; edges: Record<DiffKind, number>; decisions: Record<'ADDED' | 'REMOVED' | 'MODIFIED' | 'UNCHANGED' | 'SUPERSEDED', number>; sentences: string[] };
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cfg = (c: Array<{ key: string; value: string }>) => [...c].map((x) => `${x.key}=${x.value}`).sort();

export function diffArchitectures(a: DiffInput, b: DiffInput): ArchitectureDiff {
  const aN = new Map(a.nodes.map((n) => [n.stableKey, n])), bN = new Map(b.nodes.map((n) => [n.stableKey, n]));
  const nodes: NodeDiffEntry[] = []; const consumedA = new Set<string>(), consumedB = new Set<string>();
  for (const n of b.nodes) { // role changed: a new stableKey that records which component it replaces
    if (n.replacesStableKey && aN.has(n.replacesStableKey) && !bN.has(n.replacesStableKey)) {
      const o = aN.get(n.replacesStableKey)!; consumedA.add(o.stableKey); consumedB.add(n.stableKey);
      nodes.push({ kind: 'REPLACED', stableKey: n.stableKey, name: n.name, changes: ['stableKey', ...(o.technologySlug !== n.technologySlug ? ['technology'] : []), ...(o.category !== n.category ? ['role'] : [])], from: { stableKey: o.stableKey, technology: o.technology }, to: { stableKey: n.stableKey, technology: n.technology } });
    }
  }
  for (const n of b.nodes) {
    if (consumedB.has(n.stableKey)) continue;
    const o = aN.get(n.stableKey);
    if (!o) { nodes.push({ kind: 'ADDED', stableKey: n.stableKey, name: n.name, changes: [], from: null, to: { stableKey: n.stableKey, technology: n.technology } }); continue; }
    consumedA.add(o.stableKey);
    if (o.technologySlug !== n.technologySlug) { nodes.push({ kind: 'REPLACED', stableKey: n.stableKey, name: n.name, changes: ['technology', ...(o.category !== n.category ? ['role'] : [])], from: { stableKey: o.stableKey, technology: o.technology }, to: { stableKey: n.stableKey, technology: n.technology } }); continue; }
    const ch: string[] = [];
    if (o.purpose !== n.purpose || o.category !== n.category) ch.push('role'); if (o.name !== n.name) ch.push('name'); if (o.description !== n.description) ch.push('description');
    if (o.criticality !== n.criticality) ch.push('criticality'); if (o.managedService !== n.managedService || o.deploymentModel !== n.deploymentModel || o.provider !== n.provider) ch.push('deployment');
    if (!eq(cfg(o.configuration), cfg(n.configuration))) ch.push('configuration');
    nodes.push({ kind: ch.length ? 'MODIFIED' : 'UNCHANGED', stableKey: n.stableKey, name: n.name, changes: ch, from: { stableKey: o.stableKey, technology: o.technology }, to: { stableKey: n.stableKey, technology: n.technology } });
  }
  for (const o of a.nodes) if (!consumedA.has(o.stableKey)) nodes.push({ kind: 'REMOVED', stableKey: o.stableKey, name: o.name, changes: [], from: { stableKey: o.stableKey, technology: o.technology }, to: null });
  const changedKeys = new Set(nodes.filter((n) => n.kind !== 'UNCHANGED').flatMap((n) => [n.stableKey, n.from?.stableKey ?? '']));

  const aE = new Map(a.edges.map((e) => [e.edgeKey, e])), bE = new Map(b.edges.map((e) => [e.edgeKey, e])); const edges: EdgeDiffEntry[] = [];
  for (const e of b.edges) {
    const o = aE.get(e.edgeKey); const touches = changedKeys.has(e.sourceStableKey) || changedKeys.has(e.targetStableKey);
    if (!o) { edges.push({ kind: 'ADDED', edgeKey: e.edgeKey, source: e.sourceStableKey, target: e.targetStableKey, label: e.label, changes: [], touchesChangedComponent: touches }); continue; }
    const ch: string[] = []; if (o.protocol !== e.protocol) ch.push('protocol'); if (o.communicationType !== e.communicationType || o.synchronous !== e.synchronous) ch.push('communication pattern');
    if (o.sourceStableKey !== e.sourceStableKey || o.targetStableKey !== e.targetStableKey) ch.push('endpoints'); if (o.dataDescription !== e.dataDescription) ch.push('data'); if (o.encrypted !== e.encrypted) ch.push('encryption');
    if (o.criticality !== e.criticality) ch.push('criticality'); if (o.label !== e.label) ch.push('label');
    edges.push({ kind: ch.length ? 'MODIFIED' : 'UNCHANGED', edgeKey: e.edgeKey, source: e.sourceStableKey, target: e.targetStableKey, label: e.label, changes: ch, touchesChangedComponent: touches });
  }
  for (const o of a.edges) if (!bE.has(o.edgeKey)) edges.push({ kind: 'REMOVED', edgeKey: o.edgeKey, source: o.sourceStableKey, target: o.targetStableKey, label: o.label, changes: [], touchesChangedComponent: changedKeys.has(o.sourceStableKey) || changedKeys.has(o.targetStableKey) });

  const aD = new Map(a.decisions.map((d) => [d.key, d])), bD = new Map(b.decisions.map((d) => [d.key, d])); const decisions: DecisionDiffEntry[] = [];
  const supersededBy = new Map(b.decisions.filter((d) => d.supersedesKey && aD.has(d.supersedesKey)).map((d) => [d.supersedesKey!, d.key]));
  for (const d of b.decisions) {
    const o = aD.get(d.key);
    if (!o) { decisions.push({ kind: 'ADDED', key: d.key, title: d.title, supersededBy: null, supersedes: d.supersedesKey, changes: [] }); continue; }
    const ch: string[] = []; if (o.title !== d.title) ch.push('title'); if (o.decision !== d.decision) ch.push('decision'); if (o.rationale !== d.rationale) ch.push('rationale'); if (o.status !== d.status) ch.push('status');
    if (!eq([...o.nodeStableKeys].sort(), [...d.nodeStableKeys].sort())) ch.push('components');
    decisions.push({ kind: ch.length ? 'MODIFIED' : 'UNCHANGED', key: d.key, title: d.title, supersededBy: null, supersedes: null, changes: ch });
  }
  for (const o of a.decisions) if (!bD.has(o.key)) decisions.push({ kind: supersededBy.has(o.key) ? 'SUPERSEDED' : 'REMOVED', key: o.key, title: o.title, supersededBy: supersededBy.get(o.key) ?? null, supersedes: null, changes: [] });

  const count = <K extends string>(list: Array<{ kind: K }>, kinds: K[]) => Object.fromEntries(kinds.map((k) => [k, list.filter((x) => x.kind === k).length])) as Record<K, number>;
  const kinds: DiffKind[] = ['ADDED', 'REMOVED', 'MODIFIED', 'UNCHANGED', 'REPLACED'];
  const summary = { nodes: count(nodes, kinds), edges: count(edges, kinds), decisions: count(decisions, ['ADDED', 'REMOVED', 'MODIFIED', 'UNCHANGED', 'SUPERSEDED']), sentences: [] as string[] };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const s = summary.sentences;
  if (summary.nodes.REPLACED) s.push(`${plural(summary.nodes.REPLACED, 'component')} replaced`); if (summary.nodes.ADDED) s.push(`${plural(summary.nodes.ADDED, 'component')} added`);
  if (summary.nodes.REMOVED) s.push(`${plural(summary.nodes.REMOVED, 'component')} removed`); if (summary.nodes.MODIFIED) s.push(`${plural(summary.nodes.MODIFIED, 'component')} modified`);
  const edgeChanged = summary.edges.MODIFIED + summary.edges.ADDED + summary.edges.REMOVED; if (edgeChanged) s.push(`${plural(edgeChanged, 'connection')} changed`);
  if (summary.decisions.SUPERSEDED) s.push(`${plural(summary.decisions.SUPERSEDED, 'decision')} superseded`); if (summary.decisions.ADDED) s.push(`${plural(summary.decisions.ADDED, 'decision')} added`);
  if (!s.length) s.push('No differences');
  return { nodes, edges, decisions, summary };
}
export const isMaterialDiff = (d: ArchitectureDiff) => d.nodes.some((n) => n.kind !== 'UNCHANGED') || d.edges.some((e) => e.kind !== 'UNCHANGED') || d.decisions.some((x) => x.kind !== 'UNCHANGED');

// ====================================================================== failure-mode analysis (graph first, AI only explains)
export interface FailureGraph { nodes: Array<{ stableKey: string; name: string; category: string; criticality: string; managedService: boolean; provider?: string | null; configuration: Array<{ key: string; value: string }> }>; edges: Array<{ edgeKey: string; sourceStableKey: string; targetStableKey: string; communicationType: string; synchronous: boolean }>; decisions: Array<{ key: string; title: string; decision: string; rationale: string; nodeStableKeys: string[] }> }
const REDUNDANCY = /replica|redundan|multi.?az|multi.?region|fail.?over|cluster|autoscal|high.?availab|standby|replication/i;
const BACKUP = /backup|retention|snapshot|point.in.time|pitr|recover/i;
const STATEFUL = ['DATABASE', 'OBJECT_STORAGE', 'EVENT_STREAM', 'QUEUE', 'DATA_WAREHOUSE', 'VECTOR_DATABASE', 'SEARCH', 'CACHE'];
export function analyzeNodeFailure(g: FailureGraph, stableKey: string) {
  const byKey = new Map(g.nodes.map((n) => [n.stableKey, n])); const node = byKey.get(stableKey); if (!node) throw new Error(`unknown component ${stableKey}`);
  const out = new Map<string, string[]>(), inn = new Map<string, string[]>();
  for (const e of g.edges) { out.set(e.sourceStableKey, [...(out.get(e.sourceStableKey) ?? []), e.targetStableKey]); inn.set(e.targetStableKey, [...(inn.get(e.targetStableKey) ?? []), e.sourceStableKey]); }
  const reach = (start: string, adj: Map<string, string[]>) => { const seen = new Set<string>(); const q = [start]; while (q.length) { const k = q.shift()!; for (const n of adj.get(k) ?? []) if (!seen.has(n) && n !== start) { seen.add(n); q.push(n); } } return [...seen]; };
  const downstream = reach(stableKey, out), upstream = reach(stableKey, inn);
  const direct = { stopReceiving: (out.get(stableKey) ?? []), cannotReach: (inn.get(stableKey) ?? []) };
  const entries = g.nodes.filter((n) => !(inn.get(n.stableKey) ?? []).length && n.stableKey !== stableKey).map((n) => n.stableKey);
  const paths: string[][] = []; // shortest entry -> failing component paths
  for (const entry of entries) { const prev = new Map<string, string>(); const q = [entry]; const seen = new Set([entry]); while (q.length) { const k = q.shift()!; if (k === stableKey) break; for (const n of out.get(k) ?? []) if (!seen.has(n)) { seen.add(n); prev.set(n, k); q.push(n); } } if (prev.has(stableKey)) { const p = [stableKey]; while (prev.has(p[0]!)) p.unshift(prev.get(p[0]!)!); paths.push(p); } }
  const mine = g.decisions.filter((d) => d.nodeStableKeys.includes(stableKey));
  const existing: string[] = [];
  for (const c of node.configuration) if (REDUNDANCY.test(`${c.key} ${c.value}`) || BACKUP.test(`${c.key} ${c.value}`)) existing.push(`Configuration records ${c.key} = ${c.value}`);
  for (const d of mine) if (REDUNDANCY.test(`${d.decision} ${d.rationale}`)) existing.push(`Decision ${d.key.toUpperCase()} addresses resilience: ${d.title}`);
  const inEdges = g.edges.filter((e) => e.targetStableKey === stableKey);
  if (inEdges.length && inEdges.every((e) => !e.synchronous || ['EVENT', 'MESSAGE', 'STREAM', 'BATCH'].includes(e.communicationType))) existing.push('Callers are decoupled by asynchronous communication, so they can buffer or retry while it is down');
  if (node.managedService) existing.push('It is a managed service: the provider handles host failure and failover (check the service level you actually have)');
  const hasRedundancy = existing.some((x) => /Configuration records|Decision/.test(x) && REDUNDANCY.test(x));
  const missing: string[] = [];
  if ((node.criticality === 'CRITICAL' || node.criticality === 'HIGH') && !hasRedundancy && !node.managedService) missing.push('No redundancy or failover is recorded for this important component');
  if ((node.criticality === 'CRITICAL' || node.criticality === 'HIGH') && node.managedService && !hasRedundancy) missing.push('No redundancy configuration (for example multi-zone) is recorded, so rely on the provider default only knowingly');
  if (STATEFUL.includes(node.category) && !node.configuration.some((c) => BACKUP.test(`${c.key} ${c.value}`)) && !mine.some((d) => BACKUP.test(`${d.decision} ${d.rationale}`))) missing.push('No backup, retention or recovery objective is recorded for a component that holds state');
  if (inEdges.some((e) => e.synchronous) && upstream.length) missing.push('Synchronous callers fail immediately; no retry, timeout or fallback is recorded');
  const recovery = STATEFUL.includes(node.category) ? ['Recovery means restoring data, not just restarting: confirm how far back you can restore and how long it takes'] : ['It holds no state of its own, so recovery is redeploying it; confirm how quickly that can happen'];
  const spof = (node.criticality === 'CRITICAL' || node.criticality === 'HIGH') && !hasRedundancy && upstream.length + downstream.length > 0;
  return { component: { stableKey, name: node.name, category: node.category, criticality: node.criticality },
    directlyAffected: { stopReceiving: direct.stopReceiving.map((k) => ({ stableKey: k, name: byKey.get(k)?.name ?? k })), cannotReach: direct.cannotReach.map((k) => ({ stableKey: k, name: byKey.get(k)?.name ?? k })) },
    downstream: downstream.map((k) => ({ stableKey: k, name: byKey.get(k)?.name ?? k })), upstream: upstream.map((k) => ({ stableKey: k, name: byKey.get(k)?.name ?? k })),
    criticalPaths: paths.slice(0, 5).map((p) => p.map((k) => byKey.get(k)?.name ?? k)), existingMitigation: existing, missingMitigation: missing, recoveryConsiderations: recovery, singlePointOfFailure: spof, blastRadius: new Set([...downstream, ...upstream]).size };
}

// ====================================================================== production readiness review
export const REVIEW_AREAS = ['RELIABILITY', 'SECURITY', 'PERFORMANCE', 'SCALABILITY', 'COST', 'OBSERVABILITY', 'MAINTAINABILITY', 'OPERATIONAL_COMPLEXITY', 'DISASTER_RECOVERY', 'DATA_INTEGRITY', 'VENDOR_LOCK_IN', 'DEPLOYMENT', 'TESTING'] as const;
export const reviewAreaSchema = z.enum(REVIEW_AREAS);
export type ReviewArea = z.infer<typeof reviewAreaSchema>;
export const reviewOutputSchema = z.object({
  assessment: text(10, 1200),
  findings: z.array(z.object({
    area: reviewAreaSchema, severity: prioritySchema, title: text(5, 160), description: text(10, 800), recommendation: text(10, 600),
    nodeKeys: z.array(keySlug).max(10).default([]), decisionKeys: z.array(adrKey).max(10).default([]), requiresArchitectureChange: z.boolean(),
    suggestedChange: z.string().trim().max(400).default(''),
  })).max(25),
});
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export interface ReviewFindingDraft { area: ReviewArea; severity: z.infer<typeof prioritySchema>; title: string; description: string; recommendation: string; nodeKeys: string[]; decisionKeys: string[]; requiresArchitectureChange: boolean; suggestedChange: string; source: 'DETERMINISTIC' | 'AI' }
export function validateReviewOutput(o: ReviewOutput, nodeKeys: string[], decisionKeys: string[]): string[] {
  const n = new Set(nodeKeys), d = new Set(decisionKeys); const out: string[] = [];
  o.findings.forEach((f, i) => { for (const k of f.nodeKeys) if (!n.has(k)) out.push(`findings[${i}] references unknown component "${k}".`); for (const k of f.decisionKeys) if (!d.has(k)) out.push(`findings[${i}] references unknown decision "${k}".`); if (f.requiresArchitectureChange && !f.suggestedChange) out.push(`findings[${i}] requires an architecture change but has no suggestedChange.`); });
  return out;
}
/** Findings that follow from the stored graph alone (no model): the model's review is added to these, never instead of them. */
export function deterministicReview(g: FailureGraph): ReviewFindingDraft[] {
  const out: ReviewFindingDraft[] = []; const F = (f: Omit<ReviewFindingDraft, 'source' | 'decisionKeys' | 'suggestedChange'> & { decisionKeys?: string[]; suggestedChange?: string }) => out.push({ decisionKeys: [], suggestedChange: '', ...f, source: 'DETERMINISTIC' });
  for (const n of g.nodes) {
    if (n.criticality !== 'CRITICAL' && n.criticality !== 'HIGH') continue;
    const a = analyzeNodeFailure(g, n.stableKey);
    if (a.singlePointOfFailure) F({ area: 'RELIABILITY', severity: n.criticality === 'CRITICAL' ? 'HIGH' : 'MEDIUM', title: `${n.name} is a single point of failure`, description: `If ${n.name} fails, ${a.blastRadius} other component(s) are affected and no redundancy is recorded.`, recommendation: 'Record and implement redundancy or failover for this component, or document why it is acceptable.', nodeKeys: [n.stableKey], requiresArchitectureChange: true, suggestedChange: `Add redundancy or failover for ${n.name}` });
    if (STATEFUL.includes(n.category) && a.missingMitigation.some((m) => /backup/i.test(m))) F({ area: 'DISASTER_RECOVERY', severity: n.category === 'DATABASE' ? 'HIGH' : 'MEDIUM', title: `No recovery objective for ${n.name}`, description: `${n.name} holds state but no backup, retention or recovery objective is recorded.`, recommendation: 'Decide how far back data must be recoverable and how long recovery may take, and record it in the configuration.', nodeKeys: [n.stableKey], requiresArchitectureChange: false });
  }
  const text = g.decisions.map((d) => `${d.decision} ${d.rationale}`).join(' ') + g.nodes.map((n) => n.configuration.map((c) => `${c.key} ${c.value}`).join(' ')).join(' ');
  if (!/multi.?region|cross.?region|disaster/i.test(text) && g.nodes.some((n) => n.criticality === 'CRITICAL')) F({ area: 'DISASTER_RECOVERY', severity: 'MEDIUM', title: 'No multi-region or disaster recovery strategy is recorded', description: 'The architecture has critical components but nothing says what happens if a whole region or site is lost.', recommendation: 'Decide whether a regional outage is acceptable. If not, plan cross-region recovery.', nodeKeys: [], requiresArchitectureChange: true, suggestedChange: 'Add a disaster recovery or multi-region strategy for the critical components' });
  if (!g.nodes.some((n) => n.category === 'OBSERVABILITY') && g.nodes.length >= 4 && !/monitor|observab|metric|alert/i.test(text)) F({ area: 'OBSERVABILITY', severity: 'MEDIUM', title: 'No observability approach is recorded', description: 'No monitoring or logging component or decision exists for a system of this size.', recommendation: 'Decide how logs, metrics and alerts are collected.', nodeKeys: [], requiresArchitectureChange: true, suggestedChange: 'Add monitoring, logging and alerting' });
  const providers = new Set(g.nodes.map((n) => n.provider).filter(Boolean)); const managed = g.nodes.filter((n) => n.managedService && n.provider);
  if (providers.size === 1 && managed.length >= 3) F({ area: 'VENDOR_LOCK_IN', severity: 'LOW', title: `Heavy reliance on one provider (${[...providers][0]})`, description: `${managed.length} managed components all come from one provider, so moving later would touch most of the system.`, recommendation: 'Make sure this concentration is a conscious choice, and isolate provider-specific code behind interfaces.', nodeKeys: managed.map((n) => n.stableKey).slice(0, 10), requiresArchitectureChange: false });
  const syncChain = (() => { const sync = g.edges.filter((e) => e.synchronous); let best = 0; const next = new Map<string, string[]>(); for (const e of sync) next.set(e.sourceStableKey, [...(next.get(e.sourceStableKey) ?? []), e.targetStableKey]); const depth = (k: string, seen: Set<string>): number => (next.get(k) ?? []).reduce((m, t) => (seen.has(t) ? m : Math.max(m, 1 + depth(t, new Set([...seen, t])))), 0); for (const n of g.nodes) best = Math.max(best, depth(n.stableKey, new Set([n.stableKey]))); return best; })();
  if (syncChain >= 4) F({ area: 'PERFORMANCE', severity: 'MEDIUM', title: `A request passes through ${syncChain + 1} components synchronously`, description: 'Long synchronous chains add latency and multiply the chance that one slow component stalls the request.', recommendation: 'Shorten the chain or make some hops asynchronous.', nodeKeys: [], requiresArchitectureChange: true, suggestedChange: 'Reduce synchronous hops in the request path' });
  return out;
}
