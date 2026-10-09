import { z } from 'zod';
import { prioritySchema } from './discovery';

/**
 * The architecture is persistent, structured domain data. React Flow only ever RENDERS it.
 * Nothing in this file (or in packages/domain) knows about any graph/canvas library.
 */
export const NODE_CATEGORIES = [
  'CLIENT', 'EDGE', 'API', 'APPLICATION_SERVICE', 'AUTH', 'DATABASE', 'CACHE', 'QUEUE', 'EVENT_STREAM', 'STREAM_PROCESSOR', 'BATCH_PROCESSOR',
  'OBJECT_STORAGE', 'DATA_WAREHOUSE', 'SEARCH', 'AI_MODEL', 'VECTOR_DATABASE', 'OBSERVABILITY', 'SECURITY', 'CI_CD', 'NETWORK', 'EXTERNAL_SERVICE', 'OTHER',
] as const;
export const nodeCategorySchema = z.enum(NODE_CATEGORIES);
export type NodeCategory = z.infer<typeof nodeCategorySchema>;

export const DEPLOYMENT_MODELS = ['MANAGED_SERVICE', 'SELF_HOSTED', 'SERVERLESS', 'CONTAINER', 'SAAS', 'EXTERNAL', 'CLIENT_SIDE', 'OTHER'] as const;
export const deploymentModelSchema = z.enum(DEPLOYMENT_MODELS);
export const COMMUNICATION_TYPES = ['REQUEST_RESPONSE', 'EVENT', 'STREAM', 'BATCH', 'FILE', 'DATABASE', 'CACHE', 'MESSAGE', 'MODEL_INFERENCE', 'OTHER'] as const;
export const communicationTypeSchema = z.enum(COMMUNICATION_TYPES);
export type CommunicationType = z.infer<typeof communicationTypeSchema>;

/** Categories that may legitimately have no data-flow edges (cross-cutting concerns). */
export const ORPHAN_ALLOWED_CATEGORIES: readonly NodeCategory[] = ['OBSERVABILITY', 'SECURITY', 'CI_CD', 'NETWORK', 'OTHER'];

const keySlug = z.string().regex(/^[a-z][a-z0-9-]{1,60}$/, 'use a lowercase kebab-case key, for example "event-stream"');
const techSlug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,60}$/, 'use a lowercase technology slug, for example "apache-kafka"');

export const nodeAlternativeSchema = z.object({ technology: z.string().trim().min(1).max(120), reasoning: z.string().trim().min(10).max(600) });
export const configItemSchema = z.object({ key: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(300), note: z.string().trim().max(300).optional() });

// Field validators are defined once WITHOUT defaults. The full schema adds defaults; the patch schema makes everything optional.
// (zod's .partial() would otherwise re-apply defaults to omitted fields and silently overwrite real values.)
const nodeCore = {
  name: z.string().trim().min(2).max(120), technology: z.string().trim().min(2).max(120), technologySlug: techSlug, category: nodeCategorySchema,
  purpose: z.string().trim().min(5).max(300), description: z.string().trim().min(10).max(800), criticality: prioritySchema, managedService: z.boolean(), deploymentModel: deploymentModelSchema,
};
const nodeDefaulted = {
  provider: z.string().trim().max(60).nullable(), configuration: z.array(configItemSchema).max(12), risks: z.array(z.string().trim().min(3).max(300)).max(8),
  alternatives: z.array(nodeAlternativeSchema).max(5),
  /** Lineage: this component replaces the one with this stableKey from the previous version. */
  replacesStableKey: keySlug.nullable(),
};
export const architectureNodeSchema = z.object({
  stableKey: keySlug, ...nodeCore,
  provider: nodeDefaulted.provider.default(null), configuration: nodeDefaulted.configuration.default([]), risks: nodeDefaulted.risks.default([]),
  alternatives: nodeDefaulted.alternatives.default([]), replacesStableKey: nodeDefaulted.replacesStableKey.default(null),
});
export type ArchitectureNodeDraft = z.infer<typeof architectureNodeSchema>;

