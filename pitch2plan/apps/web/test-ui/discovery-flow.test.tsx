import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BriefReview } from '@/components/BriefReview';
import { DiscoveryWorkspace } from '@/components/DiscoveryWorkspace';
import { makeSession, push } from './helpers';

const session = makeSession();
const errors: unknown[][] = [];
beforeAll(() => { session.install(); vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); }); });
afterAll(() => session.restore());
afterEach(() => { cleanup(); push.mockClear(); });

const cards = () => screen.findAllByTestId('question-card');
async function answerAll(user: ReturnType<typeof userEvent.setup>, choose: (card: HTMLElement, i: number) => Promise<void> | void) {
  const all = await cards();
  for (const [i, c] of all.entries()) await choose(c, i);
}
const pickFirst = async (user: ReturnType<typeof userEvent.setup>, card: HTMLElement) => user.click(within(card).getAllByRole('radio')[0]!);

describe('discovery and brief, driven through the real UI', () => {
  it('goes from first question to confirmed requirements, showing recommendations and origins clearly', async () => {
    const id = await session.projectReady('flow');
    const user = userEvent.setup();
    render(<DiscoveryWorkspace projectId={id} />);

    // Discovery starts by itself and asks questions derived from this idea.
    expect(await screen.findByRole('heading', { name: 'Round 1' })).toBeTruthy();
    const round1 = await cards();
    expect(round1.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByLabelText('Discovery progress')).toBeTruthy();
    const side = screen.getByRole('complementary', { name: /currently understands/i });
    expect(within(side).getAllByText('You said').length).toBeGreaterThan(0);
    expect(within(side).getAllByText('We inferred').length).toBeGreaterThan(0);
    expect(within(side).getByText('Still to understand')).toBeTruthy();

    // "Why we're asking" is available, and a required choice is enforced client-side only when required.
    expect(within(round1[0]!).getByText(/why we.re asking/i)).toBeTruthy();

    // Answer: first option for all, but ask Pitch2Plan to recommend for the third question.
    await answerAll(user, async (card, i) => { if (i === 2) await user.click(within(card).getByRole('checkbox', { name: /recommend for me/i })); else await pickFirst(user, card); });
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));
    expect(await screen.findByTestId('busy')).toBeTruthy(); // meaningful loading text, not a fake percentage

    // Round 2 arrives for what is still open.
    expect(await screen.findByRole('heading', { name: 'Round 2' }, { timeout: 20_000 })).toBeTruthy();
    expect(screen.getAllByText('You answered').length).toBeGreaterThan(0);
    expect(screen.getAllByText('We recommended').length).toBeGreaterThan(0); // clearly marked as ours, in the sidebar
    await user.click(screen.getByText(/your earlier answers/i));
    expect(await screen.findByText(/chosen as a balanced default/i)).toBeTruthy(); // the reason is shown

    await answerAll(user, async (card) => pickFirst(user, card));
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));
    const ready = await screen.findByTestId('ready-card', undefined, { timeout: 20_000 });
    await user.click(within(ready).getByRole('button', { name: 'Generate Architecture Brief' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/projects/${id}/brief`), { timeout: 20_000 });
    cleanup();

    // The brief screen.
    render(<BriefReview projectId={id} />);
    const summary = await screen.findByTestId('brief-summary');
    expect(summary.textContent).toMatch(/./);
    expect(screen.getByRole('heading', { name: /core capabilities/i })).toBeTruthy();
    expect((await screen.findByTestId('brief-drivers')).textContent).toMatch(/critical|high|medium|low/i);
    expect(screen.getAllByTestId('brief-item').length).toBeGreaterThan(0);

    // Edit a requirement inline: the brief becomes stale and must be regenerated before confirming.
    const confirm = screen.getByRole('button', { name: 'Confirm requirements' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await user.click(within(screen.getAllByTestId('brief-item')[0]!).getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Requirement' });
    await user.clear(box); await user.type(box, 'Edited by the user in the brief review.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/requirements changed after this brief was written/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Confirm requirements' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getAllByRole('button', { name: 'Regenerate brief' })[0]!);
    await waitFor(() => expect(screen.queryByText(/requirements changed after this brief was written/i)).toBeNull(), { timeout: 20_000 });
    expect(screen.getAllByText('You edited').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Confirm requirements' }));
    expect(await screen.findByText('Requirements confirmed', undefined, { timeout: 20_000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm requirements' })).toBeNull();
  });

  it('shows a contradiction, blocks the brief until it is resolved, and lets the user choose', async () => {
    const id = await session.projectReady('conflict');
    const user = userEvent.setup();
    render(<DiscoveryWorkspace projectId={id} />);
    const round1 = await cards();
    // Latency question is the second one: choose "Batch processing is fine", which contradicts "in real time" from the pitch.
    for (const [i, c] of round1.entries()) {
      const radios = within(c).getAllByRole('radio');
      await user.click(i === 1 ? radios[3]! : radios[0]!);
    }
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));
    const conflict = await screen.findByTestId('conflict-card', undefined, { timeout: 20_000 });
    expect(conflict.textContent).toMatch(/timing conflict/i);
    expect((within(conflict).getByRole('button', { name: 'Resolve' }) as HTMLButtonElement).disabled).toBe(true); // must choose first
    await user.click(within(conflict).getAllByRole('radio')[0]!);
    await user.click(within(conflict).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(screen.queryByTestId('conflict-card')).toBeNull(), { timeout: 20_000 });
  });

  it('shows recoverable errors instead of failing silently', async () => {
    const id = await session.projectReady('error');
    const user = userEvent.setup();
    const realFetch = globalThis.fetch;
    render(<DiscoveryWorkspace projectId={id} />);
    await cards();
    await answerAll(user, (c) => pickFirst(user, c));
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'AI_OUTPUT_INVALID', message: 'The AI response did not pass validation, so it was discarded.', requestId: 'req-x' } }), { status: 502 })) as typeof fetch;
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn.t process that this time/i);
    expect(alert.textContent).toMatch(/answers are saved|resubmit/i);
    expect(alert.textContent).toContain('req-x');
    globalThis.fetch = realFetch;
    expect(screen.getByRole('button', { name: /submit answers|resubmit answers/i })).toBeTruthy(); // the user can retry
  });

  it('lets the user stop early; open items appear in the brief as assumptions that must be accepted', async () => {
    const id = await session.projectReady('early');
    const user = userEvent.setup();
    render(<DiscoveryWorkspace projectId={id} />);
    await cards();
    await user.click(screen.getByRole('button', { name: 'Generate brief now' }));
    const ready = await screen.findByTestId('ready-card');
    expect(ready.textContent).toMatch(/stop early/i);
    await user.click(within(ready).getByRole('button', { name: 'Generate Architecture Brief' }));
    await waitFor(() => expect(push).toHaveBeenCalled(), { timeout: 20_000 });
    cleanup();
    render(<BriefReview projectId={id} />);
    const panel = await screen.findByTestId('confirm-panel');
    const confirm = within(panel).getByRole('button', { name: 'Confirm requirements' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // critical unknowns not yet accepted
    for (const box of within(panel).getAllByRole('checkbox')) await user.click(box);
    expect(confirm.disabled).toBe(false);
    expect((await screen.findByTestId('brief-open')).textContent).toMatch(/volume/i);
  });

  it('produced no React errors or warnings while doing all of the above', () => {
    const real = errors.filter((a) => !String(a[0]).includes('not wrapped in act'));
    expect(real).toEqual([]);
  });
});
