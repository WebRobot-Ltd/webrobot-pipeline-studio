'use client';
// GRAPH mode of the pipeline (second definition mode next to the list, 10-23). What it shows that the list
// does not: a multi-source pipeline is a set of LANES (one per `sources[i]`, each fetching and extracting on
// its own) that CONVERGE into the shared tail (union / combine / output). Same rows, same YAML: a view, not
// a second model.
//
// v2 (user 10-23: "very compressed, the nodes can't be moved"): React Flow canvas — tall, pan/zoom, nodes
// draggable (positions kept while the page is open), dry-run badges on the nodes, + nodes at each lane end.
import { useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Position, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { PipelineRow } from '../yaml';

export interface GraphLook { icon: string; tile: string; label: string }
export interface GraphRun { status: string | null; fill: number | null; rows: number | null }

const COL = 270;   // horizontal step between stages
const ROW = 170;   // vertical step between lanes

export default function PipelineGraph({
  pipeline, lookOf, run, selected, onSelect, onRemove, onAddTo, height = 560,
}: {
  pipeline: PipelineRow[];
  lookOf: (stage: string) => GraphLook;
  run?: (GraphRun | null)[] | null;
  selected: number | null;
  onSelect: (idx: number) => void;
  onRemove: (idx: number) => void;
  onAddTo: (src: number | 'shared') => void;
  /** canvas height in px, or a CSS length (the expanded view passes a viewport height) */
  height?: number | string;
}) {
  // positions the person dragged, by node id (kept while the page is open; the YAML has no layout)
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});

  const { nodes, edges } = useMemo(() => {
    const lanes = new Map<number, number[]>();
    const shared: number[] = [];
    pipeline.forEach((r, i) => {
      if (r._src === 'shared') shared.push(i);
      else {
        const n = typeof r._src === 'number' ? r._src : 1;
        if (!lanes.has(n)) lanes.set(n, []);
        lanes.get(n)!.push(i);
      }
    });
    const laneNums = [...lanes.keys()].sort((a, b) => a - b);
    const multi = laneNums.length > 1 || shared.length > 0;
    const ns: Node[] = [];
    const es: Edge[] = [];
    const pos = (id: string, x: number, y: number) => moved[id] || { x, y };

    const stageNode = (idx: number, x: number, y: number): Node => {
      const row = pipeline[idx];
      const look = lookOf(row.stage);
      const rr = run?.[idx] || null;
      const bad = /fail|error/i.test(rr?.status || '');
      const id = `s${idx}`;
      return {
        id, position: pos(id, x, y),
        data: {
          label: (
            <div className="text-left">
              <div className="flex items-center gap-2">
                <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xl ring-1 ${look.tile}`}>{look.icon}</span>
                <span className="min-w-0">
                  <span className="block truncate font-mono text-sm font-semibold text-slate-900">{idx + 1}. {row.stage}</span>
                  <span className="block truncate text-xs text-slate-500">{look.label}</span>
                </span>
                <button type="button" title="Remove stage"
                  onClick={(e) => { e.stopPropagation(); onRemove(idx); }}
                  className="ml-auto rounded px-1 text-sm text-slate-400 hover:bg-rose-50 hover:text-rose-600">✕</button>
              </div>
              {rr && (rr.status || rr.rows != null) && (
                <div className={`mt-2 rounded-md px-2 py-0.5 text-xs font-semibold ${
                  bad ? 'bg-rose-50 text-rose-800' : rr.fill != null && rr.fill < 80 ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>
                  {bad ? '✕ failed' : rr.rows != null ? `${rr.rows} rows · ${rr.fill}% filled` : '✓ ran'}
                </div>
              )}
            </div>
          ),
        },
        style: {
          width: 230, padding: 10, borderRadius: 12, background: '#fff',
          border: selected === idx ? '2px solid #4f46e5' : bad ? '1px solid #fda4af' : '1px solid #cbd5e1',
          boxShadow: '0 1px 3px rgba(0,0,0,.08)',
        },
      };
    };
    const addNode = (src: number | 'shared', x: number, y: number): Node => ({
      // below the lane end, so the arc into the save node does not run through it
      id: `add-${src}`, position: pos(`add-${src}`, x - 60, y + 95),
      data: { label: <span title="Add a stage here (then pick it from the catalogue)" className="text-lg text-slate-400">+</span>, src },
      style: { width: 44, height: 44, borderRadius: 999, border: '1px dashed #94a3b8', background: '#f8fafc',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer' },
      connectable: false,
    });
    const chain = (ids: string[]) => ids.forEach((id, k) => {
      if (k > 0) es.push({ id: `e-${ids[k - 1]}-${id}`, source: ids[k - 1], target: id, type: 'smoothstep' });
    });

    let maxLen = 0;
    laneNums.forEach((n, li) => {
      const idxs = lanes.get(n)!;
      maxLen = Math.max(maxLen, idxs.length + 1);
      const y = li * ROW;
      if (multi) {
        ns.push({ id: `lane-${n}`, position: pos(`lane-${n}`, -150, y + 22), selectable: false, draggable: true,
          data: { label: <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Source {n}</span> },
          style: { width: 110, border: 'none', background: 'transparent', padding: 0 } });
      }
      idxs.forEach((idx, k) => ns.push(stageNode(idx, k * COL, y)));
      ns.push(addNode(n, idxs.length * COL, y));
      chain(idxs.map((i) => `s${i}`));
    });

    if (multi) {
      const mx = maxLen * COL;
      const my = ((laneNums.length - 1) * ROW) / 2;
      ns.push({ id: 'merge', position: pos('merge', mx, my + 14), selectable: false,
        data: { label: <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">merge ⟹</span> },
        style: { width: 110, borderRadius: 999, background: '#eef2ff', border: '1px solid #c7d2fe', padding: 8 } });
      laneNums.forEach((n) => {
        const idxs = lanes.get(n)!;
        if (idxs.length) es.push({ id: `e-l${n}-merge`, source: `s${idxs[idxs.length - 1]}`, target: 'merge', type: 'smoothstep', animated: true });
      });
      shared.forEach((idx, k) => ns.push(stageNode(idx, mx + 170 + k * COL, my)));
      ns.push(addNode('shared', mx + 170 + shared.length * COL, my));
      if (shared.length) es.push({ id: 'e-merge-tail', source: 'merge', target: `s${shared[0]}`, type: 'smoothstep', animated: true });
      chain(shared.map((i) => `s${i}`));
    }

    // End node: where the data lands. The YAML always writes `output: {format: parquet, mode:
    // overwrite}`, so the graph shows it instead of letting the last stage's arrow end in nothing.
    let endX = 0, endY = 0, endFrom: string | null = null;
    if (multi) {
      const mx = maxLen * COL;
      endX = mx + 170 + (shared.length + 1) * COL;
      endY = ((laneNums.length - 1) * ROW) / 2;
      endFrom = shared.length ? `s${shared[shared.length - 1]}` : 'merge';
    } else if (laneNums.length) {
      const idxs = lanes.get(laneNums[0])!;
      endX = (idxs.length + 1) * COL;
      endFrom = idxs.length ? `s${idxs[idxs.length - 1]}` : null;
    }
    ns.push({ id: 'save', position: pos('save', endX, endY), selectable: false,
      data: { label: (
        <div className="text-left">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-xl ring-1 ring-emerald-200">💾</span>
            <span>
              <span className="block font-mono text-sm font-semibold text-slate-900">save</span>
              <span className="block text-xs text-slate-500">parquet · overwrite</span>
            </span>
          </div>
        </div>
      ) },
      style: { width: 190, padding: 10, borderRadius: 12, background: '#f0fdf4', border: '1px solid #86efac' } });
    if (endFrom) es.push({ id: 'e-save', source: endFrom, target: 'save', type: 'smoothstep' });

    // Horizontal flow: arcs leave a node on the right and enter on the left (React Flow's
    // default handles are bottom/top, which made every arc loop under and over the nodes).
    for (const n of ns) { n.sourcePosition = Position.Right; n.targetPosition = Position.Left; }
    return { nodes: ns, edges: es };
  }, [pipeline, lookOf, run, selected, moved, onRemove]);

  if (!pipeline.length) {
    return <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No stages yet — describe what you want, or add stages from the catalogue.</p>;
  }

  return (
    <div style={{ height }} className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
      <ReactFlow
        nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.2} maxZoom={1.6} proOptions={{ hideAttribution: true }}
        nodesDraggable nodesConnectable={false}
        onNodesChange={(chs) => chs.forEach((ch: any) => {
          if (ch.type === 'position' && ch.position) setMoved((m) => ({ ...m, [ch.id]: ch.position }));
        })}
        onNodeClick={(_, n) => {
          const id = String(n.id);
          if (id.startsWith('s')) onSelect(Number(id.slice(1)));
          else if (id.startsWith('add-')) onAddTo(id === 'add-shared' ? 'shared' : Number(id.slice(4)));
        }}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable style={{ height: 90, width: 140 }} />
      </ReactFlow>
    </div>
  );
}
