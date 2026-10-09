import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { slug: string }>({ action: 'knowledge.technology-docs', rateLimit: { limit: 60, windowMs: 60_000 } }, async ({ params }) => ({ docs: await getContainer().app.knowledge.access.docsForTechnology(decodeURIComponent(params.slug)) }));
