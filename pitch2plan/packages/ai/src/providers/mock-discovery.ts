import { inferTagsFromText } from '@pitch2plan/schemas';
import { parseDataBlock } from '../prompts/util';

/**
 * Development/test heuristics for the discovery capabilities. They are NOT product logic and contain no
 * architecture knowledge: questions are derived from whichever open unknowns the caller provides, so
 * rounds terminate and adapt to input. Real question quality comes from the Claude provider.
 */
type Unknown = { id: string; text: string; status?: string };
type Opt = [string, string];

const TOPICS: Array<{ re: RegExp; category: string; q: string; opts: Opt[] }> = [
  { re: /volume|how many|traffic|events|requests|data size|load|growth|scale/i, category: 'TRAFFIC', q: 'How much activity do you expect once this is live?',
    opts: [['Small', 'Up to a few hundred users or events a day'], ['Medium', 'Thousands per day'], ['Large', 'Hundreds of thousands per day'], ['Very large', 'Millions per day or more']] },
  { re: /latency|real-?time|processing mode|speed|response|timing/i, category: 'LATENCY', q: 'How quickly does this information need to be processed?',
    opts: [['Immediately', 'Usually within a second'], ['Within a minute', 'A short delay is fine'], ['Within several minutes', 'Updates every few minutes'], ['Batch processing is fine', 'Results can wait hours']] },
  { re: /availab|uptime|reliab|downtime/i, category: 'AVAILABILITY', q: 'How bad is it if the system is briefly unavailable?',
    opts: [['Not a problem', 'Occasional downtime is fine'], ['Noticeable', 'Users would be annoyed'], ['Costly', 'It would lose money or trust'], ['Unacceptable', 'It must almost never be down']] },
  { re: /secur|compliance|privacy|regulat|confidential|sensitive/i, category: 'SECURITY', q: 'How sensitive is the information this handles?',
    opts: [['Not sensitive', 'Public or low-risk data'], ['Somewhat sensitive', 'Personal details, normal care needed'], ['Highly sensitive', 'Financial, health or legally protected data']] },
  { re: /budget|cost|team|skills|timeline/i, category: 'BUDGET', q: 'What matters most about cost and effort right now?',
    opts: [['Keep it as cheap as possible', 'Prototype first'], ['Balanced', 'Reasonable cost with room to grow'], ['Quality first', 'Spend what is needed to do it properly']] },
  { re: /cloud|platform|deploy|host|infrastructure/i, category: 'CLOUD', q: 'Where should this run?',
    opts: [['Public cloud (AWS, Azure or Google Cloud)', 'Managed services in a public cloud'], ['On-premises', 'Your own servers'], ['No preference', 'Whatever fits best']] },
];

const letters = 'abcdefgh';

export function mockClarification(input: {
  openUnknowns: Unknown[]; priorQuestions: Array<{ relatedUnknowns: string[] }>; roundNumber: number; limits: { maxQuestions: number };
}) {
  const asked = new Set(input.priorQuestions.flatMap((q) => q.relatedUnknowns));
  const fresh = input.openUnknowns.filter((u) => !asked.has(u.id));
  const pick = fresh.slice(0, Math.min(4, input.limits.maxQuestions));
  if (pick.length === 0) return { questions: [], newUnknowns: [], remainingCriticalUnknowns: [], reasonForAnotherRound: '', canGenerateBrief: true };
  const questions = pick.map((u) => {
    const topic = TOPICS.find((t) => t.re.test(u.text));
    const base = {
      id: `q${input.roundNumber}_${u.id.toLowerCase()}`, required: false, priority: 'HIGH', relatedUnknowns: [u.id],
      whyItMatters: 'Your answer changes which design options are sensible for this project.',
    };
    if (!topic) {
      return { ...base, category: 'OTHER', question: `Tell us more: ${u.text}`, answerType: 'FREE_TEXT', options: [], allowRecommendation: false };
    }
    return {
      ...base, category: topic.category, question: `${topic.q} (${u.text})`, answerType: 'SINGLE_SELECT', allowRecommendation: true,
      options: topic.opts.map(([label, description], i) => ({ id: letters[i]!, label, description })),
    };
  });
  return { questions, newUnknowns: [], remainingCriticalUnknowns: pick.map((u) => u.id), reasonForAnotherRound: `Still to confirm: ${pick.map((u) => u.text).join('; ')}`, canGenerateBrief: false };
}

type MockQuestion = { id: string; category: string; options: Array<{ id: string; label: string }>; relatedUnknowns: string[]; numberRange?: { min: number; max: number } };
type MockAnswer = { questionId: string; kind: string; answer: string };

