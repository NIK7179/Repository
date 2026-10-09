import { submitPitchRequestSchema, type SubmitPitchRequest } from '@pitch2plan/schemas';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const POST = api<SubmitPitchRequest, { projectId: string }>(
  { action: 'pitch.submit', body: submitPitchRequestSchema, status: 201, rateLimit: { limit: 30, windowMs: 60_000 } },
  async ({ rc, params, body }) => ({ pitch: await getContainer().app.pitches.submit(rc, params.projectId, body) }),
);
