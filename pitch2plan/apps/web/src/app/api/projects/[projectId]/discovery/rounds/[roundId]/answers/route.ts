import { submitAnswersRequestSchema, type SubmitAnswersRequest } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export const POST = api<SubmitAnswersRequest, { projectId: string; roundId: string }>(
  { action: 'discovery.submit_answers', body: submitAnswersRequestSchema, rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ state: await getContainer().app.discovery.submitAnswers(rc, params.projectId, params.roundId, body) }),
);