export function mockExtraction(input: { requirements: Array<{ id: string; key: string }>; questions: MockQuestion[]; answers: MockAnswer[]; openUnknowns: Unknown[] }) {
  const byKey = new Map(input.requirements.map((r) => [r.key, r.id]));
  const qs = new Map(input.questions.map((q) => [q.id, q]));
  const newRequirements: Array<Record<string, unknown>> = [];
  const updatedRequirements: Array<Record<string, unknown>> = [];
  const recommendations: Array<Record<string, unknown>> = [];
  const resolved = new Set<string>();
  const open = new Set(input.openUnknowns.map((u) => u.id));

  for (const a of input.answers) {
    const q = qs.get(a.questionId);
    if (!q || a.kind === 'SKIP') continue;
    const label = q.category.toLowerCase().replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
    const rec = a.kind === 'RECOMMEND';
    let value = a.answer;
    if (rec) {
      value = q.options.length ? (q.category === 'CLOUD' ? q.options.find((o) => /no preference/i.test(o.label)) ?? q.options[0]! : q.options[Math.min(1, q.options.length - 1)]!).label : q.numberRange ? String(Math.round((q.numberRange.min + q.numberRange.max) / 2)) : 'A sensible default for this project';
      recommendations.push({ questionId: q.id, resolvedValue: value, reason: 'Chosen as a balanced default for this kind of project; you can change it any time.' });
    }
    const statement = `${label}: ${value}${rec ? ' (recommended)' : ''}`;
    const draft = {
      category: q.category, statement, value, origin: rec ? 'AI_RECOMMENDED' : 'USER_ANSWERED', confidence: rec ? 0.6 : null,
      sourceQuestionIds: [q.id], tags: inferTagsFromText(value),
    };
    const key = `ans_${q.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    const existingId = byKey.get(key);
    if (existingId) updatedRequirements.push({ ...draft, requirementId: existingId, reason: 'The latest answer replaces the earlier one.' });
    else newRequirements.push({ ...draft, key });
    q.relatedUnknowns.filter((u) => open.has(u)).forEach((u) => resolved.add(u));
  }
  return { newRequirements, updatedRequirements, recommendations, resolvedUnknownIds: [...resolved], newUnknowns: [] };
}

export function mockConflicts() { return { conflicts: [] }; }

const SECTION: Record<string, string> = {
  FUNCTIONAL: 'functionalRequirements', BUSINESS: 'functionalRequirements', USERS: 'targetUsers', TRAFFIC: 'trafficAssumptions', SCALABILITY: 'trafficAssumptions',
  PERFORMANCE: 'performanceRequirements', LATENCY: 'performanceRequirements', AVAILABILITY: 'availabilityRequirements', SECURITY: 'securityRequirements',
  PRIVACY: 'securityRequirements', COMPLIANCE: 'complianceRequirements', DATA: 'dataRequirements', DATA_RETENTION: 'dataRequirements',
  INTEGRATION: 'integrationRequirements', API: 'integrationRequirements', CLOUD: 'cloudAndDeploymentPreferences', DEPLOYMENT: 'cloudAndDeploymentPreferences',
  GEOGRAPHY: 'cloudAndDeploymentPreferences', BUDGET: 'budgetConstraints', TIMELINE: 'budgetConstraints', TEAM_CONSTRAINT: 'teamConstraints', AI_ML: 'aiMlRequirements',
};
const DRIVER_CATEGORIES = new Set(['LATENCY', 'PERFORMANCE', 'AVAILABILITY', 'SCALABILITY', 'TRAFFIC', 'SECURITY', 'COMPLIANCE', 'PRIVACY', 'BUDGET', 'DEPLOYMENT', 'CLOUD', 'DATA']);

export function mockBrief(input: {
  interpretation: { summary: string; problemStatement: string };
  requirements: Array<{ id: string; category: string; statement: string; origin: string }>;
  openUnknowns: Array<{ id: string; text: string }>;
}) {
  const out: Record<string, unknown> = {
    projectSummary: input.interpretation.summary, businessObjective: input.interpretation.problemStatement,
    keyAssumptions: [], openQuestions: input.openUnknowns.map((u) => ({ text: u.text, unknownId: u.id })), risks: [], architectureDrivers: [],
  };
  for (const s of new Set([...Object.values(SECTION), 'nonFunctionalRequirements'])) out[s] = [];
  for (const r of input.requirements) {
    const section = SECTION[r.category] ?? 'nonFunctionalRequirements';
    (out[section] as unknown[]).push({ text: r.statement, requirementIds: [r.id] });
    if (r.origin === 'AI_INFERRED' || r.origin === 'AI_RECOMMENDED') {
      (out.keyAssumptions as unknown[]).push({ text: `We assume: ${r.statement}`, requirementIds: [r.id] });
    }
  }
  const strong = input.requirements.filter((r) => DRIVER_CATEGORIES.has(r.category) && r.origin !== 'SYSTEM_DERIVED').slice(0, 5);
  const drivers = strong.length ? strong : input.requirements.filter((r) => r.category === 'FUNCTIONAL').slice(0, 1);
  out.architectureDrivers = drivers.map((r, i) => ({
    id: `d${i + 1}`, name: r.statement.slice(0, 80), description: r.statement,
    priority: ['SECURITY', 'COMPLIANCE'].includes(r.category) && r.origin.startsWith('USER') ? 'CRITICAL' : 'HIGH', sourceRequirementIds: [r.id],
  }));
  if ((out.keyAssumptions as unknown[]).length) (out.risks as unknown[]).push({ text: 'Some requirements are assumptions that still need your confirmation.', severity: 'MEDIUM' });
  return out;
}

export function mockDiscoveryFor(promptId: string, userContent: string): unknown | undefined {
  switch (promptId) {
    case 'CLARIFICATION_QUESTION_GENERATOR': return mockClarification(parseDataBlock(userContent, 'discovery_input')!);
    case 'REQUIREMENT_EXTRACTOR': return mockExtraction(parseDataBlock(userContent, 'extraction_input')!);
    case 'CONTRADICTION_DETECTOR': return mockConflicts();
    case 'ARCHITECTURE_BRIEF_GENERATOR': return mockBrief(parseDataBlock(userContent, 'brief_input')!);
    default: return undefined;
  }
}
