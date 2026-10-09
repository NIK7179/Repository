'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Skeleton } from '@pitch2plan/ui';
import { ApiError, call, type ArchitectureOverviewDto } from '@/lib/api-client';
import type { VersionDto, ViewMode } from '@/lib/canvas';
import { ArchitectureCanvas, type Selection } from './ArchitectureCanvas';
import { GenerationProgress } from './GenerationProgress';
import { EdgeInspector, NodeInspector } from './Inspector';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.'));
const POLL_MS = 1500;

export function ArchitectureView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ArchitectureOverviewDto | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ViewMode>('SYSTEM');
  const [selection, setSelection] = useState<Selection>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try { const r = await call<{ architecture: ArchitectureOverviewDto }>(`/api/projects/${projectId}/architecture`); setData(r.architecture); setError(null); return r.architecture; }
    catch (e) { setError(asError(e)); return null; }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  // Poll only while the backend is actually working.
  useEffect(() => {
    if (data?.state !== 'GENERATING') return;
    timer.current = setTimeout(() => void load(), POLL_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [data, load]);

  async function generate() {
    setBusy(true); setError(null);
    try { await call(`/api/projects/${projectId}/architecture/generate`, { method: 'POST' }); await load(); }
    catch (e) { setError(asError(e)); await load(); } finally { setBusy(false); }
  }

  const version = data?.current ? ({ version: data.current.version, decisions: data.current.decisions, drivers: data.current.drivers, requirements: data.current.requirements, stats: data.current.stats } as unknown as VersionDto) : null;

  if (!data) return error ? <Alert title="We couldn’t load the architecture" action={<Button variant="secondary" onClick={() => void load()}>Retry</Button>}>{error.message}</Alert> : <div role="status" aria-label="Loading architecture" className="space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-96 w-full" /></div>;

  if (data.state === 'NOT_AVAILABLE') {
    return <Alert tone="neutral" title="Confirm your requirements first" action={<Link href={`/projects/${projectId}/brief`}><Button variant="secondary">Go to the brief</Button></Link>}>Architecture is designed from your confirmed requirements and architecture drivers.</Alert>;
  }
  if (data.state === 'GENERATING') return <GenerationProgress run={data.run} />;

  if (data.state === 'NOT_STARTED' || data.state === 'FAILED') {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        {data.state === 'FAILED' && data.run && (
          <Alert title="Architecture generation couldn’t be completed." action={undefined}>
            <span data-testid="failure-message">{data.run.failureMessage}</span>
            <span className="mt-1 block text-xs opacity-80">Failure code: {data.run.failureCode}. Your requirements are still confirmed and nothing was lost.</span>
          </Alert>
        )}
        {error && <Alert title="That didn’t work">{error.message}</Alert>}
        <div className="rounded-lg border border-border bg-panel p-6">
          <h2 className="text-base font-semibold">{data.state === 'FAILED' ? 'Try again' : 'Design your architecture'}</h2>
          <p className="mt-1 text-sm text-muted">We&apos;ll choose the simplest design that satisfies your confirmed requirements, explain every decision, and show you which requirement caused what.</p>
          <Button className="mt-4" loading={busy} onClick={generate}>{data.state === 'FAILED' ? 'Retry Architecture Generation' : 'Generate architecture'}</Button>
        </div>
      </div>
    );
  }

  const v = data.current!;
  const sel = selection;
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-xs uppercase tracking-wide text-muted">Architecture</p><h1 className="text-xl font-semibold" data-testid="project-name">{data.project.name}</h1></div>
        <Link href={`/projects/${projectId}/decisions`}><Button variant="secondary">View decisions</Button></Link>
      </header>
      <section aria-label="Architecture summary" data-testid="architecture-summary" className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-panel px-4 py-3 text-sm">
        <span className="font-medium">Version {v.version.versionNumber}</span>
        <span>{v.stats.components} components</span><span>{v.stats.decisions} architecture decisions</span><span>{v.stats.drivers} drivers</span>
        <span>{v.stats.highRisks} high risk{v.stats.highRisks === 1 ? '' : 's'}</span>
        {v.stats.openIssues > 0 && <Badge tone="warn">{v.stats.openIssues} open review finding{v.stats.openIssues === 1 ? '' : 's'}</Badge>}
        <span className="text-muted">Generated {v.version.finalizedAt ? new Date(v.version.finalizedAt).toLocaleString() : ''}</span>
      </section>
      <p className="max-w-3xl text-sm text-muted" data-testid="architecture-description">{v.version.summary}</p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="h-[560px] overflow-hidden rounded-lg border border-border bg-panel">
          <ArchitectureCanvas version={v.version as unknown as VersionDto['version']} mode={mode} onModeChange={setMode} selection={sel} onSelect={setSelection} />
        </div>
        <aside aria-label="Inspector" className="max-h-[560px] overflow-y-auto rounded-lg border border-border bg-panel p-4">
          {sel?.kind === 'node' ? <NodeInspector versionId={v.version.id} stableKey={sel.key} projectId={projectId} onClose={() => setSelection(null)} />
            : sel?.kind === 'edge' && version ? <EdgeInspector version={version} edgeKey={sel.key} onClose={() => setSelection(null)} />
            : <div className="text-sm text-muted"><p className="font-medium text-fg">Select a component or connection</p><p className="mt-1">See why it exists, what it connects to, the decisions behind it and the requirements that caused it.</p></div>}
        </aside>
      </div>
    </div>
  );
}
