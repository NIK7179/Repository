import { architectureBriefSchema, type ArchitectureBriefContent, type ArchitectureDriverDraft, type RequirementChange, type AiMeta } from '@pitch2plan/schemas';
import type { RequirementApplication } from './ports';

const SECTION: Record<string, keyof Pick<ArchitectureBriefContent, 'targetUsers' | 'functionalRequirements' | 'trafficAssumptions' | 'dataRequirements' | 'performanceRequirements' | 'availabilityRequirements' | 'securityRequirements' | 'complianceRequirements' | 'integrationRequirements' | 'cloudAndDeploymentPreferences' | 'budgetConstraints' | 'teamConstraints' | 'aiMlRequirements'>> = {
  USERS: 'targetUsers', TRAFFIC: 'trafficAssumptions', SCALABILITY: 'trafficAssumptions', DATA: 'dataRequirements', DATA_RETENTION: 'dataRequirements', PERFORMANCE: 'performanceRequirements', LATENCY: 'performanceRequirements',
  AVAILABILITY: 'availabilityRequirements', SECURITY: 'securityRequirements', COMPLIANCE: 'complianceRequirements', PRIVACY: 'complianceRequirements', INTEGRATION: 'integrationRequirements', API: 'integrationRequirements',
  CLOUD: 'cloudAndDeploymentPreferences', DEPLOYMENT: 'cloudAndDeploymentPreferences', GEOGRAPHY: 'cloudAndDeploymentPreferences', BUDGET: 'budgetConstraints', TEAM_CONSTRAINT: 'teamConstraints', TIMELINE: 'teamConstraints', AI_ML: 'aiMlRequirements',
};
const sectionOf = (category: string) => SECTION[category] ?? 'functionalRequirements';
export const DERIVED_BRIEF_AI: AiMeta = { promptId: 'DERIVED_BRIEF', promptVersion: 1, provider: 'system', model: 'deterministic', repaired: false };

/**
 * Builds the next brief version for an approved requirement change WITHOUT a model: the user already confirmed the exact requirement changes, so the brief
 * only reflects them. Existing driver order is preserved (driver codes are positional, so appending never renumbers anything); each ADD appends one driver.
 * `@new:N` placeholders stand for the ids of requirements the repository creates in the same transaction. Removing a requirement removes its brief items but
 * keeps drivers (and so every DRV-* code) stable.
 */
export function deriveBriefForChanges(args: { brief: ArchitectureBriefContent; changes: RequirementChange[]; requirementIdByCode: Record<string, string>; reason: string }): { content: ArchitectureBriefContent; drivers: ArchitectureDriverDraft[]; ops: RequirementApplication['ops']; errors: string[] } {
  const content: ArchitectureBriefContent = structuredClone(args.brief); const drivers = structuredClone(args.brief.architectureDrivers); const ops: RequirementApplication['ops'] = []; const errors: string[] = [];
  let added = 0;
  for (const c of args.changes) {
    const section = sectionOf(c.category);
    if (c.kind === 'ADD') {
      const ref = `@new:${added++}`; ops.push({ kind: 'ADD', category: c.category, statement: c.statement, value: c.value });
      content[section].push({ text: c.statement.slice(0, 500), requirementIds: [ref] });
      drivers.push({ id: `chg-${c.category.toLowerCase().replaceAll('_', '-')}-${added}`, name: `Changed requirement: ${c.category.toLowerCase().replaceAll('_', ' ')}`, description: c.statement.slice(0, 500), priority: 'HIGH', sourceRequirementIds: [ref] });
      continue;
    }
    const id = c.requirementCode ? args.requirementIdByCode[c.requirementCode] : undefined;
    if (!id) { errors.push(`Unknown requirement ${c.requirementCode}`); continue; }
    if (c.kind === 'MODIFY') {
      ops.push({ kind: 'MODIFY', requirementId: id, statement: c.statement, value: c.value }); let hit = false;
      for (const sec of Object.values(SECTION).concat(['functionalRequirements'])) for (const it of content[sec]) if (it.requirementIds.includes(id)) { it.text = c.statement.slice(0, 500); hit = true; }
      if (!hit) content[section].push({ text: c.statement.slice(0, 500), requirementIds: [id] });
    } else {
      ops.push({ kind: 'REMOVE', requirementId: id });
      for (const sec of new Set([...Object.values(SECTION), 'functionalRequirements' as const])) content[sec] = content[sec].map((it) => ({ ...it, requirementIds: it.requirementIds.filter((r) => r !== id) })).filter((it) => it.requirementIds.length > 0);
    }
  }
  content.keyAssumptions = [...content.keyAssumptions, { text: `Requirements changed after user approval: ${args.reason}`.slice(0, 500), requirementIds: [] }].slice(-20);
  content.architectureDrivers = drivers;
  const parsed = architectureBriefSchema.safeParse(content);
  if (!parsed.success) errors.push(...parsed.error.issues.slice(0, 3).map((i) => `Brief would be invalid at ${i.path.join('.')}: ${i.message}`));
  return { content: parsed.success ? parsed.data : content, drivers: parsed.success ? parsed.data.architectureDrivers : drivers, ops, errors };
}
