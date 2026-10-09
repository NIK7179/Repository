import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { conversationId: string }>({ action: 'conversation.messages' }, async ({ rc, params, req }) =>
  getContainer().app.assistant.listMessages(rc, params.conversationId, Number(req.nextUrl.searchParams.get('limit') ?? 50) || 50));
