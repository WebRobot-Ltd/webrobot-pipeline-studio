// combine: of a multi-source pipeline (10-23) — the designer writes it and reads it back.
// Build first, then run:  npm run build && node --test test/
import { buildYamlFromPipeline, parseCombineFromYaml } from '../dist/yaml.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rows = [
  { stage: 'fetch', args: { url: 'https://a.example/' }, _src: 1 },
  { stage: 'fetch', args: { url: 'https://b.example/' }, _src: 2 },
  { stage: 'dedup', args: {}, _src: 'shared' },
];

test('plain union writes no combine', () => {
  const y = buildYamlFromPipeline(rows, { combine: { type: 'union' } });
  assert.doesNotMatch(y, /combine:/);
  assert.equal(parseCombineFromYaml(y), null);
});

test('join round-trips key, fields and how', () => {
  const c = { type: 'join', key: 'ean', fields: ['price', 'url'], how: 'left' };
  const y = buildYamlFromPipeline(rows, { combine: c });
  assert.match(y, /^combine: \{ type: join, key: "ean", fields: \["price", "url"\], how: left \}$/m);
  assert.deepEqual(parseCombineFromYaml(y), { ...c, min_sources: undefined });
});

test('intersect with min_sources round-trips', () => {
  const y = buildYamlFromPipeline(rows, { combine: { type: 'intersect', key: 'ean', min_sources: 2 } });
  const c = parseCombineFromYaml(y);
  assert.equal(c.type, 'intersect');
  assert.equal(c.key, 'ean');
  assert.equal(c.min_sources, 2);
});

test('string form is read', () => {
  assert.deepEqual(parseCombineFromYaml('sources: []\ncombine: except\n'), { type: 'except' });
});

// output: of the save node (10-23) — format/mode written and read back
import { parseOutputFromYaml } from '../dist/yaml.js';

test('default output stays parquet · overwrite and reads back as null', () => {
  const y = buildYamlFromPipeline([rows[0]], {});
  assert.match(y, /^output:\n  format: parquet\n  mode: overwrite$/m);
  assert.equal(parseOutputFromYaml(y), null);
});

test('csv · append round-trips (single and multi source)', () => {
  for (const r of [[rows[0]], rows]) {
    const y = buildYamlFromPipeline(r, { output: { format: 'csv', mode: 'append' } });
    assert.match(y, /^output:\n  format: csv\n  mode: append$/m);
    assert.deepEqual(parseOutputFromYaml(y), { format: 'csv', mode: 'append' });
  }
});

test('inline output map from an agent is read', () => {
  assert.deepEqual(parseOutputFromYaml('pipeline: []\noutput: { format: csv, mode: overwrite, path: "x" }\n'), { format: 'csv', mode: 'overwrite' });
});
