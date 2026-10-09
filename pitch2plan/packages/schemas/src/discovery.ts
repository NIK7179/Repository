import { z } from 'zod';
import { normalizeForQuote } from './interpretation';
import { requirementTagSchema } from './conflicts';

export const REQUIREMENT_CATEGORIES = [
  'BUSINESS', 'FUNCTIONAL', 'USERS', 'TRAFFIC', 'PERFORMANCE', 'LATENCY', 'AVAILABILITY', 'SCALABILITY', 'DATA', 'DATA_RETENTION',
  'SECURITY', 'COMPLIANCE', 'PRIVACY', 'CLOUD', 'INTEGRATION', 'BUDGET', 'OBSERVABILITY', 'DEPLOYMENT', 'GEOGRAPHY', 'AI_ML',
  'MOBILE', 'WEB', 'API', 'TEAM_CONSTRAINT', 'TIMELINE', 'OTHER',
] as const;
export const requirementCategorySchema = z.enum(REQUIREMENT_CATEGORIES);
export type RequirementCategory = z.infer<typeof requirementCategorySchema>;

export const ORIGINS = ['USER_STATED', 'USER_ANSWERED', 'AI_INFERRED', 'AI_RECOMMENDED', 'SYSTEM_DERIVED'] as const;
export const requirementOriginSchema = z.enum(ORIGINS);
export type RequirementOrigin = z.infer<typeof requirementOriginSchema>;
/** A version's source additionally records manual edits. After an edit the requirement's origin becomes USER_STATED. */
export const requirementVersionSourceSchema = z.enum([...ORIGINS, 'USER_EDITED']);
export type RequirementVersionSource = z.infer<typeof requirementVersionSourceSchema>;

export const prioritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export type Priority = z.infer<typeof prioritySchema>;
export const answerTypeSchema = z.enum(['SINGLE_SELECT', 'MULTI_SELECT', 'BOOLEAN', 'NUMBER_RANGE', 'FREE_TEXT']);
export type AnswerType = z.infer<typeof answerTypeSchema>;

const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/, 'ids must be short slugs (letters, digits, - and _)');

export const questionOptionSchema = z.object({
  id: slug, label: z.string().trim().min(1).max(120), description: z.string().trim().max(300).default(''),
});
export const advancedFieldSchema = z.object({ key: slug, label: z.string().trim().min(1).max(80), unit: z.string().max(30).optional() });

export const discoveryQuestionSchema = z.object({
  id: slug,
  category: requirementCategorySchema,
  question: z.string().trim().min(8).max(300),
  whyItMatters: z.string().trim().min(15).max(500),
  answerType: answerTypeSchema,
  options: z.array(questionOptionSchema).max(8).default([]),
  required: z.boolean(),
  priority: prioritySchema,
  relatedUnknowns: z.array(z.string()).min(1).max(5),
  allowRecommendation: z.boolean(),
  numberRange: z.object({ min: z.number(), max: z.number(), unit: z.string().max(30).optional() }).optional(),
  /** Optional technical detail fields shown under "Advanced details". Answers may carry them in `advanced`. */
  advanced: z.array(advancedFieldSchema).max(6).optional(),
});
export type DiscoveryQuestion = z.infer<typeof discoveryQuestionSchema>;

/** A gap the generator found that the interpreter missed. Temporary ids (N1, N2...) are remapped to stable U-ids by the server. */
export const newUnknownSchema = z.object({ id: z.string().regex(/^N\d{1,2}$/, 'new unknown ids look like N1, N2'), text: z.string().trim().min(5).max(300), critical: z.boolean() });

export const clarificationOutputSchema = z.object({
  questions: z.array(discoveryQuestionSchema).max(10),
  newUnknowns: z.array(newUnknownSchema).max(6).default([]),
  remainingCriticalUnknowns: z.array(z.string()),
  reasonForAnotherRound: z.string().max(500),
  canGenerateBrief: z.boolean(),
});
export type ClarificationOutput = z.infer<typeof clarificationOutputSchema>;

