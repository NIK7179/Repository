import type { ArchitectureDiff, DiffKind } from './change';

export const MIGRATION_OUTCOMES = ['CARRIED_FORWARD', 'REQUIRES_REVALIDATION', 'OBSOLETE', 'NEW', 'UNCHANGED_NOT_STARTED'] as const;
export type MigrationOutcome = (typeof MIGRATION_OUTCOMES)[number];
export interface MigTask { id: string; key: string; title: string; taskType: string; status: string; componentKeys: string[]; decisionKeys: string[] }
export interface MigItem { v1TaskId: string | null; v2TaskId: string | null; outcome: MigrationOutcome; reason: string; v1Status: string | null }
export interface MigrationSummary {
  carriedForward: number; requiresRevalidation: number; obsoleteCompleted: number; obsoleteOther: number; newTasks: number; unchangedNotStarted: number;
  completedInV1: number; v1Tasks: number; v2Tasks: number;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
export const titleSimilarity = (a: string, b: string) => { const x = words(a), y = words(b); if (!x.size || !y.size) return 0; let i = 0; for (const w of x) if (y.has(w)) i++; return i / (x.size + y.size - i); };
const CROSS_CUTTING_REVIEW = ['SECURITY', 'TESTING', 'OBSERVABILITY', 'DEPLOYMENT', 'VALIDATION'];

/**
 * Deterministic task mapping from plan V1 to plan V2, driven by the architecture diff (stored data), never by a model.
 *
 * Matching (one-to-one): the same task key (the planner's task identity), else the same task type AND the same set of component stableKeys AND a similar title.
 * Outcome for a matched pair, in this order of precedence:
 *   1. A component the task belongs to was REPLACED or REMOVED  -> completed/in-progress work is OBSOLETE and the V2 task is NEW (work is never carried onto a different technology).
 *   2. A component was MODIFIED, a connection touching it changed, or a decision it carries out was modified/superseded -> completed work REQUIRES_REVALIDATION.
 *   3. Otherwise completed work is CARRIED_FORWARD.
 * Anything not completed stays NOT_STARTED in V2 (UNCHANGED_NOT_STARTED): nothing half-done is ever carried.
 * Cross-component-less tasks (foundations) carry forward unless they are security/testing/observability/deployment/validation and the architecture changed at all.
 * INVARIANT (tested as a property): CARRIED_FORWARD implies every linked component is UNCHANGED, no touching connection changed and no carried decision changed.
 */
export function mapTasksAcrossPlans(v1: MigTask[], v2: MigTask[], diff: ArchitectureDiff): { items: MigItem[]; summary: MigrationSummary } {
  const nodeKind = new Map<string, DiffKind>();
  for (const n of diff.nodes) { if (n.from) nodeKind.set(n.from.stableKey, n.kind); else if (n.to) nodeKind.set(n.to.stableKey, n.kind); }
  const kindOf = (k: string): DiffKind => nodeKind.get(k) ?? 'REMOVED'; // unknown to the diff: treat as gone (safe)
  const changedEdges = diff.edges.filter((e) => e.kind !== 'UNCHANGED' || e.touchesChangedComponent);
  const decisionBad = new Set(diff.decisions.filter((d) => d.kind === 'MODIFIED' || d.kind === 'SUPERSEDED' || d.kind === 'REMOVED').map((d) => d.key));
  const anyChange = diff.nodes.some((n) => n.kind !== 'UNCHANGED') || diff.edges.some((e) => e.kind !== 'UNCHANGED') || diff.decisions.some((d) => d.kind !== 'UNCHANGED');

  // ---- one-to-one matching
  const pairs: Array<[MigTask, MigTask]> = []; const used2 = new Set<string>(), used1 = new Set<string>();
  const byKey2 = new Map(v2.map((t) => [t.key, t]));
  for (const t1 of v1) { const t2 = byKey2.get(t1.key); if (t2 && !used2.has(t2.id)) { pairs.push([t1, t2]); used1.add(t1.id); used2.add(t2.id); } }
  const sig = (t: MigTask) => `${t.taskType}|${[...t.componentKeys].sort().join(',')}`;
  for (const t1 of v1) {
    if (used1.has(t1.id) || !t1.componentKeys.length) continue;
    const best = v2.filter((t2) => !used2.has(t2.id) && sig(t2) === sig(t1)).map((t2) => ({ t2, s: titleSimilarity(t1.title, t2.title) })).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s)[0];
    if (best) { pairs.push([t1, best.t2]); used1.add(t1.id); used2.add(best.t2.id); }
  }

