import {
  applyChangeOperations, canTransitionProposal, classifyTaskImpact, deterministicReview, diffArchitectures, analyzeNodeFailure, impactSeverity, mapTasksAcrossPlans, requiresReconfirmation, validateChangeAnalysis,
  type ArchitectureDiff, type ArchitecturePlan, type ChangeAnalysis, type ChangeOperation, type DiffInput, type IssueCategory, type MigItem, type ProposalState, type ReviewFindingDraft, type TaskFact,
} from '@pitch2plan/schemas';
import { requireProjectAccess } from './authorization';
import { DEFAULT_PIPELINE_CONFIG, PipelineError, runArchitecturePipeline } from './architecture-pipeline';
import { buildCodebook, buildPlanInput, type Codebook } from './architecture-codes';
import { deriveBriefForChanges } from './derive-brief';
import type { RequestContext } from './discovery';
import { DomainError } from './errors';
import type { ImplementationService } from './implementation';
import { loadProjectKnowledge, toPlanInput, type ProjectKnowledge } from './implementation-context';
import type { Logger } from './logger';
import {
  CHANGE_ANALYZE_JOB, CHANGE_APPLY_JOB, type ArchitectureAiPort, type ArchitectureVersionRecord, type ChangeAiPort, type ImpactItemRecord, type JobQueue, type ProposalRecord, type Repositories, type RequirementApplication,
} from './ports';
import { isAiError, requireStatus } from './shared';

export interface ChangeConfig { staleRunMs: number; maxRepairs: number; repairHighCategories: IssueCategory[] }
export const DEFAULT_CHANGE_CONFIG: ChangeConfig = { staleRunMs: 10 * 60_000, maxRepairs: DEFAULT_PIPELINE_CONFIG.maxRepairs, repairHighCategories: DEFAULT_PIPELINE_CONFIG.repairHighCategories };

const SAFE: Record<string, string> = {
  AI_OUTPUT_INVALID: 'The AI’s result did not pass our validation checks.', AI_TIMEOUT: 'The AI service took too long to respond.', AI_PROVIDER_ERROR: 'The AI service is temporarily unavailable.',
  ENQUEUE_FAILED: 'We could not start the background work.', GENERATION_TIMED_OUT: 'The work did not finish in time.', PROPOSAL_STATE_CHANGED: 'The proposal or the architecture changed while it was being processed, so nothing was applied.',
  CHANGE_OUT_OF_SCOPE: 'The planned change went beyond what you approved, so it was not applied.', REQUIREMENT_CHANGE_INVALID: 'The approved requirement changes could not be applied consistently.',
  ARCHITECTURE_VALIDATION_FAILED: 'We could not produce a new architecture version that passed all checks, even after repair attempts.', STALE_BASE: 'The architecture changed since this proposal was made.',
  INTERNAL_ERROR: 'Something went wrong on our side while processing the change.',
};
const OPEN: ProposalState[] = ['DRAFT', 'ANALYZING', 'READY_FOR_REVIEW', 'FAILED'];
const SEV = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;

export const versionToDiffInput = (v: ArchitectureVersionRecord): DiffInput => ({
  nodes: v.nodes.map((n) => ({ stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: n.category, purpose: n.purpose, description: n.description, criticality: n.criticality, managedService: n.managedService, provider: n.provider, deploymentModel: n.deploymentModel, configuration: n.configuration, replacesStableKey: n.replacesStableKey })),
  edges: v.edges.map((e) => ({ edgeKey: e.edgeKey, sourceStableKey: e.sourceStableKey, targetStableKey: e.targetStableKey, label: e.label, protocol: e.protocol, communicationType: e.communicationType, dataDescription: e.dataDescription, synchronous: e.synchronous, encrypted: e.encrypted, criticality: e.criticality })),
  decisions: v.decisions.map((d) => ({ key: d.key, title: d.title, decision: d.decision, rationale: d.rationale, status: d.status, nodeStableKeys: d.nodeStableKeys, supersedesKey: d.supersedesKey })),
});
export const planToDiffInput = (p: ArchitecturePlan): DiffInput => ({
  nodes: p.nodes.map((n) => ({ ...n })), edges: p.edges.map((e) => ({ edgeKey: e.id, sourceStableKey: e.sourceStableKey, targetStableKey: e.targetStableKey, label: e.label, protocol: e.protocol, communicationType: e.communicationType, dataDescription: e.dataDescription, synchronous: e.synchronous, encrypted: e.encrypted, criticality: e.criticality })),
  decisions: p.decisions.map((d) => ({ key: d.key, title: d.title, decision: d.decision, rationale: d.rationale, status: d.status, nodeStableKeys: d.nodeStableKeys, supersedesKey: d.supersedesKey })),
});
/** The stored version, rebuilt as the plan shape the change operations work on. Codes come from the codebook of the brief the version was made from. */
export function versionToPlan(v: ArchitectureVersionRecord, cb: Codebook): ArchitecturePlan {
  const code = (ids: string[], m: Record<string, string>) => ids.map((i) => m[i]).filter((c): c is string => !!c).sort();
  return {
    summary: v.summary, assumptions: v.assumptions, unresolvedQuestions: v.unresolvedQuestions, risks: v.risks,
    nodes: v.nodes.map((n) => ({ stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: n.category, purpose: n.purpose, description: n.description, criticality: n.criticality, managedService: n.managedService,
      deploymentModel: n.deploymentModel as never, provider: n.provider, configuration: n.configuration, risks: n.risks, alternatives: n.alternatives, replacesStableKey: n.replacesStableKey })),
    edges: v.edges.map((e) => ({ id: e.edgeKey, sourceStableKey: e.sourceStableKey, targetStableKey: e.targetStableKey, label: e.label, protocol: e.protocol, communicationType: e.communicationType as never, dataDescription: e.dataDescription, synchronous: e.synchronous, criticality: e.criticality, encrypted: e.encrypted })),
    decisions: v.decisions.map((d) => ({ key: d.key, title: d.title, problem: d.problem, decision: d.decision, rationale: d.rationale, status: d.status === 'PROPOSED' ? 'PROPOSED' as const : 'ACCEPTED' as const, confidence: d.confidence, tradeoffs: d.tradeoffs, risks: d.risks, alternatives: d.alternatives, consequences: d.consequences,
      driverCodes: code(d.driverIds, cb.driverCodeById), requirementCodes: code(d.requirementIds, cb.requirementCodeById), nodeStableKeys: d.nodeStableKeys, edgeIds: d.edgeKeys, supersedesKey: null })),
  };
}
const failureGraph = (v: ArchitectureVersionRecord) => ({
  nodes: v.nodes.map((n) => ({ stableKey: n.stableKey, name: n.name, category: n.category, criticality: n.criticality, managedService: n.managedService, provider: n.provider, configuration: n.configuration })),
  edges: v.edges.map((e) => ({ edgeKey: e.edgeKey, sourceStableKey: e.sourceStableKey, targetStableKey: e.targetStableKey, communicationType: e.communicationType, synchronous: e.synchronous })),
  decisions: v.decisions.map((d) => ({ key: d.key, title: d.title, decision: d.decision, rationale: d.rationale, nodeStableKeys: d.nodeStableKeys })),
});
const nodeKeysOfOps = (ops: ChangeOperation[]) => ops.flatMap((o) => (o.op === 'REPLACE_NODE' || o.op === 'UPDATE_NODE' || o.op === 'REMOVE_NODE' ? [o.stableKey] : []));

