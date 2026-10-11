// Lo YAML che non viene dal nostro generatore (bozze della chat, pipeline salvate dal backend con
// Jackson) deve arrivare nel canvas. Prima il parser a righe restituiva [] e il canvas restava vuoto.
//   npm run build && node --test test/
import { parsePipelineFromYaml, buildYamlFromPipeline } from '../dist/yaml.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const catalog = [
  { stage_name: 'wget', arg_schema: [{ name: 'url' }] },
  { stage_name: 'visit', arg_schema: [{ name: 'url' }] },
];

test('forma Jackson: ---, stage quotati a colonna 0, args a blocchi, sources come mappa', () => {
  const y = [
    '---',
    'metadata:',
    '  geo: "gb"',
    'sources:',
    '  w:',
    '    pipeline:',
    '    - stage: "wget"',
    '      args:',
    '      - "https://www.rightmove.co.uk/find.html?index=0"',
    '    - stage: "flatSelect"',
    '      args:',
    '      - "body"',
    '      - - selector: "script#__NEXT_DATA__"',
    '          method: "html"',
    '          as: "next_data"',
    '  v:',
    '    pipeline:',
    '    - stage: "visit"',
    '      args:',
    '      - "https://example.com"',
    'pipeline:',
    '- stage: "load_parquet"',
    '  args:',
    '  - path: "s3a://b/x.parquet/"',
    '    selectColumns: "true"',
  ].join('\n');
  const rows = parsePipelineFromYaml(y, { catalog });
  assert.deepEqual(rows, [
    { stage: 'wget', args: { url: 'https://www.rightmove.co.uk/find.html?index=0' }, _src: 1 },
    { stage: 'flatSelect', args: { segmentSelector: 'body' }, _src: 1,
      _fields: [{ selector: 'script#__NEXT_DATA__', method: 'html', as: 'next_data' }] },
    { stage: 'visit', args: { url: 'https://example.com' }, _src: 2 },
    { stage: 'load_parquet', args: { path: 's3a://b/x.parquet/', selectColumns: 'true' }, _src: 'shared' },
  ]);
  // e torna YAML che il generatore sa emettere (gli args posizionali hanno un nome)
  assert.match(buildYamlFromPipeline(rows, { catalog }), /"https:\/\/www\.rightmove\.co\.uk\/find\.html\?index=0"\s+# url/);
});

test('args in linea, recinto markdown, manifest kind: Pipeline, CRLF', () => {
  const want = [{ stage: 'visit', args: { url: 'https://x.com' } }];
  for (const y of [
    'pipeline:\n  - stage: visit\n    args: ["https://x.com"]',
    '```yaml\npipeline:\n- stage: visit\n  args:\n  - "https://x.com"\n```',
    'apiVersion: webrobot/v1\nkind: Pipeline\nspec:\n  pipeline:\n    - stage: visit\n      args:\n        - "https://x.com"',
    'pipeline:\r\n  - stage: visit\r\n    args:\r\n      - "https://x.com"',
  ]) assert.deepEqual(parsePipelineFromYaml(y, { catalog }), want, y);
});

test('il dialetto nostro resta sul parser a righe (nomi dai commenti)', () => {
  const y = 'pipeline:\n  - stage: visit\n    args:\n      - "https://x.com"    # url\n  - stage: dedup\n    args: []';
  assert.deepEqual(parsePipelineFromYaml(y), [
    { stage: 'visit', args: { url: 'https://x.com' } },
    { stage: 'dedup', args: {} },
  ]);
});

test('YAML illeggibile → [] senza eccezioni', () => {
  assert.deepEqual(parsePipelineFromYaml('just some prose: [unclosed'), []);
});