// ---------- unknowns & requirements (shared record shapes) ----------
export interface DiscoveryUnknown { id: string; text: string; status: 'OPEN' | 'RESOLVED' | 'ACCEPTED'; critical: boolean }
export interface RequirementSnapshot {
  id: string; key: string; category: RequirementCategory; statement: string; value: string | null;
  origin: RequirementOrigin; confidence: number | null; tags: string[]; version: number;
}
export interface PriorQuestion { id: string; question: string; category: string; relatedUnknowns: string[] }

// ---------- answers ----------
export const answerChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('OPTIONS'), optionIds: z.array(z.string()).min(1).max(8) }),
  z.object({ kind: z.literal('BOOLEAN'), value: z.boolean() }),
  z.object({ kind: z.literal('NUMBER_RANGE'), min: z.number(), max: z.number() }),
  z.object({ kind: z.literal('FREE_TEXT'), text: z.string().trim().min(1).max(2000) }),
  z.object({ kind: z.literal('RECOMMEND') }),
  z.object({ kind: z.literal('SKIP') }),
]);
export type AnswerChoice = z.infer<typeof answerChoiceSchema>;
export const advancedValuesSchema = z.record(z.string(), z.union([z.string().max(200), z.number()]));
export const answerInputSchema = z.object({ questionId: z.string(), choice: answerChoiceSchema, advanced: advancedValuesSchema.optional() });
export type AnswerInput = z.infer<typeof answerInputSchema>;
export const submitAnswersRequestSchema = z.object({ answers: z.array(answerInputSchema).min(1).max(12) });
export type SubmitAnswersRequest = z.infer<typeof submitAnswersRequestSchema>;

/** Human-readable rendering of an answer (used in prompts, history and the mock provider). */
export function describeChoice(q: DiscoveryQuestion, c: AnswerChoice): string {
  switch (c.kind) {
    case 'OPTIONS': return c.optionIds.map((id) => q.options.find((o) => o.id === id)?.label ?? id).join(', ');
    case 'BOOLEAN': return c.value ? 'Yes' : 'No';
    case 'NUMBER_RANGE': return `${c.min} to ${c.max}${q.numberRange?.unit ? ` ${q.numberRange.unit}` : ''}`;
    case 'FREE_TEXT': return c.text;
    case 'RECOMMEND': return 'Recommend for me';
    case 'SKIP': return '(skipped)';
  }
}

// ---------- semantic validation: questions ----------
const TECH_TERMS = /\b(kafka|rabbitmq|sqs|sns|kinesis|pulsar|spark|flink|airflow|dbt|kubernetes|k8s|docker|postgres(?:ql)?|mysql|mongodb|redis|elasticsearch|opensearch|snowflake|databricks|s3|lambda|terraform|react|next\.?js|node\.?js|fastapi|spring)\b/i;
const TECH_EXEMPT = new Set(['TEAM_CONSTRAINT', 'INTEGRATION', 'CLOUD', 'DEPLOYMENT']);

const tokens = (s: string) => new Set(normalizeForQuote(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 2));
function similar(a: string, b: string): boolean {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter) >= 0.8;
}

export interface ClarificationContext {
  openUnknownIds: string[]; openUnknownTexts?: string[]; priorQuestions: PriorQuestion[]; maxQuestions: number;
}

