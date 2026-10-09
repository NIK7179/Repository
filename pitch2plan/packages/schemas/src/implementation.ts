import { z } from 'zod';
import { prioritySchema } from './discovery';
import { REQUIREMENT_CODE } from './architecture';

/**
 * The implementation plan is persistent domain data derived from ONE immutable architecture version.
 * Tasks link to architecture components by stableKey (never by technology name) and to decisions by decision key.
 */
export const TASK_TYPES = ['SETUP', 'CONFIGURATION', 'CODE', 'INFRASTRUCTURE', 'DATA', 'SECURITY', 'INTEGRATION', 'TESTING', 'OBSERVABILITY', 'DEPLOYMENT', 'VALIDATION', 'OTHER'] as const;
export const taskTypeSchema = z.enum(TASK_TYPES);
export type TaskType = z.infer<typeof taskTypeSchema>;
export const complexitySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
/** Broad bands only. Exact hour estimates would be fake precision. */
export const effortBandSchema = z.enum(['SMALL', 'MEDIUM', 'LARGE']);
export const TASK_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'SKIPPED'] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type PhaseStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED';

const slug = z.string().regex(/^[a-z][a-z0-9-]{1,70}$/, 'use a lowercase kebab-case key');
const adr = z.string().regex(/^adr-\d{3}$/);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const referenceSchema = z.object({
  title: text(3, 200), url: z.string().trim().max(500).regex(/^https:\/\/[^\s]+$/, 'documentation links must be https URLs'),
  sourceType: z.enum(['OFFICIAL_DOCS', 'VENDOR', 'COMMUNITY', 'OTHER']), technology: text(1, 120), version: z.string().trim().max(40).nullable().default(null),
});
export const stepSchema = z.object({ title: text(3, 160), instruction: text(10, 1000), expectedResult: text(5, 400), validation: z.string().trim().max(300).default('') });

// Field validators are defined WITHOUT defaults and reused for the full schema and the patch schema (zod's .partial() would
// otherwise re-apply defaults to omitted fields and silently overwrite real values; Phase 3 taught us that).
const taskCore = {
  title: text(5, 160), objective: text(10, 400), description: text(10, 1200), whyThisTask: text(10, 600), taskType: taskTypeSchema, complexity: complexitySchema, effort: effortBandSchema,
  instructions: text(10, 1500), expectedOutcome: text(10, 600), phaseKey: slug,
};
const taskLists = {
  prerequisites: z.array(text(3, 300)).max(8), validationSteps: z.array(text(5, 300)).min(1).max(10),
  commonProblems: z.array(z.object({ problem: text(5, 300), resolution: text(5, 500) })).max(8), securityNotes: z.array(text(3, 400)).max(8), operationalNotes: z.array(text(3, 400)).max(8),
  steps: z.array(stepSchema).max(15), dependsOn: z.array(slug).max(12), componentKeys: z.array(slug).max(6), decisionKeys: z.array(adr).max(6),
  requirementCodes: z.array(z.string().regex(REQUIREMENT_CODE)).max(10), references: z.array(referenceSchema).max(5),
};
const optionalLists = ['prerequisites', 'commonProblems', 'securityNotes', 'operationalNotes', 'steps', 'dependsOn', 'componentKeys', 'decisionKeys', 'requirementCodes', 'references'] as const;
const defaulted = Object.fromEntries(optionalLists.map((k) => [k, (taskLists[k] as z.ZodArray<z.ZodType>).default([])])) as { [K in (typeof optionalLists)[number]]: z.ZodDefault<(typeof taskLists)[K]> };

export const planTaskSchema = z.object({ key: slug, ...taskCore, validationSteps: taskLists.validationSteps, ...defaulted });
export type PlanTask = z.infer<typeof planTaskSchema>;
export const planPhaseSchema = z.object({ key: slug, name: text(3, 120), objective: text(10, 400), description: text(10, 800) });
export type PlanPhase = z.infer<typeof planPhaseSchema>;
export const componentCoverageSchema = z.object({ stableKey: slug, reason: text(10, 300) });

