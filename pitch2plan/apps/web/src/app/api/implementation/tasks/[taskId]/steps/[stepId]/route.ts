import { updateStepRequestSchema } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const PATCH = api<{ status: 'NOT_STARTED' | 'COMPLETED' }, { taskId: string; stepId: string }>(
  { action: 'implementation.task.step', body: updateStepRequestSchema, rateLimit: { limit: 240, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ step: await getContainer().app.implementation.updateStep(rc, params.taskId, params.stepId, body.status) }),
);
