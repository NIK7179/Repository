import Link from 'next/link';
import { NavLink } from './NavLink';
import { SignOutButton } from './SignOutButton';

export function Shell({ email, children }: { email: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-panel md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4 font-semibold">
          <span className="grid h-6 w-6 place-items-center rounded bg-accent text-xs text-accent-fg">P</span>Pitch2Plan
        </div>
        <nav aria-label="Primary" className="flex-1 space-y-1 p-3">
          <NavLink href="/projects" exact>Projects</NavLink>
          <NavLink href="/projects/new">New project</NavLink>
        </nav>
        <p className="p-4 text-xs text-muted">Phase 1 · Foundation</p>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-panel px-4 md:px-8">
          <Link href="/projects" className="font-semibold md:hidden">Pitch2Plan</Link>
          <span className="hidden text-sm text-muted md:block">Personal workspace</span>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted" data-testid="user-email">{email}</span>
            <SignOutButton />
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8">{children}</main>
      </div>
    </div>
  );
}
