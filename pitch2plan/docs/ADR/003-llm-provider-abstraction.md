# ADR-003: LLM provider abstraction
**Status:** accepted

**Context.** Models and vendors change quickly; retries, timeouts, metering and logging must be consistent; and business logic must stay testable without network calls.

**Decision.** Business logic depends on `LLMProvider` (`generate`, `stream`). `LLMGateway` owns timeout, retry with backoff for retryable errors only, usage events per attempt, error normalisation and logging. Vendor SDK retries are disabled so all retries are visible and metered. Implementations: `AnthropicLLMProvider` and a scriptable `MockLLMProvider`. Prompts are versioned modules, and the prompt id and version are stored with each result.

**Consequences.** Swapping or adding providers is local to `packages/ai/src/providers`. Tests simulate failures deterministically. Provider-specific features (tool use, caching) will need extending the interface deliberately.
