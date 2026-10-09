import type {
  AnalyticsEventInput, BriefVersionRecord, ConflictRecord, DiscoveryRepositories, DriverRecord, RequirementRecord, RoundRecord, SessionRecord,
} from '@pitch2plan/domain';
import {
  advancedValuesSchema, answerChoiceSchema, architectureBriefSchema, discoveryQuestionSchema, requirementCategorySchema, type DiscoveryUnknown,
} from '@pitch2plan/schemas';
import { z } from 'zod';
import type { PrismaClient } from './client';
import type { Prisma } from './generated/client';

const isUnique = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
const json = (v: unknown) => v as Prisma.InputJsonValue;

// Stored JSON is data, not trusted structure: every read goes back through a schema.
const unknownsSchema = z.array(z.object({ id: z.string(), text: z.string(), status: z.enum(['OPEN', 'RESOLVED', 'ACCEPTED']), critical: z.boolean() }));
const aiSchema = z.object({
  promptId: z.string(), promptVersion: z.number(), provider: z.string(), model: z.string(),
  inputTokens: z.number().optional(), outputTokens: z.number().optional(), repaired: z.boolean().default(false),
});
const stringArray = z.array(z.string());

type SessionRow = { id: string; projectId: string; status: 'ACTIVE' | 'READY_FOR_BRIEF'; unknowns: unknown; finishReason: string | null; createdAt: Date; updatedAt: Date };
const toSession = (s: SessionRow): SessionRecord => ({ ...s, unknowns: unknownsSchema.parse(s.unknowns) as DiscoveryUnknown[] });

const roundInclude = {
  questions: { orderBy: { position: 'asc' as const }, include: { options: { orderBy: { position: 'asc' as const } }, answer: true } },
};
type RoundRow = Prisma.DiscoveryRoundGetPayload<{ include: typeof roundInclude }>;
const toRound = (r: RoundRow): RoundRecord => ({
  id: r.id, sessionId: r.sessionId, number: r.number, kind: r.kind as RoundRecord['kind'], status: r.status,
  reasonForAnotherRound: r.reasonForAnotherRound, canGenerateBrief: r.canGenerateBrief, ai: aiSchema.parse(r.ai), createdAt: r.createdAt, completedAt: r.completedAt,
  questions: r.questions.map((q) => ({
    ...discoveryQuestionSchema.parse({
      id: q.key, category: q.category, question: q.question, whyItMatters: q.whyItMatters, answerType: q.answerType, required: q.required, priority: q.priority,
      allowRecommendation: q.allowRecommendation, relatedUnknowns: q.relatedUnknowns, numberRange: q.numberRange ?? undefined, advanced: q.advanced ?? undefined,
      options: q.options.map((o) => ({ id: o.key, label: o.label, description: o.description })),
    }),
    answer: q.answer ? {
      choice: answerChoiceSchema.parse(q.answer.choice), advanced: q.answer.advanced ? advancedValuesSchema.parse(q.answer.advanced) : null,
      resolvedValue: q.answer.resolvedValue, recommendationReason: q.answer.recommendationReason, createdAt: q.answer.createdAt,
    } : null,
  })),
});

const reqInclude = { versions: { orderBy: { version: 'desc' as const }, take: 1 } };
type ReqRow = Prisma.RequirementGetPayload<{ include: typeof reqInclude }>;
const toRequirement = (r: ReqRow): RequirementRecord => {
  const v = r.versions[0]!;
  return {
    id: r.id, projectId: r.projectId, key: r.key, category: requirementCategorySchema.parse(r.category), status: r.status, version: v.version,
    statement: v.statement, value: v.value, origin: v.origin, source: v.source, confidence: v.confidence, tags: stringArray.parse(v.tags),
    previousStatement: v.previousStatement, updatedAt: v.createdAt, createdAt: r.createdAt,
  };
};

