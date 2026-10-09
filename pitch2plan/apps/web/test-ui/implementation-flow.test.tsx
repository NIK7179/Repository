import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArchitectureView } from '@/components/ArchitectureView';
import { AskArchitect } from '@/components/AskArchitect';
import { ComponentWorkspace } from '@/components/ComponentWorkspace';
import { DecisionsView } from '@/components/DecisionsView';
import { ImplementationView } from '@/components/ImplementationView';
import { TaskWorkspace } from '@/components/TaskWorkspace';
import { architectureReadyViaApi, implementationReadyViaApi, makeSession } from './helpers';

const session = makeSession();
const errors: unknown[][] = [];
beforeAll(() => { session.install(); vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); }); });
afterAll(() => session.restore());
afterEach(() => cleanup());
const LONG = { timeout: 60_000 };
const sse = (...events: Array<Record<string, unknown>>) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

describe('implementation roadmap', () => {
  it('generates a plan, shows real progress, then a phase-oriented roadmap with filters, expansion, a next step and coverage', async () => {
    const id = await architectureReadyViaApi(session, 'impl-roadmap');
    const user = userEvent.setup();
    render(<ImplementationView projectId={id} />);

    await user.click(await screen.findByRole('button', { name: 'Generate implementation plan' }));
    const progress = await screen.findByTestId('implementation-progress', undefined, LONG);
    expect(within(progress).getByText(/Planning the work/)).toBeTruthy();
    expect(progress.textContent).not.toMatch(/\d+\s?%/);
    await screen.findByTestId('impl-progress', undefined, LONG);

    expect(screen.getByTestId('progress-summary').textContent).toMatch(/^0 of \d+ tasks complete · 0%$/);
    expect(screen.getByRole('progressbar', { name: 'Overall implementation progress' }).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByTestId('current-phase').textContent).toBe('Foundation');
    const next = screen.getByTestId('next-task');
    expect(next.textContent).toMatch(/Recommended next step/); expect(next.textContent).toMatch(/Prepare the .* environment and repository/); expect(next.textContent).toMatch(/It has no prerequisites, and it unblocks/);
    expect(within(next).getByRole('link', { name: 'Open task' }).getAttribute('href')).toMatch(/\/implementation\/tasks\/[0-9a-f-]{36}$/);

    // Only the current phase is expanded; others expand and collapse on demand.
    expect(screen.getByTestId('task-prepare-environment')).toBeTruthy();
    expect(screen.queryByTestId('task-provision-primary-database')).toBeNull();
    const dataPhase = screen.getByTestId('phase-data-layer');
    await user.click(within(dataPhase).getByRole('button', { name: /Data layer/ }));
    expect(within(dataPhase).getByRole('button', { name: /Data layer/ }).getAttribute('aria-expanded')).toBe('true');
    const row = screen.getByTestId('task-provision-primary-database');
    expect(row.textContent).toMatch(/Waiting on 1/); expect(row.textContent).toMatch(/1 prerequisite/); // dependency indicators
    expect(within(row).getByRole('link', { name: 'Primary database' }).getAttribute('href')).toBe(`/projects/${id}/components/primary-database`); // task -> component
    expect(dataPhase.textContent).toMatch(/waiting on Foundation/);
    await user.click(within(dataPhase).getByRole('button', { name: /Data layer/ }));
    expect(screen.queryByTestId('task-provision-primary-database')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByTestId('task-monitor-event-stream')).toBeTruthy();

    // Filters.
    await user.click(screen.getByRole('tab', { name: /^Ready/ }));
    expect(screen.getByTestId('task-prepare-environment')).toBeTruthy(); expect(screen.queryByTestId('task-provision-primary-database')).toBeNull();
    await user.click(screen.getByRole('tab', { name: /^Blocked/ }));
    expect(screen.getByTestId('task-provision-primary-database')).toBeTruthy(); expect(screen.queryByTestId('task-prepare-environment')).toBeNull();
    await user.click(screen.getByRole('tab', { name: /^Completed/ }));
    expect(screen.getAllByText('No tasks match this filter.').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('tab', { name: /^All/ }));

    // Coverage.
    const coverage = screen.getByTestId('coverage');
    expect(coverage.textContent).toMatch(/\d+ components · \d+ have implementation tasks/); expect(coverage.textContent).not.toMatch(/uncovered/);
    expect(within(coverage).getByRole('link', { name: 'Event stream' }).getAttribute('href')).toBe(`/projects/${id}/components/event-stream`);
    cleanup();

    // Filtering by decision or component (the targets of "View implementation tasks" and component links).
    const decisionsRes = await session.api<{ architecture: { current: { decisions: Array<{ key: string }> } } }>(`/api/projects/${id}/architecture`);
    const dKey = decisionsRes.architecture.current.decisions[0]!.key;
    render(<ImplementationView projectId={id} decisionFilter={dKey} />);
    await screen.findByTestId('impl-progress'); await user.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByTestId('active-filter').textContent).toMatch(new RegExp(`decision ${dKey.toUpperCase()}`));
    const rows = screen.getAllByTestId(/^task-/); expect(rows.length).toBeGreaterThan(0); expect(rows.length).toBeLessThan(15);
    cleanup();
    render(<ImplementationView projectId={id} componentFilter="event-stream" />);
    await screen.findByTestId('impl-progress'); await user.click(screen.getByRole('button', { name: 'Expand all' }));
    const keys = screen.getAllByTestId(/^task-/).map((r) => r.getAttribute('data-testid')!);
    expect(keys).toEqual(expect.arrayContaining(['task-configure-event-stream', 'task-integrate-producers-stream', 'task-integrate-stream-processor-in', 'task-monitor-event-stream', 'task-provision-event-stream']));
    expect(keys).toContain('task-test-end-to-end'); // the end-to-end test also spans this component
    expect(keys).not.toContain('task-provision-primary-database');
  });

  it('says what happened when planning fails, and retrying really plans again', async () => {
    const id = await architectureReadyViaApi(session, 'impl-fail');
    const real = globalThis.fetch; let served = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!served && String(url).endsWith(`/projects/${id}/implementation`) && (init?.method ?? 'GET') === 'GET') {
        served = true; const now = new Date().toISOString();
        return new Response(JSON.stringify({ data: { implementation: { state: 'FAILED', project: { id, name: 'x', status: 'ARCHITECTURE_READY' }, plan: null,
          run: { id: 'r1', jobId: 'j1', status: 'FAILED', currentStage: 'FAILED', repairCount: 2, failureCode: 'IMPLEMENTATION_VALIDATION_FAILED', failureMessage: 'We could not produce an implementation plan that passed all checks, even after repair attempts.', createdAt: now, startedAt: now, finishedAt: now, planVersionId: null } } }, requestId: 'req-1' }), { status: 200 });
      }
      return real(url as string, init);
    }) as typeof fetch;
    try {
      render(<ImplementationView projectId={id} />);
      const failure = await screen.findByRole('alert');
      expect(failure.textContent).toMatch(/couldn.t be completed/); expect(screen.getByTestId('failure-message').textContent).toMatch(/passed all checks/);
      expect(failure.textContent).toMatch(/architecture is unchanged/); expect(failure.textContent).not.toMatch(/stack|Error:|ZodError|undefined/);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Retry Implementation Plan' }));
      await screen.findByTestId('impl-progress', undefined, LONG);
    } finally { globalThis.fetch = real; }
  });

  it('asks for a ready architecture first', async () => {
    const id = await session.projectReady('impl-early');
    render(<ImplementationView projectId={id} />);
    expect(await screen.findByText('Generate the architecture first')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /generate implementation plan/i })).toBeNull();
  });
});

