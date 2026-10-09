import { randomUUID } from 'node:crypto';
import { IdeaInterpreter, LLMGateway, MockLLMProvider, createDiscoveryAi, type AIUsageEvent, type MockOptions } from '@pitch2plan/ai';
import { createApplication, noopLogger, type Application, type DiscoveryConfig } from '@pitch2plan/domain';
import { createPrismaClient, createRepositories } from '@pitch2plan/db';

export const PITCH =
  'I want to create a platform that processes millions of transaction events in real time and detects fraud. Merchants should get alerts when a payment looks suspicious.';

export function makeApp(mock: MockOptions = {}, discoveryConfig: Partial<DiscoveryConfig> = {}) {
  const prisma = createPrismaClient(process.env.DATABASE_URL!);
  const repos = createRepositories(prisma);
  const provider = new MockLLMProvider(mock);
  const usage: AIUsageEvent[] = [];
  const gateway = new LLMGateway({
    provider, model: 'mock-1', timeoutMs: 5000, maxRetries: 0,
    onUsage: async (e) => { usage.push(e); await repos.usage.record(e); },
  });
  const app: Application = createApplication({ repos, interpreter: new IdeaInterpreter(gateway), discoveryAi: createDiscoveryAi(gateway), logger: noopLogger, discoveryConfig });
  return { prisma, repos, app, provider, usage };
}

export async function signUp(app: Application, label = 'user') {
  const email = `${label}-${randomUUID()}@example.com`;
  const { user, workspace } = await app.users.provision({ externalId: `test:${email}`, email, name: label });
  return { user, workspace, ctx: { userId: user.id, requestId: `req-${randomUUID()}` } };
}

export const ON_PREM_PITCH = 'I want a reporting tool for our finance team. It must run entirely on-premises. Managers should receive weekly summaries.';

/** Signs up a user and gets a project through pitch + interpretation, ready for discovery. */
export async function projectReadyForDiscovery(h: ReturnType<typeof makeApp>, pitch = PITCH, label = 'owner') {
  const u = await signUp(h.app, label);
  const project = await h.app.projects.create(u.ctx, { name: 'Discovery project' });
  await h.app.pitches.submit(u.ctx, project.id, { content: pitch, technicalLevel: 'FOUNDER' });
  await h.app.interpretation.interpret(u.ctx, project.id, {});
  return { ...u, project };
}

type State = Awaited<ReturnType<Application['discovery']['getState']>>;
/** Answers every question in the open round: first option (or the supplied choice per question id). */
export function answerAll(state: State, overrides: Record<string, import('@pitch2plan/schemas').AnswerChoice> = {}) {
  const round = state.rounds.find((r) => r.status === 'OPEN' || r.status === 'ANSWERED')!;
  return {
    round,
    answers: round.questions.map((q) => ({
      questionId: q.id,
      choice: overrides[q.id] ?? (q.answerType === 'FREE_TEXT' ? { kind: 'FREE_TEXT' as const, text: 'Some free-text detail' } : { kind: 'OPTIONS' as const, optionIds: [q.options[0]!.id] }),
    })),
  };
}
