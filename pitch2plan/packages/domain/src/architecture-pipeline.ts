import {
  applyRepairPatch, criticIssueToIssue, evaluateSemanticRules, validateArchitectureStructure,
  type AiMeta, type ArchitectureIssue, type ArchitecturePlan, type IssueCategory, type PlanInput, type RequirementText,
} from '@pitch2plan/schemas';
import type { ArchitectureAiPort } from './ports';

export interface PipelineConfig {
  /** Maximum number of repair rounds. The cycle is bounded: it can never loop forever. */
  maxRepairs: number;
  /** HIGH issues in these categories trigger a repair, in addition to every CRITICAL issue. */
  repairHighCategories: IssueCategory[];
}
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = { maxRepairs: 2, repairHighCategories: ['SECURITY', 'SINGLE_POINT_OF_FAILURE', 'MISSING_REQUIREMENT', 'INCONSISTENCY', 'RELIABILITY'] };

export type StagedIssue = ArchitectureIssue & { stage: string };
export interface PipelineResult {
  plan: ArchitecturePlan; issues: StagedIssue[]; repairs: number;
  ai: { planner: AiMeta; critics: AiMeta[]; repairers: AiMeta[] };
}
export class PipelineError extends Error {
  constructor(public readonly code: 'ARCHITECTURE_VALIDATION_FAILED', message: string, public readonly issues: StagedIssue[]) { super(message); this.name = 'PipelineError'; }
}

const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;

/**
 * Planner -> validate -> critic -> (repair -> validate -> critic)* with a hard cap.
 *  - Structural validation is deterministic and independent of the model.
 *  - CRITICAL structural issues are repaired BEFORE the critic runs (a broken graph is not worth critiquing).
 *  - After the last allowed repair, any remaining CRITICAL issue fails the run; remaining HIGH issues are recorded and shown, not hidden.
 *  - The repairer returns a patch that is applied deterministically; the planner is never asked to silently regenerate everything.
 */
export async function runArchitecturePipeline(
  ai: ArchitectureAiPort,
  args: { input: PlanInput; driverCodes: string[]; requirementCodes: string[]; requirementTexts: RequirementText[] },
  config: PipelineConfig,
  hooks: { onStage?: (stage: 'PLANNING' | 'VALIDATING' | 'CRITIQUING' | 'REPAIRING', repairs: number) => Promise<void> | void } = {},
): Promise<PipelineResult> {
  const { input, driverCodes, requirementCodes, requirementTexts } = args;
  const ctx = { driverCodes, requirementCodes };
  const stage = async (s: 'PLANNING' | 'VALIDATING' | 'CRITIQUING' | 'REPAIRING', r: number) => { await hooks.onStage?.(s, r); };

  await stage('PLANNING', 0);
  const planned = await ai.plan(input);
  let plan = planned.output;
  const meta = { planner: planned.ai, critics: [] as AiMeta[], repairers: [] as AiMeta[] };
  const history: StagedIssue[] = [];
  let repairs = 0;

  for (;;) {
    await stage('VALIDATING', repairs);
    const label = repairs === 0 ? 'PLAN' : `AFTER_REPAIR_${repairs}`;
    const structural = validateArchitectureStructure(plan, ctx);
    const semantic = evaluateSemanticRules(plan, requirementTexts);
    let all: ArchitectureIssue[] = [...structural, ...semantic];

    // A structurally broken graph is repaired first; the critic only reviews graphs that are at least coherent.
    if (!structural.some((i) => i.severity === 'CRITICAL')) {
      await stage('CRITIQUING', repairs);
      const critique = await ai.critique({ context: input.context, requirements: input.requirements, drivers: input.drivers, plan, precheckIssues: all });
      meta.critics.push(critique.ai);
      all = [...all, ...critique.output.issues.map(criticIssueToIssue)];
    }
    all = all.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
    const triggers = all.filter((i) => i.severity === 'CRITICAL' || (i.severity === 'HIGH' && config.repairHighCategories.includes(i.category)));

    const exhausted = repairs >= config.maxRepairs;
    if (triggers.length === 0 || exhausted) {
      const isFinal = (list: ArchitectureIssue[]) => list.map((i): StagedIssue => ({ ...i, stage: 'FINAL' }));
      if (exhausted && all.some((i) => i.severity === 'CRITICAL')) {
        throw new PipelineError('ARCHITECTURE_VALIDATION_FAILED', `Critical issues remained after ${repairs} repair attempt(s).`, [...history, ...isFinal(all)]);
      }
      return { plan, issues: [...history, ...isFinal(all)], repairs, ai: meta };
    }

    history.push(...all.map((i): StagedIssue => ({ ...i, stage: label })));
    await stage('REPAIRING', repairs + 1);
    repairs++;
    const issues = all.slice(0, 25);
    const mustAddress = issues.map((i, n) => (i.severity === 'CRITICAL' ? n : -1)).filter((n) => n >= 0);
    const repaired = await ai.repair({ context: input.context, requirements: input.requirements, drivers: input.drivers, plan, issues, mustAddress });
    meta.repairers.push(repaired.ai);
    plan = applyRepairPatch(plan, repaired.output);
  }
}
