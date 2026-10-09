import {
  applyRepairPatch, architecturePlanSchema, criticOutputSchema, repairPatchSchema, validateCriticOutput, validatePlanReferences, validateRepairPatch,
  type AiResult, type ArchitecturePlan, type CritiqueInput, type CriticOutput, type PlanInput, type RepairInput, type RepairPatch,
} from '@pitch2plan/schemas';
import type { LLMGateway } from '../gateway';
import { ARCHITECTURE_CRITIC_V1, ARCHITECTURE_PLANNER_V1, ARCHITECTURE_REPAIRER_V1 } from '../prompts/architecture';
import { run } from './discovery';

const LONG = 240_000; // a full architecture is a long answer; the discovery default would time out

const ctxOf = (i: { drivers: PlanInput['drivers']; requirements: PlanInput['requirements'] }) => ({ driverCodes: i.drivers.map((d) => d.code), requirementCodes: i.requirements.map((r) => r.code) });

export class ArchitecturePlanner {
  constructor(private readonly gateway: LLMGateway) {}
  plan(input: PlanInput): Promise<AiResult<ArchitecturePlan>> {
    const { context, ...payload } = input;
    const ctx = ctxOf(input);
    // Referential integrity is checked here so a malformed graph gets one corrective retry before anything else sees it.
    return run(this.gateway, ARCHITECTURE_PLANNER_V1, payload, context, architecturePlanSchema, (p) => validatePlanReferences(p, ctx), 12_000, LONG);
  }
}

export class ArchitectureCritic {
  constructor(private readonly gateway: LLMGateway) {}
  critique(input: CritiqueInput): Promise<AiResult<CriticOutput>> {
    const { context, ...payload } = input;
    const ctx = ctxOf(input);
    return run(this.gateway, ARCHITECTURE_CRITIC_V1, payload, context, criticOutputSchema, (o) => validateCriticOutput(o, input.plan, ctx), 4096, 120_000);
  }
}

export class ArchitectureRepairer {
  constructor(private readonly gateway: LLMGateway) {}
  repair(input: RepairInput): Promise<AiResult<RepairPatch>> {
    const { context, issues, mustAddress, ...rest } = input;
    const payload = { ...rest, mustAddress, issues: issues.map((i, index) => ({ index, ...i })) };
    const ctx = ctxOf(input);
    return run(this.gateway, ARCHITECTURE_REPAIRER_V1, payload, context, repairPatchSchema, (patch) => {
      const problems = validateRepairPatch(patch, input.plan, issues.length, mustAddress);
      if (problems.length) return problems;
      // A patch that references things that do not exist after it is applied is as bad as an invalid one.
      return validatePlanReferences(applyRepairPatch(input.plan, patch), ctx).map((m) => `After applying the patch: ${m}`);
    }, 8192, LONG);
  }
}

/** Implements the domain's ArchitectureAiPort. */
export function createArchitectureAi(gateway: LLMGateway) {
  const planner = new ArchitecturePlanner(gateway), critic = new ArchitectureCritic(gateway), repairer = new ArchitectureRepairer(gateway);
  return { plan: (i: PlanInput) => planner.plan(i), critique: (i: CritiqueInput) => critic.critique(i), repair: (i: RepairInput) => repairer.repair(i) };
}
