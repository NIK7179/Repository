import { afterAll, describe, expect, it } from 'vitest';
import { AIError, mockPlan } from '@pitch2plan/ai';
import { applyRepairPatch, type ArchitecturePlan } from '@pitch2plan/schemas';
import { SIMPLE_PITCH, confirmedProject, contextFor, makeApp, signUp } from '../helpers';

const h = makeApp();
afterAll(() => h.prisma.$disconnect());
const statusOf = async (p: { ctx: Parameters<typeof h.app.projects.get>[0]; project: { id: string } }) => (await h.app.projects.get(p.ctx, p.project.id)).project.status;
const jsonOf = (...xs: unknown[]) => xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('generating an architecture end to end', () => {
  it('confirmed requirements -> queued job -> worker -> persisted graph -> ARCHITECTURE_READY -> readable through the API', async () => {
    const p = await confirmedProject(h);
    expect((await h.app.architecture.getOverview(p.ctx, p.project.id)).state).toBe('NOT_STARTED');

    const g = await h.app.architecture.generate(p.ctx, p.project.id);
    expect(g).toMatchObject({ status: 'QUEUED' });
    expect(g.jobId).toBeTruthy();
    expect(await statusOf(p)).toBe('ARCHITECTURE_GENERATING');
    expect(h.queue.jobs).toMatchObject([{ name: 'architecture.generate', runId: g.generationRunId, singletonKey: g.generationRunId }]);
    const queued = await h.app.architecture.getOverview(p.ctx, p.project.id);
    expect(queued.state).toBe('GENERATING');
    expect(queued.run).toMatchObject({ status: 'QUEUED', jobId: g.jobId });
    expect(await h.app.architecture.getJob(p.ctx, g.jobId)).toMatchObject({ id: g.generationRunId, status: 'QUEUED' });

    const [result] = await h.runJobs();
    expect(result).toMatchObject({ outcome: 'SUCCEEDED', created: true });
    expect(await statusOf(p)).toBe('ARCHITECTURE_READY');

    const o = await h.app.architecture.getOverview(p.ctx, p.project.id);
    expect(o.state).toBe('READY');
    const v = o.current!;
    expect(v.version).toMatchObject({ versionNumber: 1, status: 'READY', generationRunId: g.generationRunId });
    expect(v.version.finalizedAt).toBeInstanceOf(Date);
    const keys = v.version.nodes.map((n) => n.stableKey);
    expect(keys).toEqual(expect.arrayContaining(['event-producers', 'event-stream', 'stream-processor', 'object-storage', 'primary-database']));
    for (const e of v.version.edges) { expect(keys).toContain(e.sourceStableKey); expect(keys).toContain(e.targetStableKey); }
    for (const d of v.decisions.filter((x) => x.status === 'ACCEPTED')) expect(d.driverCodes.length + d.requirementCodes.length, d.key).toBeGreaterThan(0);
    expect(v.stats).toMatchObject({ components: keys.length, connections: v.version.edges.length, decisions: v.decisions.length });
    expect(v.drivers.every((d) => /^DRV-\d{3}$/.test(d.code))).toBe(true);
    expect(await h.app.architecture.getJob(p.ctx, g.jobId)).toMatchObject({ status: 'SUCCEEDED', currentStage: 'DONE', versionId: v.version.id });

    // The same data comes back through the version-scoped reads.
    expect((await h.app.architecture.getVersion(p.ctx, v.version.id)).version.nodes).toHaveLength(keys.length);
    expect((await h.app.architecture.getDecisions(p.ctx, v.version.id)).decisions).toHaveLength(v.decisions.length);
    expect((await h.app.architecture.listVersions(p.ctx, p.project.id)).map((x) => x.versionNumber)).toEqual([1]);

    const events = (await h.prisma.analyticsEvent.findMany({ where: { projectId: p.project.id } })).map((e) => e.name);
    expect(events).toEqual(expect.arrayContaining(['architecture_generation_started', 'architecture_generated']));
    expect((await h.prisma.auditLog.findMany({ where: { projectId: p.project.id, action: { startsWith: 'architecture.' } } })).map((a) => a.action).sort()).toEqual(['architecture.generated', 'architecture.generation_started']);
    const usage = await h.prisma.usageEvent.findMany({ where: { projectId: p.project.id, capability: { in: ['ARCHITECTURE_PLANNER', 'ARCHITECTURE_CRITIC', 'ARCHITECTURE_REPAIRER'] } } });
    expect(usage.map((u) => `${u.capability}:${u.promptVersion}`).sort()).toEqual(['ARCHITECTURE_CRITIC:1', 'ARCHITECTURE_PLANNER:1']);
    expect(v.version.ai).toMatchObject({ planner: { promptId: 'ARCHITECTURE_PLANNER', promptVersion: 1 }, repairs: 0 });
  });

  it('designs a SIMPLE system for a simple idea: no event streaming, no stream processing', async () => {
    const p = await confirmedProject(h, { pitch: SIMPLE_PITCH });
    await h.app.architecture.generate(p.ctx, p.project.id); await h.runJobs();
    const v = (await h.app.architecture.getOverview(p.ctx, p.project.id)).current!;
    expect(v.version.nodes.map((n) => n.category)).not.toEqual(expect.arrayContaining(['EVENT_STREAM']));
    expect(v.version.nodes.some((n) => ['EVENT_STREAM', 'STREAM_PROCESSOR', 'BATCH_PROCESSOR'].includes(n.category))).toBe(false);
    expect(v.version.nodes.length).toBeLessThanOrEqual(4);
  });
});

