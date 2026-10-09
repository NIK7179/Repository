# ADR-004: Discovery is a structured, bounded, auditable process
**Status:** accepted

**Context.** Pitch2Plan must work out what is missing before designing, without interrogating users forever, without inventing answers, and without blurring what the user said with what the AI assumed.

**Decision.**
1. *Unknowns drive questions.* Each question must resolve an open, stable-id unknown. The generator can add gaps the interpreter missed. Questions are bounded per round and in total rounds (configurable); the user can stop early or ask for more.
2. *Origins are validated, not trusted.* Requirement origin is checked against evidence (verbatim quote, answered question, "Recommend for me" answer). AI cannot overwrite user-owned requirements.
3. *Append-only versions.* Requirements change only by adding versions; edits record previous value, author and time.
4. *The brief is derived and fingerprinted.* It is generated only from current requirements, cites requirement ids, and goes stale when they change. Confirmation is a gate (no open conflicts, summary, functional requirement, driver, critical unknowns accepted) executed with compare-and-set on project status.
5. *Conflicts are explicit.* Deterministic tag rules plus best-effort AI detection; the user decides, the system never picks silently.
6. *Discovery names needs, not tools.* Technology choice is deferred to architecture design.

**Consequences.** More validation code and some rejected model responses (one repair, then a controlled error), but discovery output is traceable, testable and safe to feed into Phase 3. Discovery quality still depends on the model and must be evaluated by reading questions, not by schema validity.
