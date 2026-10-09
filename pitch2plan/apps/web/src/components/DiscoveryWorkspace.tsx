'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeChoice } from '@pitch2plan/schemas';
import { Alert, Badge, Button, Skeleton } from '@pitch2plan/ui';
import { ApiError, call, type BriefViewDto, type DiscoveryStateDto, type RoundDto } from '@/lib/api-client';
import { draftFromChoice, draftToAnswer, emptyDraft, type Draft } from '@/lib/drafts';
import { ConflictCard } from './ConflictCard';
import { QuestionCard } from './QuestionCard';
import { RequirementLine } from './RequirementLine';
import { isUserOwned } from './origin';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.'));

export function DiscoveryWorkspace({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [state, setState] = useState<DiscoveryStateDto | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const started = useRef(false);

  const openRound = useMemo(() => state?.rounds.find((r) => r.status === 'OPEN' || r.status === 'ANSWERED') ?? null, [state]);
  const roundKey = openRound ? `${openRound.id}:${openRound.status}` : null; // reset drafts only when the round changes, not on every refresh
  const apply = useCallback((s: DiscoveryStateDto) => setState(s), []);

  const act = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError(asError(e)); } finally { setBusy(null); }
  }, []);

  const post = useCallback(async (path: string) => apply((await call<{ state: DiscoveryStateDto }>(`/api/projects/${projectId}/discovery/${path}`, { method: 'POST' })).state), [projectId, apply]);
  const reload = useCallback(async () => apply((await call<{ state: DiscoveryStateDto }>(`/api/projects/${projectId}/discovery`)).state), [projectId, apply]);

  // Load, and begin discovery automatically the first time (a retry after a failure lands here as well).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void act('Understanding what is still unknown about your idea…', async () => {
      const s = (await call<{ state: DiscoveryStateDto }>(`/api/projects/${projectId}/discovery`)).state;
      apply(s);
      const needsStart = !s.session || (s.session.status === 'ACTIVE' && s.rounds.length === 0);
      if (needsStart && (s.project.status === 'IDEA' || s.project.status === 'DISCOVERY')) await post('start');
    });
  }, [projectId, act, apply, post]);

  // Fresh drafts for each new round; prefill from saved answers if a round was saved but not processed.
  useEffect(() => {
    if (!openRound) return;
    setDrafts(Object.fromEntries(openRound.questions.map((q) => [q.id, q.answer ? draftFromChoice(q.answer.choice, q.answer.advanced) : emptyDraft()])));
    setErrors({});
  }, [roundKey]);

  async function submit(round: RoundDto) {
    const next: Record<string, string> = {};
    const answers = round.questions.flatMap((q) => {
      const r = draftToAnswer(q, drafts[q.id] ?? emptyDraft());
      if (r.error) { next[q.id] = r.error; return []; }
      return [r.answer];
    });
    setErrors(next);
    if (Object.keys(next).length) return;
    await act('Updating your project requirements…', async () => {
      apply((await call<{ state: DiscoveryStateDto }>(`/api/projects/${projectId}/discovery/rounds/${round.id}/answers`, { method: 'POST', body: { answers } })).state);
      setBusy('Understanding remaining architecture decisions…');
      await post('next');
    });
  }

  async function generateBrief() {
    await act('Writing your Architecture Brief…', async () => {
      await call<{ brief: BriefViewDto }>(`/api/projects/${projectId}/brief/generate`, { method: 'POST' });
      router.push(`/projects/${projectId}/brief`);
    });
  }

  if (!state) {
    return error
      ? <Alert title="We couldn’t load discovery" action={<Button variant="secondary" onClick={() => location.reload()}>Retry</Button>}>{error.message}</Alert>
      : <div role="status" aria-label="Loading discovery" className="space-y-3"><Skeleton className="h-8 w-72" /><p className="text-sm text-muted">{busy}</p><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>;
  }

  const { session, project } = state;
  const canEdit = project.status === 'DISCOVERY';
  const openConflicts = state.conflicts.filter((c) => c.status === 'OPEN');
  const active = state.requirements.filter((r) => r.status === 'ACTIVE');
  const mine = active.filter(isUserOwned);
  const assumed = active.filter((r) => !isUserOwned(r));
  const openUnknowns = session?.unknowns.filter((u) => u.status === 'OPEN') ?? [];
  const completed = state.rounds.filter((r) => r.status === 'COMPLETED');

  if (project.status !== 'DISCOVERY' && project.status !== 'IDEA') {
    return (
      <Alert tone="neutral" title="Discovery is finished for this project" action={<Link href={`/projects/${projectId}/brief`}><Button variant="secondary">View the brief</Button></Link>}>
        This project is {project.status.replaceAll('_', ' ').toLowerCase()}.
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Discovery</p>
          <h1 className="text-xl font-semibold" data-testid="project-name">{project.name}</h1>
          {session && (
            <ol className="mt-2 flex items-center gap-2 text-xs text-muted" aria-label="Discovery progress">
              {Array.from({ length: session.maxRounds }, (_, i) => (
                <li key={i} aria-current={i === Math.min(session.roundsUsed, session.maxRounds) - 1 && session.status === 'ACTIVE' ? 'step' : undefined}
                  className={`rounded-full border px-2.5 py-0.5 ${i < session.roundsUsed ? 'border-accent text-accent' : 'border-border'}`}>Round {i + 1}</li>
              ))}
              {session.status === 'READY_FOR_BRIEF' && <Badge tone="ok">Ready for your brief</Badge>}
            </ol>
          )}
        </div>
        {session?.status === 'ACTIVE' && state.rounds.length > 0 && canEdit && (
          <Button variant="secondary" loading={busy === 'finish'} disabled={!!busy || openRound?.status === 'ANSWERED'} onClick={() => act('finish', () => post('finish'))}>Generate brief now</Button>
        )}
      </header>

      {error && (
        <Alert title={error.code.startsWith('AI_') ? 'We couldn’t process that this time' : 'Something went wrong'}
          action={!openRound && session?.status === 'ACTIVE' ? <Button variant="secondary" onClick={() => act('Understanding remaining architecture decisions…', () => post(state.rounds.length ? 'next' : 'start'))}>Try again</Button> : undefined}>
          {error.message} {openRound ? 'Your answers are saved; you can resubmit them.' : ''}{error.requestId && <span className="mt-1 block text-xs opacity-80">Reference: {error.requestId}</span>}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          {openConflicts.map((c) => <ConflictCard key={c.id} conflict={c} requirements={state.requirements} projectId={projectId} canEdit={canEdit} onState={apply} />)}

          {busy && busy !== 'finish' && (
            <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-lg border border-border bg-panel p-5 text-sm">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden /><span data-testid="busy">{busy}</span>
            </div>
          )}

          {!busy && openRound && (
            <>
              <div>
                <h2 className="text-base font-semibold">{openRound.kind === 'USER_REQUESTED' ? 'A few more questions' : `Round ${openRound.number}`}</h2>
                {openRound.reasonForAnotherRound && <p className="text-sm text-muted">{openRound.reasonForAnotherRound}</p>}
              </div>
              {openRound.questions.map((q, i) => (
                <QuestionCard key={q.id} q={q} index={i} draft={drafts[q.id] ?? emptyDraft()} error={errors[q.id]} disabled={!canEdit}
                  onChange={(d) => { setDrafts((s) => ({ ...s, [q.id]: d })); if (errors[q.id]) setErrors((e) => { const { [q.id]: _gone, ...rest } = e; return rest; }); }} />
              ))}
              <div className="flex items-center gap-3">
                <Button onClick={() => submit(openRound)} disabled={!canEdit}>{openRound.status === 'ANSWERED' ? 'Resubmit answers' : 'Submit answers'}</Button>
                <p className="text-xs text-muted">Unanswered optional questions become open assumptions in your brief.</p>
              </div>
            </>
          )}

          {!busy && !openRound && session?.status === 'ACTIVE' && state.rounds.length > 0 && (
            <div className="rounded-lg border border-border bg-panel p-6 text-sm">
              <p>Your answers are in. Next we&apos;ll work out what, if anything, is still unclear.</p>
              <Button className="mt-4" onClick={() => act('Understanding remaining architecture decisions…', () => post('next'))}>Continue</Button>
            </div>
          )}

          {!busy && session?.status === 'READY_FOR_BRIEF' && (
            <div className="rounded-lg border border-accent/40 bg-accent/5 p-6" data-testid="ready-card">
              <h2 className="text-base font-semibold">{state.brief ? 'Your brief is ready to review' : 'We have what we need to write your brief'}</h2>
              <p className="mt-1 text-sm text-muted">
                {session.finishReason === 'USER_REQUESTED' ? 'You chose to stop early.' : session.finishReason === 'MAX_ROUNDS' ? 'We reached the question limit for this stage.' : 'Nothing else would change the design.'}
                {openUnknowns.length > 0 && ` ${openUnknowns.length} open ${openUnknowns.length === 1 ? 'item' : 'items'} will appear in the brief as assumptions for you to confirm.`}
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                {state.brief ? <Link href={`/projects/${projectId}/brief`}><Button>View brief</Button></Link> : <Button onClick={generateBrief} disabled={!canEdit}>Generate Architecture Brief</Button>}
                {state.brief && canEdit && <Button variant="secondary" onClick={generateBrief}>Regenerate brief</Button>}
                {canEdit && <Button variant="ghost" onClick={() => act('Understanding remaining architecture decisions…', () => post('ask-more'))}>Ask me more questions</Button>}
              </div>
            </div>
          )}

          {completed.length > 0 && (
            <details className="rounded-lg border border-border bg-panel p-4 text-sm">
              <summary className="cursor-pointer select-none font-medium">Your earlier answers ({completed.reduce((n, r) => n + r.questions.filter((q) => q.answer).length, 0)})</summary>
              <ul className="mt-3 space-y-3">
                {completed.flatMap((r) => r.questions.filter((q) => q.answer)).map((q) => (
                  <li key={q.id}>
                    <p className="text-muted">{q.question}</p>
                    {q.answer!.choice.kind === 'RECOMMEND'
                      ? <p><Badge tone="warn">We recommended</Badge> <span className="font-medium">{q.answer!.resolvedValue}</span><span className="block text-xs text-muted">{q.answer!.recommendationReason}</span></p>
                      : <p><Badge tone="accent">You answered</Badge> <span className="font-medium">{describeChoice(q, q.answer!.choice)}</span></p>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <aside aria-label="What Pitch2Plan currently understands" className="space-y-5 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto">
          <h2 className="text-sm font-semibold">What Pitch2Plan currently understands</h2>
          <Panel title="Confirmed by you" empty="Nothing confirmed yet." items={mine.map((r) => <RequirementLine key={r.id} req={r} projectId={projectId} canEdit={canEdit} onChanged={reload} hint />)} />
          <Panel title="Our assumptions" note="Not confirmed. Correct anything that is wrong." empty="No assumptions." items={assumed.map((r) => <RequirementLine key={r.id} req={r} projectId={projectId} canEdit={canEdit} onChanged={reload} hint />)} />
          <Panel title="Still to understand" empty="Nothing outstanding." items={openUnknowns.map((u) => <p key={u.id} className="text-sm">{u.text}{u.critical && <Badge tone="warn" className="ml-2">Important</Badge>}</p>)} />
        </aside>
      </div>
    </div>
  );
}

function Panel({ title, note, items, empty }: { title: string; note?: string; items: React.ReactNode[]; empty: string }) {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title} <span className="font-normal">({items.length})</span></h3>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
      {items.length ? <ul className="mt-3 space-y-3">{items.map((it, i) => <li key={i}>{it}</li>)}</ul> : <p className="mt-2 text-sm text-muted">{empty}</p>}
    </section>
  );
}
