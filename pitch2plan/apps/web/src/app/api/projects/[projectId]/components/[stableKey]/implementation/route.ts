import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string; stableKey: string }>({ action: 'implementation.component' }, async ({ rc, params }) => ({ component: await getContainer().app.implementation.getComponent(rc, params.projectId, decodeURIComponent(params.stableKey)) }));
