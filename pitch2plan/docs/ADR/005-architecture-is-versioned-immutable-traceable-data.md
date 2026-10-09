# ADR-005: The architecture is versioned, immutable, traceable domain data
**Status:** accepted

**Context.** The product's value is explaining *why* a system is designed the way it is. A diagram, or a generated blob of text, cannot be queried, diffed, versioned or traced to the requirements that caused it.

**Decision.**
1. The architecture is relational data (versions, components, connections, decisions, links) validated by Zod and by deterministic structural and semantic checks that do not depend on the model. The canvas library only renders it; layout is derived, never persisted as the model.
2. A version is immutable once READY, enforced by database triggers as well as by the repositories. A change is a new version. Components keep a `stableKey` across versions so continuity is explicit, with `replacesStableKey` for replacements.
3. Every accepted decision links to drivers or requirements; `Requirement -> Driver -> Decision -> Component` is stored as rows and queried, not reconstructed. "Why is this here?" needs no model call.
4. Generation is planner -> validate -> critic -> bounded repair, where repair is a patch applied by code. A remaining CRITICAL issue fails the run; the model's output is never trusted to be structurally valid.

**Consequences.** More schema and validation code, and some runs fail rather than ship a questionable design. In return, every design is auditable, explainable and safe to build on in later phases (roadmap, change proposals, exports).
