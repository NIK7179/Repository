import { rejectChangeProposalRequestSchema } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const POST = api<{ note?: string }, { proposalId: string }>({ action: 'change.reject', body: rejectChangeProposalRequestSchema, rateLimit: { limit: 20, windowMs: 60_000 } }, async ({ rc, params, body }) => ({ proposal: await getContainer().app.change.reject(rc, params.proposalId, body) }));
