import type {
  ExternalIdentity, InterpretationRecord, PitchRecord, ProjectRecord, Repositories, UserRecord, WorkspaceRecord,
} from '@pitch2plan/domain';
import { ideaInterpretationSchema } from '@pitch2plan/schemas';
import type { PrismaClient } from './client';
import { createArchitectureRepositories } from './repositories-architecture';
import { createDiscoveryRepositories } from './repositories-discovery';
import type { Prisma } from './generated/client';

const isUniqueViolation = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';

const toUser = (u: { id: string; externalId: string; email: string; name: string | null }): UserRecord =>
  ({ id: u.id, externalId: u.externalId, email: u.email, name: u.name });
const toWorkspace = (w: { id: string; name: string; isPersonal: boolean }): WorkspaceRecord =>
  ({ id: w.id, name: w.name, isPersonal: w.isPersonal });

/** The only place Prisma queries live. Everything above this layer talks to the ports. */
export function createRepositories(prisma: PrismaClient): Repositories {
  async function provision(identity: ExternalIdentity, retry = true): Promise<{ user: UserRecord; workspace: WorkspaceRecord; created: boolean }> {
    const personal = async (userId: string) => {
      const m = await prisma.workspaceMember.findFirst({
        where: { userId, role: 'OWNER', workspace: { isPersonal: true } }, include: { workspace: true }, orderBy: { createdAt: 'asc' },
      });
      if (!m) throw new Error(`User ${userId} has no personal workspace`);
      return toWorkspace(m.workspace);
    };
    const existing = await prisma.user.findUnique({ where: { externalId: identity.externalId } });
    if (existing) return { user: toUser(existing), workspace: await personal(existing.id), created: false };
    try {
      return await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { externalId: identity.externalId, email: identity.email, name: identity.name ?? null } });
        const label = identity.name?.trim() || identity.email.split('@')[0];
        const ws = await tx.workspace.create({
          data: { name: `${label}'s workspace`, isPersonal: true, members: { create: { userId: user.id, role: 'OWNER' } } },
        });
        return { user: toUser(user), workspace: toWorkspace(ws), created: true };
      });
    } catch (e) {
      if (retry && isUniqueViolation(e)) return provision(identity, false); // concurrent first login
      throw e;
    }
  }

  const toProject = (p: ProjectRecord): ProjectRecord => p;
  const toPitch = (p: PitchRecord): PitchRecord => p;

  return {
    ...createDiscoveryRepositories(prisma),
    ...createArchitectureRepositories(prisma),
    users: {
      async findById(id) {
        const u = await prisma.user.findUnique({ where: { id } });
        return u ? toUser(u) : null;
      },
      provision,
    },
    workspaces: {
      async getMembership(userId, workspaceId) {
        const m = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
        return m ? { workspaceId: m.workspaceId, userId: m.userId, role: m.role } : null;
      },
      async listMemberships(userId) {
        const rows = await prisma.workspaceMember.findMany({ where: { userId }, include: { workspace: true }, orderBy: { createdAt: 'asc' } });
        return rows.map((m) => ({ workspaceId: m.workspaceId, userId: m.userId, role: m.role, workspace: toWorkspace(m.workspace) }));
      },
    },
    projects: {
      create: async (input) => toProject(await prisma.project.create({ data: input })),
      listForWorkspaces: async (workspaceIds) =>
        (await prisma.project.findMany({ where: { workspaceId: { in: workspaceIds }, deletedAt: null }, orderBy: { updatedAt: 'desc' } })).map(toProject),
      findById: async (id) => {
        const p = await prisma.project.findFirst({ where: { id, deletedAt: null } });
        return p ? toProject(p) : null;
      },
      touch: async (id) => { await prisma.project.update({ where: { id }, data: { updatedAt: new Date() } }); },
      setStatus: async (id, status) => { await prisma.project.update({ where: { id }, data: { status } }); },
      transitionStatus: async (id, from, to) => (await prisma.project.updateMany({ where: { id, status: from, deletedAt: null }, data: { status: to } })).count === 1,
      softDelete: async (id) => { await prisma.project.update({ where: { id }, data: { deletedAt: new Date() } }); },
    },
    pitches: {
      async append({ projectId, authorId, content, technicalLevel }) {
        for (let attempt = 0; ; attempt++) {
          const last = await prisma.ideaPitch.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, select: { version: true } });
          try {
            return toPitch(await prisma.ideaPitch.create({
              data: { projectId, authorId, content, technicalLevel: technicalLevel ?? null, version: (last?.version ?? 0) + 1 },
            }));
          } catch (e) {
            if (!isUniqueViolation(e) || attempt >= 3) throw e; // lost a version race; recompute
          }
        }
      },
      latest: async (projectId) => {
        const p = await prisma.ideaPitch.findFirst({ where: { projectId }, orderBy: { version: 'desc' } });
        return p ? toPitch(p) : null;
      },
      findById: async (id) => {
        const p = await prisma.ideaPitch.findUnique({ where: { id } });
        return p ? toPitch(p) : null;
      },
    },
    interpretations: {
      async create(input) {
        const row = await prisma.ideaInterpretation.create({ data: { ...input, output: input.output as unknown as Prisma.InputJsonValue } });
        return { ...row, output: ideaInterpretationSchema.parse(row.output) } satisfies InterpretationRecord;
      },
      async latest(projectId) {
        const row = await prisma.ideaInterpretation.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
        // Re-validate on read: stored JSON is data, not trusted structure.
        return row ? { ...row, output: ideaInterpretationSchema.parse(row.output) } : null;
      },
    },
    usage: { record: async (e) => { await prisma.usageEvent.create({ data: e }); } },
    audit: {
      record: async (e) => {
        await prisma.auditLog.create({ data: { ...e, metadata: (e.metadata ?? undefined) as Prisma.InputJsonValue | undefined } });
      },
    },
  };
}
