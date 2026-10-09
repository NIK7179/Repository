import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { planVersionId: string; otherPlanId: string }>({ action: 'implementation.diff' }, async ({ rc, params }) => ({ diff: await getContainer().app.change.planDiff(rc, params.planVersionId, params.otherPlanId) }));