const toConflict = (c: Prisma.DiscoveryConflictGetPayload<object>): ConflictRecord => ({
  id: c.id, projectId: c.projectId, fingerprint: c.fingerprint, detectedBy: c.detectedBy as 'RULE' | 'AI', ruleId: c.ruleId, severity: c.severity, title: c.title,
  description: c.description, requirementIds: stringArray.parse(c.requirementIds), status: c.status,
  resolution: (c.resolution as Record<string, unknown> | null) ?? null, createdAt: c.createdAt, resolvedAt: c.resolvedAt,
});

type BriefVersionRow = Prisma.ArchitectureBriefVersionGetPayload<{ include: { brief: { select: { projectId: true } } } }>;
const toBriefVersion = (v: BriefVersionRow): BriefVersionRecord => ({
  id: v.id, briefId: v.briefId, projectId: v.brief.projectId, version: v.version, content: architectureBriefSchema.parse(v.content),
  requirementsFingerprint: v.requirementsFingerprint, ai: aiSchema.parse(v.ai), createdById: v.createdById, createdAt: v.createdAt,
  confirmedAt: v.confirmedAt, confirmedById: v.confirmedById, acceptedUnknownIds: v.acceptedUnknownIds ? stringArray.parse(v.acceptedUnknownIds) : null,
});
const briefVersionInclude = { brief: { select: { projectId: true } } } as const;

