'use client';
import { Badge, Input, Textarea, cn } from '@pitch2plan/ui';
import { emptyDraft, type Draft } from '@/lib/drafts';
import type { QuestionDto } from '@/lib/api-client';

const choice = 'flex cursor-pointer items-start gap-3 rounded-md border border-border bg-panel p-3 text-sm transition hover:bg-subtle has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent';

export function QuestionCard({ q, draft, onChange, error, disabled, index }: { q: QuestionDto; draft: Draft; onChange: (d: Draft) => void; error?: string | null; disabled?: boolean; index: number }) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const pickRecommend = (on: boolean) => set(on ? { ...emptyDraft(), recommend: true, advanced: draft.advanced } : { recommend: false });
  const name = `q-${q.id}`;

  return (
    <fieldset disabled={disabled} className="rounded-lg border border-border bg-panel p-5" data-testid="question-card" aria-describedby={error ? `${name}-error` : undefined}>
      <legend className="sr-only">{q.question}</legend>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-medium leading-snug"><span className="mr-2 text-muted">{index + 1}.</span>{q.question}</h3>
        {q.required && <Badge tone="neutral">Required</Badge>}
      </div>
      <details className="mt-1.5 text-sm text-muted"><summary className="cursor-pointer select-none hover:text-fg">Why we&apos;re asking</summary><p className="mt-1.5 max-w-prose">{q.whyItMatters}</p></details>

      <div className="mt-4 space-y-2">
        {(q.answerType === 'SINGLE_SELECT' || q.answerType === 'MULTI_SELECT') && q.options.map((o) => {
          const multi = q.answerType === 'MULTI_SELECT';
          const checked = draft.optionIds.includes(o.id);
          return (
            <label key={o.id} className={choice}>
              <input type={multi ? 'checkbox' : 'radio'} name={name} className="mt-1 accent-[var(--accent)]" checked={checked}
                onChange={() => set({ recommend: false, optionIds: multi ? (checked ? draft.optionIds.filter((x) => x !== o.id) : [...draft.optionIds, o.id]) : [o.id] })} />
              <span><span className="font-medium">{o.label}</span>{o.description && <span className="block text-muted">{o.description}</span>}</span>
            </label>
          );
        })}
        {q.answerType === 'BOOLEAN' && (
          <div className="flex gap-2">
            {[true, false].map((v) => (
              <label key={String(v)} className={cn(choice, 'flex-1')}>
                <input type="radio" name={name} className="mt-1 accent-[var(--accent)]" checked={draft.bool === v} onChange={() => set({ bool: v, recommend: false })} />
                <span className="font-medium">{v ? 'Yes' : 'No'}</span>
              </label>
            ))}
          </div>
        )}
        {q.answerType === 'NUMBER_RANGE' && (
          <div className="flex items-center gap-2">
            <Input aria-label="Minimum" type="number" inputMode="numeric" className="w-32" value={draft.min} min={q.numberRange?.min} max={q.numberRange?.max} onChange={(e) => set({ min: e.target.value, recommend: false })} />
            <span className="text-muted">to</span>
            <Input aria-label="Maximum" type="number" inputMode="numeric" className="w-32" value={draft.max} min={q.numberRange?.min} max={q.numberRange?.max} onChange={(e) => set({ max: e.target.value, recommend: false })} />
            {q.numberRange?.unit && <span className="text-sm text-muted">{q.numberRange.unit}</span>}
          </div>
        )}
        {q.answerType === 'FREE_TEXT' && <Textarea aria-label="Your answer" className="min-h-24" value={draft.text} maxLength={2000} onChange={(e) => set({ text: e.target.value, recommend: false })} />}

        {q.allowRecommendation && (
          <label className={cn(choice, 'border-dashed')}>
            <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={draft.recommend} onChange={(e) => pickRecommend(e.target.checked)} />
            <span><span className="font-medium">Recommend for me</span><span className="block text-muted">We&apos;ll pick a sensible value for your project and show you what we chose and why.</span></span>
          </label>
        )}
      </div>

      {q.advanced && q.advanced.length > 0 && (
        <details className="mt-4 text-sm"><summary className="cursor-pointer select-none text-muted hover:text-fg">Advanced details</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {q.advanced.map((f) => (
              <label key={f.key} className="block space-y-1"><span className="text-muted">{f.label}{f.unit ? ` (${f.unit})` : ''}</span>
                <Input value={draft.advanced[f.key] ?? ''} onChange={(e) => set({ advanced: { ...draft.advanced, [f.key]: e.target.value } })} maxLength={200} />
              </label>
            ))}
          </div>
        </details>
      )}
      {error && <p id={`${name}-error`} role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </fieldset>
  );
}
