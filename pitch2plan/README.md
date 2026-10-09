# Pitch2Plan

An AI-powered solution architect. You describe an idea in your own words; Pitch2Plan interprets it, asks the
right discovery questions, confirms your requirements, designs a project-specific architecture, and then guides you
through building it.

> **Status: Phase 6 (trusted knowledge and grounded guidance).** Everything from Phase 5, plus: Pitch2Plan indexes *official* documentation for the technologies in
> your architecture (allow-listed vendor hosts only), retrieves the passages that match a component, task or question, and gives them to Ask Architect as
> untrusted reference data. Answers carry verifiable citations and a grounding status that the **server** derives (never the model): `GROUNDED`,
> `PARTIALLY_GROUNDED`, `UNGROUNDED` or `PROJECT_FACT_ONLY`, with each statement labelled as project fact, architecture decision, documented guidance,
> recommendation or unverified. Task and component documentation, a source inspector and documentation search are included. See
> [docs/PRODUCT_STATE.md](docs/PRODUCT_STATE.md) and ADR-011/012.
>
> *Phase 5 (safe architecture evolution)* is unchanged: Everything from Phase 4, plus: request an architecture change in plain language and get an impact
> analysis (affected requirements, decisions, components and implementation work, including completed work at risk) before anything changes. You approve
> explicitly; Pitch2Plan then creates Architecture V2 and Implementation Plan V2, shows a deterministic diff, lets you review how your progress maps onto
> the new plan, and keeps every V1 version and all history untouched. Also: production readiness review and failure-mode analysis. See
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

Requirements: Node 20+ (22 recommended), Docker (or any PostgreSQL 16).

```bash
npm install                 # also generates the Prisma client
cp .env.example .env
npm run db:up               # PostgreSQL in Docker (creates pitch2plan and pitch2plan_test)
npm run db:migrate          # prisma migrate deploy
npm run db:seed             # demo user, project and interpretation
npm run dev                 # http://localhost:3000
```

Sign in with **Use demo account** (`demo@pitch2plan.dev`) or any email. This is the Phase 1 dev-only sign-in.

The default AI provider is a deterministic **mock**. To use Claude, set in `.env`:

