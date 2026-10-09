# Development guide

## Daily loop
`npm run db:up` once, then `npm run dev`. After pulling schema changes: `npm run db:migrate` and `npm install` (regenerates the Prisma client).

## Changing the schema
1. Edit `packages/db/prisma/schema.prisma`.
2. `npm run migrate:dev -w @pitch2plan/db -- --name <change>` creates and applies a migration.
3. Update the repository mapping in `packages/db/src/repositories.ts` and the port in `packages/domain/src/ports.ts` if the domain needs it.
4. Tests rebuild `pitch2plan_test` from the committed migrations on every run, so a missing migration fails the tests.

## Adding an AI capability
1. Zod output schema + semantic validator in `packages/schemas`.
2. Versioned prompt in `packages/ai/src/prompts/` (never edit a released version; add `V2`).
3. A capability class that calls `runStructured` (see `idea-interpreter.ts`).
4. Expose it to the domain through a port, wire it in `container.ts`, test with `MockLLMProvider({ script: [...] })`.

## Testing
* Unit tests live beside each package (`packages/*/test`, `apps/web/src/**/*.test.ts`).
* Integration tests (`test/integration`) run the real application service and repositories against PostgreSQL with the mock AI provider.
* Use `MockLLMProvider({ script: [...] })` to simulate malformed output, errors and slowness. Tests assert business outcomes (what is persisted, what is rejected), not that mocks were called.
* E2E: `npm run build && npm run test:e2e`.

## Rules of the road
No Prisma outside `packages/db`. No business logic in route handlers or components. No vendor SDK outside `packages/ai/src/providers`.
Never persist unvalidated model output. Never log secrets or (outside debug) prompts.

## Phase 2 notes
* `npm run test:ui` needs a fresh `npm run build`; it starts the production server on port 3101 and **resets `TEST_DATABASE_URL`**.
* The hand-written migrations are checked against `schema.prisma` by `test/integration/schema-drift.test.ts`. Run `prisma migrate dev` once with network access and confirm it reports no drift.
* Simulate AI behaviour with `makeApp({ script: [...] })` (see `test/integration/discovery.test.ts`): scripted strings are consumed one per model call, in order. Build "otherwise valid, one defect" responses so a test fails for the reason in its name.
* Quality of questions can only be judged by reading them: `npm run eval:discovery`. Schema validity is not quality.

## Phase 3 notes
* Architecture generation needs a worker. `npm run dev` runs one inside the web process; in production run `npm run worker` and set `WORKER_MODE=external`.
* Tests use `ManualQueue` (jobs wait until `h.runJobs()`), so worker behaviour is explicit. `test/integration/jobs.test.ts` uses the real pg-boss (schema `pgboss_test`).
* To script model output for a project, build the exact planner input with `contextFor(h, projectId)` and feed `mockPlan(...)` variants through `makeApp({ script: [...] })`. Make fixtures valid except for ONE defect so tests fail for the reason in their name.
* The main vitest config excludes `apps/web/test-ui/**` (those need the production server). Run them with `npm run test:ui`.
* React Flow in jsdom: nodes need explicit `width`/`height`/`handles` for edges to render (the adapter provides them), and use `fireEvent.click` on nodes because d3-drag reads `event.view`, which user-event does not set.
* Mutation checks used while building Phase 3 are described in the Phase 3 report; the pattern is: remove one safeguard, run the relevant tests, expect a failure, restore.
