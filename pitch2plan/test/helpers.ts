import { randomUUID } from 'node:crypto';
import { IdeaInterpreter, LLMGateway, MockLLMProvider, type AIUsageEvent, type MockOptions } from '@pitch2plan/ai';
import { createApplication, noopLogger, type Application } from '@pitch2plan/domain';
import { createPrismaClient, createRepositories } from '@pitch2plan/db';

export const PITCH =
  'I want to create a platform that processes millions of transaction events in real time and detects fraud. Merchants should get alerts when a payment looks suspicious.';

export function makeApp(mock: MockOptions = {}) {
  const prisma = createPrismaClient(process.env.DATABASE_URL!);
  const repos = createRepositories(prisma);
  const provider = new MockLLMProvider(mock);
  const usage: AIUsageEvent[] = [];
  const gateway = new LLMGateway({
    provider, model: 'mock-1', timeoutMs: 5000, maxRetries: 0,
    onUsage: async (e) => { usage.push(e); await repos.usage.record(e); },
  });
  const app: Application = createApplication({ repos, interpreter: new IdeaInterpreter(gateway), logger: noopLogger });
  return { prisma, repos, app, provider, usage };
}

export async function signUp(app: Application, label = 'user') {
  const email = `${label}-${randomUUID()}@example.com`;
  const { user, workspace } = await app.users.provision({ externalId: `test:${email}`, email, name: label });
  return { user, workspace, ctx: { userId: user.id, requestId: `req-${randomUUID()}` } };
}
