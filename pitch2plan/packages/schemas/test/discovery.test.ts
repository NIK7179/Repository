import { describe, expect, it } from 'vitest';
import {
  CONFLICT_RULES, detectRuleConflicts, inferTagsFromText, validateAnswers, validateBrief, validateClarificationOutput, validateDetectorOutput, validateExtraction,
  clarificationOutputSchema, discoveryQuestionSchema, architectureBriefSchema,
  type ClarificationOutput, type DiscoveryQuestion, type RequirementSnapshot,
} from '../src';

const q = (over: Partial<DiscoveryQuestion> = {}): DiscoveryQuestion => discoveryQuestionSchema.parse({
  id: 'q1_latency', category: 'LATENCY', question: 'How quickly does this need to respond to people?', whyItMatters: 'It decides how much effort goes into speed.',
  answerType: 'SINGLE_SELECT', required: true, priority: 'HIGH', relatedUnknowns: ['U1'], allowRecommendation: true,
  options: [{ id: 'a', label: 'Instantly' }, { id: 'b', label: 'Within a minute' }, { id: 'c', label: 'Hours are fine' }], ...over,
});
const out = (questions: DiscoveryQuestion[], over: Partial<ClarificationOutput> = {}): ClarificationOutput =>
  ({ questions, newUnknowns: [], remainingCriticalUnknowns: ['U1'], reasonForAnotherRound: 'Latency is still unknown.', canGenerateBrief: false, ...over });
const ctx = { openUnknownIds: ['U1', 'U2'], priorQuestions: [], maxQuestions: 6 };

describe('question schema', () => {
  it('rejects malformed questions (bad id, missing why, no related unknowns)', () => {
    expect(discoveryQuestionSchema.safeParse({ ...q(), id: 'has spaces' }).success).toBe(false);
    expect(discoveryQuestionSchema.safeParse({ ...q(), whyItMatters: 'short' }).success).toBe(false);
    expect(discoveryQuestionSchema.safeParse({ ...q(), relatedUnknowns: [] }).success).toBe(false);
  });
  it('accepts every answer type', () => {
    for (const answerType of ['BOOLEAN', 'FREE_TEXT'] as const) expect(validateClarificationOutput(out([q({ answerType, options: [] })]), ctx)).toEqual([]);
    expect(validateClarificationOutput(out([q({ answerType: 'NUMBER_RANGE', options: [], numberRange: { min: 1, max: 100, unit: 'users' } })]), ctx)).toEqual([]);
  });
});

