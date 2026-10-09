import {
  applyChangeOperations, changeAnalysisSchema, changePlanSchema, reviewOutputSchema, validateChangeAnalysis, validateReviewOutput,
  type AiResult, type ChangeAnalysis, type ChangePlan, type ReviewOutput,
} from '@pitch2plan/schemas';
import type { ChangeAnalysisInput, ChangePlanInput, ReviewInput } from '@pitch2plan/domain';
import type { LLMGateway } from '../gateway';
import { ARCHITECTURE_REVIEWER_V1, CHANGE_ANALYZER_V1, CHANGE_PLANNER_V1 } from '../prompts/change';
import { run } from './discovery';

const LONG = 280_000;
export class ChangeAnalyzer {
  constructor(private readonly gateway: LLMGateway) {}
  analyze(input: ChangeAnalysisInput): Promise<AiResult<ChangeAnalysis>> {
    const { context, ...payload } = input;
    const ctx = { nodeKeys: input.architecture.nodes.map((n) => n.stableKey), edgeIds: input.architecture.edges.map((e) => e.id), decisionKeys: input.architecture.decisions.map((d) => d.key), driverCodes: input.drivers.map((d) => d.code),
      requirementCodes: input.requirements.map((r) => r.code), taskKeys: (input.plan?.tasks ?? []).map((t) => t.key) };
    return run(this.gateway, CHANGE_ANALYZER_V1, payload, context, changeAnalysisSchema, (a) => validateChangeAnalysis(a, ctx), 8000, LONG);
  }
}
export class ChangePlanner {
  constructor(private readonly gateway: LLMGateway) {}
  plan(input: ChangePlanInput): Promise<AiResult<ChangePlan>> {
    const { context, basePlan, ...rest } = input;
    const payload = { ...rest, allowedNodeKeys: [...new Set([...input.analysis.affectedNodes.map((n) => n.key)])], allowedEdgeIds: input.analysis.affectedEdges.map((e) => e.key) };
    // The operations are applied to the real base architecture inside the validator, so a model that issues an impossible operation gets one corrective retry.
    return run(this.gateway, CHANGE_PLANNER_V1, payload, context, changePlanSchema, (p) => applyChangeOperations(basePlan, p).errors, 16_000, LONG);
  }
}
export class ArchitectureReviewer {
  constructor(private readonly gateway: LLMGateway) {}
  review(input: ReviewInput): Promise<AiResult<ReviewOutput>> {
    const { context, ...payload } = input;
    return run(this.gateway, ARCHITECTURE_REVIEWER_V1, payload, context, reviewOutputSchema, (o) => validateReviewOutput(o, input.architecture.nodes.map((n) => n.stableKey), input.architecture.decisions.map((d) => d.key)), 6000, 200_000);
  }
}
export function createChangeAi(gateway: LLMGateway) {
  const a = new ChangeAnalyzer(gateway), p = new ChangePlanner(gateway), r = new ArchitectureReviewer(gateway);
  return { analyze: (i: ChangeAnalysisInput) => a.analyze(i), plan: (i: ChangePlanInput) => p.plan(i), review: (i: ReviewInput) => r.review(i) };
}
