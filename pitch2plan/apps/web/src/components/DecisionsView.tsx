'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Skeleton } from '@pitch2plan/ui';
import { ApiError, call, type ArchitectureOverviewDto, type DecisionDto } from '@/lib/api-client';

const tone = (s: string) => (s === 'ACCEPTED' ? 'ok' : s === 'PROPOSED' ? 'warn' : 'neutral') as 'ok' | 'warn' | 'neutral';

/** ADR-style records rendered from structured data. Nothing here is static markdown. */
export function DecisionsView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ArchitectureOverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { call<{ architecture: ArchitectureOverviewDto }>(`/api/projects/${projectId}/architecture`).then((r) => setData(r.architecture)).catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load decisions.')); }, [projectId]);

  if (error) return <Alert title="We couldn’t load the decisions">{error}</Alert>;
  if (!data) return <div role="status" aria-label="Loading decisions" className="space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>;
  const v = data.current;
  if (!v) return <Alert tone="neutral" title="No architecture decisions yet" action={<Link href={`/projects/${projectId}/architecture`}><Button variant="secondary">Go to architecture</Button></Link>}>Decisions are recorded when the architecture is generated.</Alert>;

  const nodeName = (k: string) => v.version.nodes.find((n) => n.stableKey === k)?.name ?? k;
  const reqs = new Map(v.requirements.map((r) => [r.code, r]));
  const drivers = new Map(v.drivers.map((d) => [d.code, d]));
  return (
    <div className="space-y-5">
      <header><p className="text-xs uppercase tracking-wide text-muted">Architecture decisions · version {v.version.versionNumber}</p><h1 className="text-xl font-semibold">Why the system is designed this way</h1></header>
      <ol className="space-y-4" data-testid="decision-list">
        {v.decisions.map((d: DecisionDto) => (
          <li key={d.id} className="rounded-lg border border-border bg-panel p-5" data-testid="decision-card">
            <div className="flex flex-wrap items-center gap-2"><Badge tone="accent">{d.key.toUpperCase()}</Badge><Badge tone={tone(d.status)}>{d.status.toLowerCase()}</Badge><span className="text-xs text-muted">{Math.round(d.confidence * 100) >= 75 ? 'High confidence' : Math.round(d.confidence * 100) >= 50 ? 'Medium confidence' : 'Needs confirmation'}</span></div>
            <h2 className="mt-2 text-base font-semibold">{d.title}</h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div><dt className="font-medium">Problem</dt><dd className="text-muted">{d.problem}</dd></div>
              <div><dt className="font-medium">Decision</dt><dd>{d.decision}</dd></div>
              <div><dt className="font-medium">Why</dt><dd className="text-muted">{d.rationale}</dd></div>
              {(d.requirementCodes.length > 0 || d.impliedRequirementCodes.length > 0) && <div><dt className="font-medium">Related requirements</dt><dd><ul className="mt-1 space-y-1">{[...d.requirementCodes, ...d.impliedRequirementCodes].map((c) => <li key={c}><Badge>{c}</Badge> {reqs.get(c)?.statement}</li>)}</ul></dd></div>}
              {d.driverCodes.length > 0 && <div><dt className="font-medium">Related drivers</dt><dd><ul className="mt-1 space-y-1">{d.driverCodes.map((c) => <li key={c}><Badge tone="accent">{c}</Badge> {drivers.get(c)?.name}</li>)}</ul></dd></div>}
              {d.alternatives.length > 0 && <div><dt className="font-medium">Alternatives considered</dt><dd><ul className="mt-1 space-y-1.5">{d.alternatives.map((a, i) => <li key={i}><span className="font-medium">{a.technology}</span><span className="block text-muted">{a.reasoning}</span></li>)}</ul></dd></div>}
              {d.tradeoffs.length > 0 && <div><dt className="font-medium">Trade-offs</dt><dd><ul className="list-disc pl-5 text-muted">{d.tradeoffs.map((t, i) => <li key={i}>{t}</li>)}</ul></dd></div>}
              {d.consequences.length > 0 && <div><dt className="font-medium">Consequences</dt><dd><ul className="list-disc pl-5 text-muted">{d.consequences.map((t, i) => <li key={i}>{t}</li>)}</ul></dd></div>}
              {d.nodeStableKeys.length > 0 && <div><dt className="font-medium">Affected components</dt><dd className="flex flex-wrap gap-2 pt-1">{d.nodeStableKeys.map((k) => <Badge key={k}>{nodeName(k)}</Badge>)}</dd></div>}
            </dl>
          </li>
        ))}
      </ol>
    </div>
  );
}
