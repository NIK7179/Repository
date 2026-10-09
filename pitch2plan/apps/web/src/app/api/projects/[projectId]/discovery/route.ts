import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string }>({ action: 'discovery.state' }, async ({ rc, params }) => ({ state: await getContainer().app.discovery.getState(rc, params.projectId) }));
