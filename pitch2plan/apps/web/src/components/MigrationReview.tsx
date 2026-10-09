'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Skeleton } from '@pitch2plan/ui';
import { ApiError, call, type PlanDiffDto } from '@/lib/api-client';
import { statusLabel, statusTone } from '@/lib/impl-labels';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.'));
type Row = PlanDiffDto['items'][number];
const OUTCOMES: Array<{ key: 'carried' | 'revalidation' | 'removed' | 'added' | 'unchanged'; title: string; icon: string; tone: 'ok' | 'warn' | 'danger' | 'accent' | 'neutral'; blurb: string }> = [
  { key: 'carried', title: 'Completed tasks carried forward', icon: '✓', tone: 'ok', blurb: 'Nothing they depend on changed, so your completion carries over.' },
  { key: 'revalidation', title: 'Completed tasks that need re-confirming', icon: '↻', tone: 'warn', blurb: 'The component or decision behind them changed. They start again in the new plan and need your confirmation; your original completion stays in the old plan.' },
  { key: 'removed', title: 'Tasks that became obsolete', icon: '✕', tone: 'danger', blurb: 'They belong to something the new architecture no longer has. They stay in the old plan’s history.' },
  { key: 'added', title: 'New tasks', icon: '＋', tone: 'accent', blurb: 'Work the new architecture needs.' },
  { key: 'unchanged', title: 'Not started and unchanged', icon: '=', tone: 'neutral', blurb: 'Still to do, exactly as before.' },
];