export const implementationPlanSchema = z.object({
  summary: text(20, 1200), phases: z.array(planPhaseSchema).min(1).max(12), tasks: z.array(planTaskSchema).min(1).max(150),
  /** Components that deliberately need no implementation work, each with an explicit reason. */
  componentCoverage: z.array(componentCoverageSchema).max(40).default([]),
});
export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;

// ---------------------------------------------------------------- issues
export const IMPL_ISSUE_CATEGORIES = ['MISSING_WORK', 'ORDERING', 'SECURITY', 'TESTING', 'OBSERVABILITY', 'DEPLOYMENT', 'ARCHITECTURE_MISMATCH', 'UNNECESSARY_WORK', 'MISSING_VALIDATION', 'GENERIC_CONTENT', 'STRUCTURE', 'OTHER'] as const;
export const implIssueCategorySchema = z.enum(IMPL_ISSUE_CATEGORIES);
export type ImplIssueCategory = z.infer<typeof implIssueCategorySchema>;
export interface ImplIssue {
  source: 'STRUCTURAL' | 'SEMANTIC' | 'CRITIC'; severity: z.infer<typeof prioritySchema>; category: ImplIssueCategory; code: string; description: string;
  taskKeys: string[]; componentKeys: string[]; decisionKeys: string[]; recommendation: string;
}
export interface ComponentFacts { stableKey: string; name: string; technology: string; technologySlug: string; category: string; criticality: string; deploymentModel: string }
export interface DecisionFacts { key: string; status: string; title: string; nodeStableKeys: string[] }
export interface ImplContext { components: ComponentFacts[]; decisions: DecisionFacts[]; requirementCodes: string[] }
const issue = (i: Omit<ImplIssue, 'source' | 'taskKeys' | 'componentKeys' | 'decisionKeys'> & Partial<ImplIssue>): ImplIssue => ({ source: 'STRUCTURAL', taskKeys: [], componentKeys: [], decisionKeys: [], ...i });

/** Kahn's algorithm. Returns the keys that sit on or behind a cycle (empty when the graph is a DAG). Dependencies to unknown keys are ignored here. */
export function findDependencyCycle(tasks: Array<{ key: string; dependsOn: string[] }>): string[] {
  const keys = new Set(tasks.map((t) => t.key));
  const indeg = new Map(tasks.map((t) => [t.key, new Set(t.dependsOn.filter((d) => keys.has(d) && d !== t.key)).size]));
  const dependents = new Map<string, string[]>();
  for (const t of tasks) for (const d of new Set(t.dependsOn)) if (keys.has(d) && d !== t.key) dependents.set(d, [...(dependents.get(d) ?? []), t.key]);
  const queue = [...indeg].filter(([, n]) => n === 0).map(([k]) => k);
  let seen = 0;
  while (queue.length) { const k = queue.shift()!; seen++; for (const n of dependents.get(k) ?? []) { indeg.set(n, indeg.get(n)! - 1); if (indeg.get(n) === 0) queue.push(n); } }
  return seen === tasks.length ? [] : [...indeg].filter(([, n]) => n > 0).map(([k]) => k);
}

/** Valid execution order (dependencies first), stable with respect to the given order. Throws if a cycle exists. */
export function topologicalOrder(tasks: Array<{ key: string; dependsOn: string[] }>): string[] {
  const keys = new Set(tasks.map((t) => t.key)); const done = new Set<string>(); const order: string[] = [];
  const pending = [...tasks];
  while (pending.length) {
    const i = pending.findIndex((t) => t.dependsOn.every((d) => !keys.has(d) || d === t.key || done.has(d)));
    if (i < 0) throw new Error('dependency cycle');
    const [t] = pending.splice(i, 1); done.add(t!.key); order.push(t!.key);
  }
  return order;
}

const EXEMPT = (c: ComponentFacts) => c.category === 'EXTERNAL_SERVICE' && c.deploymentModel === 'EXTERNAL';

