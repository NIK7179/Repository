import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string }>({ action: 'architecture.overview' }, async ({ rc, params }) => ({ architecture: await getContainer().app.architecture.getOverview(rc, params.projectId) }));
