'use client';

/**
 * Python extensions editor. Feeds the YAML generator's ctx.pythonExtensions, which emits two
 * shapes: row_transform / dataframe_transform become a python_extensions block plus a shim
 * stage at the pipeline tail; sql_query becomes a first-class sql_query stage. The generator
 * auto-prepends the `def NAME(args):` header, so the user types only the body — this editor
 * mirrors that so the YAML preview stays honest.
 */
import { PyExtension } from '../yaml';

const TYPES: { value: PyExtension['type']; label: string; sig: string }[] = [
  { value: 'row_transform', label: 'row_transform', sig: 'def NAME(row):' },
  { value: 'dataframe_transform', label: 'dataframe_transform', sig: 'def NAME(df, spark):' },
  { value: 'sql_query', label: 'sql_query', sig: 'SQL (no def header)' },
];

export default function PythonExtensionsEditor({
  exts,
  onChange,
}: {
  exts: PyExtension[];
  onChange: (next: PyExtension[]) => void;
}) {
  const patch = (i: number, p: Partial<PyExtension>) =>
    onChange(exts.map((e, idx) => (idx === i ? { ...e, ...p } : e)));
  const add = () => onChange([...exts, { name: '', functionBody: '', type: 'row_transform' }]);
  const remove = (i: number) => onChange(exts.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      {exts.length === 0 && (
        <p className="text-[11px] text-slate-400">No Python extensions.</p>
      )}
      {exts.map((e, i) => {
        const sig = TYPES.find((t) => t.value === e.type)?.sig || '';
        return (
          <div key={i} className="rounded border border-slate-200 p-2 space-y-1">
            <div className="flex items-center gap-1.5">
              <input
                value={e.name}
                onChange={(ev) => patch(i, { name: ev.target.value })}
                placeholder="function name"
                className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs font-mono"
              />
              <select
                value={e.type}
                onChange={(ev) => patch(i, { type: ev.target.value as PyExtension['type'] })}
                className="rounded border border-slate-200 px-1 py-1 text-xs"
              >
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <button onClick={() => remove(i)} className="text-xs text-red-400 hover:text-red-600 px-1">✕</button>
            </div>
            <div className="text-[10px] text-slate-400 font-mono">{sig}</div>
            <textarea
              value={e.functionBody}
              onChange={(ev) => patch(i, { functionBody: ev.target.value })}
              placeholder={e.type === 'sql_query' ? 'SELECT …' : 'body only (indented under the def)'}
              rows={4}
              className="w-full rounded border border-slate-200 px-2 py-1 text-xs font-mono"
            />
          </div>
        );
      })}
      <button onClick={add} className="text-xs text-blue-600 hover:underline">+ add extension</button>
    </div>
  );
}
