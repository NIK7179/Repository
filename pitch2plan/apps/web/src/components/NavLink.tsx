'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@pitch2plan/ui';

export function NavLink({ href, children, exact }: { href: string; children: React.ReactNode; exact?: boolean }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className={cn('block rounded-md px-3 py-2 text-sm', active ? 'bg-subtle font-medium text-fg' : 'text-muted hover:bg-subtle hover:text-fg')}>
      {children}
    </Link>
  );
}