describe('traceability: requirement -> driver -> decision -> component', () => {
  it('answers "why is this here?" from persisted links, and traces a requirement forward to the components it shaped', async () => {
    const p = await confirmedProject(h);
    await h.app.architecture.generate(p.ctx, p.project.id); await h.runJobs();
    const v = (await h.app.architecture.getOverview(p.ctx, p.project.id)).current!;
    const llmCallsBefore = h.provider.calls.length;

    const node = await h.app.architecture.getNode(p.ctx, v.version.id, 'event-stream');
    expect(h.provider.calls.length).toBe(llmCallsBefore); // no model call to explain a component
    expect(node.decisions.length).toBeGreaterThan(0);
    expect(node.why.drivers.length).toBeGreaterThan(0);
    expect(node.why.requirements.length).toBeGreaterThan(0);
    expect(node.why.summary).toMatch(/^Managed event streaming is here because of \d+ architecture decision/);
    expect(node.inputs.map((i) => i.node.stableKey)).toEqual(['event-producers']);
    expect(node.outputs.map((o) => o.node.stableKey)).toEqual(['stream-processor']);
    expect(node.inputs[0]).toMatchObject({ communicationType: 'EVENT', protocol: 'TLS' });
    expect(node.history).toMatchObject([{ versionNumber: 1, replacedByStableKey: null }]);
    expect(node.why.drivers.every((d) => /^DRV-\d{3}$/.test(d.code))).toBe(true);
    expect(node.why.requirements.every((r) => /^REQ-\d{3}$/.test(r.code))).toBe(true);

    // The chain is real in the database, not reconstructed.
    const links = await h.prisma.decisionDriverLink.count({ where: { decision: { versionId: v.version.id } } });
    expect(links).toBeGreaterThan(0);

    const req = node.why.requirements[0]!;
    const trace = await h.app.architecture.getRequirementTrace(p.ctx, v.version.id, req.id);
    expect(trace.requirement.code).toBe(req.code);
    expect(trace.decisions.length).toBeGreaterThan(0);
    expect(trace.nodes.map((n) => n.stableKey)).toContain('event-stream');
    await expect(h.app.architecture.getNode(p.ctx, v.version.id, 'no-such-component')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });
});

describe('preconditions, state transitions and authorization', () => {
  it('refuses to generate unless requirements are confirmed, and never twice', async () => {
    const early = await projectBeforeConfirmation();
    await expect(h.app.architecture.generate(early.ctx, early.project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await statusOf(early)).toBe('DISCOVERY');

    const p = await confirmedProject(h);
    await h.app.architecture.generate(p.ctx, p.project.id);
    await expect(h.app.architecture.generate(p.ctx, p.project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' }); // already generating
    await h.runJobs();
    await expect(h.app.architecture.generate(p.ctx, p.project.id)).rejects.toMatchObject({ code: 'INVALID_STATE' }); // already ready
    expect(await h.prisma.architectureGenerationRun.count({ where: { projectId: p.project.id } })).toBe(1);
  });

  async function projectBeforeConfirmation() {
    const { projectReadyForDiscovery } = await import('../helpers');
    const q = await projectReadyForDiscovery(h);
    await h.app.discovery.start(q.ctx, q.project.id);
    return q;
  }

  it("hides another workspace's architecture everywhere, and lets viewers read but not generate", async () => {
    const p = await confirmedProject(h);
    const intruder = await signUp(h.app, 'intruder');
    const viewer = await signUp(h.app, 'viewer');
    await h.prisma.workspaceMember.create({ data: { workspaceId: p.workspace.id, userId: viewer.user.id, role: 'VIEWER' } });
    const g = await h.app.architecture.generate(p.ctx, p.project.id);
    await h.runJobs();
    const v = (await h.app.architecture.getOverview(p.ctx, p.project.id)).current!;

    for (const r of await Promise.allSettled([
      h.app.architecture.getVersion(intruder.ctx, v.version.id), h.app.architecture.getNode(intruder.ctx, v.version.id, 'event-stream'),
      h.app.architecture.getDecisions(intruder.ctx, v.version.id), h.app.architecture.getRequirementTrace(intruder.ctx, v.version.id, v.requirements[0]!.id),
    ])) expect(r).toMatchObject({ status: 'rejected', reason: { code: 'ARCHITECTURE_NOT_FOUND' } });
    await expect(h.app.architecture.getJob(intruder.ctx, g.jobId)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    await expect(h.app.architecture.getOverview(intruder.ctx, p.project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(h.app.architecture.generate(intruder.ctx, p.project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(h.app.architecture.getVersion(p.ctx, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'ARCHITECTURE_NOT_FOUND' });

    expect((await h.app.architecture.getVersion(viewer.ctx, v.version.id)).version.nodes.length).toBeGreaterThan(0);
    expect((await h.app.architecture.getNode(viewer.ctx, v.version.id, 'event-stream')).node.stableKey).toBe('event-stream');
    await expect(h.app.architecture.generate(viewer.ctx, p.project.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets exactly one of two simultaneous generate requests win', async () => {
    const p = await confirmedProject(h);
    const before = h.queue.jobs.length;
    const results = await Promise.allSettled([h.app.architecture.generate(p.ctx, p.project.id), h.app.architecture.generate(p.ctx, p.project.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'INVALID_STATE' } });
    expect(await h.prisma.architectureGenerationRun.count({ where: { projectId: p.project.id } })).toBe(1);
    expect(h.queue.jobs.length - before).toBe(1);
    await h.runJobs();
  });
});

describe('idempotency: retries, duplicates and crashes never create a second version', () => {
  it('ignores a second delivery of a finished job', async () => {
    const p = await confirmedProject(h);
    const g = await h.app.architecture.generate(p.ctx, p.project.id);
    expect(await h.runJobs()).toMatchObject([{ outcome: 'SUCCEEDED' }]);
    expect(await h.app.architecture.runGeneration(g.generationRunId)).toMatchObject({ outcome: 'ALREADY_DONE' });
    expect(await h.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(1);
    expect(await h.app.architecture.runGeneration('00000000-0000-4000-8000-000000000000')).toEqual({ outcome: 'MISSING' });
  });

  it('lets only one of several simultaneous workers run the pipeline', async () => {
    const p = await confirmedProject(h);
    const g = await h.app.architecture.generate(p.ctx, p.project.id);
    h.queue.jobs.length = 0;
    const out = await Promise.all([1, 2, 3, 4].map(() => h.app.architecture.runGeneration(g.generationRunId)));
    expect(out.filter((o) => o.outcome === 'SUCCEEDED')).toHaveLength(1);
    expect(out.filter((o) => o.outcome !== 'SUCCEEDED').every((o) => o.outcome === 'NOT_CLAIMED' || o.outcome === 'ALREADY_DONE')).toBe(true);
    expect(await h.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(1);
    expect((await h.repos.architecture.getRun(g.generationRunId))!.attempt).toBe(1);
    expect(await h.prisma.architectureNode.count({ where: { version: { architecture: { projectId: p.project.id } } } })).toBe((await h.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.nodes.length);
  });

  it('finalizing the same run twice returns the same version instead of creating another', async () => {
    const p = await confirmedProject(h);
    const g = await h.app.architecture.generate(p.ctx, p.project.id);
    h.queue.jobs.length = 0;
    const c = await contextFor(h, p.project.id);
    await h.repos.architecture.claimRun(g.generationRunId, new Date(0));
    const input = { runId: g.generationRunId, projectId: p.project.id, briefVersionId: c.briefVersionId, plan: planFor(c), driverIdByCode: c.codebook.driverIdByCode, requirementIdByCode: c.codebook.requirementIdByCode, issues: [], ai: {} };
    const first = await h.repos.architecture.finalize(input);
    const second = await h.repos.architecture.finalize(input);
    expect(first.created).toBe(true); expect(second).toEqual({ ...first, created: false });
    expect(await h.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(1);
  });

  it('recovers a run whose worker died mid-way: a later worker reclaims it and still produces exactly one version', async () => {
    const quick = makeApp({}, {}, { staleRunMs: 400 });
    try {
      const p = await confirmedProject(quick);
      const g = await quick.app.architecture.generate(p.ctx, p.project.id);
      quick.queue.jobs.length = 0;
      expect(await quick.repos.architecture.claimRun(g.generationRunId, new Date(0))).toMatchObject({ status: 'RUNNING', attempt: 1 }); // worker A starts... and vanishes
      expect(await quick.repos.architecture.claimRun(g.generationRunId, new Date(Date.now() - 400))).toBeNull(); // fresh heartbeat: B may not steal it yet
      await sleep(450);
      expect(await quick.app.architecture.runGeneration(g.generationRunId)).toMatchObject({ outcome: 'SUCCEEDED', created: true }); // worker B
      expect((await quick.repos.architecture.getRun(g.generationRunId))).toMatchObject({ status: 'SUCCEEDED', attempt: 2 });
      expect(await quick.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(1);
    } finally { await quick.prisma.$disconnect(); }
  });
});

describe('failure recovery: projects are never stuck', () => {
  it('returns the project to REQUIREMENTS_CONFIRMED when the model keeps producing garbage; requirements stay confirmed; retry works', async () => {
    const p = await confirmedProject(h);
    const bad = makeApp({ script: ['I think you should use microservices!', 'Definitely microservices.'] });
    try {
      await bad.app.architecture.generate(p.ctx, p.project.id);
      expect(await bad.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'AI_OUTPUT_INVALID' }]);
    } finally { await bad.prisma.$disconnect(); }
    expect(await statusOf(p)).toBe('REQUIREMENTS_CONFIRMED');
    const o = await h.app.architecture.getOverview(p.ctx, p.project.id);
    expect(o.state).toBe('FAILED');
    expect(o.run).toMatchObject({ status: 'FAILED', failureCode: 'AI_OUTPUT_INVALID', currentStage: 'FAILED' });
    expect(o.run!.failureMessage).toMatch(/did not pass our validation/);
    expect(o.run!.failureMessage).not.toMatch(/microservices|JSON|Zod/);
    expect(await h.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(0);
    expect((await h.app.briefs.get(p.ctx, p.project.id)).brief.status).toBe('CONFIRMED'); // discovery work intact

    await h.app.architecture.generate(p.ctx, p.project.id); // Retry
    expect(await h.runJobs()).toMatchObject([{ outcome: 'SUCCEEDED' }]);
    expect(await statusOf(p)).toBe('ARCHITECTURE_READY');
    expect(await h.prisma.architectureGenerationRun.count({ where: { projectId: p.project.id } })).toBe(2);
  });

  it('never exposes provider errors, secrets or stack traces in the failure shown to users', async () => {
    const p = await confirmedProject(h);
    const down = makeApp({ script: [new AIError('AI_PROVIDER_ERROR', 'LEAKMARKER upstream api_key=sk-ant-SECRET at Object.<anonymous> (/srv/app.js:1)', false)] });
    try { await down.app.architecture.generate(p.ctx, p.project.id); await down.runJobs(); } finally { await down.prisma.$disconnect(); }
    const run = (await h.app.architecture.getOverview(p.ctx, p.project.id)).run!;
    expect(run).toMatchObject({ status: 'FAILED', failureCode: 'AI_PROVIDER_ERROR', failureMessage: 'The AI service is temporarily unavailable.' });
    expect(`${run.failureCode} ${run.failureMessage}`).not.toMatch(/LEAKMARKER|SECRET|sk-ant|srv\/app|upstream/);
    const stored = await h.prisma.architectureGenerationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(JSON.stringify([stored.failureCode, stored.failureMessage, stored.ai])).not.toMatch(/LEAKMARKER|SECRET|sk-ant|srv\/app/); // nor in the database
    expect(await statusOf(p)).toBe('REQUIREMENTS_CONFIRMED');
  });

  it('recovers when the queue is unavailable: the project goes back and the user can retry', async () => {
    const p = await confirmedProject(h);
    h.queue.failNext = true;
    await expect(h.app.architecture.generate(p.ctx, p.project.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await statusOf(p)).toBe('REQUIREMENTS_CONFIRMED');
    expect(await h.repos.architecture.getLatestRun(p.project.id)).toMatchObject({ status: 'FAILED', failureCode: 'ENQUEUE_FAILED' });
    await h.app.architecture.generate(p.ctx, p.project.id); await h.runJobs();
    expect(await statusOf(p)).toBe('ARCHITECTURE_READY');
  });

  it('times out a run whose worker never showed up, so ARCHITECTURE_GENERATING is never permanent', async () => {
    const quick = makeApp({}, {}, { staleRunMs: 400 });
    try {
      const p = await confirmedProject(quick);
      const g = await quick.app.architecture.generate(p.ctx, p.project.id);
      quick.queue.jobs.length = 0; // the job was lost
      await sleep(450);
      const o = await quick.app.architecture.getOverview(p.ctx, p.project.id); // reading is enough to recover
      expect(o.state).toBe('FAILED');
      expect(o.run).toMatchObject({ id: g.generationRunId, status: 'FAILED', failureCode: 'GENERATION_TIMED_OUT' });
      expect((await quick.app.projects.get(p.ctx, p.project.id)).project.status).toBe('REQUIREMENTS_CONFIRMED');
      await quick.app.architecture.recoverStale(); // idempotent: sweeping again changes nothing for this project
      expect((await quick.repos.architecture.getRun(g.generationRunId))).toMatchObject({ status: 'FAILED', failureCode: 'GENERATION_TIMED_OUT' });
      expect((await quick.app.projects.get(p.ctx, p.project.id)).project.status).toBe('REQUIREMENTS_CONFIRMED');
      await quick.app.architecture.generate(p.ctx, p.project.id); await quick.runJobs();
      expect((await quick.app.projects.get(p.ctx, p.project.id)).project.status).toBe('ARCHITECTURE_READY');
    } finally { await quick.prisma.$disconnect(); }
  });

  it('does not touch a project that changed state while the job ran', async () => {
    const p = await confirmedProject(h);
    await h.app.architecture.generate(p.ctx, p.project.id);
    await h.prisma.project.update({ where: { id: p.project.id }, data: { status: 'ARCHIVED' } });
    expect(await h.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'PROJECT_STATE_CHANGED' }]);
    expect(await statusOf(p)).toBe('ARCHIVED');
    expect(await h.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(0);
  });

  it('rolls back completely when persistence fails part-way: no version, no nodes, the run still unfinished', async () => {
    const p = await confirmedProject(h);
    const g = await h.app.architecture.generate(p.ctx, p.project.id);
    h.queue.jobs.length = 0;
    const c = await contextFor(h, p.project.id);
    await h.repos.architecture.claimRun(g.generationRunId, new Date(0));
    const plan = planFor(c);
    const broken = { ...plan, nodes: [...plan.nodes, plan.nodes[0]!] }; // duplicate stableKey slips past validation
    await expect(h.repos.architecture.finalize({ runId: g.generationRunId, projectId: p.project.id, briefVersionId: c.briefVersionId, plan: broken, driverIdByCode: c.codebook.driverIdByCode, requirementIdByCode: c.codebook.requirementIdByCode, issues: [], ai: {} })).rejects.toThrow();
    expect(await h.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(0);
    expect(await h.prisma.architectureNode.count({ where: { version: { architecture: { projectId: p.project.id } } } })).toBe(0);
    expect((await h.repos.architecture.getRun(g.generationRunId))!.status).toBe('RUNNING');
    expect(await statusOf(p)).toBe('ARCHITECTURE_GENERATING');
    await h.runJobs();
    // and a project that is no longer generating cannot be finalized into
    await h.prisma.project.update({ where: { id: p.project.id }, data: { status: 'REQUIREMENTS_CONFIRMED' } });
    await expect(h.repos.architecture.finalize({ runId: g.generationRunId, projectId: p.project.id, briefVersionId: c.briefVersionId, plan, driverIdByCode: c.codebook.driverIdByCode, requirementIdByCode: c.codebook.requirementIdByCode, issues: [], ai: {} })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
    expect((await h.repos.architecture.getRun(g.generationRunId))!.status).toBe('RUNNING'); // the claim rolled back with it
  });
});

describe('the repair cycle on real data', () => {
  type Ctx = Awaited<ReturnType<typeof contextFor>>;
  async function scripted(script: unknown[]) {
    const p = await confirmedProject(h);
    const c = await contextFor(h, p.project.id);
    const s = makeApp({ script: jsonOf(...script.map((x) => (typeof x === 'function' ? (x as (c: Ctx) => unknown)(c) : x))) });
    return { p, c, s };
  }
  const clean = { assessment: 'The design satisfies the stated requirements.', issues: [] };
  const critical = (over: object = {}) => ({ assessment: 'There is one serious gap in the design.', issues: [{ severity: 'CRITICAL', category: 'RELIABILITY', description: 'The primary database has no redundancy for a critical requirement.', affectedNodeStableKeys: ['primary-database'], affectedDecisionIds: [], relatedRequirementIds: ['REQ-001'], recommendation: 'Add a replica with failover.', ...over }] });
  const dbPatch = (index = 0) => ({ changes: [{ issueIndex: index, description: 'Added a replica with automatic failover' }], nodes: { update: [{ stableKey: 'primary-database', set: { configuration: [{ key: 'replicas', value: '2 with failover' }] } }] } });

  it('repairs an orphaned component before the critic ever sees it, and records the history', async () => {
    const { p, c, s } = await scripted([(c: Ctx) => withOrphan(planFor(c)), { changes: [{ issueIndex: 0, description: 'Removed the unconnected cache' }], nodes: { remove: ['lonely-cache'] } }, clean]);
    try {
      await s.app.architecture.generate(p.ctx, p.project.id);
      expect(await s.runJobs()).toMatchObject([{ outcome: 'SUCCEEDED' }]);
      const v = (await s.app.architecture.getOverview(p.ctx, p.project.id)).current!;
      expect(v.version.nodes.map((n) => n.stableKey)).not.toContain('lonely-cache');
      expect(v.version.ai).toMatchObject({ repairs: 1, repairers: [{ promptId: 'ARCHITECTURE_REPAIRER' }] });
      expect(v.version.issues.map((i) => `${i.stage}:${i.code}`)).toEqual(['PLAN:ORPHAN_NODE']);
      expect((await s.repos.architecture.getLatestRun(p.project.id))!.repairCount).toBe(1);
      expect(s.provider.calls.map((x) => /PROMPT_ID: (\w+)_V1/.exec(x.system)![1])).toEqual(['ARCHITECTURE_PLANNER', 'ARCHITECTURE_REPAIRER', 'ARCHITECTURE_CRITIC']);
      expect(c.driverCodes.length).toBeGreaterThan(0);
    } finally { await s.prisma.$disconnect(); }
  });

  it('sends a CRITICAL critic finding to the repairer and re-reviews the repaired design', async () => {
    const { p, s } = await scripted([(c: Ctx) => planFor(c), critical(), dbPatch(), clean]);
    try {
      await s.app.architecture.generate(p.ctx, p.project.id);
      expect(await s.runJobs()).toMatchObject([{ outcome: 'SUCCEEDED' }]);
      const v = (await s.app.architecture.getOverview(p.ctx, p.project.id)).current!;
      expect(v.version.nodes.find((n) => n.stableKey === 'primary-database')!.configuration).toEqual([{ key: 'replicas', value: '2 with failover' }]);
      expect(v.version.issues.map((i) => `${i.stage}:${i.source}:${i.severity}`)).toEqual(['PLAN:CRITIC:CRITICAL']);
      expect(s.provider.calls.map((x) => /PROMPT_ID: (\w+)_V1/.exec(x.system)![1])).toEqual(['ARCHITECTURE_PLANNER', 'ARCHITECTURE_CRITIC', 'ARCHITECTURE_REPAIRER', 'ARCHITECTURE_CRITIC']);
    } finally { await s.prisma.$disconnect(); }
  });

  it('gives up after the configured number of repairs: the run FAILS, the findings are kept, and nothing half-finished is saved', async () => {
    const { p, s } = await scripted([(c: Ctx) => planFor(c), critical(), dbPatch(), critical(), dbPatch(), critical()]);
    try {
      await s.app.architecture.generate(p.ctx, p.project.id);
      expect(await s.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'ARCHITECTURE_VALIDATION_FAILED' }]);
      expect(s.provider.calls).toHaveLength(6); // plan + 2x(critic, repair) + final critic: a hard cap, not a loop
      expect(await statusOf(p)).toBe('REQUIREMENTS_CONFIRMED');
      const run = (await s.repos.architecture.getLatestRun(p.project.id))!;
      expect(run).toMatchObject({ status: 'FAILED', repairCount: 2 });
      const kept = await s.prisma.architectureGenerationIssue.findMany({ where: { runId: run.id } });
      expect(kept.some((i) => i.stage === 'FINAL' && i.severity === 'CRITICAL')).toBe(true);
      expect(await s.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(0);
    } finally { await s.prisma.$disconnect(); }
  });

  it('fails cleanly when the repairer itself keeps returning unusable patches', async () => {
    const { p, s } = await scripted([(c: Ctx) => planFor(c), critical(), { changes: [{ issueIndex: 0, description: 'x y z w' }], nodes: { remove: ['no-such-node'] } }, { changes: [{ issueIndex: 0, description: 'x y z w' }], nodes: { remove: ['no-such-node'] } }]);
    try {
      await s.app.architecture.generate(p.ctx, p.project.id);
      expect(await s.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'AI_OUTPUT_INVALID' }]);
      expect(await statusOf(p)).toBe('REQUIREMENTS_CONFIRMED');
    } finally { await s.prisma.$disconnect(); }
  });
});

describe('versioning, stable keys and immutability', () => {
  async function twoVersions() {
    const p = await confirmedProject(h);
    await h.app.architecture.generate(p.ctx, p.project.id); await h.runJobs();
    const v1 = (await h.app.architecture.getOverview(p.ctx, p.project.id)).current!;
    const c = await contextFor(h, p.project.id);
    // A future change (Phase 5) will create version 2 by replacing a technology; simulate it at the repository level.
    await h.prisma.project.update({ where: { id: p.project.id }, data: { status: 'ARCHITECTURE_GENERATING' } });
    const run2 = await h.prisma.architectureGenerationRun.create({ data: { projectId: p.project.id, briefVersionId: c.briefVersionId, requestedById: p.user.id, status: 'RUNNING' } });
    const plan2: ArchitecturePlan = JSON.parse(JSON.stringify(planFor(c)).replaceAll('stream-processor', 'stream-processing-v2'));
    plan2.nodes.find((n) => n.stableKey === 'stream-processing-v2')!.replacesStableKey = 'stream-processor';
    plan2.nodes.find((n) => n.stableKey === 'event-stream')!.technology = 'A different managed stream';
    const saved = await h.repos.architecture.finalize({ runId: run2.id, projectId: p.project.id, briefVersionId: c.briefVersionId, plan: plan2, driverIdByCode: c.codebook.driverIdByCode, requirementIdByCode: c.codebook.requirementIdByCode, issues: [], ai: {} });
    return { p, v1, saved };
  }

  it('numbers versions, supersedes the previous one, and keeps conceptual identity through stable keys and replacement lineage', async () => {
    const { p, v1, saved } = await twoVersions();
    expect(saved).toMatchObject({ versionNumber: 2, created: true });
    expect((await h.app.architecture.listVersions(p.ctx, p.project.id)).map((v) => [v.versionNumber, v.status])).toEqual([[2, 'READY'], [1, 'SUPERSEDED']]);
    const arch = (await h.repos.architecture.getByProject(p.project.id))!;
    expect(arch.currentVersionId).toBe(saved.versionId);
    expect((await h.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.id).toBe(saved.versionId);

    const history = await h.repos.architecture.nodeHistory(arch.id, 'event-stream'); // same stableKey, different rows
    expect(history.map((x) => [x.versionNumber, x.technology])).toEqual([[1, v1.version.nodes.find((n) => n.stableKey === 'event-stream')!.technology], [2, 'A different managed stream']]);
    const rows = await h.prisma.architectureNode.findMany({ where: { stableKey: 'event-stream', version: { architectureId: arch.id } } });
    expect(new Set(rows.map((r) => r.id)).size).toBe(2); // continuity is the stableKey, never the database id
    expect(await h.repos.architecture.nodeHistory(arch.id, 'stream-processor')).toMatchObject([{ versionNumber: 1, replacedByStableKey: 'stream-processing-v2' }]);
    expect(await h.repos.architecture.nodeHistory(arch.id, 'stream-processing-v2')).toMatchObject([{ versionNumber: 2, replacesStableKey: 'stream-processor' }]);
    expect((await h.app.architecture.getVersion(p.ctx, v1.version.id)).version.status).toBe('SUPERSEDED'); // old versions stay readable
  });

  it('cannot be modified once READY or SUPERSEDED, even by raw SQL (database triggers)', async () => {
    const { v1, saved } = await twoVersions();
    const fail = (sql: string) => expect(h.prisma.$executeRawUnsafe(sql), sql).rejects.toThrow(/cannot be modified|and cannot|immutable/i);
    const v2 = saved.versionId;
    for (const v of [v1.version.id, v2]) {
      await fail(`UPDATE "ArchitectureNode" SET "name" = 'tampered' WHERE "versionId" = '${v}'`);
      await fail(`UPDATE "ArchitectureEdge" SET "label" = 'tampered' WHERE "versionId" = '${v}'`);
      await fail(`UPDATE "ArchitectureDecision" SET "rationale" = 'tampered' WHERE "versionId" = '${v}'`);
      await fail(`UPDATE "ArchitectureVersion" SET "summary" = 'tampered' WHERE "id" = '${v}'`);
      await fail(`INSERT INTO "ArchitectureNode" ("id","versionId","stableKey","name","technology","technologySlug","category","purpose","description","criticality","managedService","deploymentModel","configuration","risks","alternatives") VALUES (gen_random_uuid(),'${v}','sneaky','n','t','t','OTHER','p','d','LOW',false,'OTHER','[]','[]','[]')`);
      await fail(`INSERT INTO "NodeDecisionLink" ("decisionId","nodeId") SELECT d."id", n."id" FROM "ArchitectureDecision" d, "ArchitectureNode" n WHERE d."versionId" = '${v}' AND n."versionId" = '${v}' AND NOT EXISTS (SELECT 1 FROM "NodeDecisionLink" l WHERE l."decisionId" = d."id" AND l."nodeId" = n."id") LIMIT 1`);
    }
    await fail(`UPDATE "ArchitectureVersion" SET "status" = 'READY' WHERE "id" = '${v1.version.id}'`); // SUPERSEDED cannot be revived
    await fail(`UPDATE "ArchitectureVersion" SET "status" = 'DRAFT' WHERE "id" = '${v2}'`);
    const after = await h.repos.architecture.getVersion(v2);
    expect(after!.summary).not.toBe('tampered');
  });

  it('allows at most one version per generation run, enforced by the database independently of the application', async () => {
    const p = await confirmedProject(h);
    const c = await contextFor(h, p.project.id);
    const run = await h.prisma.architectureGenerationRun.create({ data: { projectId: p.project.id, briefVersionId: c.briefVersionId, requestedById: p.user.id } });
    const arch = await h.prisma.architecture.create({ data: { projectId: p.project.id } });
    const data = { architectureId: arch.id, generationRunId: run.id, briefVersionId: c.briefVersionId, summary: 's', assumptions: [], unresolvedQuestions: [], risks: [], ai: {} };
    await h.prisma.architectureVersion.create({ data: { ...data, versionNumber: 1 } });
    await expect(h.prisma.architectureVersion.create({ data: { ...data, versionNumber: 2 } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(h.prisma.architectureVersion.create({ data: { ...data, generationRunId: (await h.prisma.architectureGenerationRun.create({ data: { projectId: p.project.id, briefVersionId: c.briefVersionId, requestedById: p.user.id } })).id, versionNumber: 1 } })).rejects.toMatchObject({ code: 'P2002' }); // and version numbers are unique per architecture
  });

  it('enforces unique stable keys, edge keys and decision keys within a version in the database', async () => {
    const { v1 } = await twoVersions();
    const n = v1.version.nodes[0]!;
    await expect(h.prisma.$executeRawUnsafe(`INSERT INTO "ArchitectureNode" SELECT * FROM "ArchitectureNode" WHERE "id" = '${n.id}'`)).rejects.toThrow(); // blocked by the immutability trigger and by uniqueness
    const idx = await h.prisma.$queryRawUnsafe<Array<{ indexname: string }>>(`SELECT indexname::text AS indexname FROM pg_indexes WHERE tablename IN ('ArchitectureNode','ArchitectureEdge','ArchitectureDecision') AND indexdef LIKE 'CREATE UNIQUE%'`);
    expect(idx.map((i) => i.indexname).sort()).toEqual(expect.arrayContaining(['ArchitectureDecision_versionId_key_key', 'ArchitectureEdge_versionId_edgeKey_key', 'ArchitectureNode_versionId_stableKey_key']));
  });
});

// ---------- helpers
function planFor(c: Awaited<ReturnType<typeof contextFor>>): ArchitecturePlan {
  return mockPlan({ requirements: c.input.requirements, drivers: c.input.drivers, brief: c.input.brief as { openQuestions?: Array<{ text: string }> } }) as unknown as ArchitecturePlan;
}
function withOrphan(plan: ArchitecturePlan): ArchitecturePlan {
  return applyRepairPatch(plan, { changes: [{ issueIndex: 0, description: 'test fixture' }], nodes: { add: [{ ...plan.nodes[0]!, stableKey: 'lonely-cache', name: 'Lonely cache', technology: 'Some cache', technologySlug: 'some-cache', category: 'CACHE', criticality: 'LOW', replacesStableKey: null }], update: [], remove: [] }, edges: { add: [], update: [], remove: [] }, decisions: { add: [], update: [], remove: [] }, addRisks: [], addAssumptions: [] });
}
