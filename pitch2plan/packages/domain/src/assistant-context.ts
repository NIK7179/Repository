import type { ConversationScope } from '@pitch2plan/schemas';

export interface TaskLite {
  id: string; key: string; title: string; status: string; taskType: string; phaseName: string; dependsOn: string[]; componentKeys: string[]; decisionKeys: string[]; objective: string; instructions: string;
  expectedOutcome: string; validationSteps: string[]; securityNotes: string[]; commonProblems: Array<{ problem: string; resolution: string }>;
  steps: Array<{ id: string; sequence: number; title: string; instruction: string; expectedResult: string; validation: string; status: string }>;
}
export interface AssistantContextInput {
  project: { id: string; name: string }; brief: { projectSummary: string; businessObjective: string };
  requirements: Array<{ code: string; category: string; statement: string; origin: string }>;
  drivers: Array<{ code: string; name: string; description: string; priority: string; requirementCodes: string[] }>;
  architecture: {
    versionNumber: number; summary: string;
    nodes: Array<{ stableKey: string; name: string; technology: string; category: string; purpose: string; description: string; criticality: string; provider: string | null; managedService: boolean; deploymentModel: string; configuration: Array<{ key: string; value: string }>; risks: string[]; alternatives: Array<{ technology: string; reasoning: string }> }>;
    edges: Array<{ edgeKey: string; sourceStableKey: string; targetStableKey: string; label: string; protocol: string; communicationType: string; dataDescription: string; encrypted: boolean | null }>;
    decisions: Array<{ key: string; title: string; status: string; decision: string; rationale: string; tradeoffs: string[]; nodeStableKeys: string[]; driverCodes: string[]; requirementCodes: string[] }>;
  };
  plan: null | { progress: { percent: number; completed: number; applicable: number }; tasks: TaskLite[] };
  scope: { kind: ConversationScope; scopeId: string; stepId?: string };
  question: string;
  tail: Array<{ role: 'USER' | 'ASSISTANT'; content: string }>;
  maxChars?: number;
}
export interface BuiltContext { context: Record<string, unknown>; refs: Array<{ type: string; id: string }>; stats: { chars: number; level: number; included: { components: number; decisions: number; requirements: number; tasks: number }; omitted: { components: number; requirements: number; tasks: number } } }

const TOPICS: Array<[RegExp, string[]]> = [
  [/secur|auth|encrypt|secret|permission|\biam\b|\btls\b|credential|access|privacy|complian|tenant/i, ['SECURITY', 'PRIVACY', 'COMPLIANCE']],
  [/latenc|perform|slow|throughput|scal|load|speed|capacity|partition/i, ['PERFORMANCE', 'LATENCY', 'TRAFFIC', 'SCALABILITY']],
  [/cost|budget|cheap|price|expens/i, ['BUDGET']],
  [/availab|outage|fail|redundan|recover|backup|durab/i, ['AVAILABILITY', 'DATA_RETENTION']],
  [/retention|replay|delete|gdpr|compliance/i, ['DATA_RETENTION', 'COMPLIANCE']],
];
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const LEVELS = [
  { tasksOther: 14, reqs: 10, decisions: 8, tail: 6, tailChars: 700, neighbors: 8, textCap: 1500 },
  { tasksOther: 8, reqs: 6, decisions: 5, tail: 4, tailChars: 400, neighbors: 5, textCap: 800 },
  { tasksOther: 4, reqs: 4, decisions: 3, tail: 2, tailChars: 250, neighbors: 3, textCap: 400 },
];

/**
 * Deterministic context selection. The model gets what bears on THIS scope, not the database:
 * the focus component(s), their neighbours and connections, the decisions that govern them, the requirements and drivers behind
 * those decisions (plus topical requirements when the question is about security, performance, cost, ...), the current task and step,
 * related tasks, plan progress and a short conversation tail. Unrelated components and requirements are left out on purpose
 * (cost, latency, quality and privacy). If the result is too large it is shrunk by dropping the least relevant material first.
 */
