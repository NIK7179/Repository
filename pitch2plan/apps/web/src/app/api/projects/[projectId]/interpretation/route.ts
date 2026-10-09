import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string }>({ action: 'idea.get_interpretation' }, async ({ rc, params }) => ({
  interpretation: await getContainer().app.interpretation.getLatest(rc, params.projectId),
}));
