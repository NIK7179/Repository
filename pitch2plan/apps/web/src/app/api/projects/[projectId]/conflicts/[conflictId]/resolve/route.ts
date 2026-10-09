import { resolveConflictRequestSchema } from '@pitch2plan/schemas';
import type { z } from 'zod';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const POST = api<z.infer<typeof resolveConflictRequestSchema>, { projectId: string; conflictId: string }>(
  { action: 'conflict.resolve', body: resolveConflictRequestSchema, rateLimit: { limit: 30, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ state: await getContainer().app.discovery.resolveConflict(rc, params.projectId, params.conflictId, body) }),
);
