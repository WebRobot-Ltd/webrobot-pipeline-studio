'use client';

/**
 * Visual selector picker — FULL PARITY port of the Vue DemoApp picker/wizard.
 *
 * Opens a live proxied browser session (Camoufox via CMF), shows the target page in an
 * iframe, and drives the in-iframe picker.js over the window<->iframe postMessage bridge.
 * The in-iframe picker script is injected server-side by /tenant/wizard/iframe; this
 * component is the HOST side. It reproduces the Vue original's behaviour exactly:
 *
 *   1. ACTIONS before/between picks (navigate / consent / click / scroll → /cmf/step),
 *      staged locally then replayed on the live Camoufox tab, which refreshes the iframe
 *      to the post-action DOM (?_v=reloadKey cache-bust). Captcha/WAF block + resume.
 *   2. MULTI-SAMPLE mode — pick a repeating element across several samples; the iframe
 *      computes the common (generalised) selector.
 *   3. 2-CLICK ROW / LCA container picking (mode 'row-lca') + MULTI-FIELD accumulation
 *      (pick several fields inside a segment container, relative selectors).
 *   4. oddsSelect market-box structure picking (mode 'market-box' → infer-odds-structure).
 *   5. ANTI-BOT detection signals posted by picker.js (Cloudflare/Datadome/hCaptcha/PX).
 *
 * The wizard-STATE plumbing (which stage arg / _fields / _markets a pick lands on, YAML
 * emission) is the host application's concern — in the Vue original it was inlined against
 * `wizPipeline`. Here it is surfaced through typed callbacks so the picker stays a reusable,
 * host-agnostic SDK component. Every message type and every API call the Vue picker used is
 * mirrored 1:1 below; only the destination of a finished pick is a callback instead of a
 * direct wizPipeline mutation.
 *
 * ⚠️ This is inherently interactive — its whole value is clicking in a live iframe — so it
 * MUST be validated in a browser against a real page. It is additive (behind a "pick" button)
 * and cannot break anything else if it misbehaves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  wizardCmfOpen,
  wizardCmfStep,
  wizardCmfResume,
  wizardCmfClose,
  wizardIframeSrc,
  wizardInferSegment,
  wizardInferBodySelector,
  wizardInferFields,
  TenantStudioError,
} from '../client';

// ── Public shapes ────────────────────────────────────────────────────────────

/** Requested picking behaviour. Selection modes (single/list/multi-field/multi-sample)
 * open navigate-first: the modal starts in 'action-record' so the operator can drive the
 * mirror to the right page, then a "📌 Start picking" CTA arms the requested mode. */
export type PickerMode =
  | 'selector-single'
  | 'selector-list'
  | 'multi-field'
  | 'multi-sample'
  | 'row-lca'
  | 'market-box'
  | 'action-record';

/** A single element pick result (selector-single / selector-list / row-lca). */
export interface PickResult {
  selector: string;
  matches?: number;
  attributes?: string[];
  sampleText?: string;
  sampleHtml?: string;
  /** picker.js-reported mode of the click, e.g. 'row-lca' for a 2-click container. */
  mode?: string;
  /** LCA refinement selector when the picker climbed to a wrapper. */
  refinedFromHighlight?: string | null;
}

/** One accumulated multi-field row (matches the Vue row._fields shape). */
export interface PickField {
  selector: string;
  as: string;
  method: string;
  _color?: string | null;
  _sample?: string | null;
  _sampleHtml?: string | null;
  _parallel?: boolean;
  _attrs?: string[];
  _matches?: number;
}

/** Running state of the repeating-link (multi-sample) picker. */
export interface MultiSampleStatus {
  selector: string | null;
  matches: number;
  samples: number;
  sampleText: string;
}

/** A picked oddsSelect market box (selector + its full HTML for structure inference). */
export interface MarketBoxPick {
  selector: string;
  html: string;
}

/** A picked macro / content box for focused AI field inference. */
export interface MacroBoxPick {
  selector: string;
  html: string;
}

/** Captcha / WAF block descriptor returned by /cmf/open|step. */
export interface CmfBlock {
  kind?: string;
  url?: string;
  [k: string]: unknown;
}

/** A recorded action for /cmf/step (Click / Type / Scroll / Back / raw events). */
export interface PickerAction {
  type: string;
  selector?: string;
  text?: string;
  ms?: number;
  [k: string]: unknown;
}

interface StatusMsg {
  kind: 'info' | 'error' | 'warn' | 'ok';
  text: string;
}

export interface SelectorPickerProps {
  initialUrl?: string;
  /** Geo/country zone — the live session exits through it (same proxy the pipeline uses). */
  geo?: string;
  /** Requested pick mode (default 'selector-single'). */
  mode?: PickerMode;
  /** explore/join origin: picker climbs to the <a href> (linkMode). */
  linkMode?: boolean;
  /** flatSelect segment container — field selectors are computed RELATIVE to it. */
  containerSelector?: string | null;
  /** Existing fields to re-paint in the iframe (multi-restore) when re-entering. */
  restoreFields?: PickField[];

  /** Single/list/row-lca pick landed. Host applies it to the target arg. */
  onPick?: (r: PickResult) => void;
  /** Multi-field accumulation changed (append/refine/samples). Host stores row._fields. */
  onFieldsChange?: (fields: PickField[]) => void;
  /** Repeating-link sampler progress. */
  onMultiSample?: (s: MultiSampleStatus) => void;
  /** An oddsSelect market box was picked. Host appends it + runs structure inference. */
  onMarketBox?: (m: MarketBoxPick) => void;
  /** A macro/content box was picked (focused AI field inference region). */
  onMacroBox?: (m: MacroBoxPick | null) => void;
  /** Anti-bot detected inside the iframe — host tags the pipeline requires_hitl. */
  onAntiBot?: (reason: string) => void;
  /** Committed action trace (round-tripped through /cmf/step). Host may apply to a stage. */
  onActionsCommitted?: (actions: PickerAction[]) => void;
  /** Body-selector suggestion after picking a long-text field (best-effort). */
  onBodySuggestion?: (s: BodySuggestion) => void;

  onClose: () => void;
}

