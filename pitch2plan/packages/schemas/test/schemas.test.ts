import { describe, expect, it } from 'vitest';
import {
  createProjectRequestSchema, ideaInterpretationSchema, submitPitchRequestSchema,
  validateInterpretationAgainstPitch, type IdeaInterpretation,
} from '../src';

const pitch = 'I want an app where customers book  haircuts.\nBarbers manage their own schedule.';
const valid: IdeaInterpretation = {
  summary: 'A booking app for haircuts.',
  problemStatement: 'Customers need an easy way to book haircuts with barbers.',
  targetUsers: [{ text: 'Customers', origin: 'USER_STATED', evidence: 'customers book haircuts' }],
  possibleCapabilities: [{ text: 'Online scheduling', origin: 'AI_INFERRED' }],
  userStatedFacts: [{ statement: 'Barbers manage their own schedule', quote: 'Barbers manage their own schedule' }],
  inferredRequirements: [{ type: 'FUNCTIONAL', description: 'Calendar availability per barber', confidence: 0.6, origin: 'AI_INFERRED', rationale: 'Barbers manage schedules.' }],
  assumptions: ['Single location'], unknowns: ['Expected number of barbers'], recommendedDiscoveryAreas: ['Scale'],
};

describe('ideaInterpretationSchema', () => {
  it('accepts a well-formed interpretation', () => {
    expect(ideaInterpretationSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects confidence outside 0..1', () => {
    const bad = { ...valid, inferredRequirements: [{ ...valid.inferredRequirements[0]!, confidence: 1.5 }] };
    expect(ideaInterpretationSchema.safeParse(bad).success).toBe(false);
  });
  it('never allows an inferred requirement to claim USER_STATED origin', () => {
    const bad = { ...valid, inferredRequirements: [{ ...valid.inferredRequirements[0]!, origin: 'USER_STATED' }] };
    expect(ideaInterpretationSchema.safeParse(bad).success).toBe(false);
  });
});

describe('validateInterpretationAgainstPitch', () => {
  it('accepts quotes that match despite case and whitespace differences', () => {
    expect(validateInterpretationAgainstPitch(valid, pitch)).toEqual([]);
  });
  it('flags a USER_STATED claim whose evidence is not in the pitch', () => {
    const fabricated = { ...valid, targetUsers: [{ text: 'Enterprise HR teams', origin: 'USER_STATED' as const, evidence: 'enterprise HR teams' }] };
    const issues = validateInterpretationAgainstPitch(fabricated, pitch);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/USER_STATED/);
  });
  it('flags a USER_STATED claim with no evidence at all', () => {
    const noEvidence = { ...valid, possibleCapabilities: [{ text: 'Payments', origin: 'USER_STATED' as const }] };
    expect(validateInterpretationAgainstPitch(noEvidence, pitch)).toHaveLength(1);
  });
  it('flags fabricated userStatedFacts quotes', () => {
    const bad = { ...valid, userStatedFacts: [{ statement: 'x', quote: 'It must use blockchain' }] };
    expect(validateInterpretationAgainstPitch(bad, pitch)).toHaveLength(1);
  });
});

describe('request schemas', () => {
  it('requires a meaningful project name and pitch', () => {
    expect(createProjectRequestSchema.safeParse({ name: 'a' }).success).toBe(false);
    expect(createProjectRequestSchema.safeParse({ name: 'Fraud detection' }).success).toBe(true);
    expect(submitPitchRequestSchema.safeParse({ content: 'too short' }).success).toBe(false);
  });
});

