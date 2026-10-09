'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Skeleton } from '@pitch2plan/ui';
import { ApiError, call, timeAgo, type ImplementationOverviewDto, type TaskDetailDto } from '@/lib/api-client';
import { statusLabel, statusTone, typeLabel } from '@/lib/impl-labels';
import { AskArchitect } from './AskArchitect';
import { TechIcon } from './TechIcon';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.'));
const Section = ({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) => (
  <section data-testid={testId} className="border-t border-border pt-4"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3><div className="mt-2 text-sm">{children}</div></section>
);
const Bullets = ({ items }: { items: string[] }) => <ul className="list-disc space-y-1 pl-5">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>;

export function TaskWorkspace({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [d, setD] = useState<TaskDetailDto | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [blocking, setBlocking] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [next, setNext] = useState<{ taskId: string; title: string } | null>(null);

  const load = useCallback(async () => {
    try { const r = await call<{ task: TaskDetailDto }>(`/api/implementation/tasks/${taskId}`); setD(r.task); setError(null); }
    catch (e) { setError(asError(e)); }
  }, [taskId]);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>) { setBusy(true); setError(null); try { await fn(); await load(); } catch (e) { setError(asError(e)); await load(); } finally { setBusy(false); } }
  const setStatus = (status: string, why?: string) => act(async () => {
    await call(`/api/implementation/tasks/${taskId}/status`, { method: 'PATCH', body: { status, ...(why ? { reason: why } : {}) } });
    setBlocking(false); setReason('');
    if (status === 'COMPLETED') { const o = await call<{ implementation: ImplementationOverviewDto }>(`/api/projects/${projectId}/implementation`); setNext(o.implementation.plan?.next ? { taskId: o.implementation.plan.next.taskId, title: o.implementation.plan.next.title } : null); } else setNext(null);
  });
  const confirm = (position: number, confirmed: boolean) => act(() => call(`/api/implementation/tasks/${taskId}/validate-completion`, { method: 'POST', body: { confirmations: [{ position, confirmed }] } }));
  const toggleStep = (id: string, done: boolean) => act(() => call(`/api/implementation/tasks/${taskId}/steps/${id}`, { method: 'PATCH', body: { status: done ? 'COMPLETED' : 'NOT_STARTED' } }));

  if (!d) return error ? <Alert title="We couldn’t load this task" action={<Link href={`/projects/${projectId}/implementation`}><Button variant="secondary">Back to the roadmap</Button></Link>}>{error.message}</Alert> : <div role="status" aria-label="Loading task" className="space-y-3"><Skeleton className="h-8 w-80" /><Skeleton className="h-64 w-full" /></div>;
  const t = d.task; const active = t.status === 'IN_PROGRESS';
  const allConfirmed = d.validation.allConfirmed;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]" data-testid="task-workspace">
      <article className="min-w-0 space-y-4">
        <nav aria-label="Breadcrumb" className="text-xs text-muted"><Link href={`/projects/${projectId}/implementation`} className="hover:underline">Implementation</Link> / {d.phase.name}</nav>
        <header>
          <div className="flex flex-wrap items-center gap-2"><Badge tone={statusTone(t.status)}><span data-testid="task-status">{statusLabel(t.status)}</span></Badge><Badge>{typeLabel(t.taskType)}</Badge><Badge>{t.effort.toLowerCase()} effort</Badge><Badge>{t.complexity.toLowerCase()} complexity</Badge></div>
          <h1 className="mt-2 text-xl font-semibold" data-testid="task-title">{t.title}</h1>
          <div className="mt-2 flex flex-wrap gap-2">{d.components.map((c) => <Link key={c.stableKey} href={`/projects/${projectId}/components/${c.stableKey}`} className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs hover:bg-subtle" data-testid="task-component"><TechIcon slug={c.technologySlug} name={c.technology} category={c.category} size={18} />{c.name}<span className="text-muted">View architecture component</span></Link>)}</div>
        </header>
        {error && <Alert title="That didn’t work">{error.message}{error.code === 'CONFIRMATION_BLOCKED' && ' Confirm each check below first.'}</Alert>}

        <div data-testid="task-actions" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-panel p-3">
          {t.status === 'NOT_STARTED' && <><Button onClick={() => void setStatus('IN_PROGRESS')} disabled={busy || !d.canStart} loading={busy}>Start task</Button><Button variant="ghost" onClick={() => void setStatus('SKIPPED')} disabled={busy}>Skip</Button>
            {!d.canStart && <span className="text-sm text-muted" data-testid="unmet">Finish first: {d.unmetDependencies.map((u, i) => <span key={u.id}>{i > 0 && '; '}<Link href={`/projects/${projectId}/implementation/tasks/${u.id}`} className="text-accent underline">{u.title}</Link></span>)}</span>}</>}
          {active && <><Button variant="secondary" onClick={() => setBlocking((b) => !b)} disabled={busy}>Block…</Button><Button variant="ghost" onClick={() => void setStatus('SKIPPED')} disabled={busy}>Skip</Button><span className="text-sm text-muted">Complete the checks at the bottom to finish this task.</span></>}
          {t.status === 'BLOCKED' && <><Button onClick={() => void setStatus('IN_PROGRESS')} disabled={busy}>Resume</Button><Button variant="ghost" onClick={() => void setStatus('SKIPPED')} disabled={busy}>Skip</Button></>}
          {t.status === 'COMPLETED' && <Button variant="secondary" onClick={() => void setStatus('IN_PROGRESS')} disabled={busy}>Reopen</Button>}
          {t.status === 'SKIPPED' && <Button variant="secondary" onClick={() => void setStatus('NOT_STARTED')} disabled={busy}>Restore</Button>}
          {blocking && <form className="flex w-full flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void setStatus('BLOCKED', reason.trim() || undefined); }}>
            <label htmlFor="block-reason" className="sr-only">Why is it blocked?</label><input id="block-reason" data-testid="block-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="What is blocking you? (optional)" className="h-9 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-sm" /><Button type="submit" variant="secondary" disabled={busy}>Mark blocked</Button></form>}
        </div>
        {t.status === 'COMPLETED' && (
          <div data-testid="completed-note" className="rounded-md border border-ok/30 bg-ok/10 p-3 text-sm">Completed. The checks below were <strong>confirmed by you</strong>; Pitch2Plan did not check your environment.
            {next ? <> Next recommended: <Link data-testid="next-after-complete" className="text-accent underline" href={`/projects/${projectId}/implementation/tasks/${next.taskId}`}>{next.title}</Link>.</> : <> <Link className="text-accent underline" href={`/projects/${projectId}/implementation`}>Back to the roadmap</Link>.</>}</div>
        )}

        <Section title="Objective"><p>{t.objective}</p></Section>
        <Section title="Why this task exists" testId="why-section">
          <p>{t.whyThisTask}</p>
          {d.decisions.length > 0 && <div className="mt-2"><p className="text-xs text-muted">Architecture decisions behind it</p><ul className="mt-1 space-y-1">{d.decisions.map((x) => <li key={x.key}><Link href={`/projects/${projectId}/decisions`} className="font-medium text-accent hover:underline">{x.key.toUpperCase()}</Link> {x.title}</li>)}</ul></div>}
          {d.requirements.length > 0 && <div className="mt-2"><p className="text-xs text-muted">Requirements it serves</p><ul className="mt-1 space-y-1">{d.requirements.map((r) => <li key={r.id}><Badge>{r.code}</Badge> {r.statement}</li>)}</ul></div>}
        </Section>
        {t.prerequisites.length > 0 && <Section title="Prerequisites"><Bullets items={t.prerequisites} /></Section>}
        {d.dependencies.length > 0 && <Section title="Depends on" testId="dependencies"><ul className="space-y-1">{d.dependencies.map((x) => <li key={x.id} className="flex items-center gap-2"><Badge tone={statusTone(x.status)}>{statusLabel(x.status)}</Badge><Link href={`/projects/${projectId}/implementation/tasks/${x.id}`} className="hover:underline">{x.title}</Link></li>)}</ul>{d.dependents.length > 0 && <p className="mt-2 text-xs text-muted">Unblocks: {d.dependents.map((x) => x.title).join('; ')}</p>}</Section>}

        <Section title="Instructions" testId="instructions">
          <p className="whitespace-pre-wrap">{t.instructions}</p>
          {t.steps.length > 0 && (
            <ol className="mt-3 space-y-3" data-testid="steps">{t.steps.map((s) => (
              <li key={s.id} data-testid="step" className={`rounded-md border p-3 ${step === s.id ? 'border-accent' : 'border-border'}`}>
                <div className="flex items-start gap-3">
                  <input type="checkbox" aria-label={`Step ${s.sequence + 1} done`} checked={s.status === 'COMPLETED'} disabled={!active || busy} onChange={(e) => void toggleStep(s.id, e.target.checked)} className="mt-1" />
                  <div className="min-w-0 flex-1"><p className="font-medium">{s.sequence + 1}. {s.title}</p><p className="mt-1">{s.instruction}</p><p className="mt-1 text-xs text-muted">Expected: {s.expectedResult}{s.validation ? ` · Check: ${s.validation}` : ''}</p></div>
                  <button className="shrink-0 text-xs text-accent underline" onClick={() => setStep(s.id)}>Ask about this step</button>
                </div>
              </li>))}</ol>)}
        </Section>
        <Section title="Expected result"><p>{t.expectedOutcome}</p></Section>
        {t.securityNotes.length > 0 && <Section title="Security considerations" testId="security"><Bullets items={t.securityNotes} /></Section>}
        {t.commonProblems.length > 0 && <Section title="Common issues" testId="common-issues"><ul className="space-y-2">{t.commonProblems.map((c, i) => <li key={i}><p className="font-medium">{c.problem}</p><p className="text-muted">{c.resolution}</p></li>)}</ul></Section>}
        {t.operationalNotes.length > 0 && <Section title="Operational notes"><Bullets items={t.operationalNotes} /></Section>}
        {t.references.length > 0 && <Section title="Documentation (suggested by the AI, not verified)"><ul className="space-y-1">{t.references.map((r) => <li key={r.url}><a href={r.url} target="_blank" rel="noopener noreferrer" className="text-accent underline">{r.title}</a> <span className="text-xs text-muted">{r.technology}{r.version ? ` ${r.version}` : ''} · {r.sourceType.toLowerCase().replaceAll('_', ' ')}</span></li>)}</ul></Section>}

        <Section title="Validation" testId="validation">
          <p className="text-xs text-muted">{active ? 'You confirm these checks yourself. Pitch2Plan has not verified anything in your environment.' : t.status === 'COMPLETED' ? 'Confirmed by you.' : 'Start the task to confirm these checks.'}</p>
          <ul className="mt-2 space-y-2">{t.validations.map((v) => (
            <li key={v.id} className="flex items-start gap-3"><input type="checkbox" id={`val-${v.position}`} data-testid="validation-check" checked={v.confirmed} disabled={!active || busy} onChange={(e) => void confirm(v.position, e.target.checked)} className="mt-1" /><label htmlFor={`val-${v.position}`}>{v.label}{v.confirmed && <span className="ml-2 text-xs text-muted">confirmed by you{v.confirmedAt ? ` ${timeAgo(v.confirmedAt)}` : ''}</span>}</label></li>))}</ul>
          {active && <div className="mt-3 flex items-center gap-3"><Button data-testid="complete-task" onClick={() => void setStatus('COMPLETED')} disabled={busy || !allConfirmed}>Complete task</Button><span className="text-xs text-muted" data-testid="validation-count">{d.validation.confirmed} of {d.validation.total} checks confirmed</span></div>}
        </Section>

        {d.events.length > 0 && <Section title="History" testId="history"><ol className="space-y-1 text-xs text-muted">{d.events.map((e) => <li key={e.id}>{timeAgo(e.createdAt)} · {statusLabel(e.fromStatus)} → {statusLabel(e.toStatus)}{e.reason ? ` · “${e.reason}”` : ''}</li>)}</ol></Section>}
      </article>
      <aside className="min-w-0 xl:sticky xl:top-4 xl:h-[calc(100vh-6rem)]"><AskArchitect projectId={projectId} scope="TASK" scopeId={taskId} stepId={step} onClearStep={() => setStep(null)} /></aside>
    </div>
  );
}
