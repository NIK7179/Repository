# Architecture (Phase 2)

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

## Discovery (Phase 2)

```
Pitch -> IdeaInterpreter -> [start] seed requirements + unknowns (U1..Un)
      -> loop: ClarificationQuestionGenerator (gap analysis + questions)
               user answers -> RequirementExtractor (new / updated requirements, recommendations, resolved unknowns)
               rule + AI conflict detection
               stop when: nothing critical remains | round cap | user says "generate brief now"
      -> ArchitectureBriefGenerator (from current requirements only) -> user edits / resolves conflicts / confirms
      -> project: DISCOVERY -> REQUIREMENTS_CONFIRMED
```

* **Unknowns are the spine.** Every question must reference an open unknown; the generator may add gaps the interpreter missed (`newUnknowns`, remapped server-side to stable `U` ids). Unresolved unknowns are never invented away: they appear in the brief as open questions, and critical ones must be explicitly accepted to confirm.
* **Origins are enforced, not requested.** `USER_STATED` needs a verbatim quote from the pitch; `USER_ANSWERED` may only cite questions actually answered; `AI_RECOMMENDED` may only cite "Recommend for me" answers; an AI-origin update cannot overwrite a user-owned requirement. Violations are rejected by semantic validation (one repair attempt, then `AI_OUTPUT_INVALID`).
* **Requirements are append-only.** `Requirement` + `RequirementVersion` (+ `RequirementSource`). A manual edit creates a version with `source=USER_EDITED`, the previous wording, who and when; the requirement's origin becomes `USER_STATED` and its tags are cleared.
* **Brief staleness.** Each brief version stores a fingerprint of the active requirement versions it was built from. Any edit, answer or conflict resolution makes it stale; only the latest, non-stale brief can be confirmed.
* **Conflicts.** Deterministic rules over a controlled tag vocabulary (`packages/schemas/src/conflicts.ts`, add a rule to extend) always run; an AI detector is best-effort. Conflicts are deduplicated by fingerprint, shown to the user, and block confirmation until resolved (keep one, or dismiss with a reason).
* **Traceability for Phase 3.** `ArchitectureDriver` + `ArchitectureDriverRequirement` persist Requirement -> Driver. Phase 3 adds Decision -> Technology.
* **State machine.** `packages/domain/src/status.ts` lists every allowed project transition; writes use compare-and-set so concurrent requests cannot both win. Architecture generation is only allowed from `REQUIREMENTS_CONFIRMED`.
* **AI inputs/outputs** are versioned prompts (`CLARIFICATION_QUESTION_GENERATOR`, `REQUIREMENT_EXTRACTOR`, `CONTRADICTION_DETECTOR`, `ARCHITECTURE_BRIEF_GENERATOR`, all v1). Round, requirement-version and brief-version rows keep prompt id/version, provider, model, token usage and whether a repair was needed.
* **Discovery asks about needs, never tools.** A validator rejects questions that name technologies (except cloud-vs-on-prem, integrations and team skills).

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
* **Playwright** specs exist but were not executed where this was built (no browser download available). They run in CI. The `test:ui` suite (jsdom + real server + real Postgres) covers the same journeys and did run.
* **Live Claude quality is unverified.** The mock provider only proves plumbing; run `npm run eval:discovery` with an API key and read the questions.
* AI conflict detection is best-effort; only the deterministic rules are guaranteed to run. Rules key off tags the extractor attaches, so a contradiction between two untagged requirements depends on the AI detector.
* A dismissed or resolved conflict is not re-raised if one of its requirements is later edited.
* `actorId`-style columns (`answeredById`, `createdById`, `resolvedById`, `confirmedById`) are plain UUIDs without foreign keys to `User`.
* The mock provider is heuristic and for development/tests only. Real interpretation quality has not been evaluated against Claude yet.
* No streaming UI, no Organizations UI, no edit/delete UI for projects (the delete endpoint exists).
