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
