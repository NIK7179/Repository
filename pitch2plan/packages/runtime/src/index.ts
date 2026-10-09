import { AnthropicLLMProvider, IdeaInterpreter, LLMGateway, MockLLMProvider, createArchitectureAi, createAssistantAi, createChangeAi, createDiscoveryAi, createImplementationAi, type LLMProvider } from '@pitch2plan/ai';
import { createPrismaClient, createRepositories, type PrismaClient } from '@pitch2plan/db';
import { createApplication, type Application, type ArchitectureConfig, type DiscoveryConfig, type ChangeConfig, type ImplementationConfig, type JobQueue, type Logger, type Repositories } from '@pitch2plan/domain';

export interface RuntimeConfig {
  databaseUrl: string;
  ai: { provider: 'mock' | 'anthropic'; anthropicApiKey?: string; model: string; timeoutMs: number; maxRetries: number; debugLogPrompts?: boolean };
  discovery?: Partial<DiscoveryConfig>;
  architecture?: Partial<ArchitectureConfig>;
  implementation?: Partial<ImplementationConfig>;
  change?: Partial<ChangeConfig>;
  logger: Logger;
}
export interface Runtime { prisma: PrismaClient; repos: Repositories; app: Application; gateway: LLMGateway }

/**
 * The single composition root shared by the web app and the worker, so both build the application identically.
 * Concrete implementations (Prisma, the LLM provider, the queue) are wired to the domain's ports here and nowhere else.
 */
export function composeRuntime(cfg: RuntimeConfig, queue: JobQueue): Runtime {
  const prisma = createPrismaClient(cfg.databaseUrl);
  const repos = createRepositories(prisma);
  const live = cfg.ai.provider === 'anthropic';
  const provider: LLMProvider = live ? new AnthropicLLMProvider({ apiKey: cfg.ai.anthropicApiKey!, defaultModel: cfg.ai.model }) : new MockLLMProvider({ model: 'mock-1' });
  const gateway = new LLMGateway({
    provider, model: live ? cfg.ai.model : 'mock-1', timeoutMs: cfg.ai.timeoutMs, maxRetries: cfg.ai.maxRetries, logger: cfg.logger,
    debugLogPrompts: !!cfg.ai.debugLogPrompts, onUsage: (e) => repos.usage.record(e),
  });
  const app = createApplication({
    repos, interpreter: new IdeaInterpreter(gateway), discoveryAi: createDiscoveryAi(gateway), architectureAi: createArchitectureAi(gateway), implementationAi: createImplementationAi(gateway), assistantAi: createAssistantAi(gateway), changeAi: createChangeAi(gateway), queue,
    logger: cfg.logger, discoveryConfig: cfg.discovery, architectureConfig: cfg.architecture, implementationConfig: cfg.implementation, changeConfig: cfg.change,
  });
  return { prisma, repos, app, gateway };
}
