'use client';
// DATA PREVIEW after Validate (redesign 10-23, after Lakeflow Designer / Fabric / Browse AI): the dry run
// already returns the extracted rows and the per-stage steps, but the designer showed only
// "valid · 12 records". A pipeline is judged by its rows: show them, and show where it breaks.
import { useMemo, useState } from 'react';

interface Step { stage?: string; status?: string; message?: string }

export default function DataPreview({ result }: { result: any }) {
  const [showAll, setShowAll] = useState(false);
  const records: Record<string, unknown>[] = Array.isArray(result?.records) ? result.records : [];
  const steps: Step[] = Array.isArray(result?.steps) ? result.steps : [];
  const cols = useMemo(() => {
    const seen: string[] = [];
    for (const r of records.slice(0, 50)) for (const k of Object.keys(r || {})) if (!seen.includes(k)) seen.push(k);
    return seen.slice(0, 10);
  }, [records]);
  const rows = showAll ? records.slice(0, 100) : records.slice(0, 10);
  const valid = !!result?.valid;
  const count = result?.record_count ?? records.length;
  const filled = (k: string) => records.length ? Math.round(100 * records.filter((r) => r?.[k] != null && String(r[k]).trim() !== '').length / records.length) : 0;

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white">
      <div className={`flex flex-wrap items-center gap-2 rounded-t-xl border-b px-4 py-2.5 ${valid && count > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
        <span className={`text-base font-semibold ${valid && count > 0 ? 'text-emerald-900' : 'text-rose-900'}`}>
          {valid && count > 0 ? `✓ ${count} rows extracted` : valid ? 'Ran, but no rows extracted' : 'The pipeline does not work yet'}
        </span>
        {result?.final_url && (
          <a href={result.final_url} target="_blank" rel="noopener noreferrer" className="truncate text-sm text-slate-600 underline">{result.final_url}</a>
        )}
      </div>

      {!valid && result?.error && <p className="px-4 pt-3 text-sm leading-relaxed text-rose-900">{result.error}</p>}

      {steps.length > 0 && (
        <ol className="flex flex-wrap gap-2 px-4 pt-3">
          {steps.map((s, i) => {
            const bad = /fail|error/i.test(String(s.status || ''));
            const ok = /ok|done|success|complete/i.test(String(s.status || ''));
            return (
              <li key={i} title={s.message || ''}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${bad ? 'border-rose-300 bg-rose-50 text-rose-800' : ok ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                {i + 1}. {s.stage || 'step'}{s.message ? ` — ${String(s.message).slice(0, 60)}` : ''}
              </li>
            );
          })}
        </ol>
      )}

      {records.length > 0 && (
        <div className="p-4">
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-semibold">#</th>
                  {cols.map((c) => (
                    <th key={c} className="px-3 py-2 font-semibold">
                      {c} <span className={`ml-1 font-normal normal-case ${filled(c) < 80 ? 'text-amber-700' : 'text-slate-400'}`}>{filled(c)}%</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={i} className="align-top">
                    <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                    {cols.map((c) => {
                      const v = r?.[c];
                      const t = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                      return (
                        <td key={c} className="max-w-[280px] px-3 py-2 text-slate-800">
                          {t === '' ? <span className="text-slate-300">—</span>
                            : /^https?:\/\//.test(t) ? <a href={t} target="_blank" rel="noopener noreferrer" className="block truncate text-brand-700 underline">{t}</a>
                            : <span className="line-clamp-2 break-words">{t}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex items-center gap-3 text-sm text-slate-500">
            <span>Showing {rows.length} of {records.length} sample rows{Object.keys(records[0] || {}).length > cols.length ? ` · ${cols.length} of ${Object.keys(records[0] || {}).length} columns` : ''}. Percentages = how many rows have the field filled.</span>
            {records.length > 10 && (
              <button type="button" onClick={() => setShowAll((v) => !v)} className="font-medium text-brand-700 hover:underline">{showAll ? 'Show fewer' : 'Show all'}</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
