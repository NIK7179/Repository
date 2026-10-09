import type { ConversationRecord, ImplementationRepositories, ImplRunRecord, MessageRecord, PhaseRecord, PlanVersionRecord, ProgressEventRecord, TaskRecord, ValidationRecord } from '@pitch2plan/domain';
import { phaseStatus, referenceSchema, taskStatusSchema, type AssistantMessageContent, type ConversationScope } from '@pitch2plan/schemas';
import { z } from 'zod';
import type { PrismaClient } from './client';
import type { Prisma } from './generated/client';

const isUnique = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
const json = (v: unknown) => v as Prisma.InputJsonValue;
const strings = z.array(z.string());
const problems = z.array(z.object({ problem: z.string(), resolution: z.string() }));
const taskStatus = (s: string) => taskStatusSchema.parse(s);

const taskInclude = {
  phase: { select: { key: true, sequence: true } }, steps: { orderBy: { sequence: 'asc' as const } }, validations: { orderBy: { position: 'asc' as const } },
  dependencies: { include: { dependsOn: { select: { key: true } } } }, componentLinks: true, decisionLinks: { include: { decision: { select: { key: true } } } }, requirementLinks: true,
} as const;
type TaskRow = Prisma.ImplementationTaskGetPayload<{ include: typeof taskInclude }>;
const toTask = (t: TaskRow): TaskRecord => ({
  id: t.id, planVersionId: t.planVersionId, phaseId: t.phaseId, phaseKey: t.phase.key, phaseSequence: t.phase.sequence, key: t.key, sequence: t.sequence, title: t.title, objective: t.objective,
  description: t.description, whyThisTask: t.whyThisTask, taskType: t.taskType, complexity: t.complexity, effort: t.effort, status: taskStatus(t.status), prerequisites: strings.parse(t.prerequisites),
  instructions: t.instructions, expectedOutcome: t.expectedOutcome, validationSteps: strings.parse(t.validationSteps), commonProblems: problems.parse(t.commonProblems), securityNotes: strings.parse(t.securityNotes),
  operationalNotes: strings.parse(t.operationalNotes), references: z.array(referenceSchema).parse(t.references), createdAt: t.createdAt, updatedAt: t.updatedAt,
  steps: t.steps.map((s) => ({ id: s.id, sequence: s.sequence, title: s.title, instruction: s.instruction, expectedResult: s.expectedResult, validation: s.validation, status: s.status === 'COMPLETED' ? 'COMPLETED' as const : 'NOT_STARTED' as const, completedAt: s.completedAt })),
  dependsOn: t.dependencies.map((d) => d.dependsOn.key).sort(), componentKeys: t.componentLinks.map((c) => c.stableKey).sort(), decisionKeys: t.decisionLinks.map((d) => d.decision.key).sort(),
  requirementIds: t.requirementLinks.map((r) => r.requirementId),
  validations: t.validations.map((v): ValidationRecord => ({ id: v.id, position: v.position, label: v.label, confirmed: v.confirmed, confirmationKind: v.confirmationKind as ValidationRecord['confirmationKind'], confirmedById: v.confirmedById, confirmedAt: v.confirmedAt })),
});
const runInclude = { version: { select: { id: true } } } as const;
const toRun = (r: Prisma.ImplementationGenerationRunGetPayload<{ include: typeof runInclude }>): ImplRunRecord => ({
  id: r.id, projectId: r.projectId, architectureVersionId: r.architectureVersionId, status: r.status, currentStage: r.currentStage, attempt: r.attempt, repairCount: r.repairCount, failureCode: r.failureCode,
  failureMessage: r.failureMessage, jobId: r.jobId, requestedById: r.requestedById, createdAt: r.createdAt, startedAt: r.startedAt, heartbeatAt: r.heartbeatAt, finishedAt: r.finishedAt, planVersionId: r.version?.id ?? null,
});
class ProjectNotReady extends Error { constructor() { super('PROJECT_NOT_READY'); } }

