import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignInForm } from '@/components/SignInForm';
import { getCurrentUser } from '@/server/current-user';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  if (await getCurrentUser()) redirect('/projects');
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2 text-lg font-semibold"><span className="grid h-7 w-7 place-items-center rounded bg-accent text-sm text-accent-fg">P</span>Pitch2Plan</div>
        <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
        <p className="mb-6 text-sm text-muted">Turn an idea into a production-ready system design.</p>
        <SignInForm />
      </div>
    </div>
  );
}
