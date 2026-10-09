import { z } from 'zod';

/**
 * FUTURE (Phase 3+): the structured architecture model. This is the source of truth.
 * React Flow is ONLY a renderer of this state and must never become the data model.
 */
export const architectureNodeSchema = z.object({
  /** Stable across architecture versions so tasks/decisions can keep pointing at it. */
  stableKey: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  technology: z.string().min(1).max(120),
  category: z.string().min(1).max(80),
  purpose: z.string().min(1).max(500),
});
export const architectureEdgeSchema = z.object({
  id: z.string().min(1),
  fromKey: z.string().min(1),
  toKey: z.string().min(1),
  protocol: z.string().max(60).optional(),
  description: z.string().max(300).optional(),
});
export const architectureDecisionSchema = z.object({
  id: z.string().min(1),
  nodeKey: z.string().min(1),
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(1000),
  requirementIds: z.array(z.string()).default([]),
  alternatives: z.array(z.string()).default([]),
});
export const architectureSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  nodes: z.array(architectureNodeSchema),
  edges: z.array(architectureEdgeSchema),
  decisions: z.array(architectureDecisionSchema),
});
export type Architecture = z.infer<typeof architectureSchema>;

/** Future entities (tables arrive with their phase's migration). */
export const requirementSchema = z.object({
  id: z.string(), projectId: z.string(), type: z.string(), description: z.string(),
  origin: z.enum(['USER_STATED', 'AI_INFERRED', 'USER_CONFIRMED']), confirmed: z.boolean(),
});
export const implementationPhaseSchema = z.object({ id: z.string(), architectureId: z.string(), name: z.string(), order: z.number().int() });
export const implementationTaskSchema = z.object({
  id: z.string(), phaseId: z.string(), nodeKey: z.string().optional(), title: z.string(),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED']),
});

export function validateArchitectureIntegrity(a: Architecture): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  for (const n of a.nodes) {
    if (keys.has(n.stableKey)) issues.push(`Duplicate node stableKey "${n.stableKey}".`);
    keys.add(n.stableKey);
  }
  for (const e of a.edges) {
    if (!keys.has(e.fromKey)) issues.push(`Edge ${e.id} references unknown node "${e.fromKey}".`);
    if (!keys.has(e.toKey)) issues.push(`Edge ${e.id} references unknown node "${e.toKey}".`);
  }
  for (const d of a.decisions) if (!keys.has(d.nodeKey)) issues.push(`Decision ${d.id} references unknown node "${d.nodeKey}".`);
  return issues;
}
