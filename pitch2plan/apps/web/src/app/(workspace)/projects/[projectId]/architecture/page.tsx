import type { Metadata } from 'next';
import { ArchitectureView } from '@/components/ArchitectureView';

export const metadata: Metadata = { title: 'Architecture' };
export default async function ArchitecturePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ArchitectureView projectId={projectId} />;
}
