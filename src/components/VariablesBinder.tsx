'use client';
// "Use dataset columns as variables" (user 10-25: the job → project association needs templatization).
// Given the agent and the input dataset chosen for a job, it asks the platform where the pipeline has
// values worth taking from the dataset (infer-variables), lets the person bind each to a column, rewrites
// the YAML (templatize.ts) and saves it on the agent (apply-variables). Then every dataset row is one run.
import { useEffect, useState } from 'react';
import { listPipelines, getDatasetColumns, wizardInferVariables, wizardApplyVariables, TenantStudioError } from '../client';
import { templatizeYaml, detectUrlKeyword, type VariableCandidate, type VariableBinding } from '../templatize';

export default function VariablesBinder({ agentId, datasetId, onApplied }: {
  agentId: string | number;
  datasetId: string | number;
  /** called with the saved YAML after the bindings are applied */
  onApplied?: (yaml: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pipelineName, setPipelineName] = useState('');
  const [yaml, setYaml] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<(VariableBinding & { on: boolean })[]>([]);

  // a different agent or dataset → start again
  useEffect(() => { setOpen(false); setRows([]); setDone(null); setErr(null); }, [agentId, datasetId]);

  const analyse = async () => {
    setOpen(true); setBusy(true); setErr(null); setDone(null);
    try {
      const [list, cols] = await Promise.all([listPipelines(), getDatasetColumns(datasetId).catch(() => [] as string[])]);
      const items: any[] = list?.demos || list?.data || list?.pipelines || (Array.isArray(list) ? list : []);
      const it = items.find((p) => String(p.agent_id) === String(agentId));
      if (!it?.pipeline_yaml) { setErr('This agent has no pipeline to templatize.'); return; }
      setPipelineName(it.pipeline_name || it.agent_name);
      setYaml(it.pipeline_yaml);
      setColumns(cols);
      const r = await wizardInferVariables({ pipeline_yaml: it.pipeline_yaml, dataset_columns: cols });
      const cands: VariableCandidate[] = r?.variables || [];
      setRows(cands.map((c) => {
        const isUrl = c.kind === 'url' || /^https?:\/\//.test(c.current);
        const kw = isUrl ? detectUrlKeyword(c.current) : null;
        return {
          candidate: c, on: true,
          column: c.suggested_column || '',
          mode: isUrl ? (kw ? 'url_keyword' : 'whole_url') : 'value',
          keyword: kw || undefined,
        };
      }));
      if (!cands.length) setErr('No value in this pipeline looks like it should come from the dataset (search words, URLs, typed texts).');
    } catch (e) {
      setErr(e instanceof TenantStudioError ? `Analysis failed (${e.status})` : 'Analysis failed');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const chosen = rows.filter((r) => r.on && r.column.trim());
    const t = templatizeYaml(yaml, chosen);
    if (!t.count) { setErr(t.notes[0] || 'Pick a column for at least one value.'); return; }
    setBusy(true); setErr(null);
    try {
      await wizardApplyVariables({ pipeline_name: pipelineName, pipeline_yaml: t.yaml });
      setYaml(t.yaml);
      setDone(`Saved: ${t.count} value${t.count === 1 ? '' : 's'} now come${t.count === 1 ? 's' : ''} from the dataset — the job runs once per row.${t.notes.length ? ' ' + t.notes.join(' ') : ''}`);
      onApplied?.(t.yaml);
    } catch (e) {
      setErr(e instanceof TenantStudioError ? `Save failed (${e.status})` : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const set = (i: number, patch: Partial<VariableBinding & { on: boolean }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const inp = 'rounded border border-slate-300 px-2 py-1 text-sm';

  if (!open) {
    return (
      <button type="button" onClick={analyse}
        className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-semibold text-brand-900 hover:bg-brand-100">
        🔗 Use dataset columns as variables
      </button>
    );
  }
  return (
    <div className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-3 text-sm">
      <div className="flex items-center">
        <span className="font-semibold text-slate-800">🔗 Values taken from the dataset</span>
        <span className="flex-1" />
        <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-700" title="Close">✕</button>
      </div>
      <p className="text-slate-600">Each row of the dataset becomes one run: the values below are replaced by that row's column.</p>
      {busy && <p className="text-slate-500">Working…</p>}
      {rows.map((r, i) => {
        const isUrl = r.mode !== 'value';
        return (
          <div key={i} className="space-y-1.5 rounded-lg border border-slate-200 bg-white p-2.5">
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} className="mt-1" />
              <span className="min-w-0">
                <span className="block text-xs uppercase tracking-wide text-slate-400">{r.candidate.stage} · {isUrl ? 'URL' : 'value'}</span>
                <code className="block break-all text-slate-800">{r.candidate.current}</code>
              </span>
            </label>
            {r.on && (
              <div className="flex flex-wrap items-center gap-2 pl-6">
                {isUrl && (
                  <select className={inp} value={r.mode} onChange={(e) => set(i, { mode: e.target.value as VariableBinding['mode'] })}>
                    <option value="url_keyword">only the search word in the URL</option>
                    <option value="whole_url">the whole URL</option>
                  </select>
                )}
                {r.mode === 'url_keyword' && (
                  <input className={inp + ' w-32'} value={r.keyword || ''} onChange={(e) => set(i, { keyword: e.target.value })} placeholder="word in URL" title="The part of the URL that changes per row" />
                )}
                <span className="text-slate-600">from column</span>
                {columns.length ? (
                  <select className={inp} value={r.column} onChange={(e) => set(i, { column: e.target.value })}>
                    <option value="">— choose —</option>
                    {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input className={inp + ' w-36'} value={r.column} onChange={(e) => set(i, { column: e.target.value })} placeholder="column name" />
                )}
              </div>
            )}
          </div>
        );
      })}
      {err && <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">{err}</p>}
      {done && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800">✓ {done}</p>}
      {rows.length > 0 && !done && (
        <button type="button" onClick={apply} disabled={busy}
          className="rounded-lg bg-brand-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-brand-950 disabled:opacity-50">
          Apply to the agent's pipeline
        </button>
      )}
    </div>
  );
}
