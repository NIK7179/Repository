import type {
  ArchitectureRepositories, ArchitectureVersionRecord, ArchitectureVersionSummary, DecisionRecord, EdgeRecord, GenerationRunRecord, IssueRecord, NodeRecord,
} from '@pitch2plan/domain';
import { configItemSchema, decisionAlternativeSchema, nodeAlternativeSchema, nodeCategorySchema, prioritySchema } from '@pitch2plan/schemas';
import { z } from 'zod';
import type { PrismaClient } from './client';
import type { Prisma } from './generated/client';

const isUnique = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
const json = (v: unknown) => v as Prisma.InputJsonValue;
const strings = z.array(z.string());

export const runInclude = { version: { select: { id: true } } } as const;
type RunRow = Prisma.ArchitectureGenerationRunGetPayload<{ include: typeof runInclude }>;
export const toRun = (r: RunRow): GenerationRunRecord => ({
  mode: r.mode, proposalId: r.proposalId, baseVersionId: r.baseVersionId,
  id: r.id, projectId: r.projectId, briefVersionId: r.briefVersionId, status: r.status, currentStage: r.currentStage, attempt: r.attempt, repairCount: r.repairCount,
  failureCode: r.failureCode, failureMessage: r.failureMessage, jobId: r.jobId, requestedById: r.requestedById, createdAt: r.createdAt, startedAt: r.startedAt,
  heartbeatAt: r.heartbeatAt, finishedAt: r.finishedAt, versionId: r.version?.id ?? null,
});

const versionInclude = {
  architecture: { select: { projectId: true } },
  nodes: { orderBy: { stableKey: 'asc' as const } },
  edges: { orderBy: { edgeKey: 'asc' as const } },
  decisions: { orderBy: { key: 'asc' as const }, include: { supersedes: { select: { key: true } }, supersededBy: { select: { key: true } }, driverLinks: true, requirementLinks: true, nodeLinks: { include: { node: { select: { stableKey: true } } } }, edgeLinks: { include: { edge: { select: { edgeKey: true } } } } } },
  issues: { orderBy: { createdAt: 'asc' as const } },
  _count: { select: { nodes: true, edges: true, decisions: true } },
} as const;
type VersionRow = Prisma.ArchitectureVersionGetPayload<{ include: typeof versionInclude }>;

const toSummary = (v: Pick<VersionRow, 'id' | 'architectureId' | 'versionNumber' | 'status' | 'generationRunId' | 'briefVersionId' | 'summary' | 'createdAt' | 'finalizedAt' | '_count' | 'parentVersionId' | 'sourceProposalId'> & { architecture: { projectId: string } }): ArchitectureVersionSummary => ({
  id: v.id, architectureId: v.architectureId, projectId: v.architecture.projectId, versionNumber: v.versionNumber, status: v.status, generationRunId: v.generationRunId,
  briefVersionId: v.briefVersionId, summary: v.summary, createdAt: v.createdAt, finalizedAt: v.finalizedAt, parentVersionId: v.parentVersionId, sourceProposalId: v.sourceProposalId, counts: { nodes: v._count.nodes, edges: v._count.edges, decisions: v._count.decisions },
});
const riskSchema = z.array(z.object({ text: z.string(), severity: prioritySchema, nodeStableKeys: strings.default([]) }));

