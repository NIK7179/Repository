export interface LLMMessage { role: 'user' | 'assistant'; content: string }
export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Set by the gateway from configuration. */
  model?: string;
  signal?: AbortSignal;
  /** Overrides the gateway's default timeout for this call. Not sent to the provider. */
  timeoutMs?: number;
}
export interface LLMUsage { inputTokens?: number; outputTokens?: number }
export interface LLMResult { text: string; model: string; provider: string; usage: LLMUsage; stopReason?: string }
export type LLMStreamChunk = { type: 'delta'; text: string } | { type: 'done'; result: LLMResult };

/** Business logic depends on this interface, never on a vendor SDK. */
export interface LLMProvider {
  readonly name: string;
  generate(request: LLMRequest): Promise<LLMResult>;
  stream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
}

export type AIErrorCode = 'AI_PROVIDER_ERROR' | 'AI_TIMEOUT' | 'AI_OUTPUT_INVALID';
export class AIError extends Error {
  constructor(
    public readonly code: AIErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: unknown,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AIError';
  }
}

export interface Logger {
  info(fields: Record<string, unknown>, msg?: string): void;
  warn(fields: Record<string, unknown>, msg?: string): void;
  error(fields: Record<string, unknown>, msg?: string): void;
}
export const noopLogger: Logger = { info() {}, warn() {}, error() {} };

export interface AIUsageEvent {
  workspaceId: string; projectId?: string; userId?: string; capability: string; provider: string; model: string;
  promptId?: string; promptVersion?: number; inputTokens?: number; outputTokens?: number;
  latencyMs: number; success: boolean; errorCode?: string;
}
export interface CallMeta {
  capability: string; promptId: string; promptVersion: number; workspaceId: string; projectId?: string; userId?: string;
}