  const items: MigItem[] = [];
  const done = (s: string) => s === 'COMPLETED'; const worked = (s: string) => s === 'COMPLETED' || s === 'IN_PROGRESS';
  for (const [t1, t2] of pairs) {
    const kinds = t1.componentKeys.map((k) => ({ k, kind: kindOf(k) }));
    const gone = kinds.filter((x) => x.kind === 'REPLACED' || x.kind === 'REMOVED');
    const modified = kinds.filter((x) => x.kind === 'MODIFIED');
    const edgeHit = t1.componentKeys.length ? changedEdges.filter((e) => t1.componentKeys.includes(e.source) || t1.componentKeys.includes(e.target)) : [];
    const decisionHit = t1.decisionKeys.filter((d) => decisionBad.has(d));
    const crossCuttingHit = !t1.componentKeys.length && CROSS_CUTTING_REVIEW.includes(t1.taskType) && anyChange;
    const base = { v1Status: t1.status };
    if (gone.length) {
      const why = `Component ${gone.map((g) => `"${g.k}" was ${g.kind === 'REPLACED' ? 'replaced' : 'removed'}`).join(', ')}.`;
      if (worked(t1.status)) { items.push({ ...base, v1TaskId: t1.id, v2TaskId: null, outcome: 'OBSOLETE', reason: `${why} Work done on the previous technology does not carry over.` }, { v1TaskId: null, v2TaskId: t2.id, v1Status: null, outcome: 'NEW', reason: `Replaces obsolete work from plan v1 ("${t1.title}").` }); }
      else items.push({ ...base, v1TaskId: t1.id, v2TaskId: t2.id, outcome: 'UNCHANGED_NOT_STARTED', reason: `${why} This task had not been done; it is regenerated for the new architecture.` });
      continue;
    }
    const reasons = [
      ...modified.map((m) => `component "${m.k}" was modified`), ...(edgeHit.length ? [`${edgeHit.length} connection(s) it depends on changed (${[...new Set(edgeHit.map((e) => e.edgeKey))].slice(0, 3).join(', ')})`] : []),
      ...decisionHit.map((d) => `decision ${d.toUpperCase()} changed`), ...(crossCuttingHit ? ['the architecture changed and this task covers it system-wide'] : []),
    ];
    if (reasons.length) {
      if (done(t1.status)) items.push({ ...base, v1TaskId: t1.id, v2TaskId: t2.id, outcome: 'REQUIRES_REVALIDATION', reason: `Completed in plan v1, but ${reasons.join('; ')}. Confirm it still holds.` });
      else items.push({ ...base, v1TaskId: t1.id, v2TaskId: t2.id, outcome: 'UNCHANGED_NOT_STARTED', reason: `Not completed in plan v1 (${t1.status.toLowerCase().replaceAll('_', ' ')}); ${reasons.join('; ')}.` });
      continue;
    }
    if (done(t1.status)) items.push({ ...base, v1TaskId: t1.id, v2TaskId: t2.id, outcome: 'CARRIED_FORWARD', reason: 'Its components, connections and decisions are unchanged.' });
    else items.push({ ...base, v1TaskId: t1.id, v2TaskId: t2.id, outcome: 'UNCHANGED_NOT_STARTED', reason: t1.status === 'NOT_STARTED' ? 'Unchanged and not started.' : `Unchanged; it was ${t1.status.toLowerCase().replaceAll('_', ' ')} in plan v1 and starts again in plan v2.` });
  }
  for (const t1 of v1) if (!used1.has(t1.id)) items.push({ v1TaskId: t1.id, v2TaskId: null, v1Status: t1.status, outcome: 'OBSOLETE', reason: 'No equivalent task exists in plan v2.' });
  for (const t2 of v2) if (!used2.has(t2.id)) items.push({ v1TaskId: null, v2TaskId: t2.id, v1Status: null, outcome: 'NEW', reason: 'New work required by the changed architecture.' });

  const c = (o: MigrationOutcome, f: (i: MigItem) => boolean = () => true) => items.filter((i) => i.outcome === o && f(i)).length;
  return {
    items,
    summary: { carriedForward: c('CARRIED_FORWARD'), requiresRevalidation: c('REQUIRES_REVALIDATION'), obsoleteCompleted: c('OBSOLETE', (i) => i.v1Status === 'COMPLETED'), obsoleteOther: c('OBSOLETE', (i) => i.v1Status !== 'COMPLETED'), newTasks: c('NEW'), unchangedNotStarted: c('UNCHANGED_NOT_STARTED'), completedInV1: v1.filter((t) => done(t.status)).length, v1Tasks: v1.length, v2Tasks: v2.length },
  };
}

/** Structural invariants of any mapping: every V1 and V2 task appears exactly once, and an outcome matches the presence of its two sides. */
export function checkMigrationInvariants(items: MigItem[], v1: MigTask[], v2: MigTask[]): string[] {
  const out: string[] = []; const s1 = new Map<string, number>(), s2 = new Map<string, number>();
  for (const i of items) {
    if (i.v1TaskId) s1.set(i.v1TaskId, (s1.get(i.v1TaskId) ?? 0) + 1); if (i.v2TaskId) s2.set(i.v2TaskId, (s2.get(i.v2TaskId) ?? 0) + 1);
    if (i.outcome === 'NEW' && (i.v1TaskId || !i.v2TaskId)) out.push('NEW needs only a V2 task');
    if (i.outcome === 'OBSOLETE' && (!i.v1TaskId || i.v2TaskId)) out.push('OBSOLETE needs only a V1 task');
    if (['CARRIED_FORWARD', 'REQUIRES_REVALIDATION', 'UNCHANGED_NOT_STARTED'].includes(i.outcome) && (!i.v1TaskId || !i.v2TaskId)) out.push(`${i.outcome} needs both tasks`);
    if (i.outcome === 'CARRIED_FORWARD' && i.v1Status !== 'COMPLETED') out.push('only completed work can be carried forward');
    if (i.outcome === 'REQUIRES_REVALIDATION' && i.v1Status !== 'COMPLETED') out.push('only completed work can require revalidation');
  }
  for (const t of v1) if (s1.get(t.id) !== 1) out.push(`V1 task ${t.key} appears ${s1.get(t.id) ?? 0} times`);
  for (const t of v2) if (s2.get(t.id) !== 1) out.push(`V2 task ${t.key} appears ${s2.get(t.id) ?? 0} times`);
  return out;
}
