'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { BRIEF_ITEM_SECTIONS, type BriefItem } from '@pitch2plan/schemas';
import { Alert, Badge, Button, Skeleton } from '@pitch2plan/ui';
import { ApiError, call, type BriefViewDto, type RequirementDto } from '@/lib/api-client';
import { RequirementLine } from './RequirementLine';
import { OriginBadge, confidenceLabel } from './origin';

type ItemSection = (typeof BRIEF_ITEM_SECTIONS)[number];
const GROUPS: Array<{ title: string; sections: ItemSection[]; always?: boolean }> = [
  { title: 'Who it’s for', sections: ['targetUsers'] },
  { title: 'Core capabilities', sections: ['functionalRequirements'], always: true },
  { title: 'Scale & traffic', sections: ['trafficAssumptions'] },
  { title: 'Performance', sections: ['performanceRequirements'] },
  { title: 'Data', sections: ['dataRequirements'] },
  { title: 'Security & compliance', sections: ['securityRequirements', 'complianceRequirements'] },
  { title: 'Availability', sections: ['availabilityRequirements'] },
  { title: 'Integrations', sections: ['integrationRequirements'] },
  { title: 'Infrastructure preferences', sections: ['cloudAndDeploymentPreferences'] },
  { title: 'AI requirements', sections: ['aiMlRequirements'] },
  { title: 'Budget & constraints', sections: ['budgetConstraints', 'teamConstraints'] },
  { title: 'Other requirements', sections: ['nonFunctionalRequirements'] },
];
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.'));

