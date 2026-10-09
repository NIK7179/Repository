import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { planVersionId: string }>({ action: 'implementation.plan' }, async ({ rc, params }) => ({ plan: await getContainer().app.implementation.getPlan(rc, params.planVersionId) }));
