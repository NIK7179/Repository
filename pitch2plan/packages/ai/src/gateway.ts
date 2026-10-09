import { AIError, noopLogger, type AIUsageEvent, type CallMeta, type LLMProvider, type LLMRequest, type LLMResult, type Logger } from './types';

export interface GatewayConfig {
  provider: LLMProvider;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs?: number;
  maxTokens?: number;
  logger?: Logger;
  /** Called after every provider attempt (success or failure) for usage/cost tracking. */
  onUsage?: (event: AIUsageEvent) => void | Promise<void>;
  /** Development only: include prompts in logs. Off by default because pitches may be sensitive. */
  debugLogPrompts?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export class LLMGateway {
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly cfg: GatewayConfig) {
    this.logger = cfg.logger ?? noopLogger;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get providerName() { return this.cfg.provider.name; }
  get model() { return this.cfg.model; }

  async generate(req: Omit<LLMRequest, 'model' | 'signal'>, meta: CallMeta): Promise<LLMResult> {
    const { maxRetries, provider, model } = this.cfg;
    const timeoutMs = req.timeoutMs ?? this.cfg.timeoutMs;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const { timeoutMs: _t, ...providerReq } = req;
        const result = await provider.generate({ maxTokens: this.cfg.maxTokens, ...providerReq, model, signal: controller.signal });
        const latencyMs = Date.now() - started;
        this.logger.info({
          action: 'llm.generate', capability: meta.capability, promptId: meta.promptId, promptVersion: meta.promptVersion,
          provider: provider.name, model: result.model, attempt, latencyMs, ...result.usage,
          workspaceId: meta.workspaceId, projectId: meta.projectId,
          ...(this.cfg.debugLogPrompts ? { prompt: req.messages } : {}),
        }, 'llm call succeeded');
        await this.report(meta, result.model, latencyMs, true, result.usage);
        return result;
      } catch (e) {
        const err = this.normalize(e, timedOut);
        const latencyMs = Date.now() - started;
        this.logger.warn({
          action: 'llm.generate', capability: meta.capability, provider: provider.name, attempt, latencyMs,
          errorCode: err.code, retryable: err.retryable, workspaceId: meta.workspaceId, projectId: meta.projectId,
        }, 'llm call failed');
        await this.report(meta, model, latencyMs, false, {}, err.code);
        if (!err.retryable || attempt >= maxRetries) throw err;
        const base = this.cfg.baseDelayMs ?? 500;
        await this.sleep(base * 2 ** attempt + Math.floor(Math.random() * base));
      } finally { clearTimeout(timer); }
    }
  }

  stream(req: Omit<LLMRequest, 'model' | 'signal'>) {
    return this.cfg.provider.stream({ maxTokens: this.cfg.maxTokens, ...req, model: this.cfg.model });
  }

  private normalize(e: unknown, timedOut: boolean): AIError {
    if (timedOut) return new AIError('AI_TIMEOUT', 'The AI provider did not respond in time.', true);
    if (e instanceof AIError) return e;
    return new AIError('AI_PROVIDER_ERROR', 'Unexpected AI provider failure.', false);
  }

  private async report(meta: CallMeta, model: string, latencyMs: number, success: boolean, usage: { inputTokens?: number; outputTokens?: number }, errorCode?: string) {
    if (!this.cfg.onUsage) return;
    try {
      await this.cfg.onUsage({
        workspaceId: meta.workspaceId, projectId: meta.projectId, userId: meta.userId, capability: meta.capability,
        provider: this.cfg.provider.name, model, promptId: meta.promptId, promptVersion: meta.promptVersion,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs, success, errorCode,
      });
    } catch (e) {
      // Usage tracking must never break the user's request.
      this.logger.error({ action: 'llm.usage.record_failed', error: e instanceof Error ? e.message : String(e) }, 'failed to record usage');
    }
  }
}