export interface BodySuggestion {
  pickedSelector: string;
  selector: string;
  method: 'text' | 'boilerPipe';
  why: string;
  confidence: number | null;
  paywalled: boolean;
  paywallReason: string;
}

const TRACE_TYPES = new Set(['Click', 'Type', 'Scroll']);
const FIELD_PALETTE = ['#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6', '#eab308'];

// ── Helpers (ported 1:1 from the Vue picker) ─────────────────────────────────

/** Snake_case column-name guess from a field's sample text (falls back to field_N). */
function guessFieldName(sampleText: string | undefined, count: number): string {
  const t = (sampleText || '').trim();
  const fallback = 'field_' + (count + 1);
  if (!t) return fallback;
  if (/^\d+([.,]\d+)?$/.test(t)) return fallback;
  return (
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || fallback
  );
}

/** Smart default extractor method from sample text + attributes + selector. */
function guessFieldMethod(d: Record<string, any>): string {
  const txt = (d.sampleText || '').trim();
  const attrs: string[] = Array.isArray(d.attributes) ? d.attributes : [];
  const sel: string = d.selector || '';
  if (!txt && attrs.includes('src')) return 'attr(src)';
  if (!txt && attrs.includes('href')) return 'attr(href)';
  if (/img/i.test(sel) && attrs.includes('src')) return 'attr(src)';
  if (/href/i.test(sel) && attrs.includes('href')) return 'attr(href)';
  return 'text';
}

