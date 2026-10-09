import { redirect } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { getCurrentUser } from '@/server/current-user';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  return <Shell email={user.email}>{children}</Shell>;
}
