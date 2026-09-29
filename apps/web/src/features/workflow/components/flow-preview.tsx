'use client';

import '@xyflow/react/dist/style.css';
import { Background, Controls, type Edge, MarkerType, MiniMap, type Node, ReactFlow } from '@xyflow/react';
import { useMemo } from 'react';
import { CATEGORY_COLOR, CATEGORY_LABEL } from '@/lib/labels';
import type { WorkflowBody } from '@/lib/types';
import { layoutGraph } from '../model';

export function FlowPreview({
  body,
  selected,
  onSelect,
}: {
  body: WorkflowBody;
  selected: { from: string; to: string } | null;
  onSelect: (s: { from: string; to: string }) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const g = layoutGraph(body, selected ?? undefined);
    const nodes: Node[] = g.nodes.map((n) => {
      const color = n.category === 'any' ? 'var(--muted-foreground)' : CATEGORY_COLOR[n.category];
      return {
        id: n.id,
        position: { x: n.x, y: n.y },
        data: { label: n.label },
        draggable: false,
        style: {
          width: 120,
          fontSize: 13,
          padding: '6px 10px',
          borderRadius: 4,
          border: `1.5px ${n.category === 'any' ? 'dashed' : 'solid'} ${color}`,
          background: 'var(--card)',
          color: 'var(--foreground)',
        },
      };
    });
    const edges: Edge[] = g.edges.map((e) => {
      const stroke = e.selected ? 'var(--primary)' : 'var(--muted-foreground)';
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        data: { from: e.from, to: e.to },
        label: e.conditional ? '有条件' : undefined,
        animated: e.selected,
        style: { stroke, strokeWidth: e.selected ? 2.2 : 1.2, strokeDasharray: e.from === '*' ? '4 4' : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      };
    });
    return { nodes, edges };
  }, [body, selected]);
  return (
    <div className="flex h-full min-h-[480px] flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <span className="font-semibold">状态图</span>
        <span className="text-xs text-muted-foreground">随编辑实时更新 · 点击连线编辑条件</span>
        <span className="ml-auto flex gap-3 text-xs text-muted-foreground">
          {(Object.keys(CATEGORY_LABEL) as Array<keyof typeof CATEGORY_LABEL>).map((c) => (
            <span key={c} className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px]" style={{ background: CATEGORY_COLOR[c] }} />
              {CATEGORY_LABEL[c]}
            </span>
          ))}
        </span>
      </div>
      <div className="flex-1" aria-label="流程状态图">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesConnectable={false}
          onEdgeClick={(_, e) => onSelect(e.data as { from: string; to: string })}
        >
          <Background gap={16} size={1.2} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}
