import type { Metadata } from 'next';
import { DiscoveryWorkspace } from '@/components/DiscoveryWorkspace';

export const metadata: Metadata = { title: 'Discovery' };
export default async function DiscoveryPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <DiscoveryWorkspace projectId={projectId} />;
}
