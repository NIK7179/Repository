import { afterAll, describe, expect, it } from 'vitest';
import { canStartArchitectureGeneration } from '@pitch2plan/domain';
import { mockBrief } from '@pitch2plan/ai';
import { ON_PREM_PITCH, PITCH, answerAll, makeApp, projectReadyForDiscovery, signUp } from '../helpers';

const h = makeApp();
afterAll(() => h.prisma.$disconnect());

async function begin(opts: { pitch?: string; app?: ReturnType<typeof makeApp> } = {}) {
  const app = opts.app ?? h;
  const p = await projectReadyForDiscovery(app, opts.pitch);
  const state = await app.app.discovery.start(p.ctx, p.project.id);
  const st = () => app.app.discovery.getState(p.ctx, p.project.id);
  return { ...p, state, st, app };
}
const reqByKey = (state: Awaited<ReturnType<typeof h.app.discovery.getState>>, key: string) => state.requirements.find((r) => r.key === key)!;

describe('starting discovery', () => {
  it('seeds requirements with honest origins, opens round 1 and moves the project to DISCOVERY', async () => {
    const { state, project, ctx } = await begin();
    expect(state.project.status).toBe('DISCOVERY');
    expect(state.session).toMatchObject({ status: 'ACTIVE', roundsUsed: 1, maxRounds: 3 });
    expect(state.session!.unknowns).toHaveLength(5);
    const round = state.rounds[0]!;
    expect(round).toMatchObject({ number: 1, kind: 'STANDARD', status: 'OPEN' });
    expect(round.ai).toMatchObject({ promptId: 'CLARIFICATION_QUESTION_GENERATOR', promptVersion: 1, provider: 'mock' });
    expect(round.questions.length).toBeGreaterThanOrEqual(3);
    const unknownIds = new Set(state.session!.unknowns.map((u) => u.id));
    for (const q of round.questions) q.relatedUnknowns.forEach((u) => expect(unknownIds.has(u)).toBe(true));
    expect(state.requirements.some((r) => r.origin === 'USER_STATED')).toBe(true);
    expect(state.requirements.filter((r) => r.origin === 'AI_INFERRED').every((r) => r.confidence !== null)).toBe(true);
    expect(state.requirements.every((r) => r.version === 1 && r.status === 'ACTIVE')).toBe(true);
    const names = (await h.prisma.analyticsEvent.findMany({ where: { projectId: project.id } })).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['discovery_started', 'discovery_round_generated']));
    expect(ctx.userId).toBeTruthy();
  });

  it('is idempotent: starting twice does not create a second session or round', async () => {
    const { project, ctx, app } = await begin();
    const again = await app.app.discovery.start(ctx, project.id);
    expect(again.rounds).toHaveLength(1);
    expect(await h.prisma.discoverySession.count({ where: { projectId: project.id } })).toBe(1);
  });

  it('requires an interpreted idea first and leaves the project untouched otherwise', async () => {
    const u = await signUp(h.app);
    const project = await h.app.projects.create(u.ctx, { name: 'Not interpreted' });
    await h.app.pitches.submit(u.ctx, project.id, { content: PITCH });
    await expect(h.app.discovery.start(u.ctx, project.id)).rejects.toMatchObject({ code: 'INTERPRETATION_NOT_FOUND' });
    expect((await h.app.projects.get(u.ctx, project.id)).project.status).toBe('IDEA');
  });
});

