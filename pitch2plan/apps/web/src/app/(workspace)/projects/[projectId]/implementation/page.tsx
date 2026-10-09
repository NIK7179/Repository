import type { Metadata } from 'next';
import { ImplementationView } from '@/components/ImplementationView';

export const metadata: Metadata = { title: 'Implementation' };
export default async function ImplementationPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ decision?: string; component?: string }> }) {
  const { projectId } = await params; const q = await searchParams;
  return <ImplementationView projectId={projectId} decisionFilter={q.decision} componentFilter={q.component} />;
}
