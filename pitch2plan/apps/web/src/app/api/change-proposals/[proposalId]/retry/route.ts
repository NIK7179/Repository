import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const POST = api<undefined, { proposalId: string }>({ action: 'change.retry', status: 202, rateLimit: { limit: 10, windowMs: 60_000 } }, async ({ rc, params }) => ({ proposal: await getContainer().app.change.retry(rc, params.proposalId) }));