describe('validateClarificationOutput', () => {
  it('accepts a good round', () => { expect(validateClarificationOutput(out([q()]), ctx)).toEqual([]); });

  it('rejects duplicates of earlier questions, including rewordings, and reused ids', () => {
    const prior = [{ id: 'q0', question: 'How quickly does this need to respond to people?', category: 'LATENCY', relatedUnknowns: ['U1'] }];
    expect(validateClarificationOutput(out([q({ id: 'q9' })]), { ...ctx, priorQuestions: prior }).join()).toMatch(/duplicates an earlier question/);
    expect(validateClarificationOutput(out([q({ id: 'q0', question: 'Completely different wording about security?' })]), { ...ctx, priorQuestions: prior }).join()).toMatch(/already used/);
  });
  it('rejects duplicates within the same round', () => {
    const issues = validateClarificationOutput(out([q(), q({ id: 'q2', question: 'How quickly does this need to respond to people?' })]), ctx);
    expect(issues.join()).toMatch(/duplicates another question/);
  });
  it('rejects invalid options for the answer type', () => {
    expect(validateClarificationOutput(out([q({ options: [{ id: 'a', label: 'Only one', description: '' }] })]), ctx).join()).toMatch(/at least 2 options/);
    expect(validateClarificationOutput(out([q({ options: [{ id: 'a', label: 'X', description: '' }, { id: 'a', label: 'Y', description: '' }] })]), ctx).join()).toMatch(/ids must be unique/);
    expect(validateClarificationOutput(out([q({ options: [{ id: 'a', label: 'Same', description: '' }, { id: 'b', label: 'same', description: '' }] })]), ctx).join()).toMatch(/labels must be unique/);
    expect(validateClarificationOutput(out([q({ answerType: 'BOOLEAN' })]), ctx).join()).toMatch(/must not have options/);
    expect(validateClarificationOutput(out([q({ answerType: 'NUMBER_RANGE', options: [] })]), ctx).join()).toMatch(/numberRange/);
  });
  it('rejects a hand-written "Recommend for me" option', () => {
    const bad = q({ options: [{ id: 'a', label: 'Instantly', description: '' }, { id: 'b', label: 'Recommend for me', description: '' }] });
    expect(validateClarificationOutput(out([bad]), ctx).join()).toMatch(/Recommend for me/);
  });
  it('rejects questions that do not map to an open unknown (no architectural relevance)', () => {
    expect(validateClarificationOutput(out([q({ relatedUnknowns: ['U99'] })]), ctx).join()).toMatch(/unknown or already-resolved id "U99"/);
    expect(validateClarificationOutput(out([q({ relatedUnknowns: ['U3'] })]), { ...ctx, openUnknownIds: ['U1'] }).join()).toMatch(/U3/);
  });
  it('rejects technology names in discovery but allows them where they are constraints', () => {
    const tech = q({ question: 'Would you rather use Kafka or RabbitMQ for events?', options: [{ id: 'a', label: 'Kafka', description: '' }, { id: 'b', label: 'RabbitMQ', description: '' }] });
    expect(validateClarificationOutput(out([tech]), ctx).join()).toMatch(/names a technology/);
    const cloud = q({ category: 'CLOUD', question: 'Which platform should this run on?', options: [{ id: 'a', label: 'AWS', description: '' }, { id: 'b', label: 'On-premises', description: '' }] });
    expect(validateClarificationOutput(out([cloud]), ctx)).toEqual([]);
    const team = q({ category: 'TEAM_CONSTRAINT', question: 'Does your team already know Python or React?', options: [{ id: 'a', label: 'Python', description: '' }, { id: 'b', label: 'Neither', description: '' }] });
    expect(validateClarificationOutput(out([team]), ctx)).toEqual([]);
  });
  it('enforces the question cap and the stopping contract', () => {
    const many = Array.from({ length: 4 }, (_, i) => q({ id: `q${i}`, question: `Entirely different question number ${i} about topic ${'abcd'[i]}${'wxyz'[i]}?` }));
    expect(validateClarificationOutput(out(many), { ...ctx, maxQuestions: 3 }).join()).toMatch(/Too many questions/);
    expect(validateClarificationOutput(out([], { canGenerateBrief: false }), ctx).join()).toMatch(/No questions were returned/);
    expect(validateClarificationOutput(out([], { canGenerateBrief: true, remainingCriticalUnknowns: ['U1'] }), ctx).join()).toMatch(/Critical unknowns block/);
    expect(validateClarificationOutput(out([], { canGenerateBrief: true, remainingCriticalUnknowns: [] }), ctx)).toEqual([]);
    expect(validateClarificationOutput(out([q()], { reasonForAnotherRound: ' ' }), ctx).join()).toMatch(/reasonForAnotherRound/);
  });
  it('parses through the output schema with defaults applied', () => {
    const parsed = clarificationOutputSchema.parse({ questions: [{ ...q(), options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }], remainingCriticalUnknowns: [], reasonForAnotherRound: '', canGenerateBrief: true });
    expect(parsed.questions[0]!.options[0]!.description).toBe('');
  });
});

describe('newUnknowns (gaps the interpreter missed)', () => {
  const withNew = (qs: DiscoveryQuestion[], n: ClarificationOutput['newUnknowns'], over: Partial<ClarificationOutput> = {}) => out(qs, { newUnknowns: n, ...over });
  it('lets a question reference a newly added unknown', () => {
    const n = [{ id: 'N1', text: 'How confidential are the uploaded documents?', critical: true }];
    expect(validateClarificationOutput(withNew([q({ relatedUnknowns: ['N1'] })], n, { remainingCriticalUnknowns: ['N1'] }), ctx)).toEqual([]);
  });
  it('still rejects references to ids that were neither open nor added', () => {
    expect(validateClarificationOutput(withNew([q({ relatedUnknowns: ['N2'] })], [{ id: 'N1', text: 'Something genuinely new here', critical: false }]), ctx).join()).toMatch(/N2/);
  });
  it('rejects duplicate temporary ids and unknowns that restate an existing one', () => {
    const dup = [{ id: 'N1', text: 'Some brand new unknown', critical: true }, { id: 'N1', text: 'Another brand new unknown', critical: true }];
    expect(validateClarificationOutput(withNew([q()], dup), ctx).join()).toMatch(/duplicate id "N1"/);
    const restated = [{ id: 'N1', text: 'expected data or request volume', critical: true }];
    expect(validateClarificationOutput(withNew([q()], restated), { ...ctx, openUnknownTexts: ['Expected data or request volume'] }).join()).toMatch(/duplicates an existing unknown/);
  });
  it('requires temporary ids in the N-format', () => {
    expect(clarificationOutputSchema.safeParse({ questions: [], newUnknowns: [{ id: 'U9', text: 'Pretending to be stable', critical: true }], remainingCriticalUnknowns: [], reasonForAnotherRound: '', canGenerateBrief: true }).success).toBe(false);
  });
});

