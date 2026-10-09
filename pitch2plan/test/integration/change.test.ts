import { afterAll, describe, expect, it } from 'vitest';
import { AIError } from '@pitch2plan/ai';
import { architectureReadyProject, implementationReadyProject, makeApp, signUp } from '../helpers';

const h = makeApp();
afterAll(() => h.prisma.$disconnect());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Impl = Awaited<ReturnType<typeof implementationReadyProject>>;
const KINESIS = 'Replace Managed event streaming with Amazon Kinesis';
const taskId = (plan: { tasks: Array<{ id: string; key: string }> }, key: string) => plan.tasks.find((t) => t.key === key)!.id;
const json = (...xs: unknown[]) => xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
const planOf = async (app: typeof h, p: Impl) => (await app.app.implementation.getOverview(p.ctx, p.project.id)).plan!;

async function complete(app: typeof h, p: Impl, key: string) {
  const id = taskId(await planOf(app, p), key);
  await app.app.implementation.updateStatus(p.ctx, id, { status: 'IN_PROGRESS' });
  const t = await app.app.implementation.getTask(p.ctx, id);
  await app.app.implementation.confirmValidation(p.ctx, id, t.task.validations.map((v) => ({ position: v.position, confirmed: true })));
  return app.app.implementation.updateStatus(p.ctx, id, { status: 'COMPLETED' });
}
/** Project with architecture V1, plan V1 and several completed tasks. */
async function started(app = h) {
  const p = await implementationReadyProject(app);
  for (const k of ['prepare-environment', 'configure-secrets-and-identity', 'provision-event-stream', 'provision-primary-database']) await complete(app, p, k);
  return p;
}
const propose = (app: typeof h, p: Impl, text = KINESIS, extra: object = {}) => app.app.change.create(p.ctx, p.project.id, { requestedChange: text, source: 'USER_REQUEST', ...extra });
async function analyzed(app: typeof h, p: Impl, text = KINESIS) {
  const c = await propose(app, p, text); await app.app.change.analyze(p.ctx, c.proposal.id); await app.runJobs();
  return app.app.change.get(p.ctx, c.proposal.id);
}
async function applied(app: typeof h, p: Impl, text = KINESIS, approve: { confirmRequirementChanges?: boolean } = {}) {
  const v = await analyzed(app, p, text); await app.app.change.approve(p.ctx, v.proposal.id, { confirmRequirementChanges: approve.confirmRequirementChanges ?? false }); await app.runJobs();
  return app.app.change.get(p.ctx, v.proposal.id);
}

