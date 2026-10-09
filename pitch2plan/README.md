# Pitch2Plan

An AI-powered solution architect. You describe an idea in your own words; Pitch2Plan interprets it, asks the
right discovery questions, confirms your requirements, designs a project-specific architecture, and then guides you
through building it.

> **Status: Phase 4 (implementable architecture).** Pitch an idea, answer discovery, confirm requirements, generate an architecture, then turn it
> into a project-specific implementation plan: phases and tasks with dependencies, a workspace for every component, step-by-step guidance, honest
> progress tracking, and an Ask Architect assistant that already knows your project. Architecture change proposals, repository write-back and
> cloud integrations arrive in later phases. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
| `npm run test:ui` | Mounts the real React components in jsdom and drives them against the real production server and Postgres (`npm run build` first) |
| `npm run test:e2e` | Playwright (real browser) against the production build (`npm run build` first) |
| `npm run eval:discovery` | Runs four reference ideas through discovery and prints the questions for human review. Needs `AI_PROVIDER=anthropic` for a real evaluation; add `-- --deep` for a second round |
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
