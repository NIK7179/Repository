import { requirementsFingerprint, type ChangeRepositories, type MigrationRecord, type ProposalRecord, type ReviewRecord } from '@pitch2plan/domain';
import { changeAnalysisSchema, phaseStatus, requirementChangeSchema, taskStatusSchema, type ArchitectureDiff, type MigItem, type MigrationSummary } from '@pitch2plan/schemas';
import { z } from 'zod';
import type { PrismaClient } from './client';
import { Prisma } from './generated/client';
import { runInclude, toRun } from './repositories-architecture';

const isUnique = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
const json = (v: unknown) => v as Prisma.InputJsonValue;
const strings = z.array(z.string());
const OPEN = ['DRAFT', 'ANALYZING', 'READY_FOR_REVIEW', 'FAILED'];
class ChangeStateChanged extends Error { constructor() { super('PROPOSAL_STATE_CHANGED'); } }

const include = { impactItems: true, approval: true, run: { select: { id: true } }, resultVersion: { select: { id: true } } } as const;
type Row = Prisma.ArchitectureChangeProposalGetPayload<{ include: typeof include }>;
const toProposal = (r: Row): ProposalRecord => ({
  id: r.id, projectId: r.projectId, baseVersionId: r.baseVersionId, source: r.source, requestedChange: r.requestedChange, reason: r.reason, status: r.status as ProposalRecord['status'], changeType: r.changeType, severity: r.severity,
  requiresReconfirmation: r.requiresReconfirmation, requirementChanges: z.array(requirementChangeSchema).parse(r.requirementChanges), analysis: r.analysis ? changeAnalysisSchema.parse(r.analysis) : null,
  analysisAi: (r.analysisAi ?? null) as Record<string, unknown> | null, failureCode: r.failureCode, failureMessage: r.failureMessage, assistantConversationId: r.assistantConversationId, assistantMessageId: r.assistantMessageId,
  reviewFindingId: r.reviewFindingId, rebasedFromId: r.rebasedFromId, briefVersionId: r.briefVersionId, resultVersionId: r.resultVersion?.id ?? null, createdById: r.createdById, createdAt: r.createdAt, updatedAt: r.updatedAt,
  analyzedAt: r.analyzedAt, analysisAttempt: r.analysisAttempt, runId: r.run?.id ?? null,
  impactItems: r.impactItems.map((i) => ({ kind: i.kind as ProposalRecord['impactItems'][number]['kind'], refKey: i.refKey, relation: i.relation as 'DIRECT' | 'POTENTIAL', reason: i.reason, taskId: i.taskId })),
  approval: r.approval ? { decision: r.approval.decision as 'APPROVED' | 'REJECTED', decidedById: r.approval.decidedById, decidedAt: r.approval.decidedAt, architectureVersionId: r.approval.architectureVersionId, confirmedRequirementChanges: r.approval.confirmedRequirementChanges, note: r.approval.note } : null,
});
const reviewInclude = { findings: { orderBy: { id: 'asc' as const } } } as const;
const toReview = (r: Prisma.ArchitectureReviewGetPayload<{ include: typeof reviewInclude }>): ReviewRecord => ({
  id: r.id, projectId: r.projectId, architectureVersionId: r.architectureVersionId, createdById: r.createdById, assessment: r.assessment, ai: (r.ai ?? {}) as Record<string, unknown>, createdAt: r.createdAt,
  findings: r.findings.map((f) => ({ id: f.id, reviewId: f.reviewId, area: f.area as never, severity: f.severity as never, title: f.title, description: f.description, recommendation: f.recommendation, nodeKeys: strings.parse(f.nodeKeys), decisionKeys: strings.parse(f.decisionKeys), requiresArchitectureChange: f.requiresArchitectureChange, suggestedChange: f.suggestedChange, source: f.source as 'DETERMINISTIC' | 'AI' })),
});

