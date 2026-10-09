'use client';
import '@xyflow/react/dist/style.css';
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { Button } from '@pitch2plan/ui';
import { VIEW_LABELS, toCanvasViewModel, type ComponentFlowEdge, type ComponentFlowNode, type VersionDto, type ViewMode } from '@/lib/canvas';
import { ComponentNode } from './ComponentNode';

const nodeTypes = { component: ComponentNode };

export type Selection = { kind: 'node'; key: string } | { kind: 'edge'; key: string } | null;

function Inner({ version, mode, onModeChange, selection, onSelect }: { version: VersionDto['version']; mode: ViewMode; onModeChange: (m: ViewMode) => void; selection: Selection; onSelect: (s: Selection) => void }) {
  // The canvas is derived from the persisted version on every render of this view. Positions are a layout, not data.
  const model = useMemo(() => toCanvasViewModel(version, mode), [version, mode]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ComponentFlowNode>(model.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ComponentFlowEdge>(model.edges);
  const { fitView } = useReactFlow();

  useEffect(() => {
    setNodes(model.nodes); setEdges(model.edges);
    // Cancelled on unmount: a pending animation frame must never touch a canvas that no longer exists.
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [model, setNodes, setEdges, fitView]);
  const selectedNodes = nodes.map((n) => ({ ...n, selected: selection?.kind === 'node' && selection.key === n.id }));
  const selectedEdges = edges.map((e) => ({ ...e, selected: selection?.kind === 'edge' && selection.key === e.id }));

  return (
    <div className="relative h-full w-full" data-testid="architecture-canvas">
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
        <div role="tablist" aria-label="Architecture view" className="flex overflow-hidden rounded-md border border-border bg-panel text-sm">
          {(Object.keys(VIEW_LABELS) as ViewMode[]).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => onModeChange(m)} className={`px-3 py-1.5 ${mode === m ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-subtle hover:text-fg'}`}>{VIEW_LABELS[m]}</button>
          ))}
        </div>
        <Button variant="secondary" className="h-8" onClick={() => { setNodes(model.nodes); void fitView({ padding: 0.2, duration: 200 }); }}>Reset layout</Button>
      </div>
      <ReactFlow<ComponentFlowNode, ComponentFlowEdge>
        nodes={selectedNodes} edges={selectedEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onNodeClick={(_, n) => onSelect({ kind: 'node', key: n.id })} onEdgeClick={(_, e) => onSelect({ kind: 'edge', key: e.id })} onPaneClick={() => onSelect(null)}
        fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.2} maxZoom={1.8} nodesConnectable={false} elementsSelectable colorMode="system" proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ interactionWidth: 24 }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" nodeStrokeWidth={2} className="!hidden sm:!block" />
      </ReactFlow>
    </div>
  );
}

export function ArchitectureCanvas(props: Parameters<typeof Inner>[0]) {
  return <ReactFlowProvider><Inner {...props} /></ReactFlowProvider>;
}
