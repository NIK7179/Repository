# ADR-008: The architect assistant is scoped, deterministic in its context, streamed, and cannot act
**Status:** accepted

**Context.** Users should ask questions from where they are (project, component, task, step) without re-explaining, at acceptable cost, latency and privacy, and without the assistant altering the architecture or running anything.

**Decision.**
1. A pure, tested ContextBuilder selects context per scope and omits unrelated material; it shrinks to a budget by priority. The database is never sent wholesale.
2. Conversations are scoped (`PROJECT | COMPONENT | TASK`, plus `scopeId`) and private to their owner. Every scope is authorized against the caller's project before anything is stored.
3. The model returns answer text then a delimited JSON trailer. The server validates the trailer, verifies referenced task ids, classifies commands with deterministic rules (the model's view of safety is ignored), and adds fixed notices (destructive commands, review-before-use for code, architecture change required).
4. Answers stream over SSE. Validation errors precede the stream. An assistant message is stored only after a complete valid answer; errors, timeouts, disconnects and cancels store nothing partial. The user's question is stored idempotently so retries do not duplicate it.
5. The assistant never changes the architecture: if the best answer means a changed decision it sets `needsArchitectureChange` and says so. Change proposals are a later phase. Commands are shown, never executed.

**Consequences.** Cheaper, faster, more private and more grounded answers; a clear safety boundary; some structured details can be missing when the model misformats its trailer (the text answer is still shown, with a notice).
