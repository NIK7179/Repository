import { afterAll, describe, expect, it } from 'vitest';
import { heuristicInterpretation } from '@pitch2plan/ai';
import { PITCH, makeApp, signUp } from '../helpers';

const h = makeApp();
afterAll(() => h.prisma.$disconnect());

describe('provisioning', () => {
  it('creates a user, a personal workspace and an OWNER membership on first sight', async () => {
    const { user, workspace } = await signUp(h.app, 'alice');
    expect(workspace.isPersonal).toBe(true);
    const memberships = await h.repos.workspaces.listMemberships(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ workspaceId: workspace.id, role: 'OWNER' });
  });

  it('is idempotent and safe under concurrent first logins', async () => {
    const identity = { externalId: 'test:race', email: `race-${Date.now()}@example.com`, name: 'Race' };
    const results = await Promise.all([1, 2, 3, 4].map(() => h.app.users.provision(identity)));
    expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.workspace.id)).size).toBe(1);
    expect(results.filter((r) => r.created).length).toBeLessThanOrEqual(1);
  });
});

describe('projects and pitches', () => {
  it('creates a project in the personal workspace, saves a pitch and reads both back', async () => {
    const { ctx, workspace } = await signUp(h.app);
    const project = await h.app.projects.create(ctx, { name: 'Fraud platform' });
    expect(project).toMatchObject({ workspaceId: workspace.id, status: 'IDEA', deletedAt: null });
    await h.app.pitches.submit(ctx, project.id, { content: PITCH, technicalLevel: 'FOUNDER' });
    const got = await h.app.projects.get(ctx, project.id);
    expect(got.latestPitch).toMatchObject({ content: PITCH, version: 1, technicalLevel: 'FOUNDER' });
    expect((await h.app.projects.list(ctx)).map((p) => p.id)).toContain(project.id);
  });

  it('never overwrites the original pitch: revisions append new versions', async () => {
    const { ctx } = await signUp(h.app);
    const project = await h.app.projects.create(ctx, { name: 'Versions' });
    const first = await h.app.pitches.submit(ctx, project.id, { content: PITCH });
    const second = await h.app.pitches.submit(ctx, project.id, { content: `${PITCH} Also support refunds.` });
    expect([first.version, second.version]).toEqual([1, 2]);
    expect((await h.repos.pitches.findById(first.id))!.content).toBe(PITCH);
    expect((await h.app.projects.get(ctx, project.id)).latestPitch!.version).toBe(2);
  });

  it('assigns unique versions when pitches are submitted concurrently', async () => {
    const { ctx } = await signUp(h.app);
    const project = await h.app.projects.create(ctx, { name: 'Concurrent' });
    const pitches = await Promise.all([1, 2, 3].map((i) => h.app.pitches.submit(ctx, project.id, { content: `${PITCH} variant ${i}` })));
    expect(new Set(pitches.map((p) => p.version)).size).toBe(3);
  });

  it('hides soft-deleted projects from lists and lookups', async () => {
    const { ctx } = await signUp(h.app);
    const project = await h.app.projects.create(ctx, { name: 'Temp' });
    await h.app.projects.softDelete(ctx, project.id);
    expect((await h.app.projects.list(ctx)).map((p) => p.id)).not.toContain(project.id);
    await expect(h.app.projects.get(ctx, project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    const row = await h.prisma.project.findUnique({ where: { id: project.id } });
    expect(row?.deletedAt).not.toBeNull(); // soft, not hard, deletion
  });
});

describe('workspace isolation and authorization', () => {
  it("does not reveal or allow access to another workspace's project", async () => {
    const a = await signUp(h.app, 'owner');
    const b = await signUp(h.app, 'intruder');
    const project = await h.app.projects.create(a.ctx, { name: 'Private' });
    await h.app.pitches.submit(a.ctx, project.id, { content: PITCH });
    await expect(h.app.projects.get(b.ctx, project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(h.app.pitches.submit(b.ctx, project.id, { content: PITCH })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(h.app.interpretation.interpret(b.ctx, project.id, {})).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(await h.app.projects.list(b.ctx)).toHaveLength(0);
  });

  it("rejects a workspaceId from the browser that the caller does not belong to", async () => {
    const a = await signUp(h.app, 'a');
    const b = await signUp(h.app, 'b');
    await expect(h.app.projects.create(b.ctx, { name: 'Sneaky', workspaceId: a.workspace.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets viewers read but not write, and only managers delete', async () => {
    const owner = await signUp(h.app, 'owner');
    const viewer = await signUp(h.app, 'viewer');
    const editor = await signUp(h.app, 'editor');
    await h.prisma.workspaceMember.create({ data: { workspaceId: owner.workspace.id, userId: viewer.user.id, role: 'VIEWER' } });
    await h.prisma.workspaceMember.create({ data: { workspaceId: owner.workspace.id, userId: editor.user.id, role: 'EDITOR' } });
    const project = await h.app.projects.create(owner.ctx, { name: 'Shared' });
    await h.app.pitches.submit(owner.ctx, project.id, { content: PITCH });

    expect((await h.app.projects.get(viewer.ctx, project.id)).project.id).toBe(project.id);
    await expect(h.app.pitches.submit(viewer.ctx, project.id, { content: PITCH })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.app.projects.create(viewer.ctx, { name: 'X', workspaceId: owner.workspace.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await h.app.pitches.submit(editor.ctx, project.id, { content: `${PITCH} More detail.` });
    await expect(h.app.projects.softDelete(editor.ctx, project.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('idea interpretation', () => {
  it('interprets the latest pitch, stores the result separately and records usage and audit', async () => {
    const { ctx, workspace } = await signUp(h.app);
    const project = await h.app.projects.create(ctx, { name: 'Interpret me' });
    const pitch = await h.app.pitches.submit(ctx, project.id, { content: PITCH });
    const record = await h.app.interpretation.interpret(ctx, project.id, {});
    expect(record).toMatchObject({ pitchId: pitch.id, promptId: 'IDEA_INTERPRETER', promptVersion: 1, provider: 'mock' });
    expect(record.output.inferredRequirements.every((r) => r.origin === 'AI_INFERRED')).toBe(true);

    expect((await h.repos.pitches.findById(pitch.id))!.content).toBe(PITCH); // pitch untouched
    expect((await h.app.interpretation.getLatest(ctx, project.id)).id).toBe(record.id);

    const usage = await h.prisma.usageEvent.findMany({ where: { projectId: project.id } });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ capability: 'IdeaInterpreter', success: true, workspaceId: workspace.id });
    const audit = await h.prisma.auditLog.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['project.created', 'pitch.submitted', 'idea.interpreted']));
  });

  it('requires a pitch first and a pitch that belongs to the project', async () => {
    const { ctx } = await signUp(h.app);
    const p1 = await h.app.projects.create(ctx, { name: 'One' });
    const p2 = await h.app.projects.create(ctx, { name: 'Two' });
    await expect(h.app.interpretation.interpret(ctx, p1.id, {})).rejects.toMatchObject({ code: 'NO_PITCH' });
    const other = await h.app.pitches.submit(ctx, p2.id, { content: PITCH });
    await expect(h.app.interpretation.interpret(ctx, p1.id, { pitchId: other.id })).rejects.toMatchObject({ code: 'PITCH_NOT_FOUND' });
    await expect(h.app.interpretation.getLatest(ctx, p1.id)).rejects.toMatchObject({ code: 'INTERPRETATION_NOT_FOUND' });
  });
});

describe('invalid AI output', () => {
  it('returns a controlled error and persists nothing when the model keeps returning malformed output', async () => {
    const bad = makeApp({ script: ['I think the idea is great!', '{"summary": "still wrong"}'] });
    try {
      const { ctx } = await signUp(bad.app);
      const project = await bad.app.projects.create(ctx, { name: 'Bad AI' });
      await bad.app.pitches.submit(ctx, project.id, { content: PITCH });
      await expect(bad.app.interpretation.interpret(ctx, project.id, {})).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
      expect(await bad.prisma.ideaInterpretation.count({ where: { projectId: project.id } })).toBe(0);
      expect(bad.usage.filter((u) => u.success)).toHaveLength(2); // both attempts were metered
    } finally { await bad.prisma.$disconnect(); }
  });

  it('persists the repaired result when the second attempt is valid', async () => {
    const good = JSON.stringify(heuristicInterpretation(PITCH));
    const repaired = makeApp({ script: ['not json at all', good] });
    try {
      const { ctx } = await signUp(repaired.app);
      const project = await repaired.app.projects.create(ctx, { name: 'Repair' });
      await repaired.app.pitches.submit(ctx, project.id, { content: PITCH });
      const record = await repaired.app.interpretation.interpret(ctx, project.id, {});
      expect(record.output.summary).toBeTruthy();
      expect(await repaired.prisma.ideaInterpretation.count({ where: { projectId: project.id } })).toBe(1);
    } finally { await repaired.prisma.$disconnect(); }
  });

  it('does not store a "USER_STATED" claim the pitch never made', async () => {
    const fabricated = JSON.stringify({
      ...heuristicInterpretation(PITCH),
      targetUsers: [{ text: 'Government agencies', origin: 'USER_STATED', evidence: 'government agencies' }],
    });
    const h2 = makeApp({ script: [fabricated] });
    try {
      const { ctx } = await signUp(h2.app);
      const project = await h2.app.projects.create(ctx, { name: 'Fabrication' });
      await h2.app.pitches.submit(ctx, project.id, { content: PITCH });
      await expect(h2.app.interpretation.interpret(ctx, project.id, {})).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
      expect(await h2.prisma.ideaInterpretation.count({ where: { projectId: project.id } })).toBe(0);
    } finally { await h2.prisma.$disconnect(); }
  });
});
