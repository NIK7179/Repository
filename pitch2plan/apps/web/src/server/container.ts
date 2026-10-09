import { AnthropicLLMProvider, IdeaInterpreter, LLMGateway, MockLLMProvider, createDiscoveryAi, type LLMProvider } from '@pitch2plan/ai';
import { createPrismaClient, createRepositories, type PrismaClient } from '@pitch2plan/db';
import { createApplication, type Application, type Repositories } from '@pitch2plan/domain';
import type { AuthProvider } from './auth/provider';
import { DevAuthProvider } from './auth/dev';
import { getEnv } from './env';
import { getLogger } from './logger';
import { MemoryRateLimiter, type RateLimiter } from './rate-limit';

export interface Container {
  prisma: PrismaClient; repos: Repositories; app: Application; auth: AuthProvider; rateLimiter: RateLimiter; authSecret: string;
}

const g = globalThis as unknown as { __p2p?: Container };

/** Composition root: the only place concrete implementations are wired to the domain's ports. */
export function getContainer(): Container {
  if (g.__p2p) return g.__p2p;
  const env = getEnv();
  const logger = getLogger();
  const prisma = createPrismaClient(env.DATABASE_URL);
  const repos = createRepositories(prisma);
  const provider: LLMProvider = env.AI_PROVIDER === 'anthropic'
    ? new AnthropicLLMProvider({ apiKey: env.ANTHROPIC_API_KEY!, defaultModel: env.ANTHROPIC_MODEL })
    : new MockLLMProvider({ model: 'mock-1' });
  const gateway = new LLMGateway({
    provider, model: env.AI_PROVIDER === 'anthropic' ? env.ANTHROPIC_MODEL : 'mock-1',
    timeoutMs: env.LLM_TIMEOUT_MS, maxRetries: env.LLM_MAX_RETRIES, logger,
    debugLogPrompts: env.DEBUG_LOG_PROMPTS === 'true' && env.NODE_ENV !== 'production',
    onUsage: (e) => repos.usage.record(e),
  });
  const app = createApplication({
    repos, interpreter: new IdeaInterpreter(gateway), discoveryAi: createDiscoveryAi(gateway), logger,
    discoveryConfig: { maxDiscoveryRounds: env.DISCOVERY_MAX_ROUNDS, maxQuestionsPerRound: env.DISCOVERY_MAX_QUESTIONS },
  });
  return (g.__p2p = { prisma, repos, app, auth: new DevAuthProvider(env.AUTH_SECRET), rateLimiter: new MemoryRateLimiter(), authSecret: env.AUTH_SECRET });
}