const toVersion = (v: VersionRow): ArchitectureVersionRecord => ({
  ...toSummary(v),
  assumptions: strings.parse(v.assumptions), unresolvedQuestions: strings.parse(v.unresolvedQuestions), risks: riskSchema.parse(v.risks), ai: (v.ai ?? {}) as Record<string, unknown>,
  nodes: v.nodes.map((n): NodeRecord => ({
    id: n.id, versionId: n.versionId, stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: nodeCategorySchema.parse(n.category),
    purpose: n.purpose, description: n.description, criticality: prioritySchema.parse(n.criticality), managedService: n.managedService, provider: n.provider, deploymentModel: n.deploymentModel,
    configuration: z.array(configItemSchema).parse(n.configuration), risks: strings.parse(n.risks), alternatives: z.array(nodeAlternativeSchema).parse(n.alternatives), status: n.status,
    replacesStableKey: n.replacesStableKey,
  })),
  edges: v.edges.map((e): EdgeRecord => ({
    id: e.id, versionId: e.versionId, edgeKey: e.edgeKey, sourceStableKey: e.sourceStableKey, targetStableKey: e.targetStableKey, label: e.label, protocol: e.protocol,
    communicationType: e.communicationType, dataDescription: e.dataDescription, synchronous: e.synchronous, encrypted: e.encrypted, criticality: prioritySchema.parse(e.criticality),
  })),
  decisions: v.decisions.map((d): DecisionRecord => ({
    id: d.id, versionId: d.versionId, key: d.key, title: d.title, problem: d.problem, decision: d.decision, rationale: d.rationale, status: d.status, tradeoffs: strings.parse(d.tradeoffs),
    risks: strings.parse(d.risks), alternatives: z.array(decisionAlternativeSchema).parse(d.alternatives), consequences: strings.parse(d.consequences), confidence: d.confidence, createdAt: d.createdAt,
    driverIds: d.driverLinks.map((l) => l.driverId), requirementIds: d.requirementLinks.map((l) => l.requirementId),
    nodeStableKeys: d.nodeLinks.map((l) => l.node.stableKey).sort(), edgeKeys: d.edgeLinks.map((l) => l.edge.edgeKey).sort(),
    supersedesKey: d.supersedes?.key ?? null, supersededByKey: d.supersededBy[0]?.key ?? null, effectiveStatus: d.supersededBy.length ? 'SUPERSEDED' : d.status,
  })),
  issues: v.issues.map((i): IssueRecord => ({
    id: i.id, stage: i.stage, source: i.source as IssueRecord['source'], severity: prioritySchema.parse(i.severity), category: i.category as IssueRecord['category'], code: i.code,
    description: i.description, affectedNodeStableKeys: strings.parse(i.affectedNodeStableKeys), affectedDecisionKeys: strings.parse(i.affectedDecisionKeys),
    relatedRequirementCodes: strings.parse(i.relatedRequirementCodes), recommendation: i.recommendation,
  })),
});

/** Thrown inside the finalize transaction to roll everything back when the project is no longer ARCHITECTURE_GENERATING. */
class ProjectNotGenerating extends Error { constructor() { super('PROJECT_NOT_GENERATING'); } }

