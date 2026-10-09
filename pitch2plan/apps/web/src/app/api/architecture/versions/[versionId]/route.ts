import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { versionId: string }>({ action: 'architecture.version' }, async ({ rc, params }) => ({ version: await getContainer().app.architecture.getVersion(rc, params.versionId) }));
