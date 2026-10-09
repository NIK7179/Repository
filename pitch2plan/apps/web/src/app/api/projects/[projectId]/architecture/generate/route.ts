import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** Returns immediately with the job and run ids. The work happens in the worker; poll GET /api/jobs/:jobId or GET .../architecture. */
export const POST = api<undefined, { projectId: string }>(
  { action: 'architecture.generate', status: 202, rateLimit: { limit: 6, windowMs: 60_000 } },
  async ({ rc, params }) => getContainer().app.architecture.generate(rc, params.projectId),
);
