# ADR-009: Architecture changes are explicit proposals that a human approves
**Status:** accepted

**Context.** Once a person has started implementing, "here is a new diagram" is the wrong answer to "replace Kafka with Kinesis". They need to know what the change touches, what completed work is at risk and what it costs in trade-offs, and nothing may change until they decide. Changes can also race (two proposals against one version) and can alter requirements, not just technology.

**Decision.**
1. A change is a first-class `ArchitectureChangeProposal` bound to the architecture version it modifies, with a domain-enforced status machine, impact rows and an append-only approval record. Chat messages are only a source.
2. The analyzer returns strict structure; code enriches it from the stored graph, decision and driver links and the implementation plan (including completed work at risk). Cost is qualitative.
3. Approval is a signed-in human act with no AI path. It is refused unless the proposal is READY_FOR_REVIEW and current, and unless requirement changes were confirmed when the change alters requirements. Requirement changes create new requirement and brief versions; nothing confirmed is rewritten.
4. A proposal on a superseded version becomes STALE and is never applied. Rebase creates a successor proposal that is re-analysed and needs approval again.
5. Application is a background job with the same idempotency and recovery pattern as generation, with database uniqueness: one version per proposal, one CHANGE run per proposal, one active change run per project.

**Consequences.** More states and tables, and an extra human step. In return nothing changes silently, concurrent changes cannot corrupt each other, and every version is traceable to the decision that created it.
