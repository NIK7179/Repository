import { updateTaskStatusRequestSchema } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const PATCH = api<{ status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED' | 'SKIPPED'; reason?: string }, { taskId: string }>(
  { action: 'implementation.task.status', body: updateTaskStatusRequestSchema, rateLimit: { limit: 120, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ task: await getContainer().app.implementation.updateStatus(rc, params.taskId, body) }),
);
