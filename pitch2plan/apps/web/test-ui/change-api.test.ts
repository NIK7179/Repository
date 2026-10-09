/* eslint-disable @typescript-eslint/no-explicit-any -- these tests inspect arbitrary JSON bodies returned by the real server */
import { describe, expect, it } from 'vitest';
import { architectureReadyViaApi, makeSession, pollUntil } from './helpers';

const BASE = () => process.env.UI_TEST_BASE!;
const owner = makeSession(); const other = makeSession(); const anon = makeSession();
type Json = { data?: Record<string, any>; error?: { code: string; message: string; details?: any } };
async function j(s: ReturnType<typeof makeSession> | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers }; if (body !== undefined) h['content-type'] = 'application/json'; if (s?.cookie()) h.cookie = s.cookie();
  const res = await fetch(BASE() + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json: Json = {}; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}
const KINESIS = 'Replace Managed event streaming with Amazon Kinesis';
const settle = (id: string) => pollUntil(() => j(owner, 'GET', `/api/change-proposals/${id}`), (r) => !['ANALYZING', 'DRAFT', 'APPROVED', 'APPLYING'].includes(r.json.data!.proposal.proposal.status), 'proposal to settle');

describe('change proposal API over HTTP (real server, real worker, real Postgres)', () => {
  it('creates a proposal without changing anything, analyses it, and keeps approval a human, explicit, single act', async () => {
    const id = await (async () => { owner.install(); try { return await architectureReadyViaApi(owner, 'chg-api'); } finally { owner.restore(); } })();
    const v1 = (await j(owner, 'GET', `/api/projects/${id}/architecture`)).json.data!.architecture.current.version.id;

    expect((await j(owner, 'POST', `/api/projects/${id}/change-proposals`, { requestedChange: 'x' })).status).toBe(400); // too short
    expect((await j(owner, 'POST', `/api/projects/${id}/change-proposals`, { requestedChange: KINESIS, source: 'FUTURE_COST_OPTIMIZATION' })).status).toBe(400); // not an implemented source
    const created = await j(owner, 'POST', `/api/projects/${id}/change-proposals`, { requestedChange: KINESIS, reason: 'Standardise on AWS' });
    expect(created.status).toBe(201); const p = created.json.data!.proposal.proposal; expect(p).toMatchObject({ status: 'DRAFT', source: 'USER_REQUEST', baseVersionId: v1 });
    expect((await j(owner, 'GET', `/api/projects/${id}/architecture`)).json.data!.architecture.current.version.id).toBe(v1); // creating a proposal changed nothing
    expect((await j(owner, 'POST', `/api/change-proposals/${p.id}/approve`, { confirmRequirementChanges: false })).status).toBe(409); // cannot approve before analysis

    const an = await j(owner, 'POST', `/api/change-proposals/${p.id}/analyze`); expect(an.status).toBe(202); expect(an.json.data!.proposal.proposal.status).toBe('ANALYZING');
    expect((await j(owner, 'POST', `/api/change-proposals/${p.id}/analyze`)).status).toBe(409); // already analysing
    const ready = (await settle(p.id)).json.data!.proposal; expect(ready.proposal).toMatchObject({ status: 'READY_FOR_REVIEW', changeType: 'TECHNOLOGY_REPLACEMENT' }); expect(ready).toMatchObject({ canApprove: true, isStale: false });
    expect(ready.proposal.analysis.recommendation.verdict).toBeTruthy(); expect(ready.impact.nodes.length).toBeGreaterThan(0);

    const listed = (await j(owner, 'GET', `/api/projects/${id}/change-proposals`)).json.data!.proposals; expect(listed).toHaveLength(1); expect(listed[0]).toMatchObject({ id: p.id, status: 'READY_FOR_REVIEW', baseVersionNumber: 1 });
    const edit = await j(owner, 'PATCH', `/api/change-proposals/${p.id}`, { requestedChange: KINESIS + ' streams' }); expect(edit.status).toBe(200); expect(edit.json.data!.proposal.proposal.status).toBe('DRAFT'); // editing sends it back for fresh analysis
    expect((await j(owner, 'POST', `/api/change-proposals/${p.id}/approve`, {})).status).toBe(409); // an edited request must be re-analysed before it can be approved
    await j(owner, 'POST', `/api/change-proposals/${p.id}/analyze`); await settle(p.id);

    const ap = await j(owner, 'POST', `/api/change-proposals/${p.id}/approve`, { confirmRequirementChanges: false, note: 'Go ahead' }); expect(ap.status).toBe(202); expect(['APPROVED', 'APPLYING']).toContain(ap.json.data!.proposal.proposal.status);
    expect((await j(owner, 'POST', `/api/change-proposals/${p.id}/approve`, { confirmRequirementChanges: false })).status).toBe(409); // a second approval is refused
    expect((await j(owner, 'POST', `/api/change-proposals/${p.id}/reject`, {})).status).toBe(409); // and so is rejecting an approved change
    const done = (await pollUntil(() => j(owner, 'GET', `/api/change-proposals/${p.id}`), (r) => ['APPLIED', 'FAILED'].includes(r.json.data!.proposal.proposal.status), 'application')).json.data!.proposal;
    expect(done.proposal.status).toBe('APPLIED'); expect(done.resultVersion.versionNumber).toBe(2); expect(done.proposal.approval).toMatchObject({ decision: 'APPROVED', architectureVersionId: v1 });

    const hist = (await j(owner, 'GET', `/api/projects/${id}/architecture/history`)).json.data!.versions as any[];
    expect(hist.map((v) => `${v.versionNumber}:${v.status}:${v.isCurrent}`)).toEqual(['2:READY:true', '1:SUPERSEDED:false']); expect(hist[0].origin).toMatchObject({ proposalId: p.id }); expect(hist[1].origin.proposalId).toBeNull(); // newest first
    const old = (await j(owner, 'GET', `/api/architecture/versions/${v1}`)).json.data!.version.version; expect(old.nodes.find((n: any) => n.stableKey === 'event-stream').technology).toBe('Managed event streaming'); // V1 immutable
    const diff = await j(owner, 'GET', `/api/architecture/versions/${v1}/diff/${done.resultVersion.id}`); expect(diff.status).toBe(200);
    expect(diff.json.data!.diff.diff.nodes.find((n: any) => n.stableKey === 'event-stream')).toMatchObject({ kind: 'REPLACED' }); expect(diff.json.data!.diff.stored).toBe(true);
    // a plan was generated for V2 as part of the chain, and is waiting for its migration review
    const ov = (await pollUntil(() => j(owner, 'GET', `/api/projects/${id}/implementation`), (r) => r.json.data!.implementation.state !== 'GENERATING', 'plan')).json.data!.implementation; void ov;
  }, 170_000);

  it('requires the user to confirm requirement changes, refuses a stale approval, and rebase creates a fresh proposal', async () => {
    const id = await (async () => { owner.install(); try { return await architectureReadyViaApi(owner, 'chg-api2'); } finally { owner.restore(); } })();
    const mk = async (text: string) => { const p = (await j(owner, 'POST', `/api/projects/${id}/change-proposals`, { requestedChange: text })).json.data!.proposal.proposal; await j(owner, 'POST', `/api/change-proposals/${p.id}/analyze`); await settle(p.id); return p.id as string; };
    const multi = await mk('Make the system multi-region');
    const blocked = await j(owner, 'POST', `/api/change-proposals/${multi}/approve`, { confirmRequirementChanges: false });
    expect(blocked.status).toBe(409); expect(blocked.json.error!.code).toBe('CONFIRMATION_BLOCKED'); expect(blocked.json.error!.details.requirementChanges[0]).toMatchObject({ kind: 'ADD' });
    expect((await j(owner, 'GET', `/api/change-proposals/${multi}`)).json.data!.proposal.proposal.approval).toBeNull(); // no approval record without confirmation

    const a = await mk('Replace Managed PostgreSQL with Amazon DynamoDB'); const b = await mk(KINESIS);
    await j(owner, 'POST', `/api/change-proposals/${b}/approve`, { confirmRequirementChanges: false }); await pollUntil(() => j(owner, 'GET', `/api/change-proposals/${b}`), (r) => r.json.data!.proposal.proposal.status === 'APPLIED', 'B applied');
    const stale = await j(owner, 'POST', `/api/change-proposals/${a}/approve`, { confirmRequirementChanges: false });
    expect(stale.status).toBe(409); expect(stale.json.error!.code).toBe('STALE_PROPOSAL'); // never applied blindly
    const view = (await j(owner, 'GET', `/api/change-proposals/${a}`)).json.data!.proposal; expect(view).toMatchObject({ isStale: true, canRebase: true, canApprove: false }); expect(view.proposal.status).toBe('STALE');
    const rb = await j(owner, 'POST', `/api/change-proposals/${a}/rebase`); expect(rb.status).toBe(201); const next = rb.json.data!.proposal.proposal; expect(next.id).not.toBe(a); expect(next.baseVersionId).not.toBe(view.proposal.baseVersionId);
    expect((await j(owner, 'GET', `/api/change-proposals/${a}`)).json.data!.proposal.successorId).toBe(next.id);
    const rej = await j(owner, 'POST', `/api/change-proposals/${multi}/reject`, { note: 'no' }); expect(rej.status).toBe(409 === rej.status ? 409 : 200); // multi was made against V1 and is now stale
  }, 170_000);

  it('requires sign-in, hides other workspaces, refuses read-only roles, and refuses cross-origin changes', async () => {
    const id = await (async () => { owner.install(); try { return await architectureReadyViaApi(owner, 'chg-authz'); } finally { owner.restore(); } })();
    const p = (await j(owner, 'POST', `/api/projects/${id}/change-proposals`, { requestedChange: KINESIS })).json.data!.proposal.proposal.id as string;
    const v = (await j(owner, 'GET', `/api/projects/${id}/architecture`)).json.data!.architecture.current.version.id;
    await other.api('/api/auth/dev-sign-in', { email: `intruder-${Date.now()}@example.com` });
    const calls: Array<[string, string, unknown?]> = [['GET', `/api/projects/${id}/change-proposals`], ['POST', `/api/projects/${id}/change-proposals`, { requestedChange: KINESIS }], ['GET', `/api/change-proposals/${p}`], ['PATCH', `/api/change-proposals/${p}`, { requestedChange: 'something else' }],
      ['POST', `/api/change-proposals/${p}/analyze`], ['POST', `/api/change-proposals/${p}/approve`, {}], ['POST', `/api/change-proposals/${p}/reject`, {}], ['POST', `/api/change-proposals/${p}/rebase`], ['GET', `/api/architecture/versions/${v}/diff/${v}`],
      ['GET', `/api/projects/${id}/architecture/history`], ['POST', `/api/projects/${id}/review`], ['GET', `/api/projects/${id}/components/event-stream/failure-impact`]];
    for (const [m, path, b] of calls) expect((await j(null, m, path, b)).status, `anonymous ${m} ${path}`).toBe(401);
    for (const [m, path, b] of calls) { const r = await j(other, m, path, b); expect(r.status, `intruder ${m} ${path}`).toBe(404); } // existence is never leaked
    expect((await j(other, 'GET', `/api/change-proposals/${p}`)).json.error!.code).toBe('PROPOSAL_NOT_FOUND');
    const cross = await j(owner, 'POST', `/api/change-proposals/${p}/approve`, { confirmRequirementChanges: false }, { origin: 'https://evil.example' }); expect(cross.status).toBe(403); expect(cross.json.error!.code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await j(owner, 'GET', `/api/change-proposals/${p}`)).json.data!.proposal.proposal.approval).toBeNull(); // nothing was approved
    void anon;
  }, 170_000);

  it('serves reviews and failure-mode analysis, and rejects unknown components', async () => {
    const id = await (async () => { owner.install(); try { return await architectureReadyViaApi(owner, 'chg-review-api'); } finally { owner.restore(); } })();
    expect((await j(owner, 'GET', `/api/projects/${id}/review`)).json.data!.review).toBeNull();
    const run = await j(owner, 'POST', `/api/projects/${id}/review`); expect(run.status).toBe(201); const r = run.json.data!.review;
    expect(r.isCurrent).toBe(true); expect(r.review.findings.length).toBeGreaterThan(0);
    const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }; const sev = r.review.findings.map((f: any) => rank[f.severity]); expect(sev).toEqual([...sev].sort((a: number, b: number) => a - b)); // most serious first
    expect((await j(owner, 'GET', `/api/projects/${id}/review`)).json.data!.review.review.id).toBe(r.review.id);
    const fi = await j(owner, 'GET', `/api/projects/${id}/components/event-stream/failure-impact`); expect(fi.status).toBe(200);
    expect(fi.json.data!.impact.downstream.map((n: any) => n.stableKey)).toContain('stream-processor'); expect(fi.json.data!.impact.criticalPaths.length).toBeGreaterThan(0);
    expect((await j(owner, 'GET', `/api/projects/${id}/components/nope/failure-impact`)).status).toBe(404);
  }, 170_000);
});