describe('the full product path: change a started architecture without losing any history', () => {
  it('V1 -> plan V1 -> complete tasks -> request -> analyze -> approve -> V2 -> diff -> plan V2 -> review migration -> revalidate', async () => {
    const p = await started();
    const v1 = (await h.app.architecture.getOverview(p.ctx, p.project.id)).current!;
    const plan1 = await planOf(h, p); const v1Snapshot = JSON.stringify(await h.repos.architecture.getVersion(v1.version.id));
    const progress1 = JSON.stringify((await planOf(h, p)).tasks.map((t) => [t.key, t.status]));

    // --- request: a PROPOSAL, never an immediate change
    const c = await propose(h, p, KINESIS, { reason: 'We are standardising on AWS' });
    expect(c.proposal).toMatchObject({ status: 'DRAFT', source: 'USER_REQUEST', baseVersionId: v1.version.id, requestedChange: KINESIS }); expect(c.baseVersionNumber).toBe(1);
    expect((await h.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.id).toBe(v1.version.id); // nothing changed yet

    // --- analysis (a background job)
    expect((await h.app.change.analyze(p.ctx, c.proposal.id)).proposal.status).toBe('ANALYZING'); expect(h.queue.jobs).toMatchObject([{ name: 'change.analyze' }]);
    expect(await h.runJobs()).toMatchObject([{ outcome: 'READY' }]);
    const a = await h.app.change.get(p.ctx, c.proposal.id);
    expect(a.proposal).toMatchObject({ status: 'READY_FOR_REVIEW', changeType: 'TECHNOLOGY_REPLACEMENT', requiresReconfirmation: false });
    expect(a.proposal.analysis!.whatChanges[0]).toMatch(/Managed event streaming becomes Amazon Kinesis/);
    expect(a.impact.nodes.map((n) => `${n.refKey}:${n.relation}`).sort()).toEqual(['event-producers:POTENTIAL', 'event-stream:DIRECT', 'stream-processor:POTENTIAL']); // direct, plus neighbours from the graph
    expect(a.impact.decisions.length).toBeGreaterThan(0); expect(a.impact.requirements.length).toBeGreaterThan(0); expect(a.impact.drivers.length).toBeGreaterThan(0); expect(a.impact.edges.length).toBe(2);
    expect(a.workAtRisk.tasks.find((t) => t.key === 'provision-event-stream')).toMatchObject({ status: 'COMPLETED', relation: 'DIRECT' }); // completed work at risk, from the plan
    expect(a.workAtRisk.completed).toBeGreaterThanOrEqual(1); expect(['MEDIUM', 'HIGH']).toContain(a.proposal.severity);
    expect(a.proposal.analysis!.costImpact).toMatchObject({ direction: 'UNKNOWN' }); // no fake cost precision
    expect(await h.prisma.changeProposalImpactItem.count({ where: { proposalId: c.proposal.id, kind: 'TASK' } })).toBeGreaterThan(0);

    // --- approval is an explicit, recorded human act
    const ap = await h.app.change.approve(p.ctx, c.proposal.id, { confirmRequirementChanges: false, note: 'Reviewed the completed work at risk' });
    expect(ap.proposal.status).toBe('APPLYING');
    const approval = await h.prisma.changeProposalApproval.findUniqueOrThrow({ where: { proposalId: c.proposal.id } });
    expect(approval).toMatchObject({ decision: 'APPROVED', decidedById: p.user.id, architectureVersionId: v1.version.id }); expect(approval.decidedAt).toBeInstanceOf(Date);
    const run = await h.prisma.architectureGenerationRun.findUniqueOrThrow({ where: { proposalId: c.proposal.id } }); expect(run).toMatchObject({ mode: 'CHANGE', baseVersionId: v1.version.id });
    const out = await h.runJobs(); expect(out.filter((o) => (o as { outcome: string }).outcome === 'SUCCEEDED')).toHaveLength(2); // the architecture version AND the plan chain

    // --- architecture V2: V1 is preserved byte for byte
    const done = await h.app.change.get(p.ctx, c.proposal.id); expect(done.proposal.status).toBe('APPLIED'); expect(done.resultVersion).toMatchObject({ versionNumber: 2 });
    const cur = (await h.app.architecture.getOverview(p.ctx, p.project.id)).current!; expect(cur.version).toMatchObject({ versionNumber: 2, status: 'READY' }); expect(cur.version.id).toBe(done.resultVersion!.id);
    const old = await h.repos.architecture.getVersion(v1.version.id); expect(old).toMatchObject({ status: 'SUPERSEDED', versionNumber: 1 });
    const graph = (v: unknown) => { const x = JSON.parse(JSON.stringify(v)); return JSON.stringify({ nodes: x.nodes, edges: x.edges, summary: x.summary, assumptions: x.assumptions, risks: x.risks, decisions: x.decisions.map(({ supersededByKey: _a, effectiveStatus: _b, ...d }: Record<string, unknown>) => d) }); };
    expect(graph(old)).toBe(graph(JSON.parse(v1Snapshot))); // V1's stored graph is identical to what it was before the change (only its status and derived decision status differ)
    const v2 = (await h.repos.architecture.getVersion(cur.version.id))!;
    expect(v2).toMatchObject({ parentVersionId: v1.version.id, sourceProposalId: c.proposal.id });
    expect(old!.nodes.find((n) => n.stableKey === 'event-stream')).toMatchObject({ technology: 'Managed event streaming' }); // V1 untouched
    expect(v2.nodes.map((n) => n.stableKey).sort()).toEqual(old!.nodes.map((n) => n.stableKey).sort());
    expect(v2.nodes.find((n) => n.stableKey === 'event-stream')).toMatchObject({ technology: 'Amazon Kinesis', technologySlug: 'amazon-kinesis', category: 'EVENT_STREAM', replacesStableKey: null }); // role kept => stableKey kept

    // --- decision supersession: preserved, never deleted
    const newDecision = v2.decisions.find((d) => d.supersedesKey)!; expect(newDecision.title).toMatch(/Amazon Kinesis/);
    const oldDecision = old!.decisions.find((d) => d.key === newDecision.supersedesKey)!; expect(oldDecision).toMatchObject({ status: 'ACCEPTED', effectiveStatus: 'SUPERSEDED', supersededByKey: newDecision.key }); // V1 row untouched; status derived
    expect(old!.decisions.map((d) => d.key)).toContain(oldDecision.key); expect(v2.decisions.map((d) => d.key)).not.toContain(oldDecision.key); expect(Number(newDecision.key.slice(4))).toBeGreaterThan(Math.max(...old!.decisions.map((d) => Number(d.key.slice(4))))); // new key, never reused
    expect(newDecision.driverIds.length).toBeGreaterThan(0); expect([...newDecision.driverIds].sort()).toEqual([...oldDecision.driverIds].sort()); expect([...newDecision.requirementIds].sort()).toEqual([...oldDecision.requirementIds].sort()); // traceability carried over EXACTLY from the decision it supersedes

    // --- the diff (deterministic, stored)
    const d = await h.app.change.getDiff(p.ctx, v1.version.id, v2.id);
    expect(d.stored).toBe(true); expect(d.origin).toMatchObject({ proposalId: c.proposal.id });
    expect(d.diff.nodes.find((n) => n.stableKey === 'event-stream')).toMatchObject({ kind: 'REPLACED', from: { technology: 'Managed event streaming' }, to: { technology: 'Amazon Kinesis' } });
    expect(d.diff.summary.sentences).toEqual(expect.arrayContaining(['1 component replaced', '1 decision superseded']));
    expect(d.diff.nodes.filter((n) => n.kind === 'UNCHANGED')).toHaveLength(v2.nodes.length - 1); expect((await h.app.change.getDiff(p.ctx, v2.id, v1.version.id)).stored).toBe(false); // the reverse is computed

    // --- implementation plan V2 exists but is PENDING; plan V1 is untouched and still the active plan
    const ov = await h.app.implementation.getOverview(p.ctx, p.project.id);
    expect(ov.plan!.version.id).toBe(plan1.version.id); expect(JSON.stringify(ov.plan!.tasks.map((t) => [t.key, t.status]))).toBe(progress1);
    const pending = (await h.repos.implementation.listPlanVersions(p.project.id)).find((x) => x.activation === 'PENDING_REVIEW')!; expect(pending).toMatchObject({ versionNumber: 2, architectureVersionId: v2.id, sourceProposalId: c.proposal.id });
    const plan2 = (await h.repos.implementation.getVersion(pending.id))!;
    await expect(h.app.implementation.updateStatus(p.ctx, plan2.tasks[0]!.id, { status: 'IN_PROGRESS' })).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/waiting for its progress migration/) });

    // --- progress migration: shown BEFORE it is applied
    const pd = await h.app.change.planDiff(p.ctx, plan1.version.id, pending.id);
    expect(pd.source).toBe('PREVIEW'); expect(pd.canAccept).toBe(true);
    const outcome = (key: string) => pd.items.find((i) => (i.v1 && plan1.tasks.find((t) => t.id === i.v1!.id)?.key === key))?.outcome;
    expect(outcome('prepare-environment')).toBe('CARRIED_FORWARD'); expect(outcome('provision-primary-database')).toBe('CARRIED_FORWARD'); // unchanged components
    expect(outcome('provision-event-stream')).toBe('OBSOLETE'); expect(pd.added.some((r) => r.v2!.key === 'provision-event-stream')).toBe(true); // work on the replaced technology does not carry
    expect(outcome('configure-secrets-and-identity')).toBe('REQUIRES_REVALIDATION'); // system-wide security work after an architecture change
    expect(pd.summary).toMatchObject({ completedInV1: 4, carriedForward: 2, requiresRevalidation: 1, obsoleteCompleted: 1 });
    expect(await h.prisma.taskProgressEvent.count({ where: { task: { planVersionId: pending.id } } })).toBe(0); // nothing transferred silently

    // --- accept the reviewed migration
    const accepted = await h.app.change.acceptMigration(p.ctx, pending.id);
    expect(accepted.source).toBe('ACCEPTED'); expect(accepted.summary).toEqual(pd.summary);
    const after = await h.app.implementation.getOverview(p.ctx, p.project.id); expect(after.plan!.version.id).toBe(pending.id);
    const t2 = (key: string) => after.plan!.tasks.find((t) => t.key === key)!;
    expect(t2('prepare-environment').status).toBe('COMPLETED'); expect(t2('provision-primary-database').status).toBe('COMPLETED');
    expect(t2('provision-event-stream').status).toBe('NOT_STARTED'); expect(t2('configure-secrets-and-identity').status).toBe('NOT_STARTED'); // revalidation: NOT claimed complete
    const carried = await h.app.implementation.getTask(p.ctx, t2('prepare-environment').id);
    expect(carried.events.map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(['NOT_STARTED>COMPLETED']); expect(carried.events[0]!.reason).toMatch(/Carried forward from plan v1/);
    expect(carried.task.validations.every((v) => v.confirmed && v.confirmationKind === 'USER_CONFIRMED')).toBe(true);
    // history of plan V1 is unchanged and now read-only
    const plan1After = (await h.repos.implementation.getVersion(plan1.version.id))!; expect(plan1After.activation).toBe('SUPERSEDED');
    expect(JSON.stringify(plan1After.tasks.map((t) => [t.key, t.status]))).toBe(progress1);
    await expect(h.app.implementation.updateStatus(p.ctx, plan1.tasks[0]!.id, { status: 'IN_PROGRESS' })).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/replaced by a newer one/) });
    await expect(h.app.change.acceptMigration(p.ctx, pending.id)).rejects.toMatchObject({ code: 'INVALID_STATE' }); // not twice

    // --- revalidation is a normal, explicit confirmation in V2
    await complete(h, p, 'configure-secrets-and-identity');
    expect((await planOf(h, p)).tasks.find((t) => t.key === 'configure-secrets-and-identity')!.status).toBe('COMPLETED');
    expect((await h.prisma.auditLog.findMany({ where: { projectId: p.project.id, action: { startsWith: 'change.' } } })).map((x) => x.action)).toEqual(expect.arrayContaining([
      'change.proposal_created', 'change.proposal_analyzed', 'change.proposal_approved', 'change.architecture_version_created', 'change.version_superseded', 'change.plan_migration_reviewed', 'change.progress_migration_accepted']));
    expect(await h.prisma.architectureChangeProposal.count({ where: { projectId: p.project.id } })).toBe(1);
  });
});

