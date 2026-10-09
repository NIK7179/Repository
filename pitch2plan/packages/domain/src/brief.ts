import { detectRuleConflicts, type ArchitectureBriefContent, type DiscoveryUnknown } from '@pitch2plan/schemas';
import { requireProjectAccess } from './authorization';
import type { DiscoveryService, RequestContext } from './discovery';
import { DomainError } from './errors';
import type { Logger } from './logger';
import type { BriefRecord, BriefVersionRecord, ConflictRecord, DiscoveryAiPort, DriverRecord, ProjectRecord, Repositories, RequirementRecord } from './ports';
import { callAi, requireStatus, requirementsFingerprint, toSnapshot } from './shared';
import { assertTransition } from './status';

export interface Blocker { code: 'BRIEF_STALE' | 'OPEN_CONFLICTS' | 'NO_SUMMARY' | 'NO_FUNCTIONAL' | 'NO_DRIVERS'; message: string }

/** Pure confirmation gate. Critical unknowns are handled separately because the user may explicitly accept them. */
export function evaluateConfirmation(input: { content: ArchitectureBriefContent; stale: boolean; openConflicts: number }): Blocker[] {
  const b: Blocker[] = [];
  if (input.stale) b.push({ code: 'BRIEF_STALE', message: 'Your requirements changed after this brief was generated. Regenerate the brief to confirm.' });
  if (input.openConflicts > 0) b.push({ code: 'OPEN_CONFLICTS', message: `Resolve ${input.openConflicts} conflicting requirement${input.openConflicts === 1 ? '' : 's'} first.` });
  if (!input.content.projectSummary.trim()) b.push({ code: 'NO_SUMMARY', message: 'The brief needs a project summary.' });
  if (input.content.functionalRequirements.length === 0) b.push({ code: 'NO_FUNCTIONAL', message: 'The brief needs at least one functional requirement.' });
  if (input.content.architectureDrivers.length === 0) b.push({ code: 'NO_DRIVERS', message: 'The brief needs at least one architecture driver.' });
  return b;
}
export const unresolvedCriticalUnknowns = (unknowns: DiscoveryUnknown[]) => unknowns.filter((u) => u.status === 'OPEN' && u.critical);

export interface BriefView {
  brief: BriefRecord; version: BriefVersionRecord; drivers: DriverRecord[]; requirements: RequirementRecord[];
  unknowns: DiscoveryUnknown[]; openConflicts: ConflictRecord[]; stale: boolean; blockers: Blocker[]; criticalUnknowns: DiscoveryUnknown[];
  project: { id: string; name: string; status: ProjectRecord['status'] };
}