const edgeCore = {
  sourceStableKey: keySlug, targetStableKey: keySlug, label: z.string().trim().min(2).max(120), protocol: z.string().trim().min(2).max(80), communicationType: communicationTypeSchema,
  dataDescription: z.string().trim().min(3).max(300), synchronous: z.boolean(), criticality: prioritySchema,
};
const edgeEncrypted = z.boolean().nullable();
export const architectureEdgeSchema = z.object({ id: keySlug, ...edgeCore, encrypted: edgeEncrypted.default(null) });
export type ArchitectureEdgeDraft = z.infer<typeof architectureEdgeSchema>;

export const decisionAlternativeSchema = z.object({ technology: z.string().trim().min(1).max(120), reasoning: z.string().trim().min(10).max(600) });
export const DRIVER_CODE = /^DRV-\d{3}$/;
export const REQUIREMENT_CODE = /^REQ-\d{3}$/;

const decisionCore = {
  title: z.string().trim().min(5).max(200), problem: z.string().trim().min(10).max(600), decision: z.string().trim().min(10).max(600), rationale: z.string().trim().min(20).max(1200),
  status: z.enum(['PROPOSED', 'ACCEPTED']), confidence: z.number().min(0).max(1),
};
const decisionLists = {
  tradeoffs: z.array(z.string().trim().min(3).max(400)).max(8), risks: z.array(z.string().trim().min(3).max(400)).max(8), alternatives: z.array(decisionAlternativeSchema).max(6),
  consequences: z.array(z.string().trim().min(3).max(400)).max(8), driverCodes: z.array(z.string().regex(DRIVER_CODE)).max(10), requirementCodes: z.array(z.string().regex(REQUIREMENT_CODE)).max(15),
  nodeStableKeys: z.array(keySlug).max(15), edgeIds: z.array(keySlug).max(15),
};
export const architectureDecisionSchema = z.object({
  key: z.string().regex(/^adr-\d{3}$/, 'decision keys look like adr-001'), ...decisionCore,
  tradeoffs: decisionLists.tradeoffs.default([]), risks: decisionLists.risks.default([]), alternatives: decisionLists.alternatives.default([]), consequences: decisionLists.consequences.default([]),
  driverCodes: decisionLists.driverCodes.default([]), requirementCodes: decisionLists.requirementCodes.default([]), nodeStableKeys: decisionLists.nodeStableKeys.default([]), edgeIds: decisionLists.edgeIds.default([]),
  /** Set only by a change application: this decision replaces the (still preserved) decision with this key in the previous version. */
  supersedesKey: z.string().regex(/^adr-\d{3}$/).nullable().default(null),
});
export type ArchitectureDecisionDraft = z.infer<typeof architectureDecisionSchema>;

export const architecturePlanSchema = z.object({
  summary: z.string().trim().min(20).max(1200),
  nodes: z.array(architectureNodeSchema).min(1).max(40),
  edges: z.array(architectureEdgeSchema).max(80).default([]),
  decisions: z.array(architectureDecisionSchema).min(1).max(30),
  risks: z.array(z.object({ text: z.string().trim().min(5).max(400), severity: prioritySchema, nodeStableKeys: z.array(keySlug).max(10).default([]) })).max(15).default([]),
  assumptions: z.array(z.string().trim().min(3).max(400)).max(15).default([]),
  unresolvedQuestions: z.array(z.string().trim().min(3).max(400)).max(15).default([]),
});
export type ArchitecturePlan = z.infer<typeof architecturePlanSchema>;

// ------------------------------------------------------------------ issues (structural, semantic, critic)
export const ISSUE_CATEGORIES = [
  'MISSING_REQUIREMENT', 'SCALABILITY', 'RELIABILITY', 'SECURITY', 'PERFORMANCE', 'COST', 'DATA', 'COMPLEXITY', 'SINGLE_POINT_OF_FAILURE',
  'OBSERVABILITY', 'INCONSISTENCY', 'UNNECESSARY_TECHNOLOGY', 'STRUCTURE', 'OTHER',
] as const;
export const issueCategorySchema = z.enum(ISSUE_CATEGORIES);
export type IssueCategory = z.infer<typeof issueCategorySchema>;
export const issueSourceSchema = z.enum(['STRUCTURAL', 'SEMANTIC', 'CRITIC']);
export interface ArchitectureIssue {
  source: z.infer<typeof issueSourceSchema>; severity: z.infer<typeof prioritySchema>; category: IssueCategory; code: string; description: string;
  affectedNodeStableKeys: string[]; affectedDecisionKeys: string[]; relatedRequirementCodes: string[]; recommendation: string;
}

