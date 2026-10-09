import { IdeaInterpreter, LLMGateway, MockLLMProvider, createArchitectureAi, createDiscoveryAi } from '@pitch2plan/ai';
import { createPrismaClient, createRepositories } from '@pitch2plan/db';
import { createApplication, noopLogger } from '@pitch2plan/domain';

// Development seed. The pitch is a generic description; no architecture is hard-coded anywhere.
const PITCH = 'Create a real-time transaction analytics system where applications publish events, events are processed continuously, and processed data is stored for analytics.';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const prisma = createPrismaClient(url);
const repos = createRepositories(prisma);
const gateway = new LLMGateway({ provider: new MockLLMProvider(), model: 'mock-1', timeoutMs: 10_000, maxRetries: 0, onUsage: (e) => repos.usage.record(e) });
const app = createApplication({ repos, interpreter: new IdeaInterpreter(gateway), discoveryAi: createDiscoveryAi(gateway), architectureAi: createArchitectureAi(gateway), queue: { enqueue: async () => null }, logger: noopLogger });

const { user } = await app.users.provision({ externalId: 'dev:demo@pitch2plan.dev', email: 'demo@pitch2plan.dev', name: 'Demo User' });
const ctx = { userId: user.id, requestId: 'seed' };
const existing = (await app.projects.list(ctx)).find((p) => p.name === 'Real-time transaction analytics');
if (existing) {
  console.log(`Seed already present (project ${existing.id}).`);
} else {
  const project = await app.projects.create(ctx, { name: 'Real-time transaction analytics' });
  await app.pitches.submit(ctx, project.id, { content: PITCH, technicalLevel: 'DEVELOPER' });
  await app.interpretation.interpret(ctx, project.id, {});
  console.log(`Seeded demo project ${project.id} for demo@pitch2plan.dev`);
}
await prisma.$disconnect();