/** Reviewing is mandatory: progress is never moved to the new plan silently. */
export function MigrationReview({ projectId, toPlanId, fromPlanId }: { projectId: string; toPlanId: string; fromPlanId?: string }) {
  const [d, setD] = useState<PlanDiffDto | null>(null); const [error, setError] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false); const [open, setOpen] = useState<Record<string, boolean>>({ revalidation: true });
  const load = useCallback(async () => {
    try {
      let from = fromPlanId;
      if (!from) { const o = await call<{ implementation: { plan: { version: { id: string } } | null } }>(`/api/projects/${projectId}/implementation`); from = o.implementation.plan?.version.id; }
      if (!from) throw new ApiError('PLAN_NOT_FOUND', 'There is no active implementation plan to migrate from.');
      const r = await call<{ diff: PlanDiffDto }>(`/api/implementation/plans/${from}/diff/${toPlanId}`); setD(r.diff); setError(null);
    } catch (e) { setError(asError(e)); }
  }, [projectId, toPlanId, fromPlanId]);
  useEffect(() => { void load(); }, [load]);
  async function accept() { setBusy(true); setError(null); try { await call(`/api/implementation/plans/${toPlanId}/accept-migration`, { method: 'POST' }); await load(); } catch (e) { setError(asError(e)); await load(); } finally { setBusy(false); } }

  if (!d) return error ? <Alert title="We couldn’t load the plan comparison">{error.message}</Alert> : <div role="status" aria-label="Loading comparison" className="space-y-3"><Skeleton className="h-8 w-72" /><Skeleton className="h-64 w-full" /></div>;
  const s = d.summary; const accepted = d.source === 'ACCEPTED';
  const counts: Record<string, number> = { carried: s.carriedForward, revalidation: s.requiresRevalidation, removed: s.obsoleteCompleted + s.obsoleteOther, added: s.newTasks, unchanged: s.unchangedNotStarted };
  return (
    <div className="space-y-4" data-testid="migration-review">
      <header><p className="text-xs uppercase tracking-wide text-muted">Implementation plan</p><h1 className="text-xl font-semibold" data-testid="migration-title">Plan V{d.from.versionNumber} → V{d.to.versionNumber}</h1>
        <p className="mt-1 text-sm text-muted">Architecture V{d.to.versionNumber} changed what must be built. Review how your progress maps onto the new plan before it becomes active. Plan V{d.from.versionNumber} and everything you completed in it are kept unchanged.</p></header>
      {error && <Alert title="That didn’t work">{error.message}</Alert>}
      {accepted ? <Alert tone="neutral" title="Migration accepted">Plan V{d.to.versionNumber} is now your active plan. <Link className="underline" href={`/projects/${projectId}/implementation`} data-testid="go-implementation">Open the roadmap</Link>.</Alert> : !d.canAccept ? <Alert tone="warn" title="This plan is not waiting for review">It is not a pending plan that supersedes the active one.</Alert> : null}
      <section aria-label="Summary" data-testid="migration-summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {OUTCOMES.map((o) => <div key={o.key} className="rounded-lg border border-border bg-panel p-3"><div className="flex items-center gap-2"><Badge tone={o.tone}><span aria-hidden>{o.icon} </span>{o.key === 'carried' ? 'Carried forward' : o.key === 'revalidation' ? 'Needs re-confirming' : o.key === 'removed' ? 'Obsolete' : o.key === 'added' ? 'New' : 'Unchanged'}</Badge></div><p className="mt-2 text-2xl font-semibold" data-testid={`count-${o.key}`}>{counts[o.key]}</p></div>)}
      </section>
      <p className="text-sm text-muted">{s.completedInV1} task{s.completedInV1 === 1 ? '' : 's'} were completed in V{d.from.versionNumber}: <strong>{s.carriedForward}</strong> carried forward, <strong>{s.requiresRevalidation}</strong> need re-confirming, <strong>{s.obsoleteCompleted}</strong> became obsolete.</p>

      {OUTCOMES.map((o) => {
        const rows: Row[] = d[o.key as 'carried'] as Row[]; const isOpen = open[o.key] ?? false;
        return (
          <section key={o.key} data-testid={`group-${o.key}`} className="rounded-lg border border-border bg-panel">
            <button aria-expanded={isOpen} onClick={() => setOpen({ ...open, [o.key]: !isOpen })} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"><span><span className="text-sm font-semibold">{o.title}</span> <Badge tone={o.tone}>{rows.length}</Badge><span className="mt-0.5 block text-xs text-muted">{o.blurb}</span></span><span aria-hidden className="text-muted">{isOpen ? '▾' : '▸'}</span></button>
            {isOpen && (rows.length === 0 ? <p className="border-t border-border px-4 py-3 text-sm text-muted">None.</p> : <ul className="divide-y divide-border border-t border-border">{rows.map((r, i) => (
              <li key={i} className="px-4 py-2.5 text-sm"><div className="flex flex-wrap items-center gap-2">{r.v1 && <><Badge tone={statusTone(r.v1.status ?? 'NOT_STARTED')}>V{d.from.versionNumber}: {statusLabel(r.v1.status ?? 'NOT_STARTED')}</Badge><span>{r.v1.title}</span></>}{r.v1 && r.v2 && <span aria-hidden className="text-muted">→</span>}{r.v2 && <><Badge>V{d.to.versionNumber}</Badge><span className="font-medium">{r.v2.title}</span></>}</div><p className="mt-0.5 text-xs text-muted">{r.reason}</p></li>))}</ul>)}
          </section>);
      })}
      {d.changed.length > 0 && <section className="rounded-lg border border-border bg-panel p-4 text-sm" data-testid="group-changed"><h2 className="font-semibold">Tasks whose instructions changed ({d.changed.length})</h2><ul className="mt-2 list-disc space-y-1 pl-5">{d.changed.map((r, i) => <li key={i}>{r.v2?.title ?? r.v1?.title}</li>)}</ul></section>}
      {d.newBlockers.length > 0 && <section className="rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm" data-testid="new-blockers"><h2 className="font-semibold">New blockers</h2><p className="text-xs text-muted">These tasks now wait on work that has to be redone or added.</p><ul className="mt-2 list-disc space-y-1 pl-5">{d.newBlockers.map((b) => <li key={b.id}>{b.title} <span className="text-muted">(waiting on {b.waitingOn.join(', ')})</span></li>)}</ul></section>}

      {!accepted && d.canAccept && (
        <div className="sticky bottom-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panel p-4 shadow-sm" data-testid="accept-bar">
          <Button data-testid="accept-migration" loading={busy} onClick={() => void accept()}>Accept migration and activate plan V{d.to.versionNumber}</Button>
          <span className="text-sm text-muted">{s.requiresRevalidation > 0 ? `${s.requiresRevalidation} task${s.requiresRevalidation === 1 ? '' : 's'} will need your confirmation again. ` : ''}Nothing in plan V{d.from.versionNumber} is modified.</span>
        </div>)}
    </div>
  );
}