export interface PlanContext { driverCodes: string[]; requirementCodes: string[] }

/**
 * Referential integrity: the graph must at least be parseable. Used inside the planner/repairer pipeline so a malformed
 * response gets one corrective retry before anything else looks at it.
 */
export function validatePlanReferences(plan: ArchitecturePlan, ctx: PlanContext): string[] {
  const issues: string[] = [];
  const nodeKeys = new Set<string>(), edgeIds = new Set<string>(), decisionKeys = new Set<string>();
  for (const n of plan.nodes) { if (nodeKeys.has(n.stableKey)) issues.push(`Duplicate node stableKey "${n.stableKey}".`); nodeKeys.add(n.stableKey); }
  for (const e of plan.edges) { if (edgeIds.has(e.id)) issues.push(`Duplicate edge id "${e.id}".`); edgeIds.add(e.id); }
  for (const e of plan.edges) {
    if (!nodeKeys.has(e.sourceStableKey)) issues.push(`Edge "${e.id}" has unknown source node "${e.sourceStableKey}".`);
    if (!nodeKeys.has(e.targetStableKey)) issues.push(`Edge "${e.id}" has unknown target node "${e.targetStableKey}".`);
  }
  const drivers = new Set(ctx.driverCodes), reqs = new Set(ctx.requirementCodes);
  for (const d of plan.decisions) {
    if (decisionKeys.has(d.key)) issues.push(`Duplicate decision key "${d.key}".`);
    decisionKeys.add(d.key);
    for (const k of d.nodeStableKeys) if (!nodeKeys.has(k)) issues.push(`Decision ${d.key} references unknown node "${k}".`);
    for (const k of d.edgeIds) if (!edgeIds.has(k)) issues.push(`Decision ${d.key} references unknown edge "${k}".`);
    for (const c of d.driverCodes) if (!drivers.has(c)) issues.push(`Decision ${d.key} references unknown driver "${c}".`);
    for (const c of d.requirementCodes) if (!reqs.has(c)) issues.push(`Decision ${d.key} references unknown requirement "${c}".`);
  }
  for (const [i, r] of plan.risks.entries()) for (const k of r.nodeStableKeys) if (!nodeKeys.has(k)) issues.push(`risks[${i}] references unknown node "${k}".`);
  return issues;
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const CLOUD_PREFIX: Array<[RegExp, string]> = [[/^aws-/, 'aws'], [/^azure-/, 'azure'], [/^gcp-|^google-/, 'gcp']];
const providerKey = (p: string) => (/amazon|aws/i.test(p) ? 'aws' : /azure|microsoft/i.test(p) ? 'azure' : /google|gcp/i.test(p) ? 'gcp' : p.toLowerCase());

const issue = (i: Omit<ArchitectureIssue, 'source' | 'affectedNodeStableKeys' | 'affectedDecisionKeys' | 'relatedRequirementCodes'> & Partial<ArchitectureIssue>): ArchitectureIssue =>
  ({ source: 'STRUCTURAL', affectedNodeStableKeys: [], affectedDecisionKeys: [], relatedRequirementCodes: [], ...i });

/** Deterministic structural validation. Independent of the LLM and of any critic. CRITICAL issues block the architecture. */
export function validateArchitectureStructure(plan: ArchitecturePlan, ctx: PlanContext): ArchitectureIssue[] {
  const out: ArchitectureIssue[] = [];
  for (const message of validatePlanReferences(plan, ctx)) {
    out.push(issue({ severity: 'CRITICAL', category: 'STRUCTURE', code: 'BROKEN_REFERENCE', description: message, recommendation: 'Fix the reference or remove the dangling item.' }));
  }
  const edgeSeen = new Map<string, string>();
  const degree = new Map(plan.nodes.map((n) => [n.stableKey, 0]));
  for (const e of plan.edges) {
    if (e.sourceStableKey === e.targetStableKey) {
      out.push(issue({ severity: 'CRITICAL', category: 'STRUCTURE', code: 'SELF_EDGE', description: `Edge "${e.id}" connects ${e.sourceStableKey} to itself.`, affectedNodeStableKeys: [e.sourceStableKey], recommendation: 'Remove the self-edge or model the interaction between two components.' }));
    }
    const sig = `${e.sourceStableKey}>${e.targetStableKey}>${e.communicationType}>${normName(e.label)}`;
    if (edgeSeen.has(sig)) out.push(issue({ severity: 'HIGH', category: 'STRUCTURE', code: 'DUPLICATE_EDGE', description: `Edges "${edgeSeen.get(sig)}" and "${e.id}" describe the same interaction.`, affectedNodeStableKeys: [e.sourceStableKey, e.targetStableKey], recommendation: 'Keep a single edge for this interaction.' }));
    edgeSeen.set(sig, e.id);
    for (const k of [e.sourceStableKey, e.targetStableKey]) if (degree.has(k)) degree.set(k, degree.get(k)! + 1);
  }
  if (plan.nodes.length > 1) {
    for (const n of plan.nodes) {
      if (degree.get(n.stableKey) === 0 && !ORPHAN_ALLOWED_CATEGORIES.includes(n.category)) {
        out.push(issue({ severity: 'CRITICAL', category: 'STRUCTURE', code: 'ORPHAN_NODE', description: `Component "${n.name}" has no connections.`, affectedNodeStableKeys: [n.stableKey], recommendation: 'Connect it to the components it interacts with, or remove it if it is not needed.' }));
      }
    }
  }
  const seenNames = new Map<string, string>(), seenSlug = new Map<string, string>();
  for (const n of plan.nodes) {
    const nameKey = `${n.technologySlug}|${normName(n.name)}`;
    if (seenNames.has(nameKey)) out.push(issue({ severity: 'CRITICAL', category: 'STRUCTURE', code: 'DUPLICATE_NODE', description: `"${n.name}" appears more than once (${seenNames.get(nameKey)} and ${n.stableKey}).`, affectedNodeStableKeys: [seenNames.get(nameKey)!, n.stableKey], recommendation: 'Merge the duplicate components.' }));
    seenNames.set(nameKey, n.stableKey);
    const slugKey = `${n.technologySlug}|${n.category}`;
    if (seenSlug.has(slugKey) && !seenNames.has(`dup|${slugKey}`)) {
      out.push(issue({ severity: 'MEDIUM', category: 'STRUCTURE', code: 'POSSIBLE_DUPLICATE_NODE', description: `${n.technology} is used for two ${n.category.toLowerCase().replaceAll('_', ' ')} components (${seenSlug.get(slugKey)}, ${n.stableKey}). Confirm they are really separate.`, affectedNodeStableKeys: [seenSlug.get(slugKey)!, n.stableKey], recommendation: 'Merge them unless they have distinct responsibilities.' }));
      seenNames.set(`dup|${slugKey}`, n.stableKey);
    }
    seenSlug.set(slugKey, n.stableKey);
    if (n.managedService && !n.provider) out.push(issue({ severity: 'HIGH', category: 'STRUCTURE', code: 'PROVIDER_MISSING', description: `"${n.name}" is marked as a managed service but names no provider.`, affectedNodeStableKeys: [n.stableKey], recommendation: 'Name the provider or mark it self-hosted.' }));
    for (const [re, p] of CLOUD_PREFIX) if (re.test(n.technologySlug) && n.provider && providerKey(n.provider) !== p) {
      out.push(issue({ severity: 'HIGH', category: 'STRUCTURE', code: 'PROVIDER_MISMATCH', description: `"${n.name}" uses technology "${n.technologySlug}" but names provider "${n.provider}".`, affectedNodeStableKeys: [n.stableKey], recommendation: 'Make the provider and technology agree.' }));
    }
  }
  for (const d of plan.decisions) {
    if (d.status === 'ACCEPTED' && d.driverCodes.length === 0 && d.requirementCodes.length === 0) {
      out.push(issue({ severity: 'CRITICAL', category: 'STRUCTURE', code: 'DECISION_WITHOUT_DRIVER', description: `Accepted decision ${d.key} ("${d.title}") is not linked to any architecture driver or requirement.`, affectedDecisionKeys: [d.key], recommendation: 'Link it to the drivers or requirements that caused it, or mark it PROPOSED.' }));
    }
    if (d.nodeStableKeys.length === 0 && d.edgeIds.length === 0) {
      out.push(issue({ severity: 'MEDIUM', category: 'STRUCTURE', code: 'DECISION_WITHOUT_COMPONENT', description: `Decision ${d.key} does not say which components implement it.`, affectedDecisionKeys: [d.key], recommendation: 'Link the decision to the components it affects.' }));
    }
  }
  const covered = new Set(plan.decisions.flatMap((d) => d.nodeStableKeys));
  for (const n of plan.nodes) {
    if ((n.criticality === 'CRITICAL' || n.criticality === 'HIGH') && !covered.has(n.stableKey)) {
      out.push(issue({ severity: 'MEDIUM', category: 'STRUCTURE', code: 'NODE_WITHOUT_DECISION', description: `Important component "${n.name}" is not explained by any decision.`, affectedNodeStableKeys: [n.stableKey], recommendation: 'Add or extend a decision that explains why this component exists.' }));
    }
  }
  return out;
}

// ------------------------------------------------------------------ semantic (rule-based) checks. Not complete, by design.
export interface RequirementText { code: string; category: string; statement: string }
const HA = /high availab|always on|almost never be down|unacceptable|99\.9|multi-?region|zero downtime|costly/i;
const SENSITIVE = /sensitive|confidential|financial|payment|health|personal|pii|compliance|regulat|legally protected/i;
const AGNOSTIC = /cloud[- ]agnostic|portab|no vendor lock|avoid lock-?in/i;
const BUDGET = /cheap|low cost|low-cost|budget|prototype|as cheap as possible|keep it as cheap/i;
const REDUNDANT = /replica|multi-?az|cluster|redundan|failover|ha\b|high availab|autoscal|multiple instances|active-active/i;
const HEAVY_SLUGS = /kubernetes|kafka|spark|flink|pulsar|hadoop|cassandra/;

export function evaluateSemanticRules(plan: ArchitecturePlan, reqs: RequirementText[]): ArchitectureIssue[] {
  const out: ArchitectureIssue[] = [];
  const sem = (i: Omit<ArchitectureIssue, 'source'>) => out.push({ source: 'SEMANTIC', ...i });
  const codes = (re: RegExp) => reqs.filter((r) => re.test(r.statement)).map((r) => r.code);

  const ha = codes(HA);
  if (ha.length) {
    for (const n of plan.nodes) {
      const managed = n.deploymentModel === 'MANAGED_SERVICE' || n.deploymentModel === 'SERVERLESS' || n.deploymentModel === 'SAAS' || n.deploymentModel === 'EXTERNAL' || n.deploymentModel === 'CLIENT_SIDE';
      const redundant = n.configuration.some((c) => REDUNDANT.test(`${c.key} ${c.value} ${c.note ?? ''}`)) || REDUNDANT.test(n.description);
      if ((n.criticality === 'CRITICAL') && !managed && !redundant && !['CLIENT', 'OBSERVABILITY', 'CI_CD'].includes(n.category)) {
        sem({ severity: 'HIGH', category: 'SINGLE_POINT_OF_FAILURE', code: 'SINGLETON_CRITICAL', description: `Availability matters, but critical component "${n.name}" is self-run with no stated redundancy.`, affectedNodeStableKeys: [n.stableKey], affectedDecisionKeys: [], relatedRequirementCodes: ha, recommendation: 'Run it redundantly (replicas, failover) or use a managed service with built-in redundancy.' });
      }
    }
  }
  const sens = codes(SENSITIVE);
  if (sens.length) {
    for (const e of plan.edges.filter((x) => x.encrypted === false)) {
      sem({ severity: 'HIGH', category: 'SECURITY', code: 'UNENCRYPTED_SENSITIVE', description: `Requirements involve sensitive data, but "${e.label}" is explicitly unencrypted.`, affectedNodeStableKeys: [e.sourceStableKey, e.targetStableKey], affectedDecisionKeys: [], relatedRequirementCodes: sens, recommendation: 'Encrypt this connection in transit.' });
    }
  }
  const agn = codes(AGNOSTIC);
  if (agn.length) {
    const lockIn = plan.nodes.filter((n) => n.managedService && n.provider && /aws|azure|gcp|google|amazon|microsoft/i.test(n.provider));
    if (lockIn.length) sem({ severity: 'MEDIUM', category: 'INCONSISTENCY', code: 'LOCK_IN_VS_AGNOSTIC', description: `Requirements ask for portability, but ${lockIn.length} component(s) use provider-specific managed services (${lockIn.map((n) => n.name).join(', ')}).`, affectedNodeStableKeys: lockIn.map((n) => n.stableKey), affectedDecisionKeys: [], relatedRequirementCodes: agn, recommendation: 'Justify each provider-specific service in a decision, or prefer portable alternatives.' });
  }
  const bud = codes(BUDGET);
  if (bud.length) {
    const c = computeComplexity(plan);
    const heavy = plan.nodes.filter((n) => HEAVY_SLUGS.test(n.technologySlug));
    if (c.label === 'HIGH' || heavy.length > 0) sem({ severity: 'MEDIUM', category: 'COST', code: 'COMPLEX_FOR_BUDGET', description: `Cost is a constraint, but the design is ${c.label.toLowerCase()} in complexity (${c.nodes} components${heavy.length ? `; heavyweight: ${heavy.map((n) => n.name).join(', ')}` : ''}).`, affectedNodeStableKeys: heavy.map((n) => n.stableKey), affectedDecisionKeys: [], relatedRequirementCodes: bud, recommendation: 'Prefer simpler or managed components unless a driver clearly requires the heavyweight ones.' });
  }
  return out;
}

export interface Complexity { score: number; nodes: number; edges: number; heavyweight: number; label: 'LOW' | 'MODERATE' | 'HIGH' }
/** A rough heuristic for comparing designs, NOT a measurement. */
export function computeComplexity(plan: Pick<ArchitecturePlan, 'nodes' | 'edges'>): Complexity {
  const heavyweight = plan.nodes.filter((n) => ['EVENT_STREAM', 'STREAM_PROCESSOR', 'BATCH_PROCESSOR'].includes(n.category) || HEAVY_SLUGS.test(n.technologySlug)).length;
  const score = Math.round((plan.nodes.length + plan.edges.length * 0.5 + heavyweight * 3) * 10) / 10;
  return { score, nodes: plan.nodes.length, edges: plan.edges.length, heavyweight, label: score < 12 ? 'LOW' : score < 25 ? 'MODERATE' : 'HIGH' };
}

// ------------------------------------------------------------------ critic
const critIssue = z.object({
  severity: prioritySchema, category: issueCategorySchema, description: z.string().trim().min(10).max(800),
  affectedNodeStableKeys: z.array(keySlug).max(10).default([]), affectedDecisionIds: z.array(z.string().regex(/^adr-\d{3}$/)).max(10).default([]),
  relatedRequirementIds: z.array(z.string().regex(REQUIREMENT_CODE)).max(10).default([]), recommendation: z.string().trim().min(10).max(800),
});
export const criticOutputSchema = z.object({ assessment: z.string().trim().min(10).max(1200), issues: z.array(critIssue).max(25) });
export type CriticOutput = z.infer<typeof criticOutputSchema>;

export function validateCriticOutput(out: CriticOutput, plan: ArchitecturePlan, ctx: PlanContext): string[] {
  const issues: string[] = [];
  const nodes = new Set(plan.nodes.map((n) => n.stableKey)), decisions = new Set(plan.decisions.map((d) => d.key)), reqs = new Set(ctx.requirementCodes);
  out.issues.forEach((i, n) => {
    for (const k of i.affectedNodeStableKeys) if (!nodes.has(k)) issues.push(`issues[${n}] references unknown node "${k}".`);
    for (const k of i.affectedDecisionIds) if (!decisions.has(k)) issues.push(`issues[${n}] references unknown decision "${k}".`);
    for (const k of i.relatedRequirementIds) if (!reqs.has(k)) issues.push(`issues[${n}] references unknown requirement "${k}".`);
  });
  return issues;
}
export const criticIssueToIssue = (i: CriticOutput['issues'][number], n: number): ArchitectureIssue => ({
  source: 'CRITIC', severity: i.severity, category: i.category, code: `CRITIC_${n + 1}`, description: i.description, affectedNodeStableKeys: i.affectedNodeStableKeys,
  affectedDecisionKeys: i.affectedDecisionIds, relatedRequirementCodes: i.relatedRequirementIds, recommendation: i.recommendation,
});

// ------------------------------------------------------------------ repair patch (targeted changes, never a silent regeneration)
// Patches contain ONLY the fields the repairer names. Unknown fields (for example a stableKey inside "set") are rejected.
const nodePatch = z.object({ ...nodeCore, ...nodeDefaulted }).partial().strict();
const edgePatch = z.object({ ...edgeCore, encrypted: edgeEncrypted }).partial().strict();
const decisionPatch = z.object({ ...decisionCore, ...decisionLists }).partial().strict();
export const repairPatchSchema = z.object({
  changes: z.array(z.object({ issueIndex: z.number().int().min(0), description: z.string().trim().min(5).max(400) })).min(1).max(30),
  nodes: z.object({ add: z.array(architectureNodeSchema).default([]), update: z.array(z.object({ stableKey: keySlug, set: nodePatch })).default([]), remove: z.array(keySlug).default([]) }).default({ add: [], update: [], remove: [] }),
  edges: z.object({ add: z.array(architectureEdgeSchema).default([]), update: z.array(z.object({ id: keySlug, set: edgePatch })).default([]), remove: z.array(keySlug).default([]) }).default({ add: [], update: [], remove: [] }),
  decisions: z.object({ add: z.array(architectureDecisionSchema).default([]), update: z.array(z.object({ key: z.string().regex(/^adr-\d{3}$/), set: decisionPatch })).default([]), remove: z.array(z.string().regex(/^adr-\d{3}$/)).default([]) }).default({ add: [], update: [], remove: [] }),
  addRisks: z.array(z.object({ text: z.string().trim().min(5).max(400), severity: prioritySchema, nodeStableKeys: z.array(keySlug).max(10).default([]) })).max(10).default([]),
  addAssumptions: z.array(z.string().trim().min(3).max(400)).max(10).default([]),
});
export type RepairPatch = z.infer<typeof repairPatchSchema>;

export function validateRepairPatch(patch: RepairPatch, plan: ArchitecturePlan, issueCount: number, mustAddress: number[]): string[] {
  const out: string[] = [];
  const nodeKeys = new Set(plan.nodes.map((n) => n.stableKey)), edgeIds = new Set(plan.edges.map((e) => e.id)), decKeys = new Set(plan.decisions.map((d) => d.key));
  for (const c of patch.changes) if (c.issueIndex >= issueCount) out.push(`changes references issue ${c.issueIndex}, but only ${issueCount} issues were listed.`);
  const addressed = new Set(patch.changes.map((c) => c.issueIndex));
  for (const i of mustAddress) if (!addressed.has(i)) out.push(`Issue ${i} must be addressed (CRITICAL or blocking) but no change refers to it.`);
  for (const n of patch.nodes.add) if (nodeKeys.has(n.stableKey)) out.push(`nodes.add: "${n.stableKey}" already exists; use update.`);
  for (const u of patch.nodes.update) if (!nodeKeys.has(u.stableKey)) out.push(`nodes.update: unknown node "${u.stableKey}".`);
  for (const k of patch.nodes.remove) if (!nodeKeys.has(k)) out.push(`nodes.remove: unknown node "${k}".`);
  for (const e of patch.edges.add) if (edgeIds.has(e.id)) out.push(`edges.add: "${e.id}" already exists; use update.`);
  for (const u of patch.edges.update) if (!edgeIds.has(u.id)) out.push(`edges.update: unknown edge "${u.id}".`);
  for (const k of patch.edges.remove) if (!edgeIds.has(k)) out.push(`edges.remove: unknown edge "${k}".`);
  for (const d of patch.decisions.add) if (decKeys.has(d.key)) out.push(`decisions.add: "${d.key}" already exists; use update.`);
  for (const u of patch.decisions.update) if (!decKeys.has(u.key)) out.push(`decisions.update: unknown decision "${u.key}".`);
  for (const k of patch.decisions.remove) if (!decKeys.has(k)) out.push(`decisions.remove: unknown decision "${k}".`);
  return out;
}

/** Deterministically applies a repair patch. Removing a node also removes its edges and its references in decisions and risks. */
export function applyRepairPatch(plan: ArchitecturePlan, patch: RepairPatch): ArchitecturePlan {
  const next: ArchitecturePlan = structuredClone(plan);
  const gone = new Set(patch.nodes.remove);
  next.nodes = next.nodes.filter((n) => !gone.has(n.stableKey)).map((n) => {
    const u = patch.nodes.update.find((x) => x.stableKey === n.stableKey);
    return u ? ({ ...n, ...stripUndefined(u.set) } as ArchitectureNodeDraft) : n;
  }).concat(patch.nodes.add);
  const goneEdges = new Set(patch.edges.remove);
  next.edges = next.edges.filter((e) => !goneEdges.has(e.id) && !gone.has(e.sourceStableKey) && !gone.has(e.targetStableKey)).map((e) => {
    const u = patch.edges.update.find((x) => x.id === e.id);
    return u ? ({ ...e, ...stripUndefined(u.set) } as ArchitectureEdgeDraft) : e;
  }).concat(patch.edges.add);
  const edgeIds = new Set(next.edges.map((e) => e.id));
  const goneDec = new Set(patch.decisions.remove);
  next.decisions = next.decisions.filter((d) => !goneDec.has(d.key)).map((d) => {
    const u = patch.decisions.update.find((x) => x.key === d.key);
    return u ? ({ ...d, ...stripUndefined(u.set) } as ArchitectureDecisionDraft) : d;
  }).concat(patch.decisions.add).map((d) => ({ ...d, nodeStableKeys: d.nodeStableKeys.filter((k) => !gone.has(k)), edgeIds: d.edgeIds.filter((k) => edgeIds.has(k)) }));
  next.risks = next.risks.map((r) => ({ ...r, nodeStableKeys: r.nodeStableKeys.filter((k) => !gone.has(k)) })).concat(patch.addRisks);
  next.assumptions = [...next.assumptions, ...patch.addAssumptions];
  return next;
}
const stripUndefined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

// ------------------------------------------------------------------ planner inputs shared by domain and ai
export interface ArchCodebookItem { code: string; id: string }
export interface PlanInput {
  context: { workspaceId: string; projectId: string; userId: string };
  project: { name: string; technicalLevel?: string };
  brief: unknown; // the confirmed Architecture Brief content
  requirements: Array<{ code: string; category: string; statement: string; value: string | null; origin: string; confidence: number | null }>;
  drivers: Array<{ code: string; name: string; description: string; priority: string; requirementCodes: string[] }>;
}
export interface CritiqueInput { context: PlanInput['context']; requirements: PlanInput['requirements']; drivers: PlanInput['drivers']; plan: ArchitecturePlan; precheckIssues: ArchitectureIssue[] }
export interface RepairInput { context: PlanInput['context']; requirements: PlanInput['requirements']; drivers: PlanInput['drivers']; plan: ArchitecturePlan; issues: ArchitectureIssue[]; mustAddress: number[] }
