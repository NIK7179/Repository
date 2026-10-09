'use client';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@pitch2plan/ui';
import type { ComponentFlowNode } from '@/lib/canvas';
import { TechIcon } from './TechIcon';

/** Diff markers never rely on colour alone: each kind has a text label, an icon and a border pattern. */
const DIFF: Record<string, { label: string; icon: string; border: string; chip: string }> = {
  ADDED: { label: 'Added', icon: '＋', border: 'border-2 border-solid border-ok', chip: 'bg-ok/15 text-ok' },
  REMOVED: { label: 'Removed', icon: '−', border: 'border-2 border-dashed border-danger opacity-80', chip: 'bg-danger/15 text-danger' },
  MODIFIED: { label: 'Modified', icon: '~', border: 'border-2 border-dotted border-warn', chip: 'bg-warn/15 text-warn' },
  REPLACED: { label: 'Replaced', icon: '⇄', border: 'border-2 border-double border-accent', chip: 'bg-accent/15 text-accent' },
};
const CRIT: Record<string, string> = { CRITICAL: 'bg-danger', HIGH: 'bg-warn', MEDIUM: 'bg-accent', LOW: 'bg-muted' };

/** A node is a label, not a document. Everything detailed lives in the inspector. */
export function ComponentNode({ data, selected }: NodeProps<ComponentFlowNode>) {
  const diff = data.diffKind ? DIFF[data.diffKind] : undefined;
  return (
    <div data-testid={`node-${data.stableKey}`} data-diff={data.diffKind} aria-label={`${data.name}, ${data.technology}${diff ? `, ${diff.label.toLowerCase()}` : ''}`}
      className={cn('relative flex h-[84px] w-[224px] items-center gap-3 rounded-lg border bg-panel px-3 shadow-sm transition', diff ? diff.border : selected ? 'border-accent ring-2 ring-accent/30' : 'border-border hover:border-muted', diff && selected && 'ring-2 ring-accent/40')}>
      {diff && <span data-testid={`diff-${data.stableKey}`} className={cn('absolute -top-2.5 left-2 rounded px-1.5 text-[10px] font-semibold uppercase tracking-wide', diff.chip)}><span aria-hidden>{diff.icon} </span>{diff.label}</span>}
      <Handle type="target" position={Position.Left} isConnectable={false} className="!h-2 !w-2 !border-border !bg-muted" />
      <TechIcon slug={data.technologySlug} name={data.technology} category={data.category} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight">{data.name}</p>
        <p className="truncate text-xs text-muted">{data.technology}</p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] uppercase tracking-wide text-muted">
          <span title={`${data.criticality.toLowerCase()} criticality`} className={cn('h-1.5 w-1.5 shrink-0 rounded-full', CRIT[data.criticality] ?? 'bg-muted')} />{data.category.replaceAll('_', ' ').toLowerCase()}
        </p>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} className="!h-2 !w-2 !border-border !bg-muted" />
    </div>
  );
}
