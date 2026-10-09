import { editRequirementRequestSchema } from '@pitch2plan/schemas';
import type { z } from 'zod';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const PATCH = api<z.infer<typeof editRequirementRequestSchema>, { projectId: string; requirementId: string }>(
  { action: 'requirement.edit', body: editRequirementRequestSchema, rateLimit: { limit: 60, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ requirement: await getContainer().app.discovery.editRequirement(rc, params.projectId, params.requirementId, body) }),
);
