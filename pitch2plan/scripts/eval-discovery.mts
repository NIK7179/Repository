/**
 * Discovery quality evaluation. Runs the four reference ideas through interpretation and the first
 * discovery round (and, with --deep, answers them and runs the second round), then prints every question
 * for HUMAN review plus a few mechanical comparisons.
 *
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run eval:discovery            # round 1
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run eval:discovery -- --deep  # + answers + round 2
 *
 * With the default mock provider this only smoke-tests the harness. Mock output says NOTHING about question quality.
 * Schema validity is not quality: read the questions.
 */
import { writeFileSync } from 'node:fs';
import { AnthropicLLMProvider, IdeaInterpreter, LLMGateway, MockLLMProvider, createDiscoveryAi, type LLMProvider } from '@pitch2plan/ai';
import { seedRequirementsFromInterpretation, unknownsFromInterpretation } from '@pitch2plan/domain';
import type { AnsweredQuestion, AnswerInput, ClarificationInput, DiscoveryQuestion, DiscoveryUnknown, RequirementSnapshot } from '@pitch2plan/schemas';
import { describeChoice } from '@pitch2plan/schemas';

const CASES = [
  { name: 'CASE 1 — Streaming data', pitch: 'I want to collect transaction events from multiple applications, process them in real time, and store processed data for analytics.' },
  { name: 'CASE 2 — Simple SaaS', pitch: 'I want to build a scheduling app for independent fitness trainers and their clients.' },
  { name: 'CASE 3 — AI / RAG', pitch: 'I want companies to upload internal documents and let employees ask questions about them.' },
  { name: 'CASE 4 — Ambiguous idea', pitch: 'I want to build the next big social platform.' },
];
const live = process.env.AI_PROVIDER === 'anthropic';
const deep = process.argv.includes('--deep');
const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
const provider: LLMProvider = live ? new AnthropicLLMProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, defaultModel: model }) : new MockLLMProvider();
const tokens = { in: 0, out: 0 };
const gateway = new LLMGateway({ provider, model: live ? model : 'mock-1', timeoutMs: 120_000, maxRetries: 2, onUsage: (e) => { tokens.in += e.inputTokens ?? 0; tokens.out += e.outputTokens ?? 0; } });
const ai = createDiscoveryAi(gateway);
const context = { workspaceId: 'eval', projectId: 'eval', userId: 'eval' };
const lines: string[] = [];
const say = (s = '') => { console.log(s); lines.push(s); };

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
const jaccard = (a: Set<string>, b: Set<string>) => { let i = 0; for (const x of a) if (b.has(x)) i++; return a.size + b.size - i ? i / (a.size + b.size - i) : 0; };

const results: Array<{ name: string; questions: DiscoveryQuestion[] }> = [];
say(`# Discovery evaluation (${live ? `LIVE: ${model}` : 'MOCK provider: harness smoke test only, NOT a quality evaluation'})`);

