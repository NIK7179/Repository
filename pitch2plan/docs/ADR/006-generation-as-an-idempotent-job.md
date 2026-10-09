# ADR-006: Architecture generation is an idempotent background job on pg-boss
**Status:** accepted

**Context.** Generation takes minutes, can crash, and can be delivered more than once. A project must never be stuck, and a retry must never create a second version. We already run PostgreSQL and do not want new infrastructure.

**Decision.** Use pg-boss on the existing Postgres behind a `JobQueue` port. Correctness lives in the database, not the queue: the project transition and run creation are one compare-and-set transaction; workers claim a run with a CAS (stale heartbeats may be reclaimed); finalization is one transaction guarded by a CAS on the run and a unique constraint on the version's run id. The queue uses policy `short` so duplicate keys are refused, but nothing relies on that. Business failures never throw out of the handler; they are recorded (with a safe message) and the project returns to REQUIREMENTS_CONFIRMED. A sweeper fails runs whose worker vanished.

**Consequences.** Safe retries, crash recovery and a recoverable UX with plain SQL guarantees. Operating cost: a worker process in production (or the inline worker in development), and a stale-run timeout that must exceed the longest legitimate generation.
