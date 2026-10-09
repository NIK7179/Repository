import { z } from 'zod';

/**
 * Controlled vocabulary the requirement extractor may attach to a requirement. Deterministic conflict
 * rules operate on these tags, never on free text, so detection is predictable and testable.
 */
export const REQUIREMENT_TAGS = [
  'DEPLOYMENT_ON_PREM', 'DEPLOYMENT_PUBLIC_CLOUD', 'DEPLOYMENT_HYBRID',
  'PROCESSING_REAL_TIME', 'PROCESSING_BATCH',
  'DATA_NO_EXTERNAL_SHARING', 'EXTERNAL_AI_PROVIDER',
] as const;
export const requirementTagSchema = z.enum(REQUIREMENT_TAGS);
export type RequirementTag = z.infer<typeof requirementTagSchema>;

export const TAG_PATTERNS: Array<[RegExp, RequirementTag]> = [
  [/\bon[- ]?prem(?:ise|ises)?\b|self[- ]hosted|own (?:data ?cent(?:er|re)s?|servers)/i, 'DEPLOYMENT_ON_PREM'],
  [/\b(?:aws|azure|gcp|google cloud|public cloud|amazon web services)\b/i, 'DEPLOYMENT_PUBLIC_CLOUD'],
  [/\bbatch\b|\bhourly\b|\bnightly\b/i, 'PROCESSING_BATCH'],
  [/real[- ]?time|sub-?second|\binstant(?:ly)?\b|\bimmediate(?:ly)?\b|<\s*100\s*ms|under (?:a|1|one) second/i, 'PROCESSING_REAL_TIME'],
  [/no (?:customer )?data (?:leaves|is shared)|not (?:share|send)[^.]{0,40}external|never leaves?/i, 'DATA_NO_EXTERNAL_SHARING'],
  [/openai|external (?:llm|model|ai)|hosted (?:llm|model)|claude api|third[- ]party (?:ai|model)/i, 'EXTERNAL_AI_PROVIDER'],
];

/** Used to tag deterministically-seeded requirements and by the dev mock provider. Real extraction tags via the model. */
export function inferTagsFromText(text: string): RequirementTag[] {
  return [...new Set(TAG_PATTERNS.filter(([re]) => re.test(text)).map(([, tag]) => tag))];
}

export interface ConflictRule { id: string; title: string; a: RequirementTag[]; b: RequirementTag[]; explain: string }

/** Extensible: add a rule here and it is applied everywhere. */
export const CONFLICT_RULES: ConflictRule[] = [
  { id: 'DEPLOYMENT_MODEL', title: 'Deployment conflict', a: ['DEPLOYMENT_ON_PREM'], b: ['DEPLOYMENT_PUBLIC_CLOUD'],
    explain: 'One requirement calls for running on your own infrastructure, while another calls for a public cloud.' },
  { id: 'PROCESSING_LATENCY', title: 'Timing conflict', a: ['PROCESSING_REAL_TIME'], b: ['PROCESSING_BATCH'],
    explain: 'One requirement needs results immediately, while another accepts periodic batch processing.' },
  { id: 'DATA_SHARING', title: 'Data-sharing conflict', a: ['DATA_NO_EXTERNAL_SHARING'], b: ['EXTERNAL_AI_PROVIDER'],
    explain: 'One requirement says data must not leave your control, while another relies on an external AI provider.' },
];

export interface TaggedRequirement { id: string; statement: string; tags: string[] }
export interface DetectedConflict { ruleId: string; title: string; description: string; severity: 'CRITICAL' | 'HIGH' | 'MEDIUM'; requirementIds: string[]; fingerprint: string }

export const conflictFingerprint = (prefix: string, ids: string[]) => `${prefix}:${[...ids].sort().join('+')}`;

export function detectRuleConflicts(reqs: TaggedRequirement[], rules: ConflictRule[] = CONFLICT_RULES): DetectedConflict[] {
  const out: DetectedConflict[] = [];
  for (const rule of rules) {
    const as = reqs.filter((r) => r.tags.some((t) => (rule.a as string[]).includes(t)));
    const bs = reqs.filter((r) => r.tags.some((t) => (rule.b as string[]).includes(t)));
    for (const x of as) for (const y of bs) {
      if (x.id === y.id) continue;
      out.push({
        ruleId: rule.id, title: rule.title, severity: 'HIGH', requirementIds: [x.id, y.id],
        description: `${rule.explain} (“${x.statement}” vs “${y.statement}”)`,
        fingerprint: conflictFingerprint(`RULE:${rule.id}`, [x.id, y.id]),
      });
    }
  }
  return out;
}

export const detectorOutputSchema = z.object({
  conflicts: z.array(z.object({
    title: z.string().min(3).max(160),
    description: z.string().min(10).max(600),
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM']),
    requirementKeys: z.array(z.string()).min(2).max(6),
  })).max(10),
});
export type DetectorOutput = z.infer<typeof detectorOutputSchema>;

export function validateDetectorOutput(out: DetectorOutput, activeKeys: string[]): string[] {
  const issues: string[] = [];
  const known = new Set(activeKeys);
  out.conflicts.forEach((c, i) => {
    if (new Set(c.requirementKeys).size !== c.requirementKeys.length) issues.push(`conflicts[${i}] repeats a requirement key.`);
    for (const k of c.requirementKeys) if (!known.has(k)) issues.push(`conflicts[${i}] references unknown requirement key "${k}".`);
  });
  return issues;
}
