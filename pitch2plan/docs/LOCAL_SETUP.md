# Local setup

How to get Pitch2Plan (Phase 6) running on a development machine, verified end to end on Ubuntu 24.04 with Node 22,
Docker and PostgreSQL 16 (the `infra/docker-compose.yml` image). `README.md` and `docs/DEVELOPMENT.md` stay authoritative for
day-to-day development; this page is the first-time path plus what was learned getting it running outside the original build sandbox.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 LTS (`engines` says >= 20; 22 is what CI uses) | `node -v` |
| npm | 10+ (ships with Node 22) | The repo has `package-lock.json`: use `npm ci`, not pnpm/yarn |
| Docker + Docker Compose | any recent | Runs PostgreSQL 16. Any PostgreSQL 16 works if you point the URLs at it |
| Git | any | |

pgvector is **not** required: Phase 6 stores embeddings as `DOUBLE PRECISION[]` and retrieves with PostgreSQL full-text search (ADR-012).

**Windows:** use WSL2 (Ubuntu) with Docker Desktop's WSL integration, and keep the checkout inside the WSL filesystem
(`~/pitch2plan`, not `/mnt/c/...`). The app, worker and build are written to work on native Windows too, but the UI test
harness (`apps/web/test-ui/global-setup.mjs`) uses POSIX process groups, and CI is Linux. PowerShell equivalents are given
below where commands differ.

## First-time setup

```bash
git clone https://github.com/NIK7179/Repository && cd Repository/pitch2plan
npm ci                       # installs and generates the Prisma client (postinstall)
cp .env.example .env         # PowerShell: Copy-Item .env.example .env
```

Edit `.env`:

* `AUTH_SECRET`: replace the placeholder with a random value (never commit it):
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
* `AI_PROVIDER=mock` (the default). The app, worker, tests and smoke tests need **no** API key in mock mode.
* `WORKER_MODE`: `inline` (default) runs the job worker inside `npm run dev`, so one terminal is enough.
  `external` matches production: run `npm run worker` in a second terminal (it is then the only job consumer).

`.env` is in `.gitignore`. Check with `git check-ignore .env` before committing anything.

## Database

```bash
npm run db:up                # PostgreSQL 16 in Docker; first start also creates pitch2plan_test (infra/initdb)
npm run db:migrate           # prisma migrate deploy, reading DATABASE_URL from the root .env
npm run db:migrate:status    # should print "Database schema is up to date!"
npm run db:seed              # demo user + workspace + project; idempotent (safe to run again)
```

| Database | Used by |
|---|---|
| `pitch2plan` | `DATABASE_URL`: `npm run dev`, `npm run worker`, seed |
| `pitch2plan_test` | `TEST_DATABASE_URL`: `npm test`, `npm run test:ui`, e2e. **Dropped and rebuilt on every run** |

`npm run db:down` stops PostgreSQL (data persists in the `pgdata` volume).
`npm run db:migrate:sql` is the engine-free fallback for networks that block Prisma's engine download.

### Prisma drift: read before running `prisma migrate dev`

`prisma migrate status` is clean, but `prisma migrate diff` between the migrations and `schema.prisma` reports three
**intentional** differences:

1. `KnowledgeChunk.tsv`: a `GENERATED ALWAYS ... STORED` tsvector column plus its GIN index (`KnowledgeChunk_tsv_idx`).
   This is the full-text retrieval index. Prisma's schema language cannot express generated columns, so it exists only in SQL.
2. `ArchitectureChangeProposal.requirementChanges DEFAULT '[]'` and `KnowledgeChunk.embedding DEFAULT ARRAY[]`: database
   defaults the schema does not declare (the application always supplies values).
3. The immutability / append-only triggers (24 of them) are invisible to Prisma; `migrate diff` neither sees nor drops them.

So `npm run migrate:dev -w @pitch2plan/db` (when changing the schema) **will generate SQL that drops `tsv` and its index**.
Always review the generated migration and delete those statements (and the two `DROP DEFAULT`s) before applying it.
`test/integration/schema-drift.test.ts` guards tables, columns and nullability; it does not cover generated columns or triggers.

