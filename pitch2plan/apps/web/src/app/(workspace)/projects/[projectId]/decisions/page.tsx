import type { Metadata } from 'next';
import { DecisionsView } from '@/components/DecisionsView';

export const metadata: Metadata = { title: 'Decisions' };
export default async function DecisionsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <DecisionsView projectId={projectId} />;
}
