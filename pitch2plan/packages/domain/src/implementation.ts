import {
  canTransitionTask, computeProgress, nextBestTask, phaseStatus, taskReadiness, type ProgressTask, type TaskStatus, type ImplIssue,
} from '@pitch2plan/schemas';
import { requireProjectAccess } from './authorization';
import { buildCodebook } from './architecture-codes';
import type { RequestContext } from './discovery';
import { DomainError } from './errors';
import { loadProjectKnowledge, toImplContext, toPlanInput, type ProjectKnowledge } from './implementation-context';
import { DEFAULT_IMPL_PIPELINE_CONFIG, ImplPipelineError, runImplementationPipeline, type ImplPipelineConfig } from './implementation-pipeline';
import type { Logger } from './logger';
import type { ArchitectureVersionRecord, ImplementationAiPort, ImplRunRecord, JobQueue, PlanVersionRecord, ProjectRecord, Repositories, TaskRecord } from './ports';
import { IMPLEMENTATION_JOB } from './ports';
import { isAiError, requireStatus } from './shared';

export interface ImplementationConfig extends ImplPipelineConfig { staleRunMs: number }
export const DEFAULT_IMPLEMENTATION_CONFIG: ImplementationConfig = { ...DEFAULT_IMPL_PIPELINE_CONFIG, staleRunMs: 10 * 60_000 };

const SAFE: Record<string, string> = {
  AI_OUTPUT_INVALID: 'The AI’s implementation plan did not pass our validation checks.',
  AI_TIMEOUT: 'The AI service took too long to respond.',
  AI_PROVIDER_ERROR: 'The AI service is temporarily unavailable.',
  IMPLEMENTATION_VALIDATION_FAILED: 'We could not produce an implementation plan that passed all checks, even after repair attempts.',
  GENERATION_TIMED_OUT: 'Implementation planning did not finish in time.',
  ENQUEUE_FAILED: 'We could not start implementation planning.',
  PROJECT_STATE_CHANGED: 'The project or its architecture changed while the plan was being generated.',
  INTERNAL_ERROR: 'Something went wrong on our side while planning the implementation.',
};
const toRunView = (r: ImplRunRecord) => ({ id: r.id, jobId: r.jobId, status: r.status, currentStage: r.currentStage, repairCount: r.repairCount, failureCode: r.failureCode, failureMessage: r.failureMessage, createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, planVersionId: r.planVersionId });
export type ImplRunView = ReturnType<typeof toRunView>;

export type ImplementationState = 'NOT_AVAILABLE' | 'NOT_STARTED' | 'GENERATING' | 'FAILED' | 'READY';

const asProgress = (t: TaskRecord): ProgressTask => ({ key: t.key, status: t.status, dependsOn: t.dependsOn, phaseKey: t.phaseKey, phaseSequence: t.phaseSequence, sequence: t.sequence, title: t.title, componentKeys: t.componentKeys });