export function validateClarificationOutput(out: ClarificationOutput, ctx: ClarificationContext): string[] {
  const issues: string[] = [];
  const fresh = new Set<string>();
  out.newUnknowns.forEach((n, i) => {
    if (fresh.has(n.id)) issues.push(`newUnknowns[${i}]: duplicate id "${n.id}".`);
    fresh.add(n.id);
    for (const t of ctx.openUnknownTexts ?? []) if (similar(t, n.text)) issues.push(`newUnknowns[${i}] duplicates an existing unknown ("${t}"). Reference that one instead.`);
  });
  const open = new Set([...ctx.openUnknownIds, ...fresh]);
  const { questions } = out;
  if (questions.length > ctx.maxQuestions) issues.push(`Too many questions (${questions.length}); the maximum is ${ctx.maxQuestions}.`);
  if (questions.length === 0 && !out.canGenerateBrief) issues.push('No questions were returned but canGenerateBrief is false. Either ask questions or set canGenerateBrief to true.');
  if (out.canGenerateBrief && out.remainingCriticalUnknowns.length > 0) issues.push('canGenerateBrief is true but remainingCriticalUnknowns is not empty. Critical unknowns block the brief.');
  if (!out.canGenerateBrief && !out.reasonForAnotherRound.trim()) issues.push('reasonForAnotherRound is required when canGenerateBrief is false.');
  for (const id of out.remainingCriticalUnknowns) if (!open.has(id)) issues.push(`remainingCriticalUnknowns references unknown or already-resolved id "${id}".`);

  const priorIds = new Set(ctx.priorQuestions.map((q) => q.id));
  const seen = new Set<string>();
  questions.forEach((q, i) => {
    const at = `questions[${i}] (${q.id})`;
    if (seen.has(q.id)) issues.push(`${at}: duplicate question id within this round.`);
    if (priorIds.has(q.id)) issues.push(`${at}: id was already used in an earlier round.`);
    seen.add(q.id);
    for (const p of ctx.priorQuestions) if (similar(p.question, q.question)) issues.push(`${at}: duplicates an earlier question ("${p.question}").`);
    questions.slice(0, i).forEach((e) => { if (similar(e.question, q.question)) issues.push(`${at}: duplicates another question in this round.`); });

    const needsOptions = q.answerType === 'SINGLE_SELECT' || q.answerType === 'MULTI_SELECT';
    if (needsOptions) {
      if (q.options.length < 2) issues.push(`${at}: ${q.answerType} needs at least 2 options.`);
      if (new Set(q.options.map((o) => o.id)).size !== q.options.length) issues.push(`${at}: option ids must be unique.`);
      if (new Set(q.options.map((o) => normalizeForQuote(o.label))).size !== q.options.length) issues.push(`${at}: option labels must be unique.`);
      if (q.options.some((o) => /recommend/i.test(o.label))) issues.push(`${at}: do not add a "Recommend for me" option; set allowRecommendation instead.`);
    } else if (q.options.length > 0) issues.push(`${at}: ${q.answerType} questions must not have options.`);
    if (q.answerType === 'NUMBER_RANGE' && (!q.numberRange || q.numberRange.min >= q.numberRange.max)) issues.push(`${at}: NUMBER_RANGE needs numberRange with min < max.`);

    for (const u of q.relatedUnknowns) if (!open.has(u)) issues.push(`${at}: relatedUnknowns references unknown or already-resolved id "${u}".`);
    if (!TECH_EXEMPT.has(q.category)) {
      const text = [q.question, ...q.options.flatMap((o) => [o.label, o.description])].join(' ');
      const hit = TECH_TERMS.exec(text);
      if (hit) issues.push(`${at}: names a technology ("${hit[0]}"). Discovery asks about needs, not tools; rephrase around the underlying requirement.`);
    }
  });
  return issues;
}

