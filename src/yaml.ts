/**
 * Pipeline → YAML generator, ported faithfully from the Vue DemoApp
 * (buildYamlFromPipeline and its helpers). This is the correctness-critical core of the
 * designer: it turns the visually composed pipeline into the exact YAML the ETL runtime and
 * validator expect. A subtle deviation here produces pipelines that look right and fail at
 * execution, so it is ported verbatim and covered by yaml.test.mjs rather than eyeballed.
 *
 * The Vue version read four reactive globals (python extensions, runtime, geo, HITL). Those
 * are lifted into an explicit `ctx` so this stays a pure function — same output for the same
 * input, which is what makes it testable without a browser.
 */

export interface PyExtension {
  name: string;
  functionBody: string;
  type: 'row_transform' | 'dataframe_transform' | 'sql_query';
}

export interface StageSpec {
  stage_name: string;
  aliases?: string[];
  arg_schema?: { name: string }[];
}

export interface PipelineField {
  selector: string;
  as?: string;
  method?: string;
  _parallel?: boolean;
}

export interface OddsMarket {
  label?: string;
  enabled?: boolean;
  sectionSelector?: string;
  rowSelector?: string;
  fields?: PipelineField[];
}

export interface TraceAction {
  type: 'Click' | 'Type' | 'Wait' | 'Scroll';
  selector?: string;
  text?: string;
  ms?: number;
  y?: number;
}

/** One row of the visual pipeline. Mirrors the Vue wizPipeline element. */
export interface PipelineRow {
  stage: string;
  args: Record<string, any>;
  _src?: number | 'shared';
  _fields?: PipelineField[];
  _markets?: OddsMarket[];
  _trace?: TraceAction[];
  _requires_hitl?: boolean;
  _anti_bot_kind?: string;
}

export interface YamlContext {
  catalog: StageSpec[];
  pythonExtensions?: PyExtension[];
  runtime?: string;   // 'spark' (default, omitted) | 'ray_actor'
  geo?: string;       // 2-letter country code, or empty
  hitlAwait?: boolean;
}

const FETCH_LIKE_STAGES = new Set(['fetch', 'visit', 'wget']);

export function yamlScalar(v: unknown): string {
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (/^(true|false)$/i.test(s)) return s.toLowerCase();
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function srcKey(r: PipelineRow): number {
  if (r && r._src === 'shared') return Number.MAX_SAFE_INTEGER;
  return r && typeof r._src === 'number' ? r._src : 1;
}

export function groupBySource(pipe: PipelineRow[]): PipelineRow[] {
  return [...pipe].sort((a, b) => srcKey(a) - srcKey(b)); // stable
}

export function multiSourceActive(pipe: PipelineRow[]): boolean {
  return pipe.some((r) => r && (r._src === 'shared' || (typeof r._src === 'number' && r._src > 1)));
}

function traceActionToYamlMap(a: TraceAction): string | null {
  if (!a || !a.type) return null;
  if (a.type === 'Click' && a.selector) {
    return `{ action: "click", selector: ${yamlScalar(a.selector)} }`;
  }
  if (a.type === 'Type' && a.selector) {
    return `{ action: "input", selector: ${yamlScalar(a.selector)}, text: ${yamlScalar(a.text || '')} }`;
  }
  if (a.type === 'Wait') {
    const seconds = (a.ms != null ? Number(a.ms) : 1000) / 1000;
    return `{ action: "wait", seconds: ${seconds} }`;
  }
  if (a.type === 'Scroll') {
    const pixels = Math.abs(Number(a.y || 600));
    const direction = Number(a.y || 0) < 0 ? 'up' : 'down';
    return `{ action: "scroll", direction: "${direction}", pixels: ${pixels} }`;
  }
  return null;
}

function emitEmbeddedTraceActions(row: PipelineRow, lines: string[], indent: string): boolean {
  const t = Array.isArray(row._trace) ? row._trace : [];
  const entries = t.map(traceActionToYamlMap).filter(Boolean) as string[];
  if (entries.length === 0) return false;
  lines.push(`${indent}-`);
  for (const e of entries) lines.push(`${indent}  - ${e}`);
  return true;
}

function splitBranchesForYaml(pipeline: PipelineRow[]) {
  const bySrc = new Map<number, PipelineRow[]>();
  const tail: PipelineRow[] = [];
  for (const row of pipeline) {
    const s = row && row._src;
    if (s === 'shared') { tail.push(row); continue; }
    const k = typeof s === 'number' && s > 0 ? s : 1;
    if (!bySrc.has(k)) bySrc.set(k, []);
    bySrc.get(k)!.push(row);
  }
  const sources = Array.from(bySrc.keys()).sort((a, b) => a - b)
    .map((k) => ({ label: 'source_' + k, stages: bySrc.get(k)! }));
  return { sources, tail };
}

function stripBoundaryFlags(stages: PipelineRow[]): PipelineRow[] {
  return stages.map((s) => { const c = { ...s }; delete c._src; return c; });
}

function pipelineSectionLines(yamlStr: string): string[] {
  const all = String(yamlStr).split('\n');
  const start = all.findIndex((l) => l === 'pipeline:');
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < all.length; i++) {
    if (/^\S/.test(all[i])) break;
    out.push(all[i]);
  }
  return out;
}

