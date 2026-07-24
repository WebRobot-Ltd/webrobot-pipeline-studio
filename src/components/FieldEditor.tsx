'use client';

/**
 * Field editor for the structured extraction stages (extract / flatSelect / oddsSelect).
 *
 * These stages don't take positional args — they carry a `_fields` list of
 * {selector, as, method} that the YAML generator turns into the extractor block. This is the
 * manual + AI-assisted way to fill that list. The remaining piece, the visual click-to-pick
 * picker (live proxied iframe + highlight overlays via the CMF/proxy endpoints), is the
 * deepest browser-coupled part and lands separately; everything here already produces correct
 * YAML because the generator consumes `_fields` directly.
 *
 * "Infer fields" asks the org wizard's LLM to propose fields from a URL (and, for flatSelect,
 * the segment selector as container so the returned selectors are relative — exactly what the
 * generator expects).
 */
import { useState } from 'react';
import { wizardInferFields, TenantStudioError } from '../client';
import { PipelineRow, PipelineField } from '../yaml';
import SelectorPicker from './SelectorPicker';

const METHODS = ['text', 'html', 'attr:href', 'attr:src', 'attr:title'];

export default function FieldEditor({
  row,
  onChange,
}: {
  row: PipelineRow;
  onChange: (fields: PipelineField[]) => void;
}) {
  const fields = row._fields || [];
  const isFlat = row.stage === 'flatSelect';
  const segment = String((row.args?.segmentSelector || row.args?.selector) || '');

  const [inferUrl, setInferUrl] = useState('');
  const [inferring, setInferring] = useState(false);
  const [inferMsg, setInferMsg] = useState<string | null>(null);
  // Which field row (if any) is currently picking a selector via the visual picker.
  const [pickingIdx, setPickingIdx] = useState<number | null>(null);

  const set = (next: PipelineField[]) => onChange(next);

  const addField = () => set([...fields, { selector: '', as: '', method: 'text' }]);
  const removeField = (i: number) => set(fields.filter((_, idx) => idx !== i));
  const updateField = (i: number, prop: keyof PipelineField, value: string | boolean) =>
    set(fields.map((f, idx) => (idx === i ? { ...f, [prop]: value } : f)));

  const infer = async () => {
    if (!inferUrl.trim()) { setInferMsg('Enter a URL to infer from.'); return; }
    setInferring(true);
    setInferMsg(null);
    try {
      const body: Record<string, unknown> = { url: inferUrl.trim() };
      // flatSelect returns RELATIVE selectors → pass the segment as the container.
      if (isFlat && segment) body.container_selector = segment;
      const j = await wizardInferFields(body);
      const inferred = (j?.llm?.length ? j.llm : j?.algo) || [];
      if (inferred.length === 0) { setInferMsg('No fields inferred — try a clearer page.'); return; }
      set(inferred.map((f: any) => ({
        selector: String(f.selector || ''),
        as: String(f.as || ''),
        method: String(f.method || 'text'),
      })));
      setInferMsg(`Inferred ${inferred.length} field(s).`);
    } catch (e) {
      setInferMsg(e instanceof TenantStudioError ? `infer → ${e.status}` : 'Inference failed');
    } finally {
      setInferring(false);
    }
  };

  return (
    <div className="mt-1 space-y-2">
      <div className="flex items-center gap-1.5">
        <input
          value={inferUrl}
          onChange={(e) => setInferUrl(e.target.value)}
          placeholder="URL to infer fields from…"
          className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs"
        />
        <button
          onClick={infer}
          disabled={inferring}
          className="text-xs px-2 py-1 rounded border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
        >
          {inferring ? '…' : 'Infer fields'}
        </button>
      </div>
      {inferMsg && <p className="text-[11px] text-slate-500">{inferMsg}</p>}

      {fields.length === 0 && (
        <p className="text-[11px] text-slate-400">No fields yet — add one or infer from a URL.</p>
      )}

      {fields.map((f, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto] gap-1.5 items-center">
          <div className="flex items-center gap-1">
            <input
              value={f.selector}
              onChange={(e) => updateField(i, 'selector', e.target.value)}
              placeholder="CSS selector"
              className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs font-mono"
            />
            <button
              type="button"
              title="Pick visually — click the element on a live page"
              onClick={() => setPickingIdx(i)}
              className="shrink-0 rounded border border-blue-200 px-1.5 py-1 text-xs hover:bg-blue-50"
            >
              🎯
            </button>
          </div>
          <input
            value={f.as || ''}
            onChange={(e) => updateField(i, 'as', e.target.value)}
            placeholder="column"
            className="rounded border border-slate-200 px-2 py-1 text-xs"
          />
          <select
            value={f.method || 'text'}
            onChange={(e) => updateField(i, 'method', e.target.value)}
            className="rounded border border-slate-200 px-1 py-1 text-xs"
          >
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button onClick={() => removeField(i)} className="text-xs text-red-400 hover:text-red-600 px-1">✕</button>
          {isFlat && (
            <label className="col-span-4 flex items-center gap-1 text-[10px] text-slate-400 -mt-1">
              <input
                type="checkbox"
                checked={!!f._parallel}
                onChange={(e) => updateField(i, '_parallel', e.target.checked)}
              />
              parallel (picked outside the segment → parallelSelect, zipped by index)
            </label>
          )}
        </div>
      ))}

      <button onClick={addField} className="text-xs text-blue-600 hover:underline">+ add field</button>

      {pickingIdx !== null && (
        <SelectorPicker
          initialUrl={inferUrl}
          onPick={(r) => {
            updateField(pickingIdx, 'selector', r.selector);
            setInferMsg(`Picked: ${r.selector}${r.matches != null ? ` (${r.matches} matches)` : ''}`);
          }}
          onClose={() => setPickingIdx(null)}
        />
      )}
    </div>
  );
}
