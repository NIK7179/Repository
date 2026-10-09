import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskArchitect } from '@/components/AskArchitect';
import { ChangeProposalView, ChangeRequestsView, NewChangeForm } from '@/components/ChangeViews';
import { ImplementationView } from '@/components/ImplementationView';
import { MigrationReview } from '@/components/MigrationReview';
import { ReviewView } from '@/components/ReviewView';
import { VersionBar, VersionCompare } from '@/components/VersionViews';
import { __setNavigator } from '@/lib/navigate';
import { architectureReadyViaApi, makeSession, pollUntil, startedViaApi } from './helpers';

const session = makeSession(); const nav: string[] = []; const errors: unknown[][] = [];
beforeAll(() => { session.install(); __setNavigator((u) => { nav.push(u); }); vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); }); });
afterAll(() => { session.restore(); __setNavigator(null); });
afterEach(() => cleanup());
beforeEach(() => { nav.length = 0; }); // each test must observe ITS OWN navigation, never a previous test's
const LONG = { timeout: 90_000 }; const T = 170_000;
const KINESIS = 'Replace Managed event streaming with Amazon Kinesis';
type Arch = { architecture: { current: { version: { id: string; versionNumber: number } } } };
const currentVersion = async (id: string) => (await session.api<Arch>(`/api/projects/${id}/architecture`)).architecture.current.version;
type Prop = { proposal: { proposal: { id: string; status: string; source: string; assistantMessageId: string | null; assistantConversationId: string | null; reviewFindingId: string | null } } };
const create = (id: string, text: string, extra: object = {}) => session.api<Prop>(`/api/projects/${id}/change-proposals`, { requestedChange: text, source: 'USER_REQUEST', ...extra }).then((r) => r.proposal.proposal);
const analyze = async (id: string, text: string) => { const p = await create(id, text); await session.api(`/api/change-proposals/${p.id}/analyze`, {}); await pollUntil(() => session.api<Prop>(`/api/change-proposals/${p.id}`), (r) => r.proposal.proposal.status !== 'ANALYZING' && r.proposal.proposal.status !== 'DRAFT', 'analysis'); return p; };
const status = async (pid: string) => (await session.api<Prop>(`/api/change-proposals/${pid}`)).proposal.proposal.status;