export function createArchitectureRepositories(prisma: PrismaClient): ArchitectureRepositories {
  const getRun = async (id: string) => { const r = await prisma.architectureGenerationRun.findUnique({ where: { id }, include: runInclude }); return r ? toRun(r) : null; };
  return {
    architecture: {
      async getByProject(projectId) {
        const a = await prisma.architecture.findUnique({ where: { projectId } });
        return a ? { id: a.id, projectId: a.projectId, currentVersionId: a.currentVersionId } : null;
      },
      async listVersions(projectId) {
        const rows = await prisma.architectureVersion.findMany({ where: { architecture: { projectId } }, orderBy: { versionNumber: 'desc' }, include: { architecture: { select: { projectId: true } }, _count: { select: { nodes: true, edges: true, decisions: true } } } });
        return rows.map(toSummary);
      },
      async getVersion(versionId) {
        const v = await prisma.architectureVersion.findUnique({ where: { id: versionId }, include: versionInclude });
        return v ? toVersion(v) : null;
      },
      async nodeHistory(architectureId, stableKey) {
        const versions = await prisma.architectureVersion.findMany({ where: { architectureId }, orderBy: { versionNumber: 'asc' }, include: { nodes: { where: { OR: [{ stableKey }, { replacesStableKey: stableKey }] } } } });
        const out = [];
        for (const [i, v] of versions.entries()) {
          const n = v.nodes.find((x) => x.stableKey === stableKey);
          if (!n) continue;
          const next = versions[i + 1];
          const replacedBy = next?.nodes.find((x) => x.replacesStableKey === stableKey)?.stableKey ?? null;
          out.push({ versionNumber: v.versionNumber, versionId: v.id, technology: n.technology, technologySlug: n.technologySlug, replacesStableKey: n.replacesStableKey, replacedByStableKey: replacedBy });
        }
        return out;
      },

      async startGeneration({ projectId, briefVersionId, userId }) {
        return prisma.$transaction(async (tx) => {
          const moved = await tx.project.updateMany({ where: { id: projectId, status: 'REQUIREMENTS_CONFIRMED', deletedAt: null }, data: { status: 'ARCHITECTURE_GENERATING' } });
          if (moved.count !== 1) return null;
          const run = await tx.architectureGenerationRun.create({ data: { projectId, briefVersionId, requestedById: userId }, include: runInclude });
          return toRun(run);
        });
      },
      async attachJob(runId, jobId) { await prisma.architectureGenerationRun.update({ where: { id: runId }, data: { jobId } }); },
      getRun,
      async getRunByJobId(jobId) { const r = await prisma.architectureGenerationRun.findUnique({ where: { jobId }, include: runInclude }); return r ? toRun(r) : null; },
      async getLatestRun(projectId) { const r = await prisma.architectureGenerationRun.findFirst({ where: { projectId, mode: 'INITIAL' }, orderBy: { createdAt: 'desc' }, include: runInclude }); return r ? toRun(r) : null; },

      async claimRun(runId, staleBefore) {
        const now = new Date();
        const r = await prisma.architectureGenerationRun.updateMany({
          where: { id: runId, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', heartbeatAt: { lt: staleBefore } }] },
          data: { status: 'RUNNING', attempt: { increment: 1 }, startedAt: now, heartbeatAt: now, currentStage: 'ANALYZING_DRIVERS' },
        });
        return r.count === 1 ? getRun(runId) : null;
      },
      async touchRun(runId, patch) {
        await prisma.architectureGenerationRun.updateMany({ where: { id: runId, status: 'RUNNING' }, data: { ...patch, heartbeatAt: new Date() } });
      },

      async finalize(input) {
        try {
          return await prisma.$transaction(async (tx) => {
            // Compare-and-set claims the single right to finalize this run. A retry or a duplicate worker lands in the else branch.
            const claimed = await tx.architectureGenerationRun.updateMany({ where: { id: input.runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'SUCCEEDED', finishedAt: new Date(), currentStage: 'DONE', ai: json(input.ai) } });
            if (claimed.count !== 1) {
              const existing = await tx.architectureVersion.findUnique({ where: { generationRunId: input.runId } });
              if (existing) return { versionId: existing.id, versionNumber: existing.versionNumber, created: false };
              throw new Error(`Run ${input.runId} is already finished without a version`);
            }
            const moved = await tx.project.updateMany({ where: { id: input.projectId, status: 'ARCHITECTURE_GENERATING', deletedAt: null }, data: { status: 'ARCHITECTURE_READY' } });
            if (moved.count !== 1) throw new ProjectNotGenerating();

            const architecture = await tx.architecture.upsert({ where: { projectId: input.projectId }, create: { projectId: input.projectId }, update: {} });
            const last = await tx.architectureVersion.findFirst({ where: { architectureId: architecture.id }, orderBy: { versionNumber: 'desc' } });
            if (last && last.status === 'READY') await tx.architectureVersion.update({ where: { id: last.id }, data: { status: 'SUPERSEDED' } });
            const { plan } = input;
            const version = await tx.architectureVersion.create({
              data: { architectureId: architecture.id, versionNumber: (last?.versionNumber ?? 0) + 1, status: 'DRAFT', generationRunId: input.runId, briefVersionId: input.briefVersionId,
                summary: plan.summary, assumptions: json(plan.assumptions), unresolvedQuestions: json(plan.unresolvedQuestions), risks: json(plan.risks), ai: json(input.ai) },
            });
            const nodeIds = new Map<string, string>(), edgeIds = new Map<string, string>();
            for (const n of plan.nodes) {
              const row = await tx.architectureNode.create({ data: { versionId: version.id, stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: n.category, purpose: n.purpose,
                description: n.description, criticality: n.criticality, managedService: n.managedService, provider: n.provider, deploymentModel: n.deploymentModel, configuration: json(n.configuration),
                risks: json(n.risks), alternatives: json(n.alternatives), replacesStableKey: n.replacesStableKey } });
              nodeIds.set(n.stableKey, row.id);
            }
            for (const e of plan.edges) {
              const row = await tx.architectureEdge.create({ data: { versionId: version.id, edgeKey: e.id, sourceStableKey: e.sourceStableKey, targetStableKey: e.targetStableKey, label: e.label, protocol: e.protocol,
                communicationType: e.communicationType, dataDescription: e.dataDescription, synchronous: e.synchronous, encrypted: e.encrypted, criticality: e.criticality } });
              edgeIds.set(e.id, row.id);
            }
            for (const d of plan.decisions) {
              await tx.architectureDecision.create({ data: {
                versionId: version.id, key: d.key, title: d.title, problem: d.problem, decision: d.decision, rationale: d.rationale, status: d.status, tradeoffs: json(d.tradeoffs), risks: json(d.risks),
                alternatives: json(d.alternatives), consequences: json(d.consequences), confidence: d.confidence,
                driverLinks: { create: [...new Set(d.driverCodes)].map((c) => ({ driverId: input.driverIdByCode[c]! })) },
                requirementLinks: { create: [...new Set(d.requirementCodes)].map((c) => ({ requirementId: input.requirementIdByCode[c]! })) },
                nodeLinks: { create: [...new Set(d.nodeStableKeys)].map((k) => ({ nodeId: nodeIds.get(k)! })) },
                edgeLinks: { create: [...new Set(d.edgeIds)].map((k) => ({ edgeId: edgeIds.get(k)! })) },
              } });
            }
            if (input.issues.length) {
              await tx.architectureGenerationIssue.createMany({ data: input.issues.map((i) => ({ runId: input.runId, versionId: version.id, stage: i.stage, source: i.source, severity: i.severity, category: i.category,
                code: i.code, description: i.description, affectedNodeStableKeys: json(i.affectedNodeStableKeys), affectedDecisionKeys: json(i.affectedDecisionKeys),
                relatedRequirementCodes: json(i.relatedRequirementCodes), recommendation: i.recommendation })) });
            }
            await tx.architectureVersion.update({ where: { id: version.id }, data: { status: 'READY', finalizedAt: new Date() } });
            await tx.architecture.update({ where: { id: architecture.id }, data: { currentVersionId: version.id } });
            return { versionId: version.id, versionNumber: version.versionNumber, created: true };
          }, { timeout: 30_000, maxWait: 10_000 });
        } catch (e) {
          if (e instanceof ProjectNotGenerating) throw Object.assign(new Error('The project is no longer generating an architecture'), { code: 'PROJECT_STATE_CHANGED' });
          if (isUnique(e)) { // a concurrent finalizer won the race for this run
            const existing = await prisma.architectureVersion.findUnique({ where: { generationRunId: input.runId } });
            if (existing) return { versionId: existing.id, versionNumber: existing.versionNumber, created: false };
          }
          throw e;
        }
      },

      async failRun({ runId, code, message, issues }) {
        return prisma.$transaction(async (tx) => {
          const failed = await tx.architectureGenerationRun.updateMany({ where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', failureCode: code, failureMessage: message, finishedAt: new Date(), currentStage: 'FAILED' } });
          let projectRecovered = false;
          if (failed.count === 1) {
            const run = await tx.architectureGenerationRun.findUniqueOrThrow({ where: { id: runId } });
            const moved = await tx.project.updateMany({ where: { id: run.projectId, status: 'ARCHITECTURE_GENERATING' }, data: { status: 'REQUIREMENTS_CONFIRMED' } });
            projectRecovered = moved.count === 1;
            if (issues?.length) {
              await tx.architectureGenerationIssue.createMany({ data: issues.map((i) => ({ runId, stage: i.stage, source: i.source, severity: i.severity, category: i.category, code: i.code, description: i.description,
                affectedNodeStableKeys: json(i.affectedNodeStableKeys), affectedDecisionKeys: json(i.affectedDecisionKeys), relatedRequirementCodes: json(i.relatedRequirementCodes), recommendation: i.recommendation })) });
            }
          }
          return { failed: failed.count === 1, projectRecovered };
        });
      },
      async listStaleRuns(before) {
        const rows = await prisma.architectureGenerationRun.findMany({
          where: { status: { in: ['QUEUED', 'RUNNING'] }, OR: [{ heartbeatAt: { lt: before } }, { heartbeatAt: null, createdAt: { lt: before } }] }, include: runInclude,
        });
        return rows.map(toRun);
      },
    },
  };
}
