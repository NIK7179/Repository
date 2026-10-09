import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { versionId: string }>({ action: 'architecture.decisions' }, async ({ rc, params }) => getContainer().app.architecture.getDecisions(rc, params.versionId));
