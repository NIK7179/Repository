import type { Metadata } from 'next';
import { NewChangeForm } from '@/components/ChangeViews';

export const metadata: Metadata = { title: 'Request architecture change' };
export default async function NewChangePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ text?: string; reason?: string; conversation?: string; message?: string; finding?: string }> }) {
  const { projectId } = await params; const q = await searchParams;
  return <NewChangeForm projectId={projectId} prefill={{ text: q.text, reason: q.reason, conversationId: q.conversation, messageId: q.message, findingId: q.finding }} />;
}