export function buildAssistantContext(i: AssistantContextInput): BuiltContext {
  const max = i.maxChars ?? 24_000;
  const task = i.scope.kind === 'TASK' ? i.plan?.tasks.find((t) => t.id === i.scope.scopeId) : undefined;
  const focus = new Set(i.scope.kind === 'COMPONENT' ? [i.scope.scopeId] : task?.componentKeys ?? []);
  const nodeBy = new Map(i.architecture.nodes.map((n) => [n.stableKey, n]));
  const reqBy = new Map(i.requirements.map((r) => [r.code, r]));
  const driverBy = new Map(i.drivers.map((d) => [d.code, d]));
  const edges = i.architecture.edges.filter((e) => focus.has(e.sourceStableKey) || focus.has(e.targetStableKey));
  const neighborKeys = [...new Set(edges.flatMap((e) => [e.sourceStableKey, e.targetStableKey]).filter((k) => !focus.has(k)))];
  const decisions = i.scope.kind === 'PROJECT' ? i.architecture.decisions : i.architecture.decisions.filter((d) => d.nodeStableKeys.some((k) => focus.has(k)) || (task?.decisionKeys.includes(d.key) ?? false));
  const topical = new Set<string>(); const probe = `${i.question} ${task?.taskType ?? ''} ${task?.title ?? ''}`;
  for (const [re, cats] of TOPICS) if (re.test(probe)) cats.forEach((c) => topical.add(c));
  if (task?.taskType === 'SECURITY') ['SECURITY', 'PRIVACY', 'COMPLIANCE'].forEach((c) => topical.add(c));

  const reqCodes: string[] = [];
  const addReq = (c: string) => { if (reqBy.has(c) && !reqCodes.includes(c)) reqCodes.push(c); };
  for (const d of decisions) { d.requirementCodes.forEach(addReq); d.driverCodes.flatMap((c) => driverBy.get(c)?.requirementCodes ?? []).forEach(addReq); }
  for (const r of i.requirements) if (topical.has(r.category)) addReq(r.code);

  for (let level = 0; level < LEVELS.length; level++) {
    const L = LEVELS[level]!;
    const relatedKeys = new Set<string>(task ? [...task.dependsOn] : []);
    const tasks = i.plan?.tasks ?? [];
    const dependents = task ? tasks.filter((t) => t.dependsOn.includes(task.key)) : [];
    const sameComponent = tasks.filter((t) => t.id !== task?.id && t.componentKeys.some((k) => focus.has(k)));
    const related = [...tasks.filter((t) => relatedKeys.has(t.key)), ...dependents, ...sameComponent].filter((t, n, a) => a.findIndex((x) => x.id === t.id) === n);
    const otherTasks = related.slice(0, L.tasksOther).map((t) => ({ id: t.id, title: t.title, status: t.status, type: t.taskType, relation: relatedKeys.has(t.key) ? 'prerequisite' : dependents.includes(t) ? 'unblocked by this task' : 'same component' }));
    const shownReqs = reqCodes.slice(0, L.reqs).map((c) => reqBy.get(c)!);
    const shownDecisions = decisions.slice(0, L.decisions);
    const shownNeighbors = neighborKeys.slice(0, L.neighbors);
    const step = task && i.scope.stepId ? task.steps.find((s) => s.id === i.scope.stepId) : undefined;

    const context: Record<string, unknown> = {
      project: { name: i.project.name, summary: clip(i.brief.projectSummary, 500), objective: clip(i.brief.businessObjective, 400), architectureVersion: i.architecture.versionNumber, architectureSummary: clip(i.architecture.summary, L.textCap) },
      scope: { kind: i.scope.kind, ...(i.scope.kind === 'COMPONENT' ? { component: i.scope.scopeId } : {}), ...(task ? { taskId: task.id } : {}) },
      focusComponents: [...focus].map((k) => nodeBy.get(k)).filter(Boolean).map((n) => ({ stableKey: n!.stableKey, name: n!.name, technology: n!.technology, category: n!.category, role: clip(n!.purpose, 300), description: clip(n!.description, L.textCap), criticality: n!.criticality, provider: n!.provider, managedService: n!.managedService, deploymentModel: n!.deploymentModel, configuration: n!.configuration, risks: n!.risks.slice(0, 5), alternatives: n!.alternatives.slice(0, 3) })),
      connections: edges.slice(0, 12).map((e) => ({ from: nodeBy.get(e.sourceStableKey)?.name ?? e.sourceStableKey, to: nodeBy.get(e.targetStableKey)?.name ?? e.targetStableKey, label: e.label, protocol: e.protocol, type: e.communicationType, data: e.dataDescription, encrypted: e.encrypted })),
      neighbours: shownNeighbors.map((k) => ({ stableKey: k, name: nodeBy.get(k)?.name, technology: nodeBy.get(k)?.technology, role: clip(nodeBy.get(k)?.purpose ?? '', 160) })),
      decisions: shownDecisions.map((d) => ({ key: d.key, title: d.title, status: d.status, decision: clip(d.decision, 400), rationale: clip(d.rationale, L.textCap), tradeoffs: d.tradeoffs.slice(0, 3), drivers: d.driverCodes })),
      requirements: shownReqs.map((r) => ({ code: r.code, category: r.category, statement: r.statement })),
      drivers: [...new Set(shownDecisions.flatMap((d) => d.driverCodes))].slice(0, 6).map((c) => driverBy.get(c)).filter(Boolean).map((d) => ({ code: d!.code, name: d!.name, priority: d!.priority })),
      ...(i.scope.kind === 'PROJECT' ? { allComponents: i.architecture.nodes.map((n) => ({ stableKey: n.stableKey, name: n.name, technology: n.technology, category: n.category })) } : {}),
      ...(task ? { currentTask: { id: task.id, title: task.title, status: task.status, type: task.taskType, phase: task.phaseName, objective: clip(task.objective, 400), instructions: clip(task.instructions, L.textCap), expectedOutcome: task.expectedOutcome, validationSteps: task.validationSteps, securityNotes: task.securityNotes.slice(0, 4), commonProblems: task.commonProblems.slice(0, 4), steps: task.steps.map((s) => ({ id: s.id, n: s.sequence + 1, title: s.title, status: s.status })) } } : {}),
      ...(step ? { currentStep: { id: step.id, n: step.sequence + 1, title: step.title, instruction: step.instruction, expectedResult: step.expectedResult, validation: step.validation, status: step.status } } : {}),
      relatedTasks: otherTasks,
      ...(i.plan ? { planProgress: i.plan.progress, ...(i.scope.kind === 'PROJECT' ? { blockedTasks: tasks.filter((t) => t.status === 'BLOCKED').slice(0, 5).map((t) => ({ id: t.id, title: t.title })) } : {}) } : {}),
      conversationTail: i.tail.slice(-L.tail).map((m) => ({ role: m.role.toLowerCase(), content: clip(m.content, L.tailChars) })),
    };
    const chars = JSON.stringify(context).length;
    if (chars <= max || level === LEVELS.length - 1) {
      const refs = [
        ...[...focus].map((k) => ({ type: 'component', id: k })), ...shownDecisions.map((d) => ({ type: 'decision', id: d.key })), ...shownReqs.map((r) => ({ type: 'requirement', id: r.code })),
        ...(task ? [{ type: 'task', id: task.id }] : []), ...(step ? [{ type: 'step', id: step.id }] : []), ...otherTasks.map((t) => ({ type: 'task', id: t.id })),
      ];
      return { context, refs, stats: { chars, level, included: { components: focus.size + shownNeighbors.length, decisions: shownDecisions.length, requirements: shownReqs.length, tasks: otherTasks.length + (task ? 1 : 0) }, omitted: { components: Math.max(0, i.architecture.nodes.length - focus.size - shownNeighbors.length), requirements: Math.max(0, i.requirements.length - shownReqs.length), tasks: Math.max(0, tasks.length - otherTasks.length - (task ? 1 : 0)) } } };
    }
  }
  throw new Error('unreachable');
}
