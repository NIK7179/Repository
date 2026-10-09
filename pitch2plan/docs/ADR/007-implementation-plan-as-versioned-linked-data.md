# ADR-007: The implementation plan is versioned, linked domain data bound to one architecture version
**Status:** accepted

**Context.** Phase 4 must tell a person exactly what to do for THIS architecture and let them track it. A generated Markdown roadmap cannot be validated, queried, progressed or traced, and it silently drifts when the architecture changes.

**Decision.**
1. The plan is relational data: plan, plan version, phases, tasks, steps, dependencies, component/decision/requirement links, progress events, validation confirmations. It is validated by deterministic code (references, cycles, phase order, coverage) in addition to the model-based critic.
2. A plan version belongs to exactly one immutable architecture version (unique, trigger-protected). Task content is immutable; only status changes, and every change is appended to a history. A later architecture version gets a new plan; nothing is migrated in place.
3. Tasks link to components by `(architectureVersionId, stableKey)` and to decisions by id, never by technology name, so the chain Requirement -> Driver -> Decision -> Component -> Task survives renames and is queryable.
4. Progress is deterministic: one documented rule for skipped tasks, deterministic readiness and next-task selection, explicit transitions, and completion gated on the user's confirmation of validation steps. The data model distinguishes `USER_CONFIRMED` from `SYSTEM_VERIFIED`; only the former is written today.
5. Generation reuses the Phase 3 job pattern (queue, claim, finalize, one active run enforced by the database).

**Consequences.** More schema and validation code, and some runs fail rather than ship an incoherent plan. In return the plan is auditable, explainable, safe to retry, and ready for change proposals and integrations without rewriting history.
