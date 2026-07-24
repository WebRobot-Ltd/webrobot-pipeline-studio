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

export class TenantStudioError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'TenantStudioError';
  }
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { body?: unknown; query?: Record<string, string | number | undefined>; raw?: boolean } = {},
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

  const res = await fetch(`${apiBase}${TENANT}${path}${qs}`, {
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
export const wizardIframeSrc = (sessionId: string, path = '') =>
  `${config().apiBase}${TENANT}/wizard/iframe/${encodeURIComponent(sessionId)}/${path}`;
