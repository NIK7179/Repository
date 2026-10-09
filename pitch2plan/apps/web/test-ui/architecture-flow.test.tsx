import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArchitectureView } from '@/components/ArchitectureView';
import { DecisionsView } from '@/components/DecisionsView';
import { confirmedViaApi, makeSession, PITCH } from './helpers';

const session = makeSession();
const errors: unknown[][] = [];
beforeAll(() => { session.install(); vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); }); });
afterAll(() => session.restore());
afterEach(() => cleanup());

const LONG = { timeout: 60_000 };

describe('architecture UI, driven through the real app', () => {
  it('generates, shows real progress, renders the canvas, and explains components and connections from persisted traceability', async () => {
    const id = await confirmedViaApi(session, 'arch-ui', PITCH);
    const user = userEvent.setup();
    render(<ArchitectureView projectId={id} />);

    await user.click(await screen.findByRole('button', { name: 'Generate architecture' }));
    const progress = await screen.findByTestId('generation-progress', undefined, LONG);
    expect(within(progress).getByText('Analyzing architecture drivers')).toBeTruthy(); // named stages, not "Loading"
    expect(within(progress).getByText('Reviewing risks')).toBeTruthy();
    expect(progress.textContent).not.toMatch(/\d+\s?%/); // no fake percentage
    expect(progress.querySelector('[aria-current="step"]')).toBeTruthy();

    await screen.findByTestId('architecture-canvas', undefined, LONG);
    const summary = screen.getByTestId('architecture-summary');
    expect(summary.textContent).toMatch(/Version 1/);
    expect(summary.textContent).toMatch(/\d+ components/); expect(summary.textContent).toMatch(/\d+ architecture decisions/); expect(summary.textContent).toMatch(/\d+ drivers/);
    expect(screen.getByTestId('architecture-description').textContent).toMatch(/event-driven pipeline/);

    // The canvas renders the persisted components; technology icons come from the registry, with generic fallbacks.
    for (const key of ['web-app', 'api', 'event-producers', 'event-stream', 'stream-processor', 'object-storage', 'primary-database']) expect(await screen.findByTestId(`node-${key}`), key).toBeTruthy();
    const icons = screen.getAllByTestId('tech-icon');
    expect(icons.some((i) => i.getAttribute('data-icon') === 'brand')).toBe(true);
    expect(icons.some((i) => i.getAttribute('data-icon') === 'category')).toBe(true);
    expect(screen.getByText('Select a component or connection')).toBeTruthy();

    // Node click -> inspector with project-specific content, including "Why is this here?"
    // fireEvent (not user-event): d3-drag inside React Flow reads event.view on mousedown, which synthetic user-event mouse events do not set.
    fireEvent.click(screen.getByTestId('node-event-stream'));
    const inspector = await screen.findByTestId('node-inspector');
    expect(within(inspector).getByTestId('inspector-title').textContent).toBe('Event stream');
    const why = within(inspector).getByTestId('why-section');
    expect(within(why).getByTestId('why-summary').textContent).toMatch(/^Managed event streaming is here because of \d+ architecture decision/);
    expect(why.textContent).toMatch(/Because your requirements specify:/);
    expect(why.textContent).toMatch(/REQ-\d{3}/); expect(why.textContent).toMatch(/Related drivers:/); expect(why.textContent).toMatch(/DRV-\d{3}/);
    expect(why.textContent).toMatch(/Architecture decisions:/); expect(why.textContent).toMatch(/ADR-\d{3}/);
    expect(within(inspector).getByTestId('inspector-inputs').textContent).toMatch(/Event producers/);
    expect(within(inspector).getByTestId('inspector-outputs').textContent).toMatch(/Stream processor/);
    for (const heading of ['Overview', 'Role in this architecture', 'Inputs', 'Outputs', 'Configuration considerations', 'Risks', 'Alternatives considered']) expect(within(inspector).getByText(heading), heading).toBeTruthy();
    await user.click(within(why).getByRole('button', { name: /Why is this here/ }));
    expect(within(inspector).queryByTestId('why-summary')).toBeNull(); // it can be collapsed
    await user.click(within(inspector).getByRole('button', { name: /Why is this here/ }));
    expect(within(inspector).getByTestId('why-summary')).toBeTruthy();

    // Selecting another component swaps the inspector.
    fireEvent.click(screen.getByTestId('node-primary-database'));
    await waitFor(() => expect(screen.getByTestId('inspector-title').textContent).toBe('Primary database'));

    // Edge click -> edge inspector.
    fireEvent.click(await screen.findByTestId('rf__edge-producers-stream'));
    const edge = await screen.findByTestId('edge-inspector');
    expect(within(edge).getByTestId('inspector-title').textContent).toBe('Event producers → Event stream');
    expect(edge.textContent).toMatch(/Pattern\s*event/); expect(edge.textContent).toMatch(/Protocol\s*TLS/); expect(edge.textContent).toMatch(/Asynchronous/); expect(edge.textContent).toMatch(/Encrypted in transit/);
    expect(within(edge).getByTestId('edge-decisions').textContent).toMatch(/ADR-\d{3}/);

    // Views and layout reset.
    await user.click(screen.getByRole('tab', { name: 'Data flow' }));
    await waitFor(() => expect(screen.queryByTestId('node-web-app')).toBeNull()); // request/response UI traffic is not data flow
    expect(screen.getByTestId('node-event-stream')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'System architecture' }));
    expect(await screen.findByTestId('node-web-app')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reset layout' }));
    expect(screen.getByTestId('node-event-stream')).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Architecture view' })).toBeTruthy();

    // The decisions page shows the same structured records as ADRs.
    cleanup();
    render(<DecisionsView projectId={id} />);
    const cards = await screen.findAllByTestId('decision-card');
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(cards[0]!.textContent).toMatch(/ADR-001/);
    for (const label of ['Problem', 'Decision', 'Why', 'Related drivers', 'Alternatives considered', 'Trade-offs', 'Affected components']) expect(cards.some((c) => c.textContent?.includes(label)), label).toBe(true);
    expect(cards.some((c) => /Related requirements/.test(c.textContent ?? '') && /REQ-\d{3}/.test(c.textContent ?? ''))).toBe(true);
  });

  it('shows a clear, safe failure with a retry that actually works, and keeps requirements confirmed', async () => {
    const id = await confirmedViaApi(session, 'arch-fail', PITCH);
    const user = userEvent.setup();
    const real = globalThis.fetch;
    let served = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!served && String(url).endsWith(`/projects/${id}/architecture`) && (init?.method ?? 'GET') === 'GET') {
        served = true;
        const now = new Date().toISOString();
        return new Response(JSON.stringify({ data: { architecture: {
          state: 'FAILED', project: { id, name: 'x', status: 'REQUIREMENTS_CONFIRMED' }, versions: [], current: null,
          run: { id: 'r1', jobId: 'j1', status: 'FAILED', currentStage: 'FAILED', repairCount: 2, failureCode: 'ARCHITECTURE_VALIDATION_FAILED', failureMessage: 'We could not produce an architecture that passed all structural checks, even after repair attempts.', createdAt: now, startedAt: now, finishedAt: now, versionId: null },
        } }, requestId: 'req-1' }), { status: 200 });
      }
      return real(url as string, init);
    }) as typeof fetch;
    try {
      render(<ArchitectureView projectId={id} />);
      const failure = await screen.findByRole('alert');
      expect(failure.textContent).toMatch(/couldn.t be completed/);
      expect(screen.getByTestId('failure-message').textContent).toMatch(/structural checks/);
      expect(failure.textContent).toMatch(/Failure code: ARCHITECTURE_VALIDATION_FAILED/);
      expect(failure.textContent).toMatch(/requirements are still confirmed/);
      expect(failure.textContent).not.toMatch(/stack|at Object|Error:|ZodError|undefined/);

      await user.click(screen.getByRole('button', { name: 'Retry Architecture Generation' }));
      await screen.findByTestId('architecture-canvas', undefined, LONG); // the retry was real: a worker ran and a graph appeared
      expect(screen.getByTestId('architecture-summary').textContent).toMatch(/Version 1/);
    } finally { globalThis.fetch = real; }
  });

  it('explains that requirements must be confirmed first when they are not', async () => {
    const id = await session.projectReady('arch-early');
    render(<ArchitectureView projectId={id} />);
    expect(await screen.findByText('Confirm your requirements first')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /generate architecture/i })).toBeNull();
  });

  it('produced no React errors or warnings', () => {
    expect(errors.filter((a) => !String(a[0]).includes('not wrapped in act')).map((a) => a.map((x) => String(x).slice(0, 300)).join(' | '))).toEqual([]);
  });
});