// ---------- semantic validation: answers ----------
export function validateAnswers(questions: DiscoveryQuestion[], answers: AnswerInput[]): string[] {
  const issues: string[] = [];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const given = new Map<string, AnswerInput>();
  for (const a of answers) {
    if (!byId.has(a.questionId)) issues.push(`Unknown question "${a.questionId}".`);
    else if (given.has(a.questionId)) issues.push(`Question "${a.questionId}" was answered more than once.`);
    else given.set(a.questionId, a);
  }
  for (const q of questions) {
    const a = given.get(q.id);
    const label = `"${q.question}"`;
    if (!a || a.choice.kind === 'SKIP') { if (q.required) issues.push(`${label} is required.`); continue; }
    const c = a.choice;
    if (c.kind === 'RECOMMEND') { if (!q.allowRecommendation) issues.push(`${label} does not allow a recommendation.`); continue; }
    const kindFor: Record<string, string> = { SINGLE_SELECT: 'OPTIONS', MULTI_SELECT: 'OPTIONS', BOOLEAN: 'BOOLEAN', NUMBER_RANGE: 'NUMBER_RANGE', FREE_TEXT: 'FREE_TEXT' };
    if (c.kind !== kindFor[q.answerType]) { issues.push(`${label} expects a ${q.answerType} answer.`); continue; }
    if (c.kind === 'OPTIONS') {
      const ids = new Set(q.options.map((o) => o.id));
      if (c.optionIds.some((id) => !ids.has(id))) issues.push(`${label}: one of the chosen options does not exist.`);
      if (new Set(c.optionIds).size !== c.optionIds.length) issues.push(`${label}: options were repeated.`);
      if (q.answerType === 'SINGLE_SELECT' && c.optionIds.length !== 1) issues.push(`${label}: choose exactly one option.`);
    }
    if (c.kind === 'NUMBER_RANGE') {
      if (c.min > c.max) issues.push(`${label}: the minimum cannot exceed the maximum.`);
      if (q.numberRange && (c.min < q.numberRange.min || c.max > q.numberRange.max)) issues.push(`${label}: values must be between ${q.numberRange.min} and ${q.numberRange.max}.`);
    }
    if (a.advanced) {
      const allowed = new Set((q.advanced ?? []).map((f) => f.key));
      for (const k of Object.keys(a.advanced)) if (!allowed.has(k)) issues.push(`${label}: unknown advanced field "${k}".`);
    }
  }
  return issues;
}

// ---------- requirement extraction ----------
export const requirementDraftSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{2,59}$/, 'key must be a lower_snake_case slug'),
  category: requirementCategorySchema,
  statement: z.string().trim().min(5).max(500),
  value: z.string().trim().max(200).nullable().default(null),
  origin: z.enum(['USER_STATED', 'USER_ANSWERED', 'AI_INFERRED', 'AI_RECOMMENDED']),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sourceQuestionIds: z.array(z.string()).max(6).default([]),
  quote: z.string().max(400).optional(),
  tags: z.array(requirementTagSchema).max(4).default([]),
});
export type RequirementDraft = z.infer<typeof requirementDraftSchema>;

export const extractorOutputSchema = z.object({
  newRequirements: z.array(requirementDraftSchema).max(20),
  updatedRequirements: z.array(requirementDraftSchema.omit({ key: true }).extend({ requirementId: z.string(), reason: z.string().max(300) })).max(20),
  recommendations: z.array(z.object({ questionId: z.string(), resolvedValue: z.string().trim().min(1).max(300), reason: z.string().trim().min(10).max(500) })).max(12),
  resolvedUnknownIds: z.array(z.string()).max(30),
  newUnknowns: z.array(z.object({ text: z.string().trim().min(5).max(300), critical: z.boolean() })).max(6),
});
export type ExtractorOutput = z.infer<typeof extractorOutputSchema>;

export interface ExtractionContext {
  pitch: string;
  existing: RequirementSnapshot[];          // ACTIVE requirements
  questions: DiscoveryQuestion[];           // this round
  answers: AnswerInput[];                   // this round
  openUnknownIds: string[];
}