export function createChangeRepositories(prisma: PrismaClient): ChangeRepositories {
  const get = async (id: string) => { const r = await prisma.architectureChangeProposal.findUnique({ where: { id }, include }); return r ? toProposal(r) : null; };

  /** Requirement edits and the derived brief version, inside the caller's transaction. Idempotent per proposal. */
  async function applyRequirements(tx: Prisma.TransactionClient, p: { proposalId: string; projectId: string; userId: string }, app: NonNullable<Parameters<ChangeRepositories['changes']['approve']>[0]['requirementApplication']>) {
    const existing = await tx.architectureBriefVersion.findUnique({ where: { sourceProposalId: p.proposalId } });
    if (existing) return existing.id;
    const created: string[] = [];
    for (const op of app.ops) {
      if (op.kind === 'ADD') {
        const row = await tx.requirement.create({ data: { projectId: p.projectId, key: `chg-${p.proposalId.slice(0, 8)}-${created.length + 1}`, category: op.category, status: 'ACTIVE', currentVersion: 1,
          versions: { create: { version: 1, statement: op.statement, value: op.value, origin: 'USER_STATED', source: 'USER_EDITED', confidence: null, tags: json([]), createdById: p.userId, sources: { create: [{ kind: 'USER_EDIT' }] } } } } });
        created.push(row.id);
      } else if (op.kind === 'MODIFY') {
        const cur = await tx.requirement.findUniqueOrThrow({ where: { id: op.requirementId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } }); const prev = cur.versions[0]!;
        await tx.requirementVersion.create({ data: { requirementId: op.requirementId, version: prev.version + 1, statement: op.statement, value: op.value, origin: 'USER_STATED', source: 'USER_EDITED', confidence: null, tags: json([]), previousStatement: prev.statement, previousValue: prev.value, createdById: p.userId, sources: { create: [{ kind: 'USER_EDIT' }] } } });
        await tx.requirement.update({ where: { id: op.requirementId }, data: { currentVersion: prev.version + 1 } });
      } else await tx.requirement.updateMany({ where: { id: op.requirementId, projectId: p.projectId }, data: { status: 'SUPERSEDED' } });
    }
    const sub = <T,>(v: T): T => JSON.parse(created.reduce((acc, id, i) => acc.replaceAll(`@new:${i}`, id), JSON.stringify(v))) as T;
    const active = await tx.requirement.findMany({ where: { projectId: p.projectId, status: 'ACTIVE' }, select: { id: true, currentVersion: true } });
    const brief = await tx.architectureBrief.upsert({ where: { projectId: p.projectId }, create: { projectId: p.projectId }, update: {} });
    const last = await tx.architectureBriefVersion.findFirst({ where: { briefId: brief.id }, orderBy: { version: 'desc' }, select: { version: true } });
    const version = await tx.architectureBriefVersion.create({ data: { briefId: brief.id, version: (last?.version ?? 0) + 1, content: json(sub(app.brief.content)), requirementsFingerprint: requirementsFingerprint(active.map((r) => ({ id: r.id, version: r.currentVersion }))),
      ai: json(app.brief.ai), createdById: p.userId, confirmedAt: new Date(), confirmedById: p.userId, acceptedUnknownIds: json([]), sourceProposalId: p.proposalId } });
    for (const d of sub(app.brief.drivers)) {
      await tx.architectureDriver.create({ data: { projectId: p.projectId, briefVersionId: version.id, key: d.id, name: d.name, description: d.description, priority: d.priority, requirements: { create: [...new Set(d.sourceRequirementIds)].map((requirementId) => ({ requirementId })) } } });
    }
    await tx.architectureBrief.update({ where: { id: brief.id }, data: { status: 'CONFIRMED', confirmedVersionId: version.id } });
    return version.id;
  }

  return {
    changes: {
      async create(i) {
        const r = await prisma.architectureChangeProposal.create({ data: { projectId: i.projectId, baseVersionId: i.baseVersionId, source: i.source, requestedChange: i.requestedChange, reason: i.reason ?? null, assistantConversationId: i.assistantConversationId ?? null,
          assistantMessageId: i.assistantMessageId ?? null, reviewFindingId: i.reviewFindingId ?? null, rebasedFromId: i.rebasedFromId ?? null, createdById: i.userId, requirementChanges: json([]) }, include });
        return toProposal(r);
      },
      get,
      async list(projectId) { return (await prisma.architectureChangeProposal.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, include })).map(toProposal); },
      async edit({ id, requestedChange, reason }) {
        return prisma.$transaction(async (tx) => {
          const r = await tx.architectureChangeProposal.updateMany({ where: { id, status: { in: ['DRAFT', 'READY_FOR_REVIEW', 'FAILED'] }, approval: { is: null } },
            data: { requestedChange, reason, status: 'DRAFT', analysis: Prisma.DbNull, analysisAi: Prisma.DbNull, severity: null, changeType: null, requiresReconfirmation: false, requirementChanges: json([]), failureCode: null, failureMessage: null, analysisAttempt: 0, analysisHeartbeatAt: null, analyzedAt: null } });
          if (r.count === 1) await tx.changeProposalImpactItem.deleteMany({ where: { proposalId: id } });
          return r.count === 1;
        });
      },
      async startAnalysis(id) {
        const r = await prisma.architectureChangeProposal.updateMany({ where: { id, OR: [{ status: 'DRAFT' }, { status: 'FAILED', approval: { is: null } }] }, data: { status: 'ANALYZING', analysisHeartbeatAt: null, failureCode: null, failureMessage: null } });
        return r.count === 1;
      },
      async claimAnalysis(id, staleBefore) {
        const now = new Date();
        const r = await prisma.architectureChangeProposal.updateMany({ where: { id, status: 'ANALYZING', OR: [{ analysisHeartbeatAt: null }, { analysisHeartbeatAt: { lt: staleBefore } }] }, data: { analysisHeartbeatAt: now, analysisAttempt: { increment: 1 } } });
        return r.count === 1 ? get(id) : null;
      },
      async saveAnalysis({ id, analysis, ai, severity, requiresReconfirmation, requirementChanges, items }) {
        return prisma.$transaction(async (tx) => {
          const r = await tx.architectureChangeProposal.updateMany({ where: { id, status: 'ANALYZING' }, data: { status: 'READY_FOR_REVIEW', analysis: json(analysis), analysisAi: json(ai), changeType: analysis.changeType, severity, requiresReconfirmation, requirementChanges: json(requirementChanges), analyzedAt: new Date(), failureCode: null, failureMessage: null } });
          if (r.count !== 1) return false;
          await tx.changeProposalImpactItem.deleteMany({ where: { proposalId: id } });
          const seen = new Set<string>(); const data = items.filter((i) => { const k = `${i.kind}|${i.refKey}`; if (seen.has(k)) return false; seen.add(k); return true; }).map((i) => ({ proposalId: id, kind: i.kind, refKey: i.refKey, relation: i.relation, reason: i.reason, taskId: i.taskId }));
          if (data.length) await tx.changeProposalImpactItem.createMany({ data });
          return true;
        });
      },
      async failAnalysis({ id, code, message }) { const r = await prisma.architectureChangeProposal.updateMany({ where: { id, status: 'ANALYZING' }, data: { status: 'FAILED', failureCode: code, failureMessage: message } }); return r.count === 1; },
      async listStaleAnalyses(before) {
        const rows = await prisma.architectureChangeProposal.findMany({ where: { status: 'ANALYZING', OR: [{ analysisHeartbeatAt: { lt: before } }, { analysisHeartbeatAt: null, updatedAt: { lt: before } }] }, include });
        return rows.map(toProposal);
      },
      async reject({ id, userId, note }) {
        return prisma.$transaction(async (tx) => {
          const p = await tx.architectureChangeProposal.findUnique({ where: { id } }); if (!p) return false;
          const r = await tx.architectureChangeProposal.updateMany({ where: { id, status: { in: ['DRAFT', 'READY_FOR_REVIEW', 'FAILED', 'STALE'] }, approval: { is: null } }, data: { status: 'REJECTED' } });
          if (r.count !== 1) return false;
          await tx.changeProposalApproval.create({ data: { proposalId: id, decision: 'REJECTED', decidedById: userId, architectureVersionId: p.baseVersionId, note } });
          return true;
        });
      },
      async approve({ id, userId, note, confirmedRequirementChanges, requirementApplication }) {
        try {
          return await prisma.$transaction(async (tx) => {
            const p = await tx.architectureChangeProposal.findUnique({ where: { id }, include: { baseVersion: { select: { briefVersionId: true } } } });
            if (!p) return { result: 'INVALID' as const };
            const arch = await tx.architecture.findUnique({ where: { projectId: p.projectId } });
            if (arch?.currentVersionId !== p.baseVersionId) { await tx.architectureChangeProposal.updateMany({ where: { id, status: { in: OPEN } }, data: { status: 'STALE' } }); return { result: 'STALE' as const }; }
            const moved = await tx.architectureChangeProposal.updateMany({ where: { id, status: 'READY_FOR_REVIEW' }, data: { status: 'APPROVED' } });
            if (moved.count !== 1) return { result: 'INVALID' as const };
            const briefVersionId = requirementApplication ? await applyRequirements(tx, { proposalId: id, projectId: p.projectId, userId }, requirementApplication) : p.briefVersionId ?? p.baseVersion.briefVersionId;
            await tx.changeProposalApproval.create({ data: { proposalId: id, decision: 'APPROVED', decidedById: userId, architectureVersionId: p.baseVersionId, confirmedRequirementChanges, note } });
            const run = await tx.architectureGenerationRun.create({ data: { projectId: p.projectId, briefVersionId, requestedById: userId, mode: 'CHANGE', proposalId: id, baseVersionId: p.baseVersionId, currentStage: 'QUEUED' }, include: runInclude });
            await tx.architectureChangeProposal.update({ where: { id }, data: { status: 'APPLYING', briefVersionId } });
            return { result: 'OK' as const, run: toRun(run) };
          }, { timeout: 30_000, maxWait: 10_000 });
        } catch (e) { if (isUnique(e)) return { result: 'INVALID' as const }; throw e; } // a second approval, a second run, or a second active change application
      },
      async retryApply({ id }) {
        return prisma.$transaction(async (tx) => {
          const p = await tx.architectureChangeProposal.updateMany({ where: { id, status: 'FAILED', approval: { is: { decision: 'APPROVED' } } }, data: { status: 'APPLYING', failureCode: null, failureMessage: null } });
          if (p.count !== 1) return null;
          const r = await tx.architectureGenerationRun.updateMany({ where: { proposalId: id, status: 'FAILED' }, data: { status: 'QUEUED', failureCode: null, failureMessage: null, finishedAt: null, jobId: null, currentStage: 'QUEUED' } });
          if (r.count !== 1) throw new ChangeStateChanged();
          return toRun(await tx.architectureGenerationRun.findUniqueOrThrow({ where: { proposalId: id }, include: runInclude }));
        }).catch((e) => { if (e instanceof ChangeStateChanged) return null; throw e; });
      },
      async markStale(projectId, currentVersionId) {
        const r = await prisma.architectureChangeProposal.updateMany({ where: { projectId, status: { in: OPEN }, baseVersionId: { not: currentVersionId } }, data: { status: 'STALE' } });
        return r.count;
      },
      async failApply({ runId, code, message, issues }) {
        return prisma.$transaction(async (tx) => {
          const failed = await tx.architectureGenerationRun.updateMany({ where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', failureCode: code, failureMessage: message, finishedAt: new Date(), currentStage: 'FAILED' } });
          if (failed.count !== 1) return false;
          const run = await tx.architectureGenerationRun.findUniqueOrThrow({ where: { id: runId } });
          if (run.proposalId) await tx.architectureChangeProposal.updateMany({ where: { id: run.proposalId, status: 'APPLYING' }, data: { status: 'FAILED', failureCode: code, failureMessage: message } });
          if (issues?.length) await tx.architectureGenerationIssue.createMany({ data: issues.map((i) => ({ runId, stage: i.stage, source: i.source, severity: i.severity, category: i.category, code: i.code, description: i.description, affectedNodeStableKeys: json(i.affectedNodeStableKeys), affectedDecisionKeys: json(i.affectedDecisionKeys), relatedRequirementCodes: json(i.relatedRequirementCodes), recommendation: i.recommendation })) });
          return true;
        });
      },
      async finalizeChange(input) {
        try {
          return await prisma.$transaction(async (tx) => {
            const claimed = await tx.architectureGenerationRun.updateMany({ where: { id: input.runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'SUCCEEDED', finishedAt: new Date(), currentStage: 'DONE', ai: json(input.ai) } });
            if (claimed.count !== 1) {
              const existing = await tx.architectureVersion.findUnique({ where: { generationRunId: input.runId } });
              if (existing) return { versionId: existing.id, versionNumber: existing.versionNumber, created: false };
              throw new Error(`Run ${input.runId} is already finished without a version`);
            }
            const prop = await tx.architectureChangeProposal.findUniqueOrThrow({ where: { id: input.proposalId } });
            const arch = await tx.architecture.findUniqueOrThrow({ where: { projectId: input.projectId } });
            const base = await tx.architectureVersion.findUniqueOrThrow({ where: { id: input.baseVersionId }, include: { decisions: { select: { id: true, key: true } } } });
            // The change may only be applied to the version it was approved against, and only while that version is still current and READY.
            if (prop.status !== 'APPLYING' || arch.currentVersionId !== input.baseVersionId || base.status !== 'READY') throw new ChangeStateChanged();
            await tx.architectureVersion.update({ where: { id: base.id }, data: { status: 'SUPERSEDED' } });
            const last = await tx.architectureVersion.findFirst({ where: { architectureId: arch.id }, orderBy: { versionNumber: 'desc' } });
            const { plan } = input;
            const version = await tx.architectureVersion.create({ data: { architectureId: arch.id, versionNumber: (last?.versionNumber ?? 0) + 1, status: 'DRAFT', generationRunId: input.runId, briefVersionId: input.briefVersionId, parentVersionId: base.id,
              sourceProposalId: input.proposalId, summary: plan.summary, assumptions: json(plan.assumptions), unresolvedQuestions: json(plan.unresolvedQuestions), risks: json(plan.risks), ai: json(input.ai) } });
            const nodeIds = new Map<string, string>(), edgeIds = new Map<string, string>(); const baseDecisionId = new Map(base.decisions.map((d) => [d.key, d.id]));
            for (const n of plan.nodes) {
              nodeIds.set(n.stableKey, (await tx.architectureNode.create({ data: { versionId: version.id, stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: n.category, purpose: n.purpose, description: n.description,
                criticality: n.criticality, managedService: n.managedService, provider: n.provider, deploymentModel: n.deploymentModel, configuration: json(n.configuration), risks: json(n.risks), alternatives: json(n.alternatives), replacesStableKey: n.replacesStableKey } })).id);
            }
            for (const e of plan.edges) {
              edgeIds.set(e.id, (await tx.architectureEdge.create({ data: { versionId: version.id, edgeKey: e.id, sourceStableKey: e.sourceStableKey, targetStableKey: e.targetStableKey, label: e.label, protocol: e.protocol, communicationType: e.communicationType,
                dataDescription: e.dataDescription, synchronous: e.synchronous, encrypted: e.encrypted, criticality: e.criticality } })).id);
            }
            for (const d of plan.decisions) {
              if (d.supersedesKey && !baseDecisionId.has(d.supersedesKey)) throw new Error(`Decision ${d.key} supersedes unknown decision ${d.supersedesKey}`);
              await tx.architectureDecision.create({ data: { versionId: version.id, key: d.key, title: d.title, problem: d.problem, decision: d.decision, rationale: d.rationale, status: d.status, tradeoffs: json(d.tradeoffs), risks: json(d.risks), alternatives: json(d.alternatives),
                consequences: json(d.consequences), confidence: d.confidence, supersedesDecisionId: d.supersedesKey ? baseDecisionId.get(d.supersedesKey)! : null,
                driverLinks: { create: [...new Set(d.driverCodes)].map((c) => ({ driverId: input.driverIdByCode[c]! })) }, requirementLinks: { create: [...new Set(d.requirementCodes)].map((c) => ({ requirementId: input.requirementIdByCode[c]! })) },
                nodeLinks: { create: [...new Set(d.nodeStableKeys)].map((k) => ({ nodeId: nodeIds.get(k)! })) }, edgeLinks: { create: [...new Set(d.edgeIds)].map((k) => ({ edgeId: edgeIds.get(k)! })) } } });
            }
            if (input.issues.length) await tx.architectureGenerationIssue.createMany({ data: input.issues.map((i) => ({ runId: input.runId, versionId: version.id, stage: i.stage, source: i.source, severity: i.severity, category: i.category, code: i.code, description: i.description,
              affectedNodeStableKeys: json(i.affectedNodeStableKeys), affectedDecisionKeys: json(i.affectedDecisionKeys), relatedRequirementCodes: json(i.relatedRequirementCodes), recommendation: i.recommendation })) });
            await tx.architectureVersion.update({ where: { id: version.id }, data: { status: 'READY', finalizedAt: new Date() } });
            await tx.architecture.update({ where: { id: arch.id }, data: { currentVersionId: version.id } });
            const { summary, ...entries } = input.diff;
            await tx.architectureVersionDiff.create({ data: { fromVersionId: base.id, toVersionId: version.id, proposalId: input.proposalId, summary: json(summary), entries: json(entries) } });
            await tx.architectureChangeProposal.update({ where: { id: input.proposalId }, data: { status: 'APPLIED' } });
            await tx.architectureChangeProposal.updateMany({ where: { projectId: input.projectId, id: { not: input.proposalId }, status: { in: OPEN }, baseVersionId: { not: version.id } }, data: { status: 'STALE' } });
            return { versionId: version.id, versionNumber: version.versionNumber, created: true };
          }, { timeout: 60_000, maxWait: 10_000 });
        } catch (e) {
          if (e instanceof ChangeStateChanged) throw Object.assign(new Error('The proposal or the architecture changed while the change was being applied'), { code: 'PROPOSAL_STATE_CHANGED' });
          if (isUnique(e)) { // a concurrent finalizer won for this run or this proposal
            const existing = (await prisma.architectureVersion.findUnique({ where: { generationRunId: input.runId } })) ?? (await prisma.architectureVersion.findUnique({ where: { sourceProposalId: input.proposalId } }));
            if (existing) return { versionId: existing.id, versionNumber: existing.versionNumber, created: false };
          }
          throw e;
        }
      },
      async getByRun(runId) { const r = await prisma.architectureGenerationRun.findUnique({ where: { id: runId }, select: { proposalId: true } }); return r?.proposalId ? get(r.proposalId) : null; },
    },
    diffs: {
      async get(fromVersionId, toVersionId) {
        const d = await prisma.architectureVersionDiff.findUnique({ where: { fromVersionId_toVersionId: { fromVersionId, toVersionId } } });
        return d ? ({ ...(d.entries as object), summary: d.summary } as ArchitectureDiff) : null;
      },
    },
    reviews: {
      async create({ projectId, architectureVersionId, userId, assessment, ai, findings }) {
        const r = await prisma.architectureReview.create({ data: { projectId, architectureVersionId, createdById: userId, assessment, ai: json(ai),
          findings: { create: findings.map((f) => ({ area: f.area, severity: f.severity, title: f.title, description: f.description, recommendation: f.recommendation, nodeKeys: json(f.nodeKeys), decisionKeys: json(f.decisionKeys), requiresArchitectureChange: f.requiresArchitectureChange, suggestedChange: f.suggestedChange, source: f.source })) } }, include: reviewInclude });
        return toReview(r);
      },
      async latest(projectId, architectureVersionId) { const r = await prisma.architectureReview.findFirst({ where: { projectId, ...(architectureVersionId ? { architectureVersionId } : {}) }, orderBy: { createdAt: 'desc' }, include: reviewInclude }); return r ? toReview(r) : null; },
      async get(id) { const r = await prisma.architectureReview.findUnique({ where: { id }, include: reviewInclude }); return r ? toReview(r) : null; },
      async getFinding(id) {
        const f = await prisma.architectureReviewFinding.findUnique({ where: { id }, include: { review: true } }); if (!f) return null;
        const rec = toReview({ ...f.review, findings: [f] }).findings[0]!; return { ...rec, projectId: f.review.projectId, architectureVersionId: f.review.architectureVersionId };
      },
    },
    migrations: {
      async get(toPlanVersionId) {
        const m = await prisma.implementationMigration.findUnique({ where: { toPlanVersionId }, include: { items: true } }); if (!m) return null;
        return { id: m.id, fromPlanVersionId: m.fromPlanVersionId, toPlanVersionId: m.toPlanVersionId, proposalId: m.proposalId, acceptedById: m.acceptedById, acceptedAt: m.acceptedAt, summary: m.summary as unknown as MigrationSummary,
          items: m.items.map((i) => ({ id: i.id, v1TaskId: i.v1TaskId, v2TaskId: i.v2TaskId, outcome: i.outcome as MigItem['outcome'], reason: i.reason, v1Status: i.v1Status })) } satisfies MigrationRecord;
      },
      async accept({ fromPlanVersionId, toPlanVersionId, userId, proposalId, items, summary }) {
        try {
          return await prisma.$transaction(async (tx) => {
            const v2 = await tx.implementationPlanVersion.findUnique({ where: { id: toPlanVersionId } }); const v1 = await tx.implementationPlanVersion.findUnique({ where: { id: fromPlanVersionId } });
            if (!v1 || !v2) return null;
            // The reviewed mapping must still describe reality: if V1 progress moved since the user looked, nothing is applied.
            const v1Ids = items.map((i) => i.v1TaskId).filter((x): x is string => !!x);
            const now = await tx.implementationTask.findMany({ where: { id: { in: v1Ids } }, select: { id: true, status: true } }); const cur = new Map(now.map((t) => [t.id, t.status]));
            for (const i of items) if (i.v1TaskId && cur.get(i.v1TaskId) !== i.v1Status) throw Object.assign(new Error('Plan v1 progress changed after the migration was reviewed'), { code: 'MIGRATION_STALE' });
            const flipped = await tx.implementationPlanVersion.updateMany({ where: { id: toPlanVersionId, activation: 'PENDING_REVIEW', supersedesPlanVersionId: fromPlanVersionId }, data: { activation: 'ACTIVE' } });
            if (flipped.count !== 1) return null;
            await tx.implementationPlanVersion.updateMany({ where: { id: fromPlanVersionId }, data: { activation: 'SUPERSEDED' } });
            await tx.implementationPlan.update({ where: { id: v2.planId }, data: { currentVersionId: toPlanVersionId } });
            const m = await tx.implementationMigration.create({ data: { fromPlanVersionId, toPlanVersionId, proposalId, acceptedById: userId, summary: json(summary), items: { create: items.map((i) => ({ v1TaskId: i.v1TaskId, v2TaskId: i.v2TaskId, outcome: i.outcome, reason: i.reason, v1Status: i.v1Status })) } }, include: { items: true } });
            for (const it of items.filter((x) => x.outcome === 'CARRIED_FORWARD' && x.v1TaskId && x.v2TaskId)) {
              const moved = await tx.implementationTask.updateMany({ where: { id: it.v2TaskId!, status: 'NOT_STARTED' }, data: { status: 'COMPLETED' } });
              if (moved.count !== 1) continue;
              await tx.taskProgressEvent.create({ data: { taskId: it.v2TaskId!, fromStatus: 'NOT_STARTED', toStatus: 'COMPLETED', reason: `Carried forward from plan v${v1.versionNumber} after review: ${it.reason}`.slice(0, 500), actorId: userId } });
              const old = await tx.taskValidation.findMany({ where: { taskId: it.v1TaskId! } }); const byLabel = new Map(old.map((o) => [o.label, o]));
              for (const nv of await tx.taskValidation.findMany({ where: { taskId: it.v2TaskId! } })) {
                const o = byLabel.get(nv.label);
                await tx.taskValidation.update({ where: { id: nv.id }, data: { confirmed: true, confirmationKind: 'USER_CONFIRMED', confirmedById: o?.confirmedById ?? userId, confirmedAt: o?.confirmedAt ?? new Date() } });
              }
            }
            for (const ph of await tx.implementationPhase.findMany({ where: { planVersionId: toPlanVersionId } })) {
              const ts = await tx.implementationTask.findMany({ where: { phaseId: ph.id }, select: { status: true } });
              await tx.implementationPhase.update({ where: { id: ph.id }, data: { status: phaseStatus(ts.map((t) => taskStatusSchema.parse(t.status))) } });
            }
            return { id: m.id, fromPlanVersionId, toPlanVersionId, proposalId, acceptedById: userId, acceptedAt: m.acceptedAt, summary,
              items: m.items.map((i) => ({ id: i.id, v1TaskId: i.v1TaskId, v2TaskId: i.v2TaskId, outcome: i.outcome as MigItem['outcome'], reason: i.reason, v1Status: i.v1Status })) } satisfies MigrationRecord;
          }, { timeout: 60_000, maxWait: 10_000 });
        } catch (e) { if (isUnique(e)) return null; throw e; }
      },
    },
  };
}
