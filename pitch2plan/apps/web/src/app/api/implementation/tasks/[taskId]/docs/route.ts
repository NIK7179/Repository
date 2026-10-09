import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { taskId: string }>({ action: 'knowledge.task-docs', rateLimit: { limit: 60, windowMs: 60_000 } }, async ({ rc, req, params }) => ({ docs: await getContainer().app.knowledge.access.docsForTask(rc, params.taskId, req.nextUrl.searchParams.get('stepId') ?? undefined) }));
