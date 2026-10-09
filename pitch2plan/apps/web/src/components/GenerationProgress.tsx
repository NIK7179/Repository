import { Badge } from '@pitch2plan/ui';
import type { RunDto } from '@/lib/api-client';

/** Real backend stages only. There is deliberately no percentage: the backend cannot measure one. */
export const STAGES: Array<{ id: string; label: string }> = [
  { id: 'QUEUED', label: 'Waiting for a worker to pick this up' },
  { id: 'ANALYZING_DRIVERS', label: 'Analyzing architecture drivers' },
  { id: 'PLANNING', label: 'Designing system boundaries and selecting technologies' },
  { id: 'VALIDATING', label: 'Validating architecture' },
  { id: 'CRITIQUING', label: 'Reviewing risks' },
  { id: 'REPAIRING', label: 'Repairing issues found in review' },
  { id: 'FINALIZING', label: 'Finalizing architecture' },
];

export function GenerationProgress({ run }: { run: RunDto | null }) {
  const current = run?.currentStage ?? 'QUEUED';
  const index = Math.max(0, STAGES.findIndex((s) => s.id === current));
  return (
    <div role="status" aria-live="polite" className="mx-auto max-w-lg rounded-lg border border-border bg-panel p-6" data-testid="generation-progress">
      <h2 className="text-base font-semibold">Designing your architecture</h2>
      <p className="mt-1 text-sm text-muted">This usually takes a minute or two. You can leave this page; we&apos;ll keep working.</p>
      <ol className="mt-4 space-y-2">
        {STAGES.filter((s) => s.id !== 'REPAIRING' || index >= 5 || (run?.repairCount ?? 0) > 0).map((s) => {
          const i = STAGES.findIndex((x) => x.id === s.id);
          const state = i < index ? 'done' : i === index ? 'current' : 'todo';
          return (
            <li key={s.id} data-state={state} aria-current={state === 'current' ? 'step' : undefined} className={`flex items-center gap-3 text-sm ${state === 'todo' ? 'text-muted' : ''}`}>
              {state === 'current' ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden /> : <span aria-hidden className={`grid h-3.5 w-3.5 place-items-center rounded-full text-[9px] ${state === 'done' ? 'bg-ok text-accent-fg' : 'border border-border'}`}>{state === 'done' ? '✓' : ''}</span>}
              <span className={state === 'current' ? 'font-medium' : ''}>{s.label}</span>
              {s.id === 'REPAIRING' && (run?.repairCount ?? 0) > 0 && <Badge tone="warn">round {run!.repairCount}</Badge>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
