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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  getStageCatalog,
  saveGeneratedPipeline,
  wizardValidate,
  getPipelineDraft,
  putPipelineDraft,
  deletePipelineDraft,
  generatePipeline,
  TenantStudioError,
  type PipelineDraft,
} from '../client';
import {
  buildYamlFromPipeline,
  parsePipelineFromYaml,
  PipelineRow,
  PipelineField,
  StageSpec,
} from '../yaml';
import { WizRuntime } from '../types';
import { diffLines } from '../lineDiff';
import FieldEditor from './FieldEditor';
import OddsMarketsEditor from './OddsMarketsEditor';
import PythonExtensionsEditor from './PythonExtensionsEditor';
import { OddsMarket, PyExtension, TraceAction } from '../yaml';
import SelectorPicker, {
  type PickField,
  type PickResult,
  type PickerAction,
  type MarketBoxPick,
  type MacroBoxPick,
  type PickerMode,
} from './SelectorPicker';

import { lookOf, PHASES, sequenceAdvice } from '../stageIdentity';
interface CatalogStage extends StageSpec {
  category?: string;
  description?: string;
}

type TargetSource = number | 'shared';

/** Stages that carry a source URL — used to seed the visual picker's mirror. */
const FETCH_STAGES = new Set(['fetch', 'visit', 'wget']);

/**
 * @param chatSlot optional "design with chat" panel injected by the host — the SAME slot the
 *   agentic studio uses (DesignWithChat is generic; only the context differs, ETL vs agentic).
 *   The package bundles no chat component; the host passes one.
 * @param value optional controlled pipeline YAML. When provided together with `onChange`, the
 *   wizard becomes a controlled value/onChange editor: it seeds its internal rows from
 *   parsePipelineFromYaml(value) and emits buildYamlFromPipeline(...) on every edit. Omit both
 *   for the standalone (self-saving) behaviour — identical to before.
 * @param onChange called with the regenerated YAML whenever the pipeline changes (controlled).
 * @param embedded when true, hides the standalone chrome (pipeline name, Validate/Save/Run) so
 *   the host form owns persistence. The stage catalogue, stage editors and visual picker stay.
 * @param label heading for the pipeline column (defaults to "Pipeline").
 */