export function validateImplementationPlan(plan: ImplementationPlan, ctx: ImplContext): ImplIssue[] {
  const out: ImplIssue[] = [];
  const phaseIdx = new Map<string, number>(); const taskKeys = new Set<string>(); const taskByKey = new Map(plan.tasks.map((t) => [t.key, t]));
  plan.phases.forEach((p, i) => { if (phaseIdx.has(p.key)) out.push(issue({ severity: 'CRITICAL', category: 'STRUCTURE', code: 'DUPLICATE_PHASE', description: `Phase key "${p.key}" is used more than once.`, recommendation: 'Give every phase a unique key.' })); phaseIdx.set(p.key, i); });
  for (const t of plan.tasks) { if (taskKeys.has(t.key)) out.push(issue({ severity: 'CRITICAL', category: 'STRUCTURE', code: 'DUPLICATE_TASK', description: `Task key "${t.key}" is used more than once.`, taskKeys: [t.key], recommendation: 'Give every task a unique key.' })); taskKeys.add(t.key); }
  const nodes = new Set(ctx.components.map((c) => c.stableKey)), decisions = new Set(ctx.decisions.map((d) => d.key)), reqs = new Set(ctx.requirementCodes);
  const used = new Map<string, Set<string>>(); // component -> task keys
  for (const t of plan.tasks) {
    const bad = (code: string, description: string, rec: string) => out.push(issue({ severity: 'CRITICAL', category: 'STRUCTURE', code, description, taskKeys: [t.key], recommendation: rec }));
    if (!phaseIdx.has(t.phaseKey)) bad('BROKEN_REFERENCE', `Task "${t.key}" belongs to unknown phase "${t.phaseKey}".`, 'Use an existing phase.');
    const seenDeps = new Set<string>();
    for (const d of t.dependsOn) {
      if (d === t.key) bad('SELF_DEPENDENCY', `Task "${t.key}" depends on itself.`, 'Remove the self-dependency.');
      else if (!taskByKey.has(d)) bad('BROKEN_REFERENCE', `Task "${t.key}" depends on unknown task "${d}".`, 'Depend on an existing task or remove it.');
      else if (seenDeps.has(d)) bad('DUPLICATE_DEPENDENCY', `Task "${t.key}" lists "${d}" as a dependency more than once.`, 'List each dependency once.');
      seenDeps.add(d);
      const dep = taskByKey.get(d);
      if (dep && phaseIdx.has(dep.phaseKey) && phaseIdx.has(t.phaseKey) && phaseIdx.get(dep.phaseKey)! > phaseIdx.get(t.phaseKey)!) {
        out.push(issue({ severity: 'CRITICAL', category: 'ORDERING', code: 'PHASE_ORDER', description: `Task "${t.key}" (phase "${t.phaseKey}") depends on "${d}" from a LATER phase "${dep.phaseKey}".`, taskKeys: [t.key, d], recommendation: 'Move one task, or reorder the phases, so prerequisites come first.' }));
      }
    }
    for (const c of t.componentKeys) { if (!nodes.has(c)) bad('BROKEN_REFERENCE', `Task "${t.key}" links to unknown architecture component "${c}".`, 'Link to a component stableKey that exists in the architecture.'); else used.set(c, (used.get(c) ?? new Set()).add(t.key)); }
    for (const d of t.decisionKeys) if (!decisions.has(d)) bad('BROKEN_REFERENCE', `Task "${t.key}" links to unknown decision "${d}".`, 'Link to an existing decision key.');
    for (const r of t.requirementCodes) if (!reqs.has(r)) bad('BROKEN_REFERENCE', `Task "${t.key}" cites unknown requirement "${r}".`, 'Cite only requirement codes you were given.');
    if (!t.expectedOutcome.trim()) bad('MISSING_OUTCOME', `Task "${t.key}" has no expected outcome.`, 'State what must be true when the task is done.');
    if (t.validationSteps.length === 0) out.push(issue({ severity: 'HIGH', category: 'MISSING_VALIDATION', code: 'MISSING_VALIDATION', description: `Task "${t.key}" has no validation steps.`, taskKeys: [t.key], recommendation: 'Add checks that show the task is really done.' }));
  }
  for (const p of plan.phases) if (!plan.tasks.some((t) => t.phaseKey === p.key)) out.push(issue({ severity: 'CRITICAL', category: 'STRUCTURE', code: 'EMPTY_PHASE', description: `Phase "${p.key}" has no tasks.`, recommendation: 'Add tasks to the phase or remove it.' }));
  const cycle = findDependencyCycle(plan.tasks);
  if (cycle.length) out.push(issue({ severity: 'CRITICAL', category: 'ORDERING', code: 'DEPENDENCY_CYCLE', description: `These tasks depend on each other in a cycle, so none can ever start: ${cycle.join(', ')}.`, taskKeys: cycle, recommendation: 'Break the cycle by removing the dependency that points backwards.' }));

  const reasons = new Map<string, string>();
  for (const c of plan.componentCoverage) {
    if (!nodes.has(c.stableKey)) out.push(issue({ severity: 'CRITICAL', category: 'STRUCTURE', code: 'BROKEN_REFERENCE', description: `Coverage note refers to unknown component "${c.stableKey}".`, componentKeys: [c.stableKey], recommendation: 'Use an existing component key.' }));
    reasons.set(c.stableKey, c.reason);
    if (used.has(c.stableKey)) out.push(issue({ severity: 'MEDIUM', category: 'STRUCTURE', code: 'COVERAGE_CONTRADICTION', description: `"${c.stableKey}" is said to need no implementation but has tasks.`, componentKeys: [c.stableKey], taskKeys: [...used.get(c.stableKey)!], recommendation: 'Remove the exemption or the tasks.' }));
  }
  for (const c of ctx.components) {
    if (used.has(c.stableKey) || reasons.has(c.stableKey) || EXEMPT(c)) continue;
    const important = c.criticality === 'CRITICAL' || c.criticality === 'HIGH';
    out.push(issue({ severity: important ? 'HIGH' : 'MEDIUM', category: 'MISSING_WORK', code: 'UNCOVERED_COMPONENT', description: `Architecture component "${c.name}" (${c.technology}) has no implementation tasks and no stated reason.`, componentKeys: [c.stableKey], recommendation: 'Add the tasks needed to implement it, or state why none are needed.' }));
  }
  const linked = new Set(plan.tasks.flatMap((t) => t.decisionKeys));
  for (const d of ctx.decisions) if (d.status === 'ACCEPTED' && d.nodeStableKeys.length > 0 && !linked.has(d.key)) out.push(issue({ severity: 'MEDIUM', category: 'MISSING_WORK', code: 'DECISION_NOT_IMPLEMENTED', description: `Accepted decision ${d.key.toUpperCase()} ("${d.title}") is not linked from any task.`, decisionKeys: [d.key], recommendation: 'Link the tasks that carry out this decision.' }));
  return out;
}

