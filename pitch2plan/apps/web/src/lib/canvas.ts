import * as dagre from '@dagrejs/dagre';
import { Position, type Edge, type Node } from '@xyflow/react';
import type { ArchitectureService } from '@pitch2plan/domain';
import { ORPHAN_ALLOWED_CATEGORIES, type NodeCategory } from '@pitch2plan/schemas';
import type { Json } from './api-client';

/**
 * Persisted architecture -> render model. This is the ONLY place that knows about the canvas.
 * Positions are derived here and are never persisted as part of the architecture.
 */
export type VersionDto = Json<Awaited<ReturnType<ArchitectureService['getVersion']>>>;
export type ViewMode = 'SYSTEM' | 'DATA_FLOW';
export const NODE_WIDTH = 224;
export const NODE_HEIGHT = 84;
/** Component cards have a fixed size, so their connection points are known up front. This lets edges render before (or without) DOM measurement. */
const HANDLES = [
  { type: 'target' as const, position: Position.Left, x: 0, y: NODE_HEIGHT / 2, width: 1, height: 1 },
  { type: 'source' as const, position: Position.Right, x: NODE_WIDTH - 1, y: NODE_HEIGHT / 2, width: 1, height: 1 },
];

export interface ComponentNodeData extends Record<string, unknown> {
  stableKey: string; name: string; technology: string; technologySlug: string; category: NodeCategory; purpose: string; criticality: string; provider: string | null; managedService: boolean;
  /** Set only on the compare view: ADDED | REMOVED | MODIFIED | REPLACED | UNCHANGED. */
  diffKind?: string;
}
export type ComponentFlowNode = Node<ComponentNodeData, 'component'>;
export interface ComponentEdgeData extends Record<string, unknown> { edgeKey: string; communicationType: string; protocol: string; synchronous: boolean; encrypted: boolean | null }
export type ComponentFlowEdge = Edge<ComponentEdgeData>;

export const VIEW_LABELS: Record<ViewMode, string> = { SYSTEM: 'System architecture', DATA_FLOW: 'Data flow' };
const DATA_COMMUNICATION = new Set(['EVENT', 'STREAM', 'BATCH', 'FILE', 'DATABASE', 'CACHE', 'MESSAGE', 'MODEL_INFERENCE']);

/** View abstraction: later phases add Deployment / Security / Network by adding a case here. */
const EDGE_TAG: Record<string, string> = { ADDED: 'Added', REMOVED: 'Removed', MODIFIED: 'Modified' };
export interface CanvasDiff { nodes: Record<string, string>; edges: Record<string, string> }
export function toCanvasViewModel(version: Pick<VersionDto['version'], 'nodes' | 'edges'>, mode: ViewMode = 'SYSTEM', diff?: CanvasDiff): { nodes: ComponentFlowNode[]; edges: ComponentFlowEdge[] } {
  let nodes = version.nodes;
  let edges = version.edges;
  if (mode === 'DATA_FLOW') {
    // Data flow shows only the components the data actually passes through, and labels connections by WHAT flows.
    const crossCutting = new Set<string>(ORPHAN_ALLOWED_CATEGORIES);
    const keep = new Set(nodes.filter((n) => !crossCutting.has(n.category)).map((n) => n.stableKey));
    edges = edges.filter((e) => keep.has(e.sourceStableKey) && keep.has(e.targetStableKey) && (DATA_COMMUNICATION.has(e.communicationType) || !e.synchronous));
    const touched = new Set(edges.flatMap((e) => [e.sourceStableKey, e.targetStableKey]));
    nodes = nodes.filter((n) => keep.has(n.stableKey) && touched.has(n.stableKey));
  }
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 110, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.stableKey, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.sourceStableKey, e.targetStableKey);
  dagre.layout(g);
  return {
    nodes: nodes.map((n): ComponentFlowNode => {
      const p = g.node(n.stableKey);
      return {
        id: n.stableKey, type: 'component', width: NODE_WIDTH, height: NODE_HEIGHT, handles: HANDLES, position: { x: Math.round(p.x - NODE_WIDTH / 2), y: Math.round(p.y - NODE_HEIGHT / 2) },
        data: { stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.technologySlug, category: n.category, purpose: n.purpose, criticality: n.criticality, provider: n.provider, managedService: n.managedService, ...(diff ? { diffKind: diff.nodes[n.stableKey] ?? 'UNCHANGED' } : {}) },
      };
    }),
    edges: edges.map((e): ComponentFlowEdge => ({
      id: e.edgeKey, source: e.sourceStableKey, target: e.targetStableKey, type: 'default', animated: !e.synchronous,
      label: `${diff && (diff.edges[e.edgeKey] ?? 'UNCHANGED') !== 'UNCHANGED' ? `[${EDGE_TAG[diff.edges[e.edgeKey]!] ?? diff.edges[e.edgeKey]}] ` : ''}${mode === 'DATA_FLOW' ? e.dataDescription : `${e.protocol}${e.encrypted === false ? ' · unencrypted' : ''}`}`,
      data: { edgeKey: e.edgeKey, communicationType: e.communicationType, protocol: e.protocol, synchronous: e.synchronous, encrypted: e.encrypted },
      ariaLabel: `${e.label}: ${e.sourceStableKey} to ${e.targetStableKey}`,
      style: diff && diff.edges[e.edgeKey] === 'REMOVED' ? { strokeDasharray: '8 5', opacity: 0.75 } : diff && diff.edges[e.edgeKey] === 'MODIFIED' ? { strokeDasharray: '2 4', strokeWidth: 2.5 } : diff && diff.edges[e.edgeKey] === 'ADDED' ? { strokeWidth: 3 } : e.encrypted === false ? { strokeDasharray: '5 4' } : undefined,
    })),
  };
}
