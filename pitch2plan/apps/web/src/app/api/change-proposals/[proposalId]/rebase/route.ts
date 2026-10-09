import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** Re-analyses a stale proposal against the CURRENT architecture as a new proposal that must be approved again. */
export const POST = api<undefined, { proposalId: string }>({ action: 'change.rebase', status: 201, rateLimit: { limit: 10, windowMs: 60_000 } }, async ({ rc, params }) => ({ proposal: await getContainer().app.change.rebase(rc, params.proposalId) }));
