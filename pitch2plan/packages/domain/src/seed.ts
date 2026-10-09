import type { DiscoveryUnknown, IdeaInterpretation, RequirementCategory, TechnicalLevel } from '@pitch2plan/schemas';
import { inferTagsFromText } from '@pitch2plan/schemas';
import type { SeedRequirement } from './ports';

const CATEGORY_BY_INFERRED_TYPE: Record<string, RequirementCategory> = {
  FUNCTIONAL: 'FUNCTIONAL', NON_FUNCTIONAL: 'PERFORMANCE', DATA: 'DATA', INTEGRATION: 'INTEGRATION', SECURITY: 'SECURITY',
  COMPLIANCE: 'COMPLIANCE', OPERATIONAL: 'OBSERVABILITY', CONSTRAINT: 'OTHER',
};

/** Interpretation unknowns become discovery unknowns with stable ids (U1, U2, ...). All start as critical until the first gap analysis. */
export function unknownsFromInterpretation(i: IdeaInterpretation): DiscoveryUnknown[] {
  return i.unknowns.map((text, n) => ({ id: `U${n + 1}`, text, status: 'OPEN', critical: true }));
}

/**
 * Deterministic starting requirements, so discovery never starts from a blank slate and nothing is re-created from scratch later.
 * Origins are preserved exactly as the interpreter labelled them: quoted facts are USER_STATED, everything else stays AI_INFERRED.
 */
export function seedRequirementsFromInterpretation(i: IdeaInterpretation, technicalLevel?: TechnicalLevel | null): SeedRequirement[] {
  const out: SeedRequirement[] = [];
  i.userStatedFacts.forEach((f, n) => out.push({
    key: `seed_fact_${n + 1}`, category: 'FUNCTIONAL', statement: f.statement, origin: 'USER_STATED', confidence: null,
    tags: inferTagsFromText(`${f.statement} ${f.quote}`), quote: f.quote, sourceKind: 'PITCH_QUOTE',
  }));
  i.targetUsers.filter((u) => u.origin === 'USER_STATED').forEach((u, n) => out.push({
    key: `seed_user_${n + 1}`, category: 'USERS', statement: `Users include: ${u.text}`, origin: 'USER_STATED', confidence: null,
    tags: [], quote: u.evidence, sourceKind: 'PITCH_QUOTE',
  }));
  i.possibleCapabilities.filter((c) => c.origin === 'AI_INFERRED').forEach((c, n) => out.push({
    key: `seed_cap_${n + 1}`, category: 'FUNCTIONAL', statement: c.text, origin: 'AI_INFERRED', confidence: 0.5, tags: [], sourceKind: 'INTERPRETATION',
  }));
  i.inferredRequirements.forEach((r, n) => out.push({
    key: `seed_inf_${n + 1}`, category: CATEGORY_BY_INFERRED_TYPE[r.type] ?? 'OTHER', statement: r.description, origin: 'AI_INFERRED',
    confidence: r.confidence, tags: inferTagsFromText(r.description), sourceKind: 'INTERPRETATION',
  }));
  if (technicalLevel) out.push({
    key: 'seed_team_level', category: 'TEAM_CONSTRAINT', statement: `The person building this describes their background as: ${technicalLevel.toLowerCase()}.`,
    origin: 'SYSTEM_DERIVED', confidence: null, tags: [], sourceKind: 'INTERPRETATION',
  });
  return out;
}
