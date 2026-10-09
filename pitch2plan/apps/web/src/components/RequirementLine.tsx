'use client';
import { useState } from 'react';
import { Button, Textarea } from '@pitch2plan/ui';
import { ApiError, call, type RequirementDto } from '@/lib/api-client';
import { OriginBadge, confidenceLabel } from './origin';

export function RequirementLine({ req, projectId, canEdit, onChanged, hint, startEditing, onCancel }: { req: RequirementDto; projectId: string; canEdit: boolean; onChanged: () => void; hint?: boolean; startEditing?: boolean; onCancel?: () => void }) {
  const [editing, setEditing] = useState(!!startEditing);
  const [text, setText] = useState(req.statement);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conf = confidenceLabel(req.confidence);

  async function save() {
    setBusy(true); setError(null);
    try { await call(`/api/projects/${projectId}/requirements/${req.id}`, { method: 'PATCH', body: { statement: text } }); setEditing(false); onChanged(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <Textarea aria-label="Requirement" className="min-h-20" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} invalid={!!error} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <p className="text-xs text-muted">Saving creates a new version. The previous wording is kept in the history.</p>
        <div className="flex gap-2"><Button loading={busy} onClick={save}>Save</Button><Button variant="ghost" onClick={() => { setEditing(false); setText(req.statement); setError(null); onCancel?.(); }}>Cancel</Button></div>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm" data-testid="requirement-statement">{req.statement}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2"><OriginBadge req={req} />{conf && <span className="text-xs text-muted">{conf}</span>}{hint && req.version > 1 && <span className="text-xs text-muted">edited · v{req.version}</span>}</div>
      </div>
      {canEdit && <Button variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => setEditing(true)} aria-label={`Edit requirement: ${req.statement}`}>Edit</Button>}
    </div>
  );
}
