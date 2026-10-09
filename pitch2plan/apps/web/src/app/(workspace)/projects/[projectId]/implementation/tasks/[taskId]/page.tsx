import type { Metadata } from 'next';
import { TaskWorkspace } from '@/components/TaskWorkspace';

export const metadata: Metadata = { title: 'Task' };
export default async function TaskPage({ params }: { params: Promise<{ projectId: string; taskId: string }> }) {
  const { projectId, taskId } = await params;
  return <TaskWorkspace projectId={projectId} taskId={taskId} />;
}
