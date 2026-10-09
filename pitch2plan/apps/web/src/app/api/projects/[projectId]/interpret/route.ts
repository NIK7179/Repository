import { interpretRequestSchema, type InterpretRequest } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export const POST = api<InterpretRequest, { projectId: string }>(
  { action: 'idea.interpret', body: interpretRequestSchema, status: 201, rateLimit: { limit: 10, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ interpretation: await getContainer().app.interpretation.interpret(rc, params.projectId, body) }),
);
