import {
  conflictFingerprint, describeChoice, detectRuleConflicts, validateAnswers,
  type AnsweredQuestion, type ClarificationInput, type DiscoveryUnknown, type PriorQuestion, type SubmitAnswersRequest,
} from '@pitch2plan/schemas';
import { requireProjectAccess } from './authorization';
import { DomainError } from './errors';
import type { Logger } from './logger';
import type {
  ConflictRecord, DiscoveryAiPort, ProjectRecord, Repositories, RequirementRecord, RoundRecord, SessionRecord,
} from './ports';
import { callAi, requireStatus, toSnapshot, type DiscoveryConfig } from './shared';
import { seedRequirementsFromInterpretation, unknownsFromInterpretation } from './seed';
import { transitionProject } from './status';

export interface RequestContext { userId: string; requestId: string }
export interface DiscoveryState {
  project: { id: string; name: string; status: ProjectRecord['status'] };
  session: (SessionRecord & { roundsUsed: number; maxRounds: number }) | null;
  rounds: RoundRecord[];
  requirements: RequirementRecord[];
  conflicts: ConflictRecord[];
  brief: { versionId: string; version: number; status: 'DRAFT' | 'CONFIRMED'; confirmedAt: Date | null } | null;
}
export interface DiscoveryDeps { repos: Repositories; ai: DiscoveryAiPort; logger: Logger; config: DiscoveryConfig }