for (const c of CASES) {
  say(`\n## ${c.name}\n> ${c.pitch}\n`);
  const interp = (await new IdeaInterpreter(gateway).interpret({ ...context, pitch: c.pitch })).output;
  let unknowns: DiscoveryUnknown[] = unknownsFromInterpretation(interp);
  let requirements: RequirementSnapshot[] = seedRequirementsFromInterpretation(interp).map((s, i) => ({
    id: `r${i}`, key: s.key, category: s.category, statement: s.statement, value: null, origin: s.origin, confidence: s.confidence, tags: s.tags, version: 1,
  }));
  say(`Interpretation unknowns: ${unknowns.map((u) => `${u.id} ${u.text}`).join(' | ')}`);
  const priorQuestions: ClarificationInput['priorQuestions'] = [];
  const priorAnswers: AnsweredQuestion[] = [];

  for (let round = 1; round <= (deep ? 2 : 1); round++) {
    const input: ClarificationInput = {
      context, pitch: c.pitch, interpretation: interp, requirements, priorQuestions, priorAnswers, openUnknowns: unknowns.filter((u) => u.status === 'OPEN'),
      roundNumber: round, limits: { maxQuestions: 6, maxRounds: 3 },
    };
    const { output, ai: meta } = await ai.generateQuestions(input);
    say(`\n### Round ${round}: ${output.questions.length} questions · canGenerateBrief=${output.canGenerateBrief} · repaired=${meta.repaired}`);
    if (output.reasonForAnotherRound) say(`Why another round: ${output.reasonForAnotherRound}`);
    if (output.newUnknowns.length) say(`Gaps the generator added beyond the interpreter: ${output.newUnknowns.map((n) => `${n.id} ${n.text}${n.critical ? ' (critical)' : ''}`).join(' | ')}`);
    output.questions.forEach((q, i) => {
      say(`\n${i + 1}. [${q.category} · ${q.answerType} · ${q.priority}${q.allowRecommendation ? ' · recommend✓' : ''}] ${q.question}`);
      say(`   why: ${q.whyItMatters}   (unknowns: ${q.relatedUnknowns.join(',')})`);
      q.options.forEach((o) => say(`   - ${o.label}${o.description ? ` — ${o.description}` : ''}`));
    });
    if (round === 1) results.push({ name: c.name, questions: output.questions });
    if (!deep || round === 2 || output.questions.length === 0) break;

    // Answer the round: first option, or "Recommend for me" on every other recommendable question.
    const answers: AnswerInput[] = output.questions.map((q, i) => ({
      questionId: q.id,
      choice: q.allowRecommendation && i % 2 === 1 ? { kind: 'RECOMMEND' } : q.answerType === 'FREE_TEXT' ? { kind: 'FREE_TEXT', text: 'No strong preference' }
        : q.answerType === 'BOOLEAN' ? { kind: 'BOOLEAN', value: true } : q.answerType === 'NUMBER_RANGE' ? { kind: 'NUMBER_RANGE', min: q.numberRange!.min, max: q.numberRange!.max }
        : { kind: 'OPTIONS', optionIds: [q.options[0]!.id] },
    }));
    const ex = (await ai.extractRequirements({ context, pitch: c.pitch, interpretation: interp, requirements, questions: output.questions, answers, openUnknowns: input.openUnknowns })).output;
    say(`\nExtraction: +${ex.newRequirements.length} new, ${ex.updatedRequirements.length} updated, resolved ${ex.resolvedUnknownIds.join(',') || 'none'}`);
    ex.recommendations.forEach((r) => say(`   recommended for ${r.questionId}: ${r.resolvedValue} (${r.reason})`));
    ex.newRequirements.forEach((r) => say(`   + [${r.origin}] ${r.statement}`));
    requirements = [...requirements, ...ex.newRequirements.map((r, i) => ({ id: `n${round}${i}`, key: r.key, category: r.category, statement: r.statement, value: r.value, origin: r.origin, confidence: r.confidence, tags: r.tags, version: 1 }))];
    unknowns = unknowns.map((u) => (ex.resolvedUnknownIds.includes(u.id) ? { ...u, status: 'RESOLVED' as const } : u)).concat(ex.newUnknowns.map((n, i) => ({ id: `U${unknowns.length + i + 1}`, text: n.text, status: 'OPEN' as const, critical: n.critical })));
    output.questions.forEach((q) => {
      priorQuestions.push({ id: q.id, question: q.question, category: q.category, relatedUnknowns: q.relatedUnknowns });
      const a = answers.find((x) => x.questionId === q.id)!;
      priorAnswers.push({ questionId: q.id, question: q.question, category: q.category, answer: describeChoice(q, a.choice), recommended: a.choice.kind === 'RECOMMEND' });
    });
  }
}

say('\n## Mechanical comparison (a prompt for your judgement, not a verdict)');
say('Round-1 question-text similarity between cases (0 = nothing in common, 1 = identical):');
for (let i = 0; i < results.length; i++) for (let j = i + 1; j < results.length; j++) {
  const a = results[i]!, b = results[j]!;
  const sims = a.questions.map((q) => Math.max(0, ...b.questions.map((p) => jaccard(words(q.question), words(p.question)))));
  const avg = sims.length ? sims.reduce((x, y) => x + y, 0) / sims.length : 0;
  const cats = (r: typeof a) => new Set(r.questions.map((q) => q.category));
  say(`  ${a.name.split(' — ')[1]} vs ${b.name.split(' — ')[1]}: mean best-match ${avg.toFixed(2)} · shared categories: ${[...cats(a)].filter((c) => cats(b).has(c)).join(', ') || 'none'}`);
}
say(`Question counts per case: ${results.map((r) => `${r.name.split(' — ')[1]}=${r.questions.length}`).join(', ')}`);
say(`Tokens used: ${tokens.in} in / ${tokens.out} out`);
say('\nREVIEW CHECKLIST: (1) Does each case get questions a real architect would ask for THAT idea? (2) Anything irrelevant, e.g. streaming-throughput questions for the scheduling app? (3) Is the ambiguous idea probed about WHAT it is before scale? (4) Plain language? (5) Any technology named?');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
if (out) writeFileSync(out, lines.join('\n') + '\n');
