import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** Returns immediately; the plan is produced by the worker. Poll GET /api/jobs/:jobId or GET .../implementation. */
export const POST = api<undefined, { projectId: string }>(
  { action: 'implementation.generate', status: 202, rateLimit: { limit: 6, windowMs: 60_000 } },
  async ({ rc, params }) => getContainer().app.implementation.generate(rc, params.projectId),
);