export default function BuildWizard({
  chatSlot,
  value,
  onChange,
  embedded = false,
  label,
  organizations,
  draftContext = 'etl:pipeline-designer',
}: {
  chatSlot?: ReactNode;
  value?: string;
  onChange?: (yaml: string) => void;
  embedded?: boolean;
  label?: string;
  /**
   * Organizzazioni a cui il chiamante puo' assegnare la pipeline. Passate dall'host, non
   * recuperate qui: elencarle e' una faccenda amministrativa e questo pacchetto parla solo con
   * /tenant/*. Con meno di due voci il selettore non compare: scegliere fra una sola cosa non
   * e' una scelta.
   */
  organizations?: { id: string; name: string }[];
  /**
   * Quale slot di bozza guardare. Tiene separate le proposte dei diversi designer: senza, una
   * pipeline proposta per Agent Studio comparirebbe qui come se riguardasse quella aperta.
   */
  draftContext?: string;
} = {}) {
  const controlled = value !== undefined && typeof onChange === 'function';
  const [catalog, setCatalog] = useState<CatalogStage[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const [pipeline, setPipeline] = useState<PipelineRow[]>([]);
  const [target, setTarget] = useState<TargetSource>(1);

  const [pipelineName, setPipelineName] = useState('');
  // Vuoto = la propria organizzazione, cioe' il comportamento di prima.
  const [orgId, setOrgId] = useState('');
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

  // ── Visual selector picker wiring ──────────────────────────────────────────
  // The picker (ported 1:1 from the Vue studio) is launched per-row; its callbacks
  // write straight into the same row fields the YAML serializer reads (_fields,
  // _markets, _trace, _requires_hitl, _anti_bot_kind). No host coupling: the picker
  // talks to the tenant backend through the injected client.
  const [pickerFor, setPickerFor] = useState<number | null>(null);

  const patchRow = (idx: number, patch: Partial<PipelineRow>) =>
    setPipeline((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const pickFieldToPF = (f: PickField): PipelineField => ({
    selector: f.selector, as: f.as, method: f.method, _parallel: f._parallel,
  });
  const pfToPickField = (f: PipelineField): PickField => ({
    selector: f.selector, as: f.as || '', method: f.method || 'text', _parallel: f._parallel,
  });

  // Source URL for a row = the fetch-like stage's url in the SAME source group
  // (multi-source), falling back to the first fetch-like url anywhere.
  const sourceUrlFor = (idx: number): string => {
    const row = pipeline[idx];
    const urlOf = (r: PipelineRow) => r?.args?.url || r?.args?.startUrl || r?.args?.startUrls || '';
    const sameSrc = pipeline.filter(
      (r) => FETCH_STAGES.has(r.stage) && srcKey(r) === srcKey(row) && urlOf(r));
    if (sameSrc.length) return String(urlOf(sameSrc[0]));
    const any = pipeline.find((r) => FETCH_STAGES.has(r.stage) && urlOf(r));
    return any ? String(urlOf(any)) : '';
  };

  /** URL della riga stessa: il picker non puo' aprire niente senza. */
  const urlOfRow = (r: PipelineRow) =>
    String(r?.args?.url || r?.args?.startUrl || r?.args?.startUrls || '');

  const pickerModeFor = (row: PipelineRow): PickerMode => {
    if (row.stage === 'oddsSelect' || row.stage === 'odds_select') return 'market-box';
    // Una riga di fetch non ha campi da selezionare: quello che si compone li' e' la
    // NAVIGAZIONE (accetta i cookie, cerca, clicca "carica altro") prima che la pagina
    // mostri i dati. Il picker sapeva gia' registrarla — 'action-record' esisteva — ma
    // nessuno gliela chiedeva mai, e dal fetch non si poteva nemmeno aprire il picker.
    if (FETCH_STAGES.has(row.stage)) return 'action-record';
    return 'multi-field';
  };

  // Navigation trace + anti-bot are properties of the FETCH-like stage (the serializer only
  // emits _trace/requires_hitl there), not the picked extract row. Route them to the fetch
  // row in the same source group; fall back to the picked row if there's none.
  const fetchRowIndexFor = (pIdx: number): number => {
    const row = pipeline[pIdx];
    // Se il picker e' stato aperto PROPRIO da una riga di fetch (registrazione azioni), la
    // traccia appartiene a quella riga: senza questo si prendeva la prima del gruppo, che
    // con due sorgenti nello stesso gruppo e' un'altra.
    if (FETCH_STAGES.has(row?.stage)) return pIdx;
    const inSrc = pipeline.findIndex(
      (r) => FETCH_STAGES.has(r.stage) && srcKey(r) === srcKey(row));
    if (inSrc >= 0) return inSrc;
    const anyIdx = pipeline.findIndex((r) => FETCH_STAGES.has(r.stage));
    return anyIdx >= 0 ? anyIdx : pIdx;
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
    () => buildYamlFromPipeline(pipeline, {
      catalog, runtime, geo, pythonExtensions: pyExts,
      // Any anti-bot row detected by the picker → emit metadata.requires_hitl.
      hitlAwait: pipeline.some((r) => r && r._requires_hitl),
    }),
    [pipeline, catalog, runtime, geo, pyExts]);

  // ── Proposta dell'assistente ────────────────────────────────────────────────
  // L'assistente non tocca questo stato: scrive una bozza lato server e noi la leggiamo. Cosi' il
  // canale non dipende da quale pannello sia aperto, e una proposta non va persa perche' l'utente ha
  // chiuso la chat prima che arrivasse.
  //
  // Non si applica da sola. Sovrascrivere il canvas di chi sta progettando senza mostrargli cosa
  // cambia e' il modo piu' rapido per fargli perdere il lavoro senza nemmeno sapere cosa e' successo.
  const [draft, setDraft] = useState<PipelineDraft | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [askText, setAskText] = useState('');
  const [askErr, setAskErr] = useState<string | null>(null);
  // updated_at dell'ultima bozza SCARTATA: senza, il ciclo la riproporrebbe tre secondi dopo.
  const dismissed = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const d = await getPipelineDraft(draftContext);
      if (!alive) return;
      if (!d) { setDraft(null); return; }
      if (d.updated_at && d.updated_at === dismissed.current) return;
      setDraft((prev) => (prev && prev.updated_at === d.updated_at ? prev : d));
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(h); };
  }, [draftContext]);

  /** Applica la proposta al canvas. Il diff l'utente l'ha gia' visto: qui si esegue la sua scelta. */
  const applyDraft = useCallback(async () => {
    if (!draft) return;
    setPipeline(parsePipelineFromYaml(draft.pipeline_yaml));
    if (draft.pipeline_name && !pipelineName.trim()) setPipelineName(draft.pipeline_name);
    setDraftOpen(false);
    setDraft(null);
    // Consumata: si cancella, altrimenti resta in attesa e ricompare al prossimo giro.
    try { await deletePipelineDraft(draftContext); } catch { /* la proposta e' gia' applicata */ }
  }, [draft, draftContext, pipelineName]);

  const dismissDraft = useCallback(async () => {
    dismissed.current = draft?.updated_at || null;
    setDraftOpen(false);
    setDraft(null);
    try { await deletePipelineDraft(draftContext); } catch { /* verra' sovrascritta */ }
  }, [draft, draftContext]);

  /**
   * Campo testuale: una riga di descrizione invece di una conversazione. Scrive nella STESSA bozza,
   * quindi il percorso di revisione e' identico — si vede il diff e si decide.
   */
  const askForPipeline = useCallback(async () => {
    const prompt = askText.trim();
    if (!prompt) return;
    setGenerating(true);
    setAskErr(null);
    try {
      const r = await generatePipeline({ prompt });
      const y = r?.pipeline_yaml;
      if (!y) { setAskErr(r?.error || 'No pipeline came back. Try describing the goal more concretely.'); return; }
      setDraft({
        context: draftContext,
        pipeline_name: r.pipeline_name || null,
        pipeline_yaml: y,
        note: `From your description: “${prompt}”`,
        updated_at: new Date().toISOString(),
      });
      setDraftOpen(true);
      setAskText('');
    } catch (e) {
      setAskErr(e instanceof TenantStudioError ? `generate → ${e.status}` : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }, [askText, draftContext]);

  // Il canvas corrente, pubblicato nello slot GEMELLO (`…:canvas`). Serve perche' l'assistente sappia
  // cosa l'utente sta costruendo: senza, ogni richiesta ricominciava da zero invece di modificare, e
  // "aggiungi anche il prezzo" produceva una pipeline nuova che buttava via il resto.
  //
  // Passa dalla stessa bozza invece che dal contesto della chat perche' quello e' una chiave breve —
  // serve anche da etichetta e da elenco di suggerimenti — e infilarci dentro trenta righe di YAML lo
  // romperebbe. Qui il canale esiste gia' ed e' letto dagli stessi strumenti dell'agente.
  const publishedCanvas = useRef<string | null>(null);
  useEffect(() => {
    if (embedded) return;                       // l'host possiede lo stato: non e' nostro da pubblicare
    const out = pipeline.length === 0 ? '' : yaml;
    if (!out || out === publishedCanvas.current) return;
    // Ritardo: senza, ogni battuta nell'editor di uno stage sarebbe una scrittura.
    const h = setTimeout(() => {
      publishedCanvas.current = out;
      putPipelineDraft({
        context: `${draftContext}:canvas`,
        pipeline_name: pipelineName.trim() || null,
        pipeline_yaml: out,
        note: "Canvas corrente: lo pubblica il designer, non e' una proposta dell'assistente",
      }).catch(() => { publishedCanvas.current = null; });   // si riprova al prossimo cambio
    }, 5000);
    return () => clearTimeout(h);
  }, [embedded, pipeline, yaml, pipelineName, draftContext]);

  // ── Controlled/embedded value ⇄ onChange plumbing ──────────────────────────
  // `lastYaml` is the last YAML that crossed the boundary in either direction. It
  // breaks the feedback loop: an incoming `value` we already emitted is ignored,
  // and an outgoing YAML equal to the incoming `value` is not re-emitted.
  const lastYaml = useRef<string | null>(null);

  // Incoming: parse an externally-changed `value` into rows.
  useEffect(() => {
    if (!controlled) return;
    const incoming = value ?? '';
    if (incoming === lastYaml.current) return;
    lastYaml.current = incoming;
    setPipeline(parsePipelineFromYaml(incoming));
  }, [controlled, value]);

  // Outgoing: emit regenerated YAML on every edit (empty pipeline → empty string,
  // never the "(add at least one stage)" placeholder).
  useEffect(() => {
    if (!controlled || !onChange) return;
    const out = pipeline.length === 0 ? '' : yaml;
    if (out === lastYaml.current) return;
    lastYaml.current = out;
    onChange(out);
  }, [controlled, onChange, pipeline, yaml]);

  const findSpec = (name: string) =>
    catalog.find((s) => s.stage_name === name || (s.aliases || []).includes(name));

  /** Fasi coperte e primo buco da colmare — alimenta la guida alla sequenza. */
  const advice = useMemo(
    () => sequenceAdvice(pipeline, (stage) => findSpec(stage)?.category),
    // findSpec dipende dal catalogo: senza, il consiglio resterebbe fermo al primo caricamento.
    [pipeline, catalog],
  );

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
        // Omesso quando non scelto: il server ricade sull'organizzazione del chiamante.
        ...(orgId ? { organization_id: orgId } : {}),
      });
      setSaveMsg(`Saved as “${pipelineName}”${execute && res?.execution?.execution_id ? ` · run ${res.execution.execution_id}` : ''}.`);
    } catch (e) {
      setSaveMsg(e instanceof TenantStudioError ? `save → ${e.status}` : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Colonne asimmetriche, non meta' e meta'. Il catalogo e' una lista di pastiglie e smette di
  // migliorare oltre una certa larghezza; la pipeline contiene i campi che si modificano e lo
  // YAML generato, che invece guadagna da ogni pixel. A meta' schermo il catalogo sprecava
  // spazio proprio mentre l'anteprima andava a capo.
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(300px,380px)_1fr] gap-4 items-start">
      {/* Riga "descrivi o conversa": due modi di chiedere la stessa cosa, un solo canale di ritorno. */}
      {!embedded && (
        <div className="lg:col-span-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex flex-1 items-center gap-2">
            <input
              className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="Describe what you want to collect — e.g. “every product page of shop.example.com with name, price and EAN”"
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') askForPipeline(); }}
              disabled={generating}
            />
            <button
              type="button"
              onClick={askForPipeline}
              disabled={generating || !askText.trim()}
              className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              title="Propose a pipeline from this description — you review it before anything changes"
            >
              {generating ? 'Proposing…' : 'Propose'}
            </button>
          </div>
          {chatSlot}
        </div>
      )}
      {embedded && chatSlot && <div className="lg:col-span-2 flex justify-end">{chatSlot}</div>}
      {askErr && (
        <p className="lg:col-span-2 text-xs text-rose-600">{askErr}</p>
      )}

      {/* La proposta in attesa. Compare quando l'assistente ha scritto una bozza: nulla e' cambiato
          ancora nel canvas, e la si vede prima di decidere. */}
      {draft && (
        <div className="lg:col-span-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-indigo-900">
              🤖 The assistant proposes a pipeline
            </span>
            {draft.pipeline_name && (
              <span className="rounded border border-indigo-200 bg-white px-1.5 py-0.5 text-xs text-indigo-700">
                {draft.pipeline_name}
              </span>
            )}
            <span className="flex-1" />
            <button type="button" onClick={() => setDraftOpen((v) => !v)}
              className="rounded-md border border-indigo-300 bg-white px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100">
              {draftOpen ? 'Hide changes' : 'See changes'}
            </button>
            <button type="button" onClick={applyDraft}
              className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700">
              Apply to the canvas
            </button>
            <button type="button" onClick={dismissDraft}
              className="rounded-md px-2.5 py-1 text-xs text-slate-500 hover:bg-white">
              Discard
            </button>
          </div>
          {draft.note && <p className="mt-1 text-xs text-indigo-800">{draft.note}</p>}
          {draftOpen && (
            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
              {/* Un diff riga per riga, non un semplice "prima/dopo": su una pipeline lunga la
                  differenza fra due blocchi di YAML e' esattamente la cosa che non si vede a occhio. */}
              <div>
                <p className="mb-1 text-xs font-medium text-slate-600">Now</p>
                <pre className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-white p-2 text-[11px] leading-snug">
                  {diffLines(pipeline.length ? yaml : '', draft.pipeline_yaml).map((l, i) => (
                    <div key={i} className={l.left === null ? 'bg-emerald-50' : l.changed ? 'bg-amber-50' : ''}>
                      {l.left ?? ''}
                    </div>
                  ))}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-slate-600">Proposed</p>
                <pre className="max-h-64 overflow-auto rounded-md border border-indigo-200 bg-white p-2 text-[11px] leading-snug">
                  {diffLines(pipeline.length ? yaml : '', draft.pipeline_yaml).map((l, i) => (
                    <div key={i} className={l.right === null ? 'bg-rose-50' : l.changed ? 'bg-amber-50' : ''}>
                      {l.right ?? ''}
                    </div>
                  ))}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
      {/* Catalogue */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-700">Stage catalogue</h3>
          <span className="text-sm text-slate-400">{catalog.length} stages</span>
        </div>
        {catalogError && <p className="text-sm text-red-600 mb-2">catalogue failed ({catalogError})</p>}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter stages…"
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm mb-2"
        />
        <div className="flex items-center gap-2 mb-3 text-sm">
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
        {/* Altezza legata alla finestra, non un numero fisso: max-h-96 (384px) su un catalogo di
            111 stage in otto gruppi mostrava tre voci per gruppo e costringeva a scorrere dentro un
            riquadro dentro la pagina. Il minimo tiene il riquadro sensato su finestre basse. */}
        <div className="max-h-[calc(100vh-20rem)] min-h-[24rem] overflow-auto space-y-3">
          {/* Le stesse icone e gli stessi colori delle righe compaiono gia' QUI, nel momento in
              cui si sceglie: e' dove servono di piu'. La categoria grezza del catalogo resta come
              titolo del gruppo, ma sotto ogni voce porta la sua famiglia, che e' normalizzata e
              coerente anche per i 26 stage che una categoria non ce l'hanno. */}
          {groupedCatalog.map(([cat, stages]) => {
            const groupLook = lookOf(stages[0]?.stage_name || '', stages[0]?.category);
            return (
            <div key={cat}>
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-sm font-semibold text-slate-600 uppercase tracking-wide">{cat}</span>
                {groupLook.blurb && (
                  <span className="text-xs text-slate-400">{groupLook.blurb}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {stages.map((s) => {
                  const look = lookOf(s.stage_name, s.category);
                  return (
                  <button
                    key={s.stage_name}
                    onClick={() => addStage(s.stage_name)}
                    title={s.description || `${look.label} — ${look.blurb}`}
                    className={`text-sm px-2 py-1 rounded-full border inline-flex items-center gap-1 hover:brightness-95 ${look.chip}`}
                  >
                    <span aria-hidden="true">{look.icon}</span>
                    {s.stage_name}
                  </button>
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>
      </section>

      {/* Pipeline + preview */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">{label || 'Pipeline'}</h3>

        {/* Guida alla sequenza.
            Una pipeline si legge in quattro tempi — prendi, estrai, trasforma, salva — ma il
            catalogo e' un elenco piatto di 111 voci e quell'ordine non si vede da nessuna parte.
            Qui si mostrano le fasi, quali sono gia' coperte, e la prima cosa che manca perche' la
            pipeline produca qualcosa. Non impone un ordine: la trasformazione e' facoltativa, e
            il consiglio parla solo quando c'e' un buco che rende il risultato vuoto. */}
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
          <ol className="flex flex-wrap items-center gap-1.5">
            {PHASES.map((ph, i) => {
              const done = advice.covered.has(ph.n);
              return (
                <li key={ph.n} className="flex items-center gap-1.5">
                  <span
                    title={ph.hint}
                    className={
                      'px-2 py-1 rounded-full text-xs font-medium border ' +
                      (done
                        ? 'bg-white border-slate-300 text-slate-700'
                        : 'bg-transparent border-dashed border-slate-300 text-slate-400')
                    }
                  >
                    {done ? '✓' : ph.n}. {ph.title}
                  </span>
                  {i < PHASES.length - 1 && <span className="text-slate-300" aria-hidden="true">→</span>}
                </li>
              );
            })}
          </ol>
          {advice.missing && (
            <p className="mt-2 text-xs text-amber-700">💡 {advice.missing}</p>
          )}
        </div>

        {pipeline.length === 0 && (
          <p className="text-sm text-slate-400 mb-3">Add stages from the catalogue to begin.</p>
        )}

        <ol className="space-y-2 mb-4">
          {pipeline.map((row, idx) => {
            const spec = findSpec(row.stage);
            const args = (spec?.arg_schema || []).map((a) => a.name);
            const look = lookOf(row.stage, spec?.category);
            return (
              <li key={idx} className={`rounded border border-slate-200 border-l-4 ${look.bar} p-2.5 bg-white`}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-base leading-none" aria-hidden="true">{look.icon}</span>
                  <span className="text-sm font-mono font-semibold text-slate-800">{row.stage}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full border ${look.chip}`}>{look.label}</span>
                  {multiSource && (
                    <span className="text-xs px-1 rounded bg-slate-100 text-slate-500">
                      {row._src === 'shared' ? 'shared' : `S${row._src || 1}`}
                    </span>
                  )}
                  <span className="ml-auto flex gap-1">
                    <button onClick={() => moveStage(idx, -1)} className="text-sm text-slate-400 hover:text-slate-700">↑</button>
                    <button onClick={() => moveStage(idx, 1)} className="text-sm text-slate-400 hover:text-slate-700">↓</button>
                    <button onClick={() => removeStage(idx)} className="text-sm text-red-400 hover:text-red-600">✕</button>
                  </span>
                </div>
                {['extract', 'flatSelect'].includes(row.stage) ? (
                  <>
                    {row.stage === 'flatSelect' && (
                      <div className="flex items-center gap-2 mb-1">
                        <label className="text-sm text-slate-600 w-28 shrink-0">segment</label>
                        <input
                          value={row.args.segmentSelector ?? row.args.selector ?? ''}
                          onChange={(e) => setArg(idx, 'segmentSelector', e.target.value)}
                          placeholder="segment CSS selector"
                          className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                        />
                      </div>
                    )}
                    <div className="flex items-center gap-2 mb-1">
                      <button
                        onClick={() => setPickerFor(idx)}
                        className="text-sm px-2 py-1 rounded border border-blue-200 text-blue-700 hover:bg-blue-50">
                        🎯 Pick visually
                      </button>
                      {(() => {
                        const fr = pipeline[fetchRowIndexFor(idx)];
                        return (
                          <>
                            {fr?._requires_hitl && (
                              <span className="text-xs px-1 rounded bg-amber-100 text-amber-700"
                                title={fr._anti_bot_kind || 'anti-bot'}>requires HITL</span>
                            )}
                            {fr?._trace?.length ? (
                              <span className="text-xs px-1 rounded bg-slate-100 text-slate-500">
                                {fr._trace.length} action{fr._trace.length > 1 ? 's' : ''}
                              </span>
                            ) : null}
                          </>
                        );
                      })()}
                    </div>
                    <FieldEditor row={row} onChange={(f) => setFields(idx, f)} />
                  </>
                ) : args.length > 0 ? (
                  <div className="space-y-1">
                    {args.map((n) => (
                      <div key={n} className="flex items-center gap-2">
                        <label className="text-sm text-slate-600 w-28 shrink-0">{n}</label>
                        <input
                          value={row.args[n] ?? ''}
                          onChange={(e) => setArg(idx, n, e.target.value)}
                          className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
                        />
                      </div>
                    ))}
                  </div>
                ) : row.stage === 'oddsSelect' || row.stage === 'odds_select' ? (
                  <>
                    <button
                      onClick={() => setPickerFor(idx)}
                      className="mb-1 text-sm px-2 py-1 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50">
                      🎯 Pick market box
                    </button>
                    <OddsMarketsEditor row={row} onChange={(m) => setMarkets(idx, m)} />
                  </>
                ) : (
                  <p className="text-xs text-slate-400">no args</p>
                )}

                {FETCH_STAGES.has(row.stage) && (
                  <div className="mt-2 flex items-center gap-2 border-t border-slate-100 pt-2">
                    <button
                      onClick={() => setPickerFor(idx)}
                      title={urlOfRow(row) ? 'Apri la pagina e registra i passaggi' : 'Serve prima un url in questa riga'}
                      disabled={!urlOfRow(row)}
                      className="text-sm px-2 py-1 rounded border border-purple-200 text-purple-700 hover:bg-purple-50 disabled:opacity-40">
                      🎬 Registra azioni
                    </button>
                    {row._trace?.length ? (
                      <>
                        <span className="text-xs px-1 rounded bg-slate-100 text-slate-500">
                          {row._trace.length} azion{row._trace.length > 1 ? 'i' : 'e'} registrat{row._trace.length > 1 ? 'e' : 'a'}
                        </span>
                        <button
                          onClick={() => setPipeline((prev) => prev.map((r, i) => (i === idx ? { ...r, _trace: undefined } : r)))}
                          className="text-xs text-slate-400 hover:text-red-600">
                          svuota
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-slate-400">
                        cookie, ricerche, “carica altro”: i passaggi prima dei dati
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="block text-xs text-slate-500 mb-0.5">Runtime</label>
            <select value={runtime} onChange={(e) => setRuntime(e.target.value as WizRuntime)}
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm">
              <option value="spark">Spark</option>
              <option value="ray_actor">Ray actor</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-0.5">Geo (2-letter)</label>
            <input value={geo} onChange={(e) => setGeo(e.target.value)} placeholder="e.g. de"
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm" />
          </div>
        </div>

        <details className="mb-3">
          <summary className="text-xs text-slate-500 cursor-pointer">Python extensions ({pyExts.length})</summary>
          <div className="mt-2">
            <PythonExtensionsEditor exts={pyExts} onChange={setPyExts} />
          </div>
        </details>

        <label className="block text-xs text-slate-500 mb-0.5">YAML preview</label>
        <pre className="max-h-64 overflow-auto rounded bg-slate-900 text-slate-100 text-xs p-3 mb-3 whitespace-pre-wrap">
          {yaml}
        </pre>

        {/* Standalone persistence chrome — hidden when the host form owns saving. */}
        {!embedded && (
          <>
            <div className="flex items-center gap-2 mb-2">
              <input
                value={pipelineName}
                onChange={(e) => setPipelineName(e.target.value)}
                placeholder="pipeline name"
                className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
              {/* Assegnazione a un'altra organizzazione: serve a chi configura per conto di un
                  cliente. L'autorizzazione resta del server (canAccessOrganization): questo
                  selettore e' una comodita', non il controllo. */}
              {organizations && organizations.length > 1 && (
                <select
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                  title="Organization this pipeline belongs to"
                  className="rounded border border-slate-300 px-2 py-1.5 text-sm max-w-[220px]"
                >
                  <option value="">My organization</option>
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              )}
              <button onClick={handleValidate}
                className="text-sm px-2 py-1.5 rounded border border-slate-200 hover:bg-slate-50">
                Validate
              </button>
            </div>
            {validation && <p className="text-sm text-slate-500 mb-2">{validation}</p>}

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
            {saveMsg && <p className="text-sm text-slate-600 mt-2">{saveMsg}</p>}
          </>
        )}
      </section>

      {pickerFor !== null && pipeline[pickerFor] && (() => {
        const pIdx = pickerFor;
        const row = pipeline[pIdx];
        return (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-stretch">
            <div className="m-auto h-[92vh] w-[96vw] max-w-[1400px] rounded-lg bg-white shadow-2xl overflow-hidden">
              <SelectorPicker
                initialUrl={sourceUrlFor(pIdx)}
                geo={geo || undefined}
                mode={pickerModeFor(row)}
                containerSelector={row.args?.segmentSelector || row.args?.selector || null}
                restoreFields={(row._fields || []).map(pfToPickField)}
                // Multi-field accumulation → the row's _fields (what the YAML serializer reads).
                // In registrazione azioni la riga e' un fetch: non ha campi, e scriverglieli
                // lascerebbe uno stato che il serializzatore ignora e l'utente non vede.
                onFieldsChange={(fields: PickField[]) => {
                  if (FETCH_STAGES.has(pipeline[pIdx]?.stage)) return;
                  setFields(pIdx, fields.map(pickFieldToPF));
                }}
                // Single/list/row-lca pick → append one field.
                onPick={(r: PickResult) => {
                  if (FETCH_STAGES.has(pipeline[pIdx]?.stage)) return;
                  setFields(pIdx, [
                    ...(pipeline[pIdx]._fields || []),
                    { selector: r.selector, as: `field_${(pipeline[pIdx]._fields?.length || 0) + 1}`, method: 'text' },
                  ]);
                }}
                // oddsSelect market box → append a market keyed on its section selector.
                onMarketBox={(m: MarketBoxPick) =>
                  setMarkets(pIdx, [
                    ...(pipeline[pIdx]._markets || []),
                    { label: `market_${(pipeline[pIdx]._markets?.length || 0) + 1}`, enabled: true, sectionSelector: m.selector },
                  ])}
                // Macro/content box → seed a flatSelect segment when unset, else record as a hint.
                onMacroBox={(m: MacroBoxPick | null) => {
                  if (!m) return;
                  if (row.stage === 'flatSelect' && !row.args?.segmentSelector) {
                    setArg(pIdx, 'segmentSelector', m.selector);
                  } else {
                    setArg(pIdx, 'macroSelector', m.selector);
                  }
                }}
                // Anti-bot inside the mirror → tag the FETCH row so the YAML emits requires_hitl.
                onAntiBot={(reason: string) =>
                  patchRow(fetchRowIndexFor(pIdx), { _requires_hitl: true, _anti_bot_kind: reason })}
                // Recorded navigation actions → the FETCH row's _trace (Click/Type/Scroll/Wait).
                onActionsCommitted={(actions: PickerAction[]) =>
                  patchRow(fetchRowIndexFor(pIdx), {
                    _trace: actions
                      .filter((a) => ['Click', 'Type', 'Scroll', 'Wait'].includes(a.type))
                      .map((a) => ({
                        type: a.type as TraceAction['type'],
                        selector: a.selector, text: a.text, ms: a.ms,
                      })),
                  })}
                // Long-text body suggestion → append it as a content field.
                onBodySuggestion={(s) =>
                  setFields(pIdx, [
                    ...(pipeline[pIdx]._fields || []),
                    { selector: s.selector, as: 'content', method: s.method === 'boilerPipe' ? 'boilerPipe' : 'text' },
                  ])}
                onClose={() => setPickerFor(null)}
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
