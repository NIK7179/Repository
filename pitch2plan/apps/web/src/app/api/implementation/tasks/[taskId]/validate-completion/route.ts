import { validateCompletionRequestSchema } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** Records the USER's confirmation of validation steps. It does not check any external system. */
export const POST = api<{ confirmations: Array<{ position: number; confirmed: boolean }> }, { taskId: string }>(
  { action: 'implementation.task.validate', body: validateCompletionRequestSchema, rateLimit: { limit: 120, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ validation: await getContainer().app.implementation.confirmValidation(rc, params.taskId, body.confirmations) }),
);
