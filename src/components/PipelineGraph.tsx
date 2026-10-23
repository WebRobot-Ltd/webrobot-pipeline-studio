'use client';
// GRAPH mode of the pipeline (second definition mode next to the list, 10-23). What it shows that the list
// does not: a multi-source pipeline is a set of LANES (one per `sources[i]`, each fetching and extracting on
// its own) that CONVERGE into the shared tail (union / combine / output). The list only tagged each row
// "Source N"; here the branches and where they merge are visible. Same rows, same YAML: a view, not a
// second model.
import type { PipelineRow } from '../yaml';

export interface GraphLook { icon: string; tile: string; label: string }
export interface GraphRun { status: string | null; fill: number | null; rows: number | null }

export default function PipelineGraph({
  pipeline, lookOf, run, selected, onSelect, onRemove, onAddTo,
}: {
  pipeline: PipelineRow[];
  lookOf: (stage: string) => GraphLook;
  run?: (GraphRun | null)[] | null;
  selected: number | null;
  onSelect: (idx: number) => void;
  onRemove: (idx: number) => void;
  onAddTo: (src: number | 'shared') => void;
}) {
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

  const Node = ({ idx }: { idx: number }) => {
    const row = pipeline[idx];
    const look = lookOf(row.stage);
    const rr = run?.[idx] || null;
    const bad = /fail|error/i.test(rr?.status || '');
    return (
      <div
        role="button" tabIndex={0}
        onClick={() => onSelect(idx)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSelect(idx); }}
        className={`group relative w-48 shrink-0 cursor-pointer rounded-xl border bg-white p-2.5 text-left shadow-sm transition hover:shadow-md ${
          selected === idx ? 'border-brand-500 ring-2 ring-brand-200' : bad ? 'border-rose-300' : 'border-slate-200'}`}
      >
        <div className="flex items-center gap-2">
          <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg ring-1 ${look.tile}`}>{look.icon}</span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm font-semibold text-slate-900">{row.stage}</span>
            <span className="block truncate text-xs text-slate-500">{look.label}</span>
          </span>
        </div>
        {rr && (rr.status || rr.rows != null) && (
          <div className={`mt-2 rounded-md px-2 py-0.5 text-xs font-semibold ${
            bad ? 'bg-rose-50 text-rose-800' : rr.fill != null && rr.fill < 80 ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>
            {bad ? '✕ failed' : rr.rows != null ? `${rr.rows} rows · ${rr.fill}% filled` : '✓ ran'}
          </div>
        )}
        <button type="button" title="Remove stage"
          onClick={(e) => { e.stopPropagation(); onRemove(idx); }}
          className="absolute -right-2 -top-2 hidden h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-xs text-rose-600 shadow group-hover:inline-flex">✕</button>
      </div>
    );
  };

  const Arrow = () => <span className="shrink-0 px-1 text-xl text-slate-300" aria-hidden="true">→</span>;
  const Add = ({ src }: { src: number | 'shared' }) => (
    <button type="button" onClick={() => onAddTo(src)} title="Add a stage here (then pick it from the catalogue)"
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-slate-300 text-lg text-slate-400 hover:border-brand-400 hover:text-brand-600">+</button>
  );

  if (!pipeline.length) {
    return <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No stages yet — describe what you want, or add stages from the catalogue.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className={`flex items-center gap-4 ${multi ? '' : ''}`}>
        <div className="flex flex-col gap-4">
          {laneNums.map((n) => (
            <div key={n} className="flex items-center">
              {multi && <span className="mr-3 w-20 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">Source {n}</span>}
              {lanes.get(n)!.map((idx, k) => (
                <span key={idx} className="flex items-center">{k > 0 && <Arrow />}<Node idx={idx} /></span>
              ))}
              <span className="ml-2"><Add src={n} /></span>
            </div>
          ))}
        </div>
        {multi && (
          <>
            <div className="flex shrink-0 flex-col items-center text-slate-400">
              <span className="text-xs font-semibold uppercase tracking-wide">merge</span>
              <span className="text-2xl" aria-hidden="true">⟹</span>
            </div>
            <div className="flex items-center">
              {shared.map((idx, k) => (
                <span key={idx} className="flex items-center">{k > 0 && <Arrow />}<Node idx={idx} /></span>
              ))}
              <span className="ml-2"><Add src="shared" /></span>
            </div>
          </>
        )}
      </div>
      {multi && <p className="mt-3 text-xs text-slate-500">Each source runs on its own; their rows are combined, then the shared stages run on the union.</p>}
    </div>
  );
}
