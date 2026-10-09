import { afterAll, describe, expect, it } from 'vitest';
import { mockImplPlan } from '@pitch2plan/ai';
import { AIError } from '@pitch2plan/ai';
import type { AssistantAiPort } from '@pitch2plan/domain';
import { PITCH, SIMPLE_PITCH, architectureReadyProject, confirmedProject, implInputFor, implementationReadyProject, makeApp, signUp } from '../helpers';

const h = makeApp();
afterAll(() => h.prisma.$disconnect());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = async (p: { ctx: Parameters<typeof h.app.projects.get>[0]; project: { id: string } }) => (await h.app.projects.get(p.ctx, p.project.id)).project.status;
const taskId = (plan: { tasks: Array<{ id: string; key: string }> }, key: string) => plan.tasks.find((t) => t.key === key)!.id;
const jsonOf = (...xs: unknown[]) => xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
type Impl = Awaited<ReturnType<typeof implementationReadyProject>>;

async function completeTask(p: Impl, key: string, app = h) {
  const plan = (await app.app.implementation.getOverview(p.ctx, p.project.id)).plan!;
  const id = taskId(plan, key);
  await app.app.implementation.updateStatus(p.ctx, id, { status: 'IN_PROGRESS' });
  const t = await app.app.implementation.getTask(p.ctx, id);
  await app.app.implementation.confirmValidation(p.ctx, id, t.task.validations.map((v) => ({ position: v.position, confirmed: true })));
  return app.app.implementation.updateStatus(p.ctx, id, { status: 'COMPLETED' });
}

describe('generating an implementation plan end to end', () => {
  it('READY architecture -> queued job -> worker -> persisted plan bound to the architecture version; the project stays ARCHITECTURE_READY', async () => {
    const p = await architectureReadyProject(h);
    expect((await h.app.implementation.getOverview(p.ctx, p.project.id)).state).toBe('NOT_STARTED');
    const g = await h.app.implementation.generate(p.ctx, p.project.id);
    expect(g).toMatchObject({ status: 'QUEUED' });
    expect(h.queue.jobs).toMatchObject([{ name: 'implementation.generate', runId: g.generationRunId, singletonKey: g.generationRunId }]);
    expect((await h.app.implementation.getOverview(p.ctx, p.project.id)).state).toBe('GENERATING');
    expect(await h.app.implementation.getJob(p.ctx, g.jobId)).toMatchObject({ id: g.generationRunId, status: 'QUEUED' });
    expect(await statusOf(p)).toBe('ARCHITECTURE_READY'); // generating a plan is not starting to implement

    expect(await h.runJobs()).toMatchObject([{ outcome: 'SUCCEEDED', created: true }]);
    expect(await statusOf(p)).toBe('ARCHITECTURE_READY');
    const o = await h.app.implementation.getOverview(p.ctx, p.project.id);
    expect(o.state).toBe('READY');
    const plan = o.plan!;
    const arch = (await h.app.architecture.getOverview(p.ctx, p.project.id)).current!;
    expect(plan.version.architectureVersionId).toBe(arch.version.id); // bound to ONE architecture version
    expect(plan.phases.map((x) => x.sequence)).toEqual(plan.phases.map((_, i) => i));
    expect(plan.phases.every((x) => plan.tasks.some((t) => t.phaseKey === x.key))).toBe(true);
    expect(plan.tasks.length).toBeGreaterThanOrEqual(20); expect(plan.tasks.length).toBeLessThanOrEqual(40);
    const keys = new Set(plan.tasks.map((t) => t.key));
    for (const t of plan.tasks) { for (const d of t.dependsOn) expect(keys.has(d)).toBe(true); expect(t.dependsOn).not.toContain(t.key); }
    const nodeKeys = new Set(arch.version.nodes.map((n) => n.stableKey));
    for (const t of plan.tasks) for (const c of t.componentKeys) expect(nodeKeys.has(c), `${t.key} -> ${c}`).toBe(true); // linked by stableKey, never by technology name
    expect(plan.coverage.summary).toMatchObject({ total: arch.version.nodes.length, uncovered: 0 });
    expect(plan.coverage.components.find((c) => c.stableKey === 'event-producers')).toMatchObject({ status: 'COVERED' });
    const decisionKeys = new Set(arch.decisions.filter((d) => d.status === 'ACCEPTED').map((d) => d.key));
    expect(plan.tasks.flatMap((t) => t.decisionKeys).every((d) => decisionKeys.has(d))).toBe(true);
    expect(new Set(plan.tasks.flatMap((t) => t.decisionKeys)).size).toBeGreaterThan(0);
    expect(plan.next).toMatchObject({ key: 'prepare-environment', kind: 'START' });
    expect(plan.progress.overall).toMatchObject({ completed: 0, percent: 0 });
    expect(await h.app.implementation.getJob(p.ctx, g.jobId)).toMatchObject({ status: 'SUCCEEDED', currentStage: 'COMPLETE', planVersionId: plan.version.id });

    // decision links are real rows, and the chain Requirement -> Driver -> Decision -> Component -> Task is queryable
    expect(await h.prisma.taskDecisionLink.count({ where: { task: { planVersionId: plan.version.id } } })).toBeGreaterThan(0);
    expect(await h.prisma.taskComponentLink.count({ where: { architectureVersionId: arch.version.id, task: { planVersionId: plan.version.id } } })).toBeGreaterThan(0);
    const usage = await h.prisma.usageEvent.findMany({ where: { projectId: p.project.id, capability: { in: ['IMPLEMENTATION_PLANNER', 'IMPLEMENTATION_CRITIC', 'IMPLEMENTATION_REPAIRER'] } } });
    expect(usage.map((u) => `${u.capability}:${u.promptVersion}`).sort()).toEqual(['IMPLEMENTATION_CRITIC:1', 'IMPLEMENTATION_PLANNER:1']);
    expect((await h.prisma.auditLog.findMany({ where: { projectId: p.project.id, action: { startsWith: 'implementation.' } } })).map((a) => a.action).sort()).toEqual(['implementation.generated', 'implementation.generation_started']);
  });

  it('plans a SIMPLE system simply: no event infrastructure, far fewer tasks, nothing about technology that is not in the architecture', async () => {
    const simple = await implementationReadyProject(h, { pitch: SIMPLE_PITCH });
    const big = await implementationReadyProject(h);
    expect(simple.plan.tasks.length).toBeLessThan(big.plan.tasks.length);
    expect(simple.plan.tasks.length).toBeLessThanOrEqual(20);
    const text = JSON.stringify(simple.plan.tasks.map((t) => t.title)).toLowerCase();
    for (const heavy of ['kafka', 'kubernetes', 'spark', 'flink', 'stream processor', 'event stream']) expect(text, heavy).not.toContain(heavy);
    expect(simple.plan.phases.map((x) => x.key)).not.toContain('event-infrastructure');
  });

  it('writes tasks for THIS deployment: managed services are provisioned, not installed; settings come from the architecture', async () => {
    const p = await implementationReadyProject(h);
    const t = await h.app.implementation.getTask(p.ctx, taskId(p.plan, 'provision-primary-database'));
    expect(t.task.instructions).toMatch(/managed service, so there is nothing to install/);
    expect(t.task.title).toMatch(/Primary database \(Managed PostgreSQL\)/);
    expect(t.components).toMatchObject([{ stableKey: 'primary-database', technology: 'Managed PostgreSQL' }]);
    expect(t.decisions.length).toBeGreaterThan(0);
    expect(t.task.whyThisTask).toMatch(/ADR-\d{3}/);
    expect(t.task.steps.length).toBe(3);
    expect(t.validation).toMatchObject({ confirmed: 0, total: 2, allConfirmed: false });
    expect(t.requirements.every((r) => /^REQ-\d{3}$/.test(r.code))).toBe(true);
  });
});

