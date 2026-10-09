import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string }>({ action: 'architecture.versions' }, async ({ rc, params }) => ({ versions: await getContainer().app.architecture.listVersions(rc, params.projectId) }));
