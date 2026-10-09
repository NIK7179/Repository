import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** Accepts the reviewed progress migration and activates the new plan. Never automatic. */
export const POST = api<undefined, { planVersionId: string }>({ action: 'implementation.migration.accept', rateLimit: { limit: 10, windowMs: 60_000 } }, async ({ rc, params }) => ({ migration: await getContainer().app.change.acceptMigration(rc, params.planVersionId) }));
