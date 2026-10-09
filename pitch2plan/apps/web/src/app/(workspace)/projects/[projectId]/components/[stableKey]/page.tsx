import type { Metadata } from 'next';
import { ComponentWorkspace } from '@/components/ComponentWorkspace';

export const metadata: Metadata = { title: 'Component' };
export default async function ComponentPage({ params, searchParams }: { params: Promise<{ projectId: string; stableKey: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { projectId, stableKey } = await params; const { tab } = await searchParams;
  return <ComponentWorkspace projectId={projectId} stableKey={decodeURIComponent(stableKey)} initialTab={tab} />;
}
