/**
 * Background worker: consumes architecture-generation jobs from pg-boss (on the same PostgreSQL) and runs them through the domain.
 * Run it as its own process in production (`npm run worker`). In development the web app can run the same worker in-process
 * (WORKER_MODE=inline), so a single `npm run dev` is enough.
 */
import { PgBossJobQueue } from '@pitch2plan/jobs';
import { composeRuntime } from '@pitch2plan/runtime';
import { z } from 'zod';

const env = z.object({
  DATABASE_URL: z.string().min(1),
  AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  ARCH_MAX_REPAIRS: z.coerce.number().int().min(0).max(5).default(2),
  ARCH_STALE_RUN_MS: z.coerce.number().int().positive().default(600_000),
  DISCOVERY_MAX_ROUNDS: z.coerce.number().int().min(1).max(10).default(3),
  DISCOVERY_MAX_QUESTIONS: z.coerce.number().int().min(1).max(10).default(6),
}).superRefine((e, ctx) => { if (e.AI_PROVIDER === 'anthropic' && !e.ANTHROPIC_API_KEY) ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'Required when AI_PROVIDER=anthropic' }); }).parse(process.env);

const log = (level: string) => (f: Record<string, unknown>, m?: string) => console.log(JSON.stringify({ level, service: 'pitch2plan-worker', msg: m, ...f }));
const logger = { info: log('info'), warn: log('warn'), error: log('error') };

const queue = new PgBossJobQueue(env.DATABASE_URL, { logger });
const rt = composeRuntime({
  databaseUrl: env.DATABASE_URL, logger,
  ai: { provider: env.AI_PROVIDER, anthropicApiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL, timeoutMs: env.LLM_TIMEOUT_MS, maxRetries: env.LLM_MAX_RETRIES },
  discovery: { maxDiscoveryRounds: env.DISCOVERY_MAX_ROUNDS, maxQuestionsPerRound: env.DISCOVERY_MAX_QUESTIONS },
  architecture: { maxRepairs: env.ARCH_MAX_REPAIRS, staleRunMs: env.ARCH_STALE_RUN_MS },
}, queue);

const worker = await queue.startWorker(rt.app);
logger.info({ provider: env.AI_PROVIDER }, 'worker started');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { logger.info({ sig }, 'shutting down'); void worker.stop().then(() => rt.prisma.$disconnect()).finally(() => process.exit(0)); });
}