export function createBriefService(deps: { repos: Repositories; ai: DiscoveryAiPort; logger: Logger; discovery: DiscoveryService }) {
  const { repos, ai, logger, discovery } = deps;
  const event = (ctx: RequestContext, p: ProjectRecord, name: string, properties?: Record<string, string | number | boolean | null>) =>
    repos.analytics.record({ workspaceId: p.workspaceId, projectId: p.id, userId: ctx.userId, name, properties }).catch((e) => logger.error({ name, err: String(e) }, 'analytics failed'));
  const audit = (ctx: RequestContext, p: ProjectRecord, action: string, extra: { entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {}) =>
    repos.audit.record({ workspaceId: p.workspaceId, projectId: p.id, actorId: ctx.userId, action, requestId: ctx.requestId, ...extra });

  async function view(project: ProjectRecord, version: BriefVersionRecord): Promise<BriefView> {
    const [brief, drivers, all, session, conflicts] = await Promise.all([
      repos.briefs.getByProject(project.id), repos.briefs.listDrivers(version.id), repos.requirements.list(project.id),
      repos.discovery.getSession(project.id), repos.conflicts.list(project.id),
    ]);
    const active = all.filter((r) => r.status === 'ACTIVE');
    const stale = requirementsFingerprint(active) !== version.requirementsFingerprint;
    const openConflicts = conflicts.filter((c) => c.status === 'OPEN');
    const unknowns = session?.unknowns ?? [];
    return {
      brief: brief!, version, drivers, requirements: all, unknowns, openConflicts, stale,
      blockers: evaluateConfirmation({ content: version.content, stale, openConflicts: openConflicts.length }),
      criticalUnknowns: unresolvedCriticalUnknowns(unknowns), project: { id: project.id, name: project.name, status: project.status },
    };
  }

  return {
    async get(ctx: RequestContext, projectId: string): Promise<BriefView> {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      const version = await repos.briefs.latestVersion(project.id);
      if (!version) throw new DomainError('BRIEF_NOT_FOUND', 'No Architecture Brief has been generated yet.');
      return view(project, version);
    },

    async generate(ctx: RequestContext, projectId: string): Promise<BriefView> {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'DISCOVERY');
      const session = await repos.discovery.getSession(project.id);
      if (!session) throw new DomainError('DISCOVERY_NOT_FOUND', 'Start discovery first.');
      if (session.status !== 'READY_FOR_BRIEF') throw new DomainError('INVALID_STATE', 'Finish discovery before generating the brief.');
      const [pitch, interpretation, all] = await Promise.all([repos.pitches.latest(project.id), repos.interpretations.latest(project.id), repos.requirements.list(project.id)]);
      const active = all.filter((r) => r.status === 'ACTIVE');
      if (!pitch || !interpretation || active.length === 0) throw new DomainError('INVALID_STATE', 'There are no requirements to build a brief from yet.');

      const openUnknowns = session.unknowns.filter((u) => u.status === 'OPEN');
      const { output, ai: meta } = await callAi(logger, 'generateBrief', () => ai.generateBrief({
        context: { workspaceId: project.workspaceId, projectId: project.id, userId: ctx.userId }, pitch: pitch.content, interpretation: interpretation.output, requirements: active.map(toSnapshot), openUnknowns, technicalLevel: pitch.technicalLevel ?? undefined,
      }));
      // Unresolved issues are never silently dropped or invented away: they always appear as open questions.
      const content: ArchitectureBriefContent = { ...output, openQuestions: [...output.openQuestions] };
      for (const u of openUnknowns) if (!content.openQuestions.some((q) => q.unknownId === u.id)) content.openQuestions.push({ text: u.text, unknownId: u.id });

      const version = await repos.briefs.createVersion({
        projectId: project.id, content, fingerprint: requirementsFingerprint(active), ai: meta, userId: ctx.userId, drivers: content.architectureDrivers,
      });
      await event(ctx, project, 'brief_generated', { version: version.version, drivers: content.architectureDrivers.length, openQuestions: content.openQuestions.length });
      await audit(ctx, project, 'brief.generated', { entityType: 'ArchitectureBriefVersion', entityId: version.id, metadata: { version: version.version } });
      return view(project, version);
    },

    async confirm(ctx: RequestContext, projectId: string, input: { briefVersionId: string; acceptedUnknownIds: string[] }): Promise<BriefView> {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'DISCOVERY');
      assertTransition(project.status, 'REQUIREMENTS_CONFIRMED');
      const version = await repos.briefs.getVersion(input.briefVersionId);
      if (!version || version.projectId !== project.id) throw new DomainError('BRIEF_NOT_FOUND', 'Brief not found.');
      const latest = await repos.briefs.latestVersion(project.id);
      if (latest?.id !== version.id) throw new DomainError('BRIEF_STALE', 'A newer brief exists. Review the latest one.');

      // Rules are deterministic, so re-check them at the gate in case anything changed since the last detection.
      const active = (await repos.requirements.list(project.id)).filter((r) => r.status === 'ACTIVE');
      const known = new Set((await repos.conflicts.list(project.id)).map((c) => c.fingerprint));
      const latent = detectRuleConflicts(active.map((r) => ({ id: r.id, statement: r.statement, tags: r.tags }))).filter((c) => !known.has(c.fingerprint));
      if (latent.length) await discovery.detectConflictsNow(ctx, project);

      const v = await view(project, version);
      if (v.blockers.length) throw new DomainError('CONFIRMATION_BLOCKED', v.blockers[0]!.message, { blockers: v.blockers });
      const openIds = new Set(v.unknowns.filter((u) => u.status === 'OPEN').map((u) => u.id));
      const bad = input.acceptedUnknownIds.filter((id) => !openIds.has(id));
      if (bad.length) throw new DomainError('VALIDATION_ERROR', 'You accepted an assumption that is not open.', { unknownIds: bad });
      const unaccepted = v.criticalUnknowns.filter((u) => !input.acceptedUnknownIds.includes(u.id));
      if (unaccepted.length) {
        throw new DomainError('CONFIRMATION_BLOCKED', 'Answer or explicitly accept the remaining critical unknowns as assumptions.', { unacceptedUnknownIds: unaccepted.map((u) => u.id) });
      }

      const ok = await repos.briefs.confirm({ projectId: project.id, briefVersionId: version.id, userId: ctx.userId, acceptedUnknownIds: input.acceptedUnknownIds });
      if (!ok) throw new DomainError('INVALID_STATE', 'The project changed while confirming. Refresh and try again.');
      await event(ctx, project, 'requirements_confirmed', { version: version.version, acceptedAssumptions: input.acceptedUnknownIds.length, drivers: v.drivers.length });
      await audit(ctx, project, 'requirements.confirmed', { entityType: 'ArchitectureBriefVersion', entityId: version.id, metadata: { version: version.version, acceptedUnknownIds: input.acceptedUnknownIds } });
      const confirmed = (await repos.briefs.getVersion(version.id))!;
      return view({ ...project, status: 'REQUIREMENTS_CONFIRMED' }, confirmed);
    },
  };
}
export type BriefService = ReturnType<typeof createBriefService>;
