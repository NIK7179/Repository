import { conversationScopeSchema } from '@pitch2plan/schemas';
import { DomainError } from '@pitch2plan/domain';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** The caller's own conversation for a scope (PROJECT | COMPONENT | TASK), or null. */
export const GET = api<undefined, { projectId: string }>({ action: 'conversation.get' }, async ({ rc, params, req }) => {
  const scope = conversationScopeSchema.safeParse(req.nextUrl.searchParams.get('scope') ?? 'PROJECT');
  if (!scope.success) throw new DomainError('VALIDATION_ERROR', 'Unknown conversation scope.');
  return getContainer().app.assistant.getConversation(rc, { projectId: params.projectId, scope: scope.data, scopeId: req.nextUrl.searchParams.get('scopeId') ?? undefined });
});