describe('eligibility, authorization and concurrency', () => {
  it('requires a READY architecture, refuses duplicates, and respects roles and workspaces', async () => {
    const early = await confirmedProject(h);
    await expect(h.app.implementation.generate(early.ctx, early.project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const p = await architectureReadyProject(h);
    const viewer = await signUp(h.app, 'viewer'); const intruder = await signUp(h.app, 'intruder');
    await h.prisma.workspaceMember.create({ data: { workspaceId: p.workspace.id, userId: viewer.user.id, role: 'VIEWER' } });
    await expect(h.app.implementation.generate(viewer.ctx, p.project.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.app.implementation.generate(intruder.ctx, p.project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await h.app.implementation.generate(p.ctx, p.project.id);
    await expect(h.app.implementation.generate(p.ctx, p.project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' }); // active run
    await h.runJobs();
    await expect(h.app.implementation.generate(p.ctx, p.project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' }); // plan exists for this architecture version
    expect(await h.prisma.implementationGenerationRun.count({ where: { projectId: p.project.id } })).toBe(1);
    expect((await h.app.implementation.getOverview(viewer.ctx, p.project.id)).state).toBe('READY'); // viewers may read
  });

  it('lets exactly one of two simultaneous generate requests win (the database allows one ACTIVE run per project)', async () => {
    const p = await architectureReadyProject(h);
    const before = h.queue.jobs.length;
    const r = await Promise.allSettled([h.app.implementation.generate(p.ctx, p.project.id), h.app.implementation.generate(p.ctx, p.project.id)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.find((x) => x.status === 'rejected')).toMatchObject({ reason: { code: 'INVALID_STATE' } });
    expect(h.queue.jobs.length - before).toBe(1);
    await h.runJobs();
  });

  it('enforces one active run per project in the database independently of the application', async () => {
    const p = await architectureReadyProject(h);
    const av = (await h.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.id;
    const data = { projectId: p.project.id, architectureVersionId: av, requestedById: p.user.id };
    await h.prisma.implementationGenerationRun.create({ data });
    await expect(h.prisma.implementationGenerationRun.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    await h.prisma.implementationGenerationRun.create({ data: { ...data, status: 'FAILED' } }); // finished runs do not count
  });

  it("hides another workspace's tasks, plans, jobs and conversations", async () => {
    const p = await implementationReadyProject(h); const intruder = await signUp(h.app, 'intruder');
    const id = taskId(p.plan, 'prepare-environment');
    await expect(h.app.implementation.getTask(intruder.ctx, id)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(h.app.implementation.updateStatus(intruder.ctx, id, { status: 'IN_PROGRESS' })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(h.app.implementation.confirmValidation(intruder.ctx, id, [{ position: 0, confirmed: true }])).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(h.app.implementation.getPlan(intruder.ctx, p.plan.version.id)).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    await expect(h.app.implementation.getOverview(intruder.ctx, p.project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(h.app.implementation.getComponent(intruder.ctx, p.project.id, 'event-stream')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    const run = (await h.repos.implementation.getLatestRun(p.project.id))!;
    await expect(h.app.implementation.getJob(intruder.ctx, run.jobId!)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});

describe('idempotency and failure recovery', () => {
  it('survives duplicate deliveries and simultaneous workers: exactly one plan', async () => {
    const p = await architectureReadyProject(h);
    const g = await h.app.implementation.generate(p.ctx, p.project.id); h.queue.jobs.length = 0;
    const out = await Promise.all([1, 2, 3, 4].map(() => h.app.implementation.runGeneration(g.generationRunId)));
    expect(out.filter((o) => o.outcome === 'SUCCEEDED')).toHaveLength(1);
    expect(out.filter((o) => o.outcome !== 'SUCCEEDED').every((o) => ['NOT_CLAIMED', 'ALREADY_DONE'].includes(o.outcome))).toBe(true);
    expect(await h.app.implementation.runGeneration(g.generationRunId)).toMatchObject({ outcome: 'ALREADY_DONE' });
    expect(await h.prisma.implementationPlanVersion.count({ where: { plan: { projectId: p.project.id } } })).toBe(1);
    expect((await h.repos.implementation.getRun(g.generationRunId))!.attempt).toBe(1);
  });

  it('finalizing the same run twice returns the same plan', async () => {
    const p = await architectureReadyProject(h);
    const g = await h.app.implementation.generate(p.ctx, p.project.id); h.queue.jobs.length = 0;
    const { k, input, ctx } = await implInputFor(h, p.project.id);
    await h.repos.implementation.claimRun(g.generationRunId, new Date(0));
    const plan = mockImplPlan(input as never) as never;
    const fin = { runId: g.generationRunId, projectId: p.project.id, architectureVersionId: k.architecture.id, plan, decisionIdByKey: Object.fromEntries(k.architecture.decisions.map((d) => [d.key, d.id])), requirementIdByCode: k.codebook.requirementIdByCode, issues: [], ai: {} };
    const a = await h.repos.implementation.finalize(fin); const b = await h.repos.implementation.finalize(fin);
    expect(a.created).toBe(true); expect(b).toEqual({ planVersionId: a.planVersionId, created: false });
    expect(await h.prisma.implementationPlanVersion.count({ where: { plan: { projectId: p.project.id } } })).toBe(1);
    expect(ctx.components.length).toBeGreaterThan(0);
  });

  it('reclaims a run whose worker died, and still produces exactly one plan', async () => {
    const quick = makeApp({}, {}, {}, undefined, { staleRunMs: 400 });
    try {
      const p = await architectureReadyProject(quick);
      const g = await quick.app.implementation.generate(p.ctx, p.project.id); quick.queue.jobs.length = 0;
      expect(await quick.repos.implementation.claimRun(g.generationRunId, new Date(0))).toMatchObject({ status: 'RUNNING', attempt: 1 });
      expect(await quick.repos.implementation.claimRun(g.generationRunId, new Date(Date.now() - 400))).toBeNull();
      await sleep(450);
      expect(await quick.app.implementation.runGeneration(g.generationRunId)).toMatchObject({ outcome: 'SUCCEEDED' });
      expect(await quick.repos.implementation.getRun(g.generationRunId)).toMatchObject({ status: 'SUCCEEDED', attempt: 2 });
      expect(await quick.prisma.implementationPlanVersion.count({ where: { plan: { projectId: p.project.id } } })).toBe(1);
    } finally { await quick.prisma.$disconnect(); }
  });

  it('on failure the project stays ARCHITECTURE_READY, nothing is half-saved, the message is safe, and a retry works', async () => {
    const p = await architectureReadyProject(h);
    const bad = makeApp({ script: ['Use microservices!', 'Definitely.'] });
    try { await bad.app.implementation.generate(p.ctx, p.project.id); expect(await bad.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'AI_OUTPUT_INVALID' }]); } finally { await bad.prisma.$disconnect(); }
    expect(await statusOf(p)).toBe('ARCHITECTURE_READY');
    const o = await h.app.implementation.getOverview(p.ctx, p.project.id);
    expect(o.state).toBe('FAILED');
    expect(o.run).toMatchObject({ status: 'FAILED', failureCode: 'AI_OUTPUT_INVALID' });
    expect(o.run!.failureMessage).not.toMatch(/microservices|JSON|Zod/);
    expect(await h.prisma.implementationPlanVersion.count({ where: { plan: { projectId: p.project.id } } })).toBe(0);
    await h.app.implementation.generate(p.ctx, p.project.id);
    expect(await h.runJobs()).toMatchObject([{ outcome: 'SUCCEEDED' }]);
    expect((await h.app.implementation.getOverview(p.ctx, p.project.id)).state).toBe('READY');
  });

  it('never exposes provider errors or secrets, and recovers from a lost job, a down queue and a changed project', async () => {
    const p = await architectureReadyProject(h);
    const down = makeApp({ script: [new AIError('AI_PROVIDER_ERROR', 'LEAKMARKER api_key=sk-ant-SECRET at /srv/app.js:1', false)] });
    try { await down.app.implementation.generate(p.ctx, p.project.id); await down.runJobs(); } finally { await down.prisma.$disconnect(); }
    const run = (await h.app.implementation.getOverview(p.ctx, p.project.id)).run!;
    expect(`${run.failureCode} ${run.failureMessage}`).not.toMatch(/LEAKMARKER|SECRET|sk-ant|srv\/app/);
    expect(run.failureMessage).toBe('The AI service is temporarily unavailable.');

    h.queue.failNext = true;
    await expect(h.app.implementation.generate(p.ctx, p.project.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await h.repos.implementation.getLatestRun(p.project.id)).toMatchObject({ status: 'FAILED', failureCode: 'ENQUEUE_FAILED' });

    const lost = makeApp({}, {}, {}, undefined, { staleRunMs: 400 });
    try {
      await lost.app.implementation.generate(p.ctx, p.project.id); lost.queue.jobs.length = 0; await sleep(450);
      const o = await lost.app.implementation.getOverview(p.ctx, p.project.id);
      expect(o).toMatchObject({ state: 'FAILED', run: { failureCode: 'GENERATION_TIMED_OUT' } });
      await lost.app.implementation.generate(p.ctx, p.project.id);
      await h.prisma.project.update({ where: { id: p.project.id }, data: { status: 'ARCHIVED' } });
      expect(await lost.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'PROJECT_STATE_CHANGED' }]);
      expect(await statusOf(p)).toBe('ARCHIVED');
    } finally { await lost.prisma.$disconnect(); }
  });
});

describe('the repair cycle on a real architecture', () => {
  type Built = Awaited<ReturnType<typeof implInputFor>>;
  const planJson = (b: Built, edit: (p: ReturnType<typeof mockImplPlan>) => void = () => undefined) => { const p = mockImplPlan(b.input as never); edit(p); return p; };
  async function scripted(...script: Array<unknown | ((b: Built) => unknown)>) {
    const p = await architectureReadyProject(h); const b = await implInputFor(h, p.project.id);
    const s = makeApp({ script: jsonOf(...script.map((x) => (typeof x === 'function' ? (x as (b: Built) => unknown)(b) : x))) });
    return { p, s, b };
  }
  const clean = { assessment: 'The plan covers the architecture.', issues: [] };
  const critical = { assessment: 'The plan has a serious ordering problem.', issues: [{ severity: 'CRITICAL', category: 'ORDERING', description: 'Monitoring is scheduled before anything exists to monitor.', taskKeys: ['deploy-and-launch'], componentKeys: [], decisionKeys: [], recommendation: 'Move monitoring after the components are configured.' }] };
  const noopPatch = { changes: [{ issueIndex: 0, description: 'Reordered the monitoring work' }] };

  it('repairs a dependency cycle BEFORE the critic ever sees the plan, using a targeted patch', async () => {
    const { p, s } = await scripted((b: Built) => planJson(b, (pl) => { (pl.tasks[0] as unknown as { dependsOn: string[] }).dependsOn = ['configure-secrets-and-identity']; }), { changes: [{ issueIndex: 0, description: 'Removed the backwards dependency' }], tasks: { update: [{ key: 'prepare-environment', set: { dependsOn: [] } }] } }, clean);
    try {
      await s.app.implementation.generate(p.ctx, p.project.id);
      expect(await s.runJobs()).toMatchObject([{ outcome: 'SUCCEEDED' }]);
      const plan = (await s.app.implementation.getOverview(p.ctx, p.project.id)).plan!;
      expect(plan.tasks.find((t) => t.key === 'prepare-environment')!.dependsOn).toEqual([]);
      expect(plan.tasks.find((t) => t.key === 'configure-secrets-and-identity')!.dependsOn).toEqual(['prepare-environment']); // untouched parts stay untouched
      expect(s.provider.calls.map((c) => /PROMPT_ID: (\w+)_V1/.exec(c.system)![1])).toEqual(['IMPLEMENTATION_PLANNER', 'IMPLEMENTATION_REPAIRER', 'IMPLEMENTATION_CRITIC']);
      const stored = await s.prisma.implementationGenerationIssue.findMany({ where: { planVersion: { plan: { projectId: p.project.id } } } });
      expect(stored.map((i) => `${i.stage}:${i.code}`)).toContain('PLAN:DEPENDENCY_CYCLE');
    } finally { await s.prisma.$disconnect(); }
  });

  it('sends a CRITICAL critic finding to the repairer and re-reviews the result', async () => {
    const { p, s } = await scripted((b: Built) => planJson(b), critical, noopPatch, clean);
    try {
      await s.app.implementation.generate(p.ctx, p.project.id);
      expect(await s.runJobs()).toMatchObject([{ outcome: 'SUCCEEDED' }]);
      expect(s.provider.calls.map((c) => /PROMPT_ID: (\w+)_V1/.exec(c.system)![1])).toEqual(['IMPLEMENTATION_PLANNER', 'IMPLEMENTATION_CRITIC', 'IMPLEMENTATION_REPAIRER', 'IMPLEMENTATION_CRITIC']);
    } finally { await s.prisma.$disconnect(); }
  });

  it('gives up after the repair cap: the run fails, findings are kept, nothing half-finished is saved, the project is untouched', async () => {
    const { p, s } = await scripted((b: Built) => planJson(b), critical, noopPatch, critical, noopPatch, critical);
    try {
      await s.app.implementation.generate(p.ctx, p.project.id);
      expect(await s.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'IMPLEMENTATION_VALIDATION_FAILED' }]);
      expect(s.provider.calls).toHaveLength(6);
      expect(await statusOf(p)).toBe('ARCHITECTURE_READY');
      const run = (await s.repos.implementation.getLatestRun(p.project.id))!;
      expect(run.repairCount).toBe(2);
      expect((await s.prisma.implementationGenerationIssue.findMany({ where: { runId: run.id } })).some((i) => i.stage === 'FINAL' && i.severity === 'CRITICAL')).toBe(true);
      expect(await s.prisma.implementationPlanVersion.count({ where: { plan: { projectId: p.project.id } } })).toBe(0);
    } finally { await s.prisma.$disconnect(); }
  });

  it('rejects plans that reference components, decisions or tasks that do not exist, and fails cleanly', async () => {
    for (const edit of [
      (pl: ReturnType<typeof mockImplPlan>) => { (pl.tasks[2] as unknown as { componentKeys: string[] }).componentKeys = ['no-such-component']; },
      (pl: ReturnType<typeof mockImplPlan>) => { (pl.tasks[2] as unknown as { decisionKeys: string[] }).decisionKeys = ['adr-099']; },
      (pl: ReturnType<typeof mockImplPlan>) => { (pl.tasks[2] as unknown as { dependsOn: string[] }).dependsOn = ['ghost-task']; },
    ]) {
      const { p, s } = await scripted((b: Built) => planJson(b, edit), (b: Built) => planJson(b, edit));
      try { await s.app.implementation.generate(p.ctx, p.project.id); expect(await s.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'AI_OUTPUT_INVALID' }]); } finally { await s.prisma.$disconnect(); }
    }
  });
});

describe('task progress, history and completion', () => {
  it('walks a task through its lifecycle: only valid transitions, a recorded history, and the project moves to IMPLEMENTING on the first start', async () => {
    const p = await implementationReadyProject(h);
    const first = taskId(p.plan, 'prepare-environment'); const later = taskId(p.plan, 'provision-primary-database');
    expect(await statusOf(p)).toBe('ARCHITECTURE_READY');

    await expect(h.app.implementation.updateStatus(p.ctx, later, { status: 'IN_PROGRESS' })).rejects.toMatchObject({ code: 'INVALID_STATE', details: { unmetDependencies: [expect.objectContaining({ key: 'prepare-environment' })] } });
    await expect(h.app.implementation.updateStatus(p.ctx, first, { status: 'COMPLETED' })).rejects.toMatchObject({ code: 'INVALID_STATE' }); // NOT_STARTED -> COMPLETED is not a thing
    await expect(h.app.implementation.updateStatus(p.ctx, first, { status: 'BLOCKED' })).rejects.toMatchObject({ code: 'INVALID_STATE' });

    let t = await h.app.implementation.updateStatus(p.ctx, first, { status: 'IN_PROGRESS' });
    expect(t.task.status).toBe('IN_PROGRESS'); expect(await statusOf(p)).toBe('IMPLEMENTING');
    t = await h.app.implementation.updateStatus(p.ctx, first, { status: 'BLOCKED', reason: 'Waiting for the cloud account to be approved' });
    expect(t.task.status).toBe('BLOCKED');
    expect((await h.app.implementation.getOverview(p.ctx, p.project.id)).plan!.phases.find((x) => x.key === 'foundation')!.status).toBe('BLOCKED');
    await h.app.implementation.updateStatus(p.ctx, first, { status: 'IN_PROGRESS' });

    await expect(h.app.implementation.updateStatus(p.ctx, first, { status: 'COMPLETED' })).rejects.toMatchObject({ code: 'CONFIRMATION_BLOCKED', details: { unconfirmed: [expect.objectContaining({ position: 0 }), expect.objectContaining({ position: 1 })] } });
    await h.app.implementation.confirmValidation(p.ctx, first, [{ position: 0, confirmed: true }]);
    await expect(h.app.implementation.updateStatus(p.ctx, first, { status: 'COMPLETED' })).rejects.toMatchObject({ code: 'CONFIRMATION_BLOCKED' }); // still one unconfirmed
    const v = await h.app.implementation.confirmValidation(p.ctx, first, [{ position: 1, confirmed: true }]);
    expect(v.allConfirmed).toBe(true);
    expect(v.validations.every((x) => x.confirmationKind === 'USER_CONFIRMED' && x.confirmedById)).toBe(true); // never "verified": the user confirmed it
    t = await h.app.implementation.updateStatus(p.ctx, first, { status: 'COMPLETED' });
    expect(t.task.status).toBe('COMPLETED');
    expect(t.events.map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(['NOT_STARTED>IN_PROGRESS', 'IN_PROGRESS>BLOCKED', 'BLOCKED>IN_PROGRESS', 'IN_PROGRESS>COMPLETED']);
    expect(t.events[1]!.reason).toBe('Waiting for the cloud account to be approved');
    expect(await h.prisma.taskValidation.count({ where: { taskId: first, confirmationKind: 'SYSTEM_VERIFIED' } })).toBe(0);

    const o = (await h.app.implementation.getOverview(p.ctx, p.project.id)).plan!;
    expect(o.progress.overall.completed).toBe(1);
    expect(o.phases.find((x) => x.key === 'foundation')!.progress.completed).toBe(1);
    expect(o.tasks.find((x) => x.key === 'configure-secrets-and-identity')!.readiness).toBe('READY'); // its dependency is done
    expect(o.next).toMatchObject({ key: 'configure-secrets-and-identity', kind: 'START' });
    expect(o.next!.reason).toMatch(/Prepare the .* environment and repository is complete/);
    expect(await h.app.implementation.updateStatus(p.ctx, first, { status: 'IN_PROGRESS' }).then((r) => r.task.status)).toBe('IN_PROGRESS'); // reopen is allowed, and recorded
    expect((await h.app.implementation.getTask(p.ctx, first)).events).toHaveLength(5);
  });

  it('needs the task to be started before validation or steps can be touched, and rejects unknown steps', async () => {
    const p = await implementationReadyProject(h); const id = taskId(p.plan, 'prepare-environment');
    await expect(h.app.implementation.confirmValidation(p.ctx, id, [{ position: 0, confirmed: true }])).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const t0 = await h.app.implementation.getTask(p.ctx, id);
    await expect(h.app.implementation.updateStep(p.ctx, id, t0.task.steps[0]!.id, 'COMPLETED')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await h.app.implementation.updateStatus(p.ctx, id, { status: 'IN_PROGRESS' });
    await expect(h.app.implementation.confirmValidation(p.ctx, id, [{ position: 9, confirmed: true }])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await h.app.implementation.updateStep(p.ctx, id, t0.task.steps[0]!.id, 'COMPLETED');
    expect((await h.app.implementation.getTask(p.ctx, id)).task.steps[0]).toMatchObject({ status: 'COMPLETED' });
    await expect(h.app.implementation.updateStep(p.ctx, id, '00000000-0000-4000-8000-000000000000', 'COMPLETED')).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await h.app.implementation.confirmValidation(p.ctx, id, [{ position: 0, confirmed: true }]);
    await h.app.implementation.confirmValidation(p.ctx, id, [{ position: 0, confirmed: false }]); // the user can take a confirmation back
    expect((await h.app.implementation.getTask(p.ctx, id)).validation.confirmed).toBe(0);
  });

  it('lets viewers read progress but not change it, and treats skipped tasks as excluded from progress', async () => {
    const p = await implementationReadyProject(h); const viewer = await signUp(h.app, 'viewer');
    await h.prisma.workspaceMember.create({ data: { workspaceId: p.workspace.id, userId: viewer.user.id, role: 'VIEWER' } });
    const id = taskId(p.plan, 'prepare-environment');
    expect((await h.app.implementation.getTask(viewer.ctx, id)).task.key).toBe('prepare-environment');
    await expect(h.app.implementation.updateStatus(viewer.ctx, id, { status: 'IN_PROGRESS' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.app.implementation.confirmValidation(viewer.ctx, id, [{ position: 0, confirmed: true }])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const before = (await h.app.implementation.getOverview(p.ctx, p.project.id)).plan!.progress.overall;
    await h.app.implementation.updateStatus(p.ctx, taskId(p.plan, 'monitor-api'), { status: 'SKIPPED' });
    const after = (await h.app.implementation.getOverview(p.ctx, p.project.id)).plan!.progress.overall;
    expect(after).toMatchObject({ skipped: 1, completed: 0, applicable: before.applicable - 1 });
  });

  it('lets skipped prerequisites unblock dependents, but never lets a task start while one is merely in progress', async () => {
    const p = await implementationReadyProject(h);
    const env = taskId(p.plan, 'prepare-environment'); const sec = taskId(p.plan, 'configure-secrets-and-identity');
    await h.app.implementation.updateStatus(p.ctx, env, { status: 'IN_PROGRESS' });
    await expect(h.app.implementation.updateStatus(p.ctx, sec, { status: 'IN_PROGRESS' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await h.app.implementation.updateStatus(p.ctx, env, { status: 'SKIPPED' });
    expect((await h.app.implementation.updateStatus(p.ctx, sec, { status: 'IN_PROGRESS' })).task.status).toBe('IN_PROGRESS');
  });

  it('lets exactly one of two simultaneous status changes win (compare-and-set), recording one history event', async () => {
    const p = await implementationReadyProject(h); const id = taskId(p.plan, 'prepare-environment');
    const r = await Promise.allSettled([h.app.implementation.updateStatus(p.ctx, id, { status: 'IN_PROGRESS' }), h.app.implementation.updateStatus(p.ctx, id, { status: 'SKIPPED' })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.find((x) => x.status === 'rejected')).toMatchObject({ reason: { code: 'INVALID_STATE' } });
    expect(await h.prisma.taskProgressEvent.count({ where: { taskId: id } })).toBe(1);
  });

  it('full path: plan -> open task -> start -> confirm validation -> complete', async () => {
    const p = await implementationReadyProject(h);
    const done = await completeTask(p, 'prepare-environment');
    expect(done.task.status).toBe('COMPLETED'); expect(done.validation.allConfirmed).toBe(true);
    expect((await h.app.projects.get(p.ctx, p.project.id)).project.status).toBe('IMPLEMENTING');
    expect((await h.app.implementation.getOverview(p.ctx, p.project.id)).plan!.progress.overall.completed).toBe(1);
  });
});

describe('the plan is bound to its architecture version and its content cannot change', () => {
  it('rejects re-pointing the plan, editing task content, or tampering with links; only status may change', async () => {
    const p = await implementationReadyProject(h); const id = taskId(p.plan, 'prepare-environment');
    const fail = (sql: string) => expect(h.prisma.$executeRawUnsafe(sql), sql).rejects.toThrow(/bound to its architecture version|content is immutable/i);
    await fail(`UPDATE "ImplementationPlanVersion" SET "architectureVersionId" = gen_random_uuid() WHERE "id" = '${p.plan.version.id}'`);
    await fail(`UPDATE "ImplementationPlanVersion" SET "generationRunId" = gen_random_uuid() WHERE "id" = '${p.plan.version.id}'`);
    await fail(`UPDATE "ImplementationTask" SET "title" = 'tampered' WHERE "id" = '${id}'`);
    await fail(`UPDATE "ImplementationTask" SET "instructions" = 'tampered' WHERE "id" = '${id}'`);
    await h.prisma.$executeRawUnsafe(`UPDATE "ImplementationTask" SET "status" = 'IN_PROGRESS' WHERE "id" = '${id}'`); // status is allowed
    const row = await h.prisma.implementationPlanVersion.findUniqueOrThrow({ where: { id: p.plan.version.id } });
    const arch = (await h.app.architecture.getOverview(p.ctx, p.project.id)).current!.version;
    expect(row.architectureVersionId).toBe(arch.id);
    expect(await h.prisma.implementationPlanVersion.count({ where: { architectureVersionId: arch.id } })).toBe(1); // one plan per architecture version
  });
});

describe('one plan per architecture version, enforced by the database', () => {
  it('rejects a second plan version for the same architecture version even if the application check is bypassed', async () => {
    const p = await implementationReadyProject(h);
    const plan = await h.prisma.implementationPlan.findUniqueOrThrow({ where: { projectId: p.project.id } });
    const run = await h.prisma.implementationGenerationRun.create({ data: { projectId: p.project.id, architectureVersionId: p.plan.version.architectureVersionId, requestedById: p.user.id, status: 'FAILED' } });
    await expect(h.prisma.implementationPlanVersion.create({ data: { planId: plan.id, versionNumber: 2, architectureVersionId: p.plan.version.architectureVersionId, generationRunId: run.id, summary: 's', componentCoverage: [], ai: {} } })).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('component workspace and navigation data', () => {
  it('aggregates architecture FACTS and AI GUIDANCE separately, with the tasks that implement the component', async () => {
    const p = await implementationReadyProject(h);
    const c = await h.app.implementation.getComponent(p.ctx, p.project.id, 'event-stream');
    expect(c.facts.component).toMatchObject({ stableKey: 'event-stream', technology: 'Managed event streaming', managedService: true });
    expect(c.facts.connections.map((x) => `${x.direction}:${x.component.stableKey}`).sort()).toEqual(['in:event-producers', 'out:stream-processor']);
    expect(c.facts.decisions.length).toBeGreaterThan(0); expect(c.facts.drivers.length).toBeGreaterThan(0); expect(c.facts.requirements.length).toBeGreaterThan(0);
    expect(c.implementation.hasPlan).toBe(true);
    expect(c.implementation.tasks.map((t) => t.key)).toEqual(expect.arrayContaining(['provision-event-stream', 'configure-event-stream', 'monitor-event-stream']));
    expect(c.implementation.progress).toMatchObject({ completed: 0 });
    expect(c.implementation.coverage).toMatchObject({ status: 'COVERED' });
    expect(c.guidance.monitoring.map((m) => m.title).join()).toMatch(/consumer lag/);
    expect(c.guidance.commonIssues.length).toBeGreaterThan(0);
    expect(JSON.stringify(c.facts)).not.toMatch(/commonProblems|whyThisTask/); // guidance never leaks into facts
    await completeTask(p, 'prepare-environment');
    await h.app.implementation.updateStatus(p.ctx, taskId(p.plan, 'provision-event-stream'), { status: 'IN_PROGRESS' });
    const after = await h.app.implementation.getComponent(p.ctx, p.project.id, 'event-stream');
    expect(after.implementation.currentTask).toMatchObject({ key: 'provision-event-stream', status: 'IN_PROGRESS' });
    await expect(h.app.implementation.getComponent(p.ctx, p.project.id, 'nope')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    const dec = c.facts.decisions[0]!.key;
    const byDecision = await h.app.implementation.getTasksForDecision(p.ctx, p.project.id, dec);
    expect(byDecision.tasks.length).toBeGreaterThan(0); expect(byDecision.tasks.every((t) => t.decisionKeys.includes(dec))).toBe(true);
    const t = await h.app.implementation.getTask(p.ctx, byDecision.tasks[0]!.id);
    expect(t.components.length).toBeGreaterThan(0); // task -> component navigation data
  });

  it('works before a plan exists: the facts are there and the workspace says there is no plan yet', async () => {
    const p = await architectureReadyProject(h);
    const c = await h.app.implementation.getComponent(p.ctx, p.project.id, 'event-stream');
    expect(c.implementation).toMatchObject({ hasPlan: false, tasks: [], currentTask: null, progress: null });
    expect(c.facts.component.stableKey).toBe('event-stream');
  });
});

describe('Ask Architect', () => {
  async function ask(app: typeof h, p: Impl, input: { scope: 'PROJECT' | 'COMPONENT' | 'TASK'; scopeId?: string; stepId?: string; message: string; clientMessageId?: string }, signal?: AbortSignal) {
    const events = [];
    for await (const e of app.app.assistant.ask(p.ctx, { projectId: p.project.id, clientMessageId: input.clientMessageId ?? `cm-${Math.random().toString(36).slice(2, 12)}`, ...input }, signal)) events.push(e);
    return events;
  }

  it('streams a grounded answer for a task, stores both messages, and never changes the architecture', async () => {
    const p = await implementationReadyProject(h);
    const id = taskId(p.plan, 'provision-event-stream');
    const archBefore = JSON.stringify((await h.app.architecture.getOverview(p.ctx, p.project.id)).current);
    const events = await ask(h, p, { scope: 'TASK', scopeId: id, message: 'Why do I need this?' });
    expect(events[0]).toMatchObject({ type: 'start' });
    const deltas = events.filter((e) => e.type === 'delta'); expect(deltas.length).toBeGreaterThan(1); // really streamed
    const done = events.at(-1)! as { type: 'done'; message: { structured: { answer: string; notices: string[]; commands: unknown[] }; contextRefs: Array<{ type: string; id: string }> } };
    expect(done.type).toBe('done');
    expect(deltas.map((d) => (d as { text: string }).text).join('').trim()).toBe(done.message.structured.answer); // the stored answer is the streamed text, trimmed
    expect(done.message.structured.answer).toMatch(/Event stream \(Managed event streaming on /);
    expect(done.message.structured.answer).toMatch(/ADR-\d{3}/);
    expect(done.message.contextRefs).toEqual(expect.arrayContaining([{ type: 'task', id }, { type: 'component', id: 'event-stream' }]));
    const convo = await h.repos.conversations.find({ projectId: p.project.id, scope: 'TASK', scopeId: id, userId: p.user.id });
    expect(convo).toMatchObject({ scope: 'TASK', scopeId: id });
    expect((await h.repos.conversations.list(convo!.id, 10)).map((m) => `${m.role}:${m.status}`)).toEqual(['USER:COMPLETE', 'ASSISTANT:COMPLETE']);
    expect(JSON.stringify((await h.app.architecture.getOverview(p.ctx, p.project.id)).current)).toBe(archBefore);
    const usage = await h.prisma.usageEvent.findMany({ where: { projectId: p.project.id, capability: 'TASK_ASSISTANT' } });
    expect(usage).toHaveLength(1); expect(usage[0]).toMatchObject({ success: true, promptId: 'TASK_ASSISTANT', promptVersion: 1 });
    expect(JSON.stringify((await h.prisma.analyticsEvent.findMany({ where: { projectId: p.project.id, name: 'assistant_answered' } })).map((e) => e.properties))).not.toMatch(/Why do I need this/);
  });

  it('classifies commands itself (the model does not decide safety) and warns about destructive ones', async () => {
    const p = await implementationReadyProject(h);
    const events = await ask(h, p, { scope: 'COMPONENT', scopeId: 'primary-database', message: 'I get an access denied error and want to delete and reset the bucket' });
    const msg = (events.at(-1) as { message: { structured: { commands: Array<{ command: string; risk: string }>; notices: string[]; relatedTasks: unknown[] } } }).message.structured;
    expect(Object.fromEntries(msg.commands.map((c) => [c.command, c.risk]))).toEqual({ 'aws sts get-caller-identity': 'READ_ONLY', 'aws s3 rb s3://example-bucket --force': 'DESTRUCTIVE' });
    expect(msg.notices.join(' ')).toMatch(/DESTRUCTIVE.*never runs commands/);
  });

  it('flags needsArchitectureChange, explains it, and changes nothing', async () => {
    const p = await implementationReadyProject(h);
    const before = await h.prisma.architectureDecision.findMany({ where: { version: { architecture: { projectId: p.project.id } } }, orderBy: { key: 'asc' } });
    const e = await ask(h, p, { scope: 'COMPONENT', scopeId: 'event-stream', message: 'Could we use something else instead?' });
    const m = (e.at(-1) as { message: { structured: { needsArchitectureChange: boolean; architectureImpact: string; notices: string[] } } }).message.structured;
    expect(m.needsArchitectureChange).toBe(true); expect(m.architectureImpact).toMatch(/Replacing/);
    expect(m.notices.join(' ')).toMatch(/not available in Pitch2Plan yet, so nothing was changed/);
    expect(await h.prisma.architectureDecision.findMany({ where: { version: { architecture: { projectId: p.project.id } } }, orderBy: { key: 'asc' } })).toEqual(before);
  });

  it('only links related tasks that really exist in the project', async () => {
    const p = await implementationReadyProject(h);
    const bogus: AssistantAiPort = { async *stream() { yield { type: 'delta', text: 'Answer text.\n<<<STRUCTURED>>>\n' }; yield { type: 'delta', text: JSON.stringify({ relatedTaskIds: [taskId(p.plan, 'test-end-to-end'), '00000000-0000-4000-8000-0000000000aa'], commands: [{ command: 'ls -la', purpose: 'List files' }] }) }; yield { type: 'done', ai: { promptId: 'TASK_ASSISTANT', promptVersion: 1, provider: 'x', model: 'x', repaired: false } }; } };
    const a = makeApp({}, {}, {}, undefined, {}, { assistantAi: bogus });
    try {
      const events = await ask(a, p, { scope: 'PROJECT', message: 'What next?' });
      const m = (events.at(-1) as { message: { structured: { relatedTasks: Array<{ id: string; title: string }>; commands: Array<{ risk: string }> } } }).message.structured;
      expect(m.relatedTasks).toEqual([{ id: taskId(p.plan, 'test-end-to-end'), title: expect.stringMatching(/end to end/) }]);
      expect(m.commands[0]!.risk).toBe('READ_ONLY');
    } finally { await a.prisma.$disconnect(); }
  });

  it('keeps going when the model returns text without readable extras, and says so', async () => {
    const p = await implementationReadyProject(h);
    const a = makeApp({ script: ['Just a plain answer with no structured part.'] });
    try {
      const m = (await ask(a, p, { scope: 'PROJECT', message: 'Hello?' })).at(-1) as { type: string; message: { structured: { answer: string; notices: string[] } } };
      expect(m.type).toBe('done'); expect(m.message.structured.answer).toBe('Just a plain answer with no structured part.'); expect(m.message.structured.notices.join()).toMatch(/could not be read/);
    } finally { await a.prisma.$disconnect(); }
  });

  describe('failure handling', () => {
    it('stores the question but NEVER a partial or failed answer, shows a safe error, and a retry reuses the stored question', async () => {
      const p = await implementationReadyProject(h);
      const flaky: AssistantAiPort = { async *stream() { yield { type: 'delta', text: 'Partial answer that must not be saved ' }; throw new AIError('AI_PROVIDER_ERROR', 'upstream 503 api_key=sk-ant-SECRET', true); } };
      const a = makeApp({}, {}, {}, undefined, {}, { assistantAi: flaky });
      try {
        const events = await ask(a, p, { scope: 'PROJECT', message: 'Explain the plan', clientMessageId: 'retry-key-0001' });
        expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'error']);
        const err = events.at(-1) as { code: string; message: string };
        expect(err).toMatchObject({ code: 'AI_PROVIDER_ERROR' }); expect(err.message).not.toMatch(/503|SECRET|sk-ant/);
        const convo = (await h.repos.conversations.find({ projectId: p.project.id, scope: 'PROJECT', scopeId: p.project.id, userId: p.user.id }))!;
        expect((await h.repos.conversations.list(convo.id, 10)).map((m) => `${m.role}:${m.content}`)).toEqual(['USER:Explain the plan']); // no assistant message at all
        const retry = await ask(h, p, { scope: 'PROJECT', message: 'Explain the plan', clientMessageId: 'retry-key-0001' });
        expect(retry.at(-1)).toMatchObject({ type: 'done' });
        expect((await h.repos.conversations.list(convo.id, 10)).map((m) => m.role)).toEqual(['USER', 'ASSISTANT']); // the question was not duplicated
      } finally { await a.prisma.$disconnect(); }
    });

    it('maps timeouts and empty answers to safe messages, and records failed usage', async () => {
      const p = await implementationReadyProject(h);
      const t = makeApp({ script: [new AIError('AI_TIMEOUT', 'x', false)] });
      try { const e = (await ask(t, p, { scope: 'PROJECT', message: 'Anything?' })).at(-1) as { code: string; message: string }; expect(e).toMatchObject({ code: 'AI_TIMEOUT' }); expect(e.message).toMatch(/took too long/); } finally { await t.prisma.$disconnect(); }
      const empty = makeApp({ script: ['   '] });
      try { expect((await ask(empty, p, { scope: 'PROJECT', message: 'Say nothing' })).at(-1)).toMatchObject({ type: 'error', code: 'EMPTY_ANSWER' }); } finally { await empty.prisma.$disconnect(); }
      expect(await h.prisma.usageEvent.count({ where: { projectId: p.project.id, capability: 'TASK_ASSISTANT', success: false } })).toBeGreaterThanOrEqual(1);
    });

    it('stores nothing when the client disconnects mid-stream', async () => {
      const p = await implementationReadyProject(h);
      const ac = new AbortController();
      const slow: AssistantAiPort = { async *stream() { yield { type: 'delta', text: 'Starting ' }; ac.abort(); yield { type: 'delta', text: 'more text' }; yield { type: 'done', ai: { promptId: 'TASK_ASSISTANT', promptVersion: 1, provider: 'x', model: 'x', repaired: false } }; } };
      const a = makeApp({}, {}, {}, undefined, {}, { assistantAi: slow });
      try {
        const events = await ask(a, p, { scope: 'PROJECT', message: 'Hold on' }, ac.signal);
        expect(events.map((e) => e.type)).not.toContain('done');
        const convo = (await h.repos.conversations.find({ projectId: p.project.id, scope: 'PROJECT', scopeId: p.project.id, userId: p.user.id }))!;
        expect((await h.repos.conversations.list(convo.id, 10)).map((m) => m.role)).toEqual(['USER']);
      } finally { await a.prisma.$disconnect(); }
    });
  });

  describe('scope authorization', () => {
    it('refuses scopes outside the project and users outside the workspace, before anything is stored', async () => {
      const mine = await implementationReadyProject(h); const other = await implementationReadyProject(h); const intruder = await signUp(h.app, 'intruder');
      const first = async (input: Parameters<typeof ask>[2], who = mine) => { try { await ask(h, who, input); return 'ALLOWED'; } catch (e) { return (e as { code: string }).code; } };
      expect(await first({ scope: 'TASK', scopeId: taskId(other.plan, 'prepare-environment'), message: 'Peek' })).toBe('TASK_NOT_FOUND'); // a task from ANOTHER project
      expect(await first({ scope: 'COMPONENT', scopeId: 'no-such-component', message: 'Peek' })).toBe('NODE_NOT_FOUND');
      expect(await first({ scope: 'TASK', message: 'No id' })).toBe('VALIDATION_ERROR');
      const t1 = await h.app.implementation.getTask(mine.ctx, taskId(mine.plan, 'prepare-environment')); const t2 = await h.app.implementation.getTask(mine.ctx, taskId(mine.plan, 'provision-primary-database'));
      expect(await first({ scope: 'TASK', scopeId: t1.task.id, stepId: t2.task.steps[0]!.id, message: 'Wrong step' })).toBe('TASK_NOT_FOUND'); // a step of another task
      expect(await first({ scope: 'PROJECT', message: 'Hi' }, { ...mine, ctx: intruder.ctx } as Impl)).toBe('PROJECT_NOT_FOUND');
      const viewer = await signUp(h.app, 'viewer'); await h.prisma.workspaceMember.create({ data: { workspaceId: mine.workspace.id, userId: viewer.user.id, role: 'VIEWER' } });
      expect(await first({ scope: 'PROJECT', message: 'Hi' }, { ...mine, ctx: viewer.ctx } as Impl)).toBe('FORBIDDEN');
      expect(await h.prisma.conversation.count({ where: { projectId: mine.project.id, createdById: { in: [intruder.user.id, viewer.user.id] } } })).toBe(0);
    });

    it('keeps conversations private to their owner and addressable by scope', async () => {
      const p = await implementationReadyProject(h); const mate = await signUp(h.app, 'mate'); const stranger = await signUp(h.app, 'stranger');
      await h.prisma.workspaceMember.create({ data: { workspaceId: p.workspace.id, userId: mate.user.id, role: 'EDITOR' } });
      await ask(h, p, { scope: 'COMPONENT', scopeId: 'event-stream', message: 'First question' });
      await ask(h, p, { scope: 'COMPONENT', scopeId: 'event-stream', message: 'Second question' });
      const mine = await h.app.assistant.getConversation(p.ctx, { projectId: p.project.id, scope: 'COMPONENT', scopeId: 'event-stream' });
      expect(mine.messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
      expect((await h.app.assistant.getConversation(mate.ctx, { projectId: p.project.id, scope: 'COMPONENT', scopeId: 'event-stream' })).conversation).toBeNull();
      expect((await h.app.assistant.getConversation(p.ctx, { projectId: p.project.id, scope: 'PROJECT' })).conversation).toBeNull(); // a different scope is a different conversation
      expect((await h.app.assistant.listMessages(p.ctx, mine.conversation!.id)).messages).toHaveLength(4);
      await expect(h.app.assistant.listMessages(mate.ctx, mine.conversation!.id)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
      await expect(h.app.assistant.listMessages(stranger.ctx, mine.conversation!.id)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    });
  });

  it('uses earlier messages as context but only a short tail', async () => {
    const p = await implementationReadyProject(h);
    for (let i = 0; i < 8; i++) await ask(h, p, { scope: 'PROJECT', message: `Question number ${i}` });
    const seen: string[] = [];
    const spy: AssistantAiPort = { async *stream(input) { seen.push(JSON.stringify(input.projectContext)); seen.push(String(input.history.length)); yield { type: 'delta', text: 'ok\n<<<STRUCTURED>>>\n{}' }; yield { type: 'done', ai: { promptId: 'TASK_ASSISTANT', promptVersion: 1, provider: 'x', model: 'x', repaired: false } }; } };
    const a = makeApp({}, {}, {}, undefined, {}, { assistantAi: spy });
    try { await ask(a, p, { scope: 'PROJECT', message: 'Latest question' }); } finally { await a.prisma.$disconnect(); }
    expect(Number(seen[1])).toBeLessThanOrEqual(6);
    expect(seen[0]).toContain('Question number 7'); expect(seen[0]).not.toContain('Question number 0'); void PITCH;
  });
});
