/**
 * Typed client for the Tenant Studio API — the org-scoped backend behind the pipeline
 * designer. It is the foundation of the native (React) designer that replaces the embedded
 * Vue widget.
 *
 * Every method maps 1:1 onto TenantStudioApiV10 (`/webrobot/api/tenant/*`). That backend is
 * the authenticated, per-organization twin of the public `/demo/*` API the Vue DemoApp used:
 * same paths and payloads, but the org comes from the caller's JWT (401 without one) instead
 * of being pinned to the demo org. The port is therefore a pure prefix swap, demo → tenant,
 * plus sending the token.
 *
 * Calls go straight to Jersey with the bearer token, matching how the rest of the client
 * talks to the API (getAuthToken → NEXT_PUBLIC_API_URL). No BFF hop: these are already
 * org-scoped server-side, so proxying them would add nothing but latency.
 */
/**
 * Runtime config, injected rather than imported, so this module has NO dependency on the Next
 * app (@/lib/auth, process.env). That is what lets the tenant-studio core ship as a standalone
 * npm package for the planned WordPress plugin: the host — Next, WordPress, anything — calls
 * configureTenantStudio() once with an apiBase and a token provider. Inside this repo the Next
 * app wires it from getAuthToken()/NEXT_PUBLIC_API_URL at startup (see studio bootstrap).
 */
export interface TenantStudioConfig {
  apiBase: string;
  /** Returns the current bearer token (or null). A function, so a rotated token is picked up. */
  getToken: () => string | null;
  /**
   * Base for the picker's IFRAME, when the host proxies it.
   *
   * Every other call here carries `Authorization: Bearer`, but the iframe is an `src`
   * attribute: the browser issues a plain GET and CANNOT attach a header, so pointing it
   * straight at the tenant API earns
   *   {"error":"Authentication required. Provide X-API-Key header or Authorization: Bearer"}
   * The Vue original did not hit this because its endpoint was the PUBLIC demo twin
   * (/api/webrobot/api/demo/wizard/iframe/...); the port moved to /tenant/... for
   * multi-tenancy and inherited an authentication it had no way to satisfy.
   *
   * A host therefore passes a SAME-ORIGIN path it proxies itself, adding the credential
   * server-side (the Next app does this under /api/tenant/wizard/iframe). Left unset, the
   * old direct URL is kept, so nothing silently changes for a host that has no proxy.
   * Putting the token in the query string was the alternative and was rejected: it would
   * leave a reusable credential in server logs and browser history.
   */
  iframeBase?: string;
  /**
   * Percorso SAME-ORIGIN da cui l'host dice qual e' il profilo dell'agente progettista.
   * Deve rispondere `{ id: <number> }`.
   *
   * Serve perche' quel profilo e' di SISTEMA: appartiene all'organizzazione della piattaforma, e
   * l'elenco `/agentic/profiles` e' filtrato per organizzazione del chiamante — quindi un tenant
   * non lo vede, e cercarlo per nome da qui non puo' funzionare. Verificato il 26-09-2026: con una
   * chiave tenant l'elenco restituisce due profili, entrambi con organizzazione nulla, e non il
   * progettista.
   *
   * L'host lo risolve con la propria credenziale di piattaforma e ne restituisce il solo id: un
   * numero non e' un segreto, e il tenant non acquisisce con questo nessun accesso che non avesse.
   * Stesso motivo e stessa forma di `iframeBase`.
   *
   * Assente: si ripiega sull'elenco, che funziona quando il profilo appartiene all'organizzazione
   * del chiamante (sviluppo, o un cluster BYOC con un profilo proprio).
   */
  designerProfileUrl?: string;
}

let _config: TenantStudioConfig | null = null;

export function configureTenantStudio(cfg: TenantStudioConfig): void {
  _config = { ...cfg, apiBase: cfg.apiBase.replace(/\/$/, '') };
}

function config(): TenantStudioConfig {
  if (!_config) {
    // Safe default so the package works in the Next app before an explicit configure call;
    // a host with a different base/token overrides it via configureTenantStudio().
    _config = {
      apiBase: 'https://api.webrobot.eu',
      getToken: () =>
        (typeof localStorage !== 'undefined' ? localStorage.getItem('authToken') : null),
    };
  }
  return _config;
}

