// YAML generator faithfulness tests. Build first, then run:
//   npm run build && node --test test/
import { buildYamlFromPipeline } from '../dist/yaml.js';
import { test } from 'node:test';

test('yaml generator parity', () => {

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.error(`\n✗ ${name}`);
  const g = got.split('\n'), w = want.split('\n');
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (g[i] !== w[i]) console.error(`  line ${i + 1}\n    got:  ${JSON.stringify(g[i])}\n    want: ${JSON.stringify(w[i])}`);
  }
}

const catalog = [
  { stage_name: 'fetch', arg_schema: [{ name: 'url' }] },
  { stage_name: 'extract' },
  { stage_name: 'flatSelect', arg_schema: [{ name: 'segmentSelector' }] },
];
const ctx = { catalog };

// 1. Single extract
eq('extract single-source',
  buildYamlFromPipeline([
    { stage: 'fetch', args: { url: 'https://x.com' }, _src: 1 },
    { stage: 'extract', args: {}, _src: 1, _fields: [{ selector: 'h1', as: 'title', method: 'text' }] },
  ], ctx),
  [
    'pipeline:',
    '  - stage: fetch',
    '    args:',
    '      - "https://x.com"    # url',
    '  - stage: extract',
    '    args:',
    '      - { selector: "h1", method: "text", as: "title" }',
    'output:',
    '  format: parquet',
    '  mode: overwrite',
  ].join('\n'));

// 2. flatSelect with a segment
eq('flatSelect',
  buildYamlFromPipeline([
    { stage: 'flatSelect', args: { segmentSelector: '.row' }, _src: 1,
      _fields: [{ selector: '.name', as: 'name', method: 'text' }] },
  ], ctx),
  [
    'pipeline:',
    '  - stage: flatSelect',
    '    args:',
    '      - ".row"    # segment selector',
    '      -',
    '        - { selector: ".name", method: "text", as: "name" }',
    'output:',
    '  format: parquet',
    '  mode: overwrite',
  ].join('\n'));

// 3. flatSelect with a parallel field → auto parallelSelect
eq('flatSelect → parallelSelect auto-split',
  buildYamlFromPipeline([
    { stage: 'flatSelect', args: { segmentSelector: '.row' }, _src: 1,
      _fields: [
        { selector: '.name', as: 'name', method: 'text' },
        { selector: '.avatar img', as: 'pic', method: 'attr:src', _parallel: true },
      ] },
  ], ctx),
  [
    'pipeline:',
    '  - stage: parallelSelect',
    '    # auto: rows split across parallel sibling lists → parallelSelect (zipped by index)',
    '    args:',
    '      -',
    '        - { selector: ".row .name", method: "text", as: "name" }',
    '        - { selector: ".avatar img", method: "attr:src", as: "pic" }',
    'output:',
    '  format: parquet',
    '  mode: overwrite',
  ].join('\n'));

// 4. Multi-source: source_1 + shared tail
eq('multi-source sources: + shared tail',
  buildYamlFromPipeline([
    { stage: 'fetch', args: { url: 'https://a.com' }, _src: 1 },
    { stage: 'fetch', args: { url: 'https://b.com' }, _src: 2 },
    { stage: 'dedup', args: { columns: 'id' }, _src: 'shared' },
  ], ctx),
  [
    // Branch stages are indented under `pipeline:` (2 sp) then re-indented (+4 sp) by
    // buildSourcesYaml → 6 spaces before `- stage`. This matches the Vue source exactly.
    'sources:',
    '  - source: "source_1"',
    '    pipeline:',
    '      - stage: fetch',
    '        args:',
    '          - "https://a.com"    # url',
    '  - source: "source_2"',
    '    pipeline:',
    '      - stage: fetch',
    '        args:',
    '          - "https://b.com"    # url',
    'pipeline:',
    '  - stage: dedup',
    '    args:',
    '      - "id"',
    'output:',
    '  format: parquet',
    '  mode: overwrite',
  ].join('\n'));

// 5. fetch with an embedded trace (click) → args[1] action list
eq('fetch + embedded trace',
  buildYamlFromPipeline([
    { stage: 'fetch', args: { url: 'https://x.com' }, _src: 1,
      _trace: [{ type: 'Click', selector: '.more' }] },
  ], ctx),
  [
    'pipeline:',
    '  - stage: fetch',
    '    args:',
    '      - "https://x.com"    # url',
    '      -',
    '        - { action: "click", selector: ".more" }',
    'output:',
    '  format: parquet',
    '  mode: overwrite',
  ].join('\n'));

// 6. Runtime + geo metadata
eq('metadata runtime + geo',
  buildYamlFromPipeline(
    [{ stage: 'extract', args: {}, _src: 1, _fields: [{ selector: 'h1', as: 't' }] }],
    { catalog, runtime: 'ray_actor', geo: 'DE' }),
  [
    'pipeline:',
    '  - stage: extract',
    '    args:',
    '      - { selector: "h1", method: "text", as: "t" }',
    'output:',
    '  format: parquet',
    '  mode: overwrite',
    'metadata:',
    '  runtime: "ray_actor"',
    '  geo: "de"',
  ].join('\n'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) throw new Error(fail + ' YAML test(s) failed');
});
