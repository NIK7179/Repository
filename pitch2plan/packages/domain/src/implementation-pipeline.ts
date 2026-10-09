import {
  applyImplRepairPatch, criticToImplIssue, evaluateImplementationRules, validateImplementationPlan,
  type AiMeta, type ImplContext, type ImplIssue, type ImplIssueCategory, type ImplPlanInput, type ImplementationPlan,
} from '@pitch2plan/schemas';
import type { ImplementationAiPort } from './ports';

export interface ImplPipelineConfig { maxRepairs: number; repairHighCategories: ImplIssueCategory[] }
export const DEFAULT_IMPL_PIPELINE_CONFIG: ImplPipelineConfig = { maxRepairs: 2, repairHighCategories: ['SECURITY', 'OBSERVABILITY', 'ARCHITECTURE_MISMATCH', 'ORDERING', 'MISSING_VALIDATION'] };
export type StagedImplIssue = ImplIssue & { stage: string };
export interface ImplPipelineResult { plan: ImplementationPlan; issues: StagedImplIssue[]; repairs: number; ai: { planner: AiMeta; critics: AiMeta[]; repairers: AiMeta[] } }
export class ImplPipelineError extends Error { constructor(public readonly code: 'IMPLEMENTATION_VALIDATION_FAILED', message: string, public readonly issues: StagedImplIssue[]) { super(message); this.name = 'ImplPipelineError'; } }
const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;

/**
 * Planner -> validate -> critic -> (repair -> validate -> critic)* with a hard cap, exactly like the architecture pipeline.
 * Deterministic validation (references, cycles, ordering, coverage) never depends on the model; CRITICAL structural issues are repaired
 * BEFORE the critic runs; the repairer returns a patch applied by code; a CRITICAL issue after the last repair fails the run.
 */
export async function runImplementationPipeline(
  ai: ImplementationAiPort,
  args: { input: ImplPlanInput; ctx: ImplContext; requirementTexts: Array<{ code: string; statement: string }> },
  config: ImplPipelineConfig,
  hooks: { onStage?: (stage: 'PLANNING' | 'VALIDATING' | 'REVIEWING' | 'REPAIRING', repairs: number) => Promise<void> | void } = {},
): Promise<ImplPipelineResult> {
  const { input, ctx, requirementTexts } = args;
  const stage = async (s: 'PLANNING' | 'VALIDATING' | 'REVIEWING' | 'REPAIRING', r: number) => { await hooks.onStage?.(s, r); };
  await stage('PLANNING', 0);
  const planned = await ai.plan(input);
  let plan = planned.output;
  const meta = { planner: planned.ai, critics: [] as AiMeta[], repairers: [] as AiMeta[] };
  const history: StagedImplIssue[] = [];
  let repairs = 0;
  for (;;) {
    await stage('VALIDATING', repairs);
    const label = repairs === 0 ? 'PLAN' : `AFTER_REPAIR_${repairs}`;
    const structural = validateImplementationPlan(plan, ctx);
    let all: ImplIssue[] = [...structural, ...evaluateImplementationRules(plan, ctx, requirementTexts)];
    if (!structural.some((i) => i.severity === 'CRITICAL')) {
      await stage('REVIEWING', repairs);
      const critique = await ai.critique({ context: input.context, architecture: input.architecture, requirements: input.requirements, plan, precheckIssues: all });
      meta.critics.push(critique.ai);
      all = [...all, ...critique.output.issues.map(criticToImplIssue)];
    }
    all = all.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
    const triggers = all.filter((i) => i.severity === 'CRITICAL' || (i.severity === 'HIGH' && config.repairHighCategories.includes(i.category)));
    const exhausted = repairs >= config.maxRepairs;
    if (triggers.length === 0 || exhausted) {
      const fin = (l: ImplIssue[]) => l.map((i): StagedImplIssue => ({ ...i, stage: 'FINAL' }));
      if (exhausted && all.some((i) => i.severity === 'CRITICAL')) throw new ImplPipelineError('IMPLEMENTATION_VALIDATION_FAILED', `Critical issues remained after ${repairs} repair attempt(s).`, [...history, ...fin(all)]);
      return { plan, issues: [...history, ...fin(all)], repairs, ai: meta };
    }
    history.push(...all.map((i): StagedImplIssue => ({ ...i, stage: label })));
    await stage('REPAIRING', repairs + 1);
    repairs++;
    const issues = all.slice(0, 25);
    const mustAddress = issues.map((i, n) => (i.severity === 'CRITICAL' ? n : -1)).filter((n) => n >= 0);
    const repaired = await ai.repair({ context: input.context, architecture: input.architecture, requirements: input.requirements, plan, issues, mustAddress });
    meta.repairers.push(repaired.ai);
    plan = applyImplRepairPatch(plan, repaired.output);
  }
}
