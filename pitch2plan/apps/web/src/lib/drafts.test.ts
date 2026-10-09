import { describe, expect, it } from 'vitest';
import { draftFromChoice, draftToAnswer, emptyDraft } from './drafts';

const base = { id: 'q1', required: false, allowRecommendation: true };
describe('draftToAnswer', () => {
  it('maps each answer type', () => {
    expect(draftToAnswer({ ...base, answerType: 'SINGLE_SELECT' }, { ...emptyDraft(), optionIds: ['a', 'b'] }).answer).toEqual({ questionId: 'q1', choice: { kind: 'OPTIONS', optionIds: ['a'] } });
    expect(draftToAnswer({ ...base, answerType: 'MULTI_SELECT' }, { ...emptyDraft(), optionIds: ['a', 'b'] }).answer!.choice).toEqual({ kind: 'OPTIONS', optionIds: ['a', 'b'] });
    expect(draftToAnswer({ ...base, answerType: 'BOOLEAN' }, { ...emptyDraft(), bool: false }).answer!.choice).toEqual({ kind: 'BOOLEAN', value: false });
    expect(draftToAnswer({ ...base, answerType: 'FREE_TEXT' }, { ...emptyDraft(), text: '  hello  ' }).answer!.choice).toEqual({ kind: 'FREE_TEXT', text: 'hello' });
  });
  it('lets "Recommend for me" win over a selection, but only where allowed', () => {
    const d = { ...emptyDraft(), optionIds: ['a'], recommend: true };
    expect(draftToAnswer({ ...base, answerType: 'SINGLE_SELECT' }, d).answer!.choice).toEqual({ kind: 'RECOMMEND' });
    expect(draftToAnswer({ ...base, allowRecommendation: false, answerType: 'SINGLE_SELECT' }, d).answer!.choice).toEqual({ kind: 'OPTIONS', optionIds: ['a'] });
  });
  it('skips untouched optional questions and flags untouched required ones', () => {
    expect(draftToAnswer({ ...base, answerType: 'SINGLE_SELECT' }, emptyDraft()).answer!.choice).toEqual({ kind: 'SKIP' });
    expect(draftToAnswer({ ...base, required: true, answerType: 'SINGLE_SELECT' }, emptyDraft()).error).toMatch(/answer this question/);
  });
  it('validates number ranges', () => {
    const q = { ...base, answerType: 'NUMBER_RANGE' as const, numberRange: { min: 0, max: 100 } };
    expect(draftToAnswer(q, { ...emptyDraft(), min: '5', max: '1' }).error).toMatch(/minimum/);
    expect(draftToAnswer(q, { ...emptyDraft(), min: '5' }).error).toMatch(/both/);
    expect(draftToAnswer(q, { ...emptyDraft(), min: '5', max: '500' }).error).toMatch(/between 0 and 100/);
    expect(draftToAnswer(q, { ...emptyDraft(), min: '5', max: '50' }).answer!.choice).toEqual({ kind: 'NUMBER_RANGE', min: 5, max: 50 });
  });
  it('carries advanced details, converting numbers and dropping blanks', () => {
    const q = { ...base, answerType: 'SINGLE_SELECT' as const, advanced: [{ key: 'rps', label: 'Requests/s' }, { key: 'note', label: 'Note' }, { key: 'x', label: 'X' }] };
    const r = draftToAnswer(q, { ...emptyDraft(), optionIds: ['a'], advanced: { rps: '250', note: 'peaky', x: '  ' } });
    expect(r.answer).toMatchObject({ advanced: { rps: 250, note: 'peaky' } });
    expect(Object.keys(r.answer!.advanced!)).toEqual(['rps', 'note']);
  });
  it('round-trips stored answers back into drafts', () => {
    expect(draftFromChoice({ kind: 'OPTIONS', optionIds: ['b'] }).optionIds).toEqual(['b']);
    expect(draftFromChoice({ kind: 'RECOMMEND' }).recommend).toBe(true);
    expect(draftFromChoice({ kind: 'NUMBER_RANGE', min: 1, max: 9 }, { rps: 5 })).toMatchObject({ min: '1', max: '9', advanced: { rps: '5' } });
  });
});
