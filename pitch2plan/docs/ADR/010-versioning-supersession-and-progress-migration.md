# ADR-010: New versions, preserved history, deterministic diff and reviewed progress migration
**Status:** accepted

**Context.** V1 must stay exactly as it was, decisions and components need continuity across versions, and a person's completed work must not be claimed valid when the architecture under it changed.

**Decision.**
1. The model proposes explicit OPERATIONS; application code validates and applies them to build a candidate version. The model never issues mutations. The candidate passes the Phase 3 gates (structure, semantic rules, critic, bounded repair).
2. A replacement that keeps a component's role keeps its `stableKey` (diff: REPLACED); a change of role gets a new key with `replacesStableKey`. Superseded decisions are kept; the new decision has a new key and `supersedesKey`; effective status is derived, so old rows are never edited. Old versions are immutable (triggers) and become SUPERSEDED.
3. The diff is computed from the two stored versions and stored when a change is applied; it is never AI output.
4. Plan V2 is generated for V2 and starts PENDING_REVIEW. A deterministic mapping classifies V1 tasks as carried forward, requiring re-confirmation, obsolete, new or unchanged-not-started, and prefers asking the user to re-confirm. Work on a replaced or removed component is never carried forward. The user inspects the mapping and accepts it explicitly; acceptance is one guarded transaction and records every mapping; V1 task history is never rewritten.

**Consequences.** Conservative migration can ask for re-confirmation that was not strictly needed. In return a changed architecture can never silently inherit completion it did not earn, and the full history of how the system evolved remains queryable.