// ---------------------------------------------------------------- semantic rules (deterministic, deliberately incomplete)
const GENERIC = /\b(best practices?|as needed|as appropriate|follow the (official )?documentation|etc\.?|and so on|various|depending on your needs|make sure everything works|install (the )?(software|tool)|set up (the )?(system|environment) properly)\b/i;
const HEAVY = ['kubernetes', 'kafka', 'kinesis', 'spark', 'flink', 'pulsar', 'hadoop', 'cassandra', 'airflow', 'rabbitmq', 'terraform'];

export function genericContentKeys(plan: ImplementationPlan, ctx: ImplContext): string[] {
  const terms = ctx.components.flatMap((c) => [c.name, c.technology, c.stableKey]).map((s) => s.toLowerCase()).filter((s) => s.length > 2);
  return plan.tasks.filter((t) => {
    const body = [t.title, t.instructions, t.description, ...t.steps.map((s) => `${s.title} ${s.instruction}`)].join(' ');
    const generic = (body.match(new RegExp(GENERIC.source, 'gi')) ?? []).length;
    const specific = terms.some((x) => body.toLowerCase().includes(x)) || t.decisionKeys.length > 0 || t.requirementCodes.length > 0;
    return generic >= 2 || (generic >= 1 && !specific);
  }).map((t) => t.key);
}

