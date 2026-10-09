import { randomUUID } from 'node:crypto';
import { IdeaInterpreter, LLMGateway, MockLLMProvider, createArchitectureAi, createDiscoveryAi, type AIUsageEvent, type MockOptions } from '@pitch2plan/ai';
import { buildCodebook, buildPlanInput, createApplication, noopLogger, type Application, type ArchitectureConfig, type DiscoveryConfig, type JobQueue } from '@pitch2plan/domain';
import { createPrismaClient, createRepositories } from '@pitch2plan/db';

export const PITCH =
  'I want to create a platform that processes millions of transaction events in real time and detects fraud. Merchants should get alerts when a payment looks suspicious.';

/** Deterministic job queue for tests: jobs wait until a test runs them, so the worker's behaviour is explicit and controllable. */
export class ManualQueue implements JobQueue {
  jobs: Array<{ id: string; name: string; runId: string; singletonKey: string }> = [];
  failNext = false;
  async enqueue(name: string, payload: { runId: string }, o: { singletonKey: string }) {
    if (this.failNext) { this.failNext = false; throw new Error('queue unavailable'); }
    if (this.jobs.some((j) => j.singletonKey === o.singletonKey)) return null;
    const id = `job-${this.jobs.length + 1}-${o.singletonKey.slice(0, 8)}`;
    this.jobs.push({ id, name, runId: payload.runId, singletonKey: o.singletonKey });
    return id;
  }
}

export function makeApp(mock: MockOptions = {}, discoveryConfig: Partial<DiscoveryConfig> = {}, architectureConfig: Partial<ArchitectureConfig> = {}, customQueue?: JobQueue) {
  const prisma = createPrismaClient(process.env.DATABASE_URL!);
  const repos = createRepositories(prisma);
  const provider = new MockLLMProvider(mock);
  const usage: AIUsageEvent[] = [];
  const gateway = new LLMGateway({
    provider, model: 'mock-1', timeoutMs: 5000, maxRetries: 0,
    onUsage: async (e) => { usage.push(e); await repos.usage.record(e); },
  });
  const queue = new ManualQueue();
  const app: Application = createApplication({ repos, interpreter: new IdeaInterpreter(gateway), discoveryAi: createDiscoveryAi(gateway), architectureAi: createArchitectureAi(gateway), queue: customQueue ?? queue, logger: noopLogger, discoveryConfig, architectureConfig });
  /** Runs every queued job through the real worker entry point, like the pg-boss worker would. */
  const runJobs = async () => { const out = []; while (queue.jobs.length) out.push(await app.architecture.runGeneration(queue.jobs.shift()!.runId)); return out; };
  return { prisma, repos, app, provider, usage, queue, runJobs };
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

export const SIMPLE_PITCH = 'I want to build a scheduling app for independent fitness trainers and their clients.';

/** Gets a project all the way to confirmed requirements (REQUIREMENTS_CONFIRMED) through the real discovery flow. */
export async function confirmedProject(h: ReturnType<typeof makeApp>, opts: { pitch?: string; label?: string; overrides?: Record<string, import('@pitch2plan/schemas').AnswerChoice> } = {}) {
  const p = await projectReadyForDiscovery(h, opts.pitch ?? PITCH, opts.label ?? 'owner');
  let s = await h.app.discovery.start(p.ctx, p.project.id);
  await h.app.discovery.submitAnswers(p.ctx, p.project.id, s.rounds[0]!.id, { answers: answerAll(s, opts.overrides).answers });
  s = await h.app.discovery.next(p.ctx, p.project.id);
  await h.app.discovery.submitAnswers(p.ctx, p.project.id, s.rounds[1]!.id, { answers: answerAll(s).answers });
  await h.app.discovery.next(p.ctx, p.project.id);
  const view = await h.app.briefs.generate(p.ctx, p.project.id);
  await h.app.briefs.confirm(p.ctx, p.project.id, { briefVersionId: view.version.id, acceptedUnknownIds: [] });
  return p;
}

/** The exact planner input the service builds for a project, plus the code maps; lets tests script plausible model output. */
export async function contextFor(h: ReturnType<typeof makeApp>, projectId: string) {
  const brief = (await h.repos.briefs.getByProject(projectId))!;
  const version = (await h.repos.briefs.getVersion(brief.confirmedVersionId!))!;
  const [drivers, requirements] = await Promise.all([h.repos.briefs.listDrivers(version.id), h.repos.requirements.list(projectId)]);
  const codebook = buildCodebook(requirements, version.content.architectureDrivers.map((d) => d.id), drivers);
  const built = buildPlanInput({ context: { workspaceId: 'w', projectId, userId: 'u' }, project: { name: 'x' }, brief: version.content, requirements, drivers, codebook });
  return { ...built, codebook, briefVersionId: version.id };
}