export function createDiscoveryRepositories(prisma: PrismaClient): DiscoveryRepositories {
  const nextUnknownNumber = (unknowns: DiscoveryUnknown[]) => unknowns.reduce((m, u) => Math.max(m, Number(/^U(\d+)$/.exec(u.id)?.[1] ?? 0)), 0) + 1;

  return {
    discovery: {
      async getSession(projectId) {
        const s = await prisma.discoverySession.findUnique({ where: { projectId } });
        return s ? toSession(s) : null;
      },
      async createSession({ projectId, unknowns, seed }) {
        const existing = await prisma.discoverySession.findUnique({ where: { projectId } });
        if (existing) return { session: toSession(existing), created: false };
        try {
          const session = await prisma.$transaction(async (tx) => {
            const s = await tx.discoverySession.create({ data: { projectId, unknowns: json(unknowns) } });
            for (const r of seed) {
              await tx.requirement.create({
                data: {
                  projectId, key: r.key, category: r.category,
                  versions: { create: { version: 1, statement: r.statement, origin: r.origin, source: r.origin, confidence: r.confidence, tags: json(r.tags),
                    sources: { create: [{ kind: r.sourceKind, quote: r.quote ?? null }] } } },
                },
              });
            }
            return s;
          });
          return { session: toSession(session), created: true };
        } catch (e) {
          if (!isUnique(e)) throw e;
          return { session: toSession((await prisma.discoverySession.findUniqueOrThrow({ where: { projectId } }))), created: false };
        }
      },
      async updateSession(id, patch) {
        await prisma.discoverySession.update({
          where: { id },
          data: { status: patch.status, finishReason: patch.finishReason, ...(patch.unknowns ? { unknowns: json(patch.unknowns) } : {}) },
        });
      },
      async createRound(input) {
        for (let attempt = 0; ; attempt++) {
          const last = await prisma.discoveryRound.findFirst({ where: { sessionId: input.sessionId }, orderBy: { number: 'desc' }, select: { number: true } });
          try {
            const row = await prisma.discoveryRound.create({
              data: {
                sessionId: input.sessionId, number: (last?.number ?? 0) + 1, kind: input.kind, reasonForAnotherRound: input.reasonForAnotherRound,
                canGenerateBrief: input.canGenerateBrief, ai: json(input.ai),
                questions: { create: input.questions.map((q, i) => ({
                  sessionId: input.sessionId, key: q.id, category: q.category, question: q.question, whyItMatters: q.whyItMatters, answerType: q.answerType,
                  required: q.required, priority: q.priority, allowRecommendation: q.allowRecommendation, relatedUnknowns: json(q.relatedUnknowns),
                  numberRange: q.numberRange ? json(q.numberRange) : undefined, advanced: q.advanced ? json(q.advanced) : undefined, position: i,
                  options: { create: q.options.map((o, j) => ({ key: o.id, label: o.label, description: o.description, position: j })) },
                })) },
              },
              include: roundInclude,
            });
            return toRound(row);
          } catch (e) { if (!isUnique(e) || attempt >= 2) throw e; }
        }
      },
      async listRounds(sessionId) {
        return (await prisma.discoveryRound.findMany({ where: { sessionId }, orderBy: { number: 'asc' }, include: roundInclude })).map(toRound);
      },
      async saveAnswers({ roundId, userId, answers }) {
        await prisma.$transaction(async (tx) => {
          const questions = await tx.discoveryQuestion.findMany({ where: { roundId }, select: { id: true, key: true } });
          const idByKey = new Map(questions.map((q) => [q.key, q.id]));
          await tx.discoveryAnswer.deleteMany({ where: { questionId: { in: questions.map((q) => q.id) } } });
          const rows = answers.filter((a) => a.choice.kind !== 'SKIP').map((a) => ({
            questionId: idByKey.get(a.questionId)!, choice: json(a.choice), advanced: a.advanced ? json(a.advanced) : undefined, answeredById: userId,
          }));
          if (rows.length) await tx.discoveryAnswer.createMany({ data: rows });
          await tx.discoveryRound.update({ where: { id: roundId }, data: { status: 'ANSWERED' } });
        });
      },
      async setRoundStatus(roundId, status) { await prisma.discoveryRound.update({ where: { id: roundId }, data: { status } }); },

      async applyExtraction(input) {
        await prisma.$transaction(async (tx) => {
          const round = await tx.discoveryRound.findUniqueOrThrow({ where: { id: input.roundId } });
          if (round.status === 'COMPLETED') throw new Error('Round already completed');
          const questions = await tx.discoveryQuestion.findMany({ where: { roundId: input.roundId }, select: { id: true, key: true } });
          const idByKey = new Map(questions.map((q) => [q.key, q.id]));
          const sourcesFor = (d: { origin: string; quote?: string; sourceQuestionIds: string[] }) => [
            ...(d.quote ? [{ kind: 'PITCH_QUOTE', quote: d.quote }] : []),
            ...d.sourceQuestionIds.map((k) => ({ kind: d.origin === 'AI_RECOMMENDED' ? 'RECOMMENDATION' : 'ANSWER', questionKey: k })),
          ];
          for (const d of input.newRequirements) {
            await tx.requirement.create({
              data: {
                projectId: input.projectId, key: d.key, category: d.category,
                versions: { create: { version: 1, statement: d.statement, value: d.value, origin: d.origin, source: d.origin, confidence: d.confidence, tags: json(d.tags),
                  roundId: input.roundId, ai: json(input.ai), sources: { create: sourcesFor(d) } } },
              },
            });
          }
          for (const d of input.updatedRequirements) {
            const cur = await tx.requirement.findUniqueOrThrow({ where: { id: d.requirementId }, include: reqInclude });
            if (cur.projectId !== input.projectId || cur.status !== 'ACTIVE') throw new Error('Requirement is not active in this project');
            const prev = cur.versions[0]!;
            await tx.requirementVersion.create({
              data: {
                requirementId: cur.id, version: prev.version + 1, statement: d.statement, value: d.value, origin: d.origin, source: d.origin, confidence: d.confidence,
                tags: json(d.tags), previousStatement: prev.statement, previousValue: prev.value, createdById: input.userId, roundId: input.roundId, ai: json(input.ai),
                sources: { create: sourcesFor(d) },
              },
            });
            await tx.requirement.update({ where: { id: cur.id }, data: { currentVersion: prev.version + 1, category: d.category } });
          }
          for (const r of input.recommendations) {
            const qid = idByKey.get(r.questionKey);
            if (qid) await tx.discoveryAnswer.update({ where: { questionId: qid }, data: { resolvedValue: r.resolvedValue, recommendationReason: r.reason } });
          }
          const session = await tx.discoverySession.findUniqueOrThrow({ where: { id: input.sessionId } });
          let unknowns = unknownsSchema.parse(session.unknowns) as DiscoveryUnknown[];
          const resolved = new Set(input.resolvedUnknownIds);
          unknowns = unknowns.map((u) => (u.status === 'OPEN' && resolved.has(u.id) ? { ...u, status: 'RESOLVED' as const } : u));
          for (const n of input.newUnknowns) unknowns.push({ id: `U${nextUnknownNumber(unknowns)}`, text: n.text, status: 'OPEN', critical: n.critical });
          await tx.discoverySession.update({ where: { id: input.sessionId }, data: { unknowns: json(unknowns) } });
          await tx.discoveryRound.update({ where: { id: input.roundId }, data: { status: 'COMPLETED', completedAt: new Date() } });
        });
      },
    },

    requirements: {
      async list(projectId) {
        return (await prisma.requirement.findMany({ where: { projectId }, include: reqInclude, orderBy: { createdAt: 'asc' } })).map(toRequirement);
      },
      async get(id) {
        const r = await prisma.requirement.findUnique({ where: { id }, include: reqInclude });
        return r ? toRequirement(r) : null;
      },
      async history(id) {
        return (await prisma.requirementVersion.findMany({ where: { requirementId: id }, orderBy: { version: 'asc' } })).map((v) => ({
          version: v.version, statement: v.statement, value: v.value, origin: v.origin, source: v.source, confidence: v.confidence,
          previousStatement: v.previousStatement, previousValue: v.previousValue, createdById: v.createdById, createdAt: v.createdAt,
        }));
      },
      async addEditVersion({ requirementId, statement, value, userId }) {
        return toRequirement(await prisma.$transaction(async (tx) => {
          const cur = await tx.requirement.findUniqueOrThrow({ where: { id: requirementId }, include: reqInclude });
          const prev = cur.versions[0]!;
          // The user has now stated this requirement in their own words, so its origin becomes USER_STATED; the source records the edit.
          // Tags are cleared because they described the previous wording and can no longer be trusted.
          await tx.requirementVersion.create({
            data: {
              requirementId, version: prev.version + 1, statement, value, origin: 'USER_STATED', source: 'USER_EDITED', confidence: null, tags: json([]),
              previousStatement: prev.statement, previousValue: prev.value, createdById: userId, sources: { create: [{ kind: 'USER_EDIT' }] },
            },
          });
          await tx.requirement.update({ where: { id: requirementId }, data: { currentVersion: prev.version + 1 } });
          return tx.requirement.findUniqueOrThrow({ where: { id: requirementId }, include: reqInclude });
        }));
      },
      async setStatus(ids, status) { await prisma.requirement.updateMany({ where: { id: { in: ids } }, data: { status } }); },
    },

    conflicts: {
      async list(projectId) { return (await prisma.discoveryConflict.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } })).map(toConflict); },
      async get(id) { const c = await prisma.discoveryConflict.findUnique({ where: { id } }); return c ? toConflict(c) : null; },
      async createMany(projectId, items) {
        const created: ConflictRecord[] = [];
        for (const c of items) {
          try {
            created.push(toConflict(await prisma.discoveryConflict.create({
              data: { projectId, fingerprint: c.fingerprint, detectedBy: c.detectedBy, ruleId: c.ruleId, severity: c.severity, title: c.title, description: c.description,
                requirementIds: json(c.requirementIds), ai: c.ai ? json(c.ai) : undefined },
            })));
          } catch (e) { if (!isUnique(e)) throw e; }
        }
        return created;
      },
      async resolve({ id, userId, resolution, supersedeRequirementIds }) {
        await prisma.$transaction(async (tx) => {
          await tx.discoveryConflict.update({ where: { id }, data: { status: 'RESOLVED', resolution: json(resolution), resolvedById: userId, resolvedAt: new Date() } });
          if (supersedeRequirementIds.length) await tx.requirement.updateMany({ where: { id: { in: supersedeRequirementIds } }, data: { status: 'SUPERSEDED' } });
        });
      },
    },

    briefs: {
      async getByProject(projectId) {
        const b = await prisma.architectureBrief.findUnique({ where: { projectId } });
        return b ? { id: b.id, projectId: b.projectId, status: b.status, confirmedVersionId: b.confirmedVersionId } : null;
      },
      async latestVersion(projectId) {
        const v = await prisma.architectureBriefVersion.findFirst({ where: { brief: { projectId } }, orderBy: { version: 'desc' }, include: briefVersionInclude });
        return v ? toBriefVersion(v) : null;
      },
      async getVersion(id) {
        const v = await prisma.architectureBriefVersion.findUnique({ where: { id }, include: briefVersionInclude });
        return v ? toBriefVersion(v) : null;
      },
      async listDrivers(briefVersionId): Promise<DriverRecord[]> {
        const rows = await prisma.architectureDriver.findMany({ where: { briefVersionId }, include: { requirements: true } });
        // Natural order: d1, d2 ... d10 (not d1, d10, d2), then drivers added by later requirement changes (chg-*), so appended drivers stay last.
        const rank = (k: string) => { const m = /^d(\d+)$/.exec(k); return m ? ([0, Number(m[1])] as const) : ([1, 0] as const); };
        rows.sort((a, b) => rank(a.key)[0] - rank(b.key)[0] || rank(a.key)[1] - rank(b.key)[1] || a.key.localeCompare(b.key));
        return rows.map((d) => ({ id: d.id, key: d.key, name: d.name, description: d.description, priority: d.priority, requirementIds: d.requirements.map((r) => r.requirementId) }));
      },
      async createVersion({ projectId, content, fingerprint, ai, userId, drivers }) {
        const row = await prisma.$transaction(async (tx) => {
          const brief = await tx.architectureBrief.upsert({ where: { projectId }, create: { projectId }, update: {} });
          const last = await tx.architectureBriefVersion.findFirst({ where: { briefId: brief.id }, orderBy: { version: 'desc' }, select: { version: true } });
          const version = await tx.architectureBriefVersion.create({
            data: { briefId: brief.id, version: (last?.version ?? 0) + 1, content: json(content), requirementsFingerprint: fingerprint, ai: json(ai), createdById: userId },
            include: briefVersionInclude,
          });
          for (const d of drivers) {
            await tx.architectureDriver.create({
              data: { projectId, briefVersionId: version.id, key: d.id, name: d.name, description: d.description, priority: d.priority,
                requirements: { create: [...new Set(d.sourceRequirementIds)].map((requirementId) => ({ requirementId })) } },
            });
          }
          return version;
        });
        return toBriefVersion(row);
      },
      async confirm({ projectId, briefVersionId, userId, acceptedUnknownIds }) {
        return prisma.$transaction(async (tx) => {
          const moved = await tx.project.updateMany({ where: { id: projectId, status: 'DISCOVERY', deletedAt: null }, data: { status: 'REQUIREMENTS_CONFIRMED' } });
          if (moved.count !== 1) return false;
          const v = await tx.architectureBriefVersion.update({ where: { id: briefVersionId }, data: { confirmedAt: new Date(), confirmedById: userId, acceptedUnknownIds: json(acceptedUnknownIds) } });
          await tx.architectureBrief.update({ where: { id: v.briefId }, data: { status: 'CONFIRMED', confirmedVersionId: v.id } });
          const session = await tx.discoverySession.findUnique({ where: { projectId } });
          if (session && acceptedUnknownIds.length) {
            const accepted = new Set(acceptedUnknownIds);
            const unknowns = (unknownsSchema.parse(session.unknowns) as DiscoveryUnknown[]).map((u) => (accepted.has(u.id) ? { ...u, status: 'ACCEPTED' as const } : u));
            await tx.discoverySession.update({ where: { id: session.id }, data: { unknowns: json(unknowns) } });
          }
          return true;
        });
      },
    },

    analytics: {
      async record(e: AnalyticsEventInput) {
        await prisma.analyticsEvent.create({ data: { workspaceId: e.workspaceId, projectId: e.projectId, userId: e.userId, name: e.name, properties: e.properties ? json(e.properties) : undefined } });
      },
    },
  };
}
