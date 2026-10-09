import { DomainError } from '@pitch2plan/domain';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api({ action: 'knowledge.search', rateLimit: { limit: 30, windowMs: 60_000 } }, async ({ rc, req }) => {
  const p = req.nextUrl.searchParams; const q = (p.get('q') ?? '').trim();
  if (q.length < 2 || q.length > 300) throw new DomainError('VALIDATION_ERROR', 'Enter 2 to 300 characters to search.');
  return getContainer().app.knowledge.access.search(rc, { query: q, technologySlug: p.get('technology') ?? undefined, projectId: p.get('projectId') ?? undefined });
});
