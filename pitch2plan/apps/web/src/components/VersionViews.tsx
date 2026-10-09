'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Skeleton } from '@pitch2plan/ui';
import { navigateTo } from '@/lib/navigate';
import { ApiError, call, type ArchitectureDiffDto, type VersionHistoryDto } from '@/lib/api-client';
import type { CanvasDiff, VersionDto } from '@/lib/canvas';
import { ArchitectureCanvas, type Selection } from './ArchitectureCanvas';
import { NodeInspector } from './Inspector';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.'));
export const useHistory = (projectId: string) => {
  const [versions, setVersions] = useState<VersionHistoryDto | null>(null);
  useEffect(() => { let live = true; call<{ versions: VersionHistoryDto }>(`/api/projects/${projectId}/architecture/history`).then((r) => live && setVersions(r.versions)).catch(() => live && setVersions([])); return () => { live = false; }; }, [projectId]);
  return versions;
};
const label = (v: VersionHistoryDto[number]) => `Version ${v.versionNumber} — ${v.isCurrent ? 'Current' : 'Superseded'}`;

/** Lists every architecture version with why it exists. Old versions are viewable and comparable, never editable. */
export function VersionBar({ projectId, selectedId }: { projectId: string; selectedId?: string | null }) {
  const versions = useHistory(projectId);
  if (!versions || versions.length < 2) return null;
  const current = versions.find((v) => v.isCurrent)!;
  const sel = versions.find((v) => v.id === selectedId) ?? current;
  return (
    <section aria-label="Architecture versions" data-testid="version-bar" className="rounded-lg border border-border bg-panel px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="version-select" className="text-sm font-medium">Version</label>
        <select id="version-select" data-testid="version-select" value={sel.id} onChange={(e) => { navigateTo(e.target.value === current.id ? `/projects/${projectId}/architecture` : `/projects/${projectId}/architecture?version=${e.target.value}`); }} className="h-9 rounded-md border border-border bg-bg px-2 text-sm">
          {versions.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
        </select>
        {sel.id !== current.id && <Link data-testid="compare-with-current" className="text-sm text-accent underline" href={`/projects/${projectId}/architecture/compare?from=${sel.id}&to=${current.id}`}>Compare with current</Link>}
        {sel.parentVersionId && <Link className="text-sm text-accent underline" href={`/projects/${projectId}/architecture/compare?from=${sel.parentVersionId}&to=${sel.id}`}>What changed in this version</Link>}
      </div>
      <ol className="mt-2 space-y-1 text-xs text-muted">{versions.map((v) => (
        <li key={v.id} data-testid={`version-${v.versionNumber}`}>
          <span className="font-medium text-fg">V{v.versionNumber}</span> · <Badge tone={v.isCurrent ? 'ok' : 'neutral'}>{v.isCurrent ? 'Current' : 'Superseded'}</Badge> · {new Date(v.createdAt).toLocaleDateString()} ·{' '}
          {v.origin.proposalId ? <>created by change request <Link className="text-accent underline" href={`/projects/${projectId}/changes/${v.origin.proposalId}`}>“{v.origin.requestedChange}”</Link></> : 'initial architecture from your confirmed requirements'}
        </li>))}</ol>
    </section>
  );
}

/** A read-only view of any stored version. */
export function HistoricVersionView({ versionId }: { versionId: string }) {
  const [v, setV] = useState<VersionDto['version'] | null>(null); const [error, setError] = useState<ApiError | null>(null); const [sel, setSel] = useState<Selection>(null); const [mode, setMode] = useState<'SYSTEM' | 'DATA_FLOW'>('SYSTEM');
  useEffect(() => { let live = true; call<{ version: VersionDto }>(`/api/architecture/versions/${versionId}`).then((r) => live && setV(r.version.version)).catch((e) => live && setError(asError(e))); return () => { live = false; }; }, [versionId]);
  if (error) return <Alert title="We couldn’t load this version">{error.message}</Alert>;
  if (!v) return <Skeleton className="h-96 w-full" />;
  return (
    <div className="space-y-3" data-testid="historic-version">
      <Alert tone="neutral" title={`You are viewing Version ${v.versionNumber} (${v.status === 'READY' ? 'current' : 'superseded'}), read-only`}>Stored versions are immutable. To change the architecture, request a change; Pitch2Plan will create a new version and keep this one.</Alert>
      <p className="max-w-3xl text-sm text-muted">{v.summary}</p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="h-[520px] overflow-hidden rounded-lg border border-border bg-panel"><ArchitectureCanvas version={v} mode={mode} onModeChange={setMode} selection={sel} onSelect={setSel} /></div>
        <aside aria-label="Inspector" className="max-h-[520px] overflow-y-auto rounded-lg border border-border bg-panel p-4">{sel?.kind === 'node' ? <NodeInspector versionId={v.id} stableKey={sel.key} onClose={() => setSel(null)} /> : <p className="text-sm text-muted">Select a component to inspect it.</p>}</aside>
      </div>
    </div>
  );
}

const KIND_META: Record<string, { icon: string; label: string; tone: 'ok' | 'danger' | 'warn' | 'accent' | 'neutral' }> = {
  ADDED: { icon: '＋', label: 'Added', tone: 'ok' }, REMOVED: { icon: '−', label: 'Removed', tone: 'danger' }, MODIFIED: { icon: '~', label: 'Modified', tone: 'warn' },
  REPLACED: { icon: '⇄', label: 'Replaced', tone: 'accent' }, UNCHANGED: { icon: '=', label: 'Unchanged', tone: 'neutral' }, SUPERSEDED: { icon: '⇄', label: 'Superseded', tone: 'accent' },
};
export const KindBadge = ({ kind }: { kind: string }) => { const m = KIND_META[kind] ?? KIND_META.UNCHANGED!; return <Badge tone={m.tone}><span aria-hidden>{m.icon} </span>{m.label}</Badge>; };

export function VersionCompare({ projectId, from, to }: { projectId: string; from?: string; to?: string }) {
  const versions = useHistory(projectId);
  const [d, setD] = useState<ArchitectureDiffDto | null>(null); const [error, setError] = useState<ApiError | null>(null); const [sel, setSel] = useState<Selection>(null);
  const ordered = useMemo(() => (versions ? [...versions].sort((a, b) => a.versionNumber - b.versionNumber) : []), [versions]);
  const fromId = from ?? (ordered.length >= 2 ? ordered[ordered.length - 2]!.id : undefined); const toId = to ?? ordered.at(-1)?.id;
  useEffect(() => {
    if (!fromId || !toId) return; let live = true; setD(null); setError(null);
    call<{ diff: ArchitectureDiffDto }>(`/api/architecture/versions/${fromId}/diff/${toId}`).then((r) => live && setD(r.diff)).catch((e) => live && setError(asError(e)));
    return () => { live = false; };
  }, [fromId, toId]);

  if (versions && ordered.length < 2) return <Alert tone="neutral" title="There is only one architecture version">Compare becomes available once a change has been applied. <Link className="underline" href={`/projects/${projectId}/changes`}>Change requests</Link></Alert>;
  if (error) return <Alert title="We couldn’t compare these versions">{error.message}</Alert>;
  if (!d || !versions) return <div role="status" aria-label="Loading comparison" className="space-y-3"><Skeleton className="h-10 w-80" /><Skeleton className="h-96 w-full" /></div>;
  const diff = d.diff;
  // The compare canvas shows the NEW graph plus anything the old graph had that is gone, each marked.
  const keyed = new Map(d.to.nodes.map((n) => [n.stableKey, n])); for (const n of d.from.nodes) if (!keyed.has(n.stableKey)) keyed.set(n.stableKey, n);
  const edgeMap = new Map(d.to.edges.map((e) => [e.edgeKey, e])); for (const e of d.from.edges) if (!edgeMap.has(e.edgeKey)) edgeMap.set(e.edgeKey, e);
  const canvasDiff: CanvasDiff = { nodes: Object.fromEntries(diff.nodes.map((n) => [n.stableKey, n.kind])), edges: Object.fromEntries(diff.edges.map((e) => [e.edgeKey, e.kind])) };
  const virtual = { nodes: [...keyed.values()].map((n) => ({ ...n, purpose: '', provider: null, managedService: false })), edges: [...edgeMap.values()] } as unknown as VersionDto['version'];
  const counts = (kinds: string[]) => Object.fromEntries(kinds.map((k) => [k, diff.nodes.filter((n) => n.kind === k).length]));
  const c = counts(['ADDED', 'REMOVED', 'MODIFIED', 'REPLACED', 'UNCHANGED']);
  return (
    <div className="space-y-4" data-testid="version-compare">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-xs uppercase tracking-wide text-muted">Compare architecture</p><h1 className="text-xl font-semibold" data-testid="compare-title">Architecture V{d.from.versionNumber} → V{d.to.versionNumber}</h1></div>
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="cmp-from" className="text-muted">From</label><select id="cmp-from" value={fromId} onChange={(e) => { navigateTo(`/projects/${projectId}/architecture/compare?from=${e.target.value}&to=${toId}`); }} className="h-9 rounded-md border border-border bg-bg px-2">{ordered.map((v) => <option key={v.id} value={v.id}>V{v.versionNumber}</option>)}</select>
          <label htmlFor="cmp-to" className="text-muted">To</label><select id="cmp-to" value={toId} onChange={(e) => { navigateTo(`/projects/${projectId}/architecture/compare?from=${fromId}&to=${e.target.value}`); }} className="h-9 rounded-md border border-border bg-bg px-2">{ordered.map((v) => <option key={v.id} value={v.id}>V{v.versionNumber}</option>)}</select>
        </div>
      </header>
      {d.origin && <p className="text-sm">Created by change request <Link className="text-accent underline" href={`/projects/${projectId}/changes/${d.origin.proposalId}`}>“{d.origin.requestedChange}”</Link></p>}
      <section aria-label="Summary" data-testid="diff-summary" className="rounded-lg border border-border bg-panel p-4">
        <h2 className="text-sm font-semibold">Summary</h2>
        {diff.summary.sentences.length ? <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">{diff.summary.sentences.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="mt-2 text-sm text-muted">No differences.</p>}
        <ul className="mt-3 flex flex-wrap gap-3 text-xs" aria-label="Legend">{(['ADDED', 'REMOVED', 'MODIFIED', 'REPLACED', 'UNCHANGED'] as const).map((k) => <li key={k} className="flex items-center gap-1"><KindBadge kind={k} /><span className="text-muted">{c[k]}</span></li>)}</ul>
      </section>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="h-[520px] overflow-hidden rounded-lg border border-border bg-panel"><ArchitectureCanvas version={virtual} mode="SYSTEM" onModeChange={() => undefined} selection={sel} onSelect={setSel} diff={canvasDiff} /></div>
        <aside className="max-h-[520px] overflow-y-auto rounded-lg border border-border bg-panel p-4 text-sm" aria-label="Changes">
          <h2 className="font-semibold">Components</h2>
          <ul className="mt-2 space-y-2" data-testid="diff-nodes">{diff.nodes.filter((n) => n.kind !== 'UNCHANGED').map((n) => (
            <li key={n.stableKey}><div className="flex items-center gap-2"><KindBadge kind={n.kind} /><span className="font-medium">{n.name}</span></div>
              {n.kind === 'REPLACED' && n.from && n.to && <p className="mt-0.5 text-xs text-muted">{n.from.technology} → {n.to.technology}</p>}{n.changes.map((x) => <p key={x} className="text-xs text-muted">{x}</p>)}</li>))}
            {diff.nodes.every((n) => n.kind === 'UNCHANGED') && <li className="text-muted">No component changed.</li>}</ul>
          <h2 className="mt-4 font-semibold">Connections</h2>
          <ul className="mt-2 space-y-2" data-testid="diff-edges">{diff.edges.filter((e) => e.kind !== 'UNCHANGED').map((e) => (<li key={e.edgeKey}><div className="flex items-center gap-2"><KindBadge kind={e.kind} /><span>{e.label}</span></div><p className="text-xs text-muted">{e.source} → {e.target}</p>{e.changes.map((x) => <p key={x} className="text-xs text-muted">{x}</p>)}</li>))}
            {diff.edges.every((e) => e.kind === 'UNCHANGED') && <li className="text-muted">No connection changed.</li>}</ul>
          <h2 className="mt-4 font-semibold">Decisions</h2>
          <ul className="mt-2 space-y-2" data-testid="diff-decisions">{diff.decisions.filter((x) => x.kind !== 'UNCHANGED').map((x) => (<li key={x.key}><div className="flex items-center gap-2"><KindBadge kind={x.kind} /><span className="font-medium">{x.key.toUpperCase()}</span></div><p className="text-xs">{x.title}</p>{x.supersededBy && <p className="text-xs text-muted">replaced by {x.supersededBy.toUpperCase()}</p>}</li>))}
            {diff.decisions.every((x) => x.kind === 'UNCHANGED') && <li className="text-muted">No decision changed.</li>}</ul>
        </aside>
      </div>
      <p className="text-xs text-muted">Computed from the two stored versions{d.stored ? ' when the change was applied' : ''}. It is not produced by AI.</p>
    </div>
  );
}