export function validateExtraction(out: ExtractorOutput, ctx: ExtractionContext): string[] {
  const issues: string[] = [];
  const haystack = normalizeForQuote(ctx.pitch);
  const answerBy = new Map(ctx.answers.map((a) => [a.questionId, a.choice]));
  const asked = new Set(ctx.questions.map((q) => q.id));
  const substantive = (id: string) => { const c = answerBy.get(id); return !!c && c.kind !== 'SKIP' && c.kind !== 'RECOMMEND'; };
  const recommended = (id: string) => answerBy.get(id)?.kind === 'RECOMMEND';
  const existingByKey = new Map(ctx.existing.map((r) => [r.key, r]));
  const existingById = new Map(ctx.existing.map((r) => [r.id, r]));

  type Common = { origin: string; confidence: number | null; sourceQuestionIds: string[]; quote?: string };
  const checkCommon = (at: string, r: Common) => {
    for (const id of r.sourceQuestionIds) if (!asked.has(id)) issues.push(`${at}: sourceQuestionIds references "${id}", which was not asked in this round.`);
    if (r.origin === 'USER_STATED' && !(r.quote && haystack.includes(normalizeForQuote(r.quote)))) issues.push(`${at}: USER_STATED requires a quote copied verbatim from the pitch. Use AI_INFERRED if the user did not say it.`);
    if (r.origin === 'USER_ANSWERED' && (r.sourceQuestionIds.length === 0 || !r.sourceQuestionIds.every(substantive))) issues.push(`${at}: USER_ANSWERED must cite only questions the user actually answered (not skipped, not "recommend").`);
    if (r.origin === 'AI_RECOMMENDED' && (r.sourceQuestionIds.length === 0 || !r.sourceQuestionIds.every(recommended))) issues.push(`${at}: AI_RECOMMENDED must cite only questions where the user chose "Recommend for me".`);
    if ((r.origin === 'AI_INFERRED' || r.origin === 'AI_RECOMMENDED') && r.confidence === null) issues.push(`${at}: ${r.origin} requires a confidence between 0 and 1.`);
  };

  const keys = new Set<string>();
  out.newRequirements.forEach((r, i) => {
    const at = `newRequirements[${i}] (${r.key})`;
    if (existingByKey.has(r.key)) issues.push(`${at}: key already exists. Use updatedRequirements to change it.`);
    if (keys.has(r.key)) issues.push(`${at}: duplicate key in this response.`);
    keys.add(r.key);
    checkCommon(at, r);
  });
  out.updatedRequirements.forEach((r, i) => {
    const at = `updatedRequirements[${i}]`;
    const cur = existingById.get(r.requirementId);
    if (!cur) { issues.push(`${at}: requirementId "${r.requirementId}" is not an active requirement.`); return; }
    checkCommon(at, r);
    const userOwned = cur.origin === 'USER_STATED' || cur.origin === 'USER_ANSWERED';
    if (userOwned && (r.origin === 'AI_INFERRED' || r.origin === 'AI_RECOMMENDED')) issues.push(`${at}: an AI-origin update may not overwrite a requirement the user stated or answered.`);
  });

  const recIds = out.recommendations.map((r) => r.questionId);
  const wanted = ctx.questions.filter((q) => recommended(q.id)).map((q) => q.id);
  for (const id of wanted) if (!recIds.includes(id)) issues.push(`Missing recommendation for question "${id}" (the user chose "Recommend for me").`);
  for (const id of recIds) if (!wanted.includes(id)) issues.push(`recommendations includes "${id}", which was not answered with "Recommend for me".`);

  const cited = new Set([...out.newRequirements, ...out.updatedRequirements].flatMap((r) => r.sourceQuestionIds));
  for (const q of ctx.questions) {
    if ((substantive(q.id) || recommended(q.id)) && !cited.has(q.id)) issues.push(`The answer to "${q.id}" is not reflected in any requirement.`);
  }
  const open = new Set(ctx.openUnknownIds);
  for (const id of out.resolvedUnknownIds) if (!open.has(id)) issues.push(`resolvedUnknownIds references unknown or already-resolved id "${id}".`);
  return issues;
}

// ---------- architecture brief ----------
export const briefItemSchema = z.object({ text: z.string().trim().min(3).max(500), requirementIds: z.array(z.string()).min(1).max(8) });
export type BriefItem = z.infer<typeof briefItemSchema>;
const items = z.array(briefItemSchema).max(20).default([]);

export const architectureDriverSchema = z.object({
  id: slug, name: z.string().trim().min(3).max(120), description: z.string().trim().min(5).max(500),
  priority: prioritySchema, sourceRequirementIds: z.array(z.string()).min(1).max(10),
});
export type ArchitectureDriverDraft = z.infer<typeof architectureDriverSchema>;

