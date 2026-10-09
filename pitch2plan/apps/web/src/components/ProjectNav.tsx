'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@pitch2plan/ui';

const TABS = [['', 'Overview'], ['/discovery', 'Discovery'], ['/brief', 'Brief'], ['/architecture', 'Architecture'], ['/decisions', 'Decisions'], ['/implementation', 'Implementation']] as const;

export function ProjectNav({ projectId }: { projectId: string }) {
  const path = usePathname();
  const base = `/projects/${projectId}`;
  return (
    <nav aria-label="Project" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {TABS.map(([suffix, label]) => {
        const href = `${base}${suffix}`;
        const active = suffix === '' ? path === base : path.startsWith(href);
        return <Link key={label} href={href} aria-current={active ? 'page' : undefined} className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm', active ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}>{label}</Link>;
      })}
    </nav>
  );
}
