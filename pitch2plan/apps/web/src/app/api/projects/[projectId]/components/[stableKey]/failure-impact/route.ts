import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** "What happens if this fails?", computed from the stored graph and decisions. */
export const GET = api<undefined, { projectId: string; stableKey: string }>({ action: 'architecture.failure_impact' }, async ({ rc, params }) => ({ impact: await getContainer().app.change.failureImpact(rc, params.projectId, decodeURIComponent(params.stableKey)) }));
