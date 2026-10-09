'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Skeleton } from '@pitch2plan/ui';
import { ApiError, call, type ImplementationOverviewDto, type PlanDto, type PlanTaskDto } from '@/lib/api-client';
import { readinessLabel, statusLabel, statusTone, typeLabel } from '@/lib/impl-labels';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.'));
const POLL_MS = 1500;
const STAGES: Array<[string, string]> = [['LOADING_ARCHITECTURE', 'Reading your architecture'], ['PLANNING', 'Planning the work'], ['VALIDATING', 'Checking references and ordering'], ['REVIEWING', 'Reviewing for gaps'], ['REPAIRING', 'Fixing what the review found'], ['PERSISTING', 'Saving the plan']];
type Filter = 'ALL' | 'READY' | 'BLOCKED' | 'COMPLETED';
const FILTERS: Array<[Filter, string]> = [['ALL', 'All'], ['READY', 'Ready'], ['BLOCKED', 'Blocked'], ['COMPLETED', 'Completed']];
/** Blocked = the user marked it blocked, or it cannot start yet because a prerequisite is unfinished. */
const matches = (t: PlanTaskDto, f: Filter) => f === 'ALL' || (f === 'READY' && t.readiness === 'READY') || (f === 'BLOCKED' && (t.status === 'BLOCKED' || t.readiness === 'WAITING')) || (f === 'COMPLETED' && (t.status === 'COMPLETED' || t.status === 'SKIPPED'));

function Progress({ percent, label }: { percent: number; label: string }) {
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 w-full overflow-hidden rounded bg-subtle"><div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} /></div>;
}

function Generating({ run }: { run: ImplementationOverviewDto['run'] }) {
  const idx = Math.max(0, STAGES.findIndex(([k]) => k === run?.currentStage));
  return (
    <div data-testid="implementation-progress" role="status" aria-label="Planning the implementation" className="mx-auto max-w-lg rounded-lg border border-border bg-panel p-6">
      <h2 className="text-base font-semibold">Planning your implementation</h2>
      <p className="mt-1 text-sm text-muted">Turning your architecture into ordered, project-specific tasks. This usually takes a minute or two and keeps running if you leave.</p>
      <ol className="mt-4 space-y-2 text-sm">{STAGES.map(([k, label], i) => <li key={k} aria-current={i === idx ? 'step' : undefined} className={i < idx ? 'text-muted' : i === idx ? 'font-medium' : 'text-muted/60'}>{i < idx ? '✓' : i === idx ? '●' : '○'} {label}{k === 'REPAIRING' && run && run.repairCount > 0 && i === idx ? ` (attempt ${run.repairCount})` : ''}</li>)}</ol>
    </div>
  );
}