```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run lint` / `typecheck` | ESLint, then `tsc` in every package |
| `npm test` | Vitest: unit tests and integration tests against `TEST_DATABASE_URL` (schema rebuilt on each run) |
| `npm run worker` | Runs the background job worker (architecture generation) as its own process. In development the web app runs the same worker in-process (`WORKER_MODE=inline`), so `npm run dev` is enough |
| `npm run eval:architecture` | Runs four reference projects through planner -> validate -> critic -> repair and prints designs and metrics for human review. Needs `AI_PROVIDER=anthropic` for a real evaluation; add `-- --deep` for full rationales |
| `npm run eval:implementation` | Runs four reference architectures through the implementation planner -> validate -> critic -> repair pipeline and prints plans and metrics for human review (`-- --deep` for full task text). Needs `AI_PROVIDER=anthropic` for a real evaluation |
| `npm run eval:change` | Runs four reference change requests (PostgreSQL to DynamoDB, Kafka to Kinesis, Anthropic to Azure OpenAI, multi-region) through the change analyzer and planner, applies the operations with the real applier and prints proposals, diffs and checks for human review (`-- --deep` for every note). Needs `AI_PROVIDER=anthropic` for a real evaluation |
| `npm run test:ui` | Mounts the real React components in jsdom and drives them against the real production server and Postgres (`npm run build` first) |
| `npm run test:e2e` | Playwright (real browser) against the production build (`npm run build` first) |
| `npm run eval:discovery` | Runs four reference ideas through discovery and prints the questions for human review. Needs `AI_PROVIDER=anthropic` for a real evaluation; add `-- --deep` for a second round |
| `npm run eval:grounding` | Retrieval and answer-grounding evaluation over the real allow-listed documentation (needs outbound HTTPS). `-- --answers` adds real model answers (`AI_PROVIDER=anthropic`); `-- --fixtures` is an offline smoke test of the harness against labelled test pages (TRUNCATES knowledge tables: scratch database only) |
| `node scripts/smoke-phase6.mjs <url>` | Production smoke test over HTTP (web in `WORKER_MODE=external` + `npm run worker`, fixture documentation): pitch → architecture → plan → ingestion → grounded answer → citation |
| `npm run db:up` / `db:down` | Local PostgreSQL via Docker Compose |
| `npm run db:migrate` | `prisma migrate deploy` |
| `npm run db:migrate:sql` | Engine-free fallback that applies the same SQL migrations (CI, restricted networks) |
| `npm run db:seed` | Idempotent demo data |

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | none | Required. |
| `TEST_DATABASE_URL` | local `pitch2plan_test` | Used by `npm test`. **Dropped and recreated on every run.** |
| `AUTH_PROVIDER` | `dev` | Only `dev` exists in Phase 1. |
| `AUTH_SECRET` | dev fallback | Required in production (16+ chars). Signs session cookies. |
| `ALLOW_DEV_AUTH` | `false` | The dev provider is refused when `NODE_ENV=production` unless this is `true`. |
| `AI_PROVIDER` | `mock` | `mock` or `anthropic`. |
| `ANTHROPIC_API_KEY` | none | Required for `anthropic`. Server-side only; never sent to the browser. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | |
| `LLM_TIMEOUT_MS` / `LLM_MAX_RETRIES` | `60000` / `2` | Gateway policy. |
| `WORKER_MODE` | `inline` in dev, `external` in production | `inline`: the web process also consumes jobs. `external`: run `npm run worker`. **In production without a worker, generation will time out.** |
| `RATE_LIMIT_SCALE` | `1` | Multiplies every rate limit. For test and demo servers only: values above 1 are refused unless `ALLOW_DEV_AUTH=true`. The UI test server sets it so many users can sign in from one address. |
| `ARCH_MAX_REPAIRS` | `2` | Bounded repair cycle. |
| `ARCH_STALE_RUN_MS` | `600000` | A run with no heartbeat this long is failed so a project is never stuck generating. |
| `DISCOVERY_MAX_ROUNDS` | `3` | Standard discovery rounds before the brief is offered automatically. |
| `DISCOVERY_MAX_QUESTIONS` | `6` | Maximum questions per round. |
| `KNOWLEDGE_FETCHER` | `http` | `http` fetches allow-listed official pages; `fixture` serves labelled test pages (refused in production); `off` disables ingestion. |
| `ALLOW_FIXTURE_DOCS` | `false` | Must be `true` for the fixture fetcher to run. Tests only. |
| `KNOWLEDGE_STALE_DAYS` | `30` | Documentation not re-checked within this window is flagged "may be out of date". |
| `KNOWLEDGE_REFRESH_DAYS` | `7` | The worker re-checks indexed sources this often. |
| `KNOWLEDGE_DIAGNOSTICS` | `false` | Enables `/api/knowledge/status` (indexing diagnostics). Off by default. |
| `LOG_LEVEL` | `info` | pino level. |
| `DEBUG_LOG_PROMPTS` | `false` | Development only; prompts can contain sensitive user data. |

## Repository layout

```
apps/web        Next.js app: routes, UI, auth boundary, composition root
apps/worker     pg-boss job worker (architecture generation)
packages/domain application services, authorization, ports (no Prisma/Next/Anthropic imports)
packages/db     Prisma schema, migrations, repositories (the only place with queries)
packages/ai     LLM gateway, providers, prompts, structured-output pipeline, capabilities
packages/schemas Zod contracts and pure validators shared by API, AI output and UI
packages/jobs   pg-boss adapter for the domain's JobQueue port
packages/runtime shared composition root used by the web app and the worker
packages/ui     small design-system components
docs/           architecture, development guide, ADRs
infra/          docker-compose
```

## Known limitations

See the end of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#known-limitations).
