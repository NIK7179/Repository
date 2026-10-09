import { z } from 'zod';

/**
 * Every claim in an interpretation is labelled with its origin so the UI can
 * never present an inference as something the user explicitly asked for.
 *  - USER_STATED: must be backed by a verbatim quote from the pitch (checked semantically).
 *  - AI_INFERRED: the model's own assumption; never treated as confirmed.
 */
export const originSchema = z.enum(['USER_STATED', 'AI_INFERRED']);
export type Origin = z.infer<typeof originSchema>;

const attributedItem = z.object({
  text: z.string().min(1).max(300),
  origin: originSchema,
  /** Verbatim quote from the pitch. Required when origin is USER_STATED. */
  evidence: z.string().max(400).optional(),
});

export const requirementTypeSchema = z.enum([
  'FUNCTIONAL', 'NON_FUNCTIONAL', 'DATA', 'INTEGRATION', 'SECURITY', 'COMPLIANCE', 'OPERATIONAL', 'CONSTRAINT',
]);

export const ideaInterpretationSchema = z.object({
  summary: z.string().min(10).max(600),
  problemStatement: z.string().min(10).max(600),
  targetUsers: z.array(attributedItem).max(10),
  possibleCapabilities: z.array(attributedItem).max(15),
  userStatedFacts: z.array(z.object({ statement: z.string().min(1).max(300), quote: z.string().min(1).max(400) })).max(15),
  inferredRequirements: z.array(z.object({
    type: requirementTypeSchema,
    description: z.string().min(5).max(400),
    confidence: z.number().min(0).max(1),
    origin: z.literal('AI_INFERRED'),
    rationale: z.string().min(3).max(400),
  })).max(20),
  assumptions: z.array(z.string().min(1).max(300)).max(15),
  unknowns: z.array(z.string().min(1).max(300)).max(20),
  recommendedDiscoveryAreas: z.array(z.string().min(1).max(200)).min(1).max(12),
});
export type IdeaInterpretation = z.infer<typeof ideaInterpretationSchema>;

export function normalizeForQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

/**
 * Semantic validation: checks that cannot be expressed in the schema alone.
 * Returns human-readable issues (empty array = valid). Used by the AI pipeline
 * to decide whether to attempt a repair.
 */
export function validateInterpretationAgainstPitch(output: IdeaInterpretation, pitch: string): string[] {
  const issues: string[] = [];
  const haystack = normalizeForQuote(pitch);
  const quoteOk = (q: string | undefined) => !!q && haystack.includes(normalizeForQuote(q));

  const checkAttributed = (label: string, items: IdeaInterpretation['targetUsers']) =>
    items.forEach((item, i) => {
      if (item.origin === 'USER_STATED' && !quoteOk(item.evidence)) {
        issues.push(`${label}[${i}] "${item.text}" is marked USER_STATED but has no verbatim evidence in the pitch. Mark it AI_INFERRED or quote the pitch.`);
      }
    });
  checkAttributed('targetUsers', output.targetUsers);
  checkAttributed('possibleCapabilities', output.possibleCapabilities);

  output.userStatedFacts.forEach((f, i) => {
    if (!quoteOk(f.quote)) issues.push(`userStatedFacts[${i}] quote is not found verbatim in the pitch.`);
  });
  return issues;
}