describe('task workspace', () => {
  it('opens a task, explains why it exists, and walks start -> block -> resume -> steps -> validation -> complete with honest wording', async () => {
    const { id, taskId } = await implementationReadyViaApi(session, 'impl-task');
    const user = userEvent.setup();
    const prep = taskId('prepare-environment');
    render(<TaskWorkspace projectId={id} taskId={prep} />);
    expect((await screen.findByTestId('task-title')).textContent).toMatch(/Prepare the .* environment and repository/);
    expect(screen.getByTestId('task-status').textContent).toBe('Not started');
    for (const h of ['Objective', 'Why this task exists', 'Instructions', 'Expected result', 'Validation']) expect(screen.getByText(h), h).toBeTruthy();
    expect(screen.getByTestId('steps').children).toHaveLength(2);
    expect(screen.getByTestId('ask-architect')).toBeTruthy();
    expect(screen.getByTestId('validation').textContent).toMatch(/Start the task to confirm/);
    expect((screen.getAllByTestId('validation-check')[0] as HTMLInputElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(screen.getByTestId('task-status').textContent).toBe('In progress'));
    expect(screen.getByTestId('validation').textContent).toMatch(/You confirm these checks yourself\. Pitch2Plan has not verified anything/);

    await user.click(screen.getByRole('button', { name: 'Block…' }));
    await user.type(screen.getByTestId('block-reason'), 'Cloud account not approved yet');
    await user.click(screen.getByRole('button', { name: 'Mark blocked' }));
    await waitFor(() => expect(screen.getByTestId('task-status').textContent).toBe('Blocked'));
    expect(screen.getByTestId('history').textContent).toMatch(/In progress → Blocked · “Cloud account not approved yet”/);
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(screen.getByTestId('task-status').textContent).toBe('In progress'));

    const step1 = screen.getByRole('checkbox', { name: 'Step 1 done' }) as HTMLInputElement;
    await user.click(step1); await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Step 1 done' }) as HTMLInputElement).checked).toBe(true));

    // Completion is gated on the user's own confirmation of every check.
    const complete = () => screen.getByTestId('complete-task') as HTMLButtonElement;
    expect(complete().disabled).toBe(true); expect(screen.getByTestId('validation-count').textContent).toBe('0 of 2 checks confirmed');
    const checks = () => screen.getAllByTestId('validation-check') as HTMLInputElement[];
    await waitFor(() => expect(checks()[0]!.disabled).toBe(false)); // wait until the previous request has settled
    await user.click(checks()[0]!); await waitFor(() => expect(screen.getByTestId('validation-count').textContent).toBe('1 of 2 checks confirmed'));
    expect(complete().disabled).toBe(true);
    await waitFor(() => expect(checks()[1]!.disabled).toBe(false));
    await user.click(checks()[1]!); await waitFor(() => expect(complete().disabled).toBe(false));
    expect(screen.getByTestId('validation').textContent).toMatch(/confirmed by you/);
    await user.click(complete());

    const note = await screen.findByTestId('completed-note');
    expect(screen.getByTestId('task-status').textContent).toBe('Completed');
    expect(note.textContent).toMatch(/confirmed by you/); expect(note.textContent).toMatch(/Pitch2Plan did not check your environment/);
    expect(screen.queryByText(/^verified$/i)).toBeNull();
    expect((await screen.findByTestId('next-after-complete')).textContent).toMatch(/secrets storage/); // the deterministic next step
    expect(screen.getByTestId('history').textContent).toMatch(/Not started → In progress/);
  });

  it('refuses to start a task whose prerequisites are unfinished and links to them', async () => {
    const { id, taskId } = await implementationReadyViaApi(session, 'impl-unmet');
    render(<TaskWorkspace projectId={id} taskId={taskId('provision-primary-database')} />);
    expect((await screen.findByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(true);
    const unmet = screen.getByTestId('unmet');
    expect(unmet.textContent).toMatch(/Finish first: Prepare the .* environment/); expect(within(unmet).getByRole('link').getAttribute('href')).toBe(`/projects/${id}/implementation/tasks/${taskId('prepare-environment')}`);
    expect(screen.getByTestId('why-section').textContent).toMatch(/ADR-\d{3}/);
    expect(within(screen.getByTestId('why-section')).getAllByRole('link')[0]!.getAttribute('href')).toBe(`/projects/${id}/decisions`);
    expect(screen.getByTestId('task-component').getAttribute('href')).toBe(`/projects/${id}/components/primary-database`); // task -> architecture component
    expect(screen.getByTestId('task-component').textContent).toMatch(/View architecture component/);
    expect(screen.getByTestId('dependencies')).toBeTruthy();
  });

  it('shows a clear error for a task that is not there', async () => {
    const { id } = await implementationReadyViaApi(session, 'impl-missing');
    render(<TaskWorkspace projectId={id} taskId="00000000-0000-4000-8000-000000000000" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Task not found/);
  });
});

describe('component workspace', () => {
  it('aggregates what to do for one component, keeps architecture facts and AI guidance apart, and links onward', async () => {
    const { id, taskId } = await implementationReadyViaApi(session, 'impl-component');
    const user = userEvent.setup();
    render(<ComponentWorkspace projectId={id} stableKey="event-stream" />);
    expect((await screen.findByTestId('component-title')).textContent).toBe('Event stream');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Implementation', 'Configuration', 'Connections', 'Decisions', 'Risks', 'Monitoring', 'Documentation', 'Ask Architect']);
    expect(screen.getByTestId('component-progress').textContent).toMatch(/0 of \d+ tasks complete/);
    expect(screen.getByTestId('impl-summary').textContent).toMatch(/\d+ tasks remaining/);
    // Nothing is startable yet (the environment must exist first), so it says what is next and that it is waiting.
    expect(screen.getByTestId('impl-summary').textContent).toMatch(/Next up \(waiting on prerequisites\)/);
    expect(screen.getByTestId('current-task').getAttribute('href')).toBe(`/projects/${id}/implementation/tasks/${taskId('provision-event-stream')}`);
    expect(screen.getByTestId('current-task').textContent).toMatch(/Provision Event stream/);

    await user.click(screen.getByRole('tab', { name: 'Implementation' }));
    expect(within(screen.getByTestId('component-tasks')).getAllByRole('link').map((l) => l.textContent).join('|')).toMatch(/Provision|Set up/);
    expect(screen.getByTestId('component-tasks').textContent).toMatch(/Configure and secure Event stream/);
    await user.click(screen.getByRole('tab', { name: 'Configuration' }));
    expect(screen.getAllByText('AI guidance').length).toBeGreaterThan(0); expect(screen.getAllByText('Architecture').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('tab', { name: 'Connections' }));
    expect(screen.getByTestId('connections').textContent).toMatch(/receives from.*Event producers/); expect(screen.getByTestId('connections').textContent).toMatch(/sends to.*Stream processor/);
    await user.click(screen.getByRole('tab', { name: 'Decisions' }));
    const dec = screen.getAllByTestId('component-decision')[0]!;
    expect(within(dec).getByRole('link', { name: 'View implementation tasks' }).getAttribute('href')).toMatch(new RegExp(`^/projects/${id}/implementation\\?decision=adr-\\d{3}$`));
    await user.click(screen.getByRole('tab', { name: 'Risks' })); expect(screen.getByRole('tabpanel').textContent).toMatch(/Risks/);
    await user.click(screen.getByRole('tab', { name: 'Monitoring' })); expect(screen.getByRole('tabpanel').textContent).toMatch(/consumer lag/);
    await user.click(screen.getByRole('tab', { name: 'Ask Architect' })); expect(screen.getByTestId('ask-architect')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View in architecture' }).getAttribute('href')).toBe(`/projects/${id}/architecture`);
  });

  it('works before a plan exists, and reports an unknown component clearly', async () => {
    const id = await architectureReadyViaApi(session, 'impl-component-early');
    render(<ComponentWorkspace projectId={id} stableKey="event-stream" />);
    expect((await screen.findByTestId('impl-summary')).textContent).toMatch(/no implementation plan yet/);
    cleanup();
    render(<ComponentWorkspace projectId={id} stableKey="nope" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Component not found/);
  });
});

describe('architecture <-> implementation navigation', () => {
  it('node inspector offers the implementation workspace and Ask Architect; decisions link to their tasks', async () => {
    const { id } = await implementationReadyViaApi(session, 'impl-nav');
    render(<ArchitectureView projectId={id} />);
    await screen.findByTestId('architecture-canvas', undefined, LONG);
    fireEvent.click(await screen.findByTestId('node-event-stream'));
    const actions = await screen.findByTestId('node-actions');
    expect(within(actions).getByRole('link', { name: 'Open Implementation Workspace' }).getAttribute('href')).toBe(`/projects/${id}/components/event-stream`);
    expect(within(actions).getByRole('link', { name: 'Ask Architect' }).getAttribute('href')).toBe(`/projects/${id}/components/event-stream?tab=Ask%20Architect`);
    cleanup();
    render(<DecisionsView projectId={id} />);
    const links = await screen.findAllByTestId('decision-tasks-link');
    expect(links[0]!.getAttribute('href')).toBe(`/projects/${id}/implementation?decision=adr-001`);
  });
});

describe('Ask Architect', () => {
  it('streams a grounded answer, shows deterministic command safety, flags architecture changes, and keeps the conversation', async () => {
    const { id } = await implementationReadyViaApi(session, 'impl-ask');
    const user = userEvent.setup();
    const { unmount } = render(<AskArchitect projectId={id} scope="COMPONENT" scopeId="event-stream" />);
    await user.click(await screen.findByRole('button', { name: 'Why do I need this?' }));
    const msg = await screen.findByTestId('assistant-message', undefined, LONG);
    expect(msg.textContent).toMatch(/Event stream \(Managed event streaming/); expect(msg.textContent).toMatch(/ADR-\d{3}/);
    expect(screen.getAllByTestId('user-message')[0]!.textContent).toBe('Why do I need this?');

    await user.type(screen.getByTestId('ask-input'), 'I get an access denied error and want to delete and reset the bucket{Enter}'); // Enter sends
    await waitFor(() => expect(screen.getAllByTestId('assistant-message')).toHaveLength(2), LONG);
    const risks = screen.getAllByTestId('command-risk').map((e) => e.textContent);
    expect(risks).toEqual(['Read-only', 'Destructive']);
    const second = screen.getAllByTestId('assistant-message')[1]!;
    expect(second.textContent).toMatch(/Pitch2Plan never runs commands/); expect(second.textContent).toMatch(/Destructive: this can permanently delete/);

    await user.type(screen.getByTestId('ask-input'), 'Could we use something else instead?');
    await user.click(screen.getByTestId('ask-send'));
    const banner = await screen.findByTestId('needs-change-banner', undefined, LONG);
    expect(banner.textContent).toMatch(/An architecture change would be required/); expect(banner.textContent).toMatch(/Nothing was changed/);

    unmount(); render(<AskArchitect projectId={id} scope="COMPONENT" scopeId="event-stream" />); // the conversation is persisted per scope
    await waitFor(() => expect(screen.getAllByTestId('assistant-message')).toHaveLength(3));
    expect(screen.getAllByTestId('user-message')).toHaveLength(3);
    cleanup(); render(<AskArchitect projectId={id} scope="PROJECT" />);
    expect(await screen.findByText('Ask anything about this part of your project.')).toBeTruthy(); // a different scope is a different conversation
  });

  it('shows an error with a retry that reuses the same question, and never duplicates it', async () => {
    const { id } = await implementationReadyViaApi(session, 'impl-ask-retry');
    const real = globalThis.fetch; const keys: string[] = []; let failed = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/assistant/messages')) {
        keys.push(JSON.parse(String(init!.body)).clientMessageId);
        if (!failed) { failed = true; return sse({ type: 'start', conversationId: 'c', userMessageId: 'm' }, { type: 'delta', text: 'Half an ans' }, { type: 'error', code: 'AI_PROVIDER_ERROR', message: 'The assistant is temporarily unavailable. Your question is saved; try again.' }); }
      }
      return real(url as string, init);
    }) as typeof fetch;
    try {
      const user = userEvent.setup();
      render(<AskArchitect projectId={id} scope="PROJECT" />);
      await user.type(await screen.findByTestId('ask-input'), 'What should I do first?{Enter}');
      const err = await screen.findByTestId('ask-error');
      expect(err.textContent).toMatch(/temporarily unavailable/); expect(screen.queryByTestId('assistant-message')).toBeNull(); // the partial text is not kept as an answer
      await user.click(screen.getByTestId('ask-retry'));
      await screen.findByTestId('assistant-message', undefined, LONG);
      expect(screen.queryByTestId('ask-error')).toBeNull();
      expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
      expect(screen.getAllByTestId('user-message')).toHaveLength(1);
      const stored = await session.api<{ messages: Array<{ role: string }> }>(`/api/projects/${id}/conversation?scope=PROJECT`);
      expect(stored.messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);
    } finally { globalThis.fetch = real; }
  });

  it('does not lose a question sent before the saved conversation has finished loading', async () => {
    const { id } = await implementationReadyViaApi(session, 'impl-ask-race');
    const real = globalThis.fetch; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/conversation?')) { const res = await real(url as string, init); await gate; return res; } // the (empty) history arrives LATE
      return real(url as string, init);
    }) as typeof fetch;
    try {
      const user = userEvent.setup();
      render(<AskArchitect projectId={id} scope="PROJECT" />);
      await user.type(await screen.findByTestId('ask-input'), 'Sent before history arrives{Enter}');
      await screen.findByTestId('assistant-message', undefined, LONG);
      release(); await new Promise((r) => setTimeout(r, 300)); // let the late history response be applied
      expect(screen.getAllByTestId('user-message').map((e) => e.textContent)).toEqual(['Sent before history arrives']);
      expect(screen.getAllByTestId('assistant-message')).toHaveLength(1);
    } finally { release(); globalThis.fetch = real; }
  });

  it('can be stopped mid-answer without an error or a saved answer', async () => {
    const { id } = await implementationReadyViaApi(session, 'impl-ask-stop');
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/assistant/messages')) {
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(`event: delta\ndata: ${JSON.stringify({ type: 'delta', text: 'Working on it' })}\n\n`)); init?.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError'))); } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return real(url as string, init);
    }) as typeof fetch;
    try {
      const user = userEvent.setup();
      render(<AskArchitect projectId={id} scope="PROJECT" />);
      await user.type(await screen.findByTestId('ask-input'), 'Take your time{Enter}');
      await waitFor(() => expect(screen.getByTestId('ask-stream').textContent).toBe('Working on it'));
      await user.click(screen.getByTestId('ask-cancel'));
      await waitFor(() => expect(screen.queryByTestId('ask-stream')).toBeNull());
      expect(screen.queryByTestId('ask-error')).toBeNull(); expect(screen.queryByTestId('assistant-message')).toBeNull();
      expect((screen.getByTestId('ask-input') as HTMLTextAreaElement).disabled).toBe(false);
    } finally { globalThis.fetch = real; }
  });

  it('reports a dropped connection as an error, and a bad scope as a normal error before streaming', async () => {
    const { id } = await implementationReadyViaApi(session, 'impl-ask-drop');
    const real = globalThis.fetch; let dropped = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!dropped && String(url).endsWith('/api/assistant/messages')) { dropped = true; return sse({ type: 'start', conversationId: 'c', userMessageId: 'm' }, { type: 'delta', text: 'Cut off' }); }
      return real(url as string, init);
    }) as typeof fetch;
    try {
      const user = userEvent.setup();
      render(<AskArchitect projectId={id} scope="PROJECT" />);
      await user.type(await screen.findByTestId('ask-input'), 'Hello{Enter}');
      expect((await screen.findByTestId('ask-error')).textContent).toMatch(/connection was interrupted/);
      cleanup(); globalThis.fetch = real;
      render(<AskArchitect projectId={id} scope="TASK" scopeId="00000000-0000-4000-8000-000000000000" />);
      await user.type(await screen.findByTestId('ask-input'), 'Hello{Enter}');
      expect((await screen.findByTestId('ask-error')).textContent).toMatch(/Task not found/);
    } finally { globalThis.fetch = real; }
  });
});

describe('quality', () => {
  it('produced no React errors or warnings', () => {
    expect(errors.filter((a) => !String(a[0]).includes('not wrapped in act')).map((a) => a.map((x) => String(x).slice(0, 300)).join(' | '))).toEqual([]);
  });
});