export function createDiscoveryService({ repos, ai, logger, config }: DiscoveryDeps) {
  const event = (ctx: RequestContext, p: ProjectRecord, name: string, properties?: Record<string, string | number | boolean | null>) =>
    repos.analytics.record({ workspaceId: p.workspaceId, projectId: p.id, userId: ctx.userId, name, properties }).catch((e) => logger.error({ name, err: String(e) }, 'analytics failed'));
  const audit = (ctx: RequestContext, p: ProjectRecord, action: string, extra: { entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {}) =>
    repos.audit.record({ workspaceId: p.workspaceId, projectId: p.id, actorId: ctx.userId, action, requestId: ctx.requestId, ...extra });

  async function pitchAndInterpretation(projectId: string) {
    const [pitch, interpretation] = await Promise.all([repos.pitches.latest(projectId), repos.interpretations.latest(projectId)]);
    if (!pitch) throw new DomainError('NO_PITCH', 'Submit an idea pitch first.');
    if (!interpretation) throw new DomainError('INTERPRETATION_NOT_FOUND', 'Interpret your idea before starting discovery.');
    return { pitch, interpretation };
  }

  async function buildState(project: ProjectRecord): Promise<DiscoveryState> {
    const session = await repos.discovery.getSession(project.id);
    const [rounds, requirements, conflicts, version, brief] = await Promise.all([
      session ? repos.discovery.listRounds(session.id) : Promise.resolve([]),
      repos.requirements.list(project.id), repos.conflicts.list(project.id), repos.briefs.latestVersion(project.id), repos.briefs.getByProject(project.id),
    ]);
    return {
      project: { id: project.id, name: project.name, status: project.status },
      session: session ? { ...session, roundsUsed: rounds.filter((r) => r.kind === 'STANDARD').length, maxRounds: config.maxDiscoveryRounds } : null,
      rounds, requirements, conflicts,
      brief: version && brief ? { versionId: version.id, version: version.version, status: brief.status, confirmedAt: version.confirmedAt } : null,
    };
  }
  const freshProject = async (id: string) => (await repos.projects.findById(id))!;

  async function generateRound(ctx: RequestContext, project: ProjectRecord, session: SessionRecord, kind: 'STANDARD' | 'USER_REQUESTED') {
    const { pitch, interpretation } = await pitchAndInterpretation(project.id);
    const [rounds, requirements] = await Promise.all([repos.discovery.listRounds(session.id), repos.requirements.list(project.id)]);
    const questions = rounds.flatMap((r) => r.questions);
    const priorQuestions: PriorQuestion[] = questions.map((q) => ({ id: q.id, question: q.question, category: q.category, relatedUnknowns: q.relatedUnknowns }));
    const priorAnswers: AnsweredQuestion[] = questions.filter((q) => q.answer).map((q) => ({
      questionId: q.id, question: q.question, category: q.category, answer: describeChoice(q, q.answer!.choice),
      recommended: q.answer!.choice.kind === 'RECOMMEND', resolvedValue: q.answer!.resolvedValue,
    }));
    const openUnknowns = session.unknowns.filter((u) => u.status === 'OPEN');
    const input: ClarificationInput = {
      context: { workspaceId: project.workspaceId, projectId: project.id, userId: ctx.userId }, pitch: pitch.content, interpretation: interpretation.output, requirements: requirements.filter((r) => r.status === 'ACTIVE').map(toSnapshot),
      priorQuestions, priorAnswers, openUnknowns, roundNumber: rounds.length + 1, technicalLevel: pitch.technicalLevel ?? undefined,
      limits: { maxQuestions: config.maxQuestionsPerRound, maxRounds: config.maxDiscoveryRounds },
    };
    const { output, ai: meta } = await callAi(logger, 'generateQuestions', () => ai.generateQuestions(input));

    // Gaps the interpreter missed arrive with temporary ids (N1...); give them stable ids and rewrite every reference.
    let nextNumber = session.unknowns.reduce((m, u) => Math.max(m, Number(/^U(\d+)$/.exec(u.id)?.[1] ?? 0)), 0) + 1;
    const remap = new Map(output.newUnknowns.map((n) => [n.id, `U${nextNumber++}`]));
    const mapId = (id: string) => remap.get(id) ?? id;
    const questions_ = output.questions.map((q) => ({ ...q, relatedUnknowns: q.relatedUnknowns.map(mapId) }));
    const critical = new Set(output.remainingCriticalUnknowns.map(mapId));
    const unknowns: DiscoveryUnknown[] = [
      ...session.unknowns.map((u) => (u.status === 'OPEN' ? { ...u, critical: critical.has(u.id) } : u)),
      ...output.newUnknowns.map((n) => ({ id: remap.get(n.id)!, text: n.text, status: 'OPEN' as const, critical: critical.has(remap.get(n.id)!) || n.critical })),
    ];
    if (output.questions.length === 0) {
      await repos.discovery.updateSession(session.id, { status: 'READY_FOR_BRIEF', unknowns, finishReason: 'NO_CRITICAL_UNKNOWNS' });
      await event(ctx, project, 'discovery_round_generated', { round: rounds.length + 1, questions: 0, canGenerateBrief: true });
      return null;
    }
    await repos.discovery.updateSession(session.id, { unknowns });
    const round = await repos.discovery.createRound({
      sessionId: session.id, kind, reasonForAnotherRound: output.reasonForAnotherRound, canGenerateBrief: output.canGenerateBrief, ai: meta, questions: questions_,
    });
    await event(ctx, project, 'discovery_round_generated', { round: round.number, questions: output.questions.length, newUnknowns: output.newUnknowns.length, canGenerateBrief: output.canGenerateBrief });
    return round;
  }

  /** Rule-based detection always runs; AI detection is best-effort and never blocks the user's answers. */
  async function detectConflicts(ctx: RequestContext, project: ProjectRecord) {
    const active = (await repos.requirements.list(project.id)).filter((r) => r.status === 'ACTIVE');
    const existing = await repos.conflicts.list(project.id);
    const pairKey = (ids: string[]) => [...ids].sort().join('+');
    const seen = new Set(existing.map((c) => pairKey(c.requirementIds)));

    const ruleHits = detectRuleConflicts(active.map((r) => ({ id: r.id, statement: r.statement, tags: r.tags })));
    const created = await repos.conflicts.createMany(project.id, ruleHits.map((c) => ({
      fingerprint: c.fingerprint, detectedBy: 'RULE' as const, ruleId: c.ruleId, severity: c.severity, title: c.title, description: c.description, requirementIds: c.requirementIds,
    })));
    ruleHits.forEach((c) => seen.add(pairKey(c.requirementIds)));

    if (active.length >= 2) {
      try {
        const { output, ai: meta } = await callAi(logger, 'detectConflicts', () => ai.detectConflicts({ context: { workspaceId: project.workspaceId, projectId: project.id, userId: ctx.userId }, requirements: active.map(toSnapshot) }));
        const byKey = new Map(active.map((r) => [r.key, r.id]));
        const fresh = output.conflicts.map((c) => ({ c, ids: c.requirementKeys.map((k) => byKey.get(k)!) })).filter(({ ids }) => !seen.has(pairKey(ids)));
        created.push(...await repos.conflicts.createMany(project.id, fresh.map(({ c, ids }) => ({
          fingerprint: conflictFingerprint('AI', ids), detectedBy: 'AI' as const, ruleId: null, severity: c.severity, title: c.title, description: c.description, requirementIds: ids, ai: meta,
        }))));
      } catch (e) {
        if (!(e instanceof DomainError && e.code.startsWith('AI_'))) throw e;
        await audit(ctx, project, 'conflicts.ai_detection_failed', { metadata: { code: e.code } });
      }
    }
    if (created.length) await audit(ctx, project, 'conflicts.detected', { metadata: { count: created.length } });
    return created;
  }

  return {
    async getState(ctx: RequestContext, projectId: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      return buildState(project);
    },

    async start(ctx: RequestContext, projectId: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'IDEA', 'DISCOVERY');
      const { pitch, interpretation } = await pitchAndInterpretation(project.id);
      const { session, created } = await repos.discovery.createSession({
        projectId: project.id, unknowns: unknownsFromInterpretation(interpretation.output),
        seed: seedRequirementsFromInterpretation(interpretation.output, pitch.technicalLevel),
      });
      if (created) {
        if (project.status === 'IDEA') await transitionProject(repos, project, 'DISCOVERY');
        await event(ctx, project, 'discovery_started', { unknowns: session.unknowns.length });
        await audit(ctx, project, 'discovery.started', { entityType: 'DiscoverySession', entityId: session.id });
      }
      // A retry after a failed first generation lands here too: no round yet means we still owe the user one.
      const rounds = await repos.discovery.listRounds(session.id);
      if (rounds.length === 0 && session.status === 'ACTIVE') await generateRound(ctx, await freshProject(project.id), session, 'STANDARD');
      return buildState(await freshProject(project.id));
    },

    async submitAnswers(ctx: RequestContext, projectId: string, roundId: string, input: SubmitAnswersRequest) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'DISCOVERY');
      const session = await repos.discovery.getSession(project.id);
      if (!session) throw new DomainError('DISCOVERY_NOT_FOUND', 'Discovery has not started for this project.');
      const rounds = await repos.discovery.listRounds(session.id);
      const round = rounds.find((r) => r.id === roundId);
      if (!round) throw new DomainError('ROUND_NOT_FOUND', 'Discovery round not found.');
      if (round.status === 'COMPLETED' || round.status === 'SKIPPED') throw new DomainError('INVALID_STATE', 'This round is already finished.');

      const issues = validateAnswers(round.questions, input.answers);
      if (issues.length) throw new DomainError('VALIDATION_ERROR', issues[0]!, issues.map((message) => ({ message })));

      await repos.discovery.saveAnswers({ roundId, userId: ctx.userId, answers: input.answers });
      const questionById = new Map(round.questions.map((q) => [q.id, q]));
      for (const a of input.answers) {
        const q = questionById.get(a.questionId)!;
        if (a.choice.kind === 'SKIP') continue;
        await event(ctx, project, 'discovery_question_answered', { round: round.number, category: q.category, answerType: q.answerType, choice: a.choice.kind });
        if (a.choice.kind === 'RECOMMEND') await event(ctx, project, 'recommend_for_me_selected', { round: round.number, category: q.category });
      }

      const [{ pitch, interpretation }, requirements] = await Promise.all([pitchAndInterpretation(project.id), repos.requirements.list(project.id)]);
      const extraction = await callAi(logger, 'extractRequirements', () => ai.extractRequirements({
        context: { workspaceId: project.workspaceId, projectId: project.id, userId: ctx.userId }, pitch: pitch.content, interpretation: interpretation.output, requirements: requirements.filter((r) => r.status === 'ACTIVE').map(toSnapshot),
        questions: round.questions.map(({ answer: _answer, ...q }) => q), answers: input.answers, openUnknowns: session.unknowns.filter((u) => u.status === 'OPEN'),
      }));
      const out = extraction.output;
      await repos.discovery.applyExtraction({
        projectId: project.id, sessionId: session.id, roundId, userId: ctx.userId, ai: extraction.ai,
        newRequirements: out.newRequirements, updatedRequirements: out.updatedRequirements,
        recommendations: out.recommendations.map((r) => ({ questionKey: r.questionId, resolvedValue: r.resolvedValue, reason: r.reason })),
        resolvedUnknownIds: out.resolvedUnknownIds, newUnknowns: out.newUnknowns,
      });
      await event(ctx, project, 'discovery_round_completed', {
        round: round.number, answered: input.answers.filter((a) => a.choice.kind !== 'SKIP').length,
        newRequirements: out.newRequirements.length, updatedRequirements: out.updatedRequirements.length,
      });
      await audit(ctx, project, 'discovery.round_completed', { entityType: 'DiscoveryRound', entityId: roundId, metadata: { round: round.number } });
      await detectConflicts(ctx, project);
      return buildState(await freshProject(project.id));
    },

    /** Decides what happens after a completed round: another round, or ready for the brief. */
    async next(ctx: RequestContext, projectId: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'DISCOVERY');
      const session = await repos.discovery.getSession(project.id);
      if (!session) throw new DomainError('DISCOVERY_NOT_FOUND', 'Discovery has not started for this project.');
      if (session.status === 'READY_FOR_BRIEF') return buildState(project);
      const rounds = await repos.discovery.listRounds(session.id);
      if (rounds.some((r) => r.status === 'OPEN' || r.status === 'ANSWERED')) {
        throw new DomainError('INVALID_STATE', 'Finish the current round first.');
      }
      const standard = rounds.filter((r) => r.kind === 'STANDARD').length;
      if (standard >= config.maxDiscoveryRounds) {
        await repos.discovery.updateSession(session.id, { status: 'READY_FOR_BRIEF', finishReason: 'MAX_ROUNDS' });
        await audit(ctx, project, 'discovery.ready', { metadata: { reason: 'MAX_ROUNDS' } });
      } else {
        await generateRound(ctx, project, session, 'STANDARD');
      }
      return buildState(await freshProject(project.id));
    },

    /** "Generate brief now": stop asking. Unanswered unknowns become open assumptions in the brief. */
    async finish(ctx: RequestContext, projectId: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'DISCOVERY');
      const session = await repos.discovery.getSession(project.id);
      if (!session) throw new DomainError('DISCOVERY_NOT_FOUND', 'Discovery has not started for this project.');
      const rounds = await repos.discovery.listRounds(session.id);
      if (rounds.some((r) => r.status === 'ANSWERED')) throw new DomainError('INVALID_STATE', 'Your last answers are still being processed. Resubmit them to continue.');
      for (const r of rounds.filter((x) => x.status === 'OPEN')) await repos.discovery.setRoundStatus(r.id, 'SKIPPED');
      await repos.discovery.updateSession(session.id, { status: 'READY_FOR_BRIEF', finishReason: 'USER_REQUESTED' });
      await audit(ctx, project, 'discovery.finished_early', { entityType: 'DiscoverySession', entityId: session.id });
      return buildState(await freshProject(project.id));
    },

    /** "Ask more questions" from the brief screen. A user-requested round does not count toward the cap. */
    async askMore(ctx: RequestContext, projectId: string) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'DISCOVERY');
      const session = await repos.discovery.getSession(project.id);
      if (!session) throw new DomainError('DISCOVERY_NOT_FOUND', 'Discovery has not started for this project.');
      if (session.status !== 'READY_FOR_BRIEF') throw new DomainError('INVALID_STATE', 'Discovery is still in progress.');
      await repos.discovery.updateSession(session.id, { status: 'ACTIVE', finishReason: null });
      try {
        await generateRound(ctx, project, { ...session, status: 'ACTIVE' }, 'USER_REQUESTED');
      } catch (e) {
        await repos.discovery.updateSession(session.id, { status: 'READY_FOR_BRIEF', finishReason: session.finishReason });
        throw e;
      }
      return buildState(await freshProject(project.id));
    },

    async editRequirement(ctx: RequestContext, projectId: string, requirementId: string, input: { statement: string; value?: string | null }) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'DISCOVERY');
      const req = await repos.requirements.get(requirementId);
      if (!req || req.projectId !== project.id || req.status !== 'ACTIVE') throw new DomainError('REQUIREMENT_NOT_FOUND', 'Requirement not found.');
      const value = input.value === undefined ? req.value : input.value;
      if (input.statement === req.statement && value === req.value) throw new DomainError('VALIDATION_ERROR', 'Nothing was changed.');
      const updated = await repos.requirements.addEditVersion({ requirementId, statement: input.statement, value, userId: ctx.userId });
      await event(ctx, project, 'requirement_edited', { category: updated.category, version: updated.version });
      await audit(ctx, project, 'requirement.edited', { entityType: 'Requirement', entityId: requirementId, metadata: { version: updated.version, previousOrigin: req.origin } });
      return updated;
    },

    history: async (ctx: RequestContext, projectId: string, requirementId: string) => {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      const req = await repos.requirements.get(requirementId);
      if (!req || req.projectId !== project.id) throw new DomainError('REQUIREMENT_NOT_FOUND', 'Requirement not found.');
      return repos.requirements.history(requirementId);
    },

    async resolveConflict(ctx: RequestContext, projectId: string, conflictId: string,
      input: { action: 'KEEP_ONE'; keepRequirementId: string; note?: string } | { action: 'DISMISS'; note: string }) {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
      requireStatus(project, 'DISCOVERY');
      const conflict = await repos.conflicts.get(conflictId);
      if (!conflict || conflict.projectId !== project.id) throw new DomainError('CONFLICT_NOT_FOUND', 'Conflict not found.');
      if (conflict.status !== 'OPEN') throw new DomainError('INVALID_STATE', 'This conflict is already resolved.');
      if (input.action === 'KEEP_ONE' && !conflict.requirementIds.includes(input.keepRequirementId)) {
        throw new DomainError('VALIDATION_ERROR', 'Choose one of the requirements involved in this conflict.');
      }
      const supersede = input.action === 'KEEP_ONE' ? conflict.requirementIds.filter((id) => id !== input.keepRequirementId) : [];
      await repos.conflicts.resolve({ id: conflictId, userId: ctx.userId, resolution: { ...input }, supersedeRequirementIds: supersede });
      await audit(ctx, project, 'conflict.resolved', { entityType: 'DiscoveryConflict', entityId: conflictId, metadata: { action: input.action } });
      return buildState(await freshProject(project.id));
    },

    detectConflictsNow: detectConflicts,
  };
}
export type DiscoveryService = ReturnType<typeof createDiscoveryService>;
