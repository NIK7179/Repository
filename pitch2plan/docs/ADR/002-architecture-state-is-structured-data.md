# ADR-002: Architecture state is structured data, not LLM prose
**Status:** accepted

**Context.** The product's value is a persistent, queryable understanding of a user's system: why each component exists, what depends on it, and what changes when it is edited. Free-text model output and canvas-library state cannot provide that.

**Decision.** Every AI result is a JSON object validated by Zod and then by semantic checks (for example, user-stated claims must quote the pitch; edges must reference existing nodes). Only validated data is stored, in relational tables with stable node keys across versions. The user's original pitch is immutable; AI interpretation is stored separately and labels every claim `USER_STATED` or `AI_INFERRED`. React Flow is a renderer of an `Architecture` object and is never the data model.

**Consequences.** Slightly more work per capability, but outputs are traceable (prompt id/version), testable, diffable across versions, and safe to render. Malformed output costs one repair attempt and then a controlled error.