const TENANT = '/api/webrobot/api/tenant';
/**
 * Prefisso NON tenant, per le tre rotte agentiche che servono a far progettare una pipeline da un
 * agente: avviare un run, vederne lo stato, leggerne il risultato.
 *
 * Il resto di questo file corrisponde uno a uno a TenantStudioApiV10, e questa e' l'unica
 * eccezione. Vale la pena dirne il perche': il lavoro agentico non e' una funzione dello studio,
 * e' una capacita' della piattaforma — gli stessi endpoint che usano la chat e i job pianificati.
 * Rifarne un doppione sotto /tenant/ avrebbe significato mantenere due strade per avviare la
 * stessa cosa, che e' la deriva che costa piu' di quanto risparmi.
 */
const PLATFORM = '/api/webrobot/api';

export class TenantStudioError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'TenantStudioError';
  }
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: {
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    raw?: boolean;
    /** Punta al prefisso di piattaforma invece che a /tenant. Vedi PLATFORM. */
    platform?: boolean;
  } = {},
): Promise<T> {
  const { apiBase, getToken } = config();
  const token = getToken();
  if (!token) throw new TenantStudioError(401, 'Not authenticated');

  const qs = opts.query
    ? '?' + new URLSearchParams(
        Object.entries(opts.query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : '';

  const res = await fetch(`${apiBase}${opts.platform ? PLATFORM : TENANT}${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => res.text().catch(() => ''));
    throw new TenantStudioError(res.status, `tenant${path} → ${res.status}`, detail);
  }
  if (opts.raw) return (await res.text()) as unknown as T;
  // Some endpoints (logs, iframe proxy) return non-JSON; callers that need that pass raw:true.
  return (await res.json().catch(() => null)) as T;
}

// ── Catalogue & pipelines ────────────────────────────────────────────────────
export const listPipelines = () => call<any>('GET', '/list');
export const getStageCatalog = () => call<any>('GET', '/catalog/stages');

// ── Execution ────────────────────────────────────────────────────────────────
export const executePipeline = (pipelineName: string, body: unknown) =>
  call<any>('POST', `/execute/${encodeURIComponent(pipelineName)}`, { body });
export const getExecutionStatus = (executionId: string) =>
  call<any>('GET', `/executions/${encodeURIComponent(executionId)}/status`);
export const getExecutionLogs = (executionId: string) =>
  call<string>('GET', `/executions/${encodeURIComponent(executionId)}/logs`, { raw: true });
export const getExecutionOutput = (executionId: string) =>
  call<any>('GET', `/executions/${encodeURIComponent(executionId)}/output`);
export const cancelExecution = (executionId: string) =>
  call<any>('DELETE', `/executions/${encodeURIComponent(executionId)}`);

// ── Pipeline generation & persistence ────────────────────────────────────────
export const generatePipeline = (body: unknown) => call<any>('POST', '/generate-pipeline', { body });
export const saveGeneratedPipeline = (body: unknown) =>
  call<any>('POST', '/save-generated-pipeline', { body });
export const reloadPipelines = () => call<any>('POST', '/reload-pipelines');

// ── Progettazione agentica ───────────────────────────────────────────────────
/**
 * Fa progettare la pipeline all'agente di SISTEMA `webrobot-pipeline-designer`, che consulta il
 * catalogo vivo degli stage, guarda la pagina reale e valida prima di consegnare.
 *
 * Perche' non un'inferenza singola: quella strada esiste (`generatePipeline`) e ha il vocabolario
 * degli stage scritto a mano dentro il prompt, quindi cita stage che non esistono, e l'unico
 * controllo sul suo esito e' che lo YAML si parsi. L'agente invece legge il catalogo, apre il sito,
 * induce i selettori e li verifica con una prova a vuoto: piu' lento e con un altro esito.
 *
 * L'id del profilo NON si cabla: si cerca per nome, perche' su un cluster BYOC quel profilo ha un
 * id diverso. Se manca, si dice quale nome manca invece di lasciare un errore opaco.
 */
export interface AgenticRun { executionId: string }

let _designerProfileId: number | null = null;

export const DESIGNER_PROFILE_NAME = 'webrobot-pipeline-designer';

export async function findDesignerProfileId(): Promise<number> {
  if (_designerProfileId) return _designerProfileId;

  // 1. L'host, se sa dirlo. E' la via che funziona per un tenant qualunque.
  const url = config().designerProfileUrl;
  if (url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      if (j?.id) { _designerProfileId = Number(j.id); return _designerProfileId; }
    }
  }

  // 2. Ripiego sull'elenco. ATTENZIONE alla forma della risposta: e'
  // `{organizationId, count, profiles: [...]}`, non un array e non `{data}`. Leggendo la chiave
  // sbagliata si ottiene un elenco vuoto e un 404 che sembra "profilo assente" — costato un giro
  // il 26-09-2026.
  const list = await call<any>('GET', '/agentic/profiles', { platform: true, query: { enabledOnly: 'true' } });
  const rows: any[] = Array.isArray(list) ? list : (list?.profiles ?? list?.data ?? []);
  const found = rows.find((r) => r?.name === DESIGNER_PROFILE_NAME);
  if (!found?.id) {
    throw new TenantStudioError(
      404,
      `Agent profile "${DESIGNER_PROFILE_NAME}" is not reachable from this account`,
    );
  }
  _designerProfileId = Number(found.id);
  return _designerProfileId;
}

export async function startDesignerRun(goal: string, currentYaml = ''): Promise<AgenticRun> {
  const profileId = await findDesignerProfileId();
  return call<AgenticRun>('POST', '/agentic/start', {
    platform: true,
    // `inputs` e' una mappa di STRINGHE: i nomi combaciano con i segnaposto del goal_template
    // del profilo ({goal} e {current_yaml}), quindi cambiarli qui li scollega silenziosamente.
    body: { profileId, inputs: { goal, current_yaml: currentYaml } },
  });
}

export const getAgenticRunStatus = (executionId: string) =>
  call<any>('GET', `/agentic/${encodeURIComponent(executionId)}`, { platform: true });

/**
 * Il risultato di un run. Sta nell'ELENCO delle esecuzioni e non nello stato: `/agentic/{eid}`
 * riporta solo lo stato, mentre `result` compare in `/agentic/executions`. Non e' ovvio, e cercarlo
 * nello stato e' il primo posto dove si guarda.
 */
export async function getAgenticRunResult(executionId: string): Promise<any | null> {
  const list = await call<any>('GET', '/agentic/executions', { platform: true, query: { limit: 25 } });
  const rows: any[] = Array.isArray(list) ? list : (list?.data ?? []);
  const row = rows.find((r) => r?.executionId === executionId);
  return row ? (row.result ?? null) : null;
}

/**
 * Tira fuori la pipeline dal risultato di un run.
 *
 * Tre forme da attraversare, e ognuna e' stata vista sul campo il 26-09-2026:
 *  1. `result` e' `{<nodo>: {<crew>: "<testo>"}}` — si prende il primo testo non vuoto;
 *  2. il testo puo' essere avvolto in recinti markdown, che l'agente non dovrebbe mettere ma mette;
 *  3. puo' essere un manifest multi-documento (Project + Pipeline + Job) invece del corpo nudo:
 *     la skill della piattaforma insegna a consegnare manifest, e l'istruzione del profilo non
 *     sempre vince. In quel caso si prende lo `spec:` del documento `kind: Pipeline`, che e'
 *     esattamente il corpo che il designer sa caricare.
 *
 * Torna null quando non c'e' niente di utilizzabile: meglio dire "non ho una proposta" che
 * consegnare al canvas del testo che non e' una pipeline.
 */
export function extractPipelineYaml(result: any): string | null {
  if (!result) return null;
  let testo: string | null = null;
  if (typeof result === 'string') testo = result;
  else {
    for (const nodo of Object.values(result as Record<string, any>)) {
      if (typeof nodo === 'string' && nodo.trim()) { testo = nodo; break; }
      if (nodo && typeof nodo === 'object') {
        for (const v of Object.values(nodo as Record<string, any>)) {
          if (typeof v === 'string' && v.trim()) { testo = v; break; }
        }
      }
      if (testo) break;
    }
  }
  if (!testo) return null;
  let y = testo.trim();
  if (y.startsWith('NEEDS:')) return null;               // l'agente chiede, non propone

  // recinti markdown, con o senza linguaggio
  const fence = y.match(/```(?:ya?ml)?\s*\n([\s\S]*?)```/);
  if (fence) y = fence[1].trim();

  // manifest multi-documento → lo `spec:` del documento kind: Pipeline
  if (/^\s*(apiVersion|kind)\s*:/m.test(y) && /kind\s*:\s*Pipeline/.test(y)) {
    const docs = y.split(/^---\s*$/m);
    const pipelineDoc = docs.find((d) => /kind\s*:\s*Pipeline/.test(d));
    if (pipelineDoc) {
      const m = pipelineDoc.match(/^spec\s*:\s*\n([\s\S]*)$/m);
      if (m) {
        // Si toglie l'indentazione di `spec:` per riportare le chiavi al primo livello, che e' la
        // forma che parsePipelineFromYaml si aspetta.
        const righe = m[1].replace(/\s+$/, '').split('\n');
        const indent = Math.min(
          ...righe.filter((r) => r.trim()).map((r) => r.match(/^\s*/)![0].length),
        );
        return righe.map((r) => r.slice(indent)).join('\n').trim() || null;
      }
    }
  }
  // corpo nudo: si taglia l'eventuale prosa prima della prima chiave utile
  const start = y.search(/^(fetch|pipeline|sources|python_extensions|metadata)\s*:/m);
  if (start > 0) y = y.slice(start);
  return y.trim() || null;
}

// ── Bozza proposta dall'assistente ───────────────────────────────────────────
/**
 * Il canale fra la chat e il designer. L'assistente scrive una bozza con PUT, il designer la legge
 * mentre il pannello e' aperto e la PROPONE con un diff; accettata o scartata, si cancella.
 *
 * Non passa per `saveGeneratedPipeline`: quello crea un agente e un progetto veri, quindi ogni
 * tentativo dell'assistente finiva nell'elenco delle pipeline dell'utente.
 *
 * `getPipelineDraft` risponde `null` quando non c'e' nulla (l'API restituisce 204): un designer che
 * chiede ogni pochi secondi non deve distinguere "vuoto" da "errore", in entrambi i casi non c'e'
 * niente da proporre.
 */
export interface PipelineDraft {
  context: string;
  pipeline_name: string | null;
  pipeline_yaml: string;
  note: string | null;
  updated_at: string | null;
}
export const getPipelineDraft = async (context?: string): Promise<PipelineDraft | null> => {
  try {
    const d = await call<PipelineDraft | null>('GET', '/pipeline-draft',
      { query: context ? { context } : undefined });
    return d && (d as PipelineDraft).pipeline_yaml ? (d as PipelineDraft) : null;
  } catch {
    return null;
  }
};
export const putPipelineDraft = (body: Partial<PipelineDraft>) =>
  call<any>('PUT', '/pipeline-draft', { body });
export const deletePipelineDraft = (context?: string) =>
  call<any>('DELETE', '/pipeline-draft', { query: context ? { context } : undefined });
export const getStudioInfo = () => call<any>('GET', '/info');

// ── Datasets ─────────────────────────────────────────────────────────────────
export const uploadDataset = (pipelineName: string, body: unknown) =>
  call<any>('POST', `/upload-dataset/${encodeURIComponent(pipelineName)}`, { body });
export const createDataset = (body: unknown) => call<any>('POST', '/create-dataset', { body });
export const searchDatasets = (q: string) => call<any>('GET', '/search', { query: { q } });

// ── RAG ──────────────────────────────────────────────────────────────────────
export const ragQuery = (body: unknown) => call<any>('POST', '/rag/query', { body });
export const ragStatus = () => call<any>('GET', '/rag/status');

// ── Selector cache ───────────────────────────────────────────────────────────
export const getSelectorCache = (query?: Record<string, string>) =>
  call<any>('GET', '/selector-cache', { query });
export const putSelectorCache = (body: unknown) => call<any>('POST', '/selector-cache', { body });

// ── Chat session ─────────────────────────────────────────────────────────────
export const getChatSession = () => call<any>('GET', '/chat-session');
export const putChatSession = (body: unknown) => call<any>('POST', '/chat-session', { body });
export const deleteChatSession = () => call<any>('DELETE', '/chat-session');

// ── HITL / captcha notifications ─────────────────────────────────────────────
export const listCaptchaNotifications = () => call<any>('GET', '/notifications/captcha');
export const resolveCaptchaNotification = (id: string, body: unknown) =>
  call<any>('POST', `/notifications/captcha/${encodeURIComponent(id)}/resolve`, { body });

// ── Wizard: inference & suggestion ───────────────────────────────────────────
export const wizardInferSelector = (body: unknown) => call<any>('POST', '/wizard/infer-selector', { body });
export const wizardInferFields = (body: unknown) => call<any>('POST', '/wizard/infer-fields', { body });
export const wizardInferOddsStructure = (body: unknown) =>
  call<any>('POST', '/wizard/infer-odds-structure', { body });
export const wizardInferBodySelector = (body: unknown) =>
  call<any>('POST', '/wizard/infer-body-selector', { body });
export const wizardInferSegment = (body: unknown) => call<any>('POST', '/wizard/infer-segment', { body });
export const wizardInferActions = (body: unknown) => call<any>('POST', '/wizard/infer-actions', { body });
export const wizardInferVariables = (body: unknown) => call<any>('POST', '/wizard/infer-variables', { body });
export const wizardApplyVariables = (body: unknown) => call<any>('POST', '/wizard/apply-variables', { body });
export const wizardRelaxSelectors = (body: unknown) => call<any>('POST', '/wizard/relax-selectors', { body });
export const wizardConsolidateSelectors = (body: unknown) =>
  call<any>('POST', '/wizard/consolidate-selectors', { body });
export const wizardSuggest = (body: unknown) => call<any>('POST', '/wizard/suggest', { body });
export const wizardSuggestFieldNames = (body: unknown) =>
  call<any>('POST', '/wizard/suggest-field-names', { body });
export const wizardValidate = (body: unknown) => call<any>('POST', '/wizard/validate', { body });

// ── Wizard: Python transforms ────────────────────────────────────────────────
export const wizardGeneratePythonTransform = (body: unknown) =>
  call<any>('POST', '/wizard/generate-python-transform', { body });
export const wizardSecurityCheckPythonTransform = (body: unknown) =>
  call<any>('POST', '/wizard/security-check-python-transform', { body });
export const wizardValidatePythonTransform = (body: unknown) =>
  call<any>('POST', '/wizard/validate-python-transform', { body });

// ── Wizard: live preview (proxy / iframe / CMF captcha-manual-flow) ───────────
export const wizardProxy = (body: unknown) => call<any>('POST', '/wizard/proxy', { body });
export const wizardCmfOpen = (body: unknown) => call<any>('POST', '/wizard/cmf/open', { body });
export const wizardCmfStep = (body: unknown) => call<any>('POST', '/wizard/cmf/step', { body });
export const wizardCmfStatus = (sessionId: string) =>
  call<any>('GET', `/wizard/cmf/${encodeURIComponent(sessionId)}/status`);
export const wizardCmfResume = (sessionId: string, body: unknown) =>
  call<any>('POST', `/wizard/cmf/${encodeURIComponent(sessionId)}/resume`, { body });
export const wizardCmfAwaitResolution = (sessionId: string) =>
  call<any>('GET', `/wizard/cmf/${encodeURIComponent(sessionId)}/await-resolution`);
export const wizardCmfClose = (sessionId: string) =>
  call<any>('DELETE', `/wizard/cmf/${encodeURIComponent(sessionId)}`);
export const wizardRegisterRemote = (body: unknown) => call<any>('POST', '/wizard/register-remote', { body });
export const wizardGetRegisteredRemote = (sessionId: string) =>
  call<any>('GET', `/wizard/register-remote/${encodeURIComponent(sessionId)}`);
export const wizardDeregisterRemote = (sessionId: string) =>
  call<any>('DELETE', `/wizard/register-remote/${encodeURIComponent(sessionId)}`);

/** Base for the iframe live-preview proxy — used as a src, not fetched as JSON. */
export const wizardIframeSrc = (sessionId: string, path = '') => {
  const { apiBase, iframeBase } = config();
  const base = iframeBase ? iframeBase.replace(/\/$/, '') : `${apiBase}${TENANT}/wizard/iframe`;
  return `${base}/${encodeURIComponent(sessionId)}/${path}`;
};