export const architectureBriefSchema = z.object({
  projectSummary: z.string().trim().min(10).max(800),
  businessObjective: z.string().trim().min(10).max(800),
  targetUsers: items,
  functionalRequirements: items,
  nonFunctionalRequirements: items,
  trafficAssumptions: items,
  dataRequirements: items,
  performanceRequirements: items,
  availabilityRequirements: items,
  securityRequirements: items,
  complianceRequirements: items,
  integrationRequirements: items,
  cloudAndDeploymentPreferences: items,
  budgetConstraints: items,
  teamConstraints: items,
  aiMlRequirements: items,
  keyAssumptions: z.array(z.object({ text: z.string().trim().min(3).max(500), requirementIds: z.array(z.string()).max(8).default([]) })).max(20).default([]),
  openQuestions: z.array(z.object({ text: z.string().trim().min(3).max(500), unknownId: z.string().optional() })).max(30).default([]),
  risks: z.array(z.object({ text: z.string().trim().min(3).max(500), severity: z.enum(['HIGH', 'MEDIUM', 'LOW']) })).max(15).default([]),
  architectureDrivers: z.array(architectureDriverSchema).max(15).default([]),
});
export type ArchitectureBriefContent = z.infer<typeof architectureBriefSchema>;

export const BRIEF_ITEM_SECTIONS = [
  'targetUsers', 'functionalRequirements', 'nonFunctionalRequirements', 'trafficAssumptions', 'dataRequirements', 'performanceRequirements',
  'availabilityRequirements', 'securityRequirements', 'complianceRequirements', 'integrationRequirements', 'cloudAndDeploymentPreferences',
  'budgetConstraints', 'teamConstraints', 'aiMlRequirements',
] as const;

export function validateBrief(brief: ArchitectureBriefContent, activeRequirementIds: string[], hasFunctionalRequirement: boolean): string[] {
  const issues: string[] = [];
  const known = new Set(activeRequirementIds);
  const check = (at: string, ids: string[]) => { for (const id of ids) if (!known.has(id)) issues.push(`${at} references unknown requirement id "${id}".`); };
  for (const s of BRIEF_ITEM_SECTIONS) brief[s].forEach((it, i) => check(`${s}[${i}]`, it.requirementIds));
  brief.keyAssumptions.forEach((a, i) => check(`keyAssumptions[${i}]`, a.requirementIds));
  const ids = new Set<string>();
  brief.architectureDrivers.forEach((d, i) => {
    if (ids.has(d.id)) issues.push(`architectureDrivers[${i}]: duplicate id "${d.id}".`);
    ids.add(d.id);
    check(`architectureDrivers[${i}]`, d.sourceRequirementIds);
  });
  if (activeRequirementIds.length > 0 && brief.architectureDrivers.length === 0) issues.push('At least one architecture driver is required.');
  if (hasFunctionalRequirement && brief.functionalRequirements.length === 0) issues.push('functionalRequirements is empty although functional requirements exist.');
  return issues;
}

// ---------- discovery orchestration inputs (shared by domain and ai) ----------
export interface AiMeta { promptId: string; promptVersion: number; provider: string; model: string; inputTokens?: number; outputTokens?: number; repaired: boolean }
export interface AiResult<T> { output: T; ai: AiMeta }

export interface AnsweredQuestion { questionId: string; question: string; category: string; answer: string; recommended: boolean; resolvedValue?: string | null }
export interface AiCallContext { workspaceId: string; projectId: string; userId: string }
export interface ClarificationInput {
  context: AiCallContext;
  pitch: string; interpretation: unknown; requirements: RequirementSnapshot[]; priorQuestions: PriorQuestion[]; priorAnswers: AnsweredQuestion[];
  openUnknowns: DiscoveryUnknown[]; roundNumber: number; limits: { maxQuestions: number; maxRounds: number }; technicalLevel?: string;
}
export interface ExtractionInput { context: AiCallContext; pitch: string; interpretation: unknown; requirements: RequirementSnapshot[]; questions: DiscoveryQuestion[]; answers: AnswerInput[]; openUnknowns: DiscoveryUnknown[] }
export interface DetectorInput { context: AiCallContext; requirements: RequirementSnapshot[] }
export interface BriefInput { context: AiCallContext; pitch: string; interpretation: unknown; requirements: RequirementSnapshot[]; openUnknowns: DiscoveryUnknown[]; technicalLevel?: string }