export function evaluateImplementationRules(plan: ImplementationPlan, ctx: ImplContext, reqTexts: Array<{ code: string; statement: string }>): ImplIssue[] {
  const out: ImplIssue[] = [];
  const sem = (i: Omit<ImplIssue, 'source' | 'taskKeys' | 'componentKeys' | 'decisionKeys'> & Partial<ImplIssue>) => out.push({ source: 'SEMANTIC', taskKeys: [], componentKeys: [], decisionKeys: [], ...i });
  const types = new Set(plan.tasks.map((t) => t.taskType));
  const mentions = (re: RegExp) => plan.tasks.some((t) => re.test(`${t.title} ${t.instructions} ${t.operationalNotes.join(' ')}`));
  const important = ctx.components.filter((c) => c.criticality === 'CRITICAL' || c.criticality === 'HIGH');
  if (!types.has('TESTING') && !types.has('VALIDATION')) sem({ severity: 'MEDIUM', category: 'TESTING', code: 'NO_TESTING', description: 'The plan contains no testing or end-to-end validation task.', recommendation: 'Add tasks that test the integrated system against the requirements.' });
  if (important.length > 0 && !types.has('OBSERVABILITY') && !mentions(/monitor|metric|alert|dashboard|log/i)) sem({ severity: 'HIGH', category: 'OBSERVABILITY', code: 'NO_OBSERVABILITY', description: `There are ${important.length} important component(s) but no monitoring, logging or alerting work anywhere in the plan.`, componentKeys: important.map((c) => c.stableKey), recommendation: 'Add tasks for logs, metrics, health checks and alerts on the important components.' });
  const sensitive = reqTexts.filter((r) => /sensitive|confidential|financial|payment|health|personal|pii|compliance|tenant|isolation|privacy/i.test(r.statement));
  if (!types.has('SECURITY') && !plan.tasks.some((t) => t.securityNotes.length > 0)) sem({ severity: sensitive.length ? 'HIGH' : 'MEDIUM', category: 'SECURITY', code: 'NO_SECURITY', description: sensitive.length ? 'Requirements involve sensitive data, but the plan has no security work or security notes.' : 'The plan has no security work or security notes.', recommendation: 'Add identity, secrets, encryption and least-privilege tasks tied to the components that need them.' });
  if (!types.has('DEPLOYMENT') && !types.has('INFRASTRUCTURE')) sem({ severity: 'MEDIUM', category: 'DEPLOYMENT', code: 'NO_DEPLOYMENT', description: 'The plan has no infrastructure or deployment work.', recommendation: 'Add the tasks that provision environments and ship the system.' });
  if (plan.tasks.length < ctx.components.length) sem({ severity: 'MEDIUM', category: 'MISSING_WORK', code: 'TOO_COARSE', description: `Only ${plan.tasks.length} task(s) for ${ctx.components.length} components; tasks are probably too broad to act on.`, recommendation: 'Break broad tasks into actionable ones.' });
  if (plan.tasks.length > 120) sem({ severity: 'MEDIUM', category: 'UNNECESSARY_WORK', code: 'TOO_FINE', description: `${plan.tasks.length} tasks is more than a team can sensibly follow.`, recommendation: 'Merge trivial tasks.' });
  const arch = ctx.components.map((c) => `${c.technology} ${c.technologySlug} ${c.name}`).join(' ').toLowerCase();
  const stray = plan.tasks.filter((t) => HEAVY.some((h) => `${t.title} ${t.steps.map((s) => s.title).join(' ')}`.toLowerCase().includes(h) && !arch.includes(h)));
  if (stray.length) sem({ severity: 'HIGH', category: 'ARCHITECTURE_MISMATCH', code: 'TECHNOLOGY_NOT_IN_ARCHITECTURE', description: `Tasks mention technologies that are not part of this architecture: ${stray.slice(0, 5).map((t) => `"${t.title}"`).join(', ')}.`, taskKeys: stray.map((t) => t.key), recommendation: 'Implement only what the architecture contains.' });
  const generic = genericContentKeys(plan, ctx);
  if (generic.length) sem({ severity: 'MEDIUM', category: 'GENERIC_CONTENT', code: 'GENERIC_LANGUAGE', description: `${generic.length} task(s) read as generic advice that does not mention this project's components or decisions.`, taskKeys: generic.slice(0, 10), recommendation: 'Rewrite them around this project: name the component, the decision and the requirement behind each step.' });
  return out;
}

