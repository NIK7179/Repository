import type { Metadata } from 'next';
import { VersionCompare } from '@/components/VersionViews';

export const metadata: Metadata = { title: 'Compare architecture versions' };
export default async function ComparePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { projectId } = await params; const q = await searchParams;
  return <VersionCompare projectId={projectId} from={q.from} to={q.to} />;
}
