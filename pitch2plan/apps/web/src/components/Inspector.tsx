'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Badge, Skeleton } from '@pitch2plan/ui';
import { ApiError, call, type NodeInspectorDto, type RequirementDto } from '@/lib/api-client';
import type { VersionDto } from '@/lib/canvas';
import { resolveTechnology } from '@/lib/technology-registry';
import { OriginBadge } from './origin';
import { TechIcon } from './TechIcon';

const Section = ({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) => (
  <section data-testid={testId} className="border-t border-border pt-3"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3><div className="mt-2 text-sm">{children}</div></section>
);
const List = ({ items, empty }: { items: string[]; empty: string }) => (items.length ? <ul className="list-disc space-y-1 pl-5">{items.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="text-muted">{empty}</p>);
const ADR = (key: string) => key.toUpperCase();
const crit = (c: string) => <Badge tone={c === 'CRITICAL' ? 'danger' : c === 'HIGH' ? 'warn' : 'neutral'}>{c.toLowerCase()}</Badge>;
const asReq = (r: { origin: string }): Pick<RequirementDto, 'origin' | 'source'> => ({ origin: r.origin as RequirementDto['origin'], source: r.origin as RequirementDto['source'] });

export function NodeInspector({ versionId, stableKey, onClose, projectId }: { versionId: string; stableKey: string; onClose: () => void; projectId?: string }) {
  const [data, setData] = useState<NodeInspectorDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState(true);
  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    call<{ node: NodeInspectorDto }>(`/api/architecture/versions/${versionId}/nodes/${encodeURIComponent(stableKey)}`)
      .then((r) => live && setData(r.node)).catch((e) => live && setError(e instanceof ApiError ? e.message : 'Could not load this component.'));
    return () => { live = false; };
  }, [versionId, stableKey]);

  if (error) return <Alert title="We couldn’t load this component">{error}</Alert>;
  if (!data) return <div role="status" aria-label="Loading component" className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div>;
  const n = data.node;
  const tech = resolveTechnology(n.technologySlug, n.technology, n.provider);

  return (
    <div className="space-y-4" data-testid="node-inspector">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3"><TechIcon slug={n.technologySlug} name={n.technology} category={n.category} size={40} />
          <div className="min-w-0"><h2 className="truncate text-base font-semibold" data-testid="inspector-title">{n.name}</h2><p className="truncate text-sm text-muted">{tech.displayName}{tech.provider ? ` · ${tech.provider}` : ''}</p></div></div>
        <button onClick={onClose} aria-label="Close inspector" className="rounded px-2 text-muted hover:bg-subtle hover:text-fg">×</button>
      </header>
      {projectId && (
        <div className="flex flex-wrap gap-2" data-testid="node-actions">
          <Link href={`/projects/${projectId}/components/${encodeURIComponent(stableKey)}`} data-testid="open-implementation" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90">Open Implementation Workspace</Link>
          <Link href={`/projects/${projectId}/components/${encodeURIComponent(stableKey)}?tab=Ask%20Architect`} data-testid="ask-architect-link" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-subtle">Ask Architect</Link>
        </div>
      )}

      <Section title="Overview">
        <div className="mb-2 flex flex-wrap gap-2"><Badge>{n.category.replaceAll('_', ' ').toLowerCase()}</Badge>{crit(n.criticality)}<Badge>{n.deploymentModel.replaceAll('_', ' ').toLowerCase()}</Badge>{n.managedService && <Badge tone="accent">managed service</Badge>}</div>
        <p>{n.description}</p>
        {tech.documentationUrl && <a href={tech.documentationUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-accent underline">Official documentation</a>}
      </Section>
      <Section title="Role in this architecture"><p>{n.purpose}</p></Section>

      <section className="rounded-lg border border-accent/40 bg-accent/5 p-3" data-testid="why-section">
        <button onClick={() => setWhy((w) => !w)} aria-expanded={why} className="flex w-full items-center justify-between text-left text-sm font-semibold">Why is this here?<span aria-hidden>{why ? '−' : '+'}</span></button>
        {why && (
          <div className="mt-2 space-y-3 text-sm">
            <p data-testid="why-summary">{data.why.summary}</p>
            {data.why.requirements.length > 0 && <div><p className="font-medium">Because your requirements specify:</p>
              <ul className="mt-1 space-y-1.5">{data.why.requirements.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2"><Badge>{r.code}</Badge><span>{r.statement}</span><OriginBadge req={asReq(r)} /></li>)}</ul></div>}
            {data.why.drivers.length > 0 && <div><p className="font-medium">Related drivers:</p>
              <ul className="mt-1 space-y-1">{data.why.drivers.map((d) => <li key={d.id}><Badge tone="accent">{d.code}</Badge> <span className="font-medium">{d.name}</span> {crit(d.priority)}</li>)}</ul></div>}
            {data.why.decisions.length > 0 && <div><p className="font-medium">Architecture decisions:</p>
              <ul className="mt-1 space-y-1">{data.why.decisions.map((d) => <li key={d.id}><Badge tone="ok">{ADR(d.key)}</Badge> {d.title}</li>)}</ul></div>}
          </div>
        )}
      </section>

      <Section title="Inputs" testId="inspector-inputs">{data.inputs.length ? <ul className="space-y-2">{data.inputs.map((i) => <li key={i.edgeKey}><span className="font-medium">{i.node.name}</span> <span className="text-muted">→ {i.label}</span><p className="text-xs text-muted">{i.communicationType.replaceAll('_', ' ').toLowerCase()} · {i.protocol} · {i.dataDescription}</p></li>)}</ul> : <p className="text-muted">Nothing flows in. This is an entry point.</p>}</Section>
      <Section title="Outputs" testId="inspector-outputs">{data.outputs.length ? <ul className="space-y-2">{data.outputs.map((o) => <li key={o.edgeKey}><span className="text-muted">{o.label} →</span> <span className="font-medium">{o.node.name}</span><p className="text-xs text-muted">{o.communicationType.replaceAll('_', ' ').toLowerCase()} · {o.protocol} · {o.dataDescription}</p></li>)}</ul> : <p className="text-muted">Nothing flows out.</p>}</Section>
      <Section title="Configuration considerations">{n.configuration.length ? <dl className="space-y-1.5">{n.configuration.map((c) => <div key={c.key}><dt className="font-medium">{c.key}</dt><dd>{c.value}{c.note && <span className="block text-xs text-muted">{c.note}</span>}</dd></div>)}</dl> : <p className="text-muted">No specific configuration recorded yet.</p>}</Section>
      <Section title="Risks"><List items={n.risks} empty="No risks recorded for this component." /></Section>
      <Section title="Alternatives considered">{n.alternatives.length ? <ul className="space-y-2">{n.alternatives.map((a, i) => <li key={i}><span className="font-medium">{a.technology}</span><p className="text-muted">{a.reasoning}</p></li>)}</ul> : <p className="text-muted">None recorded.</p>}</Section>
      {data.history.length > 1 && <Section title="History"><ul className="space-y-1">{data.history.map((h) => <li key={h.versionId}>v{h.versionNumber}: {h.technology}{h.replacesStableKey ? ` (replaces ${h.replacesStableKey})` : ''}</li>)}</ul></Section>}
    </div>
  );
}

export function EdgeInspector({ version, edgeKey, onClose }: { version: VersionDto; edgeKey: string; onClose: () => void }) {
  const e = version.version.edges.find((x) => x.edgeKey === edgeKey);
  if (!e) return null;
  const name = (k: string) => version.version.nodes.find((n) => n.stableKey === k)?.name ?? k;
  const decisions = version.decisions.filter((d) => d.edgeKeys.includes(edgeKey));
  const requirements = version.requirements.filter((r) => decisions.some((d) => d.requirementCodes.includes(r.code) || d.impliedRequirementCodes.includes(r.code)));
  return (
    <div className="space-y-4" data-testid="edge-inspector">
      <header className="flex items-start justify-between gap-3">
        <div><p className="text-xs uppercase tracking-wide text-muted">Connection</p><h2 className="text-base font-semibold" data-testid="inspector-title">{name(e.sourceStableKey)} → {name(e.targetStableKey)}</h2></div>
        <button onClick={onClose} aria-label="Close inspector" className="rounded px-2 text-muted hover:bg-subtle hover:text-fg">×</button>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">Pattern</dt><dd>{e.communicationType.replaceAll('_', ' ').toLowerCase()}</dd>
        <dt className="text-muted">Data sent</dt><dd>{e.dataDescription}</dd>
        <dt className="text-muted">Protocol</dt><dd>{e.protocol}</dd>
        <dt className="text-muted">Timing</dt><dd>{e.synchronous ? 'Synchronous (the caller waits)' : 'Asynchronous'}</dd>
        <dt className="text-muted">Encryption</dt><dd>{e.encrypted === true ? 'Encrypted in transit' : e.encrypted === false ? 'Not encrypted' : 'Not specified'}</dd>
        <dt className="text-muted">Criticality</dt><dd>{crit(e.criticality)}</dd>
      </dl>
      <Section title="Purpose"><p>{e.label}</p></Section>
      <Section title="Relevant decisions" testId="edge-decisions">{decisions.length ? <ul className="space-y-2">{decisions.map((d) => <li key={d.id}><Badge tone="ok">{ADR(d.key)}</Badge> <span className="font-medium">{d.title}</span><p className="text-muted">{d.decision}</p></li>)}</ul> : <p className="text-muted">No decision is linked to this connection.</p>}</Section>
      {requirements.length > 0 && <Section title="Requirements it serves"><ul className="space-y-1">{requirements.map((r) => <li key={r.id}><Badge>{r.code}</Badge> {r.statement}</li>)}</ul></Section>}
    </div>
  );
}
