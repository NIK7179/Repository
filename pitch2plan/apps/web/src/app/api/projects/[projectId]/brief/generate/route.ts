import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export const POST = api<undefined, { projectId: string }>(
  { action: 'brief.generate', status: 201, rateLimit: { limit: 10, windowMs: 60_000 } },
  async ({ rc, params }) => ({ brief: await getContainer().app.briefs.generate(rc, params.projectId) }),
);
