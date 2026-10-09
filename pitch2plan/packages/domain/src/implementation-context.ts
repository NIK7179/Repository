import type { ComponentFacts, DecisionFacts, ImplContext, ImplPlanInput } from '@pitch2plan/schemas';
import { buildCodebook, type Codebook } from './architecture-codes';
import { DomainError } from './errors';
import type { ArchitectureVersionRecord, PlanVersionRecord, ProjectRecord, Repositories, DriverRecord, RequirementRecord } from './ports';

export interface ProjectKnowledge {
  project: ProjectRecord; architecture: ArchitectureVersionRecord; brief: ReturnType<typeof briefSummary>; requirements: RequirementRecord[]; drivers: DriverRecord[]; codebook: Codebook;
  plan: PlanVersionRecord | null; technicalLevel?: string;
}
const briefSummary = (c: { projectSummary: string; businessObjective: string }) => ({ projectSummary: c.projectSummary, businessObjective: c.businessObjective });

/** Loads everything the implementation planner and the assistant need, from persisted state (never from chat). Requires a current READY architecture. */
export async function loadProjectKnowledge(repos: Repositories, project: ProjectRecord): Promise<ProjectKnowledge> {
  const arch = await repos.architecture.getByProject(project.id);
  const architecture = arch?.currentVersionId ? await repos.architecture.getVersion(arch.currentVersionId) : null;
  if (!architecture || architecture.status !== 'READY') throw new DomainError('INVALID_STATE', 'This project has no ready architecture yet.');
  const brief = await repos.briefs.getVersion(architecture.briefVersionId);
  if (!brief) throw new DomainError('BRIEF_NOT_FOUND', 'The confirmed brief could not be found.');
  const [drivers, requirements, pitch, planRef] = await Promise.all([repos.briefs.listDrivers(brief.id), repos.requirements.list(project.id), repos.pitches.latest(project.id), repos.implementation.getPlanByProject(project.id)]);
  const plan = planRef?.currentVersionId ? await repos.implementation.getVersion(planRef.currentVersionId) : null;
  return {
    project, architecture, brief: briefSummary(brief.content), requirements, drivers, plan, technicalLevel: pitch?.technicalLevel ?? undefined,
    codebook: buildCodebook(requirements, brief.content.architectureDrivers.map((d) => d.id), drivers),
  };
}

export function toImplContext(k: ProjectKnowledge): { ctx: ImplContext; requirementTexts: Array<{ code: string; statement: string }> } {
  const active = k.requirements.filter((r) => r.status === 'ACTIVE');
  const components: ComponentFacts[] = k.architecture.nodes.map((n) => ({ stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: n.category, criticality: n.criticality, deploymentModel: n.deploymentModel }));
  const decisions: DecisionFacts[] = k.architecture.decisions.map((d) => ({ key: d.key, status: d.status, title: d.title, nodeStableKeys: d.nodeStableKeys }));
  const codes = active.map((r) => k.codebook.requirementCodeById[r.id]!).filter(Boolean);
  return { ctx: { components, decisions, requirementCodes: codes }, requirementTexts: active.map((r) => ({ code: k.codebook.requirementCodeById[r.id]!, statement: `${r.statement}${r.value ? ` ${r.value}` : ''}` })) };
}

export function toPlanInput(k: ProjectKnowledge, context: ImplPlanInput['context']): ImplPlanInput {
  const cb = k.codebook; const a = k.architecture;
  const codeOf = (ids: string[], map: Record<string, string>) => ids.map((id) => map[id]).filter((c): c is string => !!c).sort();
  return {
    context, project: { name: k.project.name, technicalLevel: k.technicalLevel }, brief: k.brief,
    requirements: k.requirements.filter((r) => r.status === 'ACTIVE').map((r) => ({ code: cb.requirementCodeById[r.id]!, category: r.category, statement: r.statement, origin: r.origin })),
    drivers: k.drivers.filter((d) => cb.driverCodeById[d.id]).map((d) => ({ code: cb.driverCodeById[d.id]!, name: d.name, description: d.description, priority: d.priority })).sort((x, y) => x.code.localeCompare(y.code)),
    architecture: {
      summary: a.summary, assumptions: a.assumptions, risks: a.risks,
      nodes: a.nodes.map((n) => ({ stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: n.category, criticality: n.criticality, deploymentModel: n.deploymentModel,
        purpose: n.purpose, description: n.description, provider: n.provider, managedService: n.managedService, configuration: n.configuration.map((c) => ({ key: c.key, value: c.value })), risks: n.risks, alternatives: n.alternatives })),
      edges: a.edges.map((e) => ({ id: e.edgeKey, source: e.sourceStableKey, target: e.targetStableKey, label: e.label, protocol: e.protocol, communicationType: e.communicationType, dataDescription: e.dataDescription, encrypted: e.encrypted })),
      decisions: a.decisions.map((d) => ({ key: d.key, title: d.title, status: d.status, decision: d.decision, rationale: d.rationale, nodeStableKeys: d.nodeStableKeys, driverCodes: codeOf(d.driverIds, cb.driverCodeById), requirementCodes: codeOf(d.requirementIds, cb.requirementCodeById) })),
    },
  };
}
