import type { ArchitecturePlan, PlanContext } from '@pitch2plan/schemas';
import { requireProjectAccess } from './authorization';
import { buildCodebook, buildPlanInput, type Codebook } from './architecture-codes';
import { DEFAULT_PIPELINE_CONFIG, PipelineError, runArchitecturePipeline, type PipelineConfig } from './architecture-pipeline';
import type { RequestContext } from './discovery';
import { DomainError } from './errors';
import type { Logger } from './logger';
import type {
  ArchitectureAiPort, ArchitectureVersionRecord, DecisionRecord, DriverRecord, GenerationRunRecord, JobQueue, NodeHistoryEntry, ProjectRecord, Repositories, RequirementRecord,
} from './ports';
import { ARCHITECTURE_JOB } from './ports';
import { isAiError, requireStatus } from './shared';

export interface ArchitectureConfig extends PipelineConfig { staleRunMs: number }
export const DEFAULT_ARCHITECTURE_CONFIG: ArchitectureConfig = { ...DEFAULT_PIPELINE_CONFIG, staleRunMs: 10 * 60_000 };

/** Failure information that is safe to show a user. Raw provider errors and stack traces never reach the run record. */
const SAFE: Record<string, string> = {
  AI_OUTPUT_INVALID: 'The AI’s architecture did not pass our validation checks.',
  AI_TIMEOUT: 'The AI service took too long to respond.',
  AI_PROVIDER_ERROR: 'The AI service is temporarily unavailable.',
  ARCHITECTURE_VALIDATION_FAILED: 'We could not produce an architecture that passed all structural checks, even after repair attempts.',
  GENERATION_TIMED_OUT: 'Architecture generation did not finish in time.',
  ENQUEUE_FAILED: 'We could not start architecture generation.',
  PROJECT_STATE_CHANGED: 'The project changed while the architecture was being generated.',
  INTERNAL_ERROR: 'Something went wrong on our side while generating the architecture.',
};

export interface TraceRequirement { id: string; code: string; statement: string; category: string; origin: string }
export interface TraceDriver { id: string; code: string; name: string; description: string; priority: string; requirementCodes: string[] }
export type DecisionView = DecisionRecord & { driverCodes: string[]; requirementCodes: string[]; impliedRequirementCodes: string[] };
export interface VersionView {
  version: Omit<ArchitectureVersionRecord, 'decisions'>; decisions: DecisionView[]; drivers: TraceDriver[]; requirements: TraceRequirement[];
  stats: { components: number; connections: number; decisions: number; highRisks: number; openIssues: number; drivers: number };
}
export interface RunView { id: string; jobId: string | null; status: GenerationRunRecord['status']; currentStage: string; repairCount: number; failureCode: string | null; failureMessage: string | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null; versionId: string | null }
export interface NodeInspectorView {
  node: ArchitectureVersionRecord['nodes'][number];
  inputs: Array<{ edgeKey: string; label: string; protocol: string; communicationType: string; dataDescription: string; node: { stableKey: string; name: string } }>;
  outputs: Array<{ edgeKey: string; label: string; protocol: string; communicationType: string; dataDescription: string; node: { stableKey: string; name: string } }>;
  decisions: DecisionView[]; drivers: TraceDriver[]; requirements: TraceRequirement[]; history: NodeHistoryEntry[];
  /** "Why is this here?" is answered entirely from persisted traceability. No model call. */
  why: { summary: string; drivers: TraceDriver[]; requirements: TraceRequirement[]; decisions: DecisionView[] };
}
export interface RequirementTraceView { requirement: TraceRequirement; decisions: DecisionView[]; nodes: Array<{ stableKey: string; name: string; technology: string }> }
export type ArchitectureState = 'NOT_AVAILABLE' | 'NOT_STARTED' | 'GENERATING' | 'READY' | 'FAILED';

const toRunView = (r: GenerationRunRecord): RunView => ({
  id: r.id, jobId: r.jobId, status: r.status, currentStage: r.currentStage, repairCount: r.repairCount, failureCode: r.failureCode, failureMessage: r.failureMessage,
  createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, versionId: r.versionId,
});

