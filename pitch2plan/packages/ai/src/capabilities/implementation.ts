import {
  applyImplRepairPatch, implCriticSchema, implRepairPatchSchema, implementationPlanSchema, validateImplCritic, validateImplRepairPatch, validateImplementationPlan,
  type AiMeta, type AiResult, type ImplContext, type ImplCritiqueInput, type ImplCriticOutput, type ImplPlanInput, type ImplRepairInput, type ImplRepairPatch, type ImplementationPlan,
} from '@pitch2plan/schemas';
import type { LLMGateway } from '../gateway';
import { IMPLEMENTATION_CRITIC_V1, IMPLEMENTATION_PLANNER_V1, IMPLEMENTATION_REPAIRER_V1, TASK_ASSISTANT_V2, buildAssistantUser } from '../prompts/implementation';
import { run } from './discovery';
import type { AssistantStreamEventLike } from './shared';

const LONG = 300_000;
const ctxOf = (a: ImplPlanInput['architecture'], reqs: ImplPlanInput['requirements']): ImplContext => ({
  components: a.nodes.map((n) => ({ stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: n.category, criticality: n.criticality, deploymentModel: n.deploymentModel })),
  decisions: a.decisions.map((d) => ({ key: d.key, status: d.status, title: d.title, nodeStableKeys: d.nodeStableKeys })), requirementCodes: reqs.map((r) => r.code),
});
/** Referential integrity only (so the model gets one corrective retry); coverage, ordering and quality are the pipeline's job. */
const referencesOnly = (plan: ImplementationPlan, ctx: ImplContext) => validateImplementationPlan(plan, ctx).filter((i) => i.severity === 'CRITICAL' && ['BROKEN_REFERENCE', 'DUPLICATE_TASK', 'DUPLICATE_PHASE', 'SELF_DEPENDENCY', 'DUPLICATE_DEPENDENCY'].includes(i.code)).map((i) => i.description);

export class ImplementationPlanner {
  constructor(private readonly gateway: LLMGateway) {}
  plan(input: ImplPlanInput): Promise<AiResult<ImplementationPlan>> {
    const { context, ...payload } = input; const ctx = ctxOf(input.architecture, input.requirements);
    return run(this.gateway, IMPLEMENTATION_PLANNER_V1, payload, context, implementationPlanSchema, (p) => referencesOnly(p, ctx), 16_000, LONG);
  }
}
export class ImplementationPlanCritic {
  constructor(private readonly gateway: LLMGateway) {}
  critique(input: ImplCritiqueInput): Promise<AiResult<ImplCriticOutput>> {
    const { context, ...payload } = input; const ctx = ctxOf(input.architecture, input.requirements);
    return run(this.gateway, IMPLEMENTATION_CRITIC_V1, payload, context, implCriticSchema, (o) => validateImplCritic(o, input.plan, ctx), 4096, 150_000);
  }
}
export class ImplementationPlanRepairer {
  constructor(private readonly gateway: LLMGateway) {}
  repair(input: ImplRepairInput): Promise<AiResult<ImplRepairPatch>> {
    const { context, issues, mustAddress, ...rest } = input; const ctx = ctxOf(input.architecture, input.requirements);
    const payload = { ...rest, mustAddress, issues: issues.map((i, index) => ({ index, ...i })) };
    return run(this.gateway, IMPLEMENTATION_REPAIRER_V1, payload, context, implRepairPatchSchema, (patch) => {
      const m = validateImplRepairPatch(patch, input.plan, issues.length, mustAddress);
      if (m.length) return m;
      return referencesOnly(applyImplRepairPatch(input.plan, patch), ctx).map((x) => `After applying the patch: ${x}`);
    }, 10_000, LONG);
  }
}
export function createImplementationAi(gateway: LLMGateway) {
  const planner = new ImplementationPlanner(gateway), critic = new ImplementationPlanCritic(gateway), repairer = new ImplementationPlanRepairer(gateway);
  return { plan: (i: ImplPlanInput) => planner.plan(i), critique: (i: ImplCritiqueInput) => critic.critique(i), repair: (i: ImplRepairInput) => repairer.repair(i) };
}

/** Streams the architect's answer. Usage, timeout and cancellation are handled by the gateway. */
export function createAssistantAi(gateway: LLMGateway, opts: { timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return {
    async *stream(input: { context: { workspaceId: string; projectId: string; userId: string }; projectContext: unknown; history: Array<{ role: 'user' | 'assistant'; content: string }>; question: string; documents?: string; signal?: AbortSignal }): AsyncGenerator<AssistantStreamEventLike> {
      const messages = [...input.history, { role: 'user' as const, content: buildAssistantUser(input.projectContext, input.question, input.documents) }];
      const meta = { capability: 'TASK_ASSISTANT', promptId: TASK_ASSISTANT_V2.id, promptVersion: TASK_ASSISTANT_V2.version, ...input.context };
      for await (const chunk of gateway.streamTracked({ system: TASK_ASSISTANT_V2.system, messages, maxTokens: 3000, temperature: 0.3, timeoutMs }, meta, input.signal)) {
        if (chunk.type === 'delta') yield { type: 'delta', text: chunk.text };
        else yield { type: 'done', ai: { promptId: TASK_ASSISTANT_V2.id, promptVersion: TASK_ASSISTANT_V2.version, provider: chunk.result.provider, model: chunk.result.model, inputTokens: chunk.result.usage.inputTokens, outputTokens: chunk.result.usage.outputTokens, repaired: false } as AiMeta };
      }
    },
  };
}
