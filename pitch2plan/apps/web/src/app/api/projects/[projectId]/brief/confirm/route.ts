import { confirmBriefRequestSchema } from '@pitch2plan/schemas';
import type { z } from 'zod';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const POST = api<z.infer<typeof confirmBriefRequestSchema>, { projectId: string }>(
  { action: 'brief.confirm', body: confirmBriefRequestSchema, rateLimit: { limit: 10, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ brief: await getContainer().app.briefs.confirm(rc, params.projectId, body) }),
);
