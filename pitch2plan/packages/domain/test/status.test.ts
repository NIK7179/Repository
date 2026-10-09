import { describe, expect, it } from 'vitest';
import { PROJECT_STATUSES, type ProjectStatus } from '@pitch2plan/schemas';
import {
  ALLOWED_TRANSITIONS, DomainError, assertTransition, canStartArchitectureGeneration, canTransition, evaluateConfirmation, seedRequirementsFromInterpretation,
  unknownsFromInterpretation, unresolvedCriticalUnknowns,
} from '../src';
import { architectureBriefSchema, type IdeaInterpretation } from '@pitch2plan/schemas';

describe('project status transitions', () => {
  it('allows the intended lifecycle in order', () => {
    const path: ProjectStatus[] = ['IDEA', 'DISCOVERY', 'REQUIREMENTS_CONFIRMED', 'ARCHITECTURE_GENERATING', 'ARCHITECTURE_READY', 'IMPLEMENTING'];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it('rejects skipping steps and going backwards where not defined', () => {
    for (const [from, to] of [['IDEA', 'REQUIREMENTS_CONFIRMED'], ['IDEA', 'ARCHITECTURE_READY'], ['DISCOVERY', 'ARCHITECTURE_GENERATING'], ['REQUIREMENTS_CONFIRMED', 'IMPLEMENTING'],
      ['ARCHITECTURE_READY', 'DISCOVERY'], ['IMPLEMENTING', 'DISCOVERY'], ['ARCHIVED', 'IDEA'], ['DISCOVERY', 'IDEA']] as const) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      expect(() => assertTransition(from, to)).toThrowError(DomainError);
    }
  });
  it('reports INVALID_STATE with the attempted transition', () => {
    try { assertTransition('IDEA', 'IMPLEMENTING'); } catch (e) { expect(e).toMatchObject({ code: 'INVALID_STATE', details: { from: 'IDEA', to: 'IMPLEMENTING' } }); }
  });
  it('covers every status, never transitions to itself, and ARCHIVED is terminal', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...PROJECT_STATUSES].sort());
    for (const s of PROJECT_STATUSES) expect(canTransition(s, s)).toBe(false);
    expect(ALLOWED_TRANSITIONS.ARCHIVED).toEqual([]);
  });
  it('allows architecture generation only from REQUIREMENTS_CONFIRMED', () => {
    for (const s of PROJECT_STATUSES) expect(canStartArchitectureGeneration(s)).toBe(s === 'REQUIREMENTS_CONFIRMED');
  });
});

describe('evaluateConfirmation', () => {
  const content = (o: object = {}) => architectureBriefSchema.parse({
    projectSummary: 'A real summary.', businessObjective: 'A real objective.', functionalRequirements: [{ text: 'Do a thing', requirementIds: ['r1'] }],
    architectureDrivers: [{ id: 'd1', name: 'Driver', description: 'Desc here', priority: 'HIGH', sourceRequirementIds: ['r1'] }], ...o,
  });
  it('passes a complete, fresh brief with no conflicts', () => { expect(evaluateConfirmation({ content: content(), stale: false, openConflicts: 0 })).toEqual([]); });
  it('blocks on stale briefs, open conflicts, a missing summary, no functional requirement and no drivers', () => {
    const codes = (i: Parameters<typeof evaluateConfirmation>[0]) => evaluateConfirmation(i).map((b) => b.code);
    expect(codes({ content: content(), stale: true, openConflicts: 0 })).toEqual(['BRIEF_STALE']);
    expect(codes({ content: content(), stale: false, openConflicts: 2 })).toEqual(['OPEN_CONFLICTS']);
    expect(codes({ content: { ...content(), projectSummary: '   ' }, stale: false, openConflicts: 0 })).toEqual(['NO_SUMMARY']);
    expect(codes({ content: content({ functionalRequirements: [] }), stale: false, openConflicts: 0 })).toEqual(['NO_FUNCTIONAL']);
    expect(codes({ content: content({ architectureDrivers: [] }), stale: false, openConflicts: 0 })).toEqual(['NO_DRIVERS']);
  });
  it('only treats OPEN critical unknowns as unresolved', () => {
    const list = [
      { id: 'U1', text: 'a', status: 'OPEN' as const, critical: true }, { id: 'U2', text: 'b', status: 'OPEN' as const, critical: false },
      { id: 'U3', text: 'c', status: 'RESOLVED' as const, critical: true }, { id: 'U4', text: 'd', status: 'ACCEPTED' as const, critical: true },
    ];
    expect(unresolvedCriticalUnknowns(list).map((u) => u.id)).toEqual(['U1']);
  });
});

describe('seeding from the interpretation', () => {
  const interp: IdeaInterpretation = {
    summary: 'A tool for finance teams.', problemStatement: 'Finance teams need reporting.',
    targetUsers: [{ text: 'finance team', origin: 'USER_STATED', evidence: 'finance team' }, { text: 'auditors', origin: 'AI_INFERRED' }],
    possibleCapabilities: [{ text: 'weekly summaries', origin: 'USER_STATED', evidence: 'weekly summaries' }, { text: 'export to spreadsheet', origin: 'AI_INFERRED' }],
    userStatedFacts: [{ statement: 'It must run entirely on-premises.', quote: 'It must run entirely on-premises.' }],
    inferredRequirements: [{ type: 'SECURITY', description: 'Financial data needs strict access control.', confidence: 0.6, origin: 'AI_INFERRED', rationale: 'Finance data.' }],
    assumptions: [], unknowns: ['Expected volume', 'Budget'], recommendedDiscoveryAreas: ['Scale'],
  };
  it('keeps origins exactly as labelled and never promotes inferences to user-stated', () => {
    const seed = seedRequirementsFromInterpretation(interp, 'FOUNDER');
    const byKey = Object.fromEntries(seed.map((s) => [s.key, s]));
    expect(byKey.seed_fact_1).toMatchObject({ origin: 'USER_STATED', category: 'FUNCTIONAL', quote: 'It must run entirely on-premises.', tags: ['DEPLOYMENT_ON_PREM'] });
    expect(byKey.seed_user_1).toMatchObject({ origin: 'USER_STATED', category: 'USERS' });
    expect(byKey.seed_cap_1).toMatchObject({ origin: 'AI_INFERRED', confidence: 0.5 });
    expect(byKey.seed_inf_1).toMatchObject({ origin: 'AI_INFERRED', category: 'SECURITY', confidence: 0.6 });
    expect(byKey.seed_team_level!.origin).toBe('SYSTEM_DERIVED');
    expect(seed.filter((s) => s.origin === 'USER_STATED').every((s) => !!s.quote)).toBe(true);
    expect(seedRequirementsFromInterpretation(interp).some((s) => s.key === 'seed_team_level')).toBe(false);
  });
  it('gives unknowns stable ids and starts them all critical and open', () => {
    expect(unknownsFromInterpretation(interp)).toEqual([
      { id: 'U1', text: 'Expected volume', status: 'OPEN', critical: true }, { id: 'U2', text: 'Budget', status: 'OPEN', critical: true },
    ]);
  });
});
