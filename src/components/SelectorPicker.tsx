'use client';

/**
 * Visual selector picker — CORE flow. Opens a live proxied browser session (Camoufox via CMF),
 * shows the target page in an iframe, and returns the CSS selector of the element the user
 * clicks. The in-iframe picker script is injected server-side by the /tenant/wizard/iframe
 * endpoint; this component is only the HOST side: open a session, arm single-selector mode,
 * receive `webrobot-pick-selector`, hand it back.
 *
 * SCOPE — this is the single-field core (open → navigate → pick one selector), the ~80% case.
 * The Vue original also has: 2-click row/LCA containers, multi-field accumulation, oddsSelect
 * market boxes, macro content-box for AI field inference, LLM "generalize" round-trips, action
 * recording (navigate-first), and session pause/resume across stages. Those are layered on top
 * of this same postMessage bridge and land as follow-ons.
 *
 * ⚠️ This is inherently interactive — its whole value is clicking in a live iframe — so it MUST
 * be validated in a browser against a real page. It is additive (behind a "pick" button) and
 * cannot break anything else if it misbehaves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { wizardCmfOpen, wizardCmfClose, wizardIframeSrc, TenantStudioError } from '../client';

interface PickResult {
  selector: string;
  matches?: number;
  attributes?: string[];
  sampleText?: string;
}

export default function SelectorPicker({
  initialUrl = '',
  geo,
  onPick,
  onClose,
}: {
  initialUrl?: string;
  geo?: string;
  onPick: (r: PickResult) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Close the live session on unmount, so a parked Camoufox session is not leaked.
  const closeSession = useCallback((sid: string | null) => {
    if (sid) wizardCmfClose(sid).catch(() => {});
  }, []);
  useEffect(() => () => closeSession(sessionId), [sessionId, closeSession]);

  const open = useCallback(async () => {
    const u = url.trim();
    if (!/^https?:\/\//.test(u)) { setError('Enter an http(s) URL.'); return; }
    setLoading(true);
    setError(null);
    if (sessionId) closeSession(sessionId);
    try {
      const j = await wizardCmfOpen(geo ? { url: u, country: geo } : { url: u });
      const sid = j?.session_id || null;
      if (!sid) throw new Error('no session id from cmf/open');
      setSessionId(sid);
      setReloadKey((k) => k + 1); // force iframe src refresh at the new session
    } catch (e) {
      setError(e instanceof TenantStudioError ? `open → ${e.status}` : 'Could not open the page.');
    } finally {
      setLoading(false);
    }
  }, [url, geo, sessionId, closeSession]);

  // Arm single-selector picking once the in-iframe script signals ready, and route picks back.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const d = ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'webrobot-picker-ready') {
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'webrobot-picker-mode', mode: 'selector-single', linkMode: false }, '*');
        return;
      }
      if (d.type === 'webrobot-pick-selector' && typeof d.selector === 'string') {
        onPick({
          selector: d.selector,
          matches: d.matches,
          attributes: Array.isArray(d.attributes) ? d.attributes : undefined,
          sampleText: d.sampleText,
        });
        closeSession(sessionId);
        onClose();
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sessionId, onPick, onClose, closeSession]);

  const src = sessionId ? wizardIframeSrc(sessionId, `?_v=${reloadKey}`) : '';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/40" onClick={onClose}>
      <div className="m-auto flex h-[85vh] w-[90vw] max-w-5xl flex-col rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && open()}
            placeholder="https://page-to-pick-from.example.com"
            className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          <button onClick={open} disabled={loading}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {loading ? 'Opening…' : 'Load page'}
          </button>
          <button onClick={onClose} className="rounded px-2 py-1.5 text-slate-400 hover:bg-slate-100">✕</button>
        </div>
        {error && <div className="bg-red-50 px-3 py-1.5 text-sm text-red-700">{error}</div>}
        {!sessionId && !error && (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
            Enter a URL and Load the page, then click the element to capture its selector.
          </div>
        )}
        {sessionId && (
          <iframe
            ref={iframeRef}
            key={reloadKey}
            src={src}
            title="selector picker"
            className="min-h-0 flex-1 w-full rounded-b-lg"
            sandbox="allow-same-origin allow-scripts allow-forms"
          />
        )}
      </div>
    </div>
  );
}
