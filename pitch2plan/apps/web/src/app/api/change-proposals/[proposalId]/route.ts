import { editChangeProposalRequestSchema } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { proposalId: string }>({ action: 'change.get' }, async ({ rc, params }) => ({ proposal: await getContainer().app.change.get(rc, params.proposalId) }));
export const PATCH = api<{ requestedChange: string; reason?: string }, { proposalId: string }>(
  { action: 'change.edit', body: editChangeProposalRequestSchema, rateLimit: { limit: 30, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ proposal: await getContainer().app.change.edit(rc, params.proposalId, body) }),
);
