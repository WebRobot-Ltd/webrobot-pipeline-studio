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
 * live click-to-pick picker, CMF preview) lives in the SelectorPicker component and is wired
 * per-row here and in FieldEditor — it plugs into the same wizPipeline rows.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  getStageCatalog,
  listCatalogSites,
  getCatalogRecipe,
  type CatalogSite,
  saveGeneratedPipeline,
  wizardValidate,
  getPipelineDraft,
  putPipelineDraft,
  deletePipelineDraft,
  startDesignerRun,
  listPipelines,
  extractRunError,
  extractLicenceNote,
  extractRecipePatch,
  getAgenticRunLogs,
  cancelAgenticRun,
  parseAgentSteps,
  type AgentStep,
  getAgenticRunStatus,
  getAgenticRunResult,
  extractPipelineYaml,
  extractNeeds,
  extractQuestions,
  TenantStudioError,
  type PipelineDraft,
} from '../client';
import {
  buildYamlFromPipeline,
  parsePipelineFromYaml,
  parseCombineFromYaml,
  parseOutputFromYaml,
  type CombineSpec,
  type OutputSpec,
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
import DataPreview from './DataPreview';
import PipelineGraph from './PipelineGraph';
import SelectorPicker, {
  type PickField,
  type PickResult,
  type PickerAction,
  type MarketBoxPick,
  type MacroBoxPick,
  type PickerMode,
} from './SelectorPicker';

import { lookOf, PHASES, sequenceAdvice, friendlyName, isLoadStage, isSaveStage } from '../stageIdentity';
interface CatalogStage extends StageSpec {
  category?: string;
  description?: string;
}

type TargetSource = number | 'shared';

/** Stages that carry a source URL — used to seed the visual picker's mirror. */
const FETCH_STAGES = new Set(['fetch', 'visit', 'wget']);
const JOIN_STAGES = ['resilientJoin', 'wgetJoin', 'visitJoin', 'join'];
// Branch / set-op primitives: how sources are put together is chosen on the merge node (combine:),
// so they are not offered in the catalogue (still valid in a hand-written YAML).
const SET_OP_STAGES = new Set(['union_with', 'union_branches', 'unionByName', 'union_by_name', 'intersectByName',
  'intersect_by_name', 'exceptByName', 'except_by_name', 'joinWithByName', 'join_with_by_name', 'store', 'reset']);

/**
 * Prompt di esempio per il primo uso: si mostrano SOLO a pipeline vuota, e cliccati riempiono il
 * campo "descrivi". Il nuovo utente che non sa cosa scrivere ha tre partenze concrete davanti,
 * invece del solo placeholder — e capisce che qui si descrive un obiettivo, non si conosce un DSL.
 */
const ESEMPI_DESCRIZIONE = [
  'Product name, price and image from every product page of a shop',
  'Title, date and author of the articles on a news site',
  'Company name, address and phone from a business directory',
];

/**
 * Il run del designer e' un RayJob ASINCRONO: puo' durare piu' dell'attesa inline (4 min) o l'utente
 * puo' chiudere/navigare via mentre lavora. Per non perdere la proposta si ricorda l'executionId in
 * localStorage (per contesto) e al montaggio lo si riprende — sia ancora in corso, sia gia' finito.
 * Solo il run che HAI avviato: e' nel tuo browser. Tutto in try/catch: in modalita' privata o con
 * lo storage bloccato si prosegue senza ripresa, non si rompe nulla.
 */
const RUN_KEY = (ctx: string) => `wr_designer_run:${ctx}`;
const RUN_MAX_AGE_MS = 30 * 60 * 1000; // oltre mezz'ora un run pendente e' stantio: si scarta

interface RunSalvato { executionId: string; prompt: string; startedAt: number; }

function leggiRun(ctx: string): RunSalvato | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RUN_KEY(ctx)) : null;
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v.executionId === 'string' ? (v as RunSalvato) : null;
  } catch { return null; }
}
function salvaRun(ctx: string, v: RunSalvato): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(RUN_KEY(ctx), JSON.stringify(v)); }
  catch { /* private mode / quota: si prosegue senza ripresa */ }
}
function scartaRun(ctx: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(RUN_KEY(ctx)); }
  catch { /* ignore */ }
}

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
  links,
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
  /**
   * Where the host shows an agent, a job and the project creation (hrefs). Optional: without them the
   * post-save panel says what happened but has no links. The package doesn't know the host's routes.
   */
  links?: {
    agent?: (agentId: string | number) => string;
    job?: (jobId: string | number, projectId?: string | number) => string;
    newProject?: (agentId: string | number) => string;
  };
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
  // Outcome of the last save / run, shown as a panel with links (user 10-25: "no feedback that the
  // Spark job started", "after saving, take me to the agent").
  const [saved, setSaved] = useState<{
    agentId: string; agentName: string;
    run?: { executionId?: string; jobId?: string; projectId?: string; error?: string };
  } | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [validateResult, setValidateResult] = useState<any>(null);
  const [bottomTab, setBottomTab] = useState<'data' | 'yaml' | 'steps'>('data');
  // Two definition modes over the SAME rows (10-23): the list, and the graph (lanes per source → shared tail).
  const [viewMode, setViewMode] = useState<'list' | 'graph'>('list');
  const [graphSel, setGraphSel] = useState<number | null>(null);
  const [graphFull, setGraphFull] = useState(false);
  // How the sources are combined at the merge point (multi-source): union by default (engine-side).
  const [combine, setCombine] = useState<CombineSpec | null>(null);
  const [mergeSel, setMergeSel] = useState(false);
  // final dataset written by the run (`output:`); null = parquet · overwrite
  const [output, setOutput] = useState<OutputSpec | null>(null);
  const [saveSel, setSaveSel] = useState(false);   // graph: the save node is selected → output form
  // node positions dragged in the graph: shared by the inline and the full-screen canvas (kept while the page is open)
  const [graphPos, setGraphPos] = useState<Record<string, { x: number; y: number }>>({});   // graph: the merge node is selected → combine form
  const [paletteOpen, setPaletteOpen] = useState(true);   // full-screen graph: stage palette on the left, collapsible
  const [listLane, setListLane] = useState<number | 'shared' | 'all'>(1);   // list mode: which branch is shown
  useEffect(() => {
    if (!graphFull) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setGraphFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [graphFull]);
  // The designer agent's steps, LIVE while it works (redesign 10-23, after Kadoa), and the run to stop.
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [liveEid, setLiveEid] = useState<string | null>(null);
  const followLogs = useCallback(async (eid: string) => {
    const lg = await getAgenticRunLogs(eid).catch(() => null);
    if (lg?.logs) setAgentSteps(parseAgentSteps(lg.logs));
  }, []);
  const stopAgent = useCallback(async () => {
    if (!liveEid) return;
    try { await cancelAgenticRun(liveEid); } catch { /* the poll sees the final state */ }
    setAskPhase('Stopping the agent…');
  }, [liveEid]);
  // "Save to": a NEW agent (named here) or an EXISTING agent of the org — the designer pipeline becomes
  // that agent's pipeline (user 10-23: starting from the designer, the pipeline must go to the agent).
  const [saveTarget, setSaveTarget] = useState<string>('');
  const [agentsList, setAgentsList] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    listPipelines().then((r: any) => {
      const demos: any[] = Array.isArray(r) ? r : (r?.demos || []);
      const seen = new Set<string>();
      setAgentsList(demos.filter((d) => d?.agent_id != null && !seen.has(String(d.agent_id)) && seen.add(String(d.agent_id)))
        .map((d) => ({ id: String(d.agent_id), name: String(d.agent_name || d.display_name || d.pipeline_name) }))
        .sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => setAgentsList([]));
  }, []);

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

  /** Move a stage to another lane (a source's branch or 'shared'); rows stay grouped by lane. */
  const setLane = (idx: number, lane: TargetSource) => {
    const order = pipeline.map((r, i) => ({ r: i === idx ? { ...r, _src: lane } : r, i }))
      .sort((x, y) => srcKey(x.r) - srcKey(y.r) || x.i - y.i);
    setPipeline(order.map((x) => x.r));
    if (graphSel === idx) setGraphSel(order.findIndex((x) => x.i === idx));   // keep the moved node selected
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
  // ── URL helper from the source catalogue ─────────────────────────────────────
  // Typing a URL in a fetch row suggests the catalogue's sites; picking one builds the rest of the
  // lane from the recipe the auto-setup validated — the person then checks and edits every stage
  // (🎯 Pick visually, dry run) instead of inducing selectors from scratch:
  //   detail fields in the recipe → fetch → resilientJoin(detail link) → extract(detail fields)
  //   otherwise                   → fetch → flatSelect(segment, listing fields)
  // Following links is a JOIN, never flatSelect + wget/extract (ETL rule 10-06): after a flatSelect
  // the page is gone. resilientJoin tries wget first and falls back to the browser per link.
  const [catalogSites, setCatalogSites] = useState<CatalogSite[] | null>(null);
  const [recipeNote, setRecipeNote] = useState<Record<number, string>>({});
  const [recipeSearch, setRecipeSearch] = useState<Record<number, { template: string; q: string }>>({});
  const [recipeDetail, setRecipeDetail] = useState<Record<number, string>>({});   // fetch idx → detail link selector
  const loadCatalogSites = () => {
    if (catalogSites) return;
    setCatalogSites([]);
    listCatalogSites().then(setCatalogSites).catch(() => setCatalogSites([]));
  };
  // Join args by stage: resilientJoin takes linkSelector, wgetJoin/visitJoin selector + joinType.
  const joinArgs = (stage: string, linkSel: string, prev: Record<string, any> = {}) =>
    stage === 'resilientJoin'
      ? { ...prev, linkSelector: linkSel }
      : { ...prev, selector: linkSel, joinType: prev.joinType || 'LeftOuter' };
  /** Turn the flatSelect at `f` into resilientJoin(item link) + extract: the item pages get opened and
   *  read, instead of an extract after a flatSelect that has no page left to read. */
  const flatSelectToJoin = (f: number, linkSel?: string) => {
    setPipeline((prev) => {
      const r = prev[f];
      if (!r || r.stage !== 'flatSelect') return prev;
      const seg = r.args?.segmentSelector || r.args?.selector || '';
      const link = linkSel || (seg ? `${seg} a` : 'a');
      const next = [...prev];
      next[f] = { stage: 'resilientJoin', args: { linkSelector: link }, _src: r._src } as PipelineRow;
      const after = next[f + 1];
      if (!(after && after._src === r._src && after.stage === 'extract'))
        next.splice(f + 1, 0, { stage: 'extract', args: {}, _src: r._src, _fields: [] } as PipelineRow);
      return next;
    });
  };
  const toPF = (fs?: { selector: string; as?: string; method?: string }[]): PipelineField[] =>
    (fs || []).filter((f) => f?.selector).map((f) => ({ selector: f.selector, as: f.as, method: f.method || 'text' }));
  const applyCatalogSite = async (idx: number, site: CatalogSite) => {
    const full = await getCatalogRecipe(site.domain).catch(() => null);
    const sel = full?.selectors;
    const fetchRow = pipeline[idx];
    const browser = full?.fetch_method === 'browser';
    const notes: string[] = [];
    if (full?.legal_status === 'licence') notes.push('⚠ Its terms restrict automated collection: you need a licence to use this data.');
    if (browser && fetchRow?.stage !== 'visit') notes.push('The catalogue fetches this site with a browser: consider switching this row to visit.');
    const tpl = sel?.search?.url_template;
    setRecipeSearch((m) => {
      const n = { ...m };
      if (tpl && tpl.includes('{q}')) n[idx] = { template: tpl, q: '' }; else delete n[idx];
      return n;
    });
    if (!sel?.segment && !sel?.fields?.length && !sel?.detail_fields?.length) {
      setRecipeNote((m) => ({ ...m, [idx]: ['No extraction recipe in the catalogue for this site yet — pick the fields visually.', ...notes].join(' ') }));
      return;
    }
    const listing = toPF(sel.fields);
    const detail = toPF(sel.detail_fields);
    const link = sel.detail_link?.selector;
    const useDetail = detail.length > 0 && !!link;
    const joinStage = 'resilientJoin';
    setPipeline((prev) => {
      const src = prev[idx]?._src;
      const next = [...prev];
      // reuse the row right after the cursor when it is already the wanted stage, else insert one
      const ensureAt = (pos: number, stages: string[], make: PipelineRow): number => {
        const r = next[pos];
        if (r && r._src === src && stages.includes(r.stage)) return pos;
        next.splice(pos, 0, make);
        return pos;
      };
      if (useDetail) {
        const linkSel = sel.segment && !link.startsWith('$') ? `${sel.segment} ${link}` : link;
        const j = ensureAt(idx + 1, JOIN_STAGES, { stage: joinStage, args: {}, _src: src } as PipelineRow);
        next[j] = { ...next[j], args: joinArgs(next[j].stage, linkSel, next[j].args) };
        const k = ensureAt(j + 1, ['extract'], { stage: 'extract', args: {}, _src: src } as PipelineRow);
        next[k] = { ...next[k], _fields: detail };
      } else {
        const j = ensureAt(idx + 1, ['flatSelect'], { stage: 'flatSelect', args: {}, _src: src } as PipelineRow);
        next[j] = { ...next[j], args: { ...next[j].args, segmentSelector: sel.segment || next[j].args.segmentSelector || '' }, _fields: listing };
      }
      return next;
    });
    setRecipeDetail((m) => {
      const n = { ...m };
      if (!useDetail && link) n[idx] = sel.segment && !link.startsWith('$') ? `${sel.segment} ${link}` : link; else delete n[idx];
      return n;
    });
    const when = sel.validated_at ? ` (validated ${sel.validated_at})` : '';
    const what = useDetail
      ? `follows each item's link with ${joinStage} and extracts ${detail.length} detail field${detail.length === 1 ? '' : 's'}`
      : `extracts ${listing.length} field${listing.length === 1 ? '' : 's'} from each item of the list`;
    const pag = sel.pagination && (sel.pagination.note || sel.pagination.selector)
      ? ` Pagination: ${sel.pagination.note || sel.pagination.selector} — add the next pages' URLs if you need more than the first page.` : '';
    setRecipeNote((m) => ({ ...m, [idx]: [`Recipe from the catalogue${when}: the pipeline now ${what}. Every stage stays editable — check them with 🎯 Pick visually or a dry run.${pag}`, ...notes].join(' ') }));
  };

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
    const matched = catalog.filter((s) => !/^(load|save)_/.test(s.stage_name) && !SET_OP_STAGES.has(s.stage_name)).filter(
      (s) => !q || s.stage_name.toLowerCase().includes(q) || friendlyName(s.stage_name).toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));
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
      combine,
      output,
    }),
    [pipeline, catalog, runtime, geo, pyExts, combine, output]);

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
  // The pipeline drafted on the canvas goes to the agent as context (current_yaml) ONLY with this flag,
  // shown next to Propose when there is a draft: on = the agent extends it, off = it starts from scratch.
  const [useDraftCtx, setUseDraftCtx] = useState(true);
  const [askErr, setAskErr] = useState<string | null>(null);
  // A che punto e' il run: un'attesa di decine di secondi senza notizie sembra un guasto.
  const [askPhase, setAskPhase] = useState<string | null>(null);
  // updated_at dell'ultima bozza SCARTATA: senza, il ciclo la riproporrebbe tre secondi dopo.
  const dismissed = useRef<string | null>(null);

  // Wizard guidato "2 round" (canale A, senza chat): round 1 l'agente fa 2-4 domande, l'utente
  // risponde in un mini-form, round 2 l'agente progetta. Per il meno esperto che non sa descrivere.
  const [guidedQuestions, setGuidedQuestions] = useState<string[] | null>(null);
  const [guidedAnswers, setGuidedAnswers] = useState<string[]>([]);
  const [guidedPrompt, setGuidedPrompt] = useState('');

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const d = await getPipelineDraft(draftContext);
      if (!alive) return;
      // An empty server means "no CHAT draft": it must not wipe a proposal from a designer run, which
      // lives only in the page (10-23: the Farmaè proposal appeared and vanished 4 s later).
      if (!d) { setDraft((prev) => (prev && prev.source === 'agent' ? prev : null)); return; }
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
    const rows = parsePipelineFromYaml(draft.pipeline_yaml, { catalog });
    setCombine(parseCombineFromYaml(draft.pipeline_yaml));
    setOutput(parseOutputFromYaml(draft.pipeline_yaml));
    // Uno YAML che non si riesce a leggere non deve svuotare il canvas ne' bruciare la bozza:
    // si lascia la proposta li' (il diff mostra lo YAML) e si dice perche'.
    if (!rows.length) {
      setAskErr('The proposal could not be loaded into the canvas (no stages recognised in its YAML).');
      setDraftOpen(true);
      return;
    }
    setPipeline(rows);
    if (draft.pipeline_name && !pipelineName.trim()) setPipelineName(draft.pipeline_name);
    setDraftOpen(false);
    setDraft(null);
    // Consumata: si cancella, altrimenti resta in attesa e ricompare al prossimo giro.
    try { await deletePipelineDraft(draftContext); } catch { /* la proposta e' gia' applicata */ }
  }, [draft, draftContext, pipelineName, catalog]);

  const dismissDraft = useCallback(async () => {
    dismissed.current = draft?.updated_at || null;
    setDraftOpen(false);
    setDraft(null);
    try { await deletePipelineDraft(draftContext); } catch { /* verra' sovrascritta */ }
  }, [draft, draftContext]);

  /**
   * Campo testuale: una riga di descrizione, e la pipeline la progetta l'AGENTE di sistema.
   *
   * Non un'inferenza singola. Quella strada esiste ancora nell'API, ha il vocabolario degli stage
   * scritto a mano dentro il prompt — quindi cita stage che non esistono — e l'unico controllo sul
   * suo esito e' che lo YAML si parsi. L'agente invece legge il catalogo vivo, APRE il sito, induce
   * i selettori e li verifica con una prova a vuoto prima di consegnare. Costa decine di secondi
   * invece di pochi, e quel tempo si mostra: il pulsante dice a che punto e'.
   *
   * Il risultato passa dalla stessa bozza della chat, quindi il percorso di revisione e' identico —
   * si vede il diff e si decide. Un canale solo, due modi di chiedere.
   */
  /**
   * Segue un run designer fino all'esito e ne propone il risultato. Condiviso fra l'avvio inline
   * (`askForPipeline`) e la RIPRESA al montaggio: stessa attesa + estrazione + proposta, cosi' un
   * run che finisce mentre eravamo via arriva comunque al canvas.
   *
   * Controlla lo stato PRIMA di dormire, cosi' un run gia' completato (ripreso) si propone subito.
   */
  const seguiRun = useCallback(async (eid: string, promptLabel: string) => {
    setGenerating(true);
    setAgentSteps([]); setLiveEid(eid);
    setAskErr(null);
    setAskPhase('The agent is working\u2026');
    try {
      // Tetto sull'attesa INLINE: 4 minuti (il doppio del piu' lento osservato, ~70s col browser).
      // Se scade ma il run e' ancora vivo NON si perde nulla: resta salvato e un mount successivo
      // lo riprende \u2014 e' cio' che lo rende un lavoro di background, non un'operazione bloccante.
      const scadenza = Date.now() + 4 * 60 * 1000;
      let stato = '';
      while (Date.now() < scadenza) {
        const st = await getAgenticRunStatus(eid).catch(() => null);
        stato = String(st?.persistedStatus || st?.status || '');
        if (['COMPLETED', 'FAILED', 'STOPPED', 'CANCELLED'].includes(stato)) break;
        setAskPhase(`The agent is working\u2026 (${stato.toLowerCase() || 'running'})`);
        await followLogs(eid);
        await new Promise((r) => setTimeout(r, 5000));
      }
      await followLogs(eid);
      if (stato !== 'COMPLETED') {
        if (stato === 'FAILED' || stato === 'STOPPED' || stato === 'CANCELLED') {
          setAskErr(`The agent run ended as ${stato}.`);
          scartaRun(draftContext);                       // terminale: niente da riprendere
        } else {
          // Ancora in corso oltre l'attesa inline: si TIENE salvato, e lo si dice.
          setAskErr('The agent is taking a while \u2014 you can leave this page; the proposal will appear here when it finishes.');
        }
        return;
      }
      const result = await getAgenticRunResult(eid);
      const y = extractPipelineYaml(result);
      scartaRun(draftContext);                            // COMPLETED = consumato, in ogni caso
      if (!y) {
        // Un run riuscito senza pipeline utilizzabile NON e' un successo: succede quando l'agente
        // risponde "NEEDS: <domanda>" perche' la descrizione e' troppo vaga. Se c'e' la domanda,
        // la si MOSTRA: dice all'utente cosa chiarire, invece di un generico "descrivi meglio".
        const needs = extractNeeds(result);
        const stopped = extractRunError(result);
        setAskErr(needs
          ? `The agent needs more detail: ${needs}`
          : stopped
            ? `The agent stopped before finishing (${stopped}) \u2014 try again, or describe the site and the fields more concretely.`
            : 'The agent finished without a pipeline \u2014 try describing the site and the fields more concretely.');
        return;
      }
      setDraft({
        context: draftContext,
        pipeline_name: null,
        pipeline_yaml: y,
        note: `Designed by the agent from: \u201c${promptLabel}\u201d \u2014 validated against the stage catalogue`,
        updated_at: new Date().toISOString(),
        licence_note: extractLicenceNote(result), recipe_fix: extractRecipePatch(result), source: 'agent',
      });
      setDraftOpen(true);
      setAskText('');
    } catch (e) {
      setAskErr(e instanceof TenantStudioError ? `agent \u2192 ${e.status}` : 'The agent could not be reached');
    } finally {
      setGenerating(false);
      setAskPhase(null);
    }
  }, [draftContext, followLogs]);

  const askForPipeline = useCallback(async () => {
    const prompt = askText.trim();
    if (!prompt) return;
    setAskErr(null);
    setGenerating(true);
    setAskPhase('Starting the designer agent\u2026');
    let eid: string | undefined;
    try {
      const run = await startDesignerRun(prompt, pipeline.length && useDraftCtx ? yaml : '');
      eid = run?.executionId;
    } catch (e) {
      setAskErr(e instanceof TenantStudioError ? `agent \u2192 ${e.status}` : 'The agent could not be reached');
      setGenerating(false); setAskPhase(null);
      return;
    }
    if (!eid) { setAskErr('The agent did not start.'); setGenerating(false); setAskPhase(null); return; }
    // Si ricorda SUBITO, prima di attendere: se l'utente chiude durante l'attesa, il run non e' perso.
    salvaRun(draftContext, { executionId: eid, prompt, startedAt: Date.now() });
    await seguiRun(eid, prompt);
  }, [askText, draftContext, pipeline, yaml, useDraftCtx, seguiRun]);

  // Per-row result of the last dry run (redesign 10-23, like Lakeflow's row-count badges): the steps are
  // matched to the rows by stage name in order; the extraction rows get the rows and fill rate.
  const rowRun = useMemo(() => {
    if (!validateResult) return null;
    const steps: any[] = Array.isArray(validateResult.steps) ? validateResult.steps : [];
    const recs: any[] = Array.isArray(validateResult.records) ? validateResult.records : [];
    const used = new Set<number>();
    return pipeline.map((row) => {
      const k = steps.findIndex((st, i) => !used.has(i) && String(st?.stage || '') === row.stage);
      if (k >= 0) used.add(k);
      const st = k >= 0 ? steps[k] : null;
      let fill: number | null = null;
      if (['flatSelect', 'extract'].includes(row.stage) && recs.length && Array.isArray(row._fields) && row._fields.length) {
        const names = row._fields.map((f: any) => f.as).filter(Boolean);
        const cells = recs.length * names.length;
        const ok = recs.reduce((n, r) => n + names.filter((nm: string) => r?.[nm] != null && String(r[nm]).trim() !== '').length, 0);
        fill = cells ? Math.round((100 * ok) / cells) : null;
      }
      return { status: st ? String(st.status || '') : null, message: st?.message ? String(st.message) : '', fill, rows: fill != null ? recs.length : null };
    });
  }, [validateResult, pipeline]);

  // "Fix with AI" on a stage that failed in the dry run (redesign 10-23, after Lakeflow's Fix button): the
  // agent gets the CURRENT pipeline and is asked to repair that stage only — the result comes back as the
  // usual proposal with its diff.
  const fixStageWithAI = useCallback(async (idx: number) => {
    const row = pipeline[idx];
    if (!row) return;
    const why = rowRun?.[idx]?.message || validateResult?.error || 'it produced no rows';
    const prompt = `Fix stage ${idx + 1} (${row.stage}) of this pipeline: in the dry run it failed — ${why}. `
      + 'Keep every other stage as it is and change only what is needed to make this one work; validate again.';
    setAskErr(null); setGenerating(true); setAskPhase(`Asking the agent to fix stage ${idx + 1}\u2026`);
    let eid: string | undefined;
    try { eid = (await startDesignerRun(prompt, yaml))?.executionId; }
    catch (e) {
      setAskErr(e instanceof TenantStudioError ? `agent \u2192 ${e.status}` : 'The agent could not be reached');
      setGenerating(false); setAskPhase(null); return;
    }
    if (!eid) { setAskErr('The agent did not start.'); setGenerating(false); setAskPhase(null); return; }
    salvaRun(draftContext, { executionId: eid, prompt, startedAt: Date.now() });
    await seguiRun(eid, `fix stage ${idx + 1}`);
  }, [pipeline, rowRun, validateResult, yaml, draftContext, seguiRun]);

  // \u2500\u2500 Wizard guidato "2 round" (canale A) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Attende un run fino all'esito e ne torna il result grezzo (o null, gestendo gia' l'errore).
  // Non salva/riprende come seguiRun: il guidato e' interattivo, l'utente e' qui.
  const pollUntilResult = useCallback(async (eid: string): Promise<any | null> => {
    setAgentSteps([]); setLiveEid(eid);
    const scadenza = Date.now() + 4 * 60 * 1000;
    let stato = '';
    while (Date.now() < scadenza) {
      const st = await getAgenticRunStatus(eid).catch(() => null);
      stato = String(st?.persistedStatus || st?.status || '');
      if (['COMPLETED', 'FAILED', 'STOPPED', 'CANCELLED'].includes(stato)) break;
      setAskPhase(`The agent is working\u2026 (${stato.toLowerCase() || 'running'})`);
      await followLogs(eid);
      await new Promise((r) => setTimeout(r, 5000));
    }
    await followLogs(eid);
    if (stato !== 'COMPLETED') {
      setAskErr(stato === 'FAILED' || stato === 'STOPPED' || stato === 'CANCELLED'
        ? `The agent run ended as ${stato}.`
        : 'The agent is taking a while \u2014 try again in a moment.');
      return null;
    }
    return await getAgenticRunResult(eid);
  }, [followLogs]);

  // ROUND 1: l'agente non progetta, chiede. Se invece ha gia' progettato (result e' una pipeline),
  // si salta al canvas: il guidato non deve intralciare quando la descrizione bastava.
  const startGuided = useCallback(async () => {
    const prompt = askText.trim();
    if (!prompt) return;
    setAskErr(null); setGuidedQuestions(null); setGenerating(true);
    setAskPhase('Thinking of what to ask you\u2026');
    try {
      const goal =
        'GUIDED SETUP \u2014 STEP 1 of 2. Do NOT design a pipeline yet. Return ONLY a JSON array of 2 to 4 '
        + 'short, plain-language questions whose answers you need to design a WebRobot ETL pipeline for '
        + 'this request. No YAML, no prose \u2014 just the JSON array of strings.\n\nRequest: ' + prompt;
      const run = await startDesignerRun(goal, pipeline.length && useDraftCtx ? yaml : '');
      const eid = run?.executionId;
      if (!eid) { setAskErr('The agent did not start.'); return; }
      const result = await pollUntilResult(eid);
      if (result == null) return;
      const qs = extractQuestions(result);
      const y = extractPipelineYaml(result);
      if ((!qs || qs.length === 0) && y) {
        setDraft({ context: draftContext, pipeline_name: null, pipeline_yaml: y, licence_note: extractLicenceNote(result), recipe_fix: extractRecipePatch(result), source: 'agent',
          note: `Designed by the agent from: \u201c${prompt}\u201d`, updated_at: new Date().toISOString() });
        setDraftOpen(true); return;
      }
      if (!qs || qs.length === 0) {
        setAskErr('The agent did not return questions \u2014 try \u201cPropose\u201d instead.'); return;
      }
      setGuidedPrompt(prompt);
      setGuidedQuestions(qs);
      setGuidedAnswers(qs.map(() => ''));
    } catch (e) {
      setAskErr(e instanceof TenantStudioError ? `agent \u2192 ${e.status}` : 'The agent could not be reached');
    } finally {
      setGenerating(false); setAskPhase(null);
    }
  }, [askText, pipeline, yaml, useDraftCtx, draftContext, pollUntilResult]);

  // ROUND 2: con le risposte, l'agente progetta \u2014 stessa proposta/diff/apply del canale A.
  const submitGuided = useCallback(async () => {
    if (!guidedQuestions) return;
    setAskErr(null); setGenerating(true); setAskPhase('Designing from your answers\u2026');
    try {
      const qa = guidedQuestions
        .map((q, i) => `Q: ${q}\nA: ${(guidedAnswers[i] || '').trim() || '(no answer)'}`)
        .join('\n\n');
      const goal =
        'GUIDED SETUP \u2014 STEP 2 of 2. Now design the WebRobot ETL pipeline. Here is the request and the '
        + "person's answers.\n\nRequest: " + guidedPrompt + '\n\n' + qa;
      const run = await startDesignerRun(goal, pipeline.length && useDraftCtx ? yaml : '');
      const eid = run?.executionId;
      if (!eid) { setAskErr('The agent did not start.'); return; }
      const result = await pollUntilResult(eid);
      if (result == null) return;
      const y = extractPipelineYaml(result);
      if (!y) {
        const needs = extractNeeds(result);
        const stopped = extractRunError(result);
        setAskErr(needs ? `The agent needs more detail: ${needs}`
          : stopped ? `The agent stopped before finishing (${stopped}) \u2014 try again.`
          : 'The agent finished without a pipeline \u2014 try rephrasing your answers.');
        return;
      }
      setDraft({ context: draftContext, pipeline_name: null, pipeline_yaml: y, licence_note: extractLicenceNote(result), recipe_fix: extractRecipePatch(result), source: 'agent',
        note: 'Designed from your guided answers', updated_at: new Date().toISOString() });
      setDraftOpen(true);
      setGuidedQuestions(null); setAskText('');
    } catch (e) {
      setAskErr(e instanceof TenantStudioError ? `agent \u2192 ${e.status}` : 'The agent could not be reached');
    } finally {
      setGenerating(false); setAskPhase(null);
    }
  }, [guidedQuestions, guidedAnswers, guidedPrompt, pipeline, yaml, useDraftCtx, draftContext, pollUntilResult]);

  // RIPRESA al montaggio: se c'e' un run designer salvato e recente, lo si riprende \u2014 ancora in
  // corso o gia' finito mentre eravamo via. Il ref evita di rilanciare la ripresa a ogni render.
  const seguiRunRef = useRef(seguiRun);
  seguiRunRef.current = seguiRun;
  useEffect(() => {
    if (embedded) return;                                 // i run si avviano solo dal designer pieno
    const stored = leggiRun(draftContext);
    if (!stored) return;
    if (Date.now() - stored.startedAt > RUN_MAX_AGE_MS) { scartaRun(draftContext); return; }
    setAskText((t) => t || stored.prompt);                // mostra cosa era stato chiesto
    seguiRunRef.current(stored.executionId, stored.prompt);
  }, [draftContext, embedded]);

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
    setPipeline(parsePipelineFromYaml(incoming, { catalog }));
    setCombine(parseCombineFromYaml(incoming));
    setOutput(parseOutputFromYaml(incoming));
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

  /** extract rows that come after a flatSelect in the same lane with no join in between: they have no
   *  page to read (the flatSelect consumed it). Index of the offending flatSelect, per lane. */
  const flatExtractIssues = useMemo(() => {
    const out: number[] = [];
    const lastFlat = new Map<string, number>();
    pipeline.forEach((r, i) => {
      const lane = String(r._src ?? 1);
      if (FETCH_STAGES.has(r.stage) || JOIN_STAGES.includes(r.stage)) lastFlat.delete(lane);
      else if (r.stage === 'flatSelect') lastFlat.set(lane, i);
      else if (r.stage === 'extract' && lastFlat.has(lane)) { out.push(lastFlat.get(lane)!); lastFlat.delete(lane); }
    });
    return out;
  }, [pipeline]);

  const handleValidate = async () => {
    setBottomTab('data');
    setValidation('Running the pipeline on the real site (dry run)…');
    try {
      setValidateResult(null);
      const r = await wizardValidate({ yaml });
      setValidateResult(r);
      setValidation(null);
    } catch (e) {
      setValidation(e instanceof TenantStudioError ? `validate → ${e.status}` : 'validation failed');
    }
  };

  const handleSave = async (execute: boolean) => {
    if (!saveTarget && !pipelineName.trim()) { setSaveMsg('Name the new agent first.'); return; }
    setSaving(true);
    setSaveMsg(null);
    try {
      const res: any = await saveGeneratedPipeline({
        ...(saveTarget ? { agent_id: Number(saveTarget) } : { pipeline_name: pipelineName.trim() }),
        pipeline_yaml: yaml,
        execute,
        // Omesso quando non scelto: il server ricade sull'organizzazione del chiamante.
        ...(orgId ? { organization_id: orgId } : {}),
      });
      const agentId = String(res?.agent_id ?? saveTarget ?? '');
      const agentName = saveTarget ? (agentsList.find((a) => a.id === saveTarget)?.name || `agent ${saveTarget}`) : pipelineName.trim();
      // From now on this page edits THAT agent: the next Save updates it instead of creating another one.
      if (agentId && !saveTarget) {
        setAgentsList((l) => (l.some((a) => a.id === agentId) ? l : [...l, { id: agentId, name: agentName }]));
        setSaveTarget(agentId);
      }
      const ex = res?.execution;
      setSaved({
        agentId, agentName,
        run: execute ? {
          executionId: ex?.execution_id || ex?.executionId || ex?.id,
          jobId: res?.job_id != null ? String(res.job_id) : undefined,
          projectId: res?.project_id != null ? String(res.project_id) : undefined,
          error: res?.execution_error,
        } : undefined,
      });
    } catch (e) {
      setSaveMsg(e instanceof TenantStudioError
        ? (e.status === 402 ? 'Not run: the plan has no credit left for this run.' : e.status === 403 ? 'Not run: this organization cannot start jobs here.' : `Save failed (${e.status})`)
        : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  /** Post-save panel: what was saved, the run (if any), and the next steps with links. */
  const renderSavedPanel = () => {
    if (!saved) return null;
    const a = links?.agent && saved.agentId ? links.agent(saved.agentId) : null;
    const r = saved.run;
    const jobHref = r?.jobId && links?.job ? links.job(r.jobId, r.projectId) : null;
    const projHref = links?.newProject && saved.agentId ? links.newProject(saved.agentId) : null;
    const btn = 'inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm font-semibold';
    return (
      <div className="mt-3 space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-slate-800">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-emerald-800">✓ Saved to agent “{saved.agentName}”</span>
          {a && <a href={a} className={`${btn} border-emerald-300 bg-white text-emerald-900 hover:bg-emerald-100`}>Open the agent →</a>}
          <span className="flex-1" />
          <button type="button" onClick={() => setSaved(null)} className="text-slate-400 hover:text-slate-700" title="Close">✕</button>
        </div>
        <p className="text-slate-600">This page now edits this agent: the next Save updates it. Category, description and execution mode are set on the agent page.</p>
        {r ? (
          r.error ? (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-rose-800">⚠ Saved, but the run did not start: {r.error}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2">
              <span>▶ <b>Spark job submitted</b>{r.executionId ? <> · run <code>{r.executionId}</code></> : null} — it takes a few minutes; the data appears in the job's results.</span>
              {jobHref && <a href={jobHref} className={`${btn} border-brand-300 bg-brand-50 text-brand-900 hover:bg-brand-100`}>Follow the run →</a>}
            </div>
          )
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => handleSave(true)} disabled={saving}
              className={`${btn} border-brand-900 bg-brand-900 text-white hover:bg-brand-950 disabled:opacity-50`}>▶ Run now</button>
            <span className="text-slate-600">starts a Spark job with this pipeline (a few minutes, uses credits).</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-emerald-200 pt-2">
          <span className="text-slate-700">Next: <b>create a project</b> for this agent and attach its input data, to schedule and repeat the runs.</span>
          {projHref && <a href={projHref} className={`${btn} border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}>Create a project →</a>}
        </div>
      </div>
    );
  };

  // One stage card: the list shows them in sequence, graph mode shows the selected one in the
  // inspector next to the canvas (user 10-23: edit the node right there, not down in the list).
  const renderStageCard = (row: PipelineRow, idx: number) => {
      const spec = findSpec(row.stage);
      const args = (spec?.arg_schema || []).map((a) => a.name);
      const look = lookOf(row.stage, spec?.category);
      const iconBtn = 'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm font-semibold shadow-sm transition disabled:opacity-30 disabled:shadow-none';
      return (
        <li key={idx} className={`rounded-xl border border-slate-200 border-l-4 ${look.bar} p-3 bg-white shadow-sm`}>
          <div className="flex items-center gap-3 mb-2.5">
            <span aria-hidden="true"
              className={`relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl leading-none ring-1 ${look.tile}`}>
              {look.icon}
              <span className="absolute -top-1.5 -left-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-800 px-1 text-[11px] font-semibold text-white">
                {idx + 1}
              </span>
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-slate-900">{friendlyName(row.stage)}</span>
                <span className="font-mono text-xs text-slate-500" title="Technical name (as in the YAML)">{row.stage}</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${look.chip}`}>{look.label}</span>
                {!embedded && rowRun?.[idx] && (/fail|error/i.test(rowRun[idx].status || '') || (rowRun[idx].fill != null && (rowRun[idx].fill as number) < 50)) && (
                  <button type="button" onClick={() => fixStageWithAI(idx)} disabled={generating}
                    className="text-xs font-semibold px-2 py-0.5 rounded-full border border-brand-300 bg-brand-50 text-brand-800 hover:bg-brand-100 disabled:opacity-50">
                    ✨ Fix with AI
                  </button>
                )}
                {rowRun?.[idx] && (rowRun[idx].status || rowRun[idx].rows != null) && (() => {
                  const rr = rowRun[idx];
                  const bad = /fail|error/i.test(rr.status || '');
                  return (
                    <span title={rr.message || 'last dry run'}
                      className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${bad ? 'border-rose-300 bg-rose-50 text-rose-800' : rr.fill != null && rr.fill < 80 ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-emerald-300 bg-emerald-50 text-emerald-800'}`}>
                      {bad ? '✕ failed' : rr.rows != null ? `✓ ${rr.rows} rows · fields ${rr.fill}% filled` : '✓ ran'}
                    </span>
                  );
                })()}
                {(
                  // Lane of the stage (always selectable, in list and graph mode: with one source the
                  // person must be able to start a second one from here): one source's own branch, or SHARED = after the sources are merged
                  // (e.g. a sentiment stage that must score the rows of every source together).
                  <select value={row._src === 'shared' ? 'shared' : String(row._src || 1)}
                    onChange={(e) => setLane(idx, e.target.value === 'shared' ? 'shared' : Number(e.target.value))}
                    title="Which branch this stage belongs to — Shared runs once on the merged rows of all sources"
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border ${row._src === 'shared' ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-slate-200 bg-slate-100 text-slate-600'}`}>
                    {Array.from({ length: maxSourceNum() }, (_, k) => k + 1).map((n) => <option key={n} value={n}>Source {n}</option>)}
                    <option value={maxSourceNum() + 1}>+ New source {maxSourceNum() + 1}</option>
                    <option value="shared">Shared (after merge)</option>
                  </select>
                )}
              </div>
              {look.blurb && <p className="text-sm text-slate-500 truncate">{look.blurb}</p>}
            </div>
            <span className="ml-auto flex shrink-0 gap-1">
              <button onClick={() => moveStage(idx, -1)} disabled={idx === 0}
                title="Move up" aria-label="Move up"
                className={`${iconBtn} text-slate-500 hover:bg-slate-100 hover:text-slate-800`}>↑</button>
              <button onClick={() => moveStage(idx, 1)} disabled={idx === pipeline.length - 1}
                title="Move down" aria-label="Move down"
                className={`${iconBtn} text-slate-500 hover:bg-slate-100 hover:text-slate-800`}>↓</button>
              <button onClick={() => removeStage(idx)}
                title="Remove stage" aria-label="Remove stage"
                className={`${iconBtn} text-red-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600`}>✕</button>
            </span>
          </div>
          {(isLoadStage(row.stage) || isSaveStage(row.stage)) && (() => {
            const load = isLoadStage(row.stage);
            const opts = catalog.map((c) => c.stage_name)
              .filter((n) => (load ? isLoadStage(n) && n !== 'wget' : isSaveStage(n)));
            if (!opts.includes(row.stage)) opts.unshift(row.stage);
            return (
              <label className="mb-2 flex items-center gap-2 text-sm">
                <span className="w-28 shrink-0 text-slate-600">{load ? 'Source type' : 'Destination'}</span>
                <select value={row.stage}
                  onChange={(e) => patchRow(idx, { stage: e.target.value, args: {}, _fields: undefined, _trace: undefined })}
                  className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm">
                  {opts.map((n) => <option key={n} value={n}>{friendlyName(n)}</option>)}
                </select>
              </label>
            );
          })()}
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
                  className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg border border-brand-600/30 bg-brand-600/5 text-brand-900 hover:bg-brand-600/10">
                  <span className="text-lg leading-none" aria-hidden="true">🎯</span> Pick visually
                </button>
                {(() => {
                  const fr = pipeline[fetchRowIndexFor(idx)];
                  return (
                    <>
                      {fr?._requires_hitl && (
                        <span className="text-sm px-2 py-0.5 rounded-full bg-amber-100 text-amber-800"
                          title={fr._anti_bot_kind || 'anti-bot'}>requires HITL</span>
                      )}
                      {fr?._trace?.length ? (
                        <span className="text-sm px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                          {fr._trace.length} action{fr._trace.length > 1 ? 's' : ''}
                        </span>
                      ) : null}
                    </>
                  );
                })()}
              </div>
              <FieldEditor row={row} onChange={(f) => setFields(idx, f)} sourceUrl={sourceUrlFor(idx)} />
            </>
          ) : args.length > 0 ? (
            <div className="space-y-1">
              {args.map((n) => {
                // fetch/wget name it `urlExtractor` in the stage catalogue, visit `url`
                const urlArg = FETCH_STAGES.has(row.stage) && /url/i.test(n);
                return (
                <div key={n} className="flex items-center gap-2">
                  <label className="text-sm text-slate-600 w-28 shrink-0">{n}</label>
                  <input
                    value={row.args[n] ?? ''}
                    list={urlArg ? 'wr-catalog-sites' : undefined}
                    placeholder={urlArg ? 'https://… or start typing a site from the catalogue' : undefined}
                    onFocus={urlArg ? loadCatalogSites : undefined}
                    onChange={(e) => {
                      const v = e.target.value;
                      setArg(idx, n, v);
                      if (!urlArg || !catalogSites?.length) return;
                      const hit = catalogSites.find((s) => s.url === v);
                      if (hit) applyCatalogSite(idx, hit);
                    }}
                    className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
                  />
                </div>
                );
              })}
              {recipeNote[idx] && (
                <p className="mt-1 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900">{recipeNote[idx]}</p>
              )}
              {recipeDetail[idx] && (
                <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-brand-100 bg-white px-3 py-2">
                  <span className="text-sm text-slate-600">The catalogue also knows each item's link. Need data from the item pages?</span>
                  <button type="button"
                    onClick={() => {
                      const f = pipeline.findIndex((r, i) => i > idx && r.stage === 'flatSelect' && r._src === row._src);
                      if (f >= 0) flatSelectToJoin(f, recipeDetail[idx]);
                      setRecipeDetail((m) => { const n = { ...m }; delete n[idx]; return n; });
                    }}
                    className="rounded-md border border-brand-300 bg-brand-50 px-2.5 py-1 text-sm font-medium text-brand-800 hover:bg-brand-100">
                    Open each item's page instead
                  </button>
                  <span className="text-xs text-slate-500">→ resilientJoin (wget, browser if it fails) + extract: pick the detail fields visually</span>
                </div>
              )}
              {recipeSearch[idx] && (() => {
                const rs = recipeSearch[idx];
                const urlName = args.find((n) => /url/i.test(n)) || 'url';
                return (
                  <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-brand-100 bg-white px-3 py-2">
                    <span className="text-sm text-slate-600">🔎 Start from the site's search:</span>
                    <input value={rs.q} onChange={(e) => setRecipeSearch((m) => ({ ...m, [idx]: { ...rs, q: e.target.value } }))}
                      placeholder="what to search, e.g. magnesio" className="flex-1 min-w-[160px] rounded border border-slate-300 px-2 py-1 text-sm" />
                    <button type="button" disabled={!rs.q.trim()}
                      onClick={() => setArg(idx, urlName, rs.template.replace('{q}', encodeURIComponent(rs.q.trim())))}
                      className="rounded-md bg-brand-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40">Use search URL</button>
                  </div>
                );
              })()}
            </div>
          ) : row.stage === 'oddsSelect' || row.stage === 'odds_select' ? (
            <>
              <button
                onClick={() => setPickerFor(idx)}
                className="mb-1 inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50">
                <span className="text-lg leading-none" aria-hidden="true">🎯</span> Pick market box
              </button>
              <OddsMarketsEditor row={row} onChange={(m) => setMarkets(idx, m)} />
            </>
          ) : (
            <p className="text-sm text-slate-400">no args</p>
          )}

          {FETCH_STAGES.has(row.stage) && (
            <div className="mt-2 flex items-center gap-2 border-t border-slate-100 pt-2">
              <button
                onClick={() => setPickerFor(idx)}
                title={urlOfRow(row) ? 'Open the page and record the steps' : 'This row needs a URL first'}
                disabled={!urlOfRow(row)}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                <span className="text-lg leading-none" aria-hidden="true">🎬</span> Record actions
              </button>
              {row._trace?.length ? (
                <>
                  <span className="text-sm px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    {row._trace.length} action{row._trace.length > 1 ? 's' : ''} recorded
                  </span>
                  <button
                    onClick={() => setPipeline((prev) => prev.map((r, i) => (i === idx ? { ...r, _trace: undefined } : r)))}
                    className="text-sm text-slate-500 hover:text-red-600">
                    clear
                  </button>
                </>
              ) : (
                <span className="text-sm text-slate-500">
                  cookies, searches, “load more”: the steps before the data
                </span>
              )}
            </div>
          )}
        </li>
      );
  };

  /** Save-node inspector: the dataset every run writes at the end (`output:`). */
  const renderOutputForm = () => {
    const o: OutputSpec = output || { format: 'parquet', mode: 'overwrite' };
    const set = (patch: Partial<OutputSpec>) => {
      const n = { ...o, ...patch };
      setOutput(n.format === 'parquet' && n.mode === 'overwrite' ? null : n);
    };
    const inp = 'w-full rounded border border-slate-300 px-2 py-1.5 text-sm';
    return (
      <div className="space-y-3 p-2">
        <div className="flex items-center">
          <span className="text-sm font-semibold text-slate-700">💾 Result dataset</span>
          <span className="flex-1" />
          <button type="button" onClick={() => setSaveSel(false)} title="Close"
            className="rounded px-1.5 text-sm text-slate-400 hover:bg-slate-200 hover:text-slate-700">✕</button>
        </div>
        <label className="block text-sm text-slate-600">Format
          <select className={inp} value={o.format} onChange={(e) => set({ format: e.target.value as OutputSpec['format'] })}>
            <option value="parquet">Parquet — columnar, fast to query (default)</option>
            <option value="csv">CSV — opens in a spreadsheet</option>
          </select>
        </label>
        <label className="block text-sm text-slate-600">Each run
          <select className={inp} value={o.mode} onChange={(e) => set({ mode: e.target.value as OutputSpec['mode'] })}>
            <option value="overwrite">replaces the previous result (default)</option>
            <option value="append">adds to the previous results</option>
          </select>
        </label>
        <p className="text-xs text-slate-500">
          The run always writes this dataset to the platform storage. To ALSO write somewhere else (a database,
          BigQuery, a file on S3…), add a 💾 Save data stage.
        </p>
      </div>
    );
  };

  /** Short label of the combination for the merge node. */
  const combineLabel = (c: CombineSpec | null) => {
    if (!c || c.type === 'union') return 'union · automatic';
    if (c.type === 'join') return `join on ${c.key || '?'} (${c.how || 'inner'})`;
    return `${c.type} on ${c.key || '?'}`;
  };
  /** Merge-node inspector: how the sources are put together (parser `combine:`). */
  const renderCombineForm = () => {
    const c: CombineSpec = combine || { type: 'union' };
    const set = (patch: Partial<CombineSpec>) => setCombine({ ...c, ...patch });
    const inp = 'w-full rounded border border-slate-300 px-2 py-1.5 text-sm';
    const types: [CombineSpec['type'], string][] = [
      ['union', 'Union — every row of every source'],
      ['intersect', 'Intersect — only items found in every source'],
      ['except', 'Except — items of Source 1 not found in the others'],
      ['join', 'Join — one row per item, a column per source'],
    ];
    return (
      <div className="space-y-3 p-2">
        <div className="flex items-center">
          <span className="text-sm font-semibold text-slate-700">⟹ Combine the sources</span>
          <span className="flex-1" />
          <button type="button" onClick={() => setMergeSel(false)} title="Close"
            className="rounded px-1.5 text-sm text-slate-400 hover:bg-slate-200 hover:text-slate-700">✕</button>
        </div>
        <div className="space-y-1">
          {types.map(([t, l]) => (
            <label key={t} className="flex items-center gap-2 text-sm text-slate-700">
              <input type="radio" name="wr-combine" checked={c.type === t} onChange={() => set({ type: t })} /> {l}
            </label>
          ))}
        </div>
        {c.type !== 'union' && (
          <label className="block text-sm text-slate-600">Key — the column that identifies the same item in every source
            <input className={inp} value={c.key || ''} onChange={(e) => set({ key: e.target.value.trim() })} placeholder="e.g. ean" />
          </label>
        )}
        {c.type === 'intersect' && (
          <label className="block text-sm text-slate-600">Found in at least … sources (empty = all)
            <input type="number" min={1} className={inp} value={c.min_sources ?? ''} onChange={(e) => set({ min_sources: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
        )}
        {c.type === 'join' && (<>
          <label className="block text-sm text-slate-600">Fields to bring from each source (comma-separated)
            <input className={inp} value={(c.fields || []).join(', ')} onChange={(e) => set({ fields: e.target.value.split(',').map((f) => f.trim()).filter(Boolean) })} placeholder="e.g. price, url" />
          </label>
          <label className="block text-sm text-slate-600">Keep
            <select className={inp} value={c.how || 'inner'} onChange={(e) => set({ how: e.target.value as 'inner' | 'left' })}>
              <option value="inner">only items found in every source</option>
              <option value="left">every item of Source 1 (others may be empty)</option>
            </select>
          </label>
        </>)}
        <p className="text-xs text-slate-500">
          {c.type === 'union'
            ? 'Default: the rows of every source are put together, columns matched by name, each tagged with a `source` column.'
            : c.type === 'join'
              ? 'Columns are named <source>_<field>, e.g. source_1_price. The Shared stages then work on one row per item.'
              : 'Runs right after the union, before the Shared stages.'}
          {c.type !== 'union' && !c.key && <b className="block text-amber-700">A key is needed.</b>}
        </p>
      </div>
    );
  };

  // Stage palette for the full-screen graph: the catalogue is hidden behind the modal, so the stages to
  // add are listed right beside the canvas (user 10-23). Same filter and same "Add to" as the catalogue.
  const renderPalette = () => {
    const laneOpts: TargetSource[] = [...Array.from({ length: maxSourceNum() }, (_, k) => k + 1), 'shared'];
    const gens = [
      { stage: 'fetch', icon: '📥', title: 'Load data' },
      { stage: catalog.some((c) => c.stage_name === 'save_csv') ? 'save_csv' : 'save_parquet', icon: '💾', title: 'Save data' },
    ];
    const add = (st: string) => addStage(st);
    if (!paletteOpen) {
      return (
        <aside className="wr-noprint flex flex-col items-center rounded-xl border border-slate-200 bg-white py-2" style={{ height: 'calc(100vh - 120px)' }}>
          <button type="button" onClick={() => setPaletteOpen(true)} title="Show the stages to add"
            className="rounded-md px-1.5 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-100">»</button>
          <span className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>Stages</span>
        </aside>
      );
    }
    return (
      <aside className="wr-noprint flex max-h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-2" style={{ maxHeight: 'calc(100vh - 120px)' }}>
        <div className="mb-2 flex items-center">
          <span className="text-sm font-semibold text-slate-700">Stages</span>
          <span className="flex-1" />
          <button type="button" onClick={() => setPaletteOpen(false)} title="Hide the palette"
            className="rounded-md px-1.5 py-0.5 text-sm font-semibold text-slate-500 hover:bg-slate-100">«</button>
        </div>
        <input id="wr-palette-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search stages…"
          className="mb-2 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-600" />
        <label className="mb-2 flex items-center gap-2 text-xs text-slate-600">
          Add to
          <select value={String(target)} onChange={(e) => setTarget(e.target.value === 'shared' ? 'shared' : Number(e.target.value))}
            className="flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs">
            {laneOpts.map((l) => <option key={String(l)} value={String(l)}>{l === 'shared' ? 'Shared (after merge)' : `Source ${l}`}</option>)}
            <option value={String(maxSourceNum() + 1)}>+ New source {maxSourceNum() + 1}</option>
          </select>
        </label>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          <div>
            {gens.map((g) => (
              <button key={g.title} type="button" onClick={() => add(g.stage)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-slate-100">
                <span aria-hidden="true">{g.icon}</span><span className="truncate font-medium text-slate-800">{g.title}</span>
              </button>
            ))}
          </div>
          {groupedCatalog.map(([cat, stages]) => (
            <div key={cat}>
              <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{cat}</p>
              {stages.map((st) => {
                const lk = lookOf(st.stage_name, st.category);
                return (
                  <button key={st.stage_name} type="button" onClick={() => add(st.stage_name)} title={st.description || lk.blurb}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-slate-100">
                    <span aria-hidden="true">{lk.icon}</span>
                    <span className="min-w-0 truncate text-slate-800">{friendlyName(st.stage_name)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>
    );
  };

  // Graph area (canvas + node inspector): inline in the page, or full-screen for more room.
  const renderGraphArea = (h: number | string, full: boolean) => (
          <div className={`wr-graph-grid mb-4 grid grid-cols-1 gap-3 items-start ${full ? (paletteOpen ? 'xl:grid-cols-[260px_minmax(0,1fr)_420px]' : 'xl:grid-cols-[40px_minmax(0,1fr)_420px]') : 'xl:grid-cols-[minmax(0,1fr)_440px]'}`}>
           {full && renderPalette()}
           <div className="wr-print-canvas min-w-0">
            <PipelineGraph
              height={h}
              pipeline={pipeline}
              lookOf={(st) => lookOf(st, findSpec(st)?.category)}
              run={rowRun}
              selected={graphSel}
              onSelect={(i) => { setMergeSel(false); setSaveSel(false); setGraphSel(i === graphSel ? null : i); }}
              outputLabel={`${output?.format || 'parquet'} · ${output?.mode || 'overwrite'}`}
              onSaveClick={() => { setGraphSel(null); setMergeSel(false); setSaveSel(true); }}
              combineLabel={combineLabel(combine)}
              positions={graphPos}
              onPositions={setGraphPos}
              onMergeClick={() => { setGraphSel(null); setSaveSel(false); setMergeSel(true); }}
              onRemove={(i) => { removeStage(i); setGraphSel(null); }}
              actions={{
                sources: maxSourceNum(),
                onLane: setLane,
                onMove: (i, d) => { moveStage(i, d); if (graphSel === i) setGraphSel(i + d); },
                onDuplicate: (i) => setPipeline((prev) => [...prev.slice(0, i + 1), JSON.parse(JSON.stringify(prev[i])), ...prev.slice(i + 1)]),
              }}
              onAddTo={(src) => {
                setTarget(src as any);
                if (full) { setPaletteOpen(true); setTimeout(() => document.getElementById('wr-palette-search')?.focus(), 0); }   // the palette is right there
                else document.getElementById('wr-stage-catalogue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            />
            <p className="wr-noprint mt-2 text-sm text-slate-500">Click a node to edit it in the panel · + adds a stage to that lane from the catalogue.</p>
           </div>
           {/* Inspector: the selected node's full form, right beside the canvas. */}
           <aside className={"wr-noprint " + (full ? "max-h-full" : "xl:sticky xl:top-20 max-h-[560px]") + " overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2"}>
             {saveSel ? renderOutputForm() : mergeSel && multiSource ? renderCombineForm() : graphSel != null && pipeline[graphSel] ? (
               <div>
                 <div className="mb-2 flex items-center px-1">
                   <span className="text-sm font-semibold text-slate-700">Stage {graphSel + 1}</span>
                   <span className="flex-1" />
                   <button type="button" onClick={() => setGraphSel(null)} title="Close"
                     className="rounded px-1.5 text-sm text-slate-400 hover:bg-slate-200 hover:text-slate-700">✕</button>
                 </div>
                 <ol>{renderStageCard(pipeline[graphSel], graphSel)}</ol>
               </div>
             ) : (
               <p className="p-6 text-center text-sm text-slate-500">Select a node in the graph to see and edit its details here.</p>
             )}
           </aside>
          </div>
  );

  // Colonne asimmetriche, non meta' e meta'. Il catalogo e' una lista di pastiglie e smette di
  // migliorare oltre una certa larghezza; la pipeline contiene i campi che si modificano e lo
  // YAML generato, che invece guadagna da ogni pixel. A meta' schermo il catalogo sprecava
  // spazio proprio mentre l'anteprima andava a capo.
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(300px,380px)_1fr] gap-4 items-start">
      <datalist id="wr-catalog-sites">
        {(catalogSites || []).map((s) => (
          <option key={s.name} value={s.url}>
            {`${s.domain} · ${s.category || ''}${s.topic ? ' / ' + s.topic : ''}${s.legal_status === 'licence' ? ' · licence' : ''}`}
          </option>
        ))}
      </datalist>
      {/* Riga "descrivi o conversa": due modi di chiedere la stessa cosa, un solo canale di ritorno. */}
      {!embedded && (
        <>
          {/* HERO "descrivi o conversa" (restyling 10-22, stile Databricks Genie / Snowflake Cortex): la via
              facile — descrivere — e' la protagonista; il catalogo sotto resta l'alternativa a mano. Stessi
              comandi di prima (Propose, Guided, chat), solo piu' visibili. */}
          <section className="lg:col-span-2 relative overflow-hidden rounded-2xl bg-gradient-to-br from-brand-950 via-brand-900 to-brand-700 p-6 text-white shadow-lg sm:p-8">
            <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-400/25 blur-3xl" />
            <div className="relative">
              <span className="inline-flex items-center rounded-full border border-white/20 bg-white/10 px-2.5 py-0.5 text-xs font-semibold text-brand-200">
                AI pipeline designer
              </span>
              <h2 className="mt-3 text-2xl font-extrabold tracking-tight sm:text-3xl">
                Describe the data you need. The agent builds the pipeline.
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-blue-100 sm:text-base">
                Describe what you want to collect and the agent builds the pipeline for you — you review it
                before anything changes. Prefer to build it by hand? Add stages from the catalogue below.
              </p>
              <div className="mt-5 flex flex-col gap-2 rounded-xl bg-white p-2 shadow-xl shadow-black/20 sm:flex-row sm:items-center">
                <input
                  className="min-w-0 flex-1 rounded-lg border-0 px-3 py-3 text-base text-slate-900 outline-none placeholder:text-slate-400"
                  placeholder="Describe what you want to collect — e.g. “every product page of shop.example.com with name, price and EAN”"
                  value={askText}
                  onChange={(e) => setAskText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') askForPipeline(); }}
                  disabled={generating}
                />
                <div className="flex shrink-0 items-center gap-2">
                  {/* Guidato "2 round": per chi non sa descrivere bene. L'agente fa 2-4 domande, poi progetta. */}
                  <button
                    type="button"
                    onClick={startGuided}
                    disabled={generating || !askText.trim()}
                    className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    title="Not sure how to describe it? The agent asks you a few questions first, then designs it"
                  >
                    🧭 Guided
                  </button>
                  <button
                    type="button"
                    onClick={askForPipeline}
                    disabled={generating || !askText.trim()}
                    className="rounded-lg bg-brand-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-950 disabled:opacity-50"
                    title="Propose a pipeline from this description — you review it before anything changes"
                  >
                    {generating ? 'Designing…' : 'Propose →'}
                  </button>
                </div>
              </div>
              {pipeline.length > 0 && (
                <label className="mt-3 flex items-start gap-2 text-sm text-blue-50">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={useDraftCtx}
                    onChange={(e) => setUseDraftCtx(e.target.checked)}
                    disabled={generating}
                  />
                  <span>
                    Use the pipeline I drafted ({pipeline.length} stage{pipeline.length === 1 ? '' : 's'}) as the starting
                    point — the agent extends it instead of starting over
                  </span>
                </label>
              )}
              {chatSlot && <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-blue-100">or {chatSlot}</div>}
              {/* Partenze concrete, solo quando non c'e' ancora nulla e non si sta gia' generando:
                  a chi ha gia' una pipeline o sta descrivendo non servono e farebbero rumore. */}
              {pipeline.length === 0 && !generating && !draft && (
                <div className="mt-6">
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-200">Start from an example</p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    {ESEMPI_DESCRIZIONE.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => setAskText(ex)}
                        className="rounded-xl border border-white/15 bg-white/[0.07] p-3 text-left text-sm text-blue-50 transition hover:border-white/40 hover:bg-white/[0.14]"
                      >
                        {ex}
                        <span className="mt-2 block text-xs font-semibold text-brand-200">Use this →</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Mini-form del guidato: le domande dell'agente, una risposta ciascuna, poi "Design it". */}
          {guidedQuestions && (
            <div className="lg:col-span-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <div className="mb-2 text-sm font-medium text-emerald-900">
                🧭 A few questions, then I&apos;ll build it
              </div>
              <div className="space-y-2">
                {guidedQuestions.map((q, i) => (
                  <label key={i} className="block">
                    <span className="text-xs text-emerald-900">{q}</span>
                    <input
                      className="mt-1 w-full rounded-md border border-emerald-200 px-3 py-2 text-sm"
                      value={guidedAnswers[i] || ''}
                      onChange={(e) => setGuidedAnswers((a) => { const c = [...a]; c[i] = e.target.value; return c; })}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitGuided(); }}
                      disabled={generating}
                    />
                  </label>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={submitGuided}
                  disabled={generating}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {generating ? 'Designing…' : 'Design it'}
                </button>
                <button
                  type="button"
                  onClick={() => setGuidedQuestions(null)}
                  disabled={generating}
                  className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-white disabled:opacity-50"
                >
                  Cancel
                </button>
                <span className="text-xs text-emerald-700">Leave a field blank and I&apos;ll assume a sensible default.</span>
              </div>
            </div>
          )}
        </>
      )}
      {embedded && chatSlot && <div className="lg:col-span-2 flex justify-end">{chatSlot}</div>}
      {askErr && (
        <p className="lg:col-span-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-base leading-relaxed text-rose-900">{askErr}</p>
      )}
      {askPhase && !askErr && (
        <p className="lg:col-span-2 text-base text-slate-700">{askPhase}</p>
      )}

      {/* AGENT STEPS, live (redesign 10-23, after Kadoa): what the designer agent is doing — the recipe it
          found, the pages it opened, each dry run — with a Stop button, instead of a bare "working…". */}
      {!embedded && (generating || agentSteps.length > 0) && (
        <section className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            {generating && <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-brand-600" />}
            <h3 className="text-base font-semibold text-slate-900">{generating ? 'The agent is working' : 'What the agent did'}</h3>
            <span className="text-sm text-slate-500">{agentSteps.filter((x) => x.kind === 'call').length} steps</span>
            <span className="flex-1" />
            {generating && liveEid && (
              <button type="button" onClick={stopAgent} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Stop</button>
            )}
            {!generating && (
              <button type="button" onClick={() => setAgentSteps([])} className="text-sm text-slate-500 hover:underline">Hide</button>
            )}
          </div>
          <ol className="max-h-64 space-y-1 overflow-y-auto">
            {agentSteps.filter((x) => x.kind !== 'text' || x.detail.length < 400).map((st, i) => (
              <li key={i} className="text-sm leading-snug">
                {st.kind === 'call' && <span className="text-slate-800">🔧 <b>{st.label}</b> <span className="text-slate-500">{st.detail.slice(0, 110)}</span></span>}
                {st.kind === 'result' && <span className={`block pl-6 ${st.label === 'error' ? 'text-rose-700' : 'text-slate-500'}`}>↳ {st.detail.slice(0, 160)}</span>}
                {st.kind === 'text' && <span className="block text-slate-700">💬 {st.detail.slice(0, 200)}</span>}
              </li>
            ))}
            {generating && agentSteps.length === 0 && <li className="text-sm text-slate-500">Starting… the first steps appear in a few seconds.</li>}
          </ol>
        </section>
      )}

      {/* La proposta in attesa. Compare quando l'assistente ha scritto una bozza: nulla e' cambiato
          ancora nel canvas, e la si vede prima di decidere. */}
      {draft && (
        <div className="lg:col-span-2 rounded-xl border border-blue-200 bg-blue-50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-blue-900">
              🤖 The assistant proposes a pipeline
            </span>
            {draft.pipeline_name && (
              <span className="rounded border border-blue-200 bg-white px-1.5 py-0.5 text-xs text-blue-700">
                {draft.pipeline_name}
              </span>
            )}
            <span className="flex-1" />
            <button type="button" onClick={() => setDraftOpen((v) => !v)}
              className="rounded-md border border-blue-300 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100">
              {draftOpen ? 'Hide changes' : 'See changes'}
            </button>
            <button type="button" onClick={applyDraft}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
              Apply to the canvas
            </button>
            <button type="button" onClick={dismissDraft}
              className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-white">
              Discard
            </button>
          </div>
          {draft.note && <p className="mt-1 text-sm text-blue-900">{draft.note}</p>}
          {draft.recipe_fix && (
            <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-relaxed text-emerald-900">
              The catalogue recipe for this site was out of date — the agent corrected it ({draft.recipe_fix}). The
              platform re-checks the correction on the site and, if it passes, updates the catalogue for everyone.
            </p>
          )}
          {/* Promemoria, non blocco: i diritti sulle fonti sono dell'utente (/trust/terms). Se l'agente
              ha trovato la fonte marcata "a licenza" nel catalogo, lo dice in modo specifico. */}
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-900">
            {draft.licence_note ? <><strong>Licence reminder:</strong> {draft.licence_note} </> : null}
            You are responsible for the rights and licences of the sources you collect and for what you do with the
            data — see the <a href="https://www.webrobot.eu/trust/terms" target="_blank" rel="noopener noreferrer" className="underline">terms of use</a>.
          </p>
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
                <p className="mb-1 text-sm font-medium text-slate-700">Proposed</p>
                <pre className="max-h-64 overflow-auto rounded-md border border-blue-200 bg-white p-2 text-xs leading-snug">
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
      {/* TOP BAR (redesign 10-23): where the pipeline goes (Save to an agent) and the actions, always in
          reach — before they sat at the bottom of a long column. */}
      {!embedded && (
        <div className="lg:col-span-2 sticky top-0 z-20 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
          <div className="flex flex-wrap items-center gap-2 ">
              <label className="text-sm font-medium text-slate-700" htmlFor="wr-save-target">Save to</label>
              <select id="wr-save-target" value={saveTarget} onChange={(e) => setSaveTarget(e.target.value)}
                title="The agent this pipeline belongs to: a new one, or an existing agent of your organization"
                className="rounded-lg border border-slate-300 px-2 py-2 text-sm max-w-[260px]">
                <option value="">+ New agent</option>
                {agentsList.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              {!saveTarget && (
                <input
                  value={pipelineName}
                  onChange={(e) => setPipelineName(e.target.value)}
                  placeholder="new agent name"
                  className="min-w-[160px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15"
                />
              )}
              {saveTarget && <span className="flex-1 text-sm text-slate-500">its pipeline is replaced by this one</span>}
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
            <span className="flex-1" />
            <button onClick={handleValidate}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
              ✓ Validate
            </button>
            <div className="flex gap-2">
              {/* One Save (user 10-25: "Save & run" next to Save was confusing and gave no feedback).
                  Running is offered AFTER saving, in the panel below, saying what it starts. */}
              <button onClick={() => handleSave(false)} disabled={saving || pipeline.length === 0}
                className="px-5 py-2 rounded-lg bg-brand-900 text-white text-sm font-semibold shadow-sm hover:bg-brand-950 disabled:opacity-50">
                {saving ? 'Saving…' : saveTarget ? 'Save' : 'Save as new agent'}
              </button>
            </div>
          </div>
          {saveMsg && <p className="mt-2 text-sm text-rose-700">{saveMsg}</p>}
          {renderSavedPanel()}
        </div>
      )}

      {/* Catalogue */}
      <section id="wr-stage-catalogue" className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-slate-900">Stage catalogue</h3>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{catalog.length} stages</span>
        </div>
        {catalogError && <p className="text-sm text-red-600 mb-2">catalogue failed ({catalogError})</p>}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search stages…"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm mb-2 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15"
        />
        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="text-slate-500">Add to:</span>
          <select
            value={String(target)}
            onChange={(e) => {
              const v = e.target.value;
              setTarget(v === 'shared' ? 'shared' : v === '__new' ? maxSourceNum() + 1 : Number(v));
            }}
            className="rounded-lg border border-slate-300 px-2 py-1.5"
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
          {/* Generic LOAD / SAVE: one entry each instead of the 30 load_ and save_ stages; the kind of source
              or destination is chosen inside the node (user 10-23: "here it is 1-1 with the stages"). */}
          {(() => {
            const q = filter.trim().toLowerCase();
            const gens = [
              { stage: 'fetch', icon: '📥', title: 'Load data', blurb: 'A web page, a file (CSV, XML…), a database or a stream — choose it in the node' },
              { stage: catalog.some((c) => c.stage_name === 'save_csv') ? 'save_csv' : 'save_parquet', icon: '💾', title: 'Save data', blurb: 'Also write the result to a file or a database (CSV, Postgres, BigQuery…)' },
            ].filter((g) => !q || (g.title + ' ' + g.blurb).toLowerCase().includes(q) || 'load save csv database file'.includes(q));
            if (!gens.length) return null;
            return (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Load &amp; save</p>
                {gens.map((g) => (
                  <button key={g.title} type="button" onClick={() => addStage(g.stage)} title={g.blurb}
                    className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-slate-200 hover:bg-slate-50">
                    <span aria-hidden="true" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-lg leading-none ring-1 ring-sky-200">{g.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-800">{g.title}</span>
                      <span className="block truncate text-xs text-slate-500">{g.blurb}</span>
                    </span>
                    <span className="shrink-0 rounded-md bg-brand-900 px-2 py-1 text-xs font-semibold text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">+ Add</span>
                  </button>
                ))}
              </div>
            );
          })()}
          {groupedCatalog.map(([cat, stages]) => {
            const groupLook = lookOf(stages[0]?.stage_name || '', stages[0]?.category);
            return (
            <div key={cat}>
              <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-white/95 py-1 backdrop-blur">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{cat}</span>
                {groupLook.blurb && (
                  <span className="truncate text-xs text-slate-400">{groupLook.blurb}</span>
                )}
              </div>
              {/* Righe, non pastiglie (restyling 10-22): icona della famiglia, nome, una riga di
                  descrizione e "+ Add" al passaggio — si sceglie leggendo cosa fa lo stage, non
                  indovinandolo dal nome tecnico. Un clic aggiunge, come prima. */}
              <div className="space-y-0.5">
                {stages.map((s) => {
                  const look = lookOf(s.stage_name, s.category);
                  return (
                  <button
                    key={s.stage_name}
                    onClick={() => addStage(s.stage_name)}
                    title={s.description || `${look.label} — ${look.blurb}`}
                    className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-slate-200 hover:bg-slate-50"
                  >
                    <span aria-hidden="true"
                      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg leading-none ring-1 ${look.tile}`}>
                      {look.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-800">
                        {friendlyName(s.stage_name)} <span className="font-mono text-xs font-normal text-slate-400">{s.stage_name}</span>
                      </span>
                      <span className="block truncate text-xs text-slate-500">{s.description || look.blurb || look.label}</span>
                    </span>
                    <span className="shrink-0 rounded-md bg-brand-900 px-2 py-1 text-xs font-semibold text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                      + Add
                    </span>
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
        <div className="mb-3 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-700">{label || 'Pipeline'}</h3>
          <span className="flex-1" />
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
            {(['list', 'graph'] as const).map((m) => (
              <button key={m} type="button" onClick={() => { setViewMode(m); setGraphSel(null); }}
                className={`rounded-md px-3 py-1 font-medium ${viewMode === m ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                {m === 'list' ? 'List' : 'Graph'}
              </button>
            ))}
          </div>
        </div>
        {viewMode === 'graph' && (
          <div className="relative">
            <button type="button" onClick={() => setGraphFull(true)} title="Open the graph full screen"
              className="absolute right-2 top-2 z-10 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
              ⤢ Expand
            </button>
            {!graphFull && renderGraphArea(560, false)}
          </div>
        )}
        {viewMode === 'graph' && graphFull && (
          <div className="wr-graph-print fixed inset-0 z-50 flex flex-col bg-white p-4" role="dialog" aria-modal="true">
            {/* Print / PDF: only this view goes to paper — the browser's "Save as PDF" makes the file. */}
            <style>{`@media print {
              @page { size: landscape; margin: 10mm; }
              body * { visibility: hidden !important; }
              .wr-graph-print, .wr-graph-print * { visibility: visible !important; }
              .wr-graph-print { position: absolute !important; inset: 0 !important; }
              .wr-graph-print .wr-noprint, .wr-graph-print .react-flow__controls, .wr-graph-print .react-flow__minimap { display: none !important; }
              /* PDF = the canvas only: palette, inspector, title and hints are left out, the canvas fills the page */
              .wr-graph-print .wr-graph-grid { display: block !important; }
              .wr-graph-print .wr-print-canvas, .wr-graph-print .wr-print-canvas > div { height: 180mm !important; width: 100% !important; border: none !important; }
            }`}</style>
            <div className="wr-noprint mb-3 flex items-center gap-3">
              <h3 className="text-base font-semibold text-slate-800">{label || 'Pipeline'} — graph</h3>
              <span className="flex-1" />
              <button type="button" onClick={() => window.print()} title="Print the graph, or save it as PDF from the print dialog"
                className="wr-noprint rounded-lg border border-slate-200 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50">🖨 Print / PDF</button>
              <button type="button" onClick={() => setGraphFull(false)} title="Close (Esc)"
                className="wr-noprint rounded-lg border border-slate-200 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50">✕ Close</button>
            </div>
            <div className="min-h-0 flex-1">{renderGraphArea('calc(100vh - 120px)', true)}</div>
          </div>
        )}

        {/* Guida alla sequenza.
            Una pipeline si legge in quattro tempi — prendi, estrai, trasforma, salva — ma il
            catalogo e' un elenco piatto di 111 voci e quell'ordine non si vede da nessuna parte.
            Qui si mostrano le fasi, quali sono gia' coperte, e la prima cosa che manca perche' la
            pipeline produca qualcosa. Non impone un ordine: la trasformazione e' facoltativa, e
            il consiglio parla solo quando c'e' un buco che rende il risultato vuoto. */}
        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <ol className="flex flex-wrap items-center gap-2">
            {PHASES.map((ph, i) => {
              const done = advice.covered.has(ph.n);
              return (
                <li key={ph.n} className="flex items-center gap-2">
                  <span
                    title={ph.hint}
                    className={
                      'inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full text-sm font-medium border ' +
                      (done
                        ? 'bg-white border-emerald-300 text-slate-800 shadow-sm'
                        : 'bg-transparent border-dashed border-slate-300 text-slate-500')
                    }
                  >
                    <span aria-hidden="true"
                      className={'inline-flex h-7 w-7 items-center justify-center rounded-full text-lg leading-none '
                        + (done ? 'bg-emerald-100' : 'bg-white grayscale opacity-60')}>
                      {ph.icon}
                    </span>
                    {ph.title}
                    {done && <span className="text-emerald-600" aria-label="done">✓</span>}
                  </span>
                  {i < PHASES.length - 1 && <span className="text-lg text-slate-300" aria-hidden="true">→</span>}
                </li>
              );
            })}
          </ol>
          {flatExtractIssues.map((f) => (
            <p key={f} className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <span className="text-lg leading-none" aria-hidden="true">⚠️</span>
              Stage {f + 1} (flatSelect) is followed by an extract: after a flatSelect there is no page left to read.
              To read each item's page, follow its link with a join.
              <button type="button" onClick={() => flatSelectToJoin(f)}
                className="rounded-md border border-amber-300 bg-white px-2.5 py-0.5 text-sm font-medium text-amber-900 hover:bg-amber-100">
                Use resilientJoin instead
              </button>
            </p>
          ))}
          {advice.missing && (
            <p className="mt-2.5 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <span className="text-lg leading-none" aria-hidden="true">💡</span>{advice.missing}
            </p>
          )}
        </div>

        {pipeline.length === 0 && (
          <p className="text-sm text-slate-400 mb-3">
            {embedded
              ? 'Add stages from the catalogue to begin.'
              : 'Empty for now. Describe what you want above and let the agent build it — or add stages from the catalogue by hand.'}
          </p>
        )}

        <ol className="space-y-3 mb-4">
          {viewMode === 'list' && multiSource && (() => {
            // One branch at a time (user 10-23: "not every node listed together"). The tab also sets
            // "Add to", so stages added from the catalogue land in the branch being looked at.
            const tabs: (number | 'shared' | 'all')[] = [...Array.from({ length: maxSourceNum() }, (_, k) => k + 1), 'shared', 'all'];
            const count = (t: number | 'shared' | 'all') => t === 'all' ? pipeline.length
              : pipeline.filter((r) => (t === 'shared' ? r._src === 'shared' : (r._src ?? 1) === t)).length;
            return (
              <li className="list-none">
                <div className="mb-1 inline-flex flex-wrap rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
                  {tabs.map((t) => (
                    <button key={String(t)} type="button"
                      onClick={() => { setListLane(t); if (t !== 'all') setTarget(t); }}
                      className={`rounded-md px-3 py-1 font-medium ${listLane === t ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                      {t === 'all' ? 'All' : t === 'shared' ? 'Shared' : `Source ${t}`} <span className="opacity-70">({count(t)})</span>
                    </button>
                  ))}
                </div>
                {(listLane === 'shared' || listLane === 'all') && (
                  <p className="mt-1 text-sm text-slate-600">
                    ⟹ <b>Union is automatic:</b> the rows of every source are put together (columns matched by name, each row
                    tagged with a <code>source</code> column) before the Shared stages run — no union stage needed.
                    To pair rows across sources (e.g. same EAN), add a matching stage here.
                  </p>
                )}
              </li>
            );
          })()}
          {viewMode === 'list' && pipeline.map((row, idx) => {
            if (multiSource && listLane !== 'all'
                && (listLane === 'shared' ? row._src !== 'shared' : (row._src ?? 1) !== listLane)) return null;
            return renderStageCard(row, idx);
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

        {/* BOTTOM PANEL (redesign 10-23, after Lakeflow Designer / Matillion): the data is the point of a
            pipeline — the dry run's rows sit under the steps, with the YAML and the run steps as tabs. */}
        <div className="rounded-xl border border-slate-200">
          <div className="flex items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 pt-2">
            {([['data', `Data${validateResult?.record_count != null ? ` (${validateResult.record_count})` : ''}`], ['yaml', 'YAML'], ['steps', 'Run steps']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setBottomTab(k)}
                className={`rounded-t-lg px-3 py-2 text-sm font-semibold ${bottomTab === k ? 'border border-b-0 border-slate-200 bg-white text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}>{l}</button>
            ))}
            <span className="flex-1" />
            {!embedded && (
              <button onClick={handleValidate} className="mb-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">✓ Validate</button>
            )}
          </div>
          <div className="p-3">
            {bottomTab === 'data' && (
              <>
                {validation && <p className="text-base text-slate-700">{validation}</p>}
                {validateResult ? <DataPreview result={validateResult} />
                  : !validation && <p className="text-sm text-slate-500">Press <b>Validate</b> to run the pipeline on the real site (a dry run, nothing is saved) and see the rows it extracts.</p>}
              </>
            )}
            {bottomTab === 'yaml' && (
              <pre className="max-h-80 overflow-auto rounded bg-slate-900 p-3 text-xs whitespace-pre-wrap text-slate-100">{yaml}</pre>
            )}
            {bottomTab === 'steps' && (
              Array.isArray(validateResult?.steps) && validateResult.steps.length ? (
                <ol className="space-y-1.5 text-sm">
                  {validateResult.steps.map((st: any, i: number) => (
                    <li key={i} className="flex gap-2"><span className="w-6 shrink-0 text-slate-400">{i + 1}.</span>
                      <span><b className="font-mono">{st.stage}</b> · <span className={/fail|error/i.test(String(st.status)) ? 'text-rose-700' : 'text-slate-600'}>{st.status}</span>{st.message ? ` — ${st.message}` : ''}</span></li>
                  ))}
                </ol>
              ) : <p className="text-sm text-slate-500">The steps of the last dry run appear here.</p>
            )}
          </div>
        </div>
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
