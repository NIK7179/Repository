import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string; stableKey: string }>({ action: 'knowledge.component-docs', rateLimit: { limit: 60, windowMs: 60_000 } }, async ({ rc, params }) => ({ docs: await getContainer().app.knowledge.access.docsForComponent(rc, params.projectId, decodeURIComponent(params.stableKey)) }));
