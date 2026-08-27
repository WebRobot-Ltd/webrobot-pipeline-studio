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

/* ────────────────────────────────────────────────────────────────────────────
 * parsePipelineFromYaml — the inverse of buildYamlFromPipeline.
 *
 * The generator hand-emits a tightly constrained subset of YAML (fixed 2-space
 * indentation, inline `{ key: value }` maps, positional args carrying `# name`
 * comments). Rather than pull in a YAML library — the package deliberately has
 * none — this parser inverts exactly that subset, line by line, so the pair
 * satisfies the round-trip invariant covered by yaml.test.mjs.
 *
 * It reconstructs the visual `PipelineRow[]` model: per-stage args, `_fields`
 * (extract / flatSelect / parallelSelect), `_markets` (oddsSelect), embedded
 * `_trace` actions on fetch-like stages, multi-source `_src` grouping, and the
 * per-row anti-bot / HITL flags carried in the `metadata` block.
 * ──────────────────────────────────────────────────────────────────────────── */

interface PLine { indent: number; text: string; }

function toPLines(src: string[]): PLine[] {
  const out: PLine[] = [];
  for (const raw of src) {
    const m = /^(\s*)(.*)$/.exec(raw);
    const indent = m ? m[1].length : 0;
    const text = m ? m[2] : raw;
    if (text === '') continue;                 // blank lines never carry meaning here
    if (text.startsWith('#')) continue;        // full-line comments (e.g. the parallelSelect note)
    out.push({ indent, text });
  }
  return out;
}

/** Unescape a single scalar as emitted by yamlScalar (quoted string or bareword). */
function parseScalarStr(tokRaw: string): string {
  const tok = tokRaw.trim();
  if (tok.startsWith('"')) {
    let out = '';
    let i = 1;
    while (i < tok.length) {
      const c = tok[i];
      if (c === '\\') {
        const n = tok[i + 1];
        if (n === '"') { out += '"'; i += 2; continue; }
        if (n === '\\') { out += '\\'; i += 2; continue; }
        out += n ?? ''; i += 2; continue;
      }
      if (c === '"') break;
      out += c; i += 1;
    }
    return out;
  }
  return tok;
}

/** Split on a top-level separator, honouring double-quoted spans (with escapes). */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '\\') { cur += c + (s[i + 1] ?? ''); i += 1; continue; }
      if (c === '"') inQuote = false;
      cur += c; continue;
    }
    if (c === '"') { inQuote = true; cur += c; continue; }
    if (c === sep) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Parse an inline `{ key: value, key: value }` map (values are yamlScalar output). */
function parseInlineMap(str: string): Record<string, string> {
  const inner = str.trim().replace(/^\{/, '').replace(/\}$/, '');
  const map: Record<string, string> = {};
  for (const piece of splitTopLevel(inner, ',')) {
    const p = piece.trim();
    if (!p) continue;
    const ci = p.indexOf(':');
    if (ci < 0) continue;
    const key = p.slice(0, ci).trim();
    map[key] = parseScalarStr(p.slice(ci + 1));
  }
  return map;
}

/** Split a `- value    # name` line into its scalar value and comment name. */
function splitValueComment(afterDash: string): { value: string; name?: string } {
  const idx = afterDash.lastIndexOf('    #');
  if (idx < 0) return { value: afterDash.trim() };
  return {
    value: afterDash.slice(0, idx).trim(),
    name: afterDash.slice(idx + '    #'.length).trim(),
  };
}

function parseFieldMap(headText: string): PipelineField {
  const brace = headText.slice(headText.indexOf('{'));
  const m = parseInlineMap(brace);
  const f: PipelineField = { selector: m.selector ?? '' };
  if (m.method !== undefined) f.method = m.method;
  if (m.as !== undefined) f.as = m.as;
  return f;
}

function traceFromInlineMap(m: Record<string, string>): TraceAction | null {
  switch (m.action) {
    case 'click':
      return { type: 'Click', selector: m.selector };
    case 'input':
      return { type: 'Type', selector: m.selector, text: m.text ?? '' };
    case 'wait':
      return { type: 'Wait', ms: Math.round(Number(m.seconds) * 1000) };
    case 'scroll': {
      const px = Math.abs(Number(m.pixels));
      return { type: 'Scroll', y: m.direction === 'up' ? -px : px };
    }
    default:
      return null;
  }
}

interface Item { head: PLine; sub: PLine[]; }

/** Direct list children (`- …`) of a parent line, each with its deeper sub-lines. */
function childItems(lines: PLine[], parentIndent: number): Item[] {
  const deeper = lines.filter((l) => l.indent > parentIndent);
  const dashes = deeper.filter((l) => l.text.startsWith('-'));
  if (!dashes.length) return [];
  const childIndent = Math.min(...dashes.map((l) => l.indent));
  const items: Item[] = [];
  let cur: Item | null = null;
  for (const l of deeper) {
    if (l.indent === childIndent && l.text.startsWith('-')) {
      if (cur) items.push(cur);
      cur = { head: l, sub: [] };
    } else if (cur) {
      cur.sub.push(l);
    }
  }
  if (cur) items.push(cur);
  return items;
}

