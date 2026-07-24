'use client';

/**
 * Markets editor for the oddsSelect stage. The stage carries a `_markets` list — each an
 * {label, enabled, sectionSelector, rowSelector, fields[]} — which the YAML generator emits
 * as the deterministic multi-market odds config. Only enabled markets with a section and at
 * least one field are serialised, matching the generator; the UI mirrors that so the preview
 * is honest.
 */
import { PipelineRow, OddsMarket, PipelineField } from '../yaml';

const METHODS = ['text', 'html', 'attr:href', 'attr:src'];

export default function OddsMarketsEditor({
  row,
  onChange,
}: {
  row: PipelineRow;
  onChange: (markets: OddsMarket[]) => void;
}) {
  const markets = row._markets || [];
  const set = (next: OddsMarket[]) => onChange(next);
  const patch = (i: number, p: Partial<OddsMarket>) =>
    set(markets.map((m, idx) => (idx === i ? { ...m, ...p } : m)));

  const addMarket = () =>
    set([...markets, { label: '', enabled: true, sectionSelector: '', rowSelector: '', fields: [] }]);
  const removeMarket = (i: number) => set(markets.filter((_, idx) => idx !== i));

  const patchField = (mi: number, fi: number, p: Partial<PipelineField>) =>
    patch(mi, { fields: (markets[mi].fields || []).map((f, idx) => (idx === fi ? { ...f, ...p } : f)) });
  const addField = (mi: number) =>
    patch(mi, { fields: [...(markets[mi].fields || []), { selector: '', as: '', method: 'text' }] });
  const removeField = (mi: number, fi: number) =>
    patch(mi, { fields: (markets[mi].fields || []).filter((_, idx) => idx !== fi) });

  return (
    <div className="mt-1 space-y-2">
      {markets.length === 0 && <p className="text-[11px] text-slate-400">No markets yet.</p>}
      {markets.map((m, mi) => (
        <div key={mi} className="rounded border border-slate-200 p-2 space-y-1">
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={m.enabled !== false}
              onChange={(e) => patch(mi, { enabled: e.target.checked })}
              title="enabled"
            />
            <input
              value={m.label || ''}
              onChange={(e) => patch(mi, { label: e.target.value })}
              placeholder={`Market ${mi + 1} label`}
              className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs"
            />
            <button onClick={() => removeMarket(mi)} className="text-xs text-red-400 hover:text-red-600 px-1">✕</button>
          </div>
          <input
            value={m.sectionSelector || ''}
            onChange={(e) => patch(mi, { sectionSelector: e.target.value })}
            placeholder="section selector"
            className="w-full rounded border border-slate-200 px-2 py-1 text-xs font-mono"
          />
          <input
            value={m.rowSelector || ''}
            onChange={(e) => patch(mi, { rowSelector: e.target.value })}
            placeholder="row selector (optional)"
            className="w-full rounded border border-slate-200 px-2 py-1 text-xs font-mono"
          />
          <div className="pl-2 space-y-1">
            {(m.fields || []).map((f, fi) => (
              <div key={fi} className="grid grid-cols-[1fr_1fr_auto_auto] gap-1 items-center">
                <input value={f.selector} onChange={(e) => patchField(mi, fi, { selector: e.target.value })}
                  placeholder="selector" className="rounded border border-slate-200 px-2 py-1 text-xs font-mono" />
                <input value={f.as || ''} onChange={(e) => patchField(mi, fi, { as: e.target.value })}
                  placeholder="field" className="rounded border border-slate-200 px-2 py-1 text-xs" />
                <select value={f.method || 'text'} onChange={(e) => patchField(mi, fi, { method: e.target.value })}
                  className="rounded border border-slate-200 px-1 py-1 text-xs">
                  {METHODS.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
                <button onClick={() => removeField(mi, fi)} className="text-xs text-red-400 hover:text-red-600 px-1">✕</button>
              </div>
            ))}
            <button onClick={() => addField(mi)} className="text-[11px] text-blue-600 hover:underline">+ field</button>
          </div>
        </div>
      ))}
      <button onClick={addMarket} className="text-xs text-blue-600 hover:underline">+ add market</button>
    </div>
  );
}
