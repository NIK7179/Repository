import { approveChangeProposalRequestSchema } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** The explicit human decision. Only a signed-in person's request reaches this; no AI path exists to it. Applying the change then runs as a background job. */
export const POST = api<{ confirmRequirementChanges: boolean; note?: string }, { proposalId: string }>(
  { action: 'change.approve', status: 202, body: approveChangeProposalRequestSchema, rateLimit: { limit: 10, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ proposal: await getContainer().app.change.approve(rc, params.proposalId, body) }),
);
