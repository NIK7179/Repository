'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, EmptyState, Skeleton, StatusBadge } from '@pitch2plan/ui';
import { ApiError, call, timeAgo, type ProjectDto } from '@/lib/api-client';

export function ProjectList() {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null); setProjects(null);
    try { setProjects((await call<{ projects: ProjectDto[] }>('/api/projects')).projects); }
    catch (e) { setError(e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div><h1 className="text-xl font-semibold">Projects</h1><p className="text-sm text-muted">Turn each idea into a production-ready design.</p></div>
        <Link href="/projects/new"><Button>Create project</Button></Link>
      </div>
      {error ? (
        <Alert title="We couldn't load your projects" action={<Button variant="secondary" onClick={load}>Retry</Button>}>{error.message}</Alert>
      ) : projects === null ? (
        <div className="space-y-2" aria-label="Loading projects" role="status">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : projects.length === 0 ? (
        <EmptyState title="No projects yet" description="Describe an idea in your own words. We will help you understand what to build, why, and in what order." action={<Link href="/projects/new"><Button>Create your first project</Button></Link>} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel" data-testid="project-list">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{p.name}</p>
                <p className="text-xs text-muted">Updated {timeAgo(p.updatedAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <StatusBadge status={p.status} />
                <Link href={`/projects/${p.id}`}><Button variant="secondary">Continue</Button></Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
