import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string }>({ action: 'brief.get' }, async ({ rc, params }) => ({ brief: await getContainer().app.briefs.get(rc, params.projectId) }));
