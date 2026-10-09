import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { versionId: string; stableKey: string }>({ action: 'architecture.node' }, async ({ rc, params }) => ({ node: await getContainer().app.architecture.getNode(rc, params.versionId, params.stableKey) }));
