import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** Deterministic diff of two stored versions (from -> to). Stored when a change was applied, otherwise computed. */
export const GET = api<undefined, { versionId: string; otherVersionId: string }>({ action: 'architecture.diff' }, async ({ rc, params }) => ({ diff: await getContainer().app.change.getDiff(rc, params.versionId, params.otherVersionId) }));