describe('answering, recommendations and requirement extraction', () => {
  it('persists answers, stores "Recommend for me" with its resolved value and reason, and keeps origins separate', async () => {
    const { state, project, ctx, app } = await begin();
    const { round, answers } = answerAll(state, { q1_u3: { kind: 'RECOMMEND' } });
    const after = await app.app.discovery.submitAnswers(ctx, project.id, round.id, { answers });

    expect(after.rounds[0]!.status).toBe('COMPLETED');
    const rec = after.rounds[0]!.questions.find((q) => q.id === 'q1_u3')!;
    expect(rec.answer).toMatchObject({ choice: { kind: 'RECOMMEND' }, resolvedValue: 'Balanced' });
    expect(rec.answer!.recommendationReason).toMatch(/default/);
    expect(reqByKey(after, 'ans_q1_u3')).toMatchObject({ origin: 'AI_RECOMMENDED', confidence: 0.6, category: 'BUDGET' });
    expect(reqByKey(after, 'ans_q1_u1')).toMatchObject({ origin: 'USER_ANSWERED', confidence: null });
    expect(reqByKey(after, 'ans_q1_u1').statement).toContain('Small');
    expect(after.session!.unknowns.filter((u) => u.status === 'RESOLVED').map((u) => u.id)).toEqual(['U1', 'U2', 'U3', 'U4']);
    expect(after.session!.unknowns.find((u) => u.id === 'U5')!.status).toBe('OPEN');
    expect(after.conflicts).toHaveLength(0);

    const v = await h.prisma.requirementVersion.findFirstOrThrow({ where: { requirement: { projectId: project.id, key: 'ans_q1_u3' } }, include: { sources: true } });
    expect(v.sources.map((s) => `${s.kind}:${s.questionKey}`)).toEqual(['RECOMMENDATION:q1_u3']);
    expect(v.ai).toMatchObject({ promptId: 'REQUIREMENT_EXTRACTOR', promptVersion: 1 });
  });

  it('records analytics without leaking raw answers', async () => {
    const { state, project, ctx, app } = await begin();
    const { round, answers } = answerAll(state, { q1_u3: { kind: 'RECOMMEND' } });
    await app.app.discovery.submitAnswers(ctx, project.id, round.id, { answers });
    const events = await h.prisma.analyticsEvent.findMany({ where: { projectId: project.id } });
    const names = events.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['discovery_question_answered', 'recommend_for_me_selected', 'discovery_round_completed']));
    expect(names.filter((n) => n === 'recommend_for_me_selected')).toHaveLength(1);
    const blob = JSON.stringify(events.map((e) => e.properties));
    for (const label of ['Small', 'Immediately', 'Balanced', 'Public cloud']) expect(blob).not.toContain(label);
  });

  it('rejects invalid answers without persisting anything', async () => {
    const { state, project, ctx, app, st } = await begin();
    const round = state.rounds[0]!;
    await expect(app.app.discovery.submitAnswers(ctx, project.id, round.id, { answers: [{ questionId: round.questions[0]!.id, choice: { kind: 'OPTIONS', optionIds: ['nope'] } }] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const after = await st();
    expect(after.rounds[0]!.status).toBe('OPEN');
    expect(after.rounds[0]!.questions.every((q) => q.answer === null)).toBe(true);
  });

  it('versions an AI-inferred requirement when an answer changes it, preserving history', async () => {
    const { state, project, ctx } = await begin();
    const inferred = state.requirements.find((r) => r.key === 'seed_inf_1')!;
    expect(inferred.origin).toBe('AI_INFERRED');
    const { round, answers } = answerAll(state);
    const s = makeApp({
      script: [JSON.stringify({
        newRequirements: round.questions.slice(1).map((q) => ({ key: `scripted_${q.id}`, category: q.category, statement: `Scripted answer for ${q.id}`, origin: 'USER_ANSWERED', sourceQuestionIds: [q.id], tags: [] })),
        updatedRequirements: [{ requirementId: inferred.id, category: 'PERFORMANCE', statement: 'Volume is small, so low-latency effort can stay modest.', origin: 'USER_ANSWERED', sourceQuestionIds: [round.questions[0]!.id], tags: [], reason: 'The user answered the volume question.' }],
        recommendations: [], resolvedUnknownIds: ['U1', 'U2', 'U3', 'U4'], newUnknowns: [],
      }), JSON.stringify({ conflicts: [] })],
    });
    try {
      const after = await s.app.discovery.submitAnswers(ctx, project.id, round.id, { answers });
      const updated = after.requirements.find((r) => r.id === inferred.id)!;
      expect(updated).toMatchObject({ version: 2, origin: 'USER_ANSWERED', source: 'USER_ANSWERED' });
      expect(updated.previousStatement).toBe(inferred.statement);
      const history = await s.app.discovery.history(ctx, project.id, inferred.id);
      expect(history.map((v) => [v.version, v.origin])).toEqual([[1, 'AI_INFERRED'], [2, 'USER_ANSWERED']]);
      expect(history[0]!.statement).toBe(inferred.statement); // v1 is untouched
      expect(after.requirements.filter((r) => r.key.startsWith('seed_')).length).toBe(state.requirements.length); // nothing recreated or dropped
    } finally { await s.prisma.$disconnect(); }
  });
});

describe('AI failure handling', () => {
  it('never lets an AI-origin update overwrite a requirement the user stated; answers are kept and a retry succeeds', async () => {
    const { state, project, ctx, app, st } = await begin();
    const fact = state.requirements.find((r) => r.key === 'seed_fact_1')!;
    const { round, answers } = answerAll(state);
    // Everything else in this response is valid (every answer is reflected, unknowns exist), so the ONLY problem is the overwrite.
    const bad = JSON.stringify({
      newRequirements: round.questions.map((q) => ({ key: `ok_${q.id}`, category: q.category, statement: `Valid answer for ${q.id}`, origin: 'USER_ANSWERED', sourceQuestionIds: [q.id], tags: [] })),
      updatedRequirements: [{ requirementId: fact.id, category: 'FUNCTIONAL', statement: 'Quietly rewritten by the AI', origin: 'AI_INFERRED', confidence: 0.9, sourceQuestionIds: [], tags: [], reason: 'x' }],
      recommendations: [], resolvedUnknownIds: ['U1'], newUnknowns: [],
    });
    const s = makeApp({ script: [bad, bad] });
    try {
      await expect(s.app.discovery.submitAnswers(ctx, project.id, round.id, { answers })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID', details: { issues: [expect.stringMatching(/may not overwrite a requirement the user stated/)] } });
    } finally { await s.prisma.$disconnect(); }
    const mid = await st();
    expect(reqByKey(mid, 'seed_fact_1')).toMatchObject({ version: 1, statement: fact.statement, origin: 'USER_STATED' });
    expect(mid.rounds[0]!.status).toBe('ANSWERED'); // answers are saved so the user does not lose them
    await expect(app.app.discovery.next(ctx, project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(app.app.discovery.finish(ctx, project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const done = await app.app.discovery.submitAnswers(ctx, project.id, round.id, { answers }); // retry
    expect(done.rounds[0]!.status).toBe('COMPLETED');
    expect(await h.prisma.discoveryAnswer.count({ where: { question: { roundId: round.id } } })).toBe(round.questions.length); // replaced, not duplicated
  });

  it('returns a controlled error for malformed question output, keeps the session, and a retry recovers', async () => {
    const p = await projectReadyForDiscovery(h);
    const s = makeApp({ script: ['I would ask about scale!', '{"questions": 5}'] });
    try {
      await expect(s.app.discovery.start(p.ctx, p.project.id)).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
      expect(await h.prisma.discoveryRound.count({ where: { session: { projectId: p.project.id } } })).toBe(0);
      expect((await h.app.projects.get(p.ctx, p.project.id)).project.status).toBe('DISCOVERY');
    } finally { await s.prisma.$disconnect(); }
    const retried = await h.app.discovery.start(p.ctx, p.project.id);
    expect(retried.rounds).toHaveLength(1);
  });

  it('repairs once when the first question output is invalid, and records that it was repaired', async () => {
    const p = await projectReadyForDiscovery(h);
    const good = JSON.stringify({
      questions: [{ id: 'q_vol', category: 'TRAFFIC', question: 'Roughly how many people will use this each day?', whyItMatters: 'Volume changes how much capacity the design needs.', answerType: 'SINGLE_SELECT',
        options: [{ id: 'a', label: 'Dozens' }, { id: 'b', label: 'Thousands' }], required: false, priority: 'HIGH', relatedUnknowns: ['U1'], allowRecommendation: true }],
      remainingCriticalUnknowns: ['U1'], reasonForAnotherRound: 'Volume is unknown.', canGenerateBrief: false,
    });
    const s = makeApp({ script: ['not json', good] });
    try {
      const state = await s.app.discovery.start(p.ctx, p.project.id);
      expect(state.rounds[0]!.ai.repaired).toBe(true);
      expect(state.rounds[0]!.questions[0]!.id).toBe('q_vol');
      expect(s.provider.calls[1]!.messages.at(-1)!.content).toMatch(/rejected/);
      expect(s.usage.filter((u) => u.capability === 'CLARIFICATION_QUESTION_GENERATOR')).toHaveLength(2);
    } finally { await s.prisma.$disconnect(); }
  });

  it('rejects a repeated question and creates no round', async () => {
    const { state, project, ctx, app, st } = await begin();
    const { round, answers } = answerAll(state);
    await app.app.discovery.submitAnswers(ctx, project.id, round.id, { answers });
    const asked = round.questions[0]!;
    const dup = JSON.stringify({
      questions: [{ id: 'q_again', category: 'TRAFFIC', question: asked.question, whyItMatters: 'Asking the same thing again for no reason.', answerType: 'SINGLE_SELECT',
        options: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }], required: false, priority: 'LOW', relatedUnknowns: ['U5'], allowRecommendation: false }],
      remainingCriticalUnknowns: ['U5'], reasonForAnotherRound: 'More to learn.', canGenerateBrief: false,
    });
    const s = makeApp({ script: [dup, dup] });
    try {
      await expect(s.app.discovery.next(ctx, project.id)).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID', details: { issues: expect.arrayContaining([expect.stringMatching(/duplicates an earlier question/)]) } });
    } finally { await s.prisma.$disconnect(); }
    expect((await st()).rounds).toHaveLength(1);
  });
});

describe('gap analysis beyond the interpreter', () => {
  it('adds unknowns the interpreter missed with stable ids and rewrites the questions that reference them', async () => {
    const p = await projectReadyForDiscovery(h);
    const json = JSON.stringify({
      newUnknowns: [{ id: 'N1', text: 'How confidential are the documents users will upload?', critical: true }],
      questions: [
        { id: 'q_conf', category: 'PRIVACY', question: 'How sensitive are the documents people will put in?', whyItMatters: 'Confidentiality decides how strictly data must be separated.', answerType: 'SINGLE_SELECT',
          options: [{ id: 'a', label: 'Public' }, { id: 'b', label: 'Internal only' }, { id: 'c', label: 'Highly confidential' }], required: false, priority: 'CRITICAL', relatedUnknowns: ['N1', 'U1'], allowRecommendation: true },
      ],
      remainingCriticalUnknowns: ['N1'], reasonForAnotherRound: 'Confidentiality is unknown.', canGenerateBrief: false,
    });
    const s = makeApp({ script: [json] });
    try {
      const state = await s.app.discovery.start(p.ctx, p.project.id);
      const added = state.session!.unknowns.find((u) => u.text.startsWith('How confidential'))!;
      expect(added).toMatchObject({ id: 'U6', status: 'OPEN', critical: true });
      expect(state.rounds[0]!.questions[0]!.relatedUnknowns).toEqual(['U6', 'U1']); // N1 never leaks into stored data
      expect(JSON.stringify(state)).not.toContain('"N1"');
      expect(state.session!.unknowns.find((u) => u.id === 'U1')!.critical).toBe(false); // not in remainingCriticalUnknowns
    } finally { await s.prisma.$disconnect(); }
  });

  it('rejects a question that references an unknown that does not exist', async () => {
    const p = await projectReadyForDiscovery(h);
    const bad = JSON.stringify({
      questions: [{ id: 'q_x', category: 'PRIVACY', question: 'How sensitive are the documents people will put in?', whyItMatters: 'Confidentiality decides how strictly data must be separated.', answerType: 'BOOLEAN',
        options: [], required: false, priority: 'HIGH', relatedUnknowns: ['N7'], allowRecommendation: false }],
      remainingCriticalUnknowns: [], reasonForAnotherRound: 'More to learn.', canGenerateBrief: false,
    });
    const s = makeApp({ script: [bad, bad] });
    try { await expect(s.app.discovery.start(p.ctx, p.project.id)).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' }); } finally { await s.prisma.$disconnect(); }
  });
});

describe('round control', () => {
  it('walks the whole flow: next question, then ready for the brief when nothing critical remains', async () => {
    const { state, project, ctx, app } = await begin();
    let s = await app.app.discovery.submitAnswers(ctx, project.id, state.rounds[0]!.id, { answers: answerAll(state).answers });
    s = await app.app.discovery.next(ctx, project.id);
    expect(s.rounds).toHaveLength(2);
    expect(s.rounds[1]!.questions.map((q) => q.relatedUnknowns[0])).toEqual(['U5']); // only what is still open
    s = await app.app.discovery.submitAnswers(ctx, project.id, s.rounds[1]!.id, { answers: answerAll(s).answers });
    s = await app.app.discovery.next(ctx, project.id);
    expect(s.session).toMatchObject({ status: 'READY_FOR_BRIEF', finishReason: 'NO_CRITICAL_UNKNOWNS' });
    expect(s.rounds).toHaveLength(2);
    expect(s.session!.unknowns.every((u) => u.status === 'RESOLVED')).toBe(true);
  });

  it('stops at the configured round cap, leaving unresolved unknowns open, and still lets the user ask for more', async () => {
    const capped = makeApp({}, { maxDiscoveryRounds: 3, maxQuestionsPerRound: 1 });
    try {
      const { state, project, ctx } = await begin({ app: capped });
      expect(state.rounds[0]!.questions).toHaveLength(1);
      let s = state;
      for (let i = 1; i <= 3; i++) {
        s = await capped.app.discovery.submitAnswers(ctx, project.id, s.rounds.at(-1)!.id, { answers: answerAll(s).answers });
        s = await capped.app.discovery.next(ctx, project.id);
      }
      expect(s.rounds).toHaveLength(3);
      expect(s.session).toMatchObject({ status: 'READY_FOR_BRIEF', finishReason: 'MAX_ROUNDS', roundsUsed: 3 });
      expect(s.session!.unknowns.filter((u) => u.status === 'OPEN').map((u) => u.id)).toEqual(['U4', 'U5']);
      expect((await capped.app.discovery.next(ctx, project.id)).rounds).toHaveLength(3); // no fourth automatic round

      s = await capped.app.discovery.askMore(ctx, project.id); // the user may go beyond the cap
      expect(s.rounds).toHaveLength(4);
      expect(s.rounds[3]).toMatchObject({ kind: 'USER_REQUESTED', status: 'OPEN' });
      expect(s.session).toMatchObject({ status: 'ACTIVE', roundsUsed: 3 });
    } finally { await capped.prisma.$disconnect(); }
  });

  it('lets the user generate the brief early; unanswered unknowns become open assumptions, never invented answers', async () => {
    const { state, project, ctx, app } = await begin();
    const s = await app.app.discovery.finish(ctx, project.id);
    expect(s.session).toMatchObject({ status: 'READY_FOR_BRIEF', finishReason: 'USER_REQUESTED' });
    expect(s.rounds[0]!.status).toBe('SKIPPED');
    expect(s.requirements.some((r) => r.key.startsWith('ans_'))).toBe(false);
    await expect(app.app.discovery.submitAnswers(ctx, project.id, state.rounds[0]!.id, { answers: answerAll(state).answers })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const view = await app.app.briefs.generate(ctx, project.id);
    expect(view.version.content.openQuestions.map((q) => q.unknownId).sort()).toEqual(['U1', 'U2', 'U3', 'U4', 'U5']);
  });
});

describe('contradictions', () => {
  it('detects real-time vs batch, shows it, and blocks confirmation until the user resolves it', async () => {
    const { state, project, ctx, app } = await begin();
    const fact = state.requirements.find((r) => r.key === 'seed_fact_1')!;
    expect(fact.tags).toContain('PROCESSING_REAL_TIME');
    let s = await app.app.discovery.submitAnswers(ctx, project.id, state.rounds[0]!.id, { answers: answerAll(state, { q1_u2: { kind: 'OPTIONS', optionIds: ['d'] } }).answers });
    expect(s.conflicts).toHaveLength(1);
    const c = s.conflicts[0]!;
    expect(c).toMatchObject({ status: 'OPEN', detectedBy: 'RULE', ruleId: 'PROCESSING_LATENCY' });
    expect(c.requirementIds).toEqual(expect.arrayContaining([fact.id, reqByKey(s, 'ans_q1_u2').id]));

    s = await app.app.discovery.next(ctx, project.id);
    await app.app.discovery.submitAnswers(ctx, project.id, s.rounds[1]!.id, { answers: answerAll(s).answers });
    await app.app.discovery.next(ctx, project.id);
    const view = await app.app.briefs.generate(ctx, project.id);
    expect(view.blockers.map((b) => b.code)).toContain('OPEN_CONFLICTS');
    await expect(app.app.briefs.confirm(ctx, project.id, { briefVersionId: view.version.id, acceptedUnknownIds: [] })).rejects.toMatchObject({ code: 'CONFIRMATION_BLOCKED', details: { blockers: [expect.objectContaining({ code: 'OPEN_CONFLICTS' })] } });
    expect((await app.app.projects.get(ctx, project.id)).project.status).toBe('DISCOVERY');

    await expect(app.app.discovery.resolveConflict(ctx, project.id, c.id, { action: 'KEEP_ONE', keepRequirementId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    s = await app.app.discovery.resolveConflict(ctx, project.id, c.id, { action: 'KEEP_ONE', keepRequirementId: fact.id, note: 'Real time matters most.' });
    expect(s.conflicts[0]).toMatchObject({ status: 'RESOLVED' });
    expect(reqByKey(s, 'ans_q1_u2').status).toBe('SUPERSEDED');
    expect(reqByKey(s, 'seed_fact_1').status).toBe('ACTIVE');
    await expect(app.app.discovery.resolveConflict(ctx, project.id, c.id, { action: 'DISMISS', note: 'again' })).rejects.toMatchObject({ code: 'INVALID_STATE' });

    // The brief was built before the resolution, so it is stale until regenerated.
    expect((await app.app.briefs.get(ctx, project.id)).stale).toBe(true);
    await expect(app.app.briefs.confirm(ctx, project.id, { briefVersionId: view.version.id, acceptedUnknownIds: [] })).rejects.toMatchObject({ code: 'CONFIRMATION_BLOCKED', details: { blockers: [expect.objectContaining({ code: 'BRIEF_STALE' })] } });
    const fresh = await app.app.briefs.generate(ctx, project.id);
    expect(fresh.version.version).toBe(2);
    expect(fresh.blockers).toEqual([]);
    const done = await app.app.briefs.confirm(ctx, project.id, { briefVersionId: fresh.version.id, acceptedUnknownIds: [] });
    expect(done.project.status).toBe('REQUIREMENTS_CONFIRMED');
  });

  it('detects an on-premises requirement colliding with a public-cloud answer, and a user can dismiss a false alarm with a reason', async () => {
    const { state, project, ctx, app } = await begin({ pitch: ON_PREM_PITCH });
    const s = await app.app.discovery.submitAnswers(ctx, project.id, state.rounds[0]!.id, { answers: answerAll(state, { q1_u4: { kind: 'OPTIONS', optionIds: ['a'] } }).answers });
    expect(s.conflicts.map((c) => c.ruleId)).toEqual(['DEPLOYMENT_MODEL']);
    const after = await app.app.discovery.resolveConflict(ctx, project.id, s.conflicts[0]!.id, { action: 'DISMISS', note: 'We will use cloud for backups only.' });
    expect(after.conflicts[0]).toMatchObject({ status: 'RESOLVED', resolution: { action: 'DISMISS' } });
    expect(after.requirements.filter((r) => r.status === 'ACTIVE').some((r) => r.key === 'ans_q1_u4')).toBe(true); // dismissal supersedes nothing
    expect((await app.app.discovery.detectConflictsNow(ctx, (await app.app.projects.get(ctx, project.id)).project)).length).toBe(0); // not re-raised
  });
});

describe('requirement edits', () => {
  it('creates a new version with the previous value, never mutating history, and audits it', async () => {
    const { state, project, ctx, app } = await begin();
    const r = state.requirements.find((x) => x.key === 'seed_inf_1')!;
    const edited = await app.app.discovery.editRequirement(ctx, project.id, r.id, { statement: 'Decisions must land within two seconds.' });
    expect(edited).toMatchObject({ version: 2, origin: 'USER_STATED', source: 'USER_EDITED', previousStatement: r.statement, confidence: null, tags: [] });
    const history = await app.app.discovery.history(ctx, project.id, r.id);
    expect(history.map((v) => [v.version, v.origin, v.source])).toEqual([[1, 'AI_INFERRED', 'AI_INFERRED'], [2, 'USER_STATED', 'USER_EDITED']]);
    expect(history[1]).toMatchObject({ previousStatement: r.statement, createdById: ctx.userId });
    expect(history[0]!.statement).toBe(r.statement);
    const audit = await h.prisma.auditLog.findMany({ where: { projectId: project.id, action: 'requirement.edited' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain('two seconds'); // text stays out of the audit trail
    expect((await h.prisma.analyticsEvent.count({ where: { projectId: project.id, name: 'requirement_edited' } }))).toBe(1);
    await expect(app.app.discovery.editRequirement(ctx, project.id, r.id, { statement: 'Decisions must land within two seconds.' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses requirements from another project', async () => {
    const a = await begin();
    const b = await begin();
    const foreign = a.state.requirements[0]!;
    await expect(b.app.app.discovery.editRequirement(b.ctx, b.project.id, foreign.id, { statement: 'Hijacked statement here' })).rejects.toMatchObject({ code: 'REQUIREMENT_NOT_FOUND' });
  });
});

describe('authorization', () => {
  it("hides another workspace's discovery completely", async () => {
    const owner = await begin();
    const intruder = await signUp(h.app, 'intruder');
    const id = owner.project.id;
    const round = owner.state.rounds[0]!;
    const attempts = [
      h.app.discovery.getState(intruder.ctx, id), h.app.discovery.start(intruder.ctx, id), h.app.discovery.next(intruder.ctx, id), h.app.discovery.finish(intruder.ctx, id),
      h.app.discovery.askMore(intruder.ctx, id), h.app.discovery.submitAnswers(intruder.ctx, id, round.id, { answers: answerAll(owner.state).answers }),
      h.app.discovery.editRequirement(intruder.ctx, id, owner.state.requirements[0]!.id, { statement: 'Intruder was here' }),
      h.app.briefs.generate(intruder.ctx, id), h.app.briefs.get(intruder.ctx, id),
    ];
    for (const r of await Promise.allSettled(attempts)) expect(r).toMatchObject({ status: 'rejected', reason: { code: 'PROJECT_NOT_FOUND' } });
    expect(await h.prisma.discoveryAnswer.count({ where: { question: { roundId: round.id } } })).toBe(0);
  });

  it('lets viewers read discovery but not change it', async () => {
    const owner = await begin();
    const viewer = await signUp(h.app, 'viewer');
    await h.prisma.workspaceMember.create({ data: { workspaceId: owner.workspace.id, userId: viewer.user.id, role: 'VIEWER' } });
    const id = owner.project.id;
    expect((await h.app.discovery.getState(viewer.ctx, id)).rounds).toHaveLength(1);
    const round = owner.state.rounds[0]!;
    for (const attempt of [
      h.app.discovery.submitAnswers(viewer.ctx, id, round.id, { answers: answerAll(owner.state).answers }), h.app.discovery.finish(viewer.ctx, id),
      h.app.discovery.editRequirement(viewer.ctx, id, owner.state.requirements[0]!.id, { statement: 'Viewer edit attempt' }), h.app.briefs.generate(viewer.ctx, id),
    ]) await expect(attempt).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('architecture brief and confirmation', () => {
  async function ready() {
    const t = await begin();
    let s = await t.app.app.discovery.submitAnswers(t.ctx, t.project.id, t.state.rounds[0]!.id, { answers: answerAll(t.state).answers });
    s = await t.app.app.discovery.next(t.ctx, t.project.id);
    await t.app.app.discovery.submitAnswers(t.ctx, t.project.id, s.rounds[1]!.id, { answers: answerAll(s).answers });
    await t.app.app.discovery.next(t.ctx, t.project.id);
    return t;
  }

  it('is generated from current requirements, grounded in real requirement ids, with persisted drivers', async () => {
    const { project, ctx, app } = await ready();
    const view = await app.app.briefs.generate(ctx, project.id);
    expect(view.version).toMatchObject({ version: 1, ai: { promptId: 'ARCHITECTURE_BRIEF_GENERATOR', promptVersion: 1 } });
    expect(view.stale).toBe(false);
    expect(view.blockers).toEqual([]);
    const known = new Set(view.requirements.map((r) => r.id));
    const c = view.version.content;
    const cited = [...c.functionalRequirements, ...c.performanceRequirements, ...c.cloudAndDeploymentPreferences].flatMap((i) => i.requirementIds);
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((id) => known.has(id))).toBe(true);
    expect(c.architectureDrivers.length).toBeGreaterThan(0);
    expect(view.drivers).toHaveLength(c.architectureDrivers.length);
    for (const d of view.drivers) { expect(d.requirementIds.length).toBeGreaterThan(0); d.requirementIds.forEach((id) => expect(known.has(id)).toBe(true)); }
    // inferred requirements are surfaced as assumptions, never as user statements
    const inferredIds = new Set(view.requirements.filter((r) => r.origin === 'AI_INFERRED').map((r) => r.id));
    expect(c.keyAssumptions.some((a) => a.requirementIds.some((id) => inferredIds.has(id)))).toBe(true);
    expect((await h.prisma.analyticsEvent.count({ where: { projectId: project.id, name: 'brief_generated' } }))).toBe(1);
  });

  it('cannot be generated before discovery is finished', async () => {
    const { project, ctx, app } = await begin();
    await expect(app.app.briefs.generate(ctx, project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('is rejected and not stored when the model returns a brief with no architecture drivers', async () => {
    const { project, ctx } = await ready();
    const view = await h.app.briefs.generate(ctx, project.id);
    const noDrivers = JSON.stringify({ ...view.version.content, architectureDrivers: [] });
    const s = makeApp({ script: [noDrivers, noDrivers] });
    try {
      await expect(s.app.briefs.generate(ctx, project.id)).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
      expect(await h.prisma.architectureBriefVersion.count({ where: { brief: { projectId: project.id } } })).toBe(1);
    } finally { await s.prisma.$disconnect(); }
  });

  it('is rejected when the model cites requirements that do not exist', async () => {
    const { project, ctx } = await ready();
    const base = mockBrief({ interpretation: { summary: 'A real summary here.', problemStatement: 'A real problem here.' }, requirements: [], openUnknowns: [] });
    const bad = JSON.stringify({ ...base, functionalRequirements: [{ text: 'Invented feature', requirementIds: ['not-a-real-id'] }], architectureDrivers: [{ id: 'd1', name: 'Invented', description: 'Made up driver', priority: 'HIGH', sourceRequirementIds: ['not-a-real-id'] }] });
    const s = makeApp({ script: [bad, bad] });
    try { await expect(s.app.briefs.generate(ctx, project.id)).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' }); } finally { await s.prisma.$disconnect(); }
  });

  it('goes stale after an edit, can be regenerated as a new version, and only the latest version can be confirmed', async () => {
    const { project, ctx, app } = await ready();
    const v1 = await app.app.briefs.generate(ctx, project.id);
    const target = v1.requirements.find((r) => r.key === 'seed_inf_1')!;
    await app.app.discovery.editRequirement(ctx, project.id, target.id, { statement: 'Updated wording of this requirement.' });
    expect((await app.app.briefs.get(ctx, project.id)).stale).toBe(true);
    const v2 = await app.app.briefs.generate(ctx, project.id);
    expect(v2).toMatchObject({ stale: false, version: { version: 2 } });
    expect(await h.prisma.architectureBriefVersion.count({ where: { brief: { projectId: project.id } } })).toBe(2);
    await expect(app.app.briefs.confirm(ctx, project.id, { briefVersionId: v1.version.id, acceptedUnknownIds: [] })).rejects.toMatchObject({ code: 'BRIEF_STALE' });
  });

  it('confirms: records who and when, moves to REQUIREMENTS_CONFIRMED, and then locks discovery', async () => {
    const { project, ctx, app } = await ready();
    const view = await app.app.briefs.generate(ctx, project.id);
    const done = await app.app.briefs.confirm(ctx, project.id, { briefVersionId: view.version.id, acceptedUnknownIds: [] });
    expect(done.project.status).toBe('REQUIREMENTS_CONFIRMED');
    expect(done.version).toMatchObject({ confirmedById: ctx.userId });
    expect(done.version.confirmedAt).toBeInstanceOf(Date);
    expect(done.brief).toMatchObject({ status: 'CONFIRMED', confirmedVersionId: view.version.id });
    const stored = (await app.app.projects.get(ctx, project.id)).project;
    expect(stored.status).toBe('REQUIREMENTS_CONFIRMED');
    expect(canStartArchitectureGeneration(stored.status)).toBe(true);
    expect(await h.prisma.auditLog.count({ where: { projectId: project.id, action: 'requirements.confirmed' } })).toBe(1);
    expect(await h.prisma.analyticsEvent.count({ where: { projectId: project.id, name: 'requirements_confirmed' } })).toBe(1);
    // invalid transitions are refused
    await expect(app.app.discovery.start(ctx, project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(app.app.briefs.generate(ctx, project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(app.app.discovery.editRequirement(ctx, project.id, view.requirements[0]!.id, { statement: 'Too late to edit now' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(app.app.briefs.confirm(ctx, project.id, { briefVersionId: view.version.id, acceptedUnknownIds: [] })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('requires critical unknowns to be explicitly accepted as assumptions', async () => {
    const { project, ctx, app } = await begin();
    await app.app.discovery.finish(ctx, project.id); // nothing answered: U1-U4 stay critical and open
    const view = await app.app.briefs.generate(ctx, project.id);
    expect(view.criticalUnknowns.map((u) => u.id)).toEqual(['U1', 'U2', 'U3', 'U4']);
    await expect(app.app.briefs.confirm(ctx, project.id, { briefVersionId: view.version.id, acceptedUnknownIds: ['U1'] }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_BLOCKED', details: { unacceptedUnknownIds: ['U2', 'U3', 'U4'] } });
    await expect(app.app.briefs.confirm(ctx, project.id, { briefVersionId: view.version.id, acceptedUnknownIds: ['U1', 'U2', 'U3', 'U4', 'U99'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const done = await app.app.briefs.confirm(ctx, project.id, { briefVersionId: view.version.id, acceptedUnknownIds: ['U1', 'U2', 'U3', 'U4'] });
    expect(done.unknowns.filter((u) => u.status === 'ACCEPTED').map((u) => u.id)).toEqual(['U1', 'U2', 'U3', 'U4']);
    expect(done.version.acceptedUnknownIds).toEqual(['U1', 'U2', 'U3', 'U4']);
    expect(done.version.content.openQuestions.length).toBe(5); // still visible as open assumptions
  });

  it('lets exactly one of two simultaneous confirmations win', async () => {
    const { project, ctx, app } = await ready();
    const view = await app.app.briefs.generate(ctx, project.id);
    const input = { briefVersionId: view.version.id, acceptedUnknownIds: [] };
    const results = await Promise.allSettled([app.app.briefs.confirm(ctx, project.id, input), app.app.briefs.confirm(ctx, project.id, input)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'INVALID_STATE' } });
    expect(await h.prisma.auditLog.count({ where: { projectId: project.id, action: 'requirements.confirmed' } })).toBe(1);
  });
});
