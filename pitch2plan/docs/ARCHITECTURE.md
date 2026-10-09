# Architecture (Phase 5)

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

## Architecture generation (Phase 3)

```
POST /api/projects/:id/architecture/generate
   validate (write access, REQUIREMENTS_CONFIRMED, confirmed brief, drivers exist)
   one transaction: CAS REQUIREMENTS_CONFIRMED -> ARCHITECTURE_GENERATING, create ArchitectureGenerationRun
   enqueue pg-boss job (singletonKey = run id)  -> 202 { jobId, generationRunId }
worker (apps/worker, or inline in dev):  runGeneration(runId)
   claim run (CAS)  ->  load confirmed brief, requirements, drivers (codes REQ-001 / DRV-001)
   Planner -> structural + semantic validation -> [Critic] -> [Repairer -> validate -> Critic]* (bounded)
   finalize in ONE transaction: run SUCCEEDED, version + graph + decisions + links + issues, project -> ARCHITECTURE_READY
   on any failure: run FAILED (safe message + code), project -> REQUIREMENTS_CONFIRMED
```

* **The architecture is domain data.** `Architecture`, `ArchitectureVersion`, `ArchitectureNode`, `ArchitectureEdge`, `ArchitectureDecision`, the link tables (`DecisionDriverLink`, `DecisionRequirementLink`, `NodeDecisionLink`, `EdgeDecisionLink`), `ArchitectureGenerationRun` and `ArchitectureGenerationIssue`. React Flow lives only in `apps/web` (`lib/canvas.ts` converts a persisted version to a render model; positions are computed with dagre and never stored). Nothing in `domain`, `db`, `schemas` or `ai` imports it.
* **Immutability is enforced in the database.** Triggers reject any insert/update on the graph of a READY or SUPERSEDED version, and any status change other than READY -> SUPERSEDED. Changes require a new version.
* **Stable identity.** A component is identified across versions by `stableKey` (never by database id). `replacesStableKey` records replacement lineage; `nodeHistory()` follows a key across versions and derives "replaced by".
* **Traceability is queryable.** Requirement -> driver -> decision -> component are real rows. "Why is this here?" and the reverse "which components did this requirement shape?" are answered with no model call.
* **Planner / Critic / Repairer are separate capabilities** (`ARCHITECTURE_PLANNER`, `ARCHITECTURE_CRITIC`, `ARCHITECTURE_REPAIRER`, all v1). The planner prompt states the principle: the simplest architecture that satisfies the confirmed requirements; no technology without a driver. The repairer returns a *patch* applied deterministically (`applyRepairPatch`); fields it does not name are never touched. After the repair cap, a remaining CRITICAL issue fails the run; remaining HIGH issues are kept and shown.
* **Validation does not depend on the model.** `validateArchitectureStructure` (references, duplicates, self-edges, orphans, provider consistency, decision links) and `evaluateSemanticRules` (single points of failure, unencrypted sensitive data, lock-in vs portability, complexity vs budget) are plain code. The rules are deliberately incomplete.
* **Idempotency in layers.** pg-boss singletonKey (queue policy `short`) -> `claimRun` CAS (QUEUED, or RUNNING with a stale heartbeat) -> `finalize` CAS on the run -> unique `generationRunId` on the version. A duplicate or retried job cannot create a second version.
* **No stuck projects.** Failures return the project to REQUIREMENTS_CONFIRMED. A run whose worker vanished is failed (`GENERATION_TIMED_OUT`) by a sweeper on worker start and every minute, and lazily when the project, job or `generate` is read.
* **Failure UX is safe.** Only fixed, user-presentable messages and a code are stored on the run; provider errors, secrets and stack traces never reach it.

## Implementation planning and the contextual architect (Phase 4)

