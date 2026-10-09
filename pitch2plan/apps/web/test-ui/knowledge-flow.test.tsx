import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AskArchitect } from '@/components/AskArchitect';
import { ComponentWorkspace } from '@/components/ComponentWorkspace';
import { TaskWorkspace } from '@/components/TaskWorkspace';
import { implementationReadyViaApi, makeSession, pollUntil } from './helpers';

// jsdom components against the real production server (fixture documentation). Separate from the HTTP-only suite on purpose.
const session = makeSession();
beforeAll(() => { session.install(); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterAll(() => session.restore());
afterEach(() => cleanup());
const LONG = { timeout: 60_000 };
const PG = 'https://www.postgresql.org/docs/current/runtime-config-connection.html';
const warm = () => pollUntil(() => session.api<{ docs: { availability: string; documents: unknown[] } }>('/api/technologies/postgresql/docs'), (r) => r.docs.availability === 'READY' && r.docs.documents.length > 0, 'postgresql documentation');

describe('grounded answers in Ask Architect', () => {
  it('shows the grounding status, inline citation chips, the source inspector and what each statement rests on', async () => {
    const { id } = await implementationReadyViaApi(session, 'know-ui-ask'); await warm();
    const user = userEvent.setup();
    render(<AskArchitect projectId={id} scope="COMPONENT" scopeId="primary-database" />);
    await user.type(await screen.findByTestId('ask-input'), 'How do I require TLS for remote clients?{Enter}');
    const msg = await screen.findByTestId('assistant-message', undefined, LONG);

    expect(within(msg).getByTestId('grounding-status').getAttribute('data-status')).toBe('GROUNDED');
    expect(within(msg).getByTestId('grounding-status').textContent).toBe('Grounded in official documentation');
    const chips = within(msg).getAllByTestId('citation-chip');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0]!.getAttribute('aria-label')).toMatch(/^Source 1: .*PostgreSQL connection settings/);

    await user.click(chips[0]!);
    const inspector = await within(msg).findByTestId('source-inspector');
    expect(within(inspector).getByTestId('source-title').textContent).toMatch(/PostgreSQL connection settings/);
    expect(within(inspector).getByTestId('source-type').textContent).toBe('Official documentation');
    const link = within(inspector).getByTestId('source-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(PG); expect(link.getAttribute('rel')).toBe('noopener noreferrer'); expect(link.getAttribute('target')).toBe('_blank');
    expect(within(inspector).getByTestId('source-version').textContent).toBe('Not stated by the page'); // honest about what the page does not say
    expect(within(inspector).getByTestId('source-excerpt').textContent).toMatch(/remote clients/);
    expect(inspector.textContent).toMatch(/snapshot of what the answer relied on/);
    await user.click(within(inspector).getByRole('button', { name: 'Close source' }));
    expect(within(msg).queryByTestId('source-inspector')).toBeNull();

    // Provenance of each statement is visible and labelled.
    await user.click(within(msg).getByText('What each statement rests on'));
    const labels = within(msg).getAllByTestId('claim-label').map((e) => e.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Documented guidance', 'Architecture decision']));
    expect(labels).not.toContain('Unverified');
  });

  it('an off-topic question is shown as NOT grounded, with a reason and no citation chips', async () => {
    const { id } = await implementationReadyViaApi(session, 'know-ui-off'); await warm();
    const user = userEvent.setup();
    render(<AskArchitect projectId={id} scope="COMPONENT" scopeId="primary-database" />);
    await user.type(await screen.findByTestId('ask-input'), 'How do I tune autovacuum workers?{Enter}');
    const msg = await screen.findByTestId('assistant-message', undefined, LONG);
    expect(within(msg).getByTestId('grounding-status').getAttribute('data-status')).not.toBe('GROUNDED');
    expect(within(msg).queryAllByTestId('citation-chip')).toHaveLength(0);
    expect(within(msg).queryByTestId('citation-list')).toBeNull();
  });

  it('commands show whether documentation backs them, and what the user must replace', async () => {
    const { id } = await implementationReadyViaApi(session, 'know-ui-cmd'); await warm();
    const real = globalThis.fetch;
    // The conversation history (a stored answer) is served with a command that has placeholders; the answer itself is real server output elsewhere.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/conversation')) return new Response(JSON.stringify({ data: { conversation: { id: 'c1' }, messages: [
        { id: 'm1', role: 'ASSISTANT', status: 'COMPLETE', content: 'x', structured: { answer: 'Run the check.', warnings: [], commands: [{ command: 'aws rds describe-db-instances --region <REGION>', purpose: 'List instances', risk: 'READ_ONLY', reasons: [], citations: [], placeholders: ['<REGION>'], assumptions: ['Replace <REGION> with your own value.'], documented: false }], codeBlocks: [], validationSteps: [], relatedTasks: [], architectureImpact: '', needsArchitectureChange: false, notices: [],
          grounding: { status: 'PARTIALLY_GROUNDED', reasons: ['1 command is not backed by documentation.'], versionNote: 'The documentation found is for a different version than the one in your architecture (16). Check the behaviour against your version.', availability: 'READY', retrievedCount: 1 }, claims: [], citations: [] } }] } }), { headers: { 'content-type': 'application/json' } });
      return real(url as never, init);
    }) as typeof fetch;
    try {
      render(<AskArchitect projectId={id} scope="COMPONENT" scopeId="primary-database" />);
      const msg = await screen.findByTestId('assistant-message');
      expect(within(msg).getByTestId('grounding-status').getAttribute('data-status')).toBe('PARTIALLY_GROUNDED');
      expect(within(msg).getByTestId('grounding-reasons').textContent).toMatch(/not backed by documentation/);
      expect(within(msg).getByTestId('version-note').textContent).toMatch(/different version/);
      expect(within(msg).getByTestId('command-grounding').getAttribute('data-documented')).toBe('false');
      expect(within(msg).getByTestId('command-placeholders').textContent).toMatch(/<REGION>/);
    } finally { globalThis.fetch = real; }
  });

  it('Phase 5 answers (stored before grounding existed) still render normally, with no grounding panel', async () => {
    const { id } = await implementationReadyViaApi(session, 'know-ui-legacy');
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/conversation')) return new Response(JSON.stringify({ data: { conversation: { id: 'c1' }, messages: [
        { id: 'm1', role: 'ASSISTANT', status: 'COMPLETE', content: 'x', structured: { answer: 'An older answer.', warnings: [], commands: [{ command: 'ls', purpose: 'List files', risk: 'READ_ONLY', reasons: [] }], codeBlocks: [], validationSteps: [], relatedTasks: [], architectureImpact: '', needsArchitectureChange: false, notices: [] } }] } }), { headers: { 'content-type': 'application/json' } });
      return real(url as never, init);
    }) as typeof fetch;
    try {
      render(<AskArchitect projectId={id} scope="PROJECT" />);
      const msg = await screen.findByTestId('assistant-message');
      expect(msg.textContent).toMatch(/An older answer/);
      expect(within(msg).queryByTestId('grounding-panel')).toBeNull();
      expect(within(msg).getByTestId('command-risk').textContent).toBe('Read-only');
      expect(within(msg).queryByTestId('command-grounding')).toBeNull();
    } finally { globalThis.fetch = real; }
  });
});