export function buildPlanView(plan: PlanVersionRecord, arch: ArchitectureVersionRecord) {
  const pt = plan.tasks.map(asProgress);
  const readiness = taskReadiness(pt); const progress = computeProgress(pt); const next = nextBestTask(pt);
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
  const tasks = plan.tasks.map((t) => ({
    id: t.id, key: t.key, title: t.title, taskType: t.taskType, complexity: t.complexity, effort: t.effort, status: t.status, readiness: readiness.get(t.key)!, phaseKey: t.phaseKey, sequence: t.sequence,
    componentKeys: t.componentKeys, decisionKeys: t.decisionKeys, dependsOn: t.dependsOn,
    unmetDependencies: t.dependsOn.filter((d) => { const s = byKey.get(d)?.status; return s !== 'COMPLETED' && s !== 'SKIPPED'; }), stepCount: t.steps.length, stepsDone: t.steps.filter((s) => s.status === 'COMPLETED').length,
  }));
  const phases = plan.phases.map((p) => {
    const inPhase = plan.tasks.filter((t) => t.phaseId === p.id);
    const waiting = new Set(inPhase.flatMap((t) => t.dependsOn.map((d) => byKey.get(d)).filter((d) => d && d.phaseKey !== p.key && d.status !== 'COMPLETED' && d.status !== 'SKIPPED').map((d) => d!.phaseKey)));
    return { id: p.id, key: p.key, sequence: p.sequence, name: p.name, objective: p.objective, description: p.description, status: phaseStatus(inPhase.map((t) => t.status)), taskCount: inPhase.length, progress: progress.byPhase[p.key]!, waitingOnPhases: [...waiting] };
  });
  const reasons = new Map(plan.componentCoverage.map((c) => [c.stableKey, c.reason]));
  const coverage = arch.nodes.map((n) => {
    const own = plan.tasks.filter((t) => t.componentKeys.includes(n.stableKey));
    const exempt = own.length === 0 && (reasons.has(n.stableKey) || (n.category === 'EXTERNAL_SERVICE' && n.deploymentModel === 'EXTERNAL'));
    return { stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: n.category, taskCount: own.length, completed: own.filter((t) => t.status === 'COMPLETED').length,
      status: own.length ? ('COVERED' as const) : exempt ? ('EXEMPT' as const) : ('UNCOVERED' as const), reason: own.length ? null : reasons.get(n.stableKey) ?? (exempt ? 'External dependency: nothing to implement beyond integration.' : null) };
  });
  return {
    version: { id: plan.id, versionNumber: plan.versionNumber, architectureVersionId: plan.architectureVersionId, architectureVersionNumber: arch.versionNumber, summary: plan.summary, createdAt: plan.createdAt },
    phases, tasks, progress,
    next: next ? { taskId: plan.tasks.find((t) => t.key === next.task.key)!.id, key: next.task.key, title: next.task.title ?? next.task.key, kind: next.kind, reason: next.reason } : null,
    coverage: { components: coverage, summary: { total: coverage.length, covered: coverage.filter((c) => c.status === 'COVERED').length, exempt: coverage.filter((c) => c.status === 'EXEMPT').length, uncovered: coverage.filter((c) => c.status === 'UNCOVERED').length } },
    openFindings: plan.issues.filter((i) => i.stage === 'FINAL' && (i.severity === 'CRITICAL' || i.severity === 'HIGH')).map((i) => ({ severity: i.severity, category: i.category, description: i.description })),
  };
}
export type PlanView = ReturnType<typeof buildPlanView>;

