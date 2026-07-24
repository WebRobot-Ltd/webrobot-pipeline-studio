'use client';

/**
 * Section 2 of the native designer — "Build your pipeline".
 *
 * The manual composer: pick stages from the live catalog, arrange them (with the multi-source
 * authoring model — each stage targets a source number or the shared tail), edit their args,
 * and watch the YAML the ETL runtime will actually run. The YAML is produced by the ported,
 * unit-tested generator (lib/tenant-studio/yaml.ts), so the preview here is the real thing,
 * not an approximation.
 *
 * This covers the manual/structured flow. The selector-inference sub-wizard (infer-fields,
 * live picker, CMF preview) plugs into the same wizPipeline rows and is ported separately.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getStageCatalog,
  saveGeneratedPipeline,
  wizardValidate,
  TenantStudioError,
} from '../client';
import {
  buildYamlFromPipeline,
  PipelineRow,
  PipelineField,
  StageSpec,
} from '../yaml';
import { WizRuntime } from '../types';
import FieldEditor from './FieldEditor';
import OddsMarketsEditor from './OddsMarketsEditor';
import PythonExtensionsEditor from './PythonExtensionsEditor';
import { OddsMarket, PyExtension } from '../yaml';

interface CatalogStage extends StageSpec {
  category?: string;
  description?: string;
}

type TargetSource = number | 'shared';

export default function BuildWizard() {
  const [catalog, setCatalog] = useState<CatalogStage[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const [pipeline, setPipeline] = useState<PipelineRow[]>([]);
  const [target, setTarget] = useState<TargetSource>(1);

  const [pipelineName, setPipelineName] = useState('');
  const [runtime, setRuntime] = useState<WizRuntime>('spark');
  const [geo, setGeo] = useState('');
  const [pyExts, setPyExts] = useState<PyExtension[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    getStageCatalog()
      .then((d) => setCatalog(d?.data || d?.stages || []))
      .catch((e) => setCatalogError(e instanceof TenantStudioError ? `${e.status}` : 'failed'));
  }, []);

  // ── Multi-source helpers, ported from the Vue authoring model ──────────────
  const maxSourceNum = useCallback(() => {
    let m = 1;
    for (const r of pipeline) if (typeof r._src === 'number' && r._src > m) m = r._src;
    return m;
  }, [pipeline]);

  const srcKey = (r: PipelineRow) =>
    r._src === 'shared' ? Number.MAX_SAFE_INTEGER : typeof r._src === 'number' ? r._src : 1;

  const addStage = (stageName: string) => {
    setPipeline((prev) =>
      [...prev, { stage: stageName, args: {}, _src: target } as PipelineRow]
        .sort((a, b) => srcKey(a) - srcKey(b)));
  };

  const removeStage = (idx: number) => setPipeline((prev) => prev.filter((_, i) => i !== idx));

  const moveStage = (idx: number, dir: -1 | 1) => {
    setPipeline((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const setArg = (idx: number, name: string, value: string) => {
    setPipeline((prev) => prev.map((r, i) =>
      i === idx ? { ...r, args: { ...r.args, [name]: value } } : r));
  };

  const setFields = (idx: number, fields: PipelineField[]) => {
    setPipeline((prev) => prev.map((r, i) => (i === idx ? { ...r, _fields: fields } : r)));
  };

  const setMarkets = (idx: number, markets: OddsMarket[]) => {
    setPipeline((prev) => prev.map((r, i) => (i === idx ? { ...r, _markets: markets } : r)));
  };

  const multiSource = pipeline.some(
    (r) => r._src === 'shared' || (typeof r._src === 'number' && r._src > 1));

  const groupedCatalog = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = catalog.filter(
      (s) => !q || s.stage_name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));
    const byCat = new Map<string, CatalogStage[]>();
    for (const s of matched) {
      const c = s.category || 'other';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c)!.push(s);
    }
    return Array.from(byCat.entries());
  }, [catalog, filter]);

  const yaml = useMemo(
    () => buildYamlFromPipeline(pipeline, { catalog, runtime, geo, pythonExtensions: pyExts }),
    [pipeline, catalog, runtime, geo, pyExts]);

  const findSpec = (name: string) =>
    catalog.find((s) => s.stage_name === name || (s.aliases || []).includes(name));

  const handleValidate = async () => {
    setValidation('validating…');
    try {
      const r = await wizardValidate({ yaml });
      setValidation(r?.valid ? `valid · ${r?.record_count ?? '?'} records` : `invalid: ${r?.error || 'see steps'}`);
    } catch (e) {
      setValidation(e instanceof TenantStudioError ? `validate → ${e.status}` : 'validation failed');
    }
  };

  const handleSave = async (execute: boolean) => {
    if (!pipelineName.trim()) { setSaveMsg('Name the pipeline first.'); return; }
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await saveGeneratedPipeline({
        pipeline_name: pipelineName.trim(),
        pipeline_yaml: yaml,
        execute,
      });
      setSaveMsg(`Saved as “${pipelineName}”${execute && res?.execution?.execution_id ? ` · run ${res.execution.execution_id}` : ''}.`);
    } catch (e) {
      setSaveMsg(e instanceof TenantStudioError ? `save → ${e.status}` : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Catalogue */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-700">Stage catalogue</h3>
          <span className="text-xs text-slate-400">{catalog.length} stages</span>
        </div>
        {catalogError && <p className="text-xs text-red-600 mb-2">catalogue failed ({catalogError})</p>}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter stages…"
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm mb-2"
        />
        <div className="flex items-center gap-2 mb-3 text-xs">
          <span className="text-slate-500">Add to:</span>
          <select
            value={String(target)}
            onChange={(e) => {
              const v = e.target.value;
              setTarget(v === 'shared' ? 'shared' : v === '__new' ? maxSourceNum() + 1 : Number(v));
            }}
            className="rounded border border-slate-300 px-1.5 py-1"
          >
            {Array.from({ length: maxSourceNum() }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>Source {n}</option>
            ))}
            <option value="__new">+ new source</option>
            <option value="shared">shared final part</option>
          </select>
        </div>
        <div className="max-h-96 overflow-auto space-y-3">
          {groupedCatalog.map(([cat, stages]) => (
            <div key={cat}>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{cat}</div>
              <div className="flex flex-wrap gap-1.5">
                {stages.map((s) => (
                  <button
                    key={s.stage_name}
                    onClick={() => addStage(s.stage_name)}
                    title={s.description || s.stage_name}
                    className="text-xs px-2 py-1 rounded border border-slate-200 hover:bg-blue-50 hover:border-blue-300"
                  >
                    + {s.stage_name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pipeline + preview */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Pipeline</h3>

        {pipeline.length === 0 && (
          <p className="text-sm text-slate-400 mb-3">Add stages from the catalogue to begin.</p>
        )}

        <ol className="space-y-2 mb-4">
          {pipeline.map((row, idx) => {
            const spec = findSpec(row.stage);
            const args = (spec?.arg_schema || []).map((a) => a.name);
            return (
              <li key={idx} className="rounded border border-slate-200 p-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono font-semibold text-slate-800">{row.stage}</span>
                  {multiSource && (
                    <span className="text-[10px] px-1 rounded bg-slate-100 text-slate-500">
                      {row._src === 'shared' ? 'shared' : `S${row._src || 1}`}
                    </span>
                  )}
                  <span className="ml-auto flex gap-1">
                    <button onClick={() => moveStage(idx, -1)} className="text-xs text-slate-400 hover:text-slate-700">↑</button>
                    <button onClick={() => moveStage(idx, 1)} className="text-xs text-slate-400 hover:text-slate-700">↓</button>
                    <button onClick={() => removeStage(idx)} className="text-xs text-red-400 hover:text-red-600">✕</button>
                  </span>
                </div>
                {['extract', 'flatSelect'].includes(row.stage) ? (
                  <>
                    {row.stage === 'flatSelect' && (
                      <div className="flex items-center gap-2 mb-1">
                        <label className="text-xs text-slate-500 w-28 shrink-0">segment</label>
                        <input
                          value={row.args.segmentSelector ?? row.args.selector ?? ''}
                          onChange={(e) => setArg(idx, 'segmentSelector', e.target.value)}
                          placeholder="segment CSS selector"
                          className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs font-mono"
                        />
                      </div>
                    )}
                    <FieldEditor row={row} onChange={(f) => setFields(idx, f)} />
                  </>
                ) : args.length > 0 ? (
                  <div className="space-y-1">
                    {args.map((n) => (
                      <div key={n} className="flex items-center gap-2">
                        <label className="text-xs text-slate-500 w-28 shrink-0">{n}</label>
                        <input
                          value={row.args[n] ?? ''}
                          onChange={(e) => setArg(idx, n, e.target.value)}
                          className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs"
                        />
                      </div>
                    ))}
                  </div>
                ) : row.stage === 'oddsSelect' || row.stage === 'odds_select' ? (
                  <OddsMarketsEditor row={row} onChange={(m) => setMarkets(idx, m)} />
                ) : (
                  <p className="text-[11px] text-slate-400">no args</p>
                )}
              </li>
            );
          })}
        </ol>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="block text-[11px] text-slate-500 mb-0.5">Runtime</label>
            <select value={runtime} onChange={(e) => setRuntime(e.target.value as WizRuntime)}
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs">
              <option value="spark">Spark</option>
              <option value="ray_actor">Ray actor</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-0.5">Geo (2-letter)</label>
            <input value={geo} onChange={(e) => setGeo(e.target.value)} placeholder="e.g. de"
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs" />
          </div>
        </div>

        <details className="mb-3">
          <summary className="text-[11px] text-slate-500 cursor-pointer">Python extensions ({pyExts.length})</summary>
          <div className="mt-2">
            <PythonExtensionsEditor exts={pyExts} onChange={setPyExts} />
          </div>
        </details>

        <label className="block text-[11px] text-slate-500 mb-0.5">YAML preview</label>
        <pre className="max-h-64 overflow-auto rounded bg-slate-900 text-slate-100 text-[11px] p-3 mb-3 whitespace-pre-wrap">
          {yaml}
        </pre>

        <div className="flex items-center gap-2 mb-2">
          <input
            value={pipelineName}
            onChange={(e) => setPipelineName(e.target.value)}
            placeholder="pipeline name"
            className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          <button onClick={handleValidate}
            className="text-xs px-2 py-1.5 rounded border border-slate-200 hover:bg-slate-50">
            Validate
          </button>
        </div>
        {validation && <p className="text-xs text-slate-500 mb-2">{validation}</p>}

        <div className="flex gap-2">
          <button onClick={() => handleSave(false)} disabled={saving || pipeline.length === 0}
            className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50">
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          <button onClick={() => handleSave(true)} disabled={saving || pipeline.length === 0}
            className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm disabled:opacity-50">
            Save & run
          </button>
        </div>
        {saveMsg && <p className="text-xs text-slate-600 mt-2">{saveMsg}</p>}
      </section>
    </div>
  );
}