describe('the full product path in the UI: change a started architecture without losing history', () => {
  it('request -> impact review (work at risk) -> approve -> V2 -> compare -> plan migration review -> accept; V1 untouched', async () => {
    const { id, plan, taskId } = await startedViaApi(session, 'chg-full'); const user = userEvent.setup();
    const v1 = await currentVersion(id); expect(v1.versionNumber).toBe(1);

    // --- the list is empty, then a request is a PROPOSAL (nothing changes)
    render(<ChangeRequestsView projectId={id} />);
    expect((await screen.findByTestId('change-list')).textContent).toMatch(/No change requests yet/); cleanup();
    render(<NewChangeForm projectId={id} />);
    expect(screen.getByTestId('new-change-form').textContent).toMatch(/Nothing is changed by submitting this/);
    await user.type(screen.getByTestId('change-text'), KINESIS); await user.type(screen.getByTestId('change-reason'), 'We are standardising on AWS');
    await user.click(screen.getByTestId('submit-change'));
    await waitFor(() => expect(nav.at(-1)).toMatch(/\/projects\/[0-9a-f-]{36}\/changes\/[0-9a-f-]{36}$/)); const pid = nav.at(-1)!.split('/').pop()!;
    expect((await currentVersion(id)).id).toBe(v1.id); cleanup();

    // --- impact review
    render(<ChangeProposalView projectId={id} proposalId={pid} />);
    expect((await screen.findByTestId('impact-summary', undefined, LONG)).textContent).toMatch(/Managed event streaming becomes Amazon Kinesis/);
    expect(screen.getByTestId('proposal-status').textContent).toBe('Ready for review'); expect(screen.getByTestId('proposal-request').textContent).toBe(KINESIS);
    expect(within(screen.getByTestId('affected-nodes')).getByText('event-stream').closest('li')!.textContent).toMatch(/Direct/);
    expect(within(screen.getByTestId('affected-nodes')).getByText('event-producers').closest('li')!.textContent).toMatch(/Potential/);
    for (const t of ['affected-decisions', 'affected-drivers', 'affected-requirements', 'affected-edges', 'risks', 'tradeoffs', 'recommendation']) expect(screen.getByTestId(t), t).toBeTruthy();
    expect(screen.getByTestId('affected-requirements').textContent).not.toMatch(/No requirements are affected/);
    const risk = screen.getByTestId('work-at-risk'); expect(risk.textContent).toMatch(/completed/); expect(risk.textContent).toMatch(/Completed work that may become obsolete/); expect(risk.textContent).toMatch(/Provision Event stream/);
    expect(screen.getByTestId('tradeoffs').textContent).toMatch(/does not have pricing data/); // no fake cost precision
    expect(screen.getByTestId('recommendation').textContent).toMatch(/confidence \d+% \(the analyser.s own estimate/);
    expect(screen.getByTestId('decision-panel').textContent).toMatch(/Version 1 and all progress history are preserved/);
    expect(screen.queryByTestId('requirement-changes')).toBeNull(); // a technology swap needs no requirement reconfirmation

    // --- approve: explicit, then the change is applied by the worker
    await user.click(screen.getByTestId('approve'));
    await screen.findByTestId('applied', undefined, LONG);
    expect(screen.getByTestId('applied').textContent).toMatch(/Architecture V2 is now current; V1 is preserved as superseded/);
    expect(screen.getByTestId('approval-record').textContent).toMatch(/approved/);
    const href = screen.getByTestId('view-diff').getAttribute('href')!; const v2 = await currentVersion(id); expect(v2.versionNumber).toBe(2); expect(href).toBe(`/projects/${id}/architecture/compare?from=${v1.id}&to=${v2.id}`); cleanup();

    // --- version history and the compare screen (labels and icons, not only colour)
    render(<VersionBar projectId={id} selectedId={v1.id} />);
    const bar = await screen.findByTestId('version-bar'); expect(within(bar).getByTestId('version-1').textContent).toMatch(/V1 · Superseded/); expect(within(bar).getByTestId('version-2').textContent).toMatch(/V2 · Current .* created by change request “Replace Managed event streaming with Amazon Kinesis”/);
    expect(within(bar).getByTestId('compare-with-current').getAttribute('href')).toBe(href); cleanup();
    render(<VersionCompare projectId={id} from={v1.id} to={v2.id} />);
    await screen.findByTestId('version-compare', undefined, LONG);
    expect(screen.getByTestId('compare-title').textContent).toBe('Architecture V1 → V2');
    expect(screen.getByTestId('diff-summary').textContent).toMatch(/1 component replaced/); expect(screen.getByTestId('diff-summary').textContent).toMatch(/1 decision superseded/);
    expect(screen.getByTestId('diff-nodes').textContent).toMatch(/Replaced.*Event stream.*Managed event streaming → Amazon Kinesis/);
    expect(screen.getByTestId('diff-decisions').textContent).toMatch(/Superseded/);
    const replaced = await screen.findByTestId('diff-event-stream'); expect(replaced.textContent).toMatch(/⇄\s*Replaced/); // a text label AND an icon on the canvas node
    expect((await screen.findByTestId('node-event-stream')).getAttribute('data-diff')).toBe('REPLACED'); expect((screen.getByTestId('node-event-stream').className)).toMatch(/border-double/); // and a distinct border pattern
    expect(screen.queryByTestId('diff-api')).toBeNull(); // unchanged components carry no marker
    cleanup();

    // --- implementation: plan V2 is PENDING; V1 is untouched and still active
    render(<ImplementationView projectId={id} />);
    const banner = await screen.findByTestId('pending-migration', undefined, LONG); expect(banner.textContent).toMatch(/new implementation plan is waiting for your review/);
    const reviewHref = within(banner).getByRole('link').getAttribute('href')!; expect(reviewHref).toMatch(new RegExp(`^/projects/${id}/implementation/migration/[0-9a-f-]{36}\\?from=${plan.version.id}$`)); cleanup();
    const pendingId = /migration\/([0-9a-f-]{36})/.exec(reviewHref)![1]!;
    render(<MigrationReview projectId={id} toPlanId={pendingId} fromPlanId={plan.version.id} />);
    await screen.findByTestId('migration-summary', undefined, LONG);
    expect(screen.getByTestId('migration-title').textContent).toBe('Plan V1 → V2');
    const n = (k: string) => Number(screen.getByTestId(`count-${k}`).textContent);
    expect(n('carried')).toBeGreaterThanOrEqual(2); expect(n('revalidation')).toBeGreaterThanOrEqual(1);
    expect(within(screen.getByTestId('group-revalidation')).getByRole('button', { name: /need re-confirming/ }).getAttribute('aria-expanded')).toBe('true'); // the group that needs the user's attention opens by default
    expect(screen.getByTestId('group-revalidation').textContent).toMatch(/secrets storage/); // system-wide completed work that still needs the user's confirmation
    // Work done directly on the REPLACED component must never be carried forward: open every group and find where it lands.
    for (const g of ['carried', 'removed', 'added', 'unchanged']) { const b = within(screen.getByTestId(`group-${g}`)).getByRole('button'); if (b.getAttribute('aria-expanded') !== 'true') await user.click(b); }
    expect(screen.getByTestId('group-carried').textContent).not.toMatch(/Event stream/); expect(screen.getByTestId('group-carried').textContent).toMatch(/Prepare the .* environment/);
    expect(screen.getByTestId('migration-review').textContent).toMatch(/V1: Completed.*Event stream/s); // it is still listed, with its history, just not as carried forward
    await user.click(screen.getByTestId('accept-migration'));
    expect((await screen.findByText('Migration accepted', undefined, LONG))).toBeTruthy(); expect(screen.queryByTestId('accept-migration')).toBeNull(); cleanup();

    // --- the new plan is active; completed-and-unaffected work carried over; affected work must be re-confirmed; V1 history is exactly as it was
    const o = (await session.api<{ implementation: { plan: { version: { id: string; versionNumber: number }; tasks: Array<{ key: string; status: string }> }; pendingMigration: unknown } }>(`/api/projects/${id}/implementation`)).implementation;
    expect(o.plan.version.versionNumber).toBe(2); expect(o.pendingMigration).toBeNull();
    const st = (k: string) => o.plan.tasks.find((t) => t.key === k)?.status;
    expect(st('prepare-environment')).toBe('COMPLETED'); expect(st('provision-event-stream')).not.toBe('COMPLETED'); // never auto-claimed complete when the architecture changed
    const old = (await session.api<{ plan: { tasks: Array<{ key: string; status: string }> } }>(`/api/implementation/plans/${plan.version.id}`)).plan;
    expect(old.tasks.find((t) => t.key === 'provision-event-stream')!.status).toBe('COMPLETED'); // history stays
    expect(old.tasks.filter((t) => t.status === 'COMPLETED').length).toBe(4);
    void taskId;
  }, T);
});

describe('rejecting, staleness and requirement changes', () => {
  it('reject records the decision and leaves the architecture alone', async () => {
    const id = await architectureReadyViaApi(session, 'chg-reject'); const v1 = await currentVersion(id); const p = await analyze(id, KINESIS); const user = userEvent.setup();
    render(<ChangeProposalView projectId={id} proposalId={p.id} />);
    await screen.findByTestId('decision-panel', undefined, LONG); await user.type(screen.getByTestId('decision-note'), 'Not now'); await user.click(screen.getByTestId('reject'));
    await waitFor(() => expect(screen.getByTestId('proposal-status').textContent).toBe('Rejected')); expect(screen.getByTestId('rejected').textContent).toMatch(/Not now/); expect(screen.getByTestId('rejected').textContent).toMatch(/architecture is unchanged/);
    expect(screen.queryByTestId('approve')).toBeNull(); expect((await currentVersion(id)).id).toBe(v1.id); expect(await status(p.id)).toBe('REJECTED');
    cleanup(); render(<ChangeRequestsView projectId={id} />);
    const row = await screen.findByTestId('change-row'); expect(row.textContent).toMatch(/Rejected/); expect(row.textContent).toMatch(/V1/); expect(row.textContent).toMatch(/Your request/);
  }, T);

  it('a proposal made on an old version is STALE: it cannot be approved, and rebasing re-analyses it as a new proposal needing approval again', async () => {
    const id = await architectureReadyViaApi(session, 'chg-stale'); const user = userEvent.setup();
    const a = await analyze(id, 'Replace Managed PostgreSQL with Amazon DynamoDB'); const b = await analyze(id, KINESIS);
    await session.api(`/api/change-proposals/${b.id}/approve`, { confirmRequirementChanges: false });
    await pollUntil(() => status(b.id), (s) => s === 'APPLIED' || s === 'FAILED', 'application'); expect(await status(b.id)).toBe('APPLIED'); // B produced V2

    render(<ChangeProposalView projectId={id} proposalId={a.id} />);
    const stale = await screen.findByTestId('stale-banner', undefined, LONG); expect(stale.textContent).toMatch(/This request is out of date/); expect(stale.textContent).toMatch(/changed to V2/);
    expect(screen.getByTestId('proposal-status').textContent).toBe('Stale'); expect(screen.queryByTestId('approve')).toBeNull(); expect(screen.queryByTestId('decision-panel')).toBeNull();
    await user.click(screen.getByTestId('rebase'));
    await waitFor(() => expect(nav.at(-1)).toMatch(/changes\/[0-9a-f-]{36}$/)); const successor = nav.at(-1)!.split('/').pop()!; expect(successor).not.toBe(a.id);
    cleanup(); render(<ChangeProposalView projectId={id} proposalId={successor} />);
    await screen.findByTestId('decision-panel', undefined, LONG); expect(screen.getByTestId('proposal-request').textContent).toMatch(/DynamoDB/);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy(); expect(screen.queryByTestId('stale-banner')).toBeNull();
    expect((await session.api<Prop>(`/api/change-proposals/${successor}`)).proposal.proposal.status).toBe('READY_FOR_REVIEW'); // approval is required AGAIN
    expect((await currentVersion(id)).versionNumber).toBe(2); // rebasing changed nothing
  }, T);

  it('a requirement-changing request (multi-region) needs explicit confirmation before it can be approved', async () => {
    const id = await architectureReadyViaApi(session, 'chg-req'); const p = await analyze(id, 'Make the system multi-region'); const user = userEvent.setup();
    render(<ChangeProposalView projectId={id} proposalId={p.id} />);
    const panel = await screen.findByTestId('requirement-changes', undefined, LONG);
    expect(panel.textContent).toMatch(/changes what the system must do/); expect(panel.textContent).toMatch(/New requirement.*multi-region availability/s); expect(panel.textContent).toMatch(/not.*rewritten unless you explicitly confirm/s);
    const approve = screen.getByTestId('approve') as HTMLButtonElement; expect(approve.disabled).toBe(true); expect(screen.getByTestId('decision-panel').textContent).toMatch(/Confirm the requirement changes above to enable approval/);
    await user.click(screen.getByTestId('confirm-requirements')); expect(approve.disabled).toBe(false);
    await user.click(approve); await screen.findByTestId('applied', undefined, LONG);
    const reqs = await session.api<{ requirements?: unknown }>(`/api/projects/${id}`); void reqs; expect((await currentVersion(id)).versionNumber).toBe(2);
  }, T);
});

describe('review and assistant entry points', () => {
  it('review finding -> change proposal keeps its origin; failure-mode analysis is computed from the graph', async () => {
    const id = await architectureReadyViaApi(session, 'chg-review'); const user = userEvent.setup();
    render(<ReviewView projectId={id} />);
    expect((await screen.findByTestId('run-review')).textContent).toBe('Run review'); await user.click(screen.getByTestId('run-review'));
    const summary = await screen.findByTestId('review-summary', undefined, LONG); expect(within(summary).getByTestId('count-HIGH')).toBeTruthy();
    const titles = screen.getAllByTestId('finding'); expect(titles.length).toBeGreaterThan(0); expect(screen.getByTestId('area-RELIABILITY')).toBeTruthy();
    const spof = titles.find((f) => /single point of failure/i.test(f.textContent ?? ''))!; expect(spof).toBeTruthy();
    await user.click(within(spof).getByRole('button')); await user.click(within(spof).getByTestId('finding-propose'));
    await waitFor(() => expect(nav.at(-1)).toMatch(/changes\/[0-9a-f-]{36}$/)); const pid = nav.at(-1)!.split('/').pop()!;
    const prop = (await session.api<Prop>(`/api/change-proposals/${pid}`)).proposal.proposal; expect(prop.source).toBe('ARCHITECTURE_REVIEW'); expect(prop.reviewFindingId).toMatch(/^[0-9a-f-]{36}$/);
    cleanup(); render(<ReviewView projectId={id} />); await screen.findByTestId('failure-mode');
    await waitFor(() => expect(within(screen.getByTestId('failure-select')).getByRole('option', { name: 'Event stream' })).toBeTruthy()); // components load asynchronously
    await user.selectOptions(screen.getByTestId('failure-select'), 'event-stream');
    const res = await screen.findByTestId('failure-result'); expect(res.textContent).toMatch(/Single point of failure/); expect(screen.getByTestId('downstream').textContent).toMatch(/Stream processor/); expect(screen.getByTestId('missing-mitigation').textContent).toMatch(/redundancy|backup|retention/i);
  }, T);

  it('assistant answer that needs an architecture change offers "Propose Architecture Change"; it prefills but creates nothing until the user submits', async () => {
    const id = await architectureReadyViaApi(session, 'chg-assist'); const user = userEvent.setup();
    render(<AskArchitect projectId={id} scope="COMPONENT" scopeId="event-stream" />);
    await user.type(await screen.findByTestId('ask-input'), 'Could we use something else instead?{Enter}');
    const link = await screen.findByTestId('propose-change', undefined, LONG); const href = link.getAttribute('href')!;
    expect(href).toMatch(new RegExp(`^/projects/${id}/changes/new\\?`)); const q = new URL(href, 'http://x').searchParams;
    expect(q.get('text')).toBe('Could we use something else instead?'); expect(q.get('conversation')).toMatch(/^[0-9a-f-]{36}$/); expect(q.get('message')).toMatch(/^[0-9a-f-]{36}$/); expect(q.get('reason')).toMatch(/Replacing/);
    expect((await session.api<{ proposals: unknown[] }>(`/api/projects/${id}/change-proposals`)).proposals).toHaveLength(0); // nothing was created
    cleanup();
    render(<NewChangeForm projectId={id} prefill={{ text: q.get('text')!, reason: q.get('reason')!, conversationId: q.get('conversation')!, messageId: q.get('message')! }} />);
    expect(screen.getByText('Prefilled from the assistant’s answer')).toBeTruthy(); expect((screen.getByTestId('change-text') as HTMLTextAreaElement).value).toBe('Could we use something else instead?');
    fireEvent.change(screen.getByTestId('change-text'), { target: { value: 'Replace Managed event streaming with Amazon Kinesis' } }); await user.click(screen.getByTestId('submit-change'));
    await waitFor(() => expect(nav.at(-1)).toMatch(/changes\/[0-9a-f-]{36}$/)); const pid = nav.at(-1)!.split('/').pop()!;
    const prop = (await session.api<Prop>(`/api/change-proposals/${pid}`)).proposal.proposal; expect(prop.source).toBe('ASSISTANT_RECOMMENDATION'); expect(prop.assistantMessageId).toBe(q.get('message')); expect(prop.assistantConversationId).toBe(q.get('conversation'));
  }, T);
});

describe('quality', () => { it('produced no React errors or warnings', () => { expect(errors.filter((a) => !String(a[0]).includes('not wrapped in act')).map((a) => a.map((x) => String(x).slice(0, 300)).join(' | '))).toEqual([]); }); });
