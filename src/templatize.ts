/**
 * Templatization of a saved pipeline (user 10-25): turn the literal values the run should take from the
 * input dataset (a search keyword, a URL, a typed text) into per-row `$column` references, so ONE pipeline
 * runs once per dataset row.
 *
 * Ported from the Vue demo (DemoApp.vue: rewriteYamlVariables / ensureInputLoaderInYaml), which the
 * console never inherited, plus the case the Vue code got wrong: a keyword INSIDE a URL. The ETL resolves
 * `$col` only when it is the WHOLE value (`url: "$keyword"` works, `…?q=$keyword` does not), so for that
 * case a `sql_query` builds the URL per row and the fetch reads the built column.
 *
 * Pure string functions: the console, the designer and any other host reuse them.
 */

/** One place `infer-variables` proposes to parameterize (Jersey DemoService.inferVariables). */
export interface VariableCandidate {
  stage: string;
  path: string;
  current: string;
  kind: 'search_term' | 'url' | 'text' | string;
  suggested_column?: string | null;
}

/**
 * How the person bound a candidate:
 *  - value        the literal becomes `$column` (keyword typed in a box, a text, a whole value)
 *  - url_keyword  only `keyword` inside the URL comes from the column (search URL per row)
 *  - whole_url    the whole URL comes from the column (the dataset holds full URLs)
 */
export interface VariableBinding {
  candidate: VariableCandidate;
  column: string;
  mode: 'value' | 'url_keyword' | 'whole_url';
  keyword?: string;
}

const QUERY_KEYS = ['q', 'query', 'k', 'kw', 'keyword', 'keywords', 'search', 'search_query', 's', 'term', 'text', 'w', 'p', '_nkw'];

/** The search keyword inside a URL's query string, when there is a recognisable one. */
export function detectUrlKeyword(url: string): string | null {
  const m = /\?(.*)$/.exec(String(url || ''));
  if (!m) return null;
  for (const part of m[1].split(/[&#]/)) {
    const [k, v] = part.split('=');
    if (v && QUERY_KEYS.includes(decodeURIComponent(k || '').toLowerCase())) return v;
  }
  return null;
}

const cleanCol = (c: string) => String(c || '').trim().replace(/^\$+/, '');
const sqlLit = (s: string) => "'" + String(s).replace(/'/g, "''") + "'";

/** Replace a literal everywhere it appears as a value: quoted forms first, then bare. */
function replaceLiteral(yaml: string, current: string, token: string): string {
  let out = yaml.split(`"${current}"`).join(`"${token}"`);
  if (out === yaml) out = yaml.split(`'${current}'`).join(`'${token}'`);
  if (out === yaml) out = yaml.split(current).join(token);
  return out;
}

/** True when the YAML already loads an input dataset (any load_* stage or ${INPUT_CSV_PATH}). */
export function yamlHasInputLoader(yaml: string): boolean {
  return /stage:\s*["']?load/i.test(yaml) || /\$\{INPUT_CSV_PATH\}/.test(yaml);
}

/** Insert stage blocks right after the input loader (prepending `load_csv ${INPUT_CSV_PATH}` if missing). */
function insertAfterLoader(yaml: string, stageBlocks: string[]): string {
  const lines = yaml.split('\n');
  const p = lines.findIndex((l) => /^pipeline:\s*$/.test(l));
  if (p < 0) return yaml;
  const loader = ['  - stage: load_csv', '    args:', '      - "${INPUT_CSV_PATH}"'];
  const extra = stageBlocks.flatMap((b) => b.split('\n'));
  if (!yamlHasInputLoader(yaml)) {
    lines.splice(p + 1, 0, ...loader, ...extra);
    return lines.join('\n');
  }
  // after the loader's block: the next `  - stage:` entry (or the end of the pipeline section)
  const li = lines.findIndex((l, i) => i > p && /^\s*-\s*stage:\s*["']?load/i.test(l));
  if (li < 0) { lines.splice(p + 1, 0, ...extra); return lines.join('\n'); }
  let j = li + 1;
  while (j < lines.length && !/^\s*-\s*stage:/.test(lines[j]) && /^\s/.test(lines[j])) j++;
  lines.splice(j, 0, ...extra);
  return lines.join('\n');
}

/**
 * Apply the bindings to a pipeline YAML. Returns the new YAML, how many bindings landed, and notes for
 * the person (e.g. a value that was not found, a multi-source pipeline not handled yet).
 */
export function templatizeYaml(yaml: string, bindings: VariableBinding[]): { yaml: string; count: number; notes: string[] } {
  const notes: string[] = [];
  if (/^sources:/m.test(yaml)) {
    return { yaml, count: 0, notes: ['Multi-source pipelines are not templatized yet: bind the values inside each source by hand.'] };
  }
  let out = yaml;
  let count = 0;
  const sqlStages: string[] = [];
  for (const b of bindings) {
    const col = cleanCol(b.column);
    const cur = String(b.candidate?.current || '');
    if (!col || !cur) continue;
    if (!out.includes(cur)) { notes.push(`"${cur.slice(0, 60)}" is no longer in the pipeline — skipped.`); continue; }
    if (b.mode === 'url_keyword') {
      const kw = b.keyword || detectUrlKeyword(cur) || '';
      const at = kw ? cur.indexOf(kw) : -1;
      if (at < 0) { notes.push(`No keyword found in ${cur.slice(0, 60)} — choose "whole URL" or type the keyword.`); continue; }
      const built = `__url_${col.replace(/[^A-Za-z0-9_]/g, '_')}`;
      // spaces → '+' is enough for a query string and works in Spark SQL and DuckDB alike
      sqlStages.push([
        '  - stage: sql_query',
        '    args:',
        `      - "SELECT *, concat(${sqlLit(cur.slice(0, at)).replace(/"/g, '\\"')}, replace(\`${col}\`, ' ', '+'), ${sqlLit(cur.slice(at + kw.length)).replace(/"/g, '\\"')}) AS ${built} FROM df"`,
      ].join('\n'));
      out = replaceLiteral(out, cur, `$${built}`);
    } else {
      out = replaceLiteral(out, cur, `$${col}`);
    }
    count++;
  }
  if (count > 0) out = insertAfterLoader(out, sqlStages);
  return { yaml: out, count, notes };
}
