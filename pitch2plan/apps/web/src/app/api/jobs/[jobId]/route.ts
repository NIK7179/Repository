import { DomainError } from '@pitch2plan/domain';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
/** One endpoint for background jobs: architecture generation and implementation planning. */
export const GET = api<undefined, { jobId: string }>({ action: 'jobs.get' }, async ({ rc, params }) => {
  const { app } = getContainer();
  try { return { job: await app.architecture.getJob(rc, params.jobId) }; }
  catch (e) { if (e instanceof DomainError && e.code === 'JOB_NOT_FOUND') return { job: await app.implementation.getJob(rc, params.jobId) }; throw e; }
});