describe('validateAnswers', () => {
  const single = q();
  const multi = q({ id: 'q2', answerType: 'MULTI_SELECT', required: false });
  const range = q({ id: 'q3', answerType: 'NUMBER_RANGE', options: [], numberRange: { min: 0, max: 100 }, required: false, advanced: [{ key: 'rps', label: 'Requests/s' }] });
  const all = [single, multi, range];
  it('accepts valid answers of every shape', () => {
    expect(validateAnswers(all, [
      { questionId: 'q1_latency', choice: { kind: 'OPTIONS', optionIds: ['a'] } },
      { questionId: 'q2', choice: { kind: 'OPTIONS', optionIds: ['a', 'b'] } },
      { questionId: 'q3', choice: { kind: 'NUMBER_RANGE', min: 5, max: 50 }, advanced: { rps: 200 } },
    ])).toEqual([]);
  });
  it('rejects unknown options, wrong shapes, bad ranges, unknown advanced fields and duplicates', () => {
    const bad = (a: Parameters<typeof validateAnswers>[1]) => validateAnswers(all, [{ questionId: 'q1_latency', choice: { kind: 'OPTIONS', optionIds: ['a'] } }, ...a]).join();
    expect(bad([{ questionId: 'q2', choice: { kind: 'OPTIONS', optionIds: ['zzz'] } }])).toMatch(/does not exist/);
    expect(bad([{ questionId: 'q2', choice: { kind: 'BOOLEAN', value: true } }])).toMatch(/expects a MULTI_SELECT/);
    expect(bad([{ questionId: 'q3', choice: { kind: 'NUMBER_RANGE', min: 50, max: 5 } }])).toMatch(/cannot exceed/);
    expect(bad([{ questionId: 'q3', choice: { kind: 'NUMBER_RANGE', min: 0, max: 500 } }])).toMatch(/between 0 and 100/);
    expect(bad([{ questionId: 'q3', choice: { kind: 'NUMBER_RANGE', min: 1, max: 2 }, advanced: { nope: 1 } }])).toMatch(/unknown advanced field/);
    expect(bad([{ questionId: 'ghost', choice: { kind: 'SKIP' } }])).toMatch(/Unknown question/);
    expect(bad([{ questionId: 'q2', choice: { kind: 'SKIP' } }, { questionId: 'q2', choice: { kind: 'SKIP' } }])).toMatch(/more than once/);
    expect(validateAnswers([single], [{ questionId: 'q1_latency', choice: { kind: 'OPTIONS', optionIds: ['a', 'b'] } }]).join()).toMatch(/exactly one/);
  });
  it('requires required questions and only allows RECOMMEND where permitted', () => {
    expect(validateAnswers([single], []).join()).toMatch(/required/);
    expect(validateAnswers([single], [{ questionId: 'q1_latency', choice: { kind: 'SKIP' } }]).join()).toMatch(/required/);
    expect(validateAnswers([single], [{ questionId: 'q1_latency', choice: { kind: 'RECOMMEND' } }])).toEqual([]);
    expect(validateAnswers([q({ allowRecommendation: false })], [{ questionId: 'q1_latency', choice: { kind: 'RECOMMEND' } }]).join()).toMatch(/does not allow a recommendation/);
  });
});

