# Architecture (Phase 1)

Pitch2Plan is a **modular monolith**: one Next.js deployable, plus a reserved worker. Boundaries are enforced by
package dependencies so modules can be extracted later if scale demands it (see ADR-001).

```
Browser (React)
   │  REST + JSON envelope
   ▼
apps/web  route handler  ──  api() wrapper: origin check, auth, rate limit, Zod validation, logging
   │
   ▼
packages/domain  createApplication():  projects · pitches · interpretation   (authorization lives here)
   │ ports (interfaces)                              │ ports
   ▼                                                  ▼
packages/db  (Prisma repositories → PostgreSQL)   packages/ai  IdeaInterpreter → LLMGateway → LLMProvider
                                                                                   ├─ MockLLMProvider
                                                                                   └─ AnthropicLLMProvider
```

Dependency rule: `domain` imports only `schemas`. `db` and `ai` implement domain ports. `apps/web/src/server/container.ts`
is the single composition root.

## Request flow: interpret an idea

1. `POST /api/projects/:id/interpret` → `api()` verifies Origin, resolves identity, provisions/loads the internal user, rate-limits, validates the body.
2. `application.interpretation.interpret` loads the project **through `requireProjectAccess`** (membership check; non-members get `PROJECT_NOT_FOUND`).
3. `IdeaInterpreter` builds the versioned prompt (`IDEA_INTERPRETER` v1), calls the gateway (timeout, retry with backoff, usage event per attempt).
4. `runStructured`: JSON extraction → Zod → **semantic validation** (every `USER_STATED` claim must quote the pitch verbatim) → one repair attempt → else `AI_OUTPUT_INVALID`.
5. Only validated output is stored in `IdeaInterpretation`, separate from the immutable `IdeaPitch`. An audit log entry is written.

## Data model

`User`, `Workspace` (`isPersonal`, nullable `organizationId` reserved), `WorkspaceMember` (role), `Project` (soft delete, status enum),
`IdeaPitch` (append-only, versioned), `IdeaInterpretation` (prompt id/version, provider, model), `Conversation`, `Message`,
`UsageEvent`, `AuditLog`. UUID keys, timestamps, indexes on the access paths. A new user gets a personal workspace and an OWNER membership.

Future tables (Requirement, Architecture, ArchitectureVersion, Node, Edge, Decision, ImplementationPhase/Task) are **not created yet**;
their Zod contracts live in `packages/schemas/src/architecture.ts` and arrive with their own migrations.

> **Architecture state is structured data.** React Flow will only ever *render* an `Architecture` object. It is never the data model (ADR-002).

## AI

* Provider abstraction (`LLMProvider`): `generate`, `stream`. Business logic never imports a vendor SDK (ADR-003).
* Gateway: timeouts, exponential backoff with jitter on retryable errors only, usage capture per attempt, normalized errors, structured logs. Prompts are logged only with `DEBUG_LOG_PROMPTS=true` outside production.
* Prompts live in `packages/ai/src/prompts/` with an id and version stored alongside every result.
* Orchestration is deterministic code, not autonomous agents. Interfaces for the later steps are in `capabilities/future.ts`.
* The pitch is passed as delimited, untrusted data; delimiter injection is stripped; model output never triggers actions.

## Security

Server-side authorization on every project operation; workspace ids from the browser are verified against memberships;
Zod at every boundary; signed HttpOnly SameSite=Lax session cookie plus Origin checks on mutating requests; security headers and a CSP;
React-escaped rendering only (no `dangerouslySetInnerHTML`); structured logs with redaction; no AI-generated commands are ever executed.

## Swapping in a production auth provider

Implement `AuthProvider` (`apps/web/src/server/auth/provider.ts`) to return an `ExternalIdentity { externalId, email, name }`
(for Clerk: read the verified session in `resolveIdentity`, map `userId`/email), register it in `container.ts`, and add its sign-in UI.
The domain provisions the internal `User` + personal workspace from that identity and never sees provider types.
In production the dev provider refuses to start unless `ALLOW_DEV_AUTH=true`.

## Known limitations

* **Auth:** only the dev provider is implemented. The Clerk (or similar) adapter is a documented seam, not yet built.
* **Rate limiting** is in-process (single instance). The `RateLimiter` interface is ready for a shared store.
* **Interpretation runs inside the request** (typically a few seconds). The worker is intentionally empty; pg-boss arrives with Phase 3 generation.
* **Migrations** were written by hand to Prisma's conventions because Prisma's engine could not be downloaded where this was built; run `prisma migrate dev` once locally and confirm it reports no drift.
* **Playwright** specs exist but were not executed where this was built (no browser download available). They run in CI.
* The mock provider is heuristic and for development/tests only. Real interpretation quality has not been evaluated against Claude yet.
* No streaming UI, no Organizations UI, no edit/delete UI for projects (the delete endpoint exists).
