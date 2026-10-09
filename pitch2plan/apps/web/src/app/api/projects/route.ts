import { createProjectRequestSchema } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';

export const GET = api({ action: 'projects.list' }, async ({ rc }) => ({ projects: await getContainer().app.projects.list(rc) }));

export const POST = api(
  { action: 'projects.create', body: createProjectRequestSchema, status: 201, rateLimit: { limit: 30, windowMs: 60_000 } },
  async ({ rc, body }) => ({ project: await getContainer().app.projects.create(rc, body) }),
);
