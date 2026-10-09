'use client';
import Link from 'next/link';
import { useState } from 'react';
import { createProjectRequestSchema, submitPitchRequestSchema, type TechnicalLevel } from '@pitch2plan/schemas';
import { Alert, Button, Field, Input, Textarea } from '@pitch2plan/ui';
import { ApiError, call, type InterpretationDto, type PitchDto, type ProjectDto } from '@/lib/api-client';
import { InterpretationView } from './InterpretationView';

type Phase = 'name' | 'pitch' | 'working' | 'done';
const LEVELS: Array<[TechnicalLevel | '', string]> = [['', 'Prefer not to say'], ['BEGINNER', 'Beginner'], ['FOUNDER', 'Founder / product builder'], ['DEVELOPER', 'Developer'], ['ARCHITECT', 'Architect']];

export function NewProjectFlow() {
  const [phase, setPhase] = useState<Phase>('name');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [contentError, setContentError] = useState<string | null>(null);
  const [level, setLevel] = useState<TechnicalLevel | ''>('');
  const [step, setStep] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  // Remember what has been persisted so a retry never duplicates the project or pitch.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [result, setResult] = useState<InterpretationDto | null>(null);

  function next() {
    const r = createProjectRequestSchema.shape.name.safeParse(name);
    if (!r.success) return setNameError(r.error.issues[0]!.message);
    setNameError(null); setPhase('pitch');
  }

  async function submit() {
    const r = submitPitchRequestSchema.shape.content.safeParse(content);
    if (!r.success) return setContentError(r.error.issues[0]!.message);
    setContentError(null); setError(null); setPhase('working');
    try {
      let id = projectId;
      if (!id) {
        setStep('Creating your project…');
        id = (await call<{ project: ProjectDto }>('/api/projects', { method: 'POST', body: { name: name.trim() } })).project.id;
        setProjectId(id);
      }
      if (savedContent !== content.trim()) {
        setStep('Saving your idea…');
        await call<{ pitch: PitchDto }>(`/api/projects/${id}/pitch`, { method: 'POST', body: { content, technicalLevel: level || undefined } });
        setSavedContent(content.trim());
      }
      setStep('Interpreting your idea…');
      setResult((await call<{ interpretation: InterpretationDto }>(`/api/projects/${id}/interpret`, { method: 'POST', body: {} })).interpretation);
      setPhase('done');
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.'));
      setPhase('pitch');
    }
  }

  const steps = ['Name', 'Pitch', 'Understanding'];
  const current = phase === 'name' ? 0 : phase === 'done' ? 2 : 1;

  return (
    <div className="mx-auto max-w-2xl">
      <ol className="mb-8 flex gap-6 text-sm" aria-label="Progress">
        {steps.map((s, i) => <li key={s} aria-current={i === current ? 'step' : undefined} className={i === current ? 'font-medium' : 'text-muted'}>{i + 1}. {s}</li>)}
      </ol>

      {phase === 'name' && (
        <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); next(); }}>
          <div><h1 className="text-xl font-semibold">Name your project</h1><p className="text-sm text-muted">A working title is fine. You can change it later.</p></div>
          <Field id="name" label="Project name" error={nameError}>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} invalid={!!nameError} placeholder="e.g. Fraud detection platform" autoFocus maxLength={80} aria-describedby={nameError ? 'name-error' : undefined} />
          </Field>
          <Button type="submit">Continue</Button>
        </form>
      )}

      {(phase === 'pitch' || phase === 'working') && (
        <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div><h1 className="text-xl font-semibold">Pitch your idea</h1><p className="text-sm text-muted">Describe what you want to build in your own words. Don&apos;t worry about technologies or architecture.</p></div>
          {error && (
            <Alert title={error.code === 'AI_OUTPUT_INVALID' || error.code.startsWith('AI_') ? 'We couldn’t interpret your idea this time' : 'Something went wrong'}>
              {error.message}{projectId && <> Your project and idea are saved. <Link className="underline" href={`/projects/${projectId}`}>Open project</Link> or try again.</>}
              {error.requestId && <span className="mt-1 block text-xs opacity-80">Reference: {error.requestId}</span>}
            </Alert>
          )}
          <Field id="pitch" label="Your idea" error={contentError} hint={`${content.trim().length}/8000 characters. Who is it for, what problem does it solve, and what should it do?`}>
            <Textarea id="pitch" value={content} onChange={(e) => setContent(e.target.value)} invalid={!!contentError} disabled={phase === 'working'} maxLength={8000} rows={9}
              placeholder="e.g. I want to create a platform that processes millions of transaction events in real time and detects fraud…" />
          </Field>
          <Field id="level" label="Your background (optional)" hint="We use this to adjust how we explain things.">
            <select id="level" value={level} onChange={(e) => setLevel(e.target.value as TechnicalLevel | '')} disabled={phase === 'working'}
              className="h-9 w-full rounded-md border border-border bg-panel px-3 text-sm focus-visible:outline-2 focus-visible:outline-accent">
              {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" loading={phase === 'working'}>{phase === 'working' ? step : projectId ? 'Try again' : 'Analyze my idea'}</Button>
            {phase === 'pitch' && !projectId && <Button type="button" variant="ghost" onClick={() => setPhase('name')}>Back</Button>}
          </div>
        </form>
      )}

      {phase === 'done' && result && projectId && (
        <div className="space-y-6">
          <div><h1 className="text-xl font-semibold">Here is what we understood</h1><p className="text-sm text-muted">Review this before we go deeper. Next, discovery will confirm the details that shape your architecture.</p></div>
          <InterpretationView output={result.output} />
          <div className="flex items-center gap-3 border-t border-border pt-6">
            <Link href={`/projects/${projectId}/discovery`}><Button>Continue to Discovery</Button></Link>
            <Link href={`/projects/${projectId}`}><Button variant="secondary">View project</Button></Link>
          </div>
        </div>
      )}
    </div>
  );
}