```
Architecture READY (immutable version)
  POST /api/projects/:id/implementation/generate   -> 202, same queue/worker/idempotency pattern as architecture generation
  worker: ImplementationPlanner -> deterministic validation -> ImplementationPlanCritic -> bounded ImplementationPlanRepairer (patch)
  finalize in ONE transaction: run SUCCEEDED + plan version + phases + tasks + steps + dependencies + links + validation rows
Roadmap -> task workspace -> start / block / skip / complete (with the user's own validation confirmations)
Component workspace (facts vs AI guidance) <-> task <-> decision, all by persisted links
Ask Architect: ContextBuilder -> streamed answer (SSE) -> validated, classified, stored only when complete
```

* **The plan is domain data bound to ONE architecture version.** `ImplementationPlanVersion.architectureVersionId` is unique and a trigger forbids re-pointing it. A task's content is immutable (trigger); only its `status` changes, and every change appends a `TaskProgressEvent`. A future architecture V2 gets its own plan; V1's is never mutated.
* **Tasks link by identity.** `TaskComponentLink(architectureVersionId, stableKey)`, `TaskDecisionLink`, `TaskRequirementLink`, `TaskDependency`. So Requirement -> Driver -> Decision -> Component -> Task is queryable; "why does this task exist?" and "what implements this decision?" need no model call.
* **Validation is code, not trust.** `validateImplementationPlan`: unique keys, known phases/components/decisions/requirements, no self/duplicate/cyclic dependencies (Kahn), no dependency on a LATER phase, non-empty phases, coverage of every component (or an explicit reason; purely external dependencies are exempt). `evaluateImplementationRules`: missing testing/observability/security/deployment work, technology in tasks that is not in the architecture, generic-language heuristic. The critic adds judgment; the repairer returns a strict patch (`.partial().strict()`, no re-applied defaults) applied by code. A CRITICAL issue after the repair cap fails the run.
* **Idempotency in layers (like Phase 3).** one ACTIVE run per project (partial unique index) -> `claimRun` CAS -> `finalize` CAS -> unique run id and unique architecture version per plan. Generating a plan does NOT change the project status; **the first task start moves ARCHITECTURE_READY -> IMPLEMENTING**.
* **Progress rule (single, documented).** SKIPPED tasks are excluded from the denominator: `completed / (total - skipped)`. A task is READY when it is NOT_STARTED and every dependency is COMPLETED or SKIPPED. "Next best" is deterministic: continue what is in progress, else the earliest READY task (phase order, then sequence), with a reason built from real data.
* **Completion is honest.** Completing needs every validation step confirmed by the user (`USER_CONFIRMED`). `SYSTEM_VERIFIED` exists in the data model for future integrations and is never written today; the UI never says "verified" for a checkbox.
* **Facts vs guidance.** The component workspace separates ARCHITECTURE FACTS (persisted, versioned) from AI GUIDANCE (task text, notes, links; labelled, never applied automatically). Documentation links are `https` only and shown as unverified.
* **ContextBuilder** (`assistant-context.ts`, pure and unit-tested) selects, per scope (PROJECT / COMPONENT / TASK): the focus component(s) and neighbours, their connections, the decisions that govern them, the requirements and drivers behind those decisions (plus topical requirements when the question is about security, performance, cost or availability), the current task and step, related tasks, progress and a short conversation tail. Unrelated components and requirements are deliberately omitted; oversize context is shrunk by dropping the least relevant material first.
* **Assistant output.** Answer text, then `<<<STRUCTURED>>>` and a JSON trailer (warnings, commands, code, validation steps, related task ids, architecture impact, `needsArchitectureChange`). The server validates it, drops task ids it cannot verify, **classifies every command itself** (READ_ONLY / MUTATING / DESTRUCTIVE; the model's opinion is ignored), adds fixed notices, and never changes the architecture. Commands are never run.
* **Streaming and failure.** SSE `start -> delta* -> done | error`. Authorization and scope errors are thrown before the stream opens (normal JSON errors). A provider error, timeout, dropped connection or cancel stores NO assistant message; the user's question is stored once (idempotent `clientMessageId`) so "Try again" reuses it. Usage is tracked per capability (`IMPLEMENTATION_*`, `TASK_ASSISTANT`) on success and failure.
* **Conversations** are private to their owner and addressed by `(project, scope, scopeId)`.

## Safe architecture evolution (Phase 5)

```
Request (user, assistant answer, or review finding)  ->  ChangeProposal bound to ONE architecture version (DRAFT)
  analyze (job)     ->  READY_FOR_REVIEW: structured impact + deterministic enrichment from stored links and the plan
  approve (human)   ->  approval record, requirement changes applied ONLY if the user confirmed them, one CHANGE run
  apply (job)       ->  ChangePlanner returns OPERATIONS -> applier (code) builds candidate V2 -> structural/semantic checks -> critic -> bounded repair
                        -> ONE transaction: V2 + graph + links + diff, V1 -> SUPERSEDED, proposal APPLIED   (project status never changes)
                        -> chain: Implementation Plan V2 generated as PENDING_REVIEW
  review migration  ->  user inspects carried / re-confirm / obsolete / new, then accepts (progress is never moved silently)
```

* **A proposal is first-class data**, never only a chat message: status machine enforced in the domain (`DRAFT, ANALYZING, READY_FOR_REVIEW, APPROVED, APPLYING, APPLIED, REJECTED, FAILED, STALE`), source (`USER_REQUEST`, `ASSISTANT_RECOMMENDATION`, `ARCHITECTURE_REVIEW` implemented), the base version it modifies (immutable, trigger-protected), impact items as rows (nodes, edges, decisions, drivers, requirements, tasks), and an append-only approval record. The other sources in the model are reserved.
* **Impact is not prose.** The analyzer returns a strict structure (change type, affected objects with DIRECT/POTENTIAL, qualitative trade-offs, new/reusable work, requirement changes, recommendation, confidence). The service then enriches it deterministically: neighbours from the graph, requirements via stored decision and driver links, and completed/in-progress work at risk from the plan. Cost is qualitative only.
* **Approval is a human act.** There is no path from the assistant or an AI call to `approve`. Approval is refused when the proposal is not READY_FOR_REVIEW, is stale, or needs requirement reconfirmation that was not given. These checks exist in the service AND the repository compare-and-set.
* **Stale proposals are never applied blindly.** If the current version moved on, the proposal becomes STALE. Rebase creates a NEW proposal on the current version (re-analysed, approval required again) and keeps the stale one as history.
* **Requirement changes are explicit.** `REQUIREMENT_CHANGE` (or proposed requirement changes) requires confirmation; on approval, new requirement versions and a new brief version are created in the same transaction (old ones stay). DRV codes are positional and never renumber; new drivers are appended.
* **The model proposes operations; code applies them.** `ADD/REMOVE/REPLACE/UPDATE_NODE`, `ADD/REMOVE/UPDATE_EDGE`, `ADD/SUPERSEDE/UPDATE_DECISION`. A technology replacement that keeps the component's role keeps its `stableKey` (diff: REPLACED); a role change gets a new key with `replacesStableKey` lineage. UPDATE_NODE can never change the technology. A superseded decision is kept in V1 and its replacement gets a NEW key with `supersedesKey`; effective status is derived.
* **Same quality gates as Phase 3.** The candidate V2 goes through structural validation, semantic rules, the critic and bounded repair. An approved change does not override integrity.
* **Diff and migration are computed from stored data**, not by AI: `diffArchitectures` (ADDED/REMOVED/MODIFIED/UNCHANGED/REPLACED, decisions SUPERSEDED) and `mapTasksAcrossPlans`. Outcomes: `CARRIED_FORWARD` only for completed work whose components, connections and decisions are unchanged; `REQUIRES_REVALIDATION` for completed work touching a modified component, changed connection, changed decision, or system-wide work after any change; `OBSOLETE` for work on a replaced/removed component; `NEW`; `UNCHANGED_NOT_STARTED`. Work done on a replaced technology is never carried forward.
* **Plan V2 starts PENDING_REVIEW.** Its tasks cannot be started until the migration is accepted. Acceptance is one transaction guarded by compare-and-set and a staleness check against plan V1 progress; carried-forward tasks get a recorded event, everything else starts again. Plan V1 and its history are never modified.
* **Idempotency in layers.** One approved proposal produces at most one architecture version (unique `sourceProposalId`), one CHANGE run (unique `proposalId`; one ACTIVE change run per project via a partial unique index), and one plan chain. A vanished worker is failed by the sweeper and the SAME run is retried.
* **Review and failure modes.** A production readiness review (13 areas) stores findings with the version it reviewed; a finding that needs an architecture change can create a proposal with `reviewFindingId`. "What happens if this fails?" is computed from the graph (downstream/upstream, critical paths, existing and missing mitigation).

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
* **Phase 5 limits.** Live Claude quality of change analysis and planning is unverified (run `npm run eval:change`). Proposal sources `IMPLEMENTATION_DISCOVERY`, `FUTURE_COST_OPTIMIZATION` and `FUTURE_SECURITY_REVIEW` are reserved, not built. No team approval workflow. The diff canvas shows the new graph plus removed components, not a side-by-side. Task mapping is deterministic and conservative: it prefers asking you to re-confirm over claiming work is still valid. Nothing executes in a cloud account or repository.
* **Phase 4 limits.** Live Claude plan and answer quality is unverified (run `npm run eval:implementation`). Only the current READY architecture is planned; plan V2 for a later architecture version is not built. Technology icons are still monogram badges. Documentation grounding/RAG is not built (links are unverified suggestions). Commands and code are shown, never executed or written back. Completion is user-confirmed only. The assistant cannot change the architecture (change proposals come later). Conversations are private per user (no team sharing yet).

* **Auth:** only the dev provider is implemented. The Clerk (or similar) adapter is a documented seam, not yet built.
* **Rate limiting** is in-process (single instance). The `RateLimiter` interface is ready for a shared store.
* **Interpretation runs inside the request** (typically a few seconds). The worker is intentionally empty; pg-boss arrives with Phase 3 generation.
* **Migrations** were written by hand to Prisma's conventions because Prisma's engine could not be downloaded where this was built; run `prisma migrate dev` once locally and confirm it reports no drift.
* **Playwright** specs exist but were not executed where this was built (no browser download available). They run in CI. The `test:ui` suite (jsdom + real server + real Postgres) covers the same journeys and did run.
* **Live Claude quality is unverified for discovery AND architecture.** Run `npm run eval:architecture`.
* **Only READY and SUPERSEDED versions are used.** DRAFT exists transiently inside the finalize transaction; VALIDATING/CRITIQUING/FAILED are in the enum for later use, and failures are recorded on the run.
* **A second version can only be created at the repository level** (Phase 5 adds change proposals); the project state machine does not allow regeneration from ARCHITECTURE_READY.
* **Technology icons are monogram badges**, not third-party logos; unknown technologies fall back to a generic category icon.
* **Deleting rows is not blocked by the immutability triggers** (needed for cascading deletes); the application has no delete path for versions.
 The mock provider only proves plumbing; run `npm run eval:discovery` with an API key and read the questions.
* AI conflict detection is best-effort; only the deterministic rules are guaranteed to run. Rules key off tags the extractor attaches, so a contradiction between two untagged requirements depends on the AI detector.
* A dismissed or resolved conflict is not re-raised if one of its requirements is later edited.
* `actorId`-style columns (`answeredById`, `createdById`, `resolvedById`, `confirmedById`) are plain UUIDs without foreign keys to `User`.
* The mock provider is heuristic and for development/tests only. Real interpretation quality has not been evaluated against Claude yet.
* No streaming UI, no Organizations UI, no edit/delete UI for projects (the delete endpoint exists).
