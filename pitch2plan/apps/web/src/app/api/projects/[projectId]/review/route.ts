import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string }>({ action: 'review.latest' }, async ({ rc, params }) => ({ review: await getContainer().app.change.latestReview(rc, params.projectId) }));
/** Runs a production-readiness review of the CURRENT architecture version. */
export const POST = api<undefined, { projectId: string }>({ action: 'review.run', status: 201, rateLimit: { limit: 6, windowMs: 60_000 } }, async ({ rc, params }) => ({ review: await getContainer().app.change.runReview(rc, params.projectId) }));
