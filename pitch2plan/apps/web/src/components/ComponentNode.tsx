'use client';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@pitch2plan/ui';
import type { ComponentFlowNode } from '@/lib/canvas';
import { TechIcon } from './TechIcon';

const CRIT: Record<string, string> = { CRITICAL: 'bg-danger', HIGH: 'bg-warn', MEDIUM: 'bg-accent', LOW: 'bg-muted' };

/** A node is a label, not a document. Everything detailed lives in the inspector. */
export function ComponentNode({ data, selected }: NodeProps<ComponentFlowNode>) {
  return (
    <div data-testid={`node-${data.stableKey}`} aria-label={`${data.name}, ${data.technology}`}
      className={cn('flex h-[84px] w-[224px] items-center gap-3 rounded-lg border bg-panel px-3 shadow-sm transition', selected ? 'border-accent ring-2 ring-accent/30' : 'border-border hover:border-muted')}>
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
