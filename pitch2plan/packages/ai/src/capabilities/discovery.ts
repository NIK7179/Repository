import {
  architectureBriefSchema, clarificationOutputSchema, describeChoice, detectorOutputSchema, extractorOutputSchema, validateBrief,
  validateClarificationOutput, validateDetectorOutput, validateExtraction,
  type AiMeta, type AiResult, type ArchitectureBriefContent, type BriefInput, type ClarificationInput, type ClarificationOutput, type DetectorInput,
  type DetectorOutput, type ExtractionInput, type ExtractorOutput,
} from '@pitch2plan/schemas';
import type { ZodType } from 'zod';
import type { LLMGateway } from '../gateway';
import {
  ARCHITECTURE_BRIEF_GENERATOR_V1, CLARIFICATION_QUESTION_GENERATOR_V1, CONTRADICTION_DETECTOR_V1, REQUIREMENT_EXTRACTOR_V1,
} from '../prompts/discovery';
import type { PromptDef } from '../prompts/util';
import { runStructured } from '../structured';
import type { AiCallContextLike } from './shared';

type Prompt = PromptDef & { buildUser(input: unknown): string };

/** Shared pipeline for every discovery capability: prompt -> gateway -> JSON -> Zod -> semantic checks -> one repair. */
export async function run<T>(gateway: LLMGateway, prompt: Prompt, payload: unknown, ctx: AiCallContextLike, schema: ZodType<T>, semantic: (v: T) => string[], maxTokens: number, timeoutMs?: number): Promise<AiResult<T>> {
  const { value, result, repaired, usage } = await runStructured({
    gateway, schema, semantic,
    request: { system: prompt.system, messages: [{ role: 'user', content: prompt.buildUser(payload) }], maxTokens, temperature: 0.3, timeoutMs },
    meta: { capability: prompt.id, promptId: prompt.id, promptVersion: prompt.version, workspaceId: ctx.workspaceId, projectId: ctx.projectId, userId: ctx.userId },
  });
  const ai: AiMeta = { promptId: prompt.id, promptVersion: prompt.version, provider: result.provider, model: result.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, repaired };
  return { output: value, ai };
}

export class ClarificationQuestionGenerator {
  constructor(private readonly gateway: LLMGateway) {}
  generate(input: ClarificationInput): Promise<AiResult<ClarificationOutput>> {
    const { context, ...payload } = input;
    const ctx = { openUnknownIds: input.openUnknowns.map((u) => u.id), openUnknownTexts: input.openUnknowns.map((u) => u.text), priorQuestions: input.priorQuestions, maxQuestions: input.limits.maxQuestions };
    return run(this.gateway, CLARIFICATION_QUESTION_GENERATOR_V1, payload, context, clarificationOutputSchema, (v) => validateClarificationOutput(v, ctx), 4096);
  }
}

export class RequirementExtractor {
  constructor(private readonly gateway: LLMGateway) {}
  extract(input: ExtractionInput): Promise<AiResult<ExtractorOutput>> {
    const { context, ...rest } = input;
    const byId = new Map(input.questions.map((q) => [q.id, q]));
    const payload = {
      pitch: rest.pitch, interpretation: rest.interpretation, openUnknowns: rest.openUnknowns.map((u) => ({ id: u.id, text: u.text })),
      requirements: rest.requirements.map((r) => ({ id: r.id, key: r.key, category: r.category, statement: r.statement, origin: r.origin })),
      questions: input.questions,
      answers: input.answers.map((a) => ({ questionId: a.questionId, question: byId.get(a.questionId)?.question, kind: a.choice.kind, recommend: a.choice.kind === 'RECOMMEND', answer: describeChoice(byId.get(a.questionId)!, a.choice), advanced: a.advanced })),
    };
    const sem = { pitch: input.pitch, existing: input.requirements, questions: input.questions, answers: input.answers, openUnknownIds: input.openUnknowns.map((u) => u.id) };
    return run(this.gateway, REQUIREMENT_EXTRACTOR_V1, payload, context, extractorOutputSchema, (v) => validateExtraction(v, sem), 6000);
  }
}

export class ContradictionDetector {
  constructor(private readonly gateway: LLMGateway) {}
  detect(input: DetectorInput): Promise<AiResult<DetectorOutput>> {
    const payload = { requirements: input.requirements.map((r) => ({ key: r.key, category: r.category, statement: r.statement, origin: r.origin })) };
    const keys = input.requirements.map((r) => r.key);
    return run(this.gateway, CONTRADICTION_DETECTOR_V1, payload, input.context, detectorOutputSchema, (v) => validateDetectorOutput(v, keys), 2048);
  }
}

export class ArchitectureBriefGenerator {
  constructor(private readonly gateway: LLMGateway) {}
  generate(input: BriefInput): Promise<AiResult<ArchitectureBriefContent>> {
    const payload = {
      pitch: input.pitch, interpretation: input.interpretation, technicalLevel: input.technicalLevel,
      openUnknowns: input.openUnknowns.map((u) => ({ id: u.id, text: u.text })),
      requirements: input.requirements.map((r) => ({ id: r.id, key: r.key, category: r.category, statement: r.statement, value: r.value, origin: r.origin, confidence: r.confidence })),
    };
    const ids = input.requirements.map((r) => r.id);
    const hasFunctional = input.requirements.some((r) => r.category === 'FUNCTIONAL');
    return run(this.gateway, ARCHITECTURE_BRIEF_GENERATOR_V1, payload, input.context, architectureBriefSchema, (v) => validateBrief(v, ids, hasFunctional), 8192);
  }
}

/** Implements the domain's DiscoveryAiPort. */
export function createDiscoveryAi(gateway: LLMGateway) {
  const gen = new ClarificationQuestionGenerator(gateway);
  const ext = new RequirementExtractor(gateway);
  const det = new ContradictionDetector(gateway);
  const brief = new ArchitectureBriefGenerator(gateway);
  return {
    generateQuestions: (i: ClarificationInput) => gen.generate(i),
    extractRequirements: (i: ExtractionInput) => ext.extract(i),
    detectConflicts: (i: DetectorInput) => det.detect(i),
    generateBrief: (i: BriefInput) => brief.generate(i),
  };
}
