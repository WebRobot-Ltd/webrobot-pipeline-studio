'use client';

/**
 * Section 1 of the native pipeline designer — "Execute existing pipelines".
 *
 * First screen ported from the Vue DemoApp (loadPipelines / onPipelineSelected /
 * executePipeline), now against the org-scoped /tenant API instead of the public /demo one.
 * The rest of the designer (build wizard, results) follows the same pattern on top of the
 * shared client; this section is the proof that the pattern holds end to end.
 *
 * Deliberately plain-React and self-contained: no global store yet. State is promoted to a
 * store only once a second section needs to share it, so the shape is driven by real reuse
 * rather than guessed up front.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listPipelines,
  executePipeline,
  getExecutionStatus,
  getExecutionLogs,
  getExecutionOutput,
  cancelExecution,
  TenantStudioError,
} from '../client';
import {
  Pipeline,
  ExecutionMode,
  WizRuntime,
  mapPipeline,
  groupByCategory,
} from '../types';

export default function ExistingPipelines() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');

  const [executionMode, setExecutionMode] = useState<ExecutionMode>('shared');
  const [wizRuntime, setWizRuntime] = useState<WizRuntime>('spark');

  const [executing, setExecuting] = useState(false);
  const [execId, setExecId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('idle');
  const [logs, setLogs] = useState('');
  const [output, setOutput] = useState<unknown>(null);
  const [execError, setExecError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selected = pipelines.find((p) => p.id === selectedId) || null;
  const groups = groupByCategory(pipelines);

  const loadPipelines = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await listPipelines();
      const demos: any[] = data?.demos || [];
      setPipelines(demos.map(mapPipeline));
    } catch (e) {
      setLoadError(e instanceof TenantStudioError ? `${e.status}` : 'Failed to load pipelines');
      setPipelines([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPipelines();
  }, [loadPipelines]);

  // Stop polling on unmount.
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const beginPolling = useCallback((id: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const st = await getExecutionStatus(id);
        const s = String(st?.status || st?.state || '').toLowerCase();
        setStatus(s || 'running');
        try { setLogs(await getExecutionLogs(id)); } catch { /* logs are best-effort */ }

        if (['succeeded', 'success', 'completed', 'failed', 'error', 'cancelled'].includes(s)) {
          stopPolling();
          setExecuting(false);
          if (['succeeded', 'success', 'completed'].includes(s)) {
            try { setOutput(await getExecutionOutput(id)); } catch { /* output optional */ }
          }
        }
      } catch (e) {
        // A transient status error should not kill the run view; surface it and keep polling.
        setExecError(e instanceof TenantStudioError ? `status ${e.status}` : 'status check failed');
      }
    }, 2500);
  }, []);

  const handleExecute = useCallback(async () => {
    if (!selected) return;
    setExecuting(true);
    setExecError(null);
    setLogs('');
    setOutput(null);
    setStatus('running');
    try {
      const res = await executePipeline(selected.id, {
        executionMode,
        runtime: wizRuntime,
      });
      const id = res?.executionId || res?.execution_id || res?.id;
      if (!id) throw new TenantStudioError(500, 'no execution id returned');
      setExecId(id);
      beginPolling(id);
    } catch (e) {
      setExecuting(false);
      setStatus('failed');
      setExecError(
        e instanceof TenantStudioError ? `execute → ${e.status}` : 'Failed to start execution',
      );
    }
  }, [selected, executionMode, wizRuntime, beginPolling]);

  const handleCancel = useCallback(async () => {
    if (!execId) return;
    try { await cancelExecution(execId); } catch { /* best-effort */ }
    stopPolling();
    setExecuting(false);
    setStatus('cancelled');
  }, [execId]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-800">Execute existing pipelines</h2>
        <button
          onClick={loadPipelines}
          className="text-xs px-2 py-1 rounded border border-slate-200 hover:bg-slate-50"
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {loadError && (
        <p className="text-sm text-red-600 mb-3">Could not load pipelines ({loadError}).</p>
      )}

      <label className="block text-sm text-slate-600 mb-1">Pipeline</label>
      <select
        value={selectedId}
        onChange={(e) => setSelectedId(e.target.value)}
        disabled={pipelines.length === 0 || executing}
        className="w-full rounded border border-slate-300 px-3 py-2 text-sm mb-4"
      >
        <option value="">Select a pipeline…</option>
        {groups.map((g) => (
          <optgroup key={String(g.categoryId ?? g.categoryName)} label={g.categoryName}>
            {g.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.isDraft ? ' (draft)' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {selected && (
        <div className="mb-4 text-sm text-slate-600">
          <p className="mb-2">{selected.description}</p>
          {selected.stages.length > 0 && (
            <p className="text-xs text-slate-500">{selected.stages.length} stage(s)</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Execution mode</label>
          <select
            value={executionMode}
            onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
            disabled={executing}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="shared">Shared Spark cluster</option>
            <option value="byoc">BYOC ephemeral VMs</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Runtime</label>
          <select
            value={wizRuntime}
            onChange={(e) => setWizRuntime(e.target.value as WizRuntime)}
            disabled={executing}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="spark">Spark</option>
            <option value="ray_actor">Ray actor</option>
          </select>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleExecute}
          disabled={!selected || executing}
          className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
        >
          {executing ? 'Running…' : 'Execute'}
        </button>
        {executing && (
          <button
            onClick={handleCancel}
            className="px-4 py-2 rounded border border-red-300 text-red-600 text-sm"
          >
            Cancel
          </button>
        )}
      </div>

      {(execId || execError) && (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <div className="flex items-center gap-2 text-sm mb-2">
            <span className="text-slate-500">Status:</span>
            <span className="font-medium text-slate-800">{status}</span>
            {execId && <span className="text-xs text-slate-400">({execId})</span>}
          </div>
          {execError && <p className="text-sm text-red-600 mb-2">{execError}</p>}
          {logs && (
            <pre className="max-h-64 overflow-auto rounded bg-slate-900 text-slate-100 text-xs p-3 whitespace-pre-wrap">
              {logs}
            </pre>
          )}
          {output != null && (
            <details className="mt-2">
              <summary className="text-sm text-slate-600 cursor-pointer">Output</summary>
              <pre className="max-h-64 overflow-auto rounded bg-slate-50 text-xs p-3 mt-1">
                {JSON.stringify(output, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