function buildSourcesYaml(pipeline: PipelineRow[], ctx: YamlContext): string {
  const { sources, tail } = splitBranchesForYaml(pipeline);
  const lines: string[] = [];
  lines.push('sources:');
  for (const b of sources) {
    lines.push(`  - source: ${yamlScalar(b.label)}`);
    lines.push('    pipeline:');
    for (const l of pipelineSectionLines(buildYamlFromPipeline(stripBoundaryFlags(b.stages), ctx)))
      lines.push('    ' + l);
  }
  if (tail.length) {
    lines.push('pipeline:');
    for (const l of pipelineSectionLines(buildYamlFromPipeline(stripBoundaryFlags(tail), ctx)))
      lines.push(l);
  }
  lines.push('output:');
  lines.push('  format: parquet');
  lines.push('  mode: overwrite');
  const metaLines: string[] = [];
  if (ctx.runtime && ctx.runtime !== 'spark') metaLines.push(`  runtime: ${yamlScalar(ctx.runtime)}`);
  if (ctx.geo && /^[a-z]{2}$/i.test(ctx.geo)) metaLines.push(`  geo: ${yamlScalar(ctx.geo.toLowerCase())}`);
  if (metaLines.length) { lines.push('metadata:'); for (const ml of metaLines) lines.push(ml); }
  return lines.join('\n');
}

