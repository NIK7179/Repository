import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** Queues the impact analysis (a background job); poll GET /api/change-proposals/:id. */
export const POST = api<undefined, { proposalId: string }>({ action: 'change.analyze', status: 202, rateLimit: { limit: 20, windowMs: 60_000 } }, async ({ rc, params }) => ({ proposal: await getContainer().app.change.analyze(rc, params.proposalId) }));