describe('proposal lifecycle, authorization and audit', () => {
  it('enforces the state machine and role rules; nothing happens without a human approval', async () => {
    const p = await started(); const viewer = await signUp(h.app, 'viewer'); const intruder = await signUp(h.app, 'intruder');
    await h.prisma.workspaceMember.create({ data: { workspaceId: p.workspace.id, userId: viewer.user.id, role: 'VIEWER' } });
    const c = await propose(h, p); const id = c.proposal.id;
    await expect(h.app.change.approve(p.ctx, id, { confirmRequirementChanges: false })).rejects.toMatchObject({ code: 'INVALID_STATE' }); // not analysed: cannot be approved
    await expect(h.app.change.create(viewer.ctx, p.project.id, { requestedChange: KINESIS, source: 'USER_REQUEST' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const f of [() => h.app.change.get(intruder.ctx, id), () => h.app.change.analyze(intruder.ctx, id), () => h.app.change.approve(intruder.ctx, id, { confirmRequirementChanges: false }), () => h.app.change.reject(intruder.ctx, id, {}), () => h.app.change.edit(intruder.ctx, id, { requestedChange: 'Something else entirely' }), () => h.app.change.rebase(intruder.ctx, id), () => h.app.change.retry(intruder.ctx, id)]) await expect(f()).rejects.toMatchObject({ code: 'PROPOSAL_NOT_FOUND' });
    await expect(h.app.change.list(intruder.ctx, p.project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(await h.app.change.list(viewer.ctx, p.project.id)).toHaveLength(1); // viewers may read
    await h.app.change.analyze(p.ctx, id); await expect(h.app.change.analyze(p.ctx, id)).rejects.toMatchObject({ code: 'INVALID_STATE' }); await h.runJobs();
    await expect(h.app.change.approve(viewer.ctx, id, { confirmRequirementChanges: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const edited = await h.app.change.edit(p.ctx, id, { requestedChange: 'Replace Managed event streaming with Azure Event Hubs', reason: 'Changed our mind' });
    expect(edited.proposal).toMatchObject({ status: 'DRAFT', analysis: null, severity: null }); expect(edited.proposal.impactItems).toEqual([]); // an edit discards the old analysis
    await h.app.change.analyze(p.ctx, id); await h.runJobs();
    expect((await h.app.change.reject(p.ctx, id, { note: 'Not now' })).proposal.status).toBe('REJECTED');
    expect(await h.prisma.changeProposalApproval.findUnique({ where: { proposalId: id } })).toMatchObject({ decision: 'REJECTED', decidedById: p.user.id });
    await expect(h.app.change.approve(p.ctx, id, { confirmRequirementChanges: false })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.app.change.edit(p.ctx, id, { requestedChange: 'Edit after rejection please' })).rejects.toMatchObject({ code: 'INVALID_STATE' }); await expect(h.app.change.reject(p.ctx, id, {})).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await h.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.versionNumber).toBe(1); // a rejected change changes nothing
    const acts = await h.prisma.auditLog.findMany({ where: { projectId: p.project.id, entityId: id } }); expect(acts.map((a) => a.action)).toEqual(expect.arrayContaining(['change.proposal_created', 'change.proposal_edited', 'change.proposal_analysis_started', 'change.proposal_analyzed', 'change.proposal_rejected']));
    expect(JSON.stringify(acts.map((a) => a.metadata))).not.toMatch(/Kinesis|Event Hubs|Changed our mind/); // free-form text is not copied into the audit log
  });

  it('refuses proposals the project cannot take, and validates where a proposal came from', async () => {
    const early = await architectureReadyProject(h);
    expect((await propose(h, early as never)).proposal.status).toBe('DRAFT'); // ARCHITECTURE_READY is fine
    const p = await started(); const other = await started();
    await h.prisma.project.update({ where: { id: p.project.id }, data: { status: 'ARCHIVED' } });
    await expect(propose(h, p)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const q = await started();
    await expect(h.app.change.create(q.ctx, q.project.id, { requestedChange: KINESIS, source: 'ASSISTANT_RECOMMENDATION' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); // needs the conversation and message
    await expect(h.app.change.create(q.ctx, q.project.id, { requestedChange: KINESIS, source: 'ARCHITECTURE_REVIEW' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const review = await h.app.change.runReview(other.ctx, other.project.id); // a finding of ANOTHER project
    await expect(h.app.change.create(q.ctx, q.project.id, { requestedChange: 'Add redundancy', source: 'ARCHITECTURE_REVIEW', reviewFindingId: review.review.findings[0]!.id })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('stale proposals and concurrent changes', () => {
  it('marks a proposal STALE when another change produced a newer version, refuses to apply it, and rebases it as a new proposal', async () => {
    const p = await started();
    const a = await analyzed(h, p, 'Replace Managed PostgreSQL with Amazon DynamoDB'); const b = await analyzed(h, p, KINESIS);
    await h.app.change.approve(p.ctx, b.proposal.id, { confirmRequirementChanges: false }); await h.runJobs();
    const staleA = await h.app.change.get(p.ctx, a.proposal.id);
    expect(staleA.proposal.status).toBe('STALE'); expect(staleA).toMatchObject({ isStale: true, canApprove: false, canRebase: true, baseVersionNumber: 1, currentVersionNumber: 2 });
    await expect(h.app.change.approve(p.ctx, a.proposal.id, { confirmRequirementChanges: false })).rejects.toMatchObject({ code: 'STALE_PROPOSAL' });
    await expect(h.app.change.analyze(p.ctx, a.proposal.id)).rejects.toMatchObject({ code: 'STALE_PROPOSAL' });
    expect((await h.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.versionNumber).toBe(2); // A was never applied

    const r = await h.app.change.rebase(p.ctx, a.proposal.id);
    expect(r.proposal).toMatchObject({ status: 'ANALYZING', rebasedFromId: a.proposal.id, requestedChange: a.proposal.requestedChange }); expect(r.baseVersionNumber).toBe(2); // bound to the CURRENT version
    expect((await h.app.change.rebase(p.ctx, a.proposal.id)).proposal.id).toBe(r.proposal.id); // idempotent
    expect((await h.app.change.get(p.ctx, a.proposal.id)).successorId).toBe(r.proposal.id); expect((await h.app.change.get(p.ctx, a.proposal.id)).proposal.status).toBe('STALE'); // history kept
    await h.runJobs(); const fresh = await h.app.change.get(p.ctx, r.proposal.id);
    expect(fresh.proposal.status).toBe('READY_FOR_REVIEW'); // re-analysed, and it needs approval AGAIN
    expect(await h.prisma.changeProposalApproval.count({ where: { proposalId: r.proposal.id } })).toBe(0);
    await expect(h.app.change.rebase(p.ctx, r.proposal.id)).rejects.toMatchObject({ code: 'INVALID_STATE' }); // already current
    await expect(h.app.change.rebase(p.ctx, b.proposal.id)).rejects.toMatchObject({ code: 'INVALID_STATE' }); // finished proposals are not rebased
  });

  it('lets exactly one of two simultaneous approvals win, and applies exactly one change', async () => {
    const p = await started(); const a = await analyzed(h, p); const b = await analyzed(h, p, 'Replace Managed PostgreSQL with Amazon DynamoDB');
    const r = await Promise.allSettled([h.app.change.approve(p.ctx, a.proposal.id, { confirmRequirementChanges: false }), h.app.change.approve(p.ctx, b.proposal.id, { confirmRequirementChanges: false })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1); // one active change application per project
    expect(r.find((x) => x.status === 'rejected')).toMatchObject({ reason: { code: 'INVALID_STATE' } });
    await h.runJobs(); expect(await h.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(2);
    const dup = await analyzed(h, p, 'Replace Amazon Kinesis with Managed event streaming');
    const same = await Promise.allSettled([h.app.change.approve(p.ctx, dup.proposal.id, { confirmRequirementChanges: false }), h.app.change.approve(p.ctx, dup.proposal.id, { confirmRequirementChanges: false })]);
    expect(same.filter((x) => x.status === 'fulfilled')).toHaveLength(1); await h.runJobs(); // duplicate approval of the SAME proposal
    expect(await h.prisma.architectureGenerationRun.count({ where: { proposalId: dup.proposal.id } })).toBe(1);
  });
});

describe('idempotency and crash recovery', () => {
  it('survives duplicate job deliveries and simultaneous workers: one approved proposal => one architecture version and one plan chain', async () => {
    const p = await started(); const v = await analyzed(h, p); await h.app.change.approve(p.ctx, v.proposal.id, { confirmRequirementChanges: false });
    const runId = (await h.repos.architecture.getLatestRun(p.project.id)) ? (await h.prisma.architectureGenerationRun.findUniqueOrThrow({ where: { proposalId: v.proposal.id } })).id : ''; h.queue.jobs.length = 0;
    const out = await Promise.all([1, 2, 3, 4].map(() => h.app.change.runApplication(runId)));
    expect(out.filter((o) => o.outcome === 'SUCCEEDED')).toHaveLength(1); expect(out.filter((o) => o.outcome !== 'SUCCEEDED').every((o) => ['NOT_CLAIMED', 'ALREADY_DONE'].includes(o.outcome))).toBe(true);
    expect(await h.app.change.runApplication(runId)).toMatchObject({ outcome: 'ALREADY_DONE' });
    await h.runJobs();
    expect(await h.prisma.architectureVersion.count({ where: { sourceProposalId: v.proposal.id } })).toBe(1); expect(await h.prisma.architectureVersion.count({ where: { architecture: { projectId: p.project.id } } })).toBe(2);
    expect(await h.prisma.implementationGenerationRun.count({ where: { chainProposalId: v.proposal.id } })).toBe(1); expect(await h.prisma.implementationPlanVersion.count({ where: { sourceProposalId: v.proposal.id } })).toBe(1);
  });

  it('completes the plan chain after a crash between the architecture version and the plan job', async () => {
    const p = await started(); const v = await analyzed(h, p); await h.app.change.approve(p.ctx, v.proposal.id, { confirmRequirementChanges: false });
    const runId = (await h.prisma.architectureGenerationRun.findUniqueOrThrow({ where: { proposalId: v.proposal.id } })).id; h.queue.jobs.length = 0;
    h.queue.failNext = true; // the plan job cannot be queued: simulates a crash right after the version was created
    expect(await h.app.change.runApplication(runId)).toMatchObject({ outcome: 'SUCCEEDED', created: true });
    expect(await h.prisma.implementationPlanVersion.count({ where: { sourceProposalId: v.proposal.id } })).toBe(0);
    expect(await h.prisma.implementationGenerationRun.findUnique({ where: { chainProposalId: v.proposal.id } })).toMatchObject({ status: 'FAILED' });
    expect(await h.app.change.runApplication(runId)).toMatchObject({ outcome: 'ALREADY_DONE' }); // the redelivered job finishes the chain
    await h.runJobs();
    expect(await h.prisma.architectureVersion.count({ where: { sourceProposalId: v.proposal.id } })).toBe(1); expect(await h.prisma.implementationPlanVersion.count({ where: { sourceProposalId: v.proposal.id } })).toBe(1);
    expect(await h.prisma.implementationGenerationRun.count({ where: { chainProposalId: v.proposal.id } })).toBe(1); // still ONE chain
  });

  it('reclaims a worker that died, fails a lost job instead of hanging, and retries the SAME run', async () => {
    const q = makeApp({}, {}, {}, undefined, {}, { changeConfig: { staleRunMs: 400 } });
    try {
      const p = await started(q); const v = await analyzed(q, p);
      await q.app.change.approve(p.ctx, v.proposal.id, { confirmRequirementChanges: false }); q.queue.jobs.length = 0;
      const run = await q.prisma.architectureGenerationRun.findUniqueOrThrow({ where: { proposalId: v.proposal.id } });
      await q.repos.architecture.claimRun(run.id, new Date(0)); expect(await q.repos.architecture.claimRun(run.id, new Date(Date.now() - 400))).toBeNull(); // a worker holds it
      await sleep(450);
      const lost = await q.app.change.get(p.ctx, v.proposal.id); // lazily recovered
      expect(lost.proposal).toMatchObject({ status: 'FAILED', failureCode: 'GENERATION_TIMED_OUT' }); expect(lost.proposal.failureMessage).toMatch(/did not finish in time/);
      expect(await q.prisma.architectureVersion.count({ where: { sourceProposalId: v.proposal.id } })).toBe(0); expect((await q.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.versionNumber).toBe(1);
      expect((await q.app.change.retry(p.ctx, v.proposal.id)).proposal.status).toBe('APPLYING'); await q.runJobs();
      expect((await q.app.change.get(p.ctx, v.proposal.id)).proposal.status).toBe('APPLIED');
      expect(await q.prisma.architectureGenerationRun.count({ where: { proposalId: v.proposal.id } })).toBe(1); expect(await q.prisma.architectureVersion.count({ where: { sourceProposalId: v.proposal.id } })).toBe(1);
    } finally { await q.prisma.$disconnect(); }
  });

  it('fails a lost analysis job instead of leaving the proposal ANALYZING forever, and allows analysing again', async () => {
    const q = makeApp({}, {}, {}, undefined, {}, { changeConfig: { staleRunMs: 400 } });
    try {
      const p = await started(q); const c = await propose(q, p); await q.app.change.analyze(p.ctx, c.proposal.id); q.queue.jobs.length = 0; await sleep(450);
      expect((await q.app.change.get(p.ctx, c.proposal.id)).proposal).toMatchObject({ status: 'FAILED', failureCode: 'GENERATION_TIMED_OUT' });
      await q.app.change.analyze(p.ctx, c.proposal.id); await q.runJobs(); expect((await q.app.change.get(p.ctx, c.proposal.id)).proposal.status).toBe('READY_FOR_REVIEW');
      q.queue.failNext = true; const c2 = await propose(q, p); await expect(q.app.change.analyze(p.ctx, c2.proposal.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      expect((await q.app.change.get(p.ctx, c2.proposal.id)).proposal).toMatchObject({ status: 'FAILED', failureCode: 'ENQUEUE_FAILED' });
    } finally { await q.prisma.$disconnect(); }
  });
});

describe('validation, safe failure and the same quality gates as a first version', () => {
  const v1Unchanged = async (p: Impl) => expect((await h.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.versionNumber).toBe(1);
  async function scriptedApply(p: Impl, script: unknown[]) {
    const s = makeApp({ script: json(...script) });
    try { const c = await s.app.change.create(p.ctx, p.project.id, { requestedChange: KINESIS, source: 'USER_REQUEST' }); await s.app.change.analyze(p.ctx, c.proposal.id); await s.runJobs(); return { s, c, done: async () => s.prisma.$disconnect() }; } catch (e) { await s.prisma.$disconnect(); throw e; }
  }
  const analysis = (extra: object = {}) => { const imp = { direction: 'MIXED', notes: 'Some things improve and others get worse.' }; return { summary: 'Replace the event stream technology with Amazon Kinesis while keeping its role.', changeType: 'TECHNOLOGY_REPLACEMENT', whatChanges: ['Event stream technology'], performanceImpact: imp, securityImpact: imp, reliabilityImpact: imp, costImpact: imp, complexityImpact: imp, operationalImpact: imp, migrationImpact: imp, implementationImpact: imp, recommendation: { verdict: 'PROCEED_WITH_CAUTION', rationale: 'It is feasible with care for producers and consumers.' }, confidence: 0.7, affectedNodes: [{ key: 'event-stream', relation: 'DIRECT', reason: 'It is the component being replaced' }], ...extra }; };
  const kinesisOp = { op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: true, newStableKey: null, node: { name: 'Event stream', technology: 'Amazon Kinesis', technologySlug: 'amazon-kinesis', purpose: 'Durable event backbone for transactions', description: 'Managed stream replacing the previous backbone.', managedService: true, deploymentModel: 'MANAGED_SERVICE', provider: 'AWS', configuration: [], risks: [], alternatives: [] } };
  const plan = (...operations: unknown[]) => ({ summary: 'Replace the event stream technology with Amazon Kinesis as approved.', operations });
  const clean = { assessment: 'The new version is coherent.', issues: [] };

  it('turns garbage analysis into a safe failure that can be retried; no model text reaches the user', async () => {
    const p = await started(); const bad = makeApp({ script: ['I think you should rewrite everything.', 'Seriously, rewrite it.'] });
    try {
      const c = await bad.app.change.create(p.ctx, p.project.id, { requestedChange: KINESIS, source: 'USER_REQUEST' }); await bad.app.change.analyze(p.ctx, c.proposal.id);
      expect(await bad.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'AI_OUTPUT_INVALID' }]);
      const f = await bad.app.change.get(p.ctx, c.proposal.id); expect(f.proposal).toMatchObject({ status: 'FAILED', failureCode: 'AI_OUTPUT_INVALID' }); expect(f.proposal.failureMessage).not.toMatch(/rewrite|JSON|Zod/);
      await h.app.change.analyze(p.ctx, c.proposal.id); await h.runJobs(); expect((await h.app.change.get(p.ctx, c.proposal.id)).proposal.status).toBe('READY_FOR_REVIEW');
    } finally { await bad.prisma.$disconnect(); }
    const down = makeApp({ script: [new AIError('AI_PROVIDER_ERROR', 'LEAKMARKER api_key=sk-ant-SECRET', false)] });
    try { const c = await down.app.change.create(p.ctx, p.project.id, { requestedChange: KINESIS, source: 'USER_REQUEST' }); await down.app.change.analyze(p.ctx, c.proposal.id); await down.runJobs(); const f = (await down.app.change.get(p.ctx, c.proposal.id)).proposal; expect(`${f.failureCode} ${f.failureMessage}`).not.toMatch(/LEAKMARKER|SECRET|sk-ant/); } finally { await down.prisma.$disconnect(); }
  });

  it('rejects analyses that invent components, decisions, requirements or tasks', async () => {
    const p = await started();
    const bad = analysis({ affectedNodes: [{ key: 'ghost-component', relation: 'DIRECT', reason: 'A component that does not exist at all' }] });
    const { s, c, done } = await scriptedApply(p, [bad, bad]);
    try { expect((await s.app.change.get(p.ctx, c.proposal.id)).proposal).toMatchObject({ status: 'FAILED', failureCode: 'AI_OUTPUT_INVALID' }); } finally { await done(); }
  });

  it('fails an application whose operations are impossible, leaving V1 current and untouched, and the proposal retryable', async () => {
    const p = await started(); const ghost = plan({ ...kinesisOp, stableKey: 'ghost-component' });
    const { s, c, done } = await scriptedApply(p, [analysis(), ghost, ghost]);
    try {
      await s.app.change.approve(p.ctx, c.proposal.id, { confirmRequirementChanges: false }); expect(await s.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'AI_OUTPUT_INVALID' }]);
      expect((await s.app.change.get(p.ctx, c.proposal.id)).proposal).toMatchObject({ status: 'FAILED' }); await v1Unchanged(p);
      expect(await s.prisma.architectureVersion.count({ where: { sourceProposalId: c.proposal.id } })).toBe(0); expect((await s.repos.projects.findById(p.project.id))!.status).toBe('IMPLEMENTING');
    } finally { await done(); }
  });

  it('refuses a plan that touches components the user did not approve (scope), and never applies it', async () => {
    const p = await started();
    const outOfScope = plan(kinesisOp, { op: 'UPDATE_NODE', stableKey: 'primary-database', set: { criticality: 'LOW' } });
    const { s, c, done } = await scriptedApply(p, [analysis(), outOfScope]);
    try {
      await s.app.change.approve(p.ctx, c.proposal.id, { confirmRequirementChanges: false }); expect(await s.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'CHANGE_OUT_OF_SCOPE' }]);
      expect((await s.app.change.get(p.ctx, c.proposal.id)).proposal.failureMessage).toMatch(/beyond what you approved/); await v1Unchanged(p);
      expect((await s.repos.architecture.getVersion((await s.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.id))!.nodes.find((n) => n.stableKey === 'primary-database')!.criticality).not.toBe('LOW');
    } finally { await done(); }
  });

  it('runs the SAME quality gates as a first version: a CRITICAL critic finding is repaired, and an unrepairable one fails the change', async () => {
    const p = await started();
    const critical = { assessment: 'The new version has a serious gap.', issues: [{ severity: 'CRITICAL', category: 'RELIABILITY', description: 'The replaced stream has no recovery path for the processor.', affectedNodeStableKeys: ['event-stream'], affectedDecisionKeys: [], relatedRequirementCodes: [], recommendation: 'Record retention for replay.' }] };
    const patch = { changes: [{ issueIndex: 0, description: 'Recorded retention for replay on the new stream' }], nodes: { update: [{ stableKey: 'event-stream', set: { configuration: [{ key: 'retention', value: '7 days' }] } }] } };
    const { s, c, done } = await scriptedApply(p, [analysis(), plan(kinesisOp), critical, patch, clean]);
    try {
      await s.app.change.approve(p.ctx, c.proposal.id, { confirmRequirementChanges: false }); const out = await s.runJobs();
      expect(out[0]).toMatchObject({ outcome: 'SUCCEEDED' }); const v2 = (await s.repos.architecture.getVersion((await s.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.id))!;
      expect(v2.nodes.find((n) => n.stableKey === 'event-stream')!.configuration).toEqual([{ key: 'retention', value: '7 days' }]); expect(v2.issues.some((i) => i.stage === 'AFTER_REPAIR_1' || i.stage === 'PLAN')).toBe(true);
    } finally { await done(); }
    const q = await started(); const noop = { changes: [{ issueIndex: 0, description: 'Looked at it' }] };
    const r = await scriptedApply(q, [analysis(), plan(kinesisOp), critical, noop, critical, noop, critical]);
    try {
      await r.s.app.change.approve(q.ctx, r.c.proposal.id, { confirmRequirementChanges: false }); expect(await r.s.runJobs()).toMatchObject([{ outcome: 'FAILED', failureCode: 'ARCHITECTURE_VALIDATION_FAILED' }]);
      expect(await r.s.prisma.architectureVersion.count({ where: { sourceProposalId: r.c.proposal.id } })).toBe(0); expect((await r.s.repos.architecture.getVersion((await r.s.app.architecture.getOverview(q.ctx, q.project.id)).current!.version.id))!.versionNumber).toBe(1);
    } finally { await r.done(); }
  });

  it('a role change needs a NEW stable key and records lineage in the version history', async () => {
    const p = await started();
    const roleChange = plan({ op: 'REPLACE_NODE', stableKey: 'event-stream', keepRole: false, newStableKey: 'message-queue', node: { ...kinesisOp.node, name: 'Message queue', technology: 'Amazon SQS', technologySlug: 'amazon-sqs', category: 'QUEUE' } });
    const { s, c, done } = await scriptedApply(p, [analysis(), roleChange, clean]);
    try {
      await s.app.change.approve(p.ctx, c.proposal.id, { confirmRequirementChanges: false }); expect((await s.runJobs())[0]).toMatchObject({ outcome: 'SUCCEEDED' });
      const cur = (await s.app.architecture.getOverview(p.ctx, p.project.id)).current!.version; const v2 = (await s.repos.architecture.getVersion(cur.id))!;
      expect(v2.nodes.map((n) => n.stableKey)).toContain('message-queue'); expect(v2.nodes.map((n) => n.stableKey)).not.toContain('event-stream'); expect(v2.nodes.find((n) => n.stableKey === 'message-queue')).toMatchObject({ replacesStableKey: 'event-stream', category: 'QUEUE' });
      const arch = await s.repos.architecture.getByProject(p.project.id); expect(await s.repos.architecture.nodeHistory(arch!.id, 'event-stream')).toMatchObject([{ versionNumber: 1, replacedByStableKey: 'message-queue' }]);
      const d = await s.app.change.getDiff(p.ctx, v2.parentVersionId!, v2.id); expect(d.diff.nodes.find((n) => n.kind === 'REPLACED')).toMatchObject({ stableKey: 'message-queue', from: { stableKey: 'event-stream' } });
    } finally { await done(); }
  });
});

describe('requirement changes need reconfirmation', () => {
  it('a multi-region request changes requirements: it needs explicit confirmation, creates new requirement and brief versions, and keeps every old code stable', async () => {
    const p = await started();
    const reqsBefore = await h.repos.requirements.list(p.project.id); const oldBrief = (await h.repos.briefs.latestVersion(p.project.id))!; const oldDrivers = (await h.repos.briefs.listDrivers(oldBrief.id)).map((d) => d.key);
    const v = await analyzed(h, p, 'Make the system multi-region');
    expect(v.proposal).toMatchObject({ changeType: 'REQUIREMENT_CHANGE', requiresReconfirmation: true }); expect(v.proposal.requirementChanges).toMatchObject([{ kind: 'ADD', category: 'AVAILABILITY' }]); expect(v.proposal.severity).not.toBe('LOW');
    await expect(h.app.change.approve(p.ctx, v.proposal.id, { confirmRequirementChanges: false })).rejects.toMatchObject({ code: 'CONFIRMATION_BLOCKED', details: { requirementChanges: [expect.objectContaining({ kind: 'ADD' })] } });
    expect(await h.prisma.changeProposalApproval.count({ where: { proposalId: v.proposal.id } })).toBe(0); expect((await h.repos.requirements.list(p.project.id)).length).toBe(reqsBefore.length); // nothing was rewritten without confirmation

    await h.app.change.approve(p.ctx, v.proposal.id, { confirmRequirementChanges: true }); await h.runJobs();
    const reqsAfter = await h.repos.requirements.list(p.project.id); expect(reqsAfter).toHaveLength(reqsBefore.length + 1);
    const added = reqsAfter.find((r) => !reqsBefore.some((o) => o.id === r.id))!; expect(added).toMatchObject({ category: 'AVAILABILITY', status: 'ACTIVE', origin: 'USER_STATED', version: 1 }); expect(added.statement).toMatch(/multi-region/i);
    for (const old of reqsBefore) expect(reqsAfter.find((r) => r.id === old.id)).toMatchObject({ statement: old.statement, version: old.version, status: old.status }); // confirmed requirements untouched
    const newBrief = (await h.repos.briefs.latestVersion(p.project.id))!; expect(newBrief.version).toBe(oldBrief.version + 1); expect(newBrief.confirmedAt).not.toBeNull();
    expect(await h.prisma.architectureBriefVersion.findFirst({ where: { id: newBrief.id }, select: { sourceProposalId: true } })).toEqual({ sourceProposalId: v.proposal.id });
    const drivers = (await h.repos.briefs.listDrivers(newBrief.id)).map((d) => d.key); expect(drivers.slice(0, oldDrivers.length)).toEqual(oldDrivers); expect(drivers).toHaveLength(oldDrivers.length + 1); // old DRV codes unchanged; one appended
    const v2 = (await h.repos.architecture.getVersion((await h.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.id))!; expect(v2.briefVersionId).toBe(newBrief.id);
    expect(v2.decisions.some((d) => d.requirementIds.includes(added.id))).toBe(true); // the new requirement is carried into the architecture
    expect((await h.repos.architecture.getVersion(v.proposal.baseVersionId))!.briefVersionId).toBe(oldBrief.id); // V1 still points at the brief it was made from
    expect((await h.prisma.auditLog.findMany({ where: { projectId: p.project.id, action: 'change.requirements_reconfirmed' } })).length).toBe(1);
  });

  it('a plain technology substitution never forces reconfirmation and creates no requirement or brief versions', async () => {
    const p = await started(); const before = { reqs: await h.prisma.requirement.count({ where: { projectId: p.project.id } }), briefs: await h.prisma.architectureBriefVersion.count({ where: { brief: { projectId: p.project.id } } }) };
    const v = await analyzed(h, p); expect(v.proposal.requiresReconfirmation).toBe(false);
    await h.app.change.approve(p.ctx, v.proposal.id, { confirmRequirementChanges: false }); await h.runJobs();
    expect({ reqs: await h.prisma.requirement.count({ where: { projectId: p.project.id } }), briefs: await h.prisma.architectureBriefVersion.count({ where: { brief: { projectId: p.project.id } } }) }).toEqual(before);
  });
});

describe('database-level guarantees', () => {
  it('protects the superseded version, the proposal binding, approvals, diffs and uniqueness even from raw SQL', async () => {
    const p = await started(); const v = await applied(h, p); const base = v.proposal.baseVersionId;
    const fail = (sql: string, re: RegExp) => expect(h.prisma.$executeRawUnsafe(sql), sql).rejects.toThrow(re);
    await fail(`UPDATE "ArchitectureNode" SET "technology" = 'tampered' WHERE "versionId" = '${base}'`, /immutable|READY|SUPERSEDED/i);
    await fail(`UPDATE "ArchitectureDecision" SET "title" = 'tampered' WHERE "versionId" = '${base}'`, /immutable|READY|SUPERSEDED/i);
    await fail(`UPDATE "ArchitectureChangeProposal" SET "baseVersionId" = '${v.resultVersion!.id}' WHERE "id" = '${v.proposal.id}'`, /bound to its architecture version/);
    await fail(`UPDATE "ChangeProposalApproval" SET "note" = 'edited' WHERE "proposalId" = '${v.proposal.id}'`, /append-only/);
    await fail(`UPDATE "ArchitectureVersionDiff" SET "summary" = '{}' WHERE "toVersionId" = '${v.resultVersion!.id}'`, /append-only/);
    await fail(`UPDATE "ArchitectureChangeProposal" SET "status" = 'NOT_A_STATE' WHERE "id" = '${v.proposal.id}'`, /check|violates/i);
    await expect(h.prisma.changeProposalApproval.create({ data: { proposalId: v.proposal.id, decision: 'APPROVED', decidedById: p.user.id, architectureVersionId: base } })).rejects.toMatchObject({ code: 'P2002' }); // one decision per proposal
    const arch = await h.prisma.architecture.findUniqueOrThrow({ where: { projectId: p.project.id } }); const run = await h.prisma.architectureGenerationRun.create({ data: { projectId: p.project.id, briefVersionId: (await h.repos.architecture.getVersion(base))!.briefVersionId, requestedById: p.user.id, status: 'FAILED' } });
    await expect(h.prisma.architectureVersion.create({ data: { architectureId: arch.id, versionNumber: 9, status: 'DRAFT', generationRunId: run.id, briefVersionId: (await h.repos.architecture.getVersion(base))!.briefVersionId, sourceProposalId: v.proposal.id, summary: 's', assumptions: [], unresolvedQuestions: [], risks: [], ai: {} } })).rejects.toMatchObject({ code: 'P2002' }); // one version per proposal
    const bv = (await h.repos.architecture.getVersion(base))!.briefVersionId; const data = { projectId: p.project.id, briefVersionId: bv, requestedById: p.user.id, mode: 'CHANGE', status: 'QUEUED' as const };
    await h.prisma.architectureGenerationRun.create({ data }); await expect(h.prisma.architectureGenerationRun.create({ data })).rejects.toMatchObject({ code: 'P2002' }); // one ACTIVE change application per project
  });
});

describe('production readiness review and review -> change proposal', () => {
  it('reviews the current version, keeps findings with the version, and turns a finding into a traceable proposal', async () => {
    const p = await started(); const r = await h.app.change.runReview(p.ctx, p.project.id);
    expect(r.review.architectureVersionId).toBe((await h.app.architecture.getOverview(p.ctx, p.project.id)).current!.version.id); expect(r.isCurrent).toBe(true);
    expect(r.review.findings.length).toBeGreaterThan(0); expect(r.counts.HIGH + r.counts.MEDIUM + r.counts.LOW + r.counts.CRITICAL).toBe(r.review.findings.length);
    const sev = r.review.findings.map((f) => ({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 })[f.severity]); expect(sev).toEqual([...sev].sort((a, b) => a - b)); // most serious first
    const spof = r.review.findings.find((f) => f.title === 'Event stream is a single point of failure')!; expect(spof).toMatchObject({ area: 'RELIABILITY', source: 'DETERMINISTIC', requiresArchitectureChange: true });
    expect((await h.app.change.latestReview(p.ctx, p.project.id))!.review.id).toBe(r.review.id);
    const c = await h.app.change.create(p.ctx, p.project.id, { requestedChange: spof.suggestedChange, source: 'ARCHITECTURE_REVIEW', reviewFindingId: spof.id });
    expect(c.proposal).toMatchObject({ source: 'ARCHITECTURE_REVIEW', reviewFindingId: spof.id, status: 'DRAFT' }); // origin traceability
    expect(await h.prisma.architectureChangeProposal.findUniqueOrThrow({ where: { id: c.proposal.id }, include: { reviewFinding: true } })).toMatchObject({ reviewFinding: { title: spof.title } });
    const intruder = await signUp(h.app, 'intruder'); await expect(h.app.change.runReview(intruder.ctx, p.project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' }); await expect(h.app.change.latestReview(intruder.ctx, p.project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('still produces the deterministic review when the model is unavailable, and says so', async () => {
    const p = await started(); const down = makeApp({ script: [new AIError('AI_PROVIDER_ERROR', 'x', false)] });
    try { const r = await down.app.change.runReview(p.ctx, p.project.id); expect(r.aiAvailable).toBe(false); expect(r.review.findings.length).toBeGreaterThan(0); expect(r.review.findings.every((f) => f.source === 'DETERMINISTIC')).toBe(true); expect(r.review.assessment).toMatch(/AI review was unavailable/); } finally { await down.prisma.$disconnect(); }
  });

  it('turns an assistant recommendation into a proposal, but only if the assistant really recommended a change', async () => {
    const p = await started(); const ask = async (message: string) => { let last; for await (const e of h.app.assistant.ask(p.ctx, { projectId: p.project.id, scope: 'COMPONENT', scopeId: 'event-stream', message, clientMessageId: `cm-${Math.random().toString(36).slice(2, 12)}` })) last = e; return last as { type: 'done'; message: { id: string; conversationId: string } }; };
    const yes = await ask('Could we use something else instead?'); const no = await ask('Why do I need this?');
    const c = await h.app.change.create(p.ctx, p.project.id, { requestedChange: KINESIS, source: 'ASSISTANT_RECOMMENDATION', assistantConversationId: yes.message.conversationId, assistantMessageId: yes.message.id });
    expect(c.proposal).toMatchObject({ source: 'ASSISTANT_RECOMMENDATION', assistantMessageId: yes.message.id, status: 'DRAFT' });
    await expect(h.app.change.create(p.ctx, p.project.id, { requestedChange: KINESIS, source: 'ASSISTANT_RECOMMENDATION', assistantConversationId: no.message.conversationId, assistantMessageId: no.message.id })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const mate = await signUp(h.app, 'mate'); await h.prisma.workspaceMember.create({ data: { workspaceId: p.workspace.id, userId: mate.user.id, role: 'EDITOR' } });
    await expect(h.app.change.create(mate.ctx, p.project.id, { requestedChange: KINESIS, source: 'ASSISTANT_RECOMMENDATION', assistantConversationId: yes.message.conversationId, assistantMessageId: yes.message.id })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); // someone else's conversation
  });
});

describe('failure-mode view, version history and diff access', () => {
  it('answers "what happens if this fails?" from the graph, with the decisions and tasks involved', async () => {
    const p = await started(); const f = await h.app.change.failureImpact(p.ctx, p.project.id, 'event-stream');
    expect(f.directlyAffected.cannotReach.map((x) => x.stableKey)).toEqual(['event-producers']); expect(f.directlyAffected.stopReceiving.map((x) => x.stableKey)).toEqual(['stream-processor']);
    expect(f.criticalPaths.length).toBeGreaterThan(0); expect(f.singlePointOfFailure).toBe(true); expect(f.decisions.length).toBeGreaterThan(0); expect(f.implementationTasks.map((t) => t.title).join()).toMatch(/Event stream/);
    await expect(h.app.change.failureImpact(p.ctx, p.project.id, 'ghost')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    const intruder = await signUp(h.app, 'intruder'); await expect(h.app.change.failureImpact(intruder.ctx, p.project.id, 'event-stream')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
  it('lists the version history with origin and plan versions, and keeps diffs inside the workspace', async () => {
    const p = await started(); const v = await applied(h, p); const intruder = await signUp(h.app, 'intruder'); const other = await started();
    const hist = await h.app.change.versionHistory(p.ctx, p.project.id);
    expect(hist.map((x) => `${x.versionNumber}:${x.status}:${x.isCurrent}`)).toEqual(['2:READY:true', '1:SUPERSEDED:false']); expect(hist[0]!.origin).toMatchObject({ proposalId: v.proposal.id, source: 'USER_REQUEST' }); expect(hist[1]!.origin.source).toBe('INITIAL');
    expect(hist[0]!.planVersions).toMatchObject([{ versionNumber: 2, activation: 'PENDING_REVIEW' }]); expect(hist[1]!.planVersions).toMatchObject([{ versionNumber: 1, activation: 'ACTIVE' }]);
    await expect(h.app.change.getDiff(intruder.ctx, hist[1]!.id, hist[0]!.id)).rejects.toMatchObject({ code: 'ARCHITECTURE_NOT_FOUND' });
    const otherCurrent = (await h.app.architecture.getOverview(other.ctx, other.project.id)).current!.version.id; await expect(h.app.change.getDiff(p.ctx, hist[0]!.id, otherCurrent)).rejects.toMatchObject({ code: 'ARCHITECTURE_NOT_FOUND' }); // versions of two projects never compare
    await expect(h.app.change.versionHistory(intruder.ctx, p.project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});

describe('progress migration safety', () => {
  it('refuses to apply a migration whose reviewed progress is out of date, and applies nothing', async () => {
    const p = await started(); await applied(h, p); const pending = (await h.repos.implementation.listPlanVersions(p.project.id)).find((x) => x.activation === 'PENDING_REVIEW')!;
    const plan1 = await planOf(h, p); const d = await h.app.change.planDiff(p.ctx, plan1.version.id, pending.id);
    const items = d.items.map((r) => ({ v1TaskId: r.v1?.id ?? null, v2TaskId: r.v2?.id ?? null, outcome: r.outcome, reason: r.reason, v1Status: r.v1?.status ?? null }));
    await complete(h, p, 'configure-primary-database'); // V1 progress moves AFTER the user reviewed the migration
    await expect(h.repos.migrations.accept({ fromPlanVersionId: plan1.version.id, toPlanVersionId: pending.id, userId: p.user.id, proposalId: null, items, summary: d.summary })).rejects.toMatchObject({ code: 'MIGRATION_STALE' });
    expect((await h.repos.implementation.listPlanVersions(p.project.id)).find((x) => x.id === pending.id)!.activation).toBe('PENDING_REVIEW'); expect(await h.prisma.implementationMigration.count({ where: { toPlanVersionId: pending.id } })).toBe(0);
    const fresh = await h.app.change.acceptMigration(p.ctx, pending.id); // the service always re-computes from current progress
    expect(fresh.summary.completedInV1).toBe(d.summary.completedInV1 + 1); expect(fresh.carried.some((r) => r.v1?.title && /primary database/i.test(r.v1.title))).toBe(true);
    const intruder = await signUp(h.app, 'intruder'); await expect(h.app.change.planDiff(intruder.ctx, plan1.version.id, pending.id)).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' }); await expect(h.app.change.acceptMigration(intruder.ctx, pending.id)).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });
  it('lets a viewer see the migration but not accept it', async () => {
    const p = await started(); await applied(h, p); const viewer = await signUp(h.app, 'viewer'); await h.prisma.workspaceMember.create({ data: { workspaceId: p.workspace.id, userId: viewer.user.id, role: 'VIEWER' } });
    const pending = (await h.repos.implementation.listPlanVersions(p.project.id)).find((x) => x.activation === 'PENDING_REVIEW')!; const plan1 = await planOf(h, p);
    expect((await h.app.change.planDiff(viewer.ctx, plan1.version.id, pending.id)).canAccept).toBe(true); await expect(h.app.change.acceptMigration(viewer.ctx, pending.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('approval is guarded at every layer, each one independently', () => {
  it('refuses to approve anything that is not READY_FOR_REVIEW: in the service, and again in the database compare-and-set', async () => {
    const p = await architectureReadyProject(h); const c = await propose(h, p as unknown as Impl);
    // service layer: a DRAFT cannot be approved, and says why
    await expect(h.app.change.approve(p.ctx, c.proposal.id, { confirmRequirementChanges: false })).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/not ready for review/) });
    // repository layer, bypassing the service entirely: only READY_FOR_REVIEW may become APPROVED
    for (const state of ['DRAFT', 'ANALYZING', 'REJECTED', 'APPLIED', 'FAILED']) {
      await h.prisma.architectureChangeProposal.update({ where: { id: c.proposal.id }, data: { status: state } });
      const r = await h.repos.changes.approve({ id: c.proposal.id, userId: p.user.id, note: null, confirmedRequirementChanges: false, requirementApplication: undefined });
      expect(r.result, state).not.toBe('OK');
      expect((await h.prisma.architectureChangeProposal.findUniqueOrThrow({ where: { id: c.proposal.id } })).status, state).toBe(state); // untouched
      expect(await h.prisma.changeProposalApproval.count({ where: { proposalId: c.proposal.id } }), state).toBe(0); // and no approval record was written
    }
    expect(await h.prisma.architectureGenerationRun.count({ where: { proposalId: c.proposal.id } })).toBe(0); // no application run either
  });
});
