import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api<undefined, { projectId: string; decisionKey: string }>({ action: 'implementation.decision.tasks' }, async ({ rc, params }) => getContainer().app.implementation.getTasksForDecision(rc, params.projectId, params.decisionKey));
