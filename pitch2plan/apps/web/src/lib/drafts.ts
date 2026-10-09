import type { AnswerInput, DiscoveryQuestion } from '@pitch2plan/schemas';

/** The UI-side draft of one answer, before it becomes an API payload. */
export interface Draft { optionIds: string[]; bool: boolean | null; min: string; max: string; text: string; recommend: boolean; advanced: Record<string, string> }
export const emptyDraft = (): Draft => ({ optionIds: [], bool: null, min: '', max: '', text: '', recommend: false, advanced: {} });

type Q = Pick<DiscoveryQuestion, 'answerType' | 'required' | 'allowRecommendation' | 'numberRange' | 'advanced'> & { id: string };
export type DraftResult = { answer: AnswerInput; error?: undefined } | { answer?: undefined; error: string };

/** Turns a draft into a validated-shape answer, or a human error. Optional, untouched questions become SKIP. */
export function draftToAnswer(q: Q, d: Draft): DraftResult {
  const advanced: Record<string, string | number> = {};
  for (const f of q.advanced ?? []) {
    const raw = d.advanced[f.key]?.trim();
    if (raw) advanced[f.key] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  const withAdvanced = (choice: AnswerInput['choice']): DraftResult => ({ answer: { questionId: q.id, choice, ...(Object.keys(advanced).length ? { advanced } : {}) } });
  if (d.recommend && q.allowRecommendation) return withAdvanced({ kind: 'RECOMMEND' });
  switch (q.answerType) {
    case 'SINGLE_SELECT': case 'MULTI_SELECT':
      if (d.optionIds.length) return withAdvanced({ kind: 'OPTIONS', optionIds: q.answerType === 'SINGLE_SELECT' ? d.optionIds.slice(0, 1) : d.optionIds });
      break;
    case 'BOOLEAN':
      if (d.bool !== null) return withAdvanced({ kind: 'BOOLEAN', value: d.bool });
      break;
    case 'NUMBER_RANGE': {
      if (d.min.trim() === '' && d.max.trim() === '') break;
      const min = Number(d.min), max = Number(d.max);
      if (d.min.trim() === '' || d.max.trim() === '' || !Number.isFinite(min) || !Number.isFinite(max)) return { error: 'Enter both a minimum and a maximum.' };
      if (min > max) return { error: 'The minimum cannot be higher than the maximum.' };
      if (q.numberRange && (min < q.numberRange.min || max > q.numberRange.max)) return { error: `Use values between ${q.numberRange.min} and ${q.numberRange.max}.` };
      return withAdvanced({ kind: 'NUMBER_RANGE', min, max });
    }
    case 'FREE_TEXT':
      if (d.text.trim()) return withAdvanced({ kind: 'FREE_TEXT', text: d.text.trim() });
      break;
  }
  return q.required ? { error: 'Please answer this question.' } : { answer: { questionId: q.id, choice: { kind: 'SKIP' } } };
}

/** Rebuilds a draft from a stored answer (used when a round's answers were saved but not yet processed). */
export function draftFromChoice(choice: AnswerInput['choice'], advanced?: Record<string, string | number> | null): Draft {
  const d = emptyDraft();
  if (choice.kind === 'OPTIONS') d.optionIds = [...choice.optionIds];
  if (choice.kind === 'BOOLEAN') d.bool = choice.value;
  if (choice.kind === 'NUMBER_RANGE') { d.min = String(choice.min); d.max = String(choice.max); }
  if (choice.kind === 'FREE_TEXT') d.text = choice.text;
  if (choice.kind === 'RECOMMEND') d.recommend = true;
  for (const [k, v] of Object.entries(advanced ?? {})) d.advanced[k] = String(v);
  return d;
}
