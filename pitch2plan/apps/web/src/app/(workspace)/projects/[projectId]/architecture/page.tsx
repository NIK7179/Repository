import type { Metadata } from 'next';
import { ArchitectureView } from '@/components/ArchitectureView';
import { HistoricVersionView, VersionBar } from '@/components/VersionViews';

export const metadata: Metadata = { title: 'Architecture' };
export default async function ArchitecturePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ version?: string }> }) {
  const { projectId } = await params; const { version } = await searchParams;
  return (
    <div className="space-y-4">
      <VersionBar projectId={projectId} selectedId={version} />
      {version ? <HistoricVersionView versionId={version} /> : <ArchitectureView projectId={projectId} />}
    </div>
  );
}
