import type { Metadata } from 'next';
import { ChangeRequestsView } from '@/components/ChangeViews';

export const metadata: Metadata = { title: 'Change requests' };
export default async function ChangesPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <ChangeRequestsView projectId={projectId} />; }
