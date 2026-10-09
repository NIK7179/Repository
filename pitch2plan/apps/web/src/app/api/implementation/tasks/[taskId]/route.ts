import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { taskId: string }>({ action: 'implementation.task' }, async ({ rc, params }) => ({ task: await getContainer().app.implementation.getTask(rc, params.taskId) }));