export function createChangeService(deps: { repos: Repositories; ai: ChangeAiPort; architectureAi: ArchitectureAiPort; implementation: ImplementationService; queue: JobQueue; logger: Logger; config: ChangeConfig }) {
  const { repos, ai, architectureAi, implementation, queue, logger, config } = deps;
  const audit = (p: { workspaceId: string; id: string }, actorId: string | undefined, action: string, extra: { entityId?: string; metadata?: Record<string, unknown> } = {}) =>
    repos.audit.record({ workspaceId: p.workspaceId, projectId: p.id, actorId, action, entityType: 'ArchitectureChangeProposal', ...extra });
  const event = (p: { workspaceId: string; id: string }, userId: string | undefined, name: string, properties?: Record<string, string | number | boolean | null>) =>
    repos.analytics.record({ workspaceId: p.workspaceId, projectId: p.id, userId, name, properties }).catch((e) => logger.error({ name, err: String(e) }, 'analytics failed'));

  async function accessProposal(ctx: RequestContext, id: string, access: 'read' | 'write') {
    const proposal = await repos.changes.get(id);
    if (!proposal) throw new DomainError('PROPOSAL_NOT_FOUND', 'Change proposal not found.');
    try { const { project } = await requireProjectAccess(repos, ctx.userId, proposal.projectId, access); return { proposal, project }; }
    catch (e) { if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('PROPOSAL_NOT_FOUND', 'Change proposal not found.'); throw e; }
  }
  const currentVersion = async (projectId: string) => {
    const a = await repos.architecture.getByProject(projectId);
    const v = a?.currentVersionId ? await repos.architecture.getVersion(a.currentVersionId) : null;
    if (!v || v.status !== 'READY') throw new DomainError('INVALID_STATE', 'This project has no ready architecture to change.');
    return v;
  };
  const transition = (from: ProposalState, to: ProposalState) => { if (!canTransitionProposal(from, to)) throw new DomainError('INVALID_STATE', `A proposal that is ${from.replaceAll('_', ' ').toLowerCase()} cannot become ${to.replaceAll('_', ' ').toLowerCase()}.`, { from, to }); };

  async function view(p: ProposalRecord) {
    const current = await currentVersion(p.projectId).catch(() => null);
    const versions = await repos.architecture.listVersions(p.projectId);
    const num = (id: string | null) => versions.find((v) => v.id === id)?.versionNumber ?? null;
    const stale = p.status === 'STALE' || (OPEN.includes(p.status) && !!current && p.baseVersionId !== current.id);
    const all = await repos.changes.list(p.projectId);
    const planRef = await repos.implementation.getPlanByProject(p.projectId);
    const plan = planRef?.currentVersionId ? await repos.implementation.getVersion(planRef.currentVersionId) : null;
    const tasks = new Map((plan?.tasks ?? []).map((t) => [t.id, t]));
    const workAtRisk = p.impactItems.filter((i) => i.kind === 'TASK' && i.taskId && tasks.has(i.taskId)).map((i) => { const t = tasks.get(i.taskId!)!; return { taskId: t.id, key: t.key, title: t.title, status: t.status, relation: i.relation, reason: i.reason }; });
    return {
      proposal: { ...p, status: (stale && OPEN.includes(p.status) ? 'STALE' : p.status) as ProposalState },
      baseVersionNumber: num(p.baseVersionId), currentVersionNumber: current?.versionNumber ?? null, isStale: stale, resultVersion: p.resultVersionId ? { id: p.resultVersionId, versionNumber: num(p.resultVersionId) } : null,
      successorId: all.find((x) => x.rebasedFromId === p.id)?.id ?? null,
      impact: { nodes: p.impactItems.filter((i) => i.kind === 'NODE'), edges: p.impactItems.filter((i) => i.kind === 'EDGE'), decisions: p.impactItems.filter((i) => i.kind === 'DECISION'), drivers: p.impactItems.filter((i) => i.kind === 'DRIVER'), requirements: p.impactItems.filter((i) => i.kind === 'REQUIREMENT'), tasks: p.impactItems.filter((i) => i.kind === 'TASK') },
      workAtRisk: { tasks: workAtRisk, completed: workAtRisk.filter((t) => t.status === 'COMPLETED').length, inProgress: workAtRisk.filter((t) => t.status === 'IN_PROGRESS').length, notStarted: workAtRisk.filter((t) => t.status === 'NOT_STARTED').length },
      canApprove: p.status === 'READY_FOR_REVIEW' && !stale, canEdit: ['DRAFT', 'READY_FOR_REVIEW', 'FAILED'].includes(p.status) && !p.approval && !stale, canRebase: stale && p.status !== 'REJECTED' && p.status !== 'APPLIED',
    };
  }
  const requirementsAndDrivers = async (k: ProjectKnowledge, ctx: { workspaceId: string; projectId: string; userId: string }) => { const i = toPlanInput(k, ctx); return { architecture: i.architecture, requirements: i.requirements, drivers: i.drivers }; };

  async function startAnalysisJob(project: { workspaceId: string; id: string }, id: string) {
    let jobId: string | null;
    try { jobId = await queue.enqueue(CHANGE_ANALYZE_JOB, { runId: id }, { singletonKey: `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` }); } catch (e) {
      logger.error({ proposalId: id, err: String(e) }, 'enqueue failed'); await repos.changes.failAnalysis({ id, code: 'ENQUEUE_FAILED', message: SAFE.ENQUEUE_FAILED! }); throw new DomainError('INTERNAL_ERROR', SAFE.ENQUEUE_FAILED!);
    }
    return jobId;
  }

  async function failApplication(runId: string, code: string, issues?: Parameters<Repositories['changes']['failApply']>[0]['issues']) {
    const failed = await repos.changes.failApply({ runId, code, message: SAFE[code] ?? SAFE.INTERNAL_ERROR!, issues });
    const prop = await repos.changes.getByRun(runId); const project = prop ? await repos.projects.findById(prop.projectId) : null;
    if (failed && project && prop) { await event(project, undefined, 'change_application_failed', { code }); await audit(project, undefined, 'change.application_failed', { entityId: prop.id, metadata: { code } }); }
    return failed;
  }
  /** A proposal whose worker vanished must never stay ANALYZING or APPLYING forever. */
  async function recoverStale(projectId?: string) {
    const before = new Date(Date.now() - config.staleRunMs); let n = 0;
    for (const p of await repos.changes.listStaleAnalyses(before)) if (!projectId || p.projectId === projectId) { if (await repos.changes.failAnalysis({ id: p.id, code: 'GENERATION_TIMED_OUT', message: SAFE.GENERATION_TIMED_OUT! })) n++; }
    for (const r of (await repos.architecture.listStaleRuns(before)).filter((x) => x.mode === 'CHANGE' && (!projectId || x.projectId === projectId))) { if (await failApplication(r.id, 'GENERATION_TIMED_OUT')) n++; }
    return n;
  }

  return {
    config, recoverStale,

    async create(ctx: RequestContext, projectId: string, input: { requestedChange: string; reason?: string; source: 'USER_REQUEST' | 'ASSISTANT_RECOMMENDATION' | 'ARCHITECTURE_REVIEW'; assistantConversationId?: string; assistantMessageId?: string; reviewFindingId?: string }) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'ARCHITECTURE_READY', 'IMPLEMENTING');
      const base = await currentVersion(project.id);
      if (input.source === 'ASSISTANT_RECOMMENDATION') {
        if (!input.assistantConversationId || !input.assistantMessageId) throw new DomainError('VALIDATION_ERROR', 'An assistant recommendation must reference the conversation and message it came from.');
        const convo = await repos.conversations.get(input.assistantConversationId);
        if (!convo || convo.createdById !== ctx.userId || convo.projectId !== project.id) throw new DomainError('VALIDATION_ERROR', 'That conversation is not available.');
        const msg = (await repos.conversations.list(convo.id, 100)).find((m) => m.id === input.assistantMessageId);
        if (!msg || msg.role !== 'ASSISTANT' || !msg.structured?.needsArchitectureChange) throw new DomainError('VALIDATION_ERROR', 'That assistant message did not recommend an architecture change.');
      }
      if (input.source === 'ARCHITECTURE_REVIEW') {
        const f = input.reviewFindingId ? await repos.reviews.getFinding(input.reviewFindingId) : null;
        if (!f || f.projectId !== project.id) throw new DomainError('VALIDATION_ERROR', 'That review finding is not available.');
      }
      const p = await repos.changes.create({ projectId: project.id, baseVersionId: base.id, source: input.source, requestedChange: input.requestedChange, reason: input.reason, assistantConversationId: input.assistantConversationId, assistantMessageId: input.assistantMessageId, reviewFindingId: input.reviewFindingId, userId: ctx.userId });
      await event(project, ctx.userId, 'change_proposal_created', { source: input.source });
      await audit(project, ctx.userId, 'change.proposal_created', { entityId: p.id, metadata: { source: input.source, baseVersion: base.versionNumber } });
      return view(p);
    },

    async list(ctx: RequestContext, projectId: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      const current = await currentVersion(project.id).catch(() => null);
      if (current) await repos.changes.markStale(project.id, current.id);
      await recoverStale(project.id);
      const versions = await repos.architecture.listVersions(project.id);
      return (await repos.changes.list(project.id)).map((p) => ({ id: p.id, status: p.status, source: p.source, requestedChange: p.requestedChange, severity: p.severity, changeType: p.changeType, baseVersionNumber: versions.find((v) => v.id === p.baseVersionId)?.versionNumber ?? null, createdAt: p.createdAt, requiresReconfirmation: p.requiresReconfirmation, resultVersionId: p.resultVersionId }));
    },

    async get(ctx: RequestContext, id: string) {
      const { project } = await accessProposal(ctx, id, 'read');
      const current = await currentVersion(project.id).catch(() => null);
      if (current) await repos.changes.markStale(project.id, current.id);
      await recoverStale(project.id);
      return view((await repos.changes.get(id))!);
    },

    async edit(ctx: RequestContext, id: string, input: { requestedChange: string; reason?: string }) {
      const { proposal, project } = await accessProposal(ctx, id, 'write');
      if (proposal.approval) throw new DomainError('INVALID_STATE', 'An approved or rejected proposal cannot be edited. Create a new one.');
      transition(proposal.status, 'DRAFT');
      if (!(await repos.changes.edit({ id, requestedChange: input.requestedChange, reason: input.reason ?? null }))) throw new DomainError('INVALID_STATE', 'This proposal can no longer be edited.');
      await audit(project, ctx.userId, 'change.proposal_edited', { entityId: id });
      return view((await repos.changes.get(id))!);
    },

    async analyze(ctx: RequestContext, id: string) {
      const { proposal, project } = await accessProposal(ctx, id, 'write');
      const current = await currentVersion(project.id); await repos.changes.markStale(project.id, current.id);
      if (proposal.baseVersionId !== current.id) throw new DomainError('STALE_PROPOSAL', 'The architecture changed since this proposal was made. Rebase it against the current version.');
      if (proposal.approval) throw new DomainError('INVALID_STATE', 'This proposal was already decided.');
      transition(proposal.status, 'ANALYZING');
      if (!(await repos.changes.startAnalysis(id))) throw new DomainError('INVALID_STATE', 'This proposal cannot be analysed right now.');
      await startAnalysisJob(project, id);
      await audit(project, ctx.userId, 'change.proposal_analysis_started', { entityId: id });
      return view((await repos.changes.get(id))!);
    },

    async runAnalysis(proposalId: string): Promise<{ outcome: 'READY' | 'FAILED' | 'STALE' | 'NOT_CLAIMED' | 'MISSING'; failureCode?: string }> {
      const existing = await repos.changes.get(proposalId); if (!existing) return { outcome: 'MISSING' };
      const p = await repos.changes.claimAnalysis(proposalId, new Date(Date.now() - config.staleRunMs)); if (!p) return { outcome: 'NOT_CLAIMED' };
      const project = await repos.projects.findById(p.projectId);
      const fail = async (code: string) => { await repos.changes.failAnalysis({ id: p.id, code, message: SAFE[code] ?? SAFE.INTERNAL_ERROR! }); if (project) await audit(project, undefined, 'change.proposal_analysis_failed', { entityId: p.id, metadata: { code } }); return { outcome: 'FAILED' as const, failureCode: code }; };
      try {
        if (!project || (project.status !== 'ARCHITECTURE_READY' && project.status !== 'IMPLEMENTING')) return fail('PROPOSAL_STATE_CHANGED');
        const k = await loadProjectKnowledge(repos, project);
        if (k.architecture.id !== p.baseVersionId) { await repos.changes.markStale(project.id, k.architecture.id); return { outcome: 'STALE' }; }
        const context = { workspaceId: project.workspaceId, projectId: project.id, userId: p.createdById };
        const base = await requirementsAndDrivers(k, context); const plan = k.plan && k.plan.architectureVersionId === k.architecture.id ? k.plan : null;
        const out = await ai.analyze({ context, requestedChange: p.requestedChange, reason: p.reason, ...base,
          plan: plan ? { versionNumber: plan.versionNumber, progress: { completed: plan.tasks.filter((t) => t.status === 'COMPLETED').length, applicable: plan.tasks.filter((t) => t.status !== 'SKIPPED').length }, tasks: plan.tasks.map((t) => ({ key: t.key, title: t.title, status: t.status, taskType: t.taskType, componentKeys: t.componentKeys, decisionKeys: t.decisionKeys })) } : null });
        const a: ChangeAnalysis = out.output;
        // --- deterministic enrichment: the model names what is affected; the graph and the plan say what that means for work already done.
        const items: ImpactItemRecord[] = []; const add = (i: ImpactItemRecord) => { if (!items.some((x) => x.kind === i.kind && x.refKey === i.refKey)) items.push(i); };
        for (const x of a.affectedNodes) add({ kind: 'NODE', refKey: x.key, relation: x.relation, reason: x.reason, taskId: null });
        for (const x of a.affectedEdges) add({ kind: 'EDGE', refKey: x.key, relation: x.relation, reason: x.reason, taskId: null });
        for (const x of a.affectedDecisions) add({ kind: 'DECISION', refKey: x.key, relation: x.relation, reason: x.reason, taskId: null });
        for (const x of a.affectedDrivers) add({ kind: 'DRIVER', refKey: x.key, relation: x.relation, reason: x.reason, taskId: null });
        for (const x of a.affectedRequirements) add({ kind: 'REQUIREMENT', refKey: x.key, relation: x.relation, reason: x.reason, taskId: null });
        // Requirements are derived from STORED links, not from the model's say-so: what each affected decision serves, and what stands behind each affected driver.
        const driversByCode = new Map(k.drivers.map((d) => [k.codebook.driverCodeById[d.id], d]));
        for (const x of a.affectedDecisions) { const d = base.architecture.decisions.find((y) => y.key === x.key); for (const rc of d?.requirementCodes ?? []) add({ kind: 'REQUIREMENT', refKey: rc, relation: 'POTENTIAL', reason: `Served by ${x.key.toUpperCase()}, which is affected`, taskId: null }); }
        for (const x of a.affectedDrivers) for (const rid of driversByCode.get(x.key)?.requirementIds ?? []) { const rc = k.codebook.requirementCodeById[rid]; if (rc) add({ kind: 'REQUIREMENT', refKey: rc, relation: 'POTENTIAL', reason: `Behind driver ${x.key}, which is affected`, taskId: null }); }
        const direct = a.affectedNodes.filter((n) => n.relation === 'DIRECT').map((n) => n.key); const edges = base.architecture.edges.map((e) => ({ source: e.source, target: e.target }));
        const names = new Map(base.architecture.nodes.map((n) => [n.stableKey, n.name]));
        for (const e of edges) { for (const [self, other] of [[e.source, e.target], [e.target, e.source]] as const) if (direct.includes(self) && !direct.includes(other)) add({ kind: 'NODE', refKey: other, relation: 'POTENTIAL', reason: `Connected to ${names.get(self) ?? self}`, taskId: null }); }
        const facts: TaskFact[] = (plan?.tasks ?? []).map((t) => ({ id: t.id, key: t.key, title: t.title, status: t.status, taskType: t.taskType, componentKeys: t.componentKeys, decisionKeys: t.decisionKeys }));
        const cls = classifyTaskImpact(facts, edges, direct, a.affectedDecisions.filter((d) => d.relation === 'DIRECT').map((d) => d.key));
        for (const i of cls.items) add({ kind: 'TASK', refKey: i.task.key, relation: i.relation, reason: `${i.task.status.replaceAll('_', ' ').toLowerCase()}: ${i.task.title}`, taskId: i.task.id });
        for (const t of a.affectedTasks) { const f = facts.find((x) => x.key === t.key); if (f) add({ kind: 'TASK', refKey: f.key, relation: t.relation, reason: t.reason, taskId: f.id }); }
        const severity = impactSeverity(a, { completedTasksAtRisk: items.filter((i) => i.kind === 'TASK' && facts.find((f) => f.key === i.refKey)?.status === 'COMPLETED').length, directNodes: direct.length });
        const saved = await repos.changes.saveAnalysis({ id: p.id, analysis: a, ai: out.ai as unknown as Record<string, unknown>, severity, requiresReconfirmation: requiresReconfirmation(a), requirementChanges: a.requirementChanges, items });
        if (!saved) return { outcome: 'STALE' };
        await event(project, p.createdById, 'change_proposal_analyzed', { changeType: a.changeType, severity, completedAtRisk: cls.completedAtRisk.length });
        await audit(project, undefined, 'change.proposal_analyzed', { entityId: p.id, metadata: { changeType: a.changeType, severity } });
        return { outcome: 'READY' };
      } catch (e) {
        const code = isAiError(e) ? e.code : 'INTERNAL_ERROR';
        if (code === 'INTERNAL_ERROR') logger.error({ proposalId, err: e instanceof Error ? { message: e.message, stack: e.stack } : String(e) }, 'change analysis crashed');
        return fail(code);
      }
    },

    /** The human decision. There is no code path from the assistant or the AI to this method: it needs a signed-in person's request. */
    async approve(ctx: RequestContext, id: string, input: { confirmRequirementChanges: boolean; note?: string }) {
      const { proposal, project } = await accessProposal(ctx, id, 'write');
      requireStatus(project, 'ARCHITECTURE_READY', 'IMPLEMENTING');
      const current = await currentVersion(project.id); await repos.changes.markStale(project.id, current.id);
      if (proposal.baseVersionId !== current.id || proposal.status === 'STALE') throw new DomainError('STALE_PROPOSAL', 'The architecture changed since this proposal was made. Rebase it against the current version before approving.');
      if (proposal.status !== 'READY_FOR_REVIEW' || !proposal.analysis) throw new DomainError('INVALID_STATE', proposal.approval ? 'This proposal was already decided.' : 'This proposal is not ready for review.');
      transition(proposal.status, 'APPROVED');
      if (proposal.requiresReconfirmation && !input.confirmRequirementChanges) throw new DomainError('CONFIRMATION_BLOCKED', 'This change alters your requirements. Review the requirement changes and confirm them to approve.', { requirementChanges: proposal.requirementChanges });
      let requirementApplication: RequirementApplication | undefined;
      if (proposal.requirementChanges.length) {
        const baseBrief = await repos.briefs.getVersion(current.briefVersionId); if (!baseBrief) throw new DomainError('BRIEF_NOT_FOUND', 'The confirmed brief could not be found.');
        const cb = buildCodebook(await repos.requirements.list(project.id), baseBrief.content.architectureDrivers.map((d) => d.id), await repos.briefs.listDrivers(baseBrief.id));
        const d = deriveBriefForChanges({ brief: baseBrief.content, changes: proposal.requirementChanges, requirementIdByCode: cb.requirementIdByCode, reason: proposal.reason ?? proposal.requestedChange });
        if (d.errors.length) throw new DomainError('VALIDATION_ERROR', SAFE.REQUIREMENT_CHANGE_INVALID!, { errors: d.errors });
        requirementApplication = { ops: d.ops, brief: { content: d.content, ai: { promptId: 'DERIVED_BRIEF', promptVersion: 1, provider: 'system', model: 'deterministic', repaired: false }, drivers: d.drivers } };
      }
      const r = await repos.changes.approve({ id, userId: ctx.userId, note: input.note ?? null, confirmedRequirementChanges: input.confirmRequirementChanges, requirementApplication });
      if (r.result !== 'OK') throw r.result === 'STALE' ? new DomainError('STALE_PROPOSAL', 'The architecture changed while you were approving. Rebase the proposal and review it again.') : new DomainError('INVALID_STATE', 'This proposal was already decided, or another change is being applied.');
      await audit(project, ctx.userId, 'change.proposal_approved', { entityId: id, metadata: { architectureVersion: current.versionNumber, requirementChanges: proposal.requirementChanges.length } });
      if (proposal.requirementChanges.length) await audit(project, ctx.userId, 'change.requirements_reconfirmed', { entityId: id, metadata: { count: proposal.requirementChanges.length } });
      await event(project, ctx.userId, 'change_proposal_approved', { severity: proposal.severity ?? null });
      try {
        const jobId = await queue.enqueue(CHANGE_APPLY_JOB, { runId: r.run.id }, { singletonKey: r.run.id });
        if (jobId) await repos.architecture.attachJob(r.run.id, jobId);
      } catch (e) { logger.error({ runId: r.run.id, err: String(e) }, 'enqueue failed'); await failApplication(r.run.id, 'ENQUEUE_FAILED'); throw new DomainError('INTERNAL_ERROR', SAFE.ENQUEUE_FAILED!); }
      return view((await repos.changes.get(id))!);
    },

    async reject(ctx: RequestContext, id: string, input: { note?: string }) {
      const { proposal, project } = await accessProposal(ctx, id, 'write');
      if (proposal.approval) throw new DomainError('INVALID_STATE', 'This proposal was already decided.');
      transition(proposal.status === 'ANALYZING' ? 'ANALYZING' : proposal.status, 'REJECTED');
      if (!(await repos.changes.reject({ id, userId: ctx.userId, note: input.note ?? null }))) throw new DomainError('INVALID_STATE', 'This proposal can no longer be rejected.');
      await audit(project, ctx.userId, 'change.proposal_rejected', { entityId: id });
      return view((await repos.changes.get(id))!);
    },

    /** Re-queues the SAME application run after a failure (one approved proposal never has two runs). */
    async retry(ctx: RequestContext, id: string) {
      const { proposal, project } = await accessProposal(ctx, id, 'write');
      if (proposal.status !== 'FAILED' || proposal.approval?.decision !== 'APPROVED') throw new DomainError('INVALID_STATE', 'Only a failed, approved change can be retried.');
      const current = await currentVersion(project.id);
      if (proposal.baseVersionId !== current.id) throw new DomainError('STALE_PROPOSAL', 'The architecture changed since this proposal was approved.');
      const run = await repos.changes.retryApply({ id }); if (!run) throw new DomainError('INVALID_STATE', 'This change cannot be retried.');
      try { const jobId = await queue.enqueue(CHANGE_APPLY_JOB, { runId: run.id }, { singletonKey: `${run.id}:${Date.now()}` }); if (jobId) await repos.architecture.attachJob(run.id, jobId); }
      catch (e) { logger.error({ runId: run.id, err: String(e) }, 'enqueue failed'); await failApplication(run.id, 'ENQUEUE_FAILED'); throw new DomainError('INTERNAL_ERROR', SAFE.ENQUEUE_FAILED!); }
      await audit(project, ctx.userId, 'change.application_retried', { entityId: id });
      return view((await repos.changes.get(id))!);
    },

    /** Rebase = re-analyse the same request against the CURRENT version as a NEW proposal. The stale one stays as history; approval is required again. */
    async rebase(ctx: RequestContext, id: string) {
      const { proposal, project } = await accessProposal(ctx, id, 'write');
      requireStatus(project, 'ARCHITECTURE_READY', 'IMPLEMENTING');
      const current = await currentVersion(project.id); await repos.changes.markStale(project.id, current.id);
      const fresh = (await repos.changes.get(id))!;
      if (fresh.baseVersionId === current.id) throw new DomainError('INVALID_STATE', 'This proposal is already based on the current architecture version.');
      if (fresh.status === 'APPLIED' || fresh.status === 'REJECTED') throw new DomainError('INVALID_STATE', 'This proposal is finished; create a new one instead.');
      if (fresh.status === 'APPLYING' || fresh.status === 'APPROVED') throw new DomainError('INVALID_STATE', 'This change is being applied and cannot be rebased.');
      const existing = (await repos.changes.list(project.id)).find((x) => x.rebasedFromId === id && x.status !== 'REJECTED');
      if (existing) return view(existing);
      const next = await repos.changes.create({ projectId: project.id, baseVersionId: current.id, source: fresh.source, requestedChange: fresh.requestedChange, reason: fresh.reason ?? undefined, assistantConversationId: fresh.assistantConversationId ?? undefined, assistantMessageId: fresh.assistantMessageId ?? undefined, reviewFindingId: fresh.reviewFindingId ?? undefined, rebasedFromId: id, userId: ctx.userId });
      await repos.changes.startAnalysis(next.id); await startAnalysisJob(project, next.id);
      await audit(project, ctx.userId, 'change.proposal_rebased', { entityId: next.id, metadata: { from: id, toVersion: current.versionNumber } });
      void proposal; return view((await repos.changes.get(next.id))!);
    },

    async runApplication(runId: string): Promise<{ outcome: 'SUCCEEDED' | 'FAILED' | 'ALREADY_DONE' | 'NOT_CLAIMED' | 'MISSING'; versionId?: string; created?: boolean; failureCode?: string }> {
      const existing = await repos.architecture.getRun(runId);
      if (!existing || existing.mode !== 'CHANGE') return { outcome: 'MISSING' };
      const chain = async (proposalId: string | null, userId: string) => { if (proposalId) await implementation.generateForProposal(proposalId, userId).catch((e) => logger.error({ proposalId, err: String(e) }, 'plan chain failed')); };
      if (existing.status === 'SUCCEEDED') { await chain(existing.proposalId, existing.requestedById); return { outcome: 'ALREADY_DONE', versionId: existing.versionId ?? undefined }; } // a retry after a crash still completes the chain
      if (existing.status === 'FAILED') return { outcome: 'ALREADY_DONE' };
      const run = await repos.architecture.claimRun(runId, new Date(Date.now() - config.staleRunMs)); if (!run) return { outcome: 'NOT_CLAIMED' };
      const proposal = await repos.changes.getByRun(run.id); const project = await repos.projects.findById(run.projectId);
      try {
        if (!proposal || !project || proposal.status !== 'APPLYING' || (project.status !== 'ARCHITECTURE_READY' && project.status !== 'IMPLEMENTING') || !proposal.analysis) { await failApplication(run.id, 'PROPOSAL_STATE_CHANGED'); return { outcome: 'FAILED', failureCode: 'PROPOSAL_STATE_CHANGED' }; }
        await repos.architecture.touchRun(run.id, { currentStage: 'LOADING' });
        const k = await loadProjectKnowledge(repos, project);
        if (k.architecture.id !== run.baseVersionId) { await failApplication(run.id, 'PROPOSAL_STATE_CHANGED'); return { outcome: 'FAILED', failureCode: 'PROPOSAL_STATE_CHANGED' }; }
        // The new version is built against the brief the change was approved with (a new brief version if requirements changed).
        const newBrief = (await repos.briefs.getVersion(run.briefVersionId))!; const newDrivers = await repos.briefs.listDrivers(newBrief.id); const requirements = await repos.requirements.list(project.id);
        const codebook = buildCodebook(requirements, newBrief.content.architectureDrivers.map((d) => d.id), newDrivers);
        const baseBrief = (await repos.briefs.getVersion(k.architecture.briefVersionId))!;
        const baseCodebook = buildCodebook(requirements, baseBrief.content.architectureDrivers.map((d) => d.id), await repos.briefs.listDrivers(baseBrief.id));
        const basePlan = versionToPlan(k.architecture, baseCodebook);
        const context = { workspaceId: project.workspaceId, projectId: project.id, userId: run.requestedById };
        const view2 = await requirementsAndDrivers({ ...k, requirements, drivers: newDrivers, codebook }, context);
        await repos.architecture.touchRun(run.id, { currentStage: 'PLANNING' });
        const planned = await ai.plan({ context, requestedChange: proposal.requestedChange, analysis: proposal.analysis, basePlan, ...view2 });
        const applied = applyChangeOperations(basePlan, planned.output);
        if (applied.errors.length) { logger.warn({ runId, errors: applied.errors.slice(0, 3) }, 'change operations invalid'); await failApplication(run.id, 'AI_OUTPUT_INVALID'); return { outcome: 'FAILED', failureCode: 'AI_OUTPUT_INVALID' }; }
        // Scope: the plan may only touch what the user approved (affected components and their neighbours), plus additions.
        const allowed = new Set(proposal.impactItems.filter((i) => i.kind === 'NODE').map((i) => i.refKey)); const allowedEdges = new Set(proposal.impactItems.filter((i) => i.kind === 'EDGE').map((i) => i.refKey));
        const outside = nodeKeysOfOps(planned.output.operations).filter((n) => !allowed.has(n));
        const outsideEdges = planned.output.operations.flatMap((o) => (o.op === 'UPDATE_EDGE' || o.op === 'REMOVE_EDGE' ? [o.id] : [])).filter((id) => { const e = basePlan.edges.find((x) => x.id === id); return !allowedEdges.has(id) && !(e && (allowed.has(e.sourceStableKey) || allowed.has(e.targetStableKey))); });
        if (outside.length || outsideEdges.length) { logger.warn({ runId, outside, outsideEdges }, 'change plan out of scope'); await failApplication(run.id, 'CHANGE_OUT_OF_SCOPE'); return { outcome: 'FAILED', failureCode: 'CHANGE_OUT_OF_SCOPE' }; }
        // The same quality gates as a first version: structural validation, semantic rules, critic, bounded repair. Approval never overrides integrity.
        const built = buildPlanInput({ context, project: { name: project.name }, brief: newBrief.content, requirements, drivers: newDrivers, codebook });
        const gated: ArchitectureAiPort = { plan: async () => ({ output: applied.plan, ai: planned.ai }), critique: (i) => architectureAi.critique(i), repair: (i) => architectureAi.repair(i) };
        const result = await runArchitecturePipeline(gated, { input: built.input, driverCodes: built.driverCodes, requirementCodes: built.requirementCodes, requirementTexts: built.requirementTexts }, config, { onStage: (stage, repairs) => repos.architecture.touchRun(run.id, { currentStage: stage, repairCount: repairs }) });
        await repos.architecture.touchRun(run.id, { currentStage: 'FINALIZING', repairCount: result.repairs });
        const diff = diffArchitectures(versionToDiffInput(k.architecture), planToDiffInput(result.plan));
        const saved = await repos.changes.finalizeChange({ runId: run.id, proposalId: proposal.id, projectId: project.id, baseVersionId: k.architecture.id, briefVersionId: run.briefVersionId, plan: result.plan, driverIdByCode: codebook.driverIdByCode, requirementIdByCode: codebook.requirementIdByCode,
          issues: result.issues, ai: { planner: result.ai.planner, critics: result.ai.critics, repairers: result.ai.repairers, repairs: result.repairs, operations: planned.output.operations.length }, diff });
        if (saved.created) {
          await event(project, run.requestedById, 'architecture_version_created', { version: saved.versionNumber, repairs: result.repairs });
          await audit(project, run.requestedById, 'change.architecture_version_created', { entityId: proposal.id, metadata: { version: saved.versionNumber, supersededVersion: k.architecture.versionNumber } });
          await audit(project, run.requestedById, 'change.version_superseded', { entityId: proposal.id, metadata: { version: k.architecture.versionNumber } });
        }
        await chain(proposal.id, run.requestedById);
        return { outcome: 'SUCCEEDED', versionId: saved.versionId, created: saved.created };
      } catch (e) {
        let code = 'INTERNAL_ERROR'; let issues;
        if (e instanceof PipelineError) { code = e.code; issues = e.issues; }
        else if (isAiError(e)) code = e.code;
        else if ((e as { code?: string })?.code === 'PROPOSAL_STATE_CHANGED') code = 'PROPOSAL_STATE_CHANGED';
        else logger.error({ runId, err: e instanceof Error ? { message: e.message, stack: e.stack } : String(e) }, 'change application crashed');
        await failApplication(run.id, code, issues);
        return { outcome: 'FAILED', failureCode: code };
      }
    },

    // ---------------------------------------------------------------- versions and diffs
    async versionHistory(ctx: RequestContext, projectId: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      const a = await repos.architecture.getByProject(project.id); const versions = await repos.architecture.listVersions(project.id);
      const proposals = await repos.changes.list(project.id); const plans = await repos.implementation.listPlanVersions(project.id);
      return versions.map((v) => { const p = proposals.find((x) => x.id === v.sourceProposalId); return { id: v.id, versionNumber: v.versionNumber, status: v.status, isCurrent: v.id === a?.currentVersionId, createdAt: v.createdAt, parentVersionId: v.parentVersionId, summary: v.summary,
        counts: v.counts, origin: p ? { proposalId: p.id, requestedChange: p.requestedChange, source: p.source } : { proposalId: null, requestedChange: null, source: 'INITIAL' }, planVersions: plans.filter((x) => x.architectureVersionId === v.id).map((x) => ({ id: x.id, versionNumber: x.versionNumber, activation: x.activation })) }; });
    },

    async getDiff(ctx: RequestContext, fromVersionId: string, toVersionId: string) {
      const [a, b] = await Promise.all([repos.architecture.getVersion(fromVersionId), repos.architecture.getVersion(toVersionId)]);
      if (!a || !b || a.projectId !== b.projectId) throw new DomainError('ARCHITECTURE_NOT_FOUND', 'Architecture version not found.');
      try { await requireProjectAccess(repos, ctx.userId, a.projectId, 'read'); } catch (e) { if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('ARCHITECTURE_NOT_FOUND', 'Architecture version not found.'); throw e; }
      const diff: ArchitectureDiff = (await repos.diffs.get(a.id, b.id)) ?? diffArchitectures(versionToDiffInput(a), versionToDiffInput(b));
      const proposal = b.sourceProposalId ? await repos.changes.get(b.sourceProposalId) : null;
      const slim = (v: ArchitectureVersionRecord) => ({ id: v.id, versionNumber: v.versionNumber, status: v.status, nodes: v.nodes.map((n) => ({ stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: n.category, criticality: n.criticality })), edges: v.edges.map((e) => ({ edgeKey: e.edgeKey, source: e.sourceStableKey, target: e.targetStableKey, label: e.label })) });
      return { from: slim(a), to: slim(b), diff, origin: proposal ? { proposalId: proposal.id, requestedChange: proposal.requestedChange } : null, stored: !!(await repos.diffs.get(a.id, b.id)) };
    },

    // ---------------------------------------------------------------- implementation plan migration
    async planDiff(ctx: RequestContext, fromPlanId: string, toPlanId: string) {
      const [p1, p2] = await Promise.all([repos.implementation.getVersion(fromPlanId), repos.implementation.getVersion(toPlanId)]);
      if (!p1 || !p2 || p1.projectId !== p2.projectId) throw new DomainError('PLAN_NOT_FOUND', 'Implementation plan not found.');
      try { await requireProjectAccess(repos, ctx.userId, p1.projectId, 'read'); } catch (e) { if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('PLAN_NOT_FOUND', 'Implementation plan not found.'); throw e; }
      const accepted = await repos.migrations.get(p2.id);
      const arch = await this.getDiff(ctx, p1.architectureVersionId, p2.architectureVersionId);
      const lite = (t: { id: string; key: string; title: string; taskType: string; status: string; componentKeys: string[]; decisionKeys: string[] }) => ({ id: t.id, key: t.key, title: t.title, taskType: t.taskType, status: t.status, componentKeys: t.componentKeys, decisionKeys: t.decisionKeys });
      const mapping = accepted ? { items: accepted.items as MigItem[], summary: accepted.summary } : mapTasksAcrossPlans(p1.tasks.map(lite), p2.tasks.map(lite), arch.diff);
      const t1 = new Map(p1.tasks.map((t) => [t.id, t])), t2 = new Map(p2.tasks.map((t) => [t.id, t]));
      const row = (i: MigItem) => ({ outcome: i.outcome, reason: i.reason, v1: i.v1TaskId ? { id: i.v1TaskId, title: t1.get(i.v1TaskId)?.title ?? '', status: i.v1Status } : null, v2: i.v2TaskId ? { id: i.v2TaskId, title: t2.get(i.v2TaskId)?.title ?? '', key: t2.get(i.v2TaskId)?.key ?? '' } : null });
      const rows = mapping.items.map(row);
      const needsWork = new Set(mapping.items.filter((i) => i.outcome === 'REQUIRES_REVALIDATION' || i.outcome === 'NEW').map((i) => t2.get(i.v2TaskId!)?.key).filter((k): k is string => !!k));
      const newBlockers = p2.tasks.filter((t) => !needsWork.has(t.key) && t.dependsOn.some((d) => needsWork.has(d))).map((t) => ({ id: t.id, title: t.title, waitingOn: t.dependsOn.filter((d) => needsWork.has(d)).map((d) => p2.tasks.find((x) => x.key === d)?.title ?? d) }));
      const changed = mapping.items.filter((i) => i.v1TaskId && i.v2TaskId && i.outcome !== 'NEW' && t1.get(i.v1TaskId)?.instructions !== t2.get(i.v2TaskId)?.instructions).map(row);
      return { from: { id: p1.id, versionNumber: p1.versionNumber, architectureVersionId: p1.architectureVersionId }, to: { id: p2.id, versionNumber: p2.versionNumber, architectureVersionId: p2.architectureVersionId, activation: p2.activation },
        source: accepted ? 'ACCEPTED' as const : 'PREVIEW' as const, canAccept: !accepted && p2.activation === 'PENDING_REVIEW' && p2.supersedesPlanVersionId === p1.id, summary: mapping.summary,
        added: rows.filter((r) => r.outcome === 'NEW'), removed: rows.filter((r) => r.outcome === 'OBSOLETE'), changed, carried: rows.filter((r) => r.outcome === 'CARRIED_FORWARD'), revalidation: rows.filter((r) => r.outcome === 'REQUIRES_REVALIDATION'),
        unchanged: rows.filter((r) => r.outcome === 'UNCHANGED_NOT_STARTED'), newBlockers, items: rows };
    },

    async acceptMigration(ctx: RequestContext, toPlanId: string) {
      const v2 = await repos.implementation.getVersion(toPlanId);
      if (!v2) throw new DomainError('PLAN_NOT_FOUND', 'Implementation plan not found.');
      let project;
      try { ({ project } = await requireProjectAccess(repos, ctx.userId, v2.projectId, 'write')); } catch (e) { if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('PLAN_NOT_FOUND', 'Implementation plan not found.'); throw e; }
      requireStatus(project, 'ARCHITECTURE_READY', 'IMPLEMENTING');
      if (v2.activation !== 'PENDING_REVIEW' || !v2.supersedesPlanVersionId) throw new DomainError('INVALID_STATE', 'This plan is not waiting for a progress migration.');
      const d = await this.planDiff(ctx, v2.supersedesPlanVersionId, v2.id);
      const items: MigItem[] = d.items.map((r) => ({ v1TaskId: r.v1?.id ?? null, v2TaskId: r.v2?.id ?? null, outcome: r.outcome, reason: r.reason, v1Status: r.v1?.status ?? null }));
      let m;
      try { m = await repos.migrations.accept({ fromPlanVersionId: v2.supersedesPlanVersionId, toPlanVersionId: v2.id, userId: ctx.userId, proposalId: v2.sourceProposalId, items, summary: d.summary }); }
      catch (e) { if ((e as { code?: string }).code === 'MIGRATION_STALE') throw new DomainError('MIGRATION_STALE', 'Progress in the previous plan changed after you reviewed the migration. Review it again.'); throw e; }
      if (!m) throw new DomainError('INVALID_STATE', 'This migration was already accepted or is no longer pending.');
      await audit(project, ctx.userId, 'change.plan_migration_reviewed', { entityId: v2.sourceProposalId ?? undefined, metadata: { carried: d.summary.carriedForward, revalidation: d.summary.requiresRevalidation, obsolete: d.summary.obsoleteCompleted + d.summary.obsoleteOther, new: d.summary.newTasks } });
      await audit(project, ctx.userId, 'change.progress_migration_accepted', { entityId: v2.sourceProposalId ?? undefined, metadata: { toPlanVersion: v2.versionNumber } });
      await event(project, ctx.userId, 'plan_migration_accepted', { carried: d.summary.carriedForward });
      return this.planDiff(ctx, v2.supersedesPlanVersionId, v2.id);
    },

    // ---------------------------------------------------------------- production readiness review, failure modes
    async runReview(ctx: RequestContext, projectId: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'ARCHITECTURE_READY', 'IMPLEMENTING');
      const k = await loadProjectKnowledge(repos, project); const det = deterministicReview(failureGraph(k.architecture));
      const context = { workspaceId: project.workspaceId, projectId: project.id, userId: ctx.userId };
      let findings: ReviewFindingDraft[] = [...det]; let assessment = 'Findings computed from the stored architecture graph. The AI review was unavailable.'; let aiMeta: Record<string, unknown> = { status: 'DETERMINISTIC_ONLY' };
      try {
        const out = await ai.review({ context, deterministicFindings: det, ...(await requirementsAndDrivers(k, context)) });
        const seen = new Set(det.map((f) => f.title.toLowerCase()));
        findings = [...det, ...out.output.findings.filter((f) => !seen.has(f.title.toLowerCase())).map((f): ReviewFindingDraft => ({ ...f, source: 'AI' }))]; assessment = out.output.assessment; aiMeta = out.ai as unknown as Record<string, unknown>;
      } catch (e) { logger.warn({ err: isAiError(e) ? e.code : String(e) }, 'AI review unavailable; storing deterministic findings'); }
      findings.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
      const r = await repos.reviews.create({ projectId: project.id, architectureVersionId: k.architecture.id, userId: ctx.userId, assessment, ai: aiMeta, findings });
      await audit(project, ctx.userId, 'review.created', { entityId: r.id, metadata: { findings: findings.length, aiAvailable: aiMeta.status !== 'DETERMINISTIC_ONLY' } });
      return this.reviewView(r, k.architecture.id);
    },
    reviewView(r: Awaited<ReturnType<Repositories['reviews']['create']>>, currentVersionId: string) {
      const by = (s: string) => r.findings.filter((f) => f.severity === s).length;
      const ordered = [...r.findings].sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.area.localeCompare(b.area) || a.title.localeCompare(b.title)); // most serious first, deterministic
      return { review: { ...r, findings: ordered }, isCurrent: r.architectureVersionId === currentVersionId, counts: { CRITICAL: by('CRITICAL'), HIGH: by('HIGH'), MEDIUM: by('MEDIUM'), LOW: by('LOW') }, aiAvailable: (r.ai as { status?: string }).status !== 'DETERMINISTIC_ONLY' };
    },
    async latestReview(ctx: RequestContext, projectId: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      const a = await repos.architecture.getByProject(project.id); const r = await repos.reviews.latest(project.id);
      return r && a?.currentVersionId ? this.reviewView(r, a.currentVersionId) : null;
    },

    /** "What happens if this fails?" from the stored graph and decisions (no model). */
    async failureImpact(ctx: RequestContext, projectId: string, stableKey: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      const k = await loadProjectKnowledge(repos, project);
      if (!k.architecture.nodes.some((n) => n.stableKey === stableKey)) throw new DomainError('NODE_NOT_FOUND', 'Component not found in this architecture.');
      const f = analyzeNodeFailure(failureGraph(k.architecture), stableKey);
      const tasks = k.plan && k.plan.architectureVersionId === k.architecture.id ? k.plan.tasks.filter((t) => t.componentKeys.includes(stableKey)).map((t) => ({ id: t.id, title: t.title, status: t.status, taskType: t.taskType })) : [];
      return { ...f, decisions: k.architecture.decisions.filter((d) => d.nodeStableKeys.includes(stableKey)).map((d) => ({ key: d.key, title: d.title })), implementationTasks: tasks };
    },
  };
}
export type ChangeService = ReturnType<typeof createChangeService>;
export { CHANGE_ANALYZE_JOB, CHANGE_APPLY_JOB };
void validateChangeAnalysis;