export function ImplementationView({ projectId, decisionFilter, componentFilter }: { projectId: string; decisionFilter?: string; componentFilter?: string }) {
  const [data, setData] = useState<ImplementationOverviewDto | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [open, setOpen] = useState<Record<string, boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try { const r = await call<{ implementation: ImplementationOverviewDto }>(`/api/projects/${projectId}/implementation`); setData(r.implementation); setError(null); return r.implementation; }
    catch (e) { setError(asError(e)); return null; }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Also poll while a plan for a newer architecture version is being generated (after an approved change): the active plan is
    // READY meanwhile, and the pending-migration banner must appear when that run finishes.
    const running = data?.run?.status === 'QUEUED' || data?.run?.status === 'RUNNING';
    if (data?.state !== 'GENERATING' && !running) return;
    timer.current = setTimeout(() => void load(), POLL_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [data, load]);

  async function generate() {
    setBusy(true); setError(null);
    try { await call(`/api/projects/${projectId}/implementation/generate`, { method: 'POST' }); await load(); } catch (e) { setError(asError(e)); await load(); } finally { setBusy(false); }
  }

  const plan = data?.plan ?? null;
  const names = useMemo(() => new Map((plan?.coverage.components ?? []).map((c) => [c.stableKey, c.name])), [plan]);
  const current = plan?.phases.find((p) => p.status === 'IN_PROGRESS' || p.status === 'BLOCKED') ?? plan?.phases.find((p) => p.status === 'NOT_STARTED') ?? null;
  const expanded = (key: string) => (open ? open[key] ?? false : key === current?.key);
  const toggle = (key: string) => setOpen({ ...(open ?? (current ? { [current.key]: true } : {})), [key]: !expanded(key) });

  if (!data) return error ? <Alert title="We couldn’t load the implementation plan" action={<Button variant="secondary" onClick={() => void load()}>Retry</Button>}>{error.message}</Alert> : <div role="status" aria-label="Loading implementation" className="space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>;
  if (data.state === 'NOT_AVAILABLE') return <Alert tone="neutral" title="Generate the architecture first" action={<Link href={`/projects/${projectId}/architecture`}><Button variant="secondary">Go to the architecture</Button></Link>}>The implementation plan is built from a ready architecture.</Alert>;
  if (data.state === 'GENERATING') return <Generating run={data.run} />;
  if (data.state === 'NOT_STARTED' || data.state === 'FAILED') {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        {data.state === 'FAILED' && data.run && <Alert title="Implementation planning couldn’t be completed."><span data-testid="failure-message">{data.run.failureMessage}</span><span className="mt-1 block text-xs opacity-80">Failure code: {data.run.failureCode}. Your architecture is unchanged and nothing was lost.</span></Alert>}
        {error && <Alert title="That didn’t work">{error.message}</Alert>}
        <div className="rounded-lg border border-border bg-panel p-6">
          <h2 className="text-lg font-semibold">Turn your architecture into a plan you can follow</h2>
          <p className="mt-2 text-sm text-muted">Pitch2Plan will read your architecture, its decisions and your requirements, then produce ordered phases and tasks for exactly this system, with validation steps for each and the architecture component each one belongs to.</p>
          <Button className="mt-4" onClick={() => void generate()} loading={busy}>{data.state === 'FAILED' ? 'Retry Implementation Plan' : 'Generate implementation plan'}</Button>
        </div>
      </div>
    );
  }
  const p = plan as PlanDto;
  const shown = (t: PlanTaskDto) => matches(t, filter) && (!decisionFilter || t.decisionKeys.includes(decisionFilter)) && (!componentFilter || t.componentKeys.includes(componentFilter));
  const counts = Object.fromEntries(FILTERS.map(([f]) => [f, p.tasks.filter((t) => matches(t, f)).length])) as Record<Filter, number>;
  const o = p.progress.overall; const blocked = p.tasks.filter((t) => t.status === 'BLOCKED').length;

  return (
    <div className="space-y-5">
      <section data-testid="impl-progress" className="rounded-lg border border-border bg-panel p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-base font-semibold">Implementation progress</h2><p className="text-sm text-muted"><span data-testid="progress-summary">{o.completed} of {o.applicable} tasks complete · {o.percent}%</span>{o.skipped > 0 && ` · ${o.skipped} skipped (not counted)`}{blocked > 0 && <span className="text-danger"> · {blocked} blocked</span>}</p></div>
        <div className="mt-2"><Progress percent={o.percent} label="Overall implementation progress" /></div>
        <p className="mt-2 text-xs text-muted">{current ? <>Current phase: <span className="font-medium text-fg" data-testid="current-phase">{current.name}</span> · </> : 'All phases complete · '}Plan v{p.version.versionNumber} for architecture v{p.version.architectureVersionNumber}</p>
      </section>

      {data.pendingMigration && (
        <div data-testid="pending-migration"><Alert tone="warn" title="A new implementation plan is waiting for your review" action={<Link href={`/projects/${projectId}/implementation/migration/${data.pendingMigration.planVersionId}?from=${p.version.id}`}><Button>Review progress migration</Button></Link>}>
          The architecture changed, so a new plan (V{data.pendingMigration.versionNumber}) was prepared. Your current plan and progress are unchanged until you review and accept how progress carries over.</Alert></div>)}
      {p.next && (
        <section data-testid="next-task" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/5 p-4">
          <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-accent">{p.next.kind === 'CONTINUE' ? 'Continue where you left off' : 'Recommended next step'}</p><h3 className="truncate text-base font-semibold">{p.next.title}</h3><p className="text-sm text-muted">{p.next.reason}</p></div>
          <Link href={`/projects/${projectId}/implementation/tasks/${p.next.taskId}`}><Button>{p.next.kind === 'CONTINUE' ? 'Continue task' : 'Open task'}</Button></Link>
        </section>
      )}
      {p.openFindings.length > 0 && <Alert tone="warn" title="The plan’s own review left some notes">{p.openFindings.map((f, i) => <span key={i} className="block">{f.severity.toLowerCase()} · {f.description}</span>)}</Alert>}
      {(decisionFilter || componentFilter) && <p className="text-sm" data-testid="active-filter">Showing tasks for {decisionFilter ? `decision ${decisionFilter.toUpperCase()}` : `component ${names.get(componentFilter!) ?? componentFilter}`}. <Link className="text-accent underline" href={`/projects/${projectId}/implementation`}>Show all</Link></p>}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" aria-label="Task filter" className="flex gap-1">{FILTERS.map(([f, label]) => <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={`rounded-md border px-3 py-1 text-sm ${filter === f ? 'border-accent bg-accent/10 font-medium' : 'border-border text-muted hover:bg-subtle'}`}>{label} <span className="text-xs opacity-70">{counts[f]}</span></button>)}</div>
            <div className="flex gap-2 text-xs"><button className="text-muted underline" onClick={() => setOpen(Object.fromEntries(p.phases.map((x) => [x.key, true])))}>Expand all</button><button className="text-muted underline" onClick={() => setOpen({})}>Collapse all</button></div>
          </div>
          <ol className="space-y-3">
            {p.phases.map((ph, i) => {
              const tasks = p.tasks.filter((t) => t.phaseKey === ph.key); const visible = tasks.filter(shown); const isOpen = expanded(ph.key);
              return (
                <li key={ph.key} data-testid={`phase-${ph.key}`} className="rounded-lg border border-border bg-panel">
                  <button aria-expanded={isOpen} aria-controls={`phase-body-${ph.key}`} onClick={() => toggle(ph.key)} className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left">
                    <span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted">{i + 1}</span><span className="text-sm font-semibold">{ph.name}</span><Badge tone={statusTone(ph.status)}>{statusLabel(ph.status)}</Badge></span>
                      <span className="mt-0.5 block text-xs text-muted">{ph.taskCount} tasks · {ph.progress.completed} complete{ph.waitingOnPhases.length > 0 && ` · waiting on ${ph.waitingOnPhases.map((k) => p.phases.find((x) => x.key === k)?.name ?? k).join(', ')}`}</span></span>
                    <span aria-hidden className="text-muted">{isOpen ? '▾' : '▸'}</span>
                  </button>
                  <div className="px-4 pb-2"><Progress percent={ph.progress.percent} label={`${ph.name} progress`} /></div>
                  {isOpen && (
                    <div id={`phase-body-${ph.key}`} className="border-t border-border">
                      <p className="px-4 pt-3 text-sm text-muted">{ph.objective}</p>
                      {visible.length === 0 ? <p className="px-4 py-3 text-sm text-muted">No tasks match this filter.</p> : (
                        <ul className="divide-y divide-border">{visible.map((t) => (
                          <li key={t.id} data-testid={`task-${t.key}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                            <Link href={`/projects/${projectId}/implementation/tasks/${t.id}`} className="min-w-0 flex-1 text-sm font-medium hover:underline">{t.title}</Link>
                            <Badge tone={statusTone(t.status)}>{statusLabel(t.status)}</Badge>
                            {t.status === 'NOT_STARTED' && <Badge tone={t.readiness === 'READY' ? 'accent' : 'neutral'}><span title={t.unmetDependencies.join(', ')}>{readinessLabel(t.readiness, t.unmetDependencies.length)}</span></Badge>}
                            <span className="text-xs text-muted">{typeLabel(t.taskType)} · {t.effort.toLowerCase()}</span>
                            {t.componentKeys.slice(0, 2).map((k) => <Link key={k} href={`/projects/${projectId}/components/${k}`} className="rounded border border-border px-1.5 text-xs text-muted hover:bg-subtle">{names.get(k) ?? k}</Link>)}
                            {t.dependsOn.length > 0 && <span className="text-xs text-muted" title={t.dependsOn.join(', ')}>↳ {t.dependsOn.length} prerequisite{t.dependsOn.length === 1 ? '' : 's'}</span>}
                          </li>))}</ul>)}
                    </div>)}
                </li>
              );
            })}
          </ol>
        </div>

        <aside data-testid="coverage" aria-label="Architecture coverage" className="h-fit rounded-lg border border-border bg-panel p-4">
          <h2 className="text-sm font-semibold">Architecture coverage</h2>
          <p className="mt-1 text-xs text-muted">{p.coverage.summary.total} components · {p.coverage.summary.covered} have implementation tasks{p.coverage.summary.exempt > 0 && ` · ${p.coverage.summary.exempt} need none`}{p.coverage.summary.uncovered > 0 && ` · ${p.coverage.summary.uncovered} uncovered`}</p>
          <ul className="mt-3 space-y-2">{p.coverage.components.map((c) => (
            <li key={c.stableKey} className="text-sm"><Link href={`/projects/${projectId}/components/${c.stableKey}`} className="font-medium hover:underline">{c.name}</Link> <span className="text-xs text-muted">{c.technology}</span>
              <span className="block text-xs text-muted">{c.status === 'COVERED' ? `${c.completed}/${c.taskCount} tasks complete` : c.status === 'EXEMPT' ? `No implementation needed: ${c.reason}` : 'No tasks yet'}</span></li>))}</ul>
        </aside>
      </div>
    </div>
  );
}
