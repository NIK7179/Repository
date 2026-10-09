import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string }>({ action: 'implementation.get' }, async ({ rc, params }) => ({ implementation: await getContainer().app.implementation.getOverview(rc, params.projectId) }));