describe('validateExtraction (origins must never blur)', () => {
  const existing: RequirementSnapshot[] = [
    { id: 'r1', key: 'seed_fact_1', category: 'FUNCTIONAL', statement: 'Detect fraud', value: null, origin: 'USER_STATED', confidence: null, tags: [], version: 1 },
    { id: 'r2', key: 'seed_inf_1', category: 'PERFORMANCE', statement: 'Low latency likely', value: null, origin: 'AI_INFERRED', confidence: 0.6, tags: [], version: 1 },
  ];
  const questions = [q(), q({ id: 'q2', question: 'Entirely different question about budget and money?', category: 'BUDGET' })];
  const base = { pitch: 'I want to detect fraud in payments.', existing, questions, openUnknownIds: ['U1'], answers: [
    { questionId: 'q1_latency', choice: { kind: 'OPTIONS' as const, optionIds: ['a'] } }, { questionId: 'q2', choice: { kind: 'RECOMMEND' as const } },
  ] };
  const draft = (o: object) => ({ key: 'k_one', category: 'LATENCY', statement: 'A statement here', value: null, confidence: null, sourceQuestionIds: [], tags: [], ...o });
  const empty = { newRequirements: [], updatedRequirements: [], recommendations: [], resolvedUnknownIds: [], newUnknowns: [] };
  const good = {
    ...empty,
    newRequirements: [draft({ key: 'k_lat', origin: 'USER_ANSWERED', sourceQuestionIds: ['q1_latency'] }), draft({ key: 'k_bud', category: 'BUDGET', origin: 'AI_RECOMMENDED', confidence: 0.6, sourceQuestionIds: ['q2'] })] as never,
    recommendations: [{ questionId: 'q2', resolvedValue: 'Balanced', reason: 'A balanced default fits this project.' }],
  };
  it('accepts a coherent extraction', () => { expect(validateExtraction(good, base)).toEqual([]); });
  it('rejects USER_STATED without a verbatim quote, and accepts one with it', () => {
    const bad = { ...good, newRequirements: [...good.newRequirements, draft({ key: 'k_fab', origin: 'USER_STATED', quote: 'We need blockchain' })] as never };
    expect(validateExtraction(bad, base).join()).toMatch(/verbatim/);
    const ok = { ...good, newRequirements: [...good.newRequirements, draft({ key: 'k_ok', origin: 'USER_STATED', quote: 'DETECT fraud in payments' })] as never };
    expect(validateExtraction(ok, base)).toEqual([]);
  });
  it('rejects USER_ANSWERED that cites a recommended or unasked question, and AI_RECOMMENDED that cites a real answer', () => {
    const a = { ...good, newRequirements: [draft({ key: 'k_x', origin: 'USER_ANSWERED', sourceQuestionIds: ['q2'] })] as never };
    expect(validateExtraction(a, base).join()).toMatch(/USER_ANSWERED must cite only questions the user actually answered/);
    const b = { ...good, newRequirements: [draft({ key: 'k_y', origin: 'AI_RECOMMENDED', confidence: 0.5, sourceQuestionIds: ['q1_latency'] })] as never };
    expect(validateExtraction(b, base).join()).toMatch(/AI_RECOMMENDED must cite only questions where the user chose/);
    const c = { ...good, newRequirements: [draft({ key: 'k_z', origin: 'USER_ANSWERED', sourceQuestionIds: ['q_never_asked'] })] as never };
    expect(validateExtraction(c, base).join()).toMatch(/not asked in this round/);
  });
  it('requires confidence on inferred and recommended requirements', () => {
    const bad = { ...good, newRequirements: [draft({ key: 'k_c', origin: 'AI_INFERRED' })] as never };
    expect(validateExtraction(bad, base).join()).toMatch(/requires a confidence/);
  });
  it('does not allow an AI-origin update to overwrite a user-stated requirement', () => {
    const bad = { ...good, updatedRequirements: [{ ...draft({ origin: 'AI_INFERRED', confidence: 0.7 }), key: undefined, requirementId: 'r1', reason: 'x' }] as never };
    expect(validateExtraction(bad, base).join()).toMatch(/may not overwrite/);
    const fine = { ...good, updatedRequirements: [{ ...draft({ origin: 'AI_INFERRED', confidence: 0.7 }), key: undefined, requirementId: 'r2', reason: 'x' }] as never };
    expect(validateExtraction(fine, base)).toEqual([]);
  });
  it('requires a recommendation for every "Recommend for me" answer and nothing extra', () => {
    expect(validateExtraction({ ...good, recommendations: [] }, base).join()).toMatch(/Missing recommendation for question "q2"/);
    expect(validateExtraction({ ...good, recommendations: [...good.recommendations, { questionId: 'q1_latency', resolvedValue: 'x', reason: 'because reasons' }] }, base).join()).toMatch(/not answered with "Recommend for me"/);
  });
  it('requires every answer to be reflected in a requirement, a fresh key, and open unknown ids', () => {
    expect(validateExtraction({ ...good, newRequirements: [good.newRequirements[1]!] as never }, base).join()).toMatch(/not reflected in any requirement/);
    expect(validateExtraction({ ...good, newRequirements: [...good.newRequirements, draft({ key: 'seed_fact_1', origin: 'AI_INFERRED', confidence: 0.5 })] as never }, base).join()).toMatch(/key already exists/);
    expect(validateExtraction({ ...good, resolvedUnknownIds: ['U7'] }, base).join()).toMatch(/U7/);
  });
});