function parseMarkets(sub: PLine[]): OddsMarket[] {
  const labelLines = sub.filter((l) => l.text.startsWith('- label:'));
  if (!labelLines.length) return [];
  const labelIndent = Math.min(...labelLines.map((l) => l.indent));
  const groups: PLine[][] = [];
  let cur: PLine[] | null = null;
  for (const l of sub) {
    if (l.indent === labelIndent && l.text.startsWith('- label:')) {
      if (cur) groups.push(cur);
      cur = [l];
    } else if (cur) {
      cur.push(l);
    }
  }
  if (cur) groups.push(cur);

  return groups.map((g) => {
    const head = g[0];
    const label = parseScalarStr(head.text.slice('- label:'.length));
    const secLine = g.find((l) => l.text.startsWith('sectionSelector:'));
    const rowLine = g.find((l) => l.text.startsWith('rowSelector:'));
    const fields = g.filter((l) => l.text.startsWith('- {')).map((l) => parseFieldMap(l.text));
    const market: OddsMarket = {
      label,
      enabled: true,
      sectionSelector: secLine ? parseScalarStr(secLine.text.slice('sectionSelector:'.length)) : '',
      fields,
    };
    if (rowLine) market.rowSelector = parseScalarStr(rowLine.text.slice('rowSelector:'.length));
    return market;
  });
}

/** Parse the body of one `- stage: …` chunk into a PipelineRow. */
function parseChunk(chunk: PLine[]): PipelineRow {
  const header = chunk[0];
  const base = header.indent;
  const stage = header.text.slice('- stage:'.length).trim();
  const body = chunk.slice(1);
  const argsLine = body.find((l) => l.indent === base + 2 && l.text.startsWith('args:'));
  const argsRest = argsLine ? argsLine.text.slice('args:'.length).trim() : '';
  const hasItems = !!argsLine && argsRest === '';
  const items = hasItems ? childItems(body, argsLine!.indent) : [];

  if (stage === 'extract') {
    const _fields = items
      .filter((it) => it.head.text.startsWith('- {'))
      .map((it) => parseFieldMap(it.head.text));
    return { stage: 'extract', args: {}, _fields };
  }

  if (stage === 'parallelSelect') {
    // Emitted only from a flatSelect whose fields are all parallel siblings.
    const marker = items.find((it) => it.head.text === '-') || items[0];
    const _fields = (marker ? marker.sub : [])
      .filter((l) => l.text.startsWith('- {'))
      .map((l) => ({ ...parseFieldMap(l.text), _parallel: true }));
    return { stage: 'flatSelect', args: {}, _fields };
  }

  if (stage === 'flatSelect') {
    const segItem = items[0];
    const seg = segItem ? splitValueComment(segItem.head.text.slice(1)).value : '';
    const fieldsItem = items[1];
    let _fields: PipelineField[] = [];
    if (fieldsItem && fieldsItem.head.text === '-') {
      _fields = fieldsItem.sub
        .filter((l) => l.text.startsWith('- {'))
        .map((l) => parseFieldMap(l.text));
    }
    return { stage: 'flatSelect', args: { segmentSelector: parseScalarStr(seg) }, _fields };
  }

  if (stage === 'oddsSelect' || stage === 'odds_select') {
    const marketsItem = items.find((it) => it.head.text.startsWith('- markets:'));
    const _markets = marketsItem ? parseMarkets(marketsItem.sub) : [];
    return { stage, args: {}, _markets };
  }

  if (stage === 'dedup') {
    const col = items[0] ? parseScalarStr(splitValueComment(items[0].head.text.slice(1)).value) : '';
    return { stage: 'dedup', args: col ? { columns: col } : {} };
  }

  // Generic stage: positional args (recovered from `# name` comments) + optional
  // embedded trace actions on fetch-like stages.
  const args: Record<string, any> = {};
  let _trace: TraceAction[] | undefined;
  let posIndex = 0;
  for (const it of items) {
    if (it.head.text === '-') {
      const actions = it.sub
        .filter((l) => l.text.startsWith('- {'))
        .map((l) => traceFromInlineMap(parseInlineMap(l.text.slice(l.text.indexOf('{')))))
        .filter((a): a is TraceAction => a !== null);
      if (actions.length) _trace = actions;
      continue;
    }
    if (it.head.text.startsWith('- |')) continue; // block scalar (e.g. sql_query) — not a positional arg
    const { value, name } = splitValueComment(it.head.text.slice(1));
    const key = name || String(posIndex);
    args[key] = parseScalarStr(value);
    posIndex += 1;
  }
  const row: PipelineRow = { stage, args };
  if (_trace) row._trace = _trace;
  return row;
}

