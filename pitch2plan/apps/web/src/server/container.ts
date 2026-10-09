import { PgBossJobQueue } from '@pitch2plan/jobs';
import { composeRuntime, type Runtime } from '@pitch2plan/runtime';
import type { AuthProvider } from './auth/provider';
import { DevAuthProvider } from './auth/dev';
import { getEnv } from './env';
import { getLogger } from './logger';
import { MemoryRateLimiter, type RateLimiter } from './rate-limit';

export interface Container extends Runtime { queue: PgBossJobQueue; auth: AuthProvider; rateLimiter: RateLimiter; authSecret: string }

const g = globalThis as unknown as { __p2p?: Container };

/** Web composition root. The shared runtime builds the application; this adds web-only concerns (auth, rate limiting) and the in-process worker. */
export function getContainer(): Container {
  if (g.__p2p) return g.__p2p;
  const env = getEnv();
  const logger = getLogger();
  const queue = new PgBossJobQueue(env.DATABASE_URL, { logger });
  const rt = composeRuntime({
    databaseUrl: env.DATABASE_URL, logger,
    ai: { provider: env.AI_PROVIDER, anthropicApiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL, timeoutMs: env.LLM_TIMEOUT_MS, maxRetries: env.LLM_MAX_RETRIES, debugLogPrompts: env.DEBUG_LOG_PROMPTS === 'true' && env.NODE_ENV !== 'production' },
    discovery: { maxDiscoveryRounds: env.DISCOVERY_MAX_ROUNDS, maxQuestionsPerRound: env.DISCOVERY_MAX_QUESTIONS },
    architecture: { maxRepairs: env.ARCH_MAX_REPAIRS, staleRunMs: env.ARCH_STALE_RUN_MS },
    implementation: { maxRepairs: env.ARCH_MAX_REPAIRS, staleRunMs: env.ARCH_STALE_RUN_MS },
  }, queue);
  const c: Container = { ...rt, queue, auth: new DevAuthProvider(env.AUTH_SECRET), rateLimiter: new MemoryRateLimiter(env.RATE_LIMIT_SCALE), authSecret: env.AUTH_SECRET };
  g.__p2p = c;
  const mode = env.WORKER_MODE ?? (env.NODE_ENV === 'production' ? 'external' : 'inline');
  if (mode === 'inline') void queue.startWorker(rt.app).catch((e) => logger.error({ err: String(e) }, 'inline worker failed to start'));
  return c;
}