## Run the app

Development (one terminal is enough with `WORKER_MODE=inline`):

```bash
# Terminal 1
npm run dev                  # http://localhost:3000
# Terminal 2 (required when WORKER_MODE=external, the production topology)
npm run worker
```

Sign in with **Use demo account** (`demo@pitch2plan.dev`) or any email (dev-only sign-in).
Health check: `curl http://localhost:3000/api/health` returns `{"data":{"status":"ok"}}`; the worker logs `"worker started"`.

Production build and start:

```bash
npm run build
WORKER_MODE=external ALLOW_DEV_AUTH=true npm start      # http://localhost:3000 (PORT=3200 npm start for another port)
npm run worker                                         # second terminal
```

(`ALLOW_DEV_AUTH=true` is needed because the dev sign-in is refused under `NODE_ENV=production`. Throwaway/local only.
PowerShell: `$env:WORKER_MODE="external"; $env:ALLOW_DEV_AUTH="true"; npm start`.)

## Tests

Three topologies, three commands. Do not mix them (PRODUCT_STATE.md, K4).

```bash
npm run lint
npm run typecheck
npm test                     # unit + integration (521 tests); rebuilds pitch2plan_test
npm run build && npm run test:ui                         # 56 tests: jsdom + real `next start` on :3101 + Postgres
npx playwright install chromium                          # once (CI adds --with-deps on Linux)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pitch2plan_test \
  node scripts/apply-sql-migrations.mjs --reset && \
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pitch2plan_test npm run test:e2e   # 7 Playwright specs on :3100
```

Point e2e at the test database (as CI does) so e2e users don't accumulate in your dev data. Stop any other server on port
3100 first: Playwright reuses an existing server there outside CI.

### Production smoke test (Phase 6)

Uses labelled fixture documentation, so run it against a scratch database:

```bash
createdb -h localhost -U postgres pitch2plan_smoke       # or: docker compose -f infra/docker-compose.yml exec postgres createdb -U postgres pitch2plan_smoke
export SMOKE=postgresql://postgres:postgres@localhost:5432/pitch2plan_smoke
DATABASE_URL=$SMOKE npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
DATABASE_URL=$SMOKE WORKER_MODE=external KNOWLEDGE_FETCHER=fixture ALLOW_FIXTURE_DOCS=true ALLOW_DEV_AUTH=true PORT=3200 npm start   # terminal 1
DATABASE_URL=$SMOKE KNOWLEDGE_FETCHER=fixture ALLOW_FIXTURE_DOCS=true npm run worker                                                  # terminal 2
node scripts/smoke-phase6.mjs http://localhost:3200                                                                                  # ends with SMOKE OK
```

Against the dev server with the real `http` fetcher, the smoke script stops at the documentation step whenever vendor
hosts are unreachable, then hits the app's rate limiter while polling. That is expected; use the fixture setup above.

## Trusted documentation (Phase 6)

```bash
# Offline harness check (TRUNCATES knowledge tables: scratch database only)
DATABASE_URL=$SMOKE ALLOW_FIXTURE_DOCS=true npm run eval:grounding -- --fixtures --out=verification/local/eval-grounding-fixtures.json
# Live retrieval over the real allow-listed documentation (needs outbound HTTPS; use a scratch database)
DATABASE_URL=$SMOKE KNOWLEDGE_FETCHER=http npm run eval:grounding -- --out=verification/local/eval-grounding-live.json
```

Always pass `--out=`: the default output path is a leftover from the original build sandbox (`/mnt/user-data/...`).
Ingestion failures are recorded per source in `KnowledgeIngestionRun.failureCode` (`NETWORK_ERROR`, `REDIRECT_NOT_ALLOWED`, ...).

