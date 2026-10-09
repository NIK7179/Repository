import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string }>({ action: 'architecture.history' }, async ({ rc, params }) => ({ versions: await getContainer().app.change.versionHistory(rc, params.projectId) }));
