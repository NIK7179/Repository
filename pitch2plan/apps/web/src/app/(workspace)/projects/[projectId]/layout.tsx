import { ProjectNav } from '@/components/ProjectNav';

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <><ProjectNav projectId={projectId} />{children}</>;
}