describe('validateBrief', () => {
  const item = (id: string) => ({ text: 'Something', requirementIds: [id] });
  const brief = (over: object = {}) => architectureBriefSchema.parse({
    projectSummary: 'A summary of the project.', businessObjective: 'An objective for the business.', functionalRequirements: [item('r1')],
    architectureDrivers: [{ id: 'd1', name: 'Fast decisions', description: 'Decisions must be quick', priority: 'HIGH', sourceRequirementIds: ['r1'] }], ...over,
  });
  it('accepts a grounded brief', () => { expect(validateBrief(brief(), ['r1'], true)).toEqual([]); });
  it('rejects references to requirements that do not exist (no invented content)', () => {
    expect(validateBrief(brief({ securityRequirements: [item('ghost')] }), ['r1'], true).join()).toMatch(/unknown requirement id "ghost"/);
    expect(validateBrief(brief({ keyAssumptions: [{ text: 'x y z', requirementIds: ['nope'] }] }), ['r1'], true).join()).toMatch(/nope/);
  });
  it('requires architecture drivers, unique driver ids, and functional items when functional requirements exist', () => {
    expect(validateBrief(brief({ architectureDrivers: [] }), ['r1'], true).join()).toMatch(/At least one architecture driver/);
    const d = { id: 'd1', name: 'Driver', description: 'Desc here', priority: 'LOW', sourceRequirementIds: ['r1'] };
    expect(validateBrief(brief({ architectureDrivers: [d, d] }), ['r1'], true).join()).toMatch(/duplicate id/);
    expect(validateBrief(brief({ functionalRequirements: [] }), ['r1'], true).join()).toMatch(/functionalRequirements is empty/);
    expect(validateBrief(brief({ functionalRequirements: [] }), ['r1'], false).join()).not.toMatch(/functionalRequirements is empty/);
  });
});

describe('conflict rules', () => {
  it('infers tags from plain language', () => {
    expect(inferTagsFromText('It must run entirely on-premises')).toEqual(['DEPLOYMENT_ON_PREM']);
    expect(inferTagsFromText('Hosted on AWS')).toEqual(['DEPLOYMENT_PUBLIC_CLOUD']);
    expect(inferTagsFromText('Decisions in under 100 ms, real time')).toEqual(['PROCESSING_REAL_TIME']);
    expect(inferTagsFromText('Process everything in an hourly batch')).toEqual(['PROCESSING_BATCH']);
    expect(inferTagsFromText('We want a pretty logo')).toEqual([]);
  });
  it('detects on-prem vs cloud and real-time vs batch, with stable fingerprints', () => {
    const reqs = [
      { id: 'a', statement: 'Run on-premises', tags: ['DEPLOYMENT_ON_PREM'] }, { id: 'b', statement: 'Use AWS', tags: ['DEPLOYMENT_PUBLIC_CLOUD'] },
      { id: 'c', statement: 'Respond in real time', tags: ['PROCESSING_REAL_TIME'] }, { id: 'd', statement: 'Hourly batch', tags: ['PROCESSING_BATCH'] },
      { id: 'e', statement: 'Hybrid', tags: ['DEPLOYMENT_HYBRID'] },
    ];
    const found = detectRuleConflicts(reqs);
    expect(found.map((c) => c.ruleId).sort()).toEqual(['DEPLOYMENT_MODEL', 'PROCESSING_LATENCY']);
    expect(found.find((c) => c.ruleId === 'DEPLOYMENT_MODEL')!.fingerprint).toBe('RULE:DEPLOYMENT_MODEL:a+b');
    expect(detectRuleConflicts(reqs.slice(0, 1))).toEqual([]);
  });
  it('never pairs a requirement with itself, even if it carries both tags', () => {
    expect(detectRuleConflicts([{ id: 'a', statement: 'Hybrid-ish', tags: ['DEPLOYMENT_ON_PREM', 'DEPLOYMENT_PUBLIC_CLOUD'] }])).toEqual([]);
  });
  it('is extensible: a custom rule is applied without changing the engine', () => {
    const rule = { id: 'X', title: 'X', a: ['DEPLOYMENT_HYBRID' as const], b: ['PROCESSING_BATCH' as const], explain: 'x' };
    const found = detectRuleConflicts([{ id: 'h', statement: 's1', tags: ['DEPLOYMENT_HYBRID'] }, { id: 'b', statement: 's2', tags: ['PROCESSING_BATCH'] }], [...CONFLICT_RULES, rule]);
    expect(found).toHaveLength(1);
  });
  it('validates AI detector output against real requirement keys', () => {
    expect(validateDetectorOutput({ conflicts: [{ title: 'Clash', description: 'These cannot both hold.', severity: 'HIGH', requirementKeys: ['a', 'zzz'] }] }, ['a', 'b']).join()).toMatch(/zzz/);
  });
});
