import Anthropic from '@anthropic-ai/sdk';
import { AIError, type LLMProvider, type LLMRequest, type LLMResult, type LLMStreamChunk } from '../types';

export interface AnthropicOptions { apiKey: string; defaultModel: string; baseURL?: string }

/** Maps SDK/transport failures to normalized AIErrors. Exported for testing. */
export function normalizeAnthropicError(e: unknown): unknown {
  if (e instanceof AIError) return e;
  const err = e as { name?: string; status?: number; message?: string };
  // Aborts are decided by the gateway (it owns the timeout), so pass them through untouched.
  if (err?.name === 'AbortError' || err?.name === 'APIUserAbortError') return e;
  if (err?.name === 'APIConnectionTimeoutError') return new AIError('AI_TIMEOUT', 'The AI provider timed out.', true);
  if (err?.name === 'APIConnectionError') return new AIError('AI_PROVIDER_ERROR', 'Could not reach the AI provider.', true);
  if (typeof err?.status === 'number') {
    const s = err.status;
    if (s === 429 || s === 408 || s === 409 || s >= 500) return new AIError('AI_PROVIDER_ERROR', `The AI provider is temporarily unavailable (HTTP ${s}).`, true, undefined, s);
    if (s === 401 || s === 403) return new AIError('AI_PROVIDER_ERROR', 'The AI provider rejected our credentials.', false, undefined, s);
    return new AIError('AI_PROVIDER_ERROR', `The AI provider rejected the request (HTTP ${s}).`, false, undefined, s);
  }
  return new AIError('AI_PROVIDER_ERROR', 'Unexpected AI provider failure.', false);
}

export class AnthropicLLMProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  constructor(private readonly opts: AnthropicOptions) {
    if (!opts.apiKey) throw new Error('ANTHROPIC_API_KEY is required for the Anthropic provider');
    // Retries are owned by the gateway so they are logged and metered; disable SDK-level retries.
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0 });
  }

  private params(req: LLMRequest) {
    return {
      model: req.model ?? this.opts.defaultModel,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages: req.messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    try {
      const msg = await this.client.messages.create(this.params(req), { signal: req.signal });
      return {
        text: msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
        model: msg.model, provider: this.name, stopReason: msg.stop_reason ?? undefined,
        usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      };
    } catch (e) { throw normalizeAnthropicError(e); }
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMStreamChunk> {
    try {
      const stream = this.client.messages.stream(this.params(req), { signal: req.signal });
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield { type: 'delta', text: ev.delta.text };
      }
      const msg = await stream.finalMessage();
      yield {
        type: 'done',
        result: {
          text: msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''), model: msg.model, provider: this.name,
          stopReason: msg.stop_reason ?? undefined, usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
        },
      };
    } catch (e) { throw normalizeAnthropicError(e); }
  }
}