export function createImplementationRepositories(prisma: PrismaClient): ImplementationRepositories {
  const getRun = async (id: string) => { const r = await prisma.implementationGenerationRun.findUnique({ where: { id }, include: runInclude }); return r ? toRun(r) : null; };
  const toMessage = (m: Prisma.MessageGetPayload<object>): MessageRecord => ({
    id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, status: m.status === 'FAILED' ? 'FAILED' : 'COMPLETE', structured: (m.structured as AssistantMessageContent | null) ?? null,
    contextRefs: (m.contextRefs as MessageRecord['contextRefs']) ?? null, clientMessageId: m.clientMessageId, createdAt: m.createdAt,
  });
  const toConversation = (c: Prisma.ConversationGetPayload<object>): ConversationRecord => ({ id: c.id, projectId: c.projectId, scope: c.scope as ConversationScope, scopeId: c.scopeId, createdById: c.createdById, createdAt: c.createdAt });

  return {
    implementation: {
      async getPlanByProject(projectId) { const p = await prisma.implementationPlan.findUnique({ where: { projectId } }); return p ? { id: p.id, projectId: p.projectId, currentVersionId: p.currentVersionId } : null; },
      async getVersion(id) {
        const v = await prisma.implementationPlanVersion.findUnique({
          where: { id }, include: { plan: { select: { projectId: true } }, phases: { orderBy: { sequence: 'asc' } }, tasks: { orderBy: { sequence: 'asc' }, include: taskInclude }, issues: { orderBy: { createdAt: 'asc' } } },
        });
        if (!v) return null;
        const tasks = v.tasks.map(toTask);
        const phases: PhaseRecord[] = v.phases.map((p) => ({ id: p.id, key: p.key, sequence: p.sequence, name: p.name, objective: p.objective, description: p.description, status: phaseStatus(tasks.filter((t) => t.phaseId === p.id).map((t) => t.status)) }));
        return {
          id: v.id, planId: v.planId, projectId: v.plan.projectId, versionNumber: v.versionNumber, architectureVersionId: v.architectureVersionId, generationRunId: v.generationRunId, summary: v.summary,
          componentCoverage: z.array(z.object({ stableKey: z.string(), reason: z.string() })).parse(v.componentCoverage), ai: (v.ai ?? {}) as Record<string, unknown>, createdAt: v.createdAt, phases, tasks,
          issues: v.issues.map((i) => ({ id: i.id, stage: i.stage, source: i.source as 'STRUCTURAL', severity: i.severity as 'HIGH', category: i.category as 'OTHER', code: i.code, description: i.description, taskKeys: strings.parse(i.taskKeys), componentKeys: strings.parse(i.componentKeys), decisionKeys: strings.parse(i.decisionKeys), recommendation: i.recommendation })),
        } satisfies PlanVersionRecord;
      },
      async getTask(taskId) {
        const t = await prisma.implementationTask.findUnique({ where: { id: taskId }, include: { ...taskInclude, planVersion: { select: { plan: { select: { projectId: true } } } }, progressEvents: { orderBy: { createdAt: 'asc' } } } });
        if (!t) return null;
        const events: ProgressEventRecord[] = t.progressEvents.map((e) => ({ id: e.id, fromStatus: taskStatus(e.fromStatus), toStatus: taskStatus(e.toStatus), reason: e.reason, actorId: e.actorId, createdAt: e.createdAt }));
        return { ...toTask(t), projectId: t.planVersion.plan.projectId, events };
      },
      async taskIdsDependingOn(taskId) { return (await prisma.taskDependency.findMany({ where: { dependsOnTaskId: taskId }, select: { taskId: true } })).map((d) => d.taskId); },

      async startGeneration({ projectId, architectureVersionId, userId }) {
        try {
          return await prisma.$transaction(async (tx) => {
            const project = await tx.project.findFirst({ where: { id: projectId, status: 'ARCHITECTURE_READY', deletedAt: null }, select: { id: true } });
            if (!project) return null;
            if (await tx.implementationPlanVersion.findUnique({ where: { architectureVersionId } })) return null; // one plan per architecture version
            const run = await tx.implementationGenerationRun.create({ data: { projectId, architectureVersionId, requestedById: userId }, include: runInclude });
            return toRun(run);
          });
        } catch (e) { if (isUnique(e)) return null; throw e; } // the partial unique index: another run is already active
      },
      async attachJob(runId, jobId) { await prisma.implementationGenerationRun.update({ where: { id: runId }, data: { jobId } }); },
      getRun,
      async getRunByJobId(jobId) { const r = await prisma.implementationGenerationRun.findUnique({ where: { jobId }, include: runInclude }); return r ? toRun(r) : null; },
      async getLatestRun(projectId) { const r = await prisma.implementationGenerationRun.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' }, include: runInclude }); return r ? toRun(r) : null; },
      async claimRun(runId, staleBefore) {
        const now = new Date();
        const r = await prisma.implementationGenerationRun.updateMany({
          where: { id: runId, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', heartbeatAt: { lt: staleBefore } }] },
          data: { status: 'RUNNING', attempt: { increment: 1 }, startedAt: now, heartbeatAt: now, currentStage: 'LOADING_ARCHITECTURE' },
        });
        return r.count === 1 ? getRun(runId) : null;
      },
      async touchRun(runId, patch) { await prisma.implementationGenerationRun.updateMany({ where: { id: runId, status: 'RUNNING' }, data: { ...patch, heartbeatAt: new Date() } }); },

      async finalize(input) {
        try {
          return await prisma.$transaction(async (tx) => {
            const claimed = await tx.implementationGenerationRun.updateMany({ where: { id: input.runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'SUCCEEDED', finishedAt: new Date(), currentStage: 'COMPLETE', ai: json(input.ai) } });
            if (claimed.count !== 1) {
              const existing = await tx.implementationPlanVersion.findUnique({ where: { generationRunId: input.runId } });
              if (existing) return { planVersionId: existing.id, created: false };
              throw new Error(`Run ${input.runId} is already finished without a plan`);
            }
            // The plan must be built for the CURRENT, READY architecture version of a project that is still ARCHITECTURE_READY.
            const arch = await tx.architecture.findUnique({ where: { projectId: input.projectId } });
            const archVersion = await tx.architectureVersion.findUnique({ where: { id: input.architectureVersionId } });
            const project = await tx.project.findFirst({ where: { id: input.projectId, status: 'ARCHITECTURE_READY', deletedAt: null } });
            if (!arch || arch.currentVersionId !== input.architectureVersionId || archVersion?.status !== 'READY' || !project) throw new ProjectNotReady();

            const plan = await tx.implementationPlan.upsert({ where: { projectId: input.projectId }, create: { projectId: input.projectId }, update: {} });
            const last = await tx.implementationPlanVersion.findFirst({ where: { planId: plan.id }, orderBy: { versionNumber: 'desc' } });
            const v = await tx.implementationPlanVersion.create({
              data: { planId: plan.id, versionNumber: (last?.versionNumber ?? 0) + 1, architectureVersionId: input.architectureVersionId, generationRunId: input.runId, summary: input.plan.summary, componentCoverage: json(input.plan.componentCoverage), ai: json(input.ai) },
            });
            const phaseIds = new Map<string, string>();
            for (const [i, p] of input.plan.phases.entries()) phaseIds.set(p.key, (await tx.implementationPhase.create({ data: { planVersionId: v.id, key: p.key, sequence: i, name: p.name, objective: p.objective, description: p.description } })).id);
            // Task order = phase order, then the planner's order within a phase.
            const ordered = [...input.plan.tasks].sort((a, b) => input.plan.phases.findIndex((p) => p.key === a.phaseKey) - input.plan.phases.findIndex((p) => p.key === b.phaseKey));
            const taskIds = new Map<string, string>();
            for (const [i, t] of ordered.entries()) {
              const row = await tx.implementationTask.create({ data: {
                planVersionId: v.id, phaseId: phaseIds.get(t.phaseKey)!, key: t.key, sequence: i, title: t.title, objective: t.objective, description: t.description, whyThisTask: t.whyThisTask, taskType: t.taskType,
                complexity: t.complexity, effort: t.effort, prerequisites: json(t.prerequisites), instructions: t.instructions, expectedOutcome: t.expectedOutcome, validationSteps: json(t.validationSteps),
                commonProblems: json(t.commonProblems), securityNotes: json(t.securityNotes), operationalNotes: json(t.operationalNotes), references: json(t.references),
                steps: { create: t.steps.map((s, n) => ({ sequence: n, title: s.title, instruction: s.instruction, expectedResult: s.expectedResult, validation: s.validation })) },
                validations: { create: t.validationSteps.map((label, position) => ({ position, label })) },
                componentLinks: { create: [...new Set(t.componentKeys)].map((stableKey) => ({ architectureVersionId: input.architectureVersionId, stableKey })) },
                decisionLinks: { create: [...new Set(t.decisionKeys)].map((k) => ({ decisionId: input.decisionIdByKey[k]! })) },
                requirementLinks: { create: [...new Set(t.requirementCodes)].map((c) => ({ requirementId: input.requirementIdByCode[c]! })) },
              } });
              taskIds.set(t.key, row.id);
            }
            const deps = input.plan.tasks.flatMap((t) => [...new Set(t.dependsOn)].map((d) => ({ taskId: taskIds.get(t.key)!, dependsOnTaskId: taskIds.get(d)! })));
            if (deps.length) await tx.taskDependency.createMany({ data: deps });
            if (input.issues.length) await tx.implementationGenerationIssue.createMany({ data: input.issues.map((i) => ({ runId: input.runId, planVersionId: v.id, stage: i.stage, source: i.source, severity: i.severity, category: i.category, code: i.code, description: i.description, taskKeys: json(i.taskKeys), componentKeys: json(i.componentKeys), decisionKeys: json(i.decisionKeys), recommendation: i.recommendation })) });
            await tx.implementationPlan.update({ where: { id: plan.id }, data: { currentVersionId: v.id } });
            return { planVersionId: v.id, created: true };
          }, { timeout: 60_000, maxWait: 10_000 });
        } catch (e) {
          if (e instanceof ProjectNotReady) throw Object.assign(new Error('The project or architecture changed during generation'), { code: 'PROJECT_STATE_CHANGED' });
          if (isUnique(e)) { const existing = await prisma.implementationPlanVersion.findUnique({ where: { generationRunId: input.runId } }); if (existing) return { planVersionId: existing.id, created: false }; }
          throw e;
        }
      },
      async failRun({ runId, code, message, issues }) {
        return prisma.$transaction(async (tx) => {
          const failed = await tx.implementationGenerationRun.updateMany({ where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', failureCode: code, failureMessage: message, finishedAt: new Date(), currentStage: 'FAILED' } });
          if (failed.count === 1 && issues?.length) await tx.implementationGenerationIssue.createMany({ data: issues.map((i) => ({ runId, stage: i.stage, source: i.source, severity: i.severity, category: i.category, code: i.code, description: i.description, taskKeys: json(i.taskKeys), componentKeys: json(i.componentKeys), decisionKeys: json(i.decisionKeys), recommendation: i.recommendation })) });
          return { failed: failed.count === 1 };
        });
      },
      async listStaleRuns(before) {
        const rows = await prisma.implementationGenerationRun.findMany({ where: { status: { in: ['QUEUED', 'RUNNING'] }, OR: [{ heartbeatAt: { lt: before } }, { heartbeatAt: null, createdAt: { lt: before } }] }, include: runInclude });
        return rows.map(toRun);
      },

      async updateTaskStatus({ taskId, from, to, userId, reason }) {
        return prisma.$transaction(async (tx) => {
          const moved = await tx.implementationTask.updateMany({ where: { id: taskId, status: from }, data: { status: to } });
          if (moved.count !== 1) return { ok: false, projectStarted: false };
          await tx.taskProgressEvent.create({ data: { taskId, fromStatus: from, toStatus: to, reason: reason?.slice(0, 500) ?? null, actorId: userId } });
          const task = await tx.implementationTask.findUniqueOrThrow({ where: { id: taskId }, include: { planVersion: { select: { plan: { select: { projectId: true } } } } } });
          const siblings = await tx.implementationTask.findMany({ where: { phaseId: task.phaseId }, select: { status: true } });
          await tx.implementationPhase.update({ where: { id: task.phaseId }, data: { status: phaseStatus(siblings.map((s) => taskStatus(s.status))) } });
          let projectStarted = false;
          if (to === 'IN_PROGRESS') {
            const p = await tx.project.updateMany({ where: { id: task.planVersion.plan.projectId, status: 'ARCHITECTURE_READY' }, data: { status: 'IMPLEMENTING' } });
            projectStarted = p.count === 1;
          }
          return { ok: true, projectStarted };
        });
      },
      async updateStepStatus({ taskId, stepId, status }) {
        const r = await prisma.taskStep.updateMany({ where: { id: stepId, taskId }, data: { status, completedAt: status === 'COMPLETED' ? new Date() : null } });
        return r.count === 1;
      },
      async setValidations({ taskId, userId, confirmations }) {
        await prisma.$transaction(async (tx) => {
          for (const c of confirmations) {
            await tx.taskValidation.updateMany({ where: { taskId, position: c.position }, data: c.confirmed
              ? { confirmed: true, confirmationKind: 'USER_CONFIRMED', confirmedById: userId, confirmedAt: new Date() }
              : { confirmed: false, confirmationKind: null, confirmedById: null, confirmedAt: null } });
          }
        });
        const rows = await prisma.taskValidation.findMany({ where: { taskId }, orderBy: { position: 'asc' } });
        return rows.map((v): ValidationRecord => ({ id: v.id, position: v.position, label: v.label, confirmed: v.confirmed, confirmationKind: v.confirmationKind as ValidationRecord['confirmationKind'], confirmedById: v.confirmedById, confirmedAt: v.confirmedAt }));
      },
    },

    conversations: {
      async getOrCreate({ projectId, scope, scopeId, userId }) {
        const where = { projectId, scope, scopeId, createdById: userId };
        const existing = await prisma.conversation.findFirst({ where });
        if (existing) return toConversation(existing);
        try { return toConversation(await prisma.conversation.create({ data: where })); }
        catch (e) { if (isUnique(e)) return toConversation(await prisma.conversation.findFirstOrThrow({ where })); throw e; }
      },
      async get(id) { const c = await prisma.conversation.findUnique({ where: { id } }); return c ? toConversation(c) : null; },
      async find({ projectId, scope, scopeId, userId }) { const c = await prisma.conversation.findFirst({ where: { projectId, scope, scopeId, createdById: userId } }); return c ? toConversation(c) : null; },
      async findMessageByClientId(conversationId, clientMessageId) { const m = await prisma.message.findUnique({ where: { conversationId_clientMessageId: { conversationId, clientMessageId } } }); return m ? toMessage(m) : null; },
      async addMessage({ conversationId, role, content, status, structured, contextRefs, clientMessageId, userId }) {
        try {
          const m = await prisma.message.create({ data: { conversationId, role, content, status: status ?? 'COMPLETE', structured: structured ? json(structured) : undefined, contextRefs: contextRefs ? json(contextRefs) : undefined, clientMessageId, createdById: userId } });
          await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
          return toMessage(m);
        } catch (e) {
          if (isUnique(e) && clientMessageId) return toMessage(await prisma.message.findUniqueOrThrow({ where: { conversationId_clientMessageId: { conversationId, clientMessageId } } }));
          throw e;
        }
      },
      async list(conversationId, limit) { return (await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take: limit })).reverse().map(toMessage); },
    },
  };
}
