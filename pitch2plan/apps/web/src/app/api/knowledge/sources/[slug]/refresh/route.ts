import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const POST = api<undefined, { slug: string }>({ action: 'knowledge.refresh', rateLimit: { limit: 6, windowMs: 60_000 }, status: 202 }, async ({ rc, params }) => {
  const run = await getContainer().app.knowledge.access.refresh(rc, decodeURIComponent(params.slug));
  return { run: { id: run.id, status: run.status, kind: run.kind } };
});