Known, environment-independent finding: `https://docs.claude.com/en/api/overview` now redirects (301) to
`https://platform.claude.com/docs/en/api/overview`. `platform.claude.com` is not in the Anthropic entry's allow-list, so
ingestion of that source fails with `REDIRECT_NOT_ALLOWED`. That is the allow-list working as designed. Changing the seed
URL or allowed domains in `packages/schemas/src/knowledge.ts` is a deliberate trust decision, not a test fix.

Behind a corporate proxy, Node's `fetch` ignores `HTTPS_PROXY` unless you set `NODE_USE_ENV_PROXY=1` (Node 22.21+).

## AI provider: Claude

Only after everything above works with the mock provider. In your local `.env` (never commit it, never paste the key anywhere else):

```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=<your key>
ANTHROPIC_MODEL=claude-sonnet-5-5
```

Restart **both** `npm run dev` and `npm run worker`: the worker runs architecture, implementation and change jobs, and it reads
the key from the same root `.env`. The worker refuses to start if `AI_PROVIDER=anthropic` and the key is missing.

Real evaluations (each reads `.env`; the printed metrics are heuristics, so read the output):

```bash
mkdir -p verification/local
npm run eval:discovery      -- --deep 2>&1 | tee verification/local/eval-discovery-deep.txt
npm run eval:architecture   -- --deep 2>&1 | tee verification/local/eval-architecture-deep.txt
npm run eval:implementation -- --deep 2>&1 | tee verification/local/eval-implementation-deep.txt
npm run eval:change         -- --deep 2>&1 | tee verification/local/eval-change-deep.txt
DATABASE_URL=$SMOKE npm run eval:grounding -- --answers --out=verification/local/eval-grounding-answers.json 2>&1 | tee verification/local/eval-grounding-answers.txt
```

There is no single `npm run eval` script; these five are the evaluation harnesses.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm run db:migrate`: `Environment variable not found: DATABASE_URL` | Old script ran Prisma inside `packages/db`. Fixed: the root script now loads the root `.env`. Make sure `.env` exists |
| `npm run worker` exits with a Zod error for `DATABASE_URL` | Fixed: the worker now loads the root `.env` (existing environment variables still win) |
| Architecture or plan generation never finishes | `WORKER_MODE=external` but no `npm run worker` running (or vice versa: check the worker log for `"worker started"`) |
| Implementation page doesn't show "a new implementation plan is waiting for your review" right after approving a change | Fixed in `ImplementationView`: it now keeps polling while the plan for the new architecture version is being generated |
| `test:ui` / e2e: "Could not find a production build in the '.next' directory" | `npm run dev` and `npm run build` share `apps/web/.next`, so running dev replaces the production build. Stop dev, `npm run build`, then run the suite |
| `test:ui` fails with "Next server did not start" | Run `npm run build` first; free port 3101 |
| Playwright: `Executable doesn't exist ... chromium_headless_shell-NNNN` | Run `npx playwright install chromium` (the lockfile pins Playwright 1.63) |
| Port 5432 already in use | Another PostgreSQL is running. Stop it or change the port in `infra/docker-compose.yml` and both URLs in `.env` |
| `ERR_ABORTED` / rate limit (429) in scripted runs | Dev servers apply real rate limits; the UI test server sets `RATE_LIMIT_SCALE` for that reason |

## What was changed for local setup

* `package.json`: `db:migrate` loads the root `.env` (it previously failed on a clean checkout); added `db:migrate:status`.
* `apps/worker/src/index.ts`: loads the root `.env` if present, like the web app's `next.config.ts`.
* `apps/web/next.config.ts`: `fileURLToPath` instead of `URL.pathname`, so the root `.env` is found on Windows.
* `apps/web/src/components/ImplementationView.tsx`: poll while a newer plan is generating (a real race the `change-flow` UI test exposed).
* `e2e/*.spec.ts`: first real browser run. Fixed ambiguous selectors (Next's route announcer is also `role="alert"`), a
  navigation race, a stale Phase 1 assertion ("Coming in Phase 2"), server-confirmed checkboxes (`click` + `toBeChecked`), and
  opening the collapsed "Your earlier answers" section before asserting on it. No assertion was removed or loosened.