export function buildYamlFromPipeline(pipeline: PipelineRow[], ctx: YamlContext): string {
  const catalog = ctx.catalog || [];
  if (!pipeline || pipeline.length === 0) return '(add at least one stage)';
  if (multiSourceActive(pipeline)) return buildSourcesYaml(pipeline, ctx);

  const findSpec = (n: string) =>
    catalog.find((s) => s.stage_name === n || (s.aliases || []).includes(n));
  const lines: string[] = [];

  const allExts = (ctx.pythonExtensions || [])
    .filter((e) => (e.name || '').trim() && (e.functionBody || '').trim());
  const pyExts = allExts.filter((e) => e.type === 'row_transform' || e.type === 'dataframe_transform');
  const sqlExts = allExts.filter((e) => e.type === 'sql_query');

  if (pyExts.length) {
    lines.push('python_extensions:');
    lines.push('  stages:');
    for (const ext of pyExts) {
      const argSig = ext.type === 'dataframe_transform' ? 'df, spark' : 'row';
      lines.push(`    ${ext.name}:`);
      lines.push(`      type: ${ext.type}`);
      lines.push('      function: |');
      lines.push(`        def ${ext.name}(${argSig}):`);
      for (const ln of String(ext.functionBody).split('\n')) lines.push('            ' + ln);
    }
  }

  lines.push('pipeline:');
  for (const row of pipeline) {
    const fields = Array.isArray(row._fields)
      ? row._fields.filter((f) => (f.selector || '').trim() !== '')
      : [];

    const flatSplit = row.stage === 'flatSelect' && fields.some((f) => f._parallel);
    lines.push(`  - stage: ${flatSplit ? 'parallelSelect' : row.stage}`);

    if (flatSplit) {
      const seg = (row.args && (row.args.segmentSelector || row.args.selector)) || '';
      lines.push('    # auto: rows split across parallel sibling lists → parallelSelect (zipped by index)');
      lines.push('    args:');
      lines.push('      -');
      for (const f of fields) {
        const sel = f._parallel ? f.selector : (seg ? `${seg} ${f.selector}` : f.selector);
        lines.push(`        - { selector: ${yamlScalar(sel)}, method: ${yamlScalar(f.method || 'text')}, as: ${yamlScalar(f.as || '')} }`);
      }
      continue;
    }

    if (row.stage === 'extract') {
      if (fields.length === 0) {
        lines.push('    args: []');
      } else {
        lines.push('    args:');
        for (const f of fields)
          lines.push(`      - { selector: ${yamlScalar(f.selector)}, method: ${yamlScalar(f.method || 'text')}, as: ${yamlScalar(f.as || '')} }`);
      }
      continue;
    }

    if (row.stage === 'flatSelect') {
      const seg = (row.args && (row.args.segmentSelector || row.args.selector)) || '';
      lines.push('    args:');
      lines.push(`      - ${yamlScalar(seg)}    # segment selector`);
      if (fields.length === 0) {
        lines.push('      - []    # extractors (empty)');
      } else {
        lines.push('      -');
        for (const f of fields)
          lines.push(`        - { selector: ${yamlScalar(f.selector)}, method: ${yamlScalar(f.method || 'text')}, as: ${yamlScalar(f.as || '')} }`);
      }
      continue;
    }

    if (row.stage === 'oddsSelect' || row.stage === 'odds_select') {
      const markets = (Array.isArray(row._markets) ? row._markets : [])
        .filter((m) => m && m.enabled !== false)
        .filter((m) => (m.sectionSelector || '').trim() &&
          Array.isArray(m.fields) && m.fields.some((f) => (f.selector || '').trim()));
      if (markets.length === 0) {
        lines.push('    args: []    # no enabled market with a section + fields yet');
        continue;
      }
      lines.push('    args:');
      lines.push('      - markets:');
      markets.forEach((m, mi) => {
        const label = (m.label || '').trim() || `Market ${mi + 1}`;
        lines.push(`          - label: ${yamlScalar(label)}`);
        lines.push(`            sectionSelector: ${yamlScalar(m.sectionSelector)}`);
        if ((m.rowSelector || '').trim()) lines.push(`            rowSelector: ${yamlScalar(m.rowSelector)}`);
        lines.push('            fields:');
        for (const f of m.fields!.filter((f) => (f.selector || '').trim()))
          lines.push(`              - { selector: ${yamlScalar(f.selector)}, method: ${yamlScalar(f.method || 'text')}, as: ${yamlScalar(f.as || 'field')} }`);
      });
      continue;
    }

    if (row.stage === 'dedup') {
      const col = row.args && (row.args.columns || row.args.column || row.args.by);
      if (col) { lines.push('    args:'); lines.push(`      - ${yamlScalar(col)}`); }
      else lines.push('    args: []');
      continue;
    }

    // Generic stages: positional args from the catalog arg_schema order.
    const spec = findSpec(row.stage);
    const orderedArgNames = ((spec && spec.arg_schema) || []).map((a) => a.name);
    const filled: [string, any][] = [];
    for (const n of orderedArgNames) {
      if (row.args[n] != null && row.args[n] !== '') filled.push([n, row.args[n]]);
    }
    const isFetchLike = FETCH_LIKE_STAGES.has(row.stage);
    const traceLen = isFetchLike && Array.isArray(row._trace) ? row._trace.length : 0;
    if (filled.length === 0 && traceLen === 0) {
      lines.push('    args: []');
    } else {
      lines.push('    args:');
      for (const [n, v] of filled) lines.push(`      - ${yamlScalar(v)}    # ${n}`);
      if (isFetchLike && traceLen > 0) emitEmbeddedTraceActions(row, lines, '      ');
    }
  }

  for (const ext of pyExts) {
    lines.push(`  - stage: python_${ext.type}:${ext.name}`);
    lines.push('    args: []');
  }
  for (const ext of sqlExts) {
    lines.push('  - stage: sql_query');
    lines.push('    args:');
    lines.push('      - |');
    for (const ln of String(ext.functionBody).split('\n')) lines.push('        ' + ln);
  }

  lines.push('output:');
  lines.push('  format: parquet');
  lines.push('  mode: overwrite');

  const metaLines: string[] = [];
  if (ctx.runtime && ctx.runtime !== 'spark') metaLines.push(`  runtime: ${yamlScalar(ctx.runtime)}`);
  if (ctx.geo && /^[a-z]{2}$/i.test(ctx.geo)) metaLines.push(`  geo: ${yamlScalar(ctx.geo.toLowerCase())}`);
  if (ctx.hitlAwait && pipeline.some((r) => r && r._requires_hitl)) {
    metaLines.push('  requires_hitl: true');
    const kinds = pipeline.map((r) => r && r._anti_bot_kind).filter((k) => k) as string[];
    if (kinds.length) metaLines.push(`  anti_bot_kinds: [${kinds.map(yamlScalar).join(', ')}]`);
  }
  if (metaLines.length) { lines.push('metadata:'); for (const ml of metaLines) lines.push(ml); }

  return lines.join('\n');
}