// ---------------------------------------------------------------- critic
export const implCriticSchema = z.object({
  assessment: text(10, 1200),
  issues: z.array(z.object({
    severity: prioritySchema, category: implIssueCategorySchema, description: text(10, 800), taskKeys: z.array(slug).max(10).default([]), componentKeys: z.array(slug).max(10).default([]),
    decisionKeys: z.array(adr).max(10).default([]), recommendation: text(10, 800),
  })).max(25),
});
export type ImplCriticOutput = z.infer<typeof implCriticSchema>;
export function validateImplCritic(out: ImplCriticOutput, plan: ImplementationPlan, ctx: ImplContext): string[] {
  const tasks = new Set(plan.tasks.map((t) => t.key)), nodes = new Set(ctx.components.map((c) => c.stableKey)), dec = new Set(ctx.decisions.map((d) => d.key)); const m: string[] = [];
  out.issues.forEach((i, n) => {
    for (const k of i.taskKeys) if (!tasks.has(k)) m.push(`issues[${n}] references unknown task "${k}".`);
    for (const k of i.componentKeys) if (!nodes.has(k)) m.push(`issues[${n}] references unknown component "${k}".`);
    for (const k of i.decisionKeys) if (!dec.has(k)) m.push(`issues[${n}] references unknown decision "${k}".`);
  });
  return m;
}
export const criticToImplIssue = (i: ImplCriticOutput['issues'][number], n: number): ImplIssue => ({ source: 'CRITIC', code: `CRITIC_${n + 1}`, ...i });

// ---------------------------------------------------------------- repair patch (targeted; never a silent regeneration)
const taskPatch = z.object({ ...taskCore, ...taskLists }).partial().strict();
const phasePatch = z.object({ name: planPhaseSchema.shape.name, objective: planPhaseSchema.shape.objective, description: planPhaseSchema.shape.description }).partial().strict();
export const implRepairPatchSchema = z.object({
  changes: z.array(z.object({ issueIndex: z.number().int().min(0), description: text(5, 400) })).min(1).max(40),
  phases: z.object({ add: z.array(planPhaseSchema).default([]), update: z.array(z.object({ key: slug, set: phasePatch })).default([]), remove: z.array(slug).default([]) }).default({ add: [], update: [], remove: [] }),
  tasks: z.object({ add: z.array(planTaskSchema).default([]), update: z.array(z.object({ key: slug, set: taskPatch })).default([]), remove: z.array(slug).default([]) }).default({ add: [], update: [], remove: [] }),
  coverage: z.object({ add: z.array(componentCoverageSchema).default([]), remove: z.array(slug).default([]) }).default({ add: [], remove: [] }),
});
export type ImplRepairPatch = z.infer<typeof implRepairPatchSchema>;

