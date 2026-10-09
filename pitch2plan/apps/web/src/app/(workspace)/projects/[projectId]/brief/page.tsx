import type { Metadata } from 'next';
import { BriefReview } from '@/components/BriefReview';

export const metadata: Metadata = { title: 'Architecture Brief' };
export default async function BriefPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <BriefReview projectId={projectId} />;
}
