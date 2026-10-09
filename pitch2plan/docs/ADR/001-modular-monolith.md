# ADR-001: Start as a modular monolith
**Status:** accepted

**Context.** A small team is building a product whose domain boundaries are still being discovered. Microservices would add network failure modes, deployment overhead and distributed-transaction problems before any scaling need exists.

**Decision.** One Next.js deployable plus a reserved worker, organised as packages with a strict dependency direction (`domain` depends on nothing but `schemas`; `db` and `ai` implement domain ports; `apps/web` composes them). No Redis, Kubernetes or service split in Phase 1.

**Consequences.** Simple local development, transactional consistency, one deploy. Boundaries are enforced by imports, so extracting `ai` (the likeliest first candidate) later is a mechanical change. We accept shared-process failure and in-process rate limiting until traffic justifies otherwise.
