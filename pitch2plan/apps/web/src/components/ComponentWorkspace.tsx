'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Badge, Skeleton } from '@pitch2plan/ui';
import { ApiError, call, type ComponentWorkspaceDto } from '@/lib/api-client';
import { readinessLabel, statusLabel, statusTone, typeLabel } from '@/lib/impl-labels';
import { AskArchitect } from './AskArchitect';
import { TechIcon } from './TechIcon';

const TABS = ['Overview', 'Implementation', 'Configuration', 'Connections', 'Decisions', 'Risks', 'Monitoring', 'Ask Architect'] as const;
type Tab = (typeof TABS)[number];
const FactTag = () => <Badge tone="accent">Architecture</Badge>;
const GuidanceTag = () => <span title="Suggested by the AI planner. Useful, but it is not part of your architecture and nothing here is applied automatically."><Badge tone="warn">AI guidance</Badge></span>;
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted">{children}</p>;

export function ComponentWorkspace({ projectId, stableKey, initialTab }: { projectId: string; stableKey: string; initialTab?: string }) {
  const [d, setD] = useState<ComponentWorkspaceDto | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tab, setTab] = useState<Tab>((TABS as readonly string[]).includes(initialTab ?? '') ? (initialTab as Tab) : 'Overview');
  useEffect(() => {
    let live = true; setD(null);
    call<{ component: ComponentWorkspaceDto }>(`/api/projects/${projectId}/components/${encodeURIComponent(stableKey)}/implementation`).then((r) => live && setD(r.component)).catch((e) => live && setError(e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.')));
    return () => { live = false; };
  }, [projectId, stableKey]);

  if (error) return <Alert title="We couldn’t load this component">{error.message}</Alert>;
  if (!d) return <div role="status" aria-label="Loading component" className="space-y-3"><Skeleton className="h-10 w-72" /><Skeleton className="h-64 w-full" /></div>;
  const c = d.facts.component; const imp = d.implementation; const base = `/projects/${projectId}`;
  const remaining = imp.remaining;

  return (
    <div className="space-y-4" data-testid="component-workspace">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3"><TechIcon slug={c.technologySlug} name={c.technology} category={c.category} size={44} />
          <div><h1 className="text-xl font-semibold" data-testid="component-title">{c.name}</h1><p className="text-sm text-muted">{c.technology}{c.provider ? ` · ${c.provider}` : ''} · {c.deploymentModel.replaceAll('_', ' ').toLowerCase()}</p></div></div>
        <div className="flex items-center gap-4 text-sm">
          {imp.progress && <span data-testid="component-progress" className="text-muted">{imp.progress.completed} of {imp.progress.applicable} tasks complete · {imp.progress.percent}%</span>}
          <Link href={`${base}/architecture`} className="text-accent underline">View in architecture</Link>
        </div>
      </header>
      <div role="tablist" aria-label="Component workspace" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-accent font-medium' : 'border-transparent text-muted hover:text-fg'}`}>{t}</button>)}
      </div>

      <div role="tabpanel" aria-label={tab} className="min-h-[20rem]">
        {tab === 'Overview' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-lg border border-border bg-panel p-4"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">Role in this architecture</h2><FactTag /></div><p className="mt-2 text-sm">{c.purpose}</p><p className="mt-2 text-sm text-muted">{c.description}</p>
              <div className="mt-3 flex flex-wrap gap-2"><Badge>{c.category.replaceAll('_', ' ').toLowerCase()}</Badge><Badge tone={c.criticality === 'CRITICAL' ? 'danger' : c.criticality === 'HIGH' ? 'warn' : 'neutral'}>{c.criticality.toLowerCase()}</Badge>{c.managedService && <Badge tone="accent">managed service</Badge>}</div></section>
            <section className="rounded-lg border border-border bg-panel p-4" data-testid="impl-summary"><h2 className="text-sm font-semibold">What you need to do</h2>
              {!imp.hasPlan ? <p className="mt-2 text-sm text-muted">There is no implementation plan yet. <Link href={`${base}/implementation`} className="text-accent underline">Generate it</Link> to see the steps for this component.</p>
                : <><p className="mt-2 text-sm">{remaining === 0 ? 'Everything for this component is done.' : `${remaining} task${remaining === 1 ? '' : 's'} remaining.`}</p>
                  {imp.currentTask && <p className="mt-2 text-sm"><span className="text-muted">{imp.currentTask.status === 'IN_PROGRESS' ? 'Current task: ' : imp.currentTask.readiness === 'READY' ? 'Next task: ' : 'Next up (waiting on prerequisites): '}</span><Link href={`${base}/implementation/tasks/${imp.currentTask.id}`} className="font-medium text-accent hover:underline" data-testid="current-task">{imp.currentTask.title}</Link></p>}
                  {imp.dependsOnComponents.length > 0 && <p className="mt-2 text-xs text-muted">Depends on work in: {imp.dependsOnComponents.map((x) => <Link key={x.stableKey} href={`${base}/components/${x.stableKey}`} className="mr-2 underline">{x.name}</Link>)}</p>}</>}
            </section>
          </div>)}

        {tab === 'Implementation' && (
          !imp.hasPlan ? <Empty>No implementation plan yet. <Link href={`${base}/implementation`} className="text-accent underline">Generate the plan</Link>.</Empty>
            : imp.tasks.length === 0 ? <Empty>{imp.coverage?.status === 'EXEMPT' ? `No implementation is needed here: ${imp.coverage.reason}` : 'No tasks are linked to this component.'}</Empty>
              : <ol className="divide-y divide-border rounded-lg border border-border bg-panel" data-testid="component-tasks">{imp.tasks.map((t, i) => (
                <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"><span className="w-5 text-xs text-muted">{i + 1}</span><Link href={`${base}/implementation/tasks/${t.id}`} className="min-w-0 flex-1 text-sm font-medium hover:underline">{t.title}</Link>
                  <Badge tone={statusTone(t.status)}>{statusLabel(t.status)}</Badge>{t.status === 'NOT_STARTED' && <Badge tone={t.readiness === 'READY' ? 'accent' : 'neutral'}>{readinessLabel(t.readiness, t.unmetDependencies.length)}</Badge>}<span className="text-xs text-muted">{typeLabel(t.taskType)}</span></li>))}</ol>)}

        {tab === 'Configuration' && (
          <div className="space-y-4">
            <section className="rounded-lg border border-border bg-panel p-4"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">Settings the architecture records</h2><FactTag /></div>
              {d.facts.configuration.length ? <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">{d.facts.configuration.map((k) => <><dt key={`k-${k.key}`} className="text-muted">{k.key}</dt><dd key={`v-${k.key}`}>{k.value}</dd></>)}</dl> : <Empty>The architecture records no specific settings for this component.</Empty>}</section>
            <section className="rounded-lg border border-border bg-panel p-4"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">Security considerations</h2><GuidanceTag /></div>{d.guidance.securityNotes.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{d.guidance.securityNotes.map((n, i) => <li key={i}>{n}</li>)}</ul> : <Empty>None yet.</Empty>}</section>
            <section className="rounded-lg border border-border bg-panel p-4"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">Common issues</h2><GuidanceTag /></div>{d.guidance.commonIssues.length ? <ul className="mt-2 space-y-2 text-sm">{d.guidance.commonIssues.map((x, i) => <li key={i}><p className="font-medium">{x.problem}</p><p className="text-muted">{x.resolution}</p></li>)}</ul> : <Empty>None yet.</Empty>}</section>
            {d.guidance.references.length > 0 && <section className="rounded-lg border border-border bg-panel p-4"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">Documentation</h2><GuidanceTag /></div><ul className="mt-2 space-y-1 text-sm">{d.guidance.references.map((r) => <li key={r.url}><a href={r.url} target="_blank" rel="noopener noreferrer" className="text-accent underline">{r.title}</a> <span className="text-xs text-muted">unverified link</span></li>)}</ul></section>}
          </div>)}

        {tab === 'Connections' && (d.facts.connections.length === 0 ? <Empty>This component has no connections in the architecture.</Empty> : (
          <ul className="space-y-2" data-testid="connections">{d.facts.connections.map((x) => <li key={x.edgeKey} className="rounded-lg border border-border bg-panel p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><Badge>{x.direction === 'in' ? 'receives from' : 'sends to'}</Badge><Link href={`${base}/components/${x.component.stableKey}`} className="font-medium hover:underline">{x.component.name}</Link><span className="text-xs text-muted">{x.component.technology}</span></div>
            <p className="mt-1 text-muted">{x.dataDescription} · {x.protocol} · {x.communicationType.replaceAll('_', ' ').toLowerCase()} · {x.encrypted === true ? 'encrypted' : x.encrypted === false ? 'not encrypted' : 'encryption not specified'}</p></li>)}</ul>))}

        {tab === 'Decisions' && (
          <div className="space-y-3">{d.facts.decisions.length === 0 ? <Empty>No decisions are recorded for this component.</Empty> : d.facts.decisions.map((x) => (
            <article key={x.key} className="rounded-lg border border-border bg-panel p-4" data-testid="component-decision"><div className="flex flex-wrap items-center gap-2"><Badge tone="accent">{x.key.toUpperCase()}</Badge><span className="text-sm font-semibold">{x.title}</span><Link href={`${base}/implementation?decision=${x.key}`} className="ml-auto text-xs text-accent underline">View implementation tasks</Link></div>
              <p className="mt-2 text-sm">{x.decision}</p><p className="mt-1 text-sm text-muted">{x.rationale}</p>{(x.driverCodes.length > 0 || x.requirementCodes.length > 0) && <p className="mt-2 text-xs text-muted">{[...x.driverCodes, ...x.requirementCodes].join(' · ')}</p>}</article>))}
            {d.facts.drivers.length > 0 && <section className="rounded-lg border border-border bg-panel p-4"><h2 className="text-sm font-semibold">Architecture drivers</h2><ul className="mt-2 space-y-1 text-sm">{d.facts.drivers.map((x) => <li key={x.code}><Badge>{x.code}</Badge> {x.name} <span className="text-xs text-muted">{x.priority.toLowerCase()}</span></li>)}</ul></section>}</div>)}

        {tab === 'Risks' && <section className="rounded-lg border border-border bg-panel p-4"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">Risks</h2><FactTag /></div>{d.facts.risks.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{d.facts.risks.map((r, i) => <li key={i}>{r}</li>)}</ul> : <Empty>No risks are recorded for this component.</Empty>}
          {d.facts.alternatives.length > 0 && <div className="mt-4"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Alternatives that were considered</h3><ul className="mt-1 space-y-1 text-sm">{d.facts.alternatives.map((a) => <li key={a.technology}><span className="font-medium">{a.technology}</span>: <span className="text-muted">{a.reasoning}</span></li>)}</ul></div>}</section>}

        {tab === 'Monitoring' && (
          <div className="space-y-4"><section className="rounded-lg border border-border bg-panel p-4"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">Monitoring tasks</h2><GuidanceTag /></div>
            {d.guidance.monitoring.length ? <ul className="mt-2 space-y-1 text-sm">{d.guidance.monitoring.map((m) => <li key={m.id} className="flex items-center gap-2"><Badge tone={statusTone(m.status)}>{statusLabel(m.status)}</Badge><Link href={`${base}/implementation/tasks/${m.id}`} className="hover:underline">{m.title}</Link></li>)}</ul> : <Empty>No monitoring tasks are planned for this component.</Empty>}</section>
            <section className="rounded-lg border border-border bg-panel p-4"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">Operational considerations</h2><GuidanceTag /></div>{d.guidance.operationalNotes.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{d.guidance.operationalNotes.map((n, i) => <li key={i}>{n}</li>)}</ul> : <Empty>None yet.</Empty>}</section></div>)}

        {tab === 'Ask Architect' && <div className="h-[32rem]"><AskArchitect projectId={projectId} scope="COMPONENT" scopeId={stableKey} suggestions={[`Why does this project need ${c.name}?`, 'What should I configure first?', 'How do I secure this?', 'What can go wrong?']} /></div>}
      </div>
    </div>
  );
}
