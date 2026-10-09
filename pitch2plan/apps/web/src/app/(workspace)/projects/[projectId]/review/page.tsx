import type { Metadata } from 'next';
import { ReviewView } from '@/components/ReviewView';

export const metadata: Metadata = { title: 'Production readiness review' };
export default async function ReviewPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <ReviewView projectId={projectId} />; }
