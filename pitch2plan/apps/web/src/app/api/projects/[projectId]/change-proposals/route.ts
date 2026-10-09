import { createChangeProposalRequestSchema } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string }>({ action: 'change.list' }, async ({ rc, params }) => ({ proposals: await getContainer().app.change.list(rc, params.projectId) }));
/** Creates a PROPOSAL. Nothing about the architecture changes. */
export const POST = api<{ requestedChange: string; reason?: string; source: 'USER_REQUEST' | 'ASSISTANT_RECOMMENDATION' | 'ARCHITECTURE_REVIEW'; assistantConversationId?: string; assistantMessageId?: string; reviewFindingId?: string }, { projectId: string }>(
  { action: 'change.create', status: 201, body: createChangeProposalRequestSchema, rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ proposal: await getContainer().app.change.create(rc, params.projectId, body) }),
);
