import type { Metadata } from 'next';
import { ChangeProposalView } from '@/components/ChangeViews';

export const metadata: Metadata = { title: 'Change request' };
export default async function ProposalPage({ params }: { params: Promise<{ projectId: string; proposalId: string }> }) { const { projectId, proposalId } = await params; return <ChangeProposalView projectId={projectId} proposalId={proposalId} />; }
