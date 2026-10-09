import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export const POST = api<undefined, { projectId: string }>(
  { action: 'discovery.askMore', rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ rc, params }) => ({ state: await getContainer().app.discovery.askMore(rc, params.projectId) }),
);