export function BriefReview({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [view, setView] = useState<BriefViewDto | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setView((await call<{ brief: BriefViewDto }>(`/api/projects/${projectId}/brief`)).brief); setMissing(false); }
    catch (e) { const err = asError(e); if (err.code === 'BRIEF_NOT_FOUND') setMissing(true); else setError(err); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setError(null); try { await fn(); } catch (e) { setError(asError(e)); } finally { setBusy(null); } };
  const generate = () => run('Writing your Architecture Brief…', async () => { setView((await call<{ brief: BriefViewDto }>(`/api/projects/${projectId}/brief/generate`, { method: 'POST' })).brief); setMissing(false); setAccepted([]); });

  if (missing) {
    return (
      <div className="mx-auto max-w-xl space-y-4 text-sm">
        {error && <Alert title="We couldn’t write the brief">{error.message}</Alert>}
        <div className="rounded-lg border border-border bg-panel p-6">
          <h1 className="text-lg font-semibold">No brief yet</h1>
          <p className="mt-1 text-muted">Finish discovery first, then we&apos;ll write your Architecture Brief from your confirmed requirements.</p>
          <div className="mt-4 flex gap-3"><Button loading={!!busy} onClick={generate}>Generate Architecture Brief</Button><Link href={`/projects/${projectId}/discovery`}><Button variant="secondary">Back to discovery</Button></Link></div>
        </div>
      </div>
    );
  }
  if (!view) return error ? <Alert title="We couldn’t load the brief">{error.message}</Alert> : <div role="status" aria-label="Loading brief" className="space-y-3"><Skeleton className="h-8 w-72" /><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>;

  const { version, requirements, drivers } = view;
  const c = version.content;
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const confirmed = view.brief.status === 'CONFIRMED' && view.project.status !== 'DISCOVERY';
  const canEdit = view.project.status === 'DISCOVERY';
  const unacceptedCritical = view.criticalUnknowns.filter((u) => !accepted.includes(u.id));
  const canConfirm = canEdit && view.blockers.length === 0 && unacceptedCritical.length === 0;

  const itemRow = (it: BriefItem, key: string) => {
    const reqs = it.requirementIds.map((id) => byId.get(id)).filter((r): r is RequirementDto => !!r);
    const isEditing = editing === key;
    return (
      <li key={key} className="space-y-1.5" data-testid="brief-item">
        {isEditing ? (
          <div className="space-y-3 rounded-md border border-border bg-subtle p-3">
            {reqs.map((r) => <RequirementLine key={r.id} req={r} projectId={projectId} canEdit startEditing onCancel={() => setEditing(null)} onChanged={() => { setEditing(null); void load(); }} />)}
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm">{it.text}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {[...new Map(reqs.map((r) => [r.source === 'USER_EDITED' ? 'EDITED' : r.origin, r])).values()].map((r) => <OriginBadge key={r.id} req={r} />)}
                {reqs.map((r) => confidenceLabel(r.confidence)).filter((x, i, a) => x && a.indexOf(x) === i).map((x) => <span key={x} className="text-xs text-muted">{x}</span>)}
              </div>
            </div>
            {canEdit && reqs.length > 0 && <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(key)}>Edit</Button>}
          </div>
        )}
      </li>
    );
  };
  const Section = ({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) => (
    <section className="rounded-lg border border-border bg-panel p-5" data-testid={testId}><h2 className="text-sm font-semibold">{title}</h2><div className="mt-3">{children}</div></section>
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Architecture Brief · v{version.version}</p>
          <h1 className="text-xl font-semibold" data-testid="project-name">{view.project.name}</h1>
        </div>
        <Link href={`/projects/${projectId}/discovery`}><Button variant="ghost">Back to discovery</Button></Link>
      </header>

      {confirmed && <Alert tone="neutral" title="Requirements confirmed">Your requirements were confirmed{version.confirmedAt ? ` on ${new Date(version.confirmedAt).toLocaleString()}` : ''}. Architecture generation comes next and will start from this brief.</Alert>}
      {view.stale && !confirmed && <Alert tone="warn" title="Your requirements changed after this brief was written" action={<Button variant="secondary" loading={busy === 'Writing your Architecture Brief…'} onClick={generate}>Regenerate brief</Button>}>Regenerate it to review and confirm the latest version.</Alert>}
      {error && <Alert title="That didn’t work">{error.message}</Alert>}
      {view.openConflicts.length > 0 && !confirmed && <Alert tone="warn" title={`${view.openConflicts.length} conflicting requirement${view.openConflicts.length === 1 ? '' : 's'} to resolve`} action={<Link href={`/projects/${projectId}/discovery`}><Button variant="secondary">Resolve in discovery</Button></Link>}>{view.openConflicts[0]!.description}</Alert>}

      <div className="space-y-4" aria-busy={!!busy}>
        <Section title="What you’re building" testId="brief-summary"><p className="text-base leading-relaxed">{c.projectSummary}</p><p className="mt-2 text-sm text-muted">{c.businessObjective}</p></Section>
        {GROUPS.map((g) => {
          const rows = g.sections.flatMap((s) => c[s].map((it, i) => itemRow(it, `${s}-${i}`)));
          if (!rows.length && !g.always) return null;
          return <Section key={g.title} title={g.title}>{rows.length ? <ul className="space-y-4">{rows}</ul> : <p className="text-sm text-muted">Nothing specified.</p>}</Section>;
        })}
        <Section title="Architecture drivers" testId="brief-drivers">
          {c.architectureDrivers.length ? (
            <ul className="space-y-3">{c.architectureDrivers.map((d) => (
              <li key={d.id}><div className="flex items-center gap-2"><Badge tone={d.priority === 'CRITICAL' ? 'danger' : d.priority === 'HIGH' ? 'warn' : 'neutral'}>{d.priority.toLowerCase()}</Badge><span className="text-sm font-medium">{d.name}</span></div>
                <p className="text-sm text-muted">{d.description}</p></li>))}</ul>
          ) : <p className="text-sm text-muted">No drivers identified.</p>}
          <p className="mt-3 text-xs text-muted">{drivers.length} driver{drivers.length === 1 ? '' : 's'} will shape the architecture in the next phase.</p>
        </Section>
        {c.keyAssumptions.length > 0 && <Section title="Assumptions"><p className="mb-2 text-xs text-muted">We made these. They are not things you told us.</p><ul className="list-disc space-y-1 pl-5 text-sm">{c.keyAssumptions.map((a, i) => <li key={i}>{a.text}</li>)}</ul></Section>}
        {c.openQuestions.length > 0 && <Section title="Open questions" testId="brief-open"><ul className="list-disc space-y-1 pl-5 text-sm">{c.openQuestions.map((q, i) => <li key={i}>{q.text}</li>)}</ul></Section>}
        {c.risks.length > 0 && <Section title="Risks"><ul className="space-y-1 text-sm">{c.risks.map((r, i) => <li key={i}><Badge tone={r.severity === 'HIGH' ? 'danger' : 'warn'} className="mr-2">{r.severity.toLowerCase()}</Badge>{r.text}</li>)}</ul></Section>}
      </div>

      {!confirmed && (
        <section className="rounded-lg border border-accent/40 bg-panel p-5" data-testid="confirm-panel" aria-label="Confirm requirements">
          <h2 className="text-sm font-semibold">Ready to lock in your requirements?</h2>
          {view.blockers.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-danger">{view.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>}
          {view.criticalUnknowns.length > 0 && (
            <fieldset className="mt-3 space-y-2 text-sm"><legend className="font-medium">These are still unknown. Accept each one as an assumption to continue.</legend>
              {view.criticalUnknowns.map((u) => (
                <label key={u.id} className="flex items-start gap-2"><input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={accepted.includes(u.id)} onChange={(e) => setAccepted((a) => (e.target.checked ? [...a, u.id] : a.filter((x) => x !== u.id)))} /><span>{u.text}</span></label>
              ))}
            </fieldset>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            <Button loading={busy === 'confirm'} disabled={!canConfirm || !!busy} onClick={() => run('confirm', async () => { setView((await call<{ brief: BriefViewDto }>(`/api/projects/${projectId}/brief/confirm`, { method: 'POST', body: { briefVersionId: version.id, acceptedUnknownIds: accepted } })).brief); })}>Confirm requirements</Button>
            <Button variant="secondary" disabled={!canEdit || !!busy} loading={busy === 'ask'} onClick={() => run('ask', async () => { await call(`/api/projects/${projectId}/discovery/ask-more`, { method: 'POST' }); router.push(`/projects/${projectId}/discovery`); })}>Ask more questions</Button>
            <Button variant="ghost" disabled={!canEdit || !!busy} onClick={generate}>Regenerate brief</Button>
          </div>
          <p className="mt-3 text-xs text-muted">Use “Edit” on any item to change a requirement. Confirming records who confirmed and when, and unlocks architecture generation.</p>
        </section>
      )}
    </div>
  );
}