export function createImplementationService(deps: { repos: Repositories; ai: ImplementationAiPort; queue: JobQueue; logger: Logger; config: ImplementationConfig }) {
  const { repos, ai, queue, logger, config } = deps;
  const event = (p: { workspaceId: string; id: string }, userId: string | undefined, name: string, properties?: Record<string, string | number | boolean | null>) =>
    repos.analytics.record({ workspaceId: p.workspaceId, projectId: p.id, userId, name, properties }).catch((e) => logger.error({ name, err: String(e) }, 'analytics failed'));
  const audit = (p: { workspaceId: string; id: string }, actorId: string | undefined, action: string, extra: { entityType?: string; entityId?: string; requestId?: string; metadata?: Record<string, unknown> } = {}) =>
    repos.audit.record({ workspaceId: p.workspaceId, projectId: p.id, actorId, action, ...extra });

  async function failRun(run: ImplRunRecord, code: string, issues?: Array<ImplIssue & { stage: string }>) {
    const r = await repos.implementation.failRun({ runId: run.id, code, message: SAFE[code] ?? SAFE.INTERNAL_ERROR!, issues });
    const project = await repos.projects.findById(run.projectId);
    if (r.failed && project) { await event(project, undefined, 'implementation_generation_failed', { code, attempt: run.attempt }); await audit(project, undefined, 'implementation.generation_failed', { entityType: 'ImplementationGenerationRun', entityId: run.id, metadata: { code } }); }
    return r;
  }
  async function recoverStale(projectId?: string) {
    const stale = (await repos.implementation.listStaleRuns(new Date(Date.now() - config.staleRunMs))).filter((r) => !projectId || r.projectId === projectId);
    for (const run of stale) await failRun(run, 'GENERATION_TIMED_OUT');
    return stale.length;
  }

  /** Task access: non-members get TASK_NOT_FOUND so existence is never leaked. */
  async function accessTask(ctx: RequestContext, taskId: string, access: 'read' | 'write') {
    const task = await repos.implementation.getTask(taskId);
    if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task not found.');
    try { const { project } = await requireProjectAccess(repos, ctx.userId, task.projectId, access); return { task, project }; }
    catch (e) { if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('TASK_NOT_FOUND', 'Task not found.'); throw e; }
  }
  const planOf = async (task: { planVersionId: string }) => (await repos.implementation.getVersion(task.planVersionId))!;

  return {
    config, recoverStale,

    async generate(ctx: RequestContext, projectId: string) {
      let { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      await recoverStale(project.id); project = (await repos.projects.findById(project.id))!;
      requireStatus(project, 'ARCHITECTURE_READY');
      const k = await loadProjectKnowledge(repos, project);
      if (k.plan?.architectureVersionId === k.architecture.id) throw new DomainError('INVALID_STATE', 'An implementation plan already exists for this architecture version.');
      const run = await repos.implementation.startGeneration({ projectId: project.id, architectureVersionId: k.architecture.id, userId: ctx.userId });
      if (!run) throw new DomainError('INVALID_STATE', 'Implementation planning is already in progress, or the project changed.');
      let jobId: string | null;
      try { jobId = await queue.enqueue(IMPLEMENTATION_JOB, { runId: run.id }, { singletonKey: run.id }); } catch (e) {
        logger.error({ runId: run.id, err: String(e) }, 'enqueue failed'); await failRun(run, 'ENQUEUE_FAILED'); throw new DomainError('INTERNAL_ERROR', SAFE.ENQUEUE_FAILED!);
      }
      if (jobId) await repos.implementation.attachJob(run.id, jobId);
      await event(project, ctx.userId, 'implementation_generation_started', { components: k.architecture.nodes.length });
      await audit(project, ctx.userId, 'implementation.generation_started', { entityType: 'ImplementationGenerationRun', entityId: run.id, requestId: ctx.requestId });
      return { jobId: jobId ?? run.id, generationRunId: run.id, status: 'QUEUED' as const };
    },

    async runGeneration(runId: string): Promise<{ outcome: 'SUCCEEDED' | 'FAILED' | 'ALREADY_DONE' | 'NOT_CLAIMED' | 'MISSING'; planVersionId?: string; created?: boolean; failureCode?: string }> {
      const existing = await repos.implementation.getRun(runId);
      if (!existing) return { outcome: 'MISSING' };
      if (existing.status === 'SUCCEEDED' || existing.status === 'FAILED') return { outcome: 'ALREADY_DONE', planVersionId: existing.planVersionId ?? undefined };
      const run = await repos.implementation.claimRun(runId, new Date(Date.now() - config.staleRunMs));
      if (!run) return { outcome: 'NOT_CLAIMED' };
      const project = await repos.projects.findById(run.projectId);
      if (!project || project.status !== 'ARCHITECTURE_READY') { await failRun(run, 'PROJECT_STATE_CHANGED'); return { outcome: 'FAILED', failureCode: 'PROJECT_STATE_CHANGED' }; }
      try {
        await repos.implementation.touchRun(run.id, { currentStage: 'LOADING_ARCHITECTURE' });
        const k = await loadProjectKnowledge(repos, project);
        if (k.architecture.id !== run.architectureVersionId) { await failRun(run, 'PROJECT_STATE_CHANGED'); return { outcome: 'FAILED', failureCode: 'PROJECT_STATE_CHANGED' }; }
        const { ctx, requirementTexts } = toImplContext(k);
        const input = toPlanInput(k, { workspaceId: project.workspaceId, projectId: project.id, userId: run.requestedById });
        const result = await runImplementationPipeline(ai, { input, ctx, requirementTexts }, config, { onStage: (s, r) => repos.implementation.touchRun(run.id, { currentStage: s, repairCount: r }) });
        await repos.implementation.touchRun(run.id, { currentStage: 'PERSISTING', repairCount: result.repairs });
        const decisionIdByKey = Object.fromEntries(k.architecture.decisions.map((d) => [d.key, d.id]));
        const saved = await repos.implementation.finalize({
          runId: run.id, projectId: project.id, architectureVersionId: k.architecture.id, plan: result.plan, issues: result.issues, decisionIdByKey, requirementIdByCode: k.codebook.requirementIdByCode,
          ai: { planner: result.ai.planner, critics: result.ai.critics, repairers: result.ai.repairers, repairs: result.repairs },
        });
        if (saved.created) {
          await event(project, run.requestedById, 'implementation_plan_generated', { phases: result.plan.phases.length, tasks: result.plan.tasks.length, repairs: result.repairs });
          await audit(project, run.requestedById, 'implementation.generated', { entityType: 'ImplementationPlanVersion', entityId: saved.planVersionId, metadata: { tasks: result.plan.tasks.length, repairs: result.repairs } });
        }
        return { outcome: 'SUCCEEDED', planVersionId: saved.planVersionId, created: saved.created };
      } catch (e) {
        let code = 'INTERNAL_ERROR'; let issues;
        if (e instanceof ImplPipelineError) { code = e.code; issues = e.issues; }
        else if (isAiError(e)) code = e.code;
        else if ((e as { code?: string })?.code === 'PROJECT_STATE_CHANGED') code = 'PROJECT_STATE_CHANGED';
        else logger.error({ runId, err: e instanceof Error ? { message: e.message, stack: e.stack } : String(e) }, 'implementation generation crashed');
        logger.warn({ runId, code }, 'implementation generation failed');
        await failRun(run, code, issues);
        return { outcome: 'FAILED', failureCode: code };
      }
    },

    async getOverview(ctx: RequestContext, projectId: string) {
      let { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      await recoverStale(project.id); project = (await repos.projects.findById(project.id))!;
      const run = await repos.implementation.getLatestRun(project.id);
      const available = project.status === 'ARCHITECTURE_READY' || project.status === 'IMPLEMENTING';
      const planRef = await repos.implementation.getPlanByProject(project.id);
      const plan = planRef?.currentVersionId ? await repos.implementation.getVersion(planRef.currentVersionId) : null;
      const arch = plan ? await repos.architecture.getVersion(plan.architectureVersionId) : null;
      const state: ImplementationState = !available ? 'NOT_AVAILABLE' : plan ? 'READY' : run && (run.status === 'QUEUED' || run.status === 'RUNNING') ? 'GENERATING' : run?.status === 'FAILED' ? 'FAILED' : 'NOT_STARTED';
      return { state, project: { id: project.id, name: project.name, status: project.status }, run: run ? toRunView(run) : null, plan: plan && arch ? buildPlanView(plan, arch) : null };
    },

    async getPlan(ctx: RequestContext, planVersionId: string) {
      const plan = await repos.implementation.getVersion(planVersionId);
      if (!plan) throw new DomainError('PLAN_NOT_FOUND', 'Implementation plan not found.');
      try { await requireProjectAccess(repos, ctx.userId, plan.projectId, 'read'); } catch (e) { if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('PLAN_NOT_FOUND', 'Implementation plan not found.'); throw e; }
      return buildPlanView(plan, (await repos.architecture.getVersion(plan.architectureVersionId))!);
    },

    async getJob(ctx: RequestContext, jobId: string) {
      const run = (await repos.implementation.getRunByJobId(jobId)) ?? (/^[0-9a-f-]{36}$/i.test(jobId) ? await repos.implementation.getRun(jobId) : null);
      if (!run) throw new DomainError('JOB_NOT_FOUND', 'Job not found.');
      try { await requireProjectAccess(repos, ctx.userId, run.projectId, 'read'); } catch (e) { if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('JOB_NOT_FOUND', 'Job not found.'); throw e; }
      await recoverStale(run.projectId);
      return toRunView((await repos.implementation.getRun(run.id))!);
    },

    /** The task workspace: the task plus everything that explains it, resolved from persisted links (no model call). */
    async getTask(ctx: RequestContext, taskId: string) {
      const { task, project } = await accessTask(ctx, taskId, 'read');
      const plan = await planOf(task);
      const arch = (await repos.architecture.getVersion(plan.architectureVersionId))!;
      const requirements = await repos.requirements.list(project.id);
      const codes = buildCodebook(requirements, [], []).requirementCodeById;
      const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
      const readiness = taskReadiness(plan.tasks.map(asProgress)).get(task.key)!;
      const lite = (t: TaskRecord) => ({ id: t.id, key: t.key, title: t.title, status: t.status });
      const unmet = task.dependsOn.map((d) => byKey.get(d)!).filter((d) => d.status !== 'COMPLETED' && d.status !== 'SKIPPED');
      const confirmed = task.validations.filter((v) => v.confirmed).length;
      return {
        projectId: project.id, planVersionId: plan.id, architectureVersionId: plan.architectureVersionId,
        phase: plan.phases.find((p) => p.id === task.phaseId)!, task: (({ requirementIds: _r, ...t }) => t)(task), readiness, events: task.events,
        dependencies: task.dependsOn.map((d) => lite(byKey.get(d)!)), dependents: plan.tasks.filter((t) => t.dependsOn.includes(task.key)).map(lite), unmetDependencies: unmet.map(lite),
        components: task.componentKeys.map((k) => arch.nodes.find((n) => n.stableKey === k)).filter(Boolean).map((n) => ({ stableKey: n!.stableKey, name: n!.name, technology: n!.technology, technologySlug: n!.technologySlug, category: n!.category })),
        decisions: arch.decisions.filter((d) => task.decisionKeys.includes(d.key)).map((d) => ({ key: d.key, title: d.title, status: d.status, decision: d.decision, rationale: d.rationale })),
        requirements: requirements.filter((r) => task.requirementIds.includes(r.id)).map((r) => ({ id: r.id, code: codes[r.id]!, statement: r.statement, category: r.category })),
        validation: { confirmed, total: task.validations.length, allConfirmed: task.validations.length > 0 && confirmed === task.validations.length },
        canStart: task.status === 'NOT_STARTED' && unmet.length === 0,
      };
    },

    /** Explicit transitions with history. Completing requires every validation step to be confirmed by the user; the system never claims it verified anything. */
    async updateStatus(ctx: RequestContext, taskId: string, input: { status: TaskStatus; reason?: string }) {
      const { task, project } = await accessTask(ctx, taskId, 'write');
      requireStatus(project, 'ARCHITECTURE_READY', 'IMPLEMENTING');
      if (!canTransitionTask(task.status, input.status)) throw new DomainError('INVALID_STATE', `A task that is ${task.status.replaceAll('_', ' ').toLowerCase()} cannot become ${input.status.replaceAll('_', ' ').toLowerCase()}.`, { from: task.status, to: input.status });
      if (input.status === 'IN_PROGRESS' && task.status === 'NOT_STARTED') {
        const plan = await planOf(task);
        const unmet = task.dependsOn.map((d) => plan.tasks.find((t) => t.key === d)!).filter((d) => d.status !== 'COMPLETED' && d.status !== 'SKIPPED');
        if (unmet.length) throw new DomainError('INVALID_STATE', `Finish these first: ${unmet.map((u) => u.title).join('; ')}.`, { unmetDependencies: unmet.map((u) => ({ key: u.key, title: u.title, status: u.status })) });
      }
      if (input.status === 'COMPLETED') {
        const missing = task.validations.filter((v) => !v.confirmed);
        if (missing.length) throw new DomainError('CONFIRMATION_BLOCKED', 'Confirm every validation step before completing this task.', { unconfirmed: missing.map((v) => ({ position: v.position, label: v.label })) });
      }
      const r = await repos.implementation.updateTaskStatus({ taskId, from: task.status, to: input.status, userId: ctx.userId, reason: input.reason });
      if (!r.ok) throw new DomainError('INVALID_STATE', 'The task changed while you were updating it. Refresh and try again.');
      await event(project, ctx.userId, `implementation_task_${input.status.toLowerCase()}`, { type: task.taskType });
      if (r.projectStarted) { await event(project, ctx.userId, 'implementation_started'); await audit(project, ctx.userId, 'implementation.started', { entityType: 'ImplementationTask', entityId: taskId }); }
      await audit(project, ctx.userId, 'task.status_changed', { entityType: 'ImplementationTask', entityId: taskId, requestId: ctx.requestId, metadata: { from: task.status, to: input.status } });
      return this.getTask(ctx, taskId);
    },

    /** Records the user's own confirmation of validation steps. Never SYSTEM_VERIFIED: Pitch2Plan does not check external systems yet. */
    async confirmValidation(ctx: RequestContext, taskId: string, confirmations: Array<{ position: number; confirmed: boolean }>) {
      const { task, project } = await accessTask(ctx, taskId, 'write');
      requireStatus(project, 'ARCHITECTURE_READY', 'IMPLEMENTING');
      if (task.status !== 'IN_PROGRESS') throw new DomainError('INVALID_STATE', 'Start the task before confirming its validation steps.');
      const valid = new Set(task.validations.map((v) => v.position));
      const bad = confirmations.filter((c) => !valid.has(c.position));
      if (bad.length) throw new DomainError('VALIDATION_ERROR', 'Unknown validation step.', { positions: bad.map((b) => b.position) });
      const rows = await repos.implementation.setValidations({ taskId, userId: ctx.userId, confirmations });
      await audit(project, ctx.userId, 'task.validation_confirmed', { entityType: 'ImplementationTask', entityId: taskId, metadata: { confirmed: rows.filter((r) => r.confirmed).length, total: rows.length } });
      return { validations: rows, allConfirmed: rows.length > 0 && rows.every((r) => r.confirmed) };
    },

    async updateStep(ctx: RequestContext, taskId: string, stepId: string, status: 'NOT_STARTED' | 'COMPLETED') {
      const { task, project } = await accessTask(ctx, taskId, 'write');
      requireStatus(project, 'ARCHITECTURE_READY', 'IMPLEMENTING');
      if (task.status !== 'IN_PROGRESS') throw new DomainError('INVALID_STATE', 'Start the task before marking its steps.');
      if (!(await repos.implementation.updateStepStatus({ taskId, stepId, status }))) throw new DomainError('TASK_NOT_FOUND', 'Step not found.');
      return { stepId, status };
    },

    /** "Open Implementation Workspace" for a component: architecture facts, then the tasks and AI guidance that implement it. */
    async getComponent(ctx: RequestContext, projectId: string, stableKey: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      const k = await loadProjectKnowledge(repos, project);
      const node = k.architecture.nodes.find((n) => n.stableKey === stableKey);
      if (!node) throw new DomainError('NODE_NOT_FOUND', 'Component not found in this architecture.');
      const cb = k.codebook; const names = new Map(k.architecture.nodes.map((n) => [n.stableKey, n]));
      const decisions = k.architecture.decisions.filter((d) => d.nodeStableKeys.includes(stableKey)).map((d) => ({ key: d.key, title: d.title, status: d.status, decision: d.decision, rationale: d.rationale, tradeoffs: d.tradeoffs,
        driverCodes: d.driverIds.map((id) => cb.driverCodeById[id]).filter(Boolean).sort(), requirementCodes: d.requirementIds.map((id) => cb.requirementCodeById[id]).filter(Boolean).sort() }));
      const dCodes = new Set(decisions.flatMap((d) => d.driverCodes)), rCodes = new Set(decisions.flatMap((d) => d.requirementCodes));
      const drivers = k.drivers.filter((d) => dCodes.has(cb.driverCodeById[d.id]!)).map((d) => ({ code: cb.driverCodeById[d.id]!, name: d.name, description: d.description, priority: d.priority }));
      for (const d of k.drivers) if (dCodes.has(cb.driverCodeById[d.id]!)) d.requirementIds.forEach((id) => rCodes.add(cb.requirementCodeById[id]!));
      const requirements = k.requirements.filter((r) => rCodes.has(cb.requirementCodeById[r.id]!)).map((r) => ({ code: cb.requirementCodeById[r.id]!, statement: r.statement, category: r.category }));
      const conn = (e: (typeof k.architecture.edges)[number], other: string, dir: 'in' | 'out') => ({ direction: dir, edgeKey: e.edgeKey, label: e.label, protocol: e.protocol, communicationType: e.communicationType, dataDescription: e.dataDescription, encrypted: e.encrypted, component: { stableKey: other, name: names.get(other)?.name ?? other, technology: names.get(other)?.technology ?? '' } });
      const connections = [...k.architecture.edges.filter((e) => e.targetStableKey === stableKey).map((e) => conn(e, e.sourceStableKey, 'in')), ...k.architecture.edges.filter((e) => e.sourceStableKey === stableKey).map((e) => conn(e, e.targetStableKey, 'out'))];
      const plan = k.plan; const view = plan ? buildPlanView(plan, k.architecture) : null;
      const own = view ? view.tasks.filter((t) => t.componentKeys.includes(stableKey)) : [];
      const ownFull = plan ? plan.tasks.filter((t) => t.componentKeys.includes(stableKey)) : [];
      // What to do next for this component: work in progress, else something ready, else the earliest unfinished task (it is waiting on prerequisites, and says so).
      const current = own.find((t) => t.status === 'IN_PROGRESS') ?? own.find((t) => t.readiness === 'READY') ?? own.find((t) => t.status !== 'COMPLETED' && t.status !== 'SKIPPED') ?? null;
      const uniq = <T,>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];
      return {
        project: { id: project.id, name: project.name, status: project.status }, architectureVersionId: k.architecture.id,
        // ARCHITECTURE FACTS: what the architecture says. Persisted, versioned, traceable.
        facts: { component: { stableKey: node.stableKey, name: node.name, technology: node.technology, technologySlug: node.technologySlug, category: node.category, purpose: node.purpose, description: node.description, criticality: node.criticality, provider: node.provider, managedService: node.managedService, deploymentModel: node.deploymentModel },
          configuration: node.configuration, risks: [...node.risks, ...k.architecture.risks.filter((r) => r.nodeStableKeys.includes(stableKey)).map((r) => r.text)], alternatives: node.alternatives, connections, decisions, drivers, requirements },
        // AI GUIDANCE: suggested by the planner while it was reviewed; helpful, but never architecture and never applied automatically.
        guidance: {
          operationalNotes: uniq(ownFull.flatMap((t) => t.operationalNotes), (x) => x), securityNotes: uniq(ownFull.flatMap((t) => t.securityNotes), (x) => x),
          commonIssues: uniq(ownFull.flatMap((t) => t.commonProblems), (x) => x.problem), references: uniq(ownFull.flatMap((t) => t.references), (x) => x.url),
          monitoring: own.filter((t) => t.taskType === 'OBSERVABILITY').map((t) => ({ id: t.id, title: t.title, status: t.status })),
        },
        implementation: {
          hasPlan: !!plan, tasks: own, currentTask: current, remaining: own.filter((t) => t.status !== 'COMPLETED' && t.status !== 'SKIPPED').length,
          progress: view?.progress.byComponent[stableKey] ?? null, dependsOnComponents: [...new Set(ownFull.flatMap((t) => t.dependsOn).map((d) => plan!.tasks.find((x) => x.key === d)).filter((d) => d && !d.componentKeys.includes(stableKey)).flatMap((d) => d!.componentKeys))].map((key) => ({ stableKey: key, name: names.get(key)?.name ?? key })),
          coverage: view?.coverage.components.find((c) => c.stableKey === stableKey) ?? null,
        },
      };
    },

    async getTasksForDecision(ctx: RequestContext, projectId: string, decisionKey: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      const k = await loadProjectKnowledge(repos, project);
      const decision = k.architecture.decisions.find((d) => d.key === decisionKey);
      if (!decision) throw new DomainError('NODE_NOT_FOUND', 'Decision not found.');
      const view = k.plan ? buildPlanView(k.plan, k.architecture) : null;
      return { decision: { key: decision.key, title: decision.title, status: decision.status }, tasks: view ? view.tasks.filter((t) => t.decisionKeys.includes(decisionKey)) : [] };
    },
  };
}
export type ImplementationService = ReturnType<typeof createImplementationService>;
export type { ProjectRecord, ProjectKnowledge };