export default function SelectorPicker({
  initialUrl = '',
  geo,
  mode: requestedMode = 'selector-single',
  linkMode = false,
  containerSelector = null,
  restoreFields,
  onPick,
  onFieldsChange,
  onMultiSample,
  onMarketBox,
  onMacroBox,
  onAntiBot,
  onActionsCommitted,
  onBodySuggestion,
  onClose,
}: SelectorPickerProps) {
  const [url, setUrl] = useState(initialUrl);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingKind, setLoadingKind] = useState<'open' | 'step'>('open');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMsg | null>(null);

  // Two-phase navigate-first: pickerMode is what the iframe is doing NOW; intendedMode is
  // the selection mode to promote into once the operator is on the target page.
  const [pickerMode, setPickerMode] = useState<PickerMode>('selector-single');
  const [intendedMode, setIntendedMode] = useState<PickerMode | null>(null);

  const [selected, setSelected] = useState<PickResult | null>(null);
  const [stagedActions, setStagedActions] = useState<PickerAction[]>([]);
  const [committedActions, setCommittedActions] = useState<PickerAction[]>([]);
  const [multiSampleStatus, setMultiSampleStatus] = useState<MultiSampleStatus>({
    selector: null,
    matches: 0,
    samples: 0,
    sampleText: '',
  });
  const [fields, setFields] = useState<PickField[]>(restoreFields ? [...restoreFields] : []);
  const [macroBox, setMacroBox] = useState<MacroBoxPick | null>(null);

  const [block, setBlock] = useState<CmfBlock | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [antiBot, setAntiBot] = useState<{ detected: boolean; reason: string | null }>({ detected: false, reason: null });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiIntent, setAiIntent] = useState('');

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Refs mirroring state read inside the (stable) message handler — the Vue original relied
  // on Vue refs being always-current; React closures aren't, so we mirror explicitly.
  const sessionIdRef = useRef<string | null>(null);
  const pickerModeRef = useRef<PickerMode>('selector-single');
  const intendedModeRef = useRef<PickerMode | null>(null);
  const linkModeRef = useRef<boolean>(linkMode);
  const containerRef = useRef<string | null>(containerSelector);
  const blockRef = useRef<CmfBlock | null>(null);
  const antiBotRef = useRef<boolean>(false);
  const fieldsRef = useRef<PickField[]>(fields);
  const pickingMacroRef = useRef<boolean>(false);
  const pickingMarketRef = useRef<boolean>(false);
  const loadedUrlRef = useRef<string | null>(null);
  const restoreFieldsRef = useRef<PickField[] | undefined>(restoreFields);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { pickerModeRef.current = pickerMode; }, [pickerMode]);
  useEffect(() => { intendedModeRef.current = intendedMode; }, [intendedMode]);
  useEffect(() => { linkModeRef.current = linkMode; }, [linkMode]);
  useEffect(() => { containerRef.current = containerSelector; }, [containerSelector]);
  useEffect(() => { blockRef.current = block; }, [block]);
  useEffect(() => { antiBotRef.current = antiBot.detected; }, [antiBot.detected]);
  useEffect(() => { fieldsRef.current = fields; }, [fields]);
  useEffect(() => { loadedUrlRef.current = loadedUrl; }, [loadedUrl]);
  useEffect(() => { restoreFieldsRef.current = restoreFields; }, [restoreFields]);

  // ── iframe postMessage helpers ─────────────────────────────────────────────
  const post = useCallback((msg: Record<string, unknown>) => {
    try {
      iframeRef.current?.contentWindow?.postMessage(msg, '*');
    } catch {
      /* iframe gone / cross-origin racing a reload */
    }
  }, []);

  const sendHighlight = useCallback(
    (layers: Array<{ selector: string; color: string; label?: string }>) => {
      post({ type: 'webrobot-highlight', layers });
    },
    [post],
  );
  const clearHighlight = useCallback(() => post({ type: 'webrobot-highlight-clear' }), [post]);

  const updateFields = useCallback(
    (next: PickField[]) => {
      fieldsRef.current = next;
      setFields(next);
      onFieldsChange?.(next);
    },
    [onFieldsChange],
  );

  // Forward the current block state to the iframe (or clear it). On block, also force
  // action-record + anti-bot capture so every mouse/key event while solving is buffered.
  const pushBlockStateToIframe = useCallback(
    (b: CmfBlock | null) => {
      if (b) {
        post({ type: 'webrobot-picker-block', block: b });
        if (pickerModeRef.current !== 'action-record') {
          setPickerMode('action-record');
          post({ type: 'webrobot-picker-mode', mode: 'action-record' });
        }
        post({
          type: 'webrobot-picker-anti-bot-mode',
          enabled: true,
          reason: b.kind || 'server-cmfBlock',
        });
      } else {
        post({ type: 'webrobot-picker-block-clear' });
        post({ type: 'webrobot-picker-anti-bot-mode', enabled: false });
      }
    },
    [post],
  );

  // ── CMF session open ───────────────────────────────────────────────────────
  const closeSession = useCallback((sid: string | null) => {
    if (sid) wizardCmfClose(sid).catch(() => {});
  }, []);
  // Close the live session on unmount so a parked Camoufox session is not leaked.
  useEffect(() => () => closeSession(sessionIdRef.current), [closeSession]);

  const openWithCamoufox = useCallback(
    async (target: string) => {
      setLoadingKind('open');
      setLoading(true);
      setError(null);
      try {
        const body = geo ? { url: target, country: geo } : { url: target };
        const j = await wizardCmfOpen(body);
        const sid = j?.session_id || null;
        if (!sid) throw new Error('no session id from cmf/open');
        setSessionId(sid);
        sessionIdRef.current = sid;
        setLoadedUrl(j?.current_url || target);
        setReloadKey((k) => k + 1);
        const b: CmfBlock | null = j?.block || null;
        setBlock(b);
        blockRef.current = b;
        if (b) {
          onAntiBot?.(b.kind || 'server-detected');
          setAntiBot({ detected: true, reason: b.kind || 'server-detected' });
        }
        // Safety net: onPickerIframeLoad clears loading once the mirror renders.
        setTimeout(() => setLoading(false), 30000);
      } catch (e) {
        setError(e instanceof TenantStudioError ? `cmf/open → ${e.status}` : (e as Error).message || 'Could not open the page.');
        setLoading(false);
      }
    },
    [geo, onAntiBot],
  );

  // Cleared when the mirror iframe finishes loading — until then the overlay hides the blank.
  const onPickerIframeLoad = useCallback(() => setLoading(false), []);

  // ── Load a URL (navigate-first two-phase for selection modes) ──────────────
  const loadUrl = useCallback(async () => {
    const u = url.trim();
    if (!/^https?:\/\//.test(u)) {
      setError('Enter an http(s) URL.');
      return;
    }
    setError(null);
    setSelected(null);
    setStagedActions([]);
    setCommittedActions([]);
    if (sessionIdRef.current) closeSession(sessionIdRef.current);

    // Selection modes open in action-record (pure navigation) + arm the intended mode.
    const isSelectionMode =
      requestedMode === 'multi-sample' ||
      requestedMode === 'selector-list' ||
      requestedMode === 'selector-single';
    if (isSelectionMode) {
      setIntendedMode(requestedMode);
      intendedModeRef.current = requestedMode;
      setPickerMode('action-record');
      pickerModeRef.current = 'action-record';
    } else if (requestedMode === 'multi-field') {
      // "Pick fields" navigate-first too (unless direct); promote via CTA.
      setIntendedMode('multi-field');
      intendedModeRef.current = 'multi-field';
      setPickerMode('action-record');
      pickerModeRef.current = 'action-record';
    } else {
      setIntendedMode(null);
      intendedModeRef.current = null;
      setPickerMode(requestedMode);
      pickerModeRef.current = requestedMode;
    }
    await openWithCamoufox(u);
  }, [url, requestedMode, closeSession, openWithCamoufox]);

  // ── /cmf/step action replay ────────────────────────────────────────────────
  const forwardStep = useCallback(
    async (actionOrBatch: PickerAction | PickerAction[]) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      // Blocked by captcha (and not in anti-bot capture) → the Resume button is the only path.
      if (blockRef.current && !antiBotRef.current) {
        setStatus({ kind: 'warn', text: '⚠️ Session blocked by captcha — resolve in the mirror before sending new actions.' });
        return;
      }
      const batch = Array.isArray(actionOrBatch) ? actionOrBatch : [actionOrBatch];
      if (!batch.length) return;
      const first = batch[0];
      setLoadingKind('step');
      setLoading(true);
      try {
        const j = await wizardCmfStep({
          session_id: sid,
          actions: batch,
          type: first.type,
          selector: first.selector,
          text: first.text,
          ms: first.ms,
        });
        if (j?.current_url) setLoadedUrl(j.current_url);
        setReloadKey((k) => k + 1);
        if (j?.block) {
          setBlock(j.block);
          blockRef.current = j.block;
          pushBlockStateToIframe(j.block);
          onAntiBot?.(j.block.kind || 'server-detected');
          setAntiBot({ detected: true, reason: j.block.kind || 'server-detected' });
        } else if (blockRef.current) {
          setBlock(null);
          blockRef.current = null;
          pushBlockStateToIframe(null);
        }
        if (Array.isArray(j?.warnings) && j.warnings.length) {
          setStatus({ kind: 'warn', text: `Replay ran but ${j.warnings.length} action(s) could not be applied.` });
        }
        // NAVIGATE-FIRST: while intendedMode is set the actions are positioning-only and
        // must NOT enter the committed trace. Skip pure Back navigation too.
        const committable = intendedModeRef.current ? [] : batch.filter((a) => a && a.type && a.type !== 'Back');
        if (committable.length) {
          setCommittedActions((prev) => {
            const next = [...prev, ...committable];
            onActionsCommitted?.(next);
            return next;
          });
        }
      } catch (e) {
        if (e instanceof TenantStudioError) {
          const detail = (e.body as any) || {};
          const msg = detail.error || e.message || '';
          // Poisoned session → auto-reopen on the last known URL.
          if (e.status === 404 && /session expired|session not found/i.test(msg)) {
            const lastUrl = loadedUrlRef.current;
            setSessionId(null);
            sessionIdRef.current = null;
            if (lastUrl) {
              setError('session reset — reloading page');
              await openWithCamoufox(lastUrl);
            } else {
              setError('session expired — reopen the URL to continue');
            }
            return;
          }
          // Captcha / WAF block — keep the iframe on the challenge page, surface the banner.
          if (e.status === 409 && detail.block) {
            if (detail.current_url) setLoadedUrl(detail.current_url);
            setReloadKey((k) => k + 1);
            setBlock(detail.block);
            blockRef.current = detail.block;
            pushBlockStateToIframe(detail.block);
            return;
          }
          setStatus({ kind: 'error', text: 'Step failed: ' + msg });
        } else {
          setStatus({ kind: 'error', text: 'Step failed: ' + ((e as Error).message || String(e)) });
        }
      } finally {
        setLoading(false);
      }
    },
    [openWithCamoufox, pushBlockStateToIframe, onAntiBot, onActionsCommitted],
  );

  // Drive page.goBack() on the live Camoufox tab.
  const goBack = useCallback(async () => {
    if (!sessionIdRef.current) return;
    const before = loadedUrlRef.current;
    await forwardStep([{ type: 'Back' }]);
    if (loadedUrlRef.current === before) {
      setStatus({ kind: 'info', text: '← Back: already at the start of this session — nothing to undo.' });
    }
  }, [forwardStep]);

  // Ship the staged action queue to Camoufox in one ordered batch.
  const sendStagedActions = useCallback(async () => {
    if (!sessionIdRef.current) return;
    post({ type: 'webrobot-picker-flush-queue' });
    await new Promise((r) => setTimeout(r, 50));
    let queue = stagedActions.slice();
    if (!queue.length) return;
    // Non-captcha: ship ONLY human-readable trace types (Click/Type/Scroll). Captcha
    // (antiBot): ship EVERYTHING — the CMP needs the full raw event stream.
    if (!antiBotRef.current) {
      queue = queue.filter((a) => a && a.type && TRACE_TYPES.has(a.type));
    }
    if (!queue.length) return;
    setStagedActions([]);
    await forwardStep(queue);
  }, [stagedActions, post, forwardStep]);

  const clearStagedActions = useCallback(() => {
    setStagedActions([]);
    post({ type: 'webrobot-picker-clear-queue' });
  }, [post]);

  const stopActionRecording = useCallback(() => post({ type: 'webrobot-picker-stop-recording' }), [post]);

  // ── Resume after captcha ───────────────────────────────────────────────────
  const resumeAfterCaptcha = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || resumeBusy) return;
    setResumeBusy(true);
    try {
      const j = await wizardCmfResume(sid, {});
      if (!j?.blocked) {
        setBlock(null);
        blockRef.current = null;
        pushBlockStateToIframe(null);
        setReloadKey((k) => k + 1);
      } else if (j.block) {
        setBlock(j.block);
        blockRef.current = j.block;
        pushBlockStateToIframe(j.block);
        setStatus({ kind: 'warn', text: '⚠️ The block still seems active. Complete the captcha in the mirror, then retry.' });
      }
    } catch (e) {
      if (e instanceof TenantStudioError && e.status === 409 && (e.body as any)?.block) {
        const b = (e.body as any).block;
        setBlock(b);
        blockRef.current = b;
        pushBlockStateToIframe(b);
        setStatus({ kind: 'warn', text: '⚠️ The block still seems active. Complete the captcha in the mirror, then retry.' });
      } else {
        setStatus({ kind: 'warn', text: 'resume failed: ' + ((e as Error).message || String(e)) });
      }
    } finally {
      setResumeBusy(false);
    }
  }, [resumeBusy, pushBlockStateToIframe]);

  // ── Anti-bot detected inside the iframe ────────────────────────────────────
  const onAntiBotDetected = useCallback(
    (reason: string) => {
      setAntiBot({ detected: true, reason });
      antiBotRef.current = true;
      if (pickerModeRef.current !== 'action-record') {
        setPickerMode('action-record');
        pickerModeRef.current = 'action-record';
        post({ type: 'webrobot-picker-mode', mode: 'action-record' });
      }
      onAntiBot?.(reason);
      setStatus({
        kind: 'warn',
        text: `🤖 Anti-bot detected (${reason}) — capture switched to RAW EVENT mode. Pipeline should be tagged HITL-required.`,
      });
    },
    [post, onAntiBot],
  );

  // ── LLM row-selector generalization (webrobot-generalize-request) ──────────
  const handleGeneralizeRequest = useCallback(async (d: Record<string, any>, source: MessageEventSource | null) => {
    const html = d && d.html ? String(d.html) : '';
    if (!html || !source) return;
    const sample = d && d.sampleText ? String(d.sampleText).slice(0, 120) : '';
    const nested = !!(d && d.nested);
    const linkFollow = typeof d.linkMode === 'boolean' ? d.linkMode : linkModeRef.current;
    const prompt = linkFollow
      ? 'Find the CSS selector of the repeating LINK in this list' +
        (sample ? ` whose text is «${sample}»` : '') +
        '. The selector MUST target the <a> anchor element itself and END at that `a` (so it carries an href to follow) — do NOT end on an inner span/heading/text node. It must match ALL such links: ignore auto-generated/hashed classes and :nth-of-type; prefer stable tags/attributes, ending in `a` or `a[href]`.'
      : nested
      ? 'This is a NESTED / threaded structure (e.g. comments) where the same item repeats at MULTIPLE nesting depths' +
        (sample ? ` (one contains the text «${sample}»)` : '') +
        '. Return ONE depth-agnostic CSS selector that matches EVERY node at EVERY depth (top-level and all replies), e.g. the custom element tag or a stable class/attribute. Do NOT constrain by depth or position; ignore auto-generated/hashed classes and :nth-of-type; prefer stable tags/attributes (custom element, data-testid, semantic class).'
      : 'Find the CSS selector of the repeating ROW/item of the list' +
        (sample ? ` that contains the text «${sample}»` : '') +
        '. It must match ALL similar rows: ignore auto-generated/hashed classes and :nth-of-type, prefer stable tags/attributes (data-testid, custom element, semantic classes).';
    try {
      setStatus({ kind: 'info', text: '🧬 Generalizing row selector (AI)…' });
      const j = await wizardInferSegment({ html, segmentation_prompt: prompt });
      const sel = (j && j.segment_selector) || '';
      if (sel) {
        try { source.postMessage({ type: 'webrobot-generalize-result', selector: sel }, { targetOrigin: '*' } as WindowPostMessageOptions); } catch { /* ignore */ }
        setStatus({ kind: 'info', text: '🧬 Generalized row selector applied.' });
      } else {
        setStatus({ kind: 'info', text: 'AI generalization unavailable — using the heuristic selector.' });
      }
    } catch {
      /* silent fallback to heuristic */
    }
  }, []);

  // ── Body-selector suggestion after a long-text field pick (best-effort) ────
  const suggestBodySelector = useCallback(
    async (pickedSelector: string, pickedHtml: string) => {
      try {
        const j = await wizardInferBodySelector({
          url: loadedUrlRef.current || '',
          picked_selector: pickedSelector,
          picked_html: pickedHtml || '',
        });
        if (!j || j.error) return;
        const sel = (j.selector || '').trim();
        const paywalled = j.paywalled === true;
        if (!sel && !paywalled) return;
        onBodySuggestion?.({
          pickedSelector,
          selector: sel,
          method: j.method === 'text' ? 'text' : 'boilerPipe',
          why: j.why || '',
          confidence: typeof j.confidence === 'number' ? j.confidence : null,
          paywalled,
          paywallReason: j.paywall_reason || '',
        });
      } catch {
        /* silent — suggestion is best-effort */
      }
    },
    [onBodySuggestion],
  );

  // ── The postMessage bridge — faithful mirror of onPickerMessage ────────────
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const d = ev.data as Record<string, any>;
      if (!d || typeof d !== 'object') return;

      if (d.type === 'webrobot-generalize-request') {
        handleGeneralizeRequest(d, ev.source);
        return;
      }

      if (d.type === 'webrobot-pick-selector') {
        // oddsSelect market-box capture.
        if (pickingMarketRef.current) {
          pickingMarketRef.current = false;
          setStatus({ kind: 'info', text: '📦 Market captured — inferring structure…' });
          onMarketBox?.({ selector: d.selector, html: d.sampleHtmlFull || d.sampleHtml || '' });
          return;
        }
        // Macro/content-box capture (scoping the AI field-inference region).
        if (pickingMacroRef.current) {
          const mb = { selector: d.selector, html: d.sampleHtmlFull || d.sampleHtml || '' };
          pickingMacroRef.current = false;
          setMacroBox(mb);
          onMacroBox?.(mb);
          sendHighlight([{ selector: d.selector, color: '#6366f1', label: 'content box' }]);
          setStatus({ kind: 'info', text: '📦 Content box set — describe the fields, then 🪄 Auto-suggest.' });
          return;
        }
        const result: PickResult = {
          selector: d.selector,
          matches: d.matches,
          attributes: Array.isArray(d.attributes) ? d.attributes : undefined,
          sampleText: d.sampleText,
          sampleHtml: d.sampleHtml,
          mode: d.mode,
          refinedFromHighlight: d.refinedFromHighlight || null,
        };
        setSelected(result);
        // 🧩 Row (2 clicks): LCA wrapper is an explicit row-container — auto-apply + warn if ≤1.
        if (d.mode === 'row-lca') {
          const n = typeof d.matches === 'number' ? d.matches : 0;
          if (n <= 1) {
            setStatus({
              kind: 'error',
              text: `🧩 Row container matched only ${n} element — that's not a repeating wrapper. Click two parts of ONE row (closer together), or switch to parallelSelect for split rows.`,
            });
          } else {
            setStatus({ kind: 'info', text: `🧩 Row container set (${n} rows): ${d.selector}` });
          }
          onPick?.(result);
          return;
        }
        // Single-field pick: hand back + trigger auto body-selector suggestion for long text.
        onPick?.(result);
        const textLen = typeof d.fullTextLen === 'number' ? d.fullTextLen : (d.sampleText || '').length;
        if (textLen >= 250) {
          suggestBodySelector(d.selector, d.sampleHtmlFull || d.sampleHtml || '');
        }
        return;
      }

      if (d.type === 'webrobot-pick-multi-field-refine') {
        // picker.js generalised an existing field's selector (same logical column, new row).
        if (typeof d.index === 'number') {
          const cur = fieldsRef.current;
          if (cur[d.index]) {
            const next = cur.slice();
            next[d.index] = { ...next[d.index], selector: d.selector, ...(d.matches != null ? { _matches: d.matches } : {}) };
            updateFields(next);
          }
        }
        return;
      }

      if (d.type === 'webrobot-pick-multi-field') {
        // Accumulate: append a new field UNLESS the selector is already present (dedup).
        const cur = fieldsRef.current;
        const incoming = (d.selector || '').trim();
        if (incoming && cur.some((f) => (f.selector || '').trim() === incoming)) {
          setStatus({ kind: 'info', text: 'Selector already in the fields list — duplicate skipped.' });
          return;
        }
        const field: PickField = {
          selector: d.selector,
          as: guessFieldName(d.sampleText, cur.length),
          method: guessFieldMethod(d),
          _color: d.color,
          _sample: d.sampleText,
          _sampleHtml: d.sampleHtml || d.sampleHtmlFull || null,
          _parallel: !!d.parallel,
          _attrs: Array.isArray(d.attributes) ? d.attributes : [],
        };
        updateFields([...cur, field]);
        return;
      }

      if (d.type === 'webrobot-picker-field-samples') {
        // Fill the sample column for LLM-suggested selectors (index-aligned).
        const cur = fieldsRef.current;
        const samples: Array<{ text?: string; html?: string }> = Array.isArray(d.samples) ? d.samples : [];
        if (samples.length) {
          const next = cur.map((f, i) => {
            const s = samples[i];
            if (!s) return f;
            return { ...f, ...(s.text ? { _sample: s.text } : {}), ...(s.html ? { _sampleHtml: s.html } : {}) };
          });
          updateFields(next);
        }
        return;
      }

      if (d.type === 'webrobot-picker-multi-warn') {
        setStatus({ kind: 'error', text: d.warn || 'click was outside the segment container' });
        return;
      }

      if (d.type === 'webrobot-picker-multi-rows') {
        const n = typeof d.count === 'number' ? d.count : 0;
        setStatus({
          kind: n > 0 ? 'info' : 'error',
          text: n > 0
            ? `Picker tracking ${n} row${n === 1 ? '' : 's'} via container selector.`
            : 'Picker tracking 0 rows — the container selector matches nothing on this page.',
        });
        return;
      }

      if (d.type === 'webrobot-pick-multi-sample') {
        const s: MultiSampleStatus = {
          selector: d.selector || null,
          matches: typeof d.matches === 'number' ? d.matches : 0,
          samples: typeof d.samples === 'number' ? d.samples : 0,
          sampleText: d.sampleText || '',
        };
        setMultiSampleStatus(s);
        onMultiSample?.(s);
        return;
      }

      if (d.type === 'webrobot-step-request') {
        // Legacy auto-send path (defensive no-op-by-default) — same trace filter as manual Send.
        if (sessionIdRef.current && (d.action || (Array.isArray(d.actions) && d.actions.length))) {
          let batch: PickerAction[] = Array.isArray(d.actions) ? d.actions.slice() : [d.action];
          if (!antiBotRef.current) batch = batch.filter((a) => a && a.type && TRACE_TYPES.has(a.type));
          if (batch.length) {
            setStagedActions([]);
            forwardStep(batch);
          }
        }
        return;
      }

      if (d.type === 'webrobot-pick-actions') {
        setStagedActions(Array.isArray(d.actions) ? d.actions : []);
        return;
      }

      if (d.type === 'webrobot-picker-navigation') {
        // Page reloading in action mode — buffer already received.
        return;
      }

      if (d.type === 'webrobot-picker-anti-bot-detected') {
        onAntiBotDetected(d.reason || 'unknown');
        return;
      }

      if (d.type === 'webrobot-picker-resume-request') {
        resumeAfterCaptcha();
        return;
      }

      if (d.type === 'webrobot-picker-ready') {
        // Iframe (re)loaded — echo the current mode, re-push container config, re-send block,
        // and re-paint saved field seeds. Covers the /cmf/step srcdoc replacement.
        const ifrMode: PickerMode = pickerModeRef.current || 'selector-single';
        const lm = linkModeRef.current;
        try { ev.source?.postMessage({ type: 'webrobot-picker-mode', mode: ifrMode, linkMode: lm }, { targetOrigin: '*' } as WindowPostMessageOptions); } catch { /* ignore */ }

        const isFieldCtx = ifrMode === 'multi-field' || intendedModeRef.current === 'multi-field';
        if (isFieldCtx) {
          try { ev.source?.postMessage({ type: 'webrobot-picker-multi-config', containerSelector: containerRef.current || null }, { targetOrigin: '*' } as WindowPostMessageOptions); } catch { /* ignore */ }
        }
        if (blockRef.current) {
          try { ev.source?.postMessage({ type: 'webrobot-picker-block', block: blockRef.current }, { targetOrigin: '*' } as WindowPostMessageOptions); } catch { /* ignore */ }
        }
        if (isFieldCtx) {
          const seeds = (restoreFieldsRef.current || fieldsRef.current).filter((f) => (f.selector || '').trim());
          if (seeds.length) {
            try {
              ev.source?.postMessage(
                {
                  type: 'webrobot-picker-multi-restore',
                  fields: seeds.map((f) => ({ selector: f.selector, color: f._color || null, label: f.as || null, sampleText: f._sample || null })),
                },
                { targetOrigin: '*' } as WindowPostMessageOptions,
              );
            } catch { /* ignore */ }
          }
        }
        return;
      }

      if (d.type === 'webrobot-picker-cancel') {
        onClose();
        return;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [
    handleGeneralizeRequest,
    onMarketBox,
    onMacroBox,
    onPick,
    onMultiSample,
    onClose,
    sendHighlight,
    updateFields,
    forwardStep,
    onAntiBotDetected,
    resumeAfterCaptcha,
    suggestBodySelector,
  ]);

  // ── Mode switching ─────────────────────────────────────────────────────────
  const changePickerMode = useCallback(
    (m: PickerMode) => {
      setPickerMode(m);
      pickerModeRef.current = m;
      if (m !== 'action-record') {
        setIntendedMode(null);
        intendedModeRef.current = null;
      }
      const ifrMode = m;
      post({ type: 'webrobot-picker-mode', mode: ifrMode, linkMode: linkModeRef.current });
      if (m === 'action-record') setSelected(null);
      if (m !== 'action-record') setStagedActions([]);
      if (m !== 'multi-sample') {
        setMultiSampleStatus({ selector: null, matches: 0, samples: 0, sampleText: '' });
      }
    },
    [post],
  );

  // "📌 Start picking" — promote from navigate-first action-record into the intended mode.
  const promoteToIntendedMode = useCallback(() => {
    const m = intendedModeRef.current;
    if (!m) return;
    setIntendedMode(null);
    intendedModeRef.current = null;
    if (m === 'multi-field') {
      setPickerMode('multi-field');
      pickerModeRef.current = 'multi-field';
      // Push mode FIRST, then the container config + any saved seeds.
      post({ type: 'webrobot-picker-mode', mode: 'multi-field', linkMode: false });
      post({ type: 'webrobot-picker-multi-config', containerSelector: containerRef.current || null });
      const seeds = (restoreFieldsRef.current || fieldsRef.current).filter((f) => (f.selector || '').trim());
      if (seeds.length) {
        post({
          type: 'webrobot-picker-multi-restore',
          fields: seeds.map((f) => ({ selector: f.selector, color: f._color || null, label: f.as || null, sampleText: f._sample || null })),
        });
      }
    } else {
      changePickerMode(m);
    }
  }, [post, changePickerMode]);

  // ── Multi-sample controls ──────────────────────────────────────────────────
  const clearMultiSamples = useCallback(() => {
    changePickerMode('selector-single');
    changePickerMode('multi-sample');
  }, [changePickerMode]);

  const applyMultiSample = useCallback(() => {
    const sel = multiSampleStatus.selector;
    if (!sel) { onClose(); return; }
    onPick?.({ selector: sel, matches: multiSampleStatus.matches, sampleText: multiSampleStatus.sampleText });
    onClose();
  }, [multiSampleStatus, onPick, onClose]);

  // ── Macro box → focused AI field inference ─────────────────────────────────
  const selectMacroBox = useCallback(() => {
    pickingMacroRef.current = true;
    post({ type: 'webrobot-picker-mode', mode: 'selector-single', linkMode: false });
    setStatus({ kind: 'info', text: '📦 Click the content region (e.g. the article body) to set the box.' });
  }, [post]);

  const clearMacroBox = useCallback(() => {
    setMacroBox(null);
    onMacroBox?.(null);
    clearHighlight();
  }, [clearHighlight, onMacroBox]);

  const runAutoSuggestFields = useCallback(async () => {
    const intent = aiIntent.trim();
    if (!intent) { setStatus({ kind: 'error', text: 'Describe which fields to extract in the intent box.' }); return; }
    if (!macroBox) { setStatus({ kind: 'error', text: 'Select a content box first (📦).' }); return; }
    setAiLoading(true);
    try {
      const body: Record<string, unknown> = {
        url: loadedUrlRef.current || '',
        html: (macroBox && macroBox.html) || null,
        intent,
      };
      if (containerRef.current) body.container_selector = containerRef.current;
      const j = await wizardInferFields(body);
      if (!j || j.error) throw new Error(j?.error || 'infer-fields failed');
      const inferred: Array<Record<string, any>> = (j.llm && j.llm.length ? j.llm : j.algo) || [];
      const next: PickField[] = inferred.map((f) => ({
        selector: f.selector || '',
        as: f.as || 'field',
        method: f.method || 'text',
        _sample: f.sample || null,
      }));
      updateFields(next);
      const container = containerRef.current;
      const layers = next.map((f, i) => ({
        selector: container ? `${container} ${f.selector}` : f.selector,
        color: FIELD_PALETTE[i % FIELD_PALETTE.length],
        label: f.as,
      }));
      sendHighlight(layers);
      // Ask the iframe to resolve the selectors on the page and bounce back samples.
      const sampleSels = next.map((f) => (container ? `${container} ${f.selector}` : f.selector));
      post({ type: 'webrobot-picker-sample-fields', selectors: sampleSels });
    } catch (e) {
      setStatus({ kind: 'error', text: 'Error: ' + ((e as Error).message || String(e)) });
    } finally {
      setAiLoading(false);
    }
  }, [aiIntent, macroBox, updateFields, sendHighlight, post]);

  const removeField = useCallback(
    (fIdx: number) => {
      const next = fieldsRef.current.slice();
      next.splice(fIdx, 1);
      updateFields(next);
    },
    [updateFields],
  );

  const updateFieldAs = useCallback(
    (fIdx: number, value: string) => {
      const next = fieldsRef.current.slice();
      if (next[fIdx]) { next[fIdx] = { ...next[fIdx], as: value }; updateFields(next); }
    },
    [updateFields],
  );

  const applyPickedSelector = useCallback(() => {
    if (!selected) { onClose(); return; }
    onPick?.(selected);
    onClose();
  }, [selected, onPick, onClose]);

  const src = sessionId ? wizardIframeSrc(sessionId, `?_v=${reloadKey}`) : '';
  const loadingLabel =
    loadingKind === 'open' ? 'Loading page via Camoufox…' : 'Applying action and re-rendering page…';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/40" onClick={onClose}>
      <div
        className="m-auto flex h-[90vh] w-[92vw] max-w-6xl flex-col rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* URL / toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadUrl()}
            placeholder="https://page-to-pick-from.example.com"
            className="min-w-[240px] flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          <button
            onClick={loadUrl}
            disabled={loading}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {loading ? 'Opening…' : 'Load page'}
          </button>
          {loadedUrl && (
            <button
              onClick={goBack}
              disabled={loading || !sessionId}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
              title="Go back in the server-side browser history"
            >
              ← Back
            </button>
          )}
          <button onClick={onClose} className="rounded px-2 py-1.5 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>

        {/* Address bar */}
        {loadedUrl && (
          <div className="flex items-center gap-2 border-b bg-slate-50 px-3 py-1 text-xs text-slate-500">
            <span>URL:</span>
            <code className="truncate" title={loadedUrl}>{loadedUrl}</code>
          </div>
        )}

        {/* Status / error banners */}
        {error && !sessionId && (
          <div className="bg-red-50 px-3 py-1.5 text-sm text-red-700">Load failed: {error}</div>
        )}
        {status && (
          <div
            className={
              'px-3 py-1.5 text-sm ' +
              (status.kind === 'error'
                ? 'bg-red-50 text-red-700'
                : status.kind === 'warn'
                ? 'bg-amber-50 text-amber-800'
                : status.kind === 'ok'
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-slate-50 text-slate-700')
            }
          >
            {status.text}
          </div>
        )}

        {/* Captcha / WAF block banner */}
        {block && (
          <div className="flex items-center justify-between gap-2 bg-amber-100 px-3 py-2 text-sm text-amber-900">
            <span>🛑 Blocked ({block.kind || 'captcha'}). Solve it in the mirror below, then resume.</span>
            <button
              onClick={resumeAfterCaptcha}
              disabled={resumeBusy}
              className="rounded bg-amber-600 px-3 py-1 text-white disabled:opacity-50"
            >
              {resumeBusy ? 'Resuming…' : 'Resolved, resume'}
            </button>
          </div>
        )}

        {/* Anti-bot warning */}
        {antiBot.detected && (
          <div className="bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
            🤖 Anti-bot detected ({antiBot.reason}) — raw-event capture. Tag the pipeline HITL-required.
          </div>
        )}

        {/* "Start picking" navigate-first CTA */}
        {intendedMode && loadedUrl && (
          <div className="flex items-center gap-2 border-b bg-indigo-50 px-3 py-2 text-sm text-indigo-800">
            <span>Navigate to the target page, then arm selection:</span>
            <button onClick={promoteToIntendedMode} className="rounded bg-indigo-600 px-3 py-1 text-white">
              📌 Start {intendedMode === 'multi-field' ? 'field selection' : intendedMode === 'multi-sample' ? 'multi-link sampling' : 'selector picking'}
            </button>
          </div>
        )}

        {/* Iframe / empty / loading */}
        <div className="relative min-h-0 flex-1">
          {!sessionId && !error && (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              Enter a URL and Load the page. The page renders in a sandboxed iframe via Camoufox.
            </div>
          )}
          {sessionId && (
            <iframe
              ref={iframeRef}
              id="wr-picker-iframe"
              name="wr-picker-iframe"
              key={reloadKey}
              src={src}
              title="selector picker"
              onLoad={onPickerIframeLoad}
              className="h-full w-full"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            />
          )}
          {loading && loadedUrl && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/70">
              <div className="rounded bg-white px-4 py-3 text-sm shadow">{loadingLabel}</div>
            </div>
          )}
        </div>

        {/* ── action-record: staged actions panel ── */}
        {pickerMode === 'action-record' && loadedUrl && (
          <div className="border-t px-3 py-2 text-sm">
            <div className="mb-1 flex items-center gap-2">
              <strong>⏺ Staged actions ({stagedActions.length})</strong>
              <button onClick={sendStagedActions} disabled={loading || !stagedActions.length} className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">
                ▶ Send
              </button>
              <button onClick={clearStagedActions} disabled={!stagedActions.length} className="rounded border px-2 py-1 disabled:opacity-50">
                Clear staged
              </button>
              <button onClick={stopActionRecording} className="rounded border px-2 py-1">
                ⏹ Stop recording
              </button>
            </div>
            {stagedActions.length > 0 && (
              <ul className="max-h-24 overflow-auto text-xs text-slate-600">
                {stagedActions.map((a, i) => (
                  <li key={i}>
                    {a.type}
                    {a.selector ? ` · ${a.selector}` : ''}
                    {a.text ? ` · "${a.text}"` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── selector result panel ── */}
        {selected && pickerMode !== 'action-record' && pickerMode !== 'multi-field' && pickerMode !== 'multi-sample' && (
          <div className="border-t px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <code className="rounded bg-slate-100 px-1.5 py-0.5">{selected.selector}</code>
              <span className="text-xs text-slate-500">
                {selected.matches} match{selected.matches === 1 ? '' : 'es'}
              </span>
            </div>
            {selected.sampleText && <div className="mt-1 truncate text-xs text-slate-500">{selected.sampleText}</div>}
            <div className="mt-2 flex gap-2">
              <button onClick={applyPickedSelector} className="rounded bg-blue-600 px-3 py-1 text-white">
                Use this selector
              </button>
              <button onClick={() => setSelected(null)} className="rounded border px-2 py-1">
                Clear
              </button>
            </div>
          </div>
        )}

        {/* ── multi-sample panel ── */}
        {pickerMode === 'multi-sample' && (
          <div className="border-t px-3 py-2 text-sm">
            <strong>📍 Repeating-link sampler</strong>
            <div className="mt-1 text-xs text-slate-500">
              Click 2+ examples of the same repeating element. The picker grows a selector that matches all clicked samples.
            </div>
            {multiSampleStatus.samples > 0 && (
              <div className="mt-1 flex items-center gap-2">
                <code className="rounded bg-slate-100 px-1.5 py-0.5">{multiSampleStatus.selector || '— no common selector yet —'}</code>
                <span className="text-xs text-slate-500">
                  {multiSampleStatus.samples} sample{multiSampleStatus.samples === 1 ? '' : 's'} · {multiSampleStatus.matches} match
                  {multiSampleStatus.matches === 1 ? '' : 'es'}
                </span>
              </div>
            )}
            {multiSampleStatus.sampleText && <div className="mt-1 truncate text-xs text-slate-500">{multiSampleStatus.sampleText}</div>}
            <div className="mt-2 flex gap-2">
              <button onClick={applyMultiSample} disabled={!multiSampleStatus.selector} className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">
                Use this selector
              </button>
              <button onClick={clearMultiSamples} className="rounded border px-2 py-1">
                Clear samples
              </button>
            </div>
          </div>
        )}

        {/* ── multi-field panel ── */}
        {pickerMode === 'multi-field' && (
          <div className="border-t px-3 py-2 text-sm">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <strong>🎯 Multi-field picker</strong>
              <button onClick={selectMacroBox} className="rounded border px-2 py-1" title="Click the content region — AI infers fields from THAT box only.">
                {macroBox ? '📦 Content box ✓ (re-pick)' : '📦 Select content box'}
              </button>
              {macroBox && (
                <button onClick={clearMacroBox} className="rounded border px-2 py-1" title="Clear content box">
                  ✕
                </button>
              )}
              <input
                value={aiIntent}
                onChange={(e) => setAiIntent(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && macroBox && runAutoSuggestFields()}
                placeholder="describe the fields (e.g. name, price, rating, link)"
                className="min-w-[200px] flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
              />
              <button
                onClick={runAutoSuggestFields}
                disabled={aiLoading || !aiIntent.trim() || !macroBox}
                className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
              >
                {aiLoading ? 'Thinking…' : '🪄 Auto-suggest fields'}
              </button>
              <button onClick={onClose} className="rounded border px-2 py-1">
                ✅ Done
              </button>
            </div>
            <div className="text-xs text-slate-500">Click each field on the page to add it. Edit names below.</div>
            {fields.length > 0 && (
              <table className="mt-2 w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-400">
                    <th></th>
                    <th>as (column)</th>
                    <th>selector</th>
                    <th>sample</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f, fIdx) => (
                    <tr key={fIdx}>
                      <td>
                        <span className="inline-block h-3 w-3 rounded-full" style={{ background: f._color || '#bbb' }} />
                      </td>
                      <td>
                        <input
                          value={f.as}
                          onChange={(e) => updateFieldAs(fIdx, e.target.value)}
                          placeholder="column"
                          className="w-full rounded border border-slate-300 px-1 py-0.5"
                        />
                      </td>
                      <td>
                        <code title={f.selector}>
                          {(f.selector || '').slice(0, 60)}
                          {(f.selector || '').length > 60 ? '…' : ''}
                        </code>
                      </td>
                      <td className="truncate" title={f._sample || ''}>
                        {(f._sample || '').slice(0, 32)}
                      </td>
                      <td>
                        <button onClick={() => removeField(fIdx)} className="rounded bg-red-500 px-1.5 py-0.5 text-white">
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