export function createArchitectureService(deps: { repos: Repositories; ai: ArchitectureAiPort; queue: JobQueue; logger: Logger; config: ArchitectureConfig }) {
  const { repos, ai, queue, logger, config } = deps;
  const event = (p: { workspaceId: string; id: string }, userId: string | undefined, name: string, properties?: Record<string, string | number | boolean | null>) =>
    repos.analytics.record({ workspaceId: p.workspaceId, projectId: p.id, userId, name, properties }).catch((e) => logger.error({ name, err: String(e) }, 'analytics failed'));
  const audit = (p: { workspaceId: string; id: string }, actorId: string | undefined, action: string, extra: { entityType?: string; entityId?: string; requestId?: string; metadata?: Record<string, unknown> } = {}) =>
    repos.audit.record({ workspaceId: p.workspaceId, projectId: p.id, actorId, action, ...extra });

  async function failRun(run: GenerationRunRecord, code: string, issues?: Parameters<Repositories['architecture']['failRun']>[0]['issues']) {
    const message = SAFE[code] ?? SAFE.INTERNAL_ERROR!;
    const r = await repos.architecture.failRun({ runId: run.id, code, message, issues });
    const project = await repos.projects.findById(run.projectId);
    if (r.failed && project) {
      await event(project, undefined, 'architecture_generation_failed', { code, attempt: run.attempt });
      await audit(project, undefined, 'architecture.generation_failed', { entityType: 'ArchitectureGenerationRun', entityId: run.id, metadata: { code } });
    }
    return r;
  }

  /** A run whose worker vanished (crash, lost job) must never leave the project stuck in ARCHITECTURE_GENERATING. */
  async function recoverStale(projectId?: string) {
    const before = new Date(Date.now() - config.staleRunMs);
    const stale = (await repos.architecture.listStaleRuns(before)).filter((r) => r.mode !== 'CHANGE' && (!projectId || r.projectId === projectId)); // change applications have their own recovery
    for (const run of stale) await failRun(run, 'GENERATION_TIMED_OUT');
    return stale.length;
  }

  async function loadContext(project: ProjectRecord, briefVersionId: string) {
    const [version, drivers, requirements, pitch] = await Promise.all([
      repos.briefs.getVersion(briefVersionId), repos.briefs.listDrivers(briefVersionId), repos.requirements.list(project.id), repos.pitches.latest(project.id),
    ]);
    if (!version) throw new DomainError('BRIEF_NOT_FOUND', 'The confirmed brief could not be found.');
    const codebook = buildCodebook(requirements, version.content.architectureDrivers.map((d) => d.id), drivers);
    return { version, drivers, requirements, pitch, codebook };
  }

  const traceRequirements = (reqs: RequirementRecord[], cb: Codebook): TraceRequirement[] =>
    reqs.filter((r) => cb.requirementCodeById[r.id]).map((r) => ({ id: r.id, code: cb.requirementCodeById[r.id]!, statement: r.statement, category: r.category, origin: r.origin }));
  const traceDrivers = (drivers: DriverRecord[], cb: Codebook): TraceDriver[] =>
    drivers.filter((d) => cb.driverCodeById[d.id]).map((d) => ({
      id: d.id, code: cb.driverCodeById[d.id]!, name: d.name, description: d.description, priority: d.priority,
      requirementCodes: d.requirementIds.map((id) => cb.requirementCodeById[id]).filter((c): c is string => !!c),
    })).sort((a, b) => a.code.localeCompare(b.code));
  const decisionView = (d: DecisionRecord, cb: Codebook, drivers: DriverRecord[]): DecisionView => {
    const driverCodes = d.driverIds.map((id) => cb.driverCodeById[id]).filter((c): c is string => !!c).sort();
    const requirementCodes = d.requirementIds.map((id) => cb.requirementCodeById[id]).filter((c): c is string => !!c).sort();
    const implied = new Set(drivers.filter((x) => d.driverIds.includes(x.id)).flatMap((x) => x.requirementIds).map((id) => cb.requirementCodeById[id]).filter((c): c is string => !!c));
    for (const c of requirementCodes) implied.delete(c);
    return { ...d, driverCodes, requirementCodes, impliedRequirementCodes: [...implied].sort() };
  };

  async function versionView(project: ProjectRecord, version: ArchitectureVersionRecord): Promise<{ view: VersionView; cb: Codebook; drivers: DriverRecord[]; requirements: RequirementRecord[] }> {
    const { drivers, requirements, codebook } = await loadContext(project, version.briefVersionId);
    const { decisions, ...rest } = version;
    const decisionViews = decisions.map((d) => decisionView(d, codebook, drivers));
    return {
      cb: codebook, drivers, requirements,
      view: {
        version: rest, decisions: decisionViews, drivers: traceDrivers(drivers, codebook), requirements: traceRequirements(requirements.filter((r) => r.status === 'ACTIVE'), codebook),
        stats: {
          components: version.nodes.length, connections: version.edges.length, decisions: decisions.length, drivers: Object.keys(codebook.driverIdByCode).length,
          highRisks: version.risks.filter((r) => r.severity === 'CRITICAL' || r.severity === 'HIGH').length,
          openIssues: version.issues.filter((i) => i.stage === 'FINAL' && (i.severity === 'CRITICAL' || i.severity === 'HIGH')).length,
        },
      },
    };
  }

  /** Authorization for version-scoped reads. Non-members get ARCHITECTURE_NOT_FOUND so existence is never leaked. */
  async function accessVersion(ctx: RequestContext, versionId: string) {
    const version = await repos.architecture.getVersion(versionId);
    if (!version) throw new DomainError('ARCHITECTURE_NOT_FOUND', 'Architecture not found.');
    let project;
    try { ({ project } = await requireProjectAccess(repos, ctx.userId, version.projectId, 'read')); } catch (e) {
      if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('ARCHITECTURE_NOT_FOUND', 'Architecture not found.');
      throw e;
    }
    return { version, project };
  }

  return {
    config,
    recoverStale,

    /** Validates, atomically moves the project to ARCHITECTURE_GENERATING, creates the run, and queues the job. */
    async generate(ctx: RequestContext, projectId: string) {
      let { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      if (project.status === 'ARCHITECTURE_GENERATING') { await recoverStale(project.id); project = (await repos.projects.findById(project.id))!; }
      requireStatus(project, 'REQUIREMENTS_CONFIRMED');
      const brief = await repos.briefs.getByProject(project.id);
      if (!brief || brief.status !== 'CONFIRMED' || !brief.confirmedVersionId) throw new DomainError('INVALID_STATE', 'Confirm your requirements before generating an architecture.');
      const drivers = await repos.briefs.listDrivers(brief.confirmedVersionId);
      if (drivers.length === 0) throw new DomainError('INVALID_STATE', 'The confirmed brief has no architecture drivers.');

      const run = await repos.architecture.startGeneration({ projectId: project.id, briefVersionId: brief.confirmedVersionId, userId: ctx.userId });
      if (!run) throw new DomainError('INVALID_STATE', 'Architecture generation is already in progress or the project changed.');
      let jobId: string | null;
      try { jobId = await queue.enqueue(ARCHITECTURE_JOB, { runId: run.id }, { singletonKey: run.id }); } catch (e) {
        logger.error({ runId: run.id, err: String(e) }, 'enqueue failed');
        await failRun(run, 'ENQUEUE_FAILED');
        throw new DomainError('INTERNAL_ERROR', SAFE.ENQUEUE_FAILED!);
      }
      if (jobId) await repos.architecture.attachJob(run.id, jobId);
      await event(project, ctx.userId, 'architecture_generation_started', { drivers: drivers.length });
      await audit(project, ctx.userId, 'architecture.generation_started', { entityType: 'ArchitectureGenerationRun', entityId: run.id, requestId: ctx.requestId });
      return { jobId: jobId ?? run.id, generationRunId: run.id, status: 'QUEUED' as const };
    },

    /**
     * The worker entry point. Idempotent: safe to deliver twice, to retry after a crash, or to race against another worker.
     * Never throws for business failures; those are recorded on the run and the project is returned to a recoverable state.
     */
    async runGeneration(runId: string): Promise<{ outcome: 'SUCCEEDED' | 'FAILED' | 'ALREADY_DONE' | 'NOT_CLAIMED' | 'MISSING'; versionId?: string; created?: boolean; failureCode?: string }> {
      const existing = await repos.architecture.getRun(runId);
      if (!existing) return { outcome: 'MISSING' };
      if (existing.status === 'SUCCEEDED' || existing.status === 'FAILED') return { outcome: 'ALREADY_DONE', versionId: existing.versionId ?? undefined };
      const run = await repos.architecture.claimRun(runId, new Date(Date.now() - config.staleRunMs));
      if (!run) return { outcome: 'NOT_CLAIMED' };
      const project = await repos.projects.findById(run.projectId);
      if (!project || project.status !== 'ARCHITECTURE_GENERATING') { await failRun(run, 'PROJECT_STATE_CHANGED'); return { outcome: 'FAILED', failureCode: 'PROJECT_STATE_CHANGED' }; }

      try {
        await repos.architecture.touchRun(run.id, { currentStage: 'ANALYZING_DRIVERS' });
        const { version, drivers, requirements, pitch, codebook } = await loadContext(project, run.briefVersionId);
        const built = buildPlanInput({
          context: { workspaceId: project.workspaceId, projectId: project.id, userId: run.requestedById }, project: { name: project.name, technicalLevel: pitch?.technicalLevel ?? undefined },
          brief: version.content, requirements, drivers, codebook,
        });
        const result = await runArchitecturePipeline(ai, { input: built.input, driverCodes: built.driverCodes, requirementCodes: built.requirementCodes, requirementTexts: built.requirementTexts }, config, {
          onStage: (stage, repairs) => repos.architecture.touchRun(run.id, { currentStage: stage, repairCount: repairs }),
        });
        await repos.architecture.touchRun(run.id, { currentStage: 'FINALIZING', repairCount: result.repairs });
        const saved = await repos.architecture.finalize({
          runId: run.id, projectId: project.id, briefVersionId: run.briefVersionId, plan: result.plan, issues: result.issues, driverIdByCode: codebook.driverIdByCode, requirementIdByCode: codebook.requirementIdByCode,
          ai: { planner: result.ai.planner, critics: result.ai.critics, repairers: result.ai.repairers, repairs: result.repairs },
        });
        if (saved.created) {
          await event(project, run.requestedById, 'architecture_generated', { version: saved.versionNumber, components: result.plan.nodes.length, decisions: result.plan.decisions.length, repairs: result.repairs });
          await audit(project, run.requestedById, 'architecture.generated', { entityType: 'ArchitectureVersion', entityId: saved.versionId, metadata: { version: saved.versionNumber, repairs: result.repairs } });
        }
        return { outcome: 'SUCCEEDED', versionId: saved.versionId, created: saved.created };
      } catch (e) {
        let code = 'INTERNAL_ERROR';
        let issues;
        if (e instanceof PipelineError) { code = e.code; issues = e.issues; }
        else if (isAiError(e)) code = e.code;
        else if ((e as { code?: string })?.code === 'PROJECT_STATE_CHANGED') code = 'PROJECT_STATE_CHANGED';
        else logger.error({ runId, err: e instanceof Error ? { message: e.message, stack: e.stack } : String(e) }, 'architecture generation crashed');
        logger.warn({ runId, code }, 'architecture generation failed');
        await failRun(run, code, issues);
        return { outcome: 'FAILED', failureCode: code };
      }
    },

    async getOverview(ctx: RequestContext, projectId: string) {
      let { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      if (project.status === 'ARCHITECTURE_GENERATING') { await recoverStale(project.id); project = (await repos.projects.findById(project.id))!; }
      const [architecture, run, versions] = await Promise.all([repos.architecture.getByProject(project.id), repos.architecture.getLatestRun(project.id), repos.architecture.listVersions(project.id)]);
      const current = architecture?.currentVersionId ? await repos.architecture.getVersion(architecture.currentVersionId) : null;
      const state: ArchitectureState = project.status === 'ARCHITECTURE_GENERATING' ? 'GENERATING'
        : current && ['ARCHITECTURE_READY', 'IMPLEMENTING'].includes(project.status) ? 'READY'
        : project.status === 'REQUIREMENTS_CONFIRMED' ? (run?.status === 'FAILED' ? 'FAILED' : 'NOT_STARTED') : 'NOT_AVAILABLE';
      const built = current ? await versionView(project, current) : null;
      return { state, project: { id: project.id, name: project.name, status: project.status }, run: run ? toRunView(run) : null, versions, current: built?.view ?? null };
    },

    async listVersions(ctx: RequestContext, projectId: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      return repos.architecture.listVersions(project.id);
    },

    async getVersion(ctx: RequestContext, versionId: string): Promise<VersionView> {
      const { version, project } = await accessVersion(ctx, versionId);
      return (await versionView(project, version)).view;
    },

    async getDecisions(ctx: RequestContext, versionId: string): Promise<{ decisions: DecisionView[]; drivers: TraceDriver[]; requirements: TraceRequirement[] }> {
      const { version, project } = await accessVersion(ctx, versionId);
      const { view } = await versionView(project, version);
      return { decisions: view.decisions, drivers: view.drivers, requirements: view.requirements };
    },

    async getNode(ctx: RequestContext, versionId: string, stableKey: string): Promise<NodeInspectorView> {
      const { version, project } = await accessVersion(ctx, versionId);
      const node = version.nodes.find((n) => n.stableKey === stableKey);
      if (!node) throw new DomainError('NODE_NOT_FOUND', 'Component not found in this architecture version.');
      const { view } = await versionView(project, version);
      const names = new Map(version.nodes.map((n) => [n.stableKey, n.name]));
      const link = (e: (typeof version.edges)[number], other: string) => ({ edgeKey: e.edgeKey, label: e.label, protocol: e.protocol, communicationType: e.communicationType, dataDescription: e.dataDescription, node: { stableKey: other, name: names.get(other) ?? other } });
      const decisions = view.decisions.filter((d) => d.nodeStableKeys.includes(stableKey));
      const driverCodes = new Set(decisions.flatMap((d) => d.driverCodes));
      const reqCodes = new Set(decisions.flatMap((d) => [...d.requirementCodes, ...d.impliedRequirementCodes]));
      const whyDrivers = view.drivers.filter((d) => driverCodes.has(d.code));
      const whyReqs = view.requirements.filter((r) => reqCodes.has(r.code));
      const arch = await repos.architecture.getByProject(project.id);
      return {
        node, inputs: version.edges.filter((e) => e.targetStableKey === stableKey).map((e) => link(e, e.sourceStableKey)), outputs: version.edges.filter((e) => e.sourceStableKey === stableKey).map((e) => link(e, e.targetStableKey)),
        decisions, drivers: whyDrivers, requirements: whyReqs, history: arch ? await repos.architecture.nodeHistory(arch.id, stableKey) : [],
        why: {
          summary: decisions.length
            ? `${node.technology} is here because of ${decisions.length} architecture decision${decisions.length === 1 ? '' : 's'}, which respond to ${whyDrivers.length} architecture driver${whyDrivers.length === 1 ? '' : 's'} and ${whyReqs.length} confirmed requirement${whyReqs.length === 1 ? '' : 's'}.`
            : `No recorded decision explains ${node.name} yet.`,
          drivers: whyDrivers, requirements: whyReqs, decisions,
        },
      };
    },

    /** Requirement -> decisions -> components, the reverse of "why is this here?". */
    async getRequirementTrace(ctx: RequestContext, versionId: string, requirementId: string): Promise<RequirementTraceView> {
      const { version, project } = await accessVersion(ctx, versionId);
      const { view, cb } = await versionView(project, version);
      const code = cb.requirementCodeById[requirementId];
      const requirement = view.requirements.find((r) => r.code === code);
      if (!code || !requirement) throw new DomainError('REQUIREMENT_NOT_FOUND', 'Requirement not found.');
      const decisions = view.decisions.filter((d) => d.requirementCodes.includes(code) || d.impliedRequirementCodes.includes(code));
      const keys = new Set(decisions.flatMap((d) => d.nodeStableKeys));
      return { requirement, decisions, nodes: version.nodes.filter((n) => keys.has(n.stableKey)).map((n) => ({ stableKey: n.stableKey, name: n.name, technology: n.technology })) };
    },

    /** Poll a job. Accepts the queue job id (or the run id). Exposes only safe, user-presentable run state. */
    async getJob(ctx: RequestContext, jobId: string): Promise<RunView> {
      const run = (await repos.architecture.getRunByJobId(jobId)) ?? (/^[0-9a-f-]{36}$/i.test(jobId) ? await repos.architecture.getRun(jobId) : null);
      if (!run) throw new DomainError('JOB_NOT_FOUND', 'Job not found.');
      try { await requireProjectAccess(repos, ctx.userId, run.projectId, 'read'); } catch (e) {
        if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('JOB_NOT_FOUND', 'Job not found.');
        throw e;
      }
      if (run.status === 'RUNNING' || run.status === 'QUEUED') await recoverStale(run.projectId);
      return toRunView((await repos.architecture.getRun(run.id))!);
    },
  };
}
export type ArchitectureService = ReturnType<typeof createArchitectureService>;
export type { ArchitecturePlan, PlanContext };
