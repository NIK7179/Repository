'use client';
import { useState } from 'react';
import { Badge, Button, Input } from '@pitch2plan/ui';
import { ApiError, call, type ConflictDto, type DiscoveryStateDto, type RequirementDto } from '@/lib/api-client';
import { OriginBadge } from './origin';

export function ConflictCard({ conflict, requirements, projectId, canEdit, onState }: { conflict: ConflictDto; requirements: RequirementDto[]; projectId: string; canEdit: boolean; onState: (s: DiscoveryStateDto) => void }) {
  const involved = conflict.requirementIds.map((id) => requirements.find((r) => r.id === id)).filter((r): r is RequirementDto => !!r);
  const [keep, setKeep] = useState<string>('');
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'KEEP' | 'DISMISS'>('KEEP');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve() {
    setBusy(true); setError(null);
    try {
      const body = mode === 'KEEP' ? { action: 'KEEP_ONE', keepRequirementId: keep, note: note || undefined } : { action: 'DISMISS', note };
      onState((await call<{ state: DiscoveryStateDto }>(`/api/projects/${projectId}/conflicts/${conflict.id}/resolve`, { method: 'POST', body })).state);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not resolve this.'); }
    finally { setBusy(false); }
  }

  return (
    <section className="rounded-lg border border-warn/40 bg-warn/5 p-5" data-testid="conflict-card" aria-label={conflict.title}>
      <div className="flex items-center gap-2"><Badge tone="warn">Needs your decision</Badge><h3 className="text-sm font-semibold">{conflict.title}</h3></div>
      <p className="mt-2 text-sm">{conflict.description}</p>
      <fieldset disabled={!canEdit || busy} className="mt-4 space-y-2">
        <legend className="mb-1 text-sm font-medium">How would you like to resolve this?</legend>
        {involved.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-panel p-3 text-sm has-[:checked]:border-accent">
            <input type="radio" name={`c-${conflict.id}`} className="mt-1 accent-[var(--accent)]" checked={mode === 'KEEP' && keep === r.id} onChange={() => { setMode('KEEP'); setKeep(r.id); }} />
            <span><span className="block">Keep: {r.statement}</span><span className="mt-1 inline-block"><OriginBadge req={r} /></span></span>
          </label>
        ))}
        <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-panel p-3 text-sm has-[:checked]:border-accent">
          <input type="radio" name={`c-${conflict.id}`} className="mt-1 accent-[var(--accent)]" checked={mode === 'DISMISS'} onChange={() => setMode('DISMISS')} />
          <span>These don&apos;t actually conflict</span>
        </label>
        {mode === 'DISMISS' && <Input aria-label="Why this is not a conflict" placeholder="Briefly, why not?" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
      </fieldset>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <Button className="mt-4" loading={busy} disabled={!canEdit || (mode === 'KEEP' ? !keep : note.trim().length < 3)} onClick={resolve}>Resolve</Button>
    </section>
  );
}
