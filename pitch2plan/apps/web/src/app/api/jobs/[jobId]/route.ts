import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { jobId: string }>({ action: 'jobs.get' }, async ({ rc, params }) => ({ job: await getContainer().app.architecture.getJob(rc, params.jobId) }));
