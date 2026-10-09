import type { PlanInput, RequirementText } from '@pitch2plan/schemas';
import type { DriverRecord, RequirementRecord } from './ports';

const pad = (n: number) => String(n).padStart(3, '0');

/**
 * Stable, human-readable codes (REQ-013, DRV-004). Requirement codes are assigned over ALL requirements ever created for the
 * project, ordered by creation, so a code never changes once issued (requirements are append-only and never deleted).
 * Driver codes follow the order of the confirmed brief.
 */
export interface Codebook {
  requirementCodeById: Record<string, string>; requirementIdByCode: Record<string, string>;
  driverCodeById: Record<string, string>; driverIdByCode: Record<string, string>;
}

export function buildCodebook(allRequirements: Pick<RequirementRecord, 'id' | 'createdAt'>[], briefDriverKeys: string[], drivers: Pick<DriverRecord, 'id' | 'key'>[]): Codebook {
  const ordered = [...allRequirements].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const cb: Codebook = { requirementCodeById: {}, requirementIdByCode: {}, driverCodeById: {}, driverIdByCode: {} };
  ordered.forEach((r, i) => { const c = `REQ-${pad(i + 1)}`; cb.requirementCodeById[r.id] = c; cb.requirementIdByCode[c] = r.id; });
  const byKey = new Map(drivers.map((d) => [d.key, d]));
  briefDriverKeys.forEach((k, i) => {
    const d = byKey.get(k);
    if (!d) return;
    const c = `DRV-${pad(i + 1)}`; cb.driverCodeById[d.id] = c; cb.driverIdByCode[c] = d.id;
  });
  return cb;
}

export function buildPlanInput(args: {
  context: PlanInput['context']; project: PlanInput['project']; brief: unknown; requirements: RequirementRecord[]; drivers: DriverRecord[]; codebook: Codebook;
}): { input: PlanInput; requirementTexts: RequirementText[]; driverCodes: string[]; requirementCodes: string[] } {
  const { codebook: cb } = args;
  const requirements = args.requirements.filter((r) => r.status === 'ACTIVE').map((r) => ({
    code: cb.requirementCodeById[r.id]!, category: r.category, statement: r.statement, value: r.value, origin: r.origin, confidence: r.confidence,
  }));
  const drivers = args.drivers.filter((d) => cb.driverCodeById[d.id]).map((d) => ({
    code: cb.driverCodeById[d.id]!, name: d.name, description: d.description, priority: d.priority,
    requirementCodes: d.requirementIds.map((id) => cb.requirementCodeById[id]).filter((c): c is string => !!c),
  })).sort((a, b) => a.code.localeCompare(b.code));
  return {
    input: { context: args.context, project: args.project, brief: args.brief, requirements, drivers },
    requirementTexts: requirements.map((r) => ({ code: r.code, category: r.category, statement: `${r.statement}${r.value ? ` ${r.value}` : ''}` })),
    driverCodes: drivers.map((d) => d.code), requirementCodes: requirements.map((r) => r.code),
  };
}