/** Group a pipeline body (lines under a `pipeline:` key) into per-stage chunks. */
function parsePipelineBlock(lines: PLine[]): PipelineRow[] {
  const stageLines = lines.filter((l) => l.text.startsWith('- stage:'));
  if (!stageLines.length) return [];
  const base = Math.min(...stageLines.map((l) => l.indent));
  const chunks: PLine[][] = [];
  let cur: PLine[] | null = null;
  for (const l of lines) {
    if (l.indent === base && l.text.startsWith('- stage:')) {
      if (cur) chunks.push(cur);
      cur = [l];
    } else if (cur) {
      cur.push(l);
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map(parseChunk);
}

/** Collect the lines belonging to a top-level `key:` block (indent > 0 until next col-0 key). */
function sectionBody(lines: PLine[], startIdx: number): PLine[] {
  const out: PLine[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].indent === 0) break;
    out.push(lines[i]);
  }
  return out;
}

export function parsePipelineFromYaml(yaml: string, _ctx?: YamlContext): PipelineRow[] {
  if (!yaml || !yaml.trim() || yaml.trim() === '(add at least one stage)') return [];
  const lines = toPLines(String(yaml).split('\n'));

  // Top-level anchors.
  const topKeys = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.indent === 0 && /^[a-zA-Z_]+:/.test(l.text));

  const rows: PipelineRow[] = [];
  const sourcesIdx = topKeys.find(({ l }) => l.text === 'sources:');

  if (sourcesIdx) {
    // Multi-source: each `- source: "source_N"` owns a `pipeline:` sub-block; a
    // top-level `pipeline:` (if present) is the shared tail.
    const body = sectionBody(lines, sourcesIdx.i);
    // Group into per-source items keyed by the `- source:` lines.
    const sourceHeads = body.filter((l) => l.text.startsWith('- source:'));
    if (sourceHeads.length) {
      const srcIndent = Math.min(...sourceHeads.map((l) => l.indent));
      let curSrc: number | null = null;
      let bucket: PLine[] = [];
      const flush = () => {
        if (curSrc == null) return;
        // Within the bucket, find the `pipeline:` line and take its deeper lines.
        const pl = bucket.find((l) => l.text === 'pipeline:');
        if (pl) {
          const sub = bucket.filter((l) => l.indent > pl.indent);
          for (const r of parsePipelineBlock(sub)) rows.push({ ...r, _src: curSrc });
        }
      };
      for (const l of body) {
        if (l.indent === srcIndent && l.text.startsWith('- source:')) {
          flush();
          const label = parseScalarStr(l.text.slice('- source:'.length));
          const m = /source_(\d+)/.exec(label);
          curSrc = m ? Number(m[1]) : 1;
          bucket = [];
        } else if (curSrc != null) {
          bucket.push(l);
        }
      }
      flush();
    }
    // Shared tail at top level.
    const tail = topKeys.find(({ l }) => l.text === 'pipeline:');
    if (tail) {
      for (const r of parsePipelineBlock(sectionBody(lines, tail.i))) {
        rows.push({ ...r, _src: 'shared' });
      }
    }
  } else {
    const pipelineIdx = topKeys.find(({ l }) => l.text === 'pipeline:');
    if (pipelineIdx) {
      rows.push(...parsePipelineBlock(sectionBody(lines, pipelineIdx.i)));
    }
  }

  // metadata.requires_hitl / anti_bot_kinds → per-row flags on fetch-like stages.
  const metaIdx = topKeys.find(({ l }) => l.text === 'metadata:');
  if (metaIdx) {
    const meta = sectionBody(lines, metaIdx.i);
    const requiresHitl = meta.some((l) => /^requires_hitl:\s*true$/.test(l.text));
    const kindsLine = meta.find((l) => l.text.startsWith('anti_bot_kinds:'));
    let kinds: string[] = [];
    if (kindsLine) {
      const arr = kindsLine.text.slice('anti_bot_kinds:'.length).trim().replace(/^\[/, '').replace(/\]$/, '');
      kinds = splitTopLevel(arr, ',').map((s) => parseScalarStr(s)).filter((s) => s !== '');
    }
    if (requiresHitl) {
      const fetchIdx = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => FETCH_LIKE_STAGES.has(r.stage))
        .map(({ i }) => i);
      if (kinds.length) {
        kinds.forEach((k, j) => {
          const idx = fetchIdx[j];
          if (idx != null) { rows[idx]._requires_hitl = true; rows[idx]._anti_bot_kind = k; }
        });
      } else if (fetchIdx.length) {
        rows[fetchIdx[0]]._requires_hitl = true;
      }
    }
  }

  return rows;
}
