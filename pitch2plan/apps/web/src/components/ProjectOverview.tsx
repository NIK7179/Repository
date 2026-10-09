'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Skeleton, StatusBadge } from '@pitch2plan/ui';
import { ApiError, call, timeAgo, type InterpretationDto, type PitchDto, type ProjectDto } from '@/lib/api-client';
import { InterpretationView } from './InterpretationView';

export function ProjectOverview({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{ project: ProjectDto; latestPitch: PitchDto | null; interpretation: InterpretationDto | null } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null); setData(null);
    try {
      const { project, latestPitch } = await call<{ project: ProjectDto; latestPitch: PitchDto | null }>(`/api/projects/${projectId}`);
      let interpretation: InterpretationDto | null = null;
      try { interpretation = (await call<{ interpretation: InterpretationDto }>(`/api/projects/${projectId}/interpretation`)).interpretation; }
      catch (e) { if (!(e instanceof ApiError && e.code === 'INTERPRETATION_NOT_FOUND')) throw e; }
      setData({ project, latestPitch, interpretation });
    } catch (e) { setError(e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.')); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  async function interpret() {
    setRunning(true); setRunError(null);
    try {
      const { interpretation } = await call<{ interpretation: InterpretationDto }>(`/api/projects/${projectId}/interpret`, { method: 'POST', body: {} });
      setData((d) => (d ? { ...d, interpretation } : d));
    } catch (e) { setRunError(e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.')); }
    finally { setRunning(false); }
  }

  if (error) return <Alert title={error.code === 'PROJECT_NOT_FOUND' ? 'Project not found' : 'We couldn’t load this project'} action={<Link href="/projects"><Button variant="secondary">Back to projects</Button></Link>}>{error.message}</Alert>;
  if (!data) return <div className="space-y-3" role="status" aria-label="Loading project"><Skeleton className="h-8 w-64" /><Skeleton className="h-32 w-full" /><Skeleton className="h-48 w-full" /></div>;

  const { project, latestPitch, interpretation } = data;
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3"><h1 className="text-xl font-semibold" data-testid="project-name">{project.name}</h1><StatusBadge status={project.status} /></div>
          <p className="mt-1 text-sm text-muted">Updated {timeAgo(project.updatedAt)}</p>
        </div>
        <Link href={`/projects/${project.id}/discovery`}><Button>Continue to Discovery</Button></Link>
      </div>

      <section className="rounded-lg border border-border bg-panel p-5">
        <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Your original pitch</h2>{latestPitch && <Badge>version {latestPitch.version}</Badge>}</div>
        {latestPitch ? <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed" data-testid="pitch-text">{latestPitch.content}</p> : <p className="mt-3 text-sm text-muted">No pitch has been submitted yet.</p>}
      </section>

      {runError && <Alert title="We couldn’t interpret your idea this time">{runError.message}</Alert>}
      {interpretation ? (
        <>
          <p className="text-xs text-muted">Interpreted {timeAgo(interpretation.createdAt)} · {interpretation.promptId} v{interpretation.promptVersion} · {interpretation.provider}/{interpretation.model}</p>
          <InterpretationView output={interpretation.output} />
        </>
      ) : latestPitch ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted">This idea has not been interpreted yet.</p>
          <Button className="mt-4" loading={running} onClick={interpret}>Interpret my idea</Button>
        </div>
      ) : null}
    </div>
  );
}
