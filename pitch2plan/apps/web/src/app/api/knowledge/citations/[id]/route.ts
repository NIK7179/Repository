import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { id: string }>({ action: 'knowledge.citation', rateLimit: { limit: 120, windowMs: 60_000 } }, async ({ rc, params }) => ({ citation: await getContainer().app.knowledge.access.getCitation(rc, params.id) }));