describe('documentation on tasks and components', () => {
  it('a task shows official documentation, including a preparing state and a step-specific refresh', async () => {
    const { id, taskId } = await implementationReadyViaApi(session, 'know-ui-task');
    const user = userEvent.setup();
    render(<TaskWorkspace projectId={id} taskId={taskId('provision-primary-database')} />);
    const section = await screen.findByTestId('task-docs', undefined, LONG);
    expect(section.textContent).toMatch(/Official documentation/);
    await waitFor(() => expect(within(section).getByTestId('docs-list')).toBeTruthy(), LONG); // "Preparing official documentation…" resolves by itself
    const items = within(section).getAllByTestId('doc-item');
    expect(items.length).toBeGreaterThan(0);
    const first = within(items[0]!).getAllByRole('link')[0] as HTMLAnchorElement;
    expect(first.href).toMatch(/^https:\/\/(www\.postgresql\.org|docs\.aws\.amazon\.com)\//); expect(first.rel).toBe('noopener noreferrer');
    expect(section.textContent).toMatch(/allow-listed official hosts/);
    await user.click((await screen.findAllByRole('button', { name: 'Ask about this step' }))[0]!);
    expect(await screen.findByText('Official documentation for the selected step')).toBeTruthy();
  });

  it('the preparing state is shown while documentation is not ready yet', async () => {
    const { id, taskId } = await implementationReadyViaApi(session, 'know-ui-prep');
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/docs')) return new Response(JSON.stringify({ data: { docs: { availability: 'PREPARING', technologies: [], documents: [], generalReference: false } } }), { headers: { 'content-type': 'application/json' } });
      return real(url as never, init);
    }) as typeof fetch;
    try {
      render(<TaskWorkspace projectId={id} taskId={taskId('provision-primary-database')} />);
      expect((await screen.findByTestId('docs-preparing', undefined, LONG)).textContent).toMatch(/Preparing official documentation…/);
    } finally { globalThis.fetch = real; }
  });

  it('a documentation failure is a calm warning, not a broken page', async () => {
    const { id, taskId } = await implementationReadyViaApi(session, 'know-ui-fail');
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/docs')) return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      return real(url as never, init);
    }) as typeof fetch;
    try {
      render(<TaskWorkspace projectId={id} taskId={taskId('provision-primary-database')} />);
      expect((await screen.findByText(/couldn’t load documentation for this task/, undefined, LONG))).toBeTruthy();
      expect(screen.getByTestId('task-title')).toBeTruthy(); // the rest of the task is unaffected
    } finally { globalThis.fetch = real; }
  });

  it('a component has a Documentation tab with official documents and a search that answers or says nothing matched', async () => {
    const { id } = await implementationReadyViaApi(session, 'know-ui-comp'); await warm();
    const user = userEvent.setup();
    render(<ComponentWorkspace projectId={id} stableKey="primary-database" />);
    await screen.findByTestId('component-title');
    await user.click(screen.getByRole('tab', { name: 'Documentation' }));
    const panel = await screen.findByTestId('component-docs');
    await waitFor(() => expect(within(panel).getByTestId('docs-list')).toBeTruthy(), LONG);
    const input = await within(panel).findByTestId('doc-search-input');
    await user.type(input, 'How do I require TLS for remote clients?{Enter}');
    const results = await within(panel).findByTestId('doc-search-results', undefined, LONG);
    expect(results.textContent).toMatch(/remote clients/);
    expect((within(results).getAllByRole('link')[0] as HTMLAnchorElement).href).toBe(PG);
    await user.clear(input); await user.type(input, 'quantum hyperdrive{Enter}');
    expect((await within(panel).findByTestId('doc-search-empty', undefined, LONG)).textContent).toMatch(/No passage in the indexed official documentation/);
  });

  it('a component whose technology has no documentation says so instead of inventing links', async () => {
    const { id } = await implementationReadyViaApi(session, 'know-ui-none');
    const user = userEvent.setup();
    render(<ComponentWorkspace projectId={id} stableKey="event-stream" />);
    await screen.findByTestId('component-title');
    await user.click(screen.getByRole('tab', { name: 'Documentation' }));
    expect((await screen.findByTestId('docs-empty', undefined, LONG)).textContent).toMatch(/nothing to look up/);
    expect(screen.getByText(/nothing to search/)).toBeTruthy();
  });
});
