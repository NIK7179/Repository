import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
type P = { projectId: string };

export const GET = api<undefined, P>({ action: 'projects.get' }, async ({ rc, params }) => {
  const { project, latestPitch } = await getContainer().app.projects.get(rc, params.projectId);
  return { project, latestPitch };
});

export const DELETE = api<undefined, P>({ action: 'projects.delete' }, async ({ rc, params }) => {
  await getContainer().app.projects.softDelete(rc, params.projectId);
  return { deleted: true };
});
