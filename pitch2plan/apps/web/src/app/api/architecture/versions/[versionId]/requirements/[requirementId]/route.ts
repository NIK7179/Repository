import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** Reverse traceability: which decisions and components did this requirement shape? */
export const GET = api<undefined, { versionId: string; requirementId: string }>({ action: 'architecture.requirement_trace' }, async ({ rc, params }) => ({ trace: await getContainer().app.architecture.getRequirementTrace(rc, params.versionId, params.requirementId) }));
