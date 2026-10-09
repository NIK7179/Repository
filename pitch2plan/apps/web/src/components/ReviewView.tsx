'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Skeleton } from '@pitch2plan/ui';
import { navigateTo } from '@/lib/navigate';
import { ApiError, call, type FailureImpactDto, type ReviewDto } from '@/lib/api-client';
import { statusLabel } from '@/lib/impl-labels';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.'));
const SEV: Record<string, { tone: 'danger' | 'warn' | 'accent' | 'neutral'; icon: string }> = { CRITICAL: { tone: 'danger', icon: '⬣' }, HIGH: { tone: 'danger', icon: '▲' }, MEDIUM: { tone: 'warn', icon: '◆' }, LOW: { tone: 'neutral', icon: '●' } };
const area = (a: string) => statusLabel(a).replace('Operational complexity', 'Operational complexity');

function FailureMode({ projectId, nodes }: { projectId: string; nodes: Array<{ stableKey: string; name: string }> }) {
  const [key, setKey] = useState(''); const [d, setD] = useState<FailureImpactDto | null>(null); const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => { if (!key) { setD(null); return; } let live = true; setError(null); call<{ impact: FailureImpactDto }>(`/api/projects/${projectId}/components/${encodeURIComponent(key)}/failure-impact`).then((r) => live && setD(r.impact)).catch((e) => live && setError(asError(e))); return () => { live = false; }; }, [projectId, key]);
  const names = (xs: Array<{ name: string }>) => (xs.length ? xs.map((x) => x.name).join(', ') : 'none');
  return (
    <section aria-label="Failure mode" data-testid="failure-mode" className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-semibold">What happens if this fails?</h2><p className="text-xs text-muted">Computed from your stored architecture graph and decisions, not guessed.</p>
      <label htmlFor="fm-select" className="sr-only">Component</label>
      <select id="fm-select" data-testid="failure-select" value={key} onChange={(e) => setKey(e.target.value)} className="mt-2 h-9 rounded-md border border-border bg-bg px-2 text-sm"><option value="">Choose a component…</option>{nodes.map((n) => <option key={n.stableKey} value={n.stableKey}>{n.name}</option>)}</select>
      {error && <p className="mt-2 text-sm text-danger">{error.message}</p>}
      {d && (
        <div className="mt-3 space-y-3 text-sm" data-testid="failure-result">
          {d.singlePointOfFailure && <Badge tone="danger"><span aria-hidden>▲ </span>Single point of failure</Badge>}
          <dl className="grid gap-x-6 gap-y-2 md:grid-cols-2">
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Stops receiving from it</dt><dd>{names(d.directlyAffected.stopReceiving)}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Cannot reach it</dt><dd>{names(d.directlyAffected.cannotReach)}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Downstream (everything it feeds)</dt><dd data-testid="downstream">{names(d.downstream)}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Upstream (everything feeding it)</dt><dd>{names(d.upstream)}</dd></div>
          </dl>
          {d.criticalPaths.length > 0 && <div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Critical paths through it</h3><ul className="mt-1 space-y-0.5">{d.criticalPaths.map((p, i) => <li key={i}>{p.join(' → ')}</li>)}</ul></div>}
          <div className="grid gap-4 md:grid-cols-2">
            <div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Existing mitigation</h3>{d.existingMitigation.length ? <ul className="mt-1 list-disc space-y-1 pl-5">{d.existingMitigation.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="mt-1 text-muted">None recorded.</p>}</div>
            <div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Missing mitigation</h3>{d.missingMitigation.length ? <ul className="mt-1 list-disc space-y-1 pl-5" data-testid="missing-mitigation">{d.missingMitigation.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="mt-1 text-muted">Nothing obvious is missing.</p>}</div>
          </div>
          <div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Recovery</h3><ul className="mt-1 list-disc space-y-1 pl-5">{d.recoveryConsiderations.map((x) => <li key={x}>{x}</li>)}</ul></div>
          {d.implementationTasks.length > 0 && <p className="text-xs text-muted">Implementation tasks for it: {d.implementationTasks.map((t) => t.title).join('; ')}</p>}
        </div>)}
    </section>
  );
}

export function ReviewView({ projectId }: { projectId: string }) {
  const [r, setR] = useState<ReviewDto | null | undefined>(undefined); const [error, setError] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false); const [open, setOpen] = useState<string | null>(null); const [nodes, setNodes] = useState<Array<{ stableKey: string; name: string }>>([]);
  useEffect(() => {
    let live = true;
    call<{ review: ReviewDto | null }>(`/api/projects/${projectId}/review`).then((x) => live && setR(x.review)).catch((e) => live && setError(asError(e)));
    call<{ architecture: { current: { version: { nodes: Array<{ stableKey: string; name: string }> } } | null } }>(`/api/projects/${projectId}/architecture`).then((x) => live && setNodes(x.architecture.current?.version.nodes ?? [])).catch(() => undefined);
    return () => { live = false; };
  }, [projectId]);
  async function run() { setBusy(true); setError(null); try { const x = await call<{ review: ReviewDto }>(`/api/projects/${projectId}/review`, { method: 'POST' }); setR(x.review); } catch (e) { setError(asError(e)); } finally { setBusy(false); } }
  async function propose(f: ReviewDto['review']['findings'][number]) {
    try { const x = await call<{ proposal: { proposal: { id: string } } }>(`/api/projects/${projectId}/change-proposals`, { method: 'POST', body: { requestedChange: f.suggestedChange || f.recommendation, reason: `${f.title}: ${f.description}`.slice(0, 1000), source: 'ARCHITECTURE_REVIEW', reviewFindingId: f.id } }); await call(`/api/change-proposals/${x.proposal.proposal.id}/analyze`, { method: 'POST' }); navigateTo(`/projects/${projectId}/changes/${x.proposal.proposal.id}`); }
    catch (e) { setError(asError(e)); }
  }
  if (r === undefined) return error ? <Alert title="We couldn’t load the review">{error.message}</Alert> : <div role="status" aria-label="Loading review" className="space-y-3"><Skeleton className="h-8 w-72" /><Skeleton className="h-48 w-full" /></div>;
  const groups = r ? [...new Set(r.review.findings.map((f) => f.area))] : [];
  return (
    <div className="space-y-4" data-testid="review">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Production readiness review</h1><p className="text-sm text-muted">What would worry an experienced architect before this goes live: reliability, security, performance, cost awareness, operations and more.</p></div>
        <Button data-testid="run-review" loading={busy} onClick={() => void run()}>{r ? 'Run review again' : 'Run review'}</Button></header>
      {error && <Alert title="That didn’t work">{error.message}</Alert>}
      {!r ? <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted">No review yet. Running one examines the current architecture version and keeps the findings with that version.</div> : (
        <>
          {!r.isCurrent && <Alert tone="warn" title="This review is of an older architecture version">The architecture has changed since. Run the review again for the current version.</Alert>}
          <section data-testid="review-summary" className="rounded-lg border border-border bg-panel p-4"><p className="text-sm">{r.review.assessment}</p>
            <ul className="mt-3 flex flex-wrap gap-3 text-sm">{(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((s) => <li key={s}><Badge tone={SEV[s]!.tone}><span aria-hidden>{SEV[s]!.icon} </span>{statusLabel(s)}</Badge> <strong data-testid={`count-${s}`}>{r.counts[s]}</strong></li>)}</ul>
            {!r.aiAvailable && <p className="mt-2 text-xs text-muted">The AI part of this review was unavailable; these findings come from analysing the stored graph.</p>}</section>
          {groups.map((g) => (
            <section key={g} data-testid={`area-${g}`} aria-label={area(g)}><h2 className="mb-2 text-sm font-semibold">{area(g)}</h2>
              <ul className="space-y-2">{r.review.findings.filter((f) => f.area === g).map((f) => { const isOpen = open === f.id; return (
                <li key={f.id} data-testid="finding" className="rounded-lg border border-border bg-panel">
                  <button aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : f.id)} className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"><span><Badge tone={SEV[f.severity]!.tone}><span aria-hidden>{SEV[f.severity]!.icon} </span>{statusLabel(f.severity)}</Badge> <span className="ml-1 text-sm font-medium">{f.title}</span></span><span aria-hidden className="text-muted">{isOpen ? '▾' : '▸'}</span></button>
                  {isOpen && <div className="space-y-2 border-t border-border px-4 py-3 text-sm"><p>{f.description}</p><p><span className="font-medium">Recommendation: </span>{f.recommendation}</p>{f.nodeKeys.length > 0 && <p className="text-xs text-muted">Components: {f.nodeKeys.map((k) => <Link key={k} className="mr-2 underline" href={`/projects/${projectId}/components/${k}`}>{k}</Link>)}</p>}
                    <p className="text-xs text-muted">{f.source === 'DETERMINISTIC' ? 'Found by analysing your architecture graph.' : 'Suggested by the AI reviewer.'}</p>
                    {f.requiresArchitectureChange ? <Button data-testid="finding-propose" variant="secondary" onClick={() => void propose(f)}>Create change proposal</Button> : <p className="text-xs text-muted">This can be addressed without changing the architecture.</p>}</div>}
                </li>); })}</ul></section>))}
          <FailureMode projectId={projectId} nodes={nodes} />
        </>)}
    </div>
  );
}
