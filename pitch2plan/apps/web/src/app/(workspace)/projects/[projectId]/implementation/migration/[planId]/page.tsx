import type { Metadata } from 'next';
import { MigrationReview } from '@/components/MigrationReview';

export const metadata: Metadata = { title: 'Review plan migration' };
export default async function MigrationPage({ params, searchParams }: { params: Promise<{ projectId: string; planId: string }>; searchParams: Promise<{ from?: string }> }) { const { projectId, planId } = await params; const q = await searchParams; return <MigrationReview projectId={projectId} toPlanId={planId} fromPlanId={q.from} />; }