export function validateImplRepairPatch(p: ImplRepairPatch, plan: ImplementationPlan, issueCount: number, mustAddress: number[]): string[] {
  const out: string[] = []; const tk = new Set(plan.tasks.map((t) => t.key)), pk = new Set(plan.phases.map((x) => x.key));
  for (const c of p.changes) if (c.issueIndex >= issueCount) out.push(`changes references issue ${c.issueIndex}, but only ${issueCount} issues were listed.`);
  const addressed = new Set(p.changes.map((c) => c.issueIndex));
  for (const i of mustAddress) if (!addressed.has(i)) out.push(`Issue ${i} must be addressed but no change refers to it.`);
  for (const t of p.tasks.add) if (tk.has(t.key)) out.push(`tasks.add: "${t.key}" already exists; use update.`);
  for (const u of p.tasks.update) if (!tk.has(u.key)) out.push(`tasks.update: unknown task "${u.key}".`);
  for (const k of p.tasks.remove) if (!tk.has(k)) out.push(`tasks.remove: unknown task "${k}".`);
  for (const x of p.phases.add) if (pk.has(x.key)) out.push(`phases.add: "${x.key}" already exists; use update.`);
  for (const u of p.phases.update) if (!pk.has(u.key)) out.push(`phases.update: unknown phase "${u.key}".`);
  for (const k of p.phases.remove) if (!pk.has(k)) out.push(`phases.remove: unknown phase "${k}".`);
  return out;
}
const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
/** Removing a task also removes it from other tasks' dependencies. Removing a phase requires its tasks to be removed or moved by the same patch. */
export function applyImplRepairPatch(plan: ImplementationPlan, p: ImplRepairPatch): ImplementationPlan {
  const next: ImplementationPlan = structuredClone(plan);
  const goneTasks = new Set(p.tasks.remove), gonePhases = new Set(p.phases.remove);
  next.phases = next.phases.filter((x) => !gonePhases.has(x.key)).map((x) => { const u = p.phases.update.find((y) => y.key === x.key); return u ? ({ ...x, ...strip(u.set) } as PlanPhase) : x; }).concat(p.phases.add);
  next.tasks = next.tasks.filter((t) => !goneTasks.has(t.key)).map((t) => { const u = p.tasks.update.find((y) => y.key === t.key); return u ? ({ ...t, ...strip(u.set) } as PlanTask) : t; }).concat(p.tasks.add)
    .map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => !goneTasks.has(d)) }));
  const rm = new Set(p.coverage.remove);
  next.componentCoverage = next.componentCoverage.filter((c) => !rm.has(c.stableKey)).concat(p.coverage.add);
  return next;
}

// ---------------------------------------------------------------- planner input shared with domain/ai
export interface ImplPlanInput {
  context: { workspaceId: string; projectId: string; userId: string };
  project: { name: string; technicalLevel?: string };
  brief: unknown;
  requirements: Array<{ code: string; category: string; statement: string; origin: string }>;
  drivers: Array<{ code: string; name: string; description: string; priority: string }>;
  architecture: {
    summary: string; assumptions: string[]; risks: Array<{ text: string; severity: string; nodeStableKeys: string[] }>;
    nodes: Array<ComponentFacts & { purpose: string; description: string; provider: string | null; managedService: boolean; configuration: Array<{ key: string; value: string }>; risks: string[]; alternatives: Array<{ technology: string; reasoning: string }> }>;
    edges: Array<{ id: string; source: string; target: string; label: string; protocol: string; communicationType: string; dataDescription: string; encrypted: boolean | null }>;
    decisions: Array<{ key: string; title: string; status: string; decision: string; rationale: string; nodeStableKeys: string[]; driverCodes: string[]; requirementCodes: string[] }>;
  };
}
export interface ImplCritiqueInput { context: ImplPlanInput['context']; architecture: ImplPlanInput['architecture']; requirements: ImplPlanInput['requirements']; plan: ImplementationPlan; precheckIssues: ImplIssue[] }
export interface ImplRepairInput { context: ImplPlanInput['context']; architecture: ImplPlanInput['architecture']; requirements: ImplPlanInput['requirements']; plan: ImplementationPlan; issues: ImplIssue[]; mustAddress: number[] }
