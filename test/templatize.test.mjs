// Templatization (10-25): literal → $column, keyword inside a URL → sql_query-built URL, input loader.
// Build first, then run:  npm run build && node --test test/
import { templatizeYaml, detectUrlKeyword } from '../dist/templatize.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const YAML = `pipeline:
  - stage: fetch
    args:
      - "https://www.farmae.it/search?q=magnesio"
  - stage: flatSelect
    args:
      - ".product-card"
output:
  format: parquet
  mode: overwrite`;

const cand = { stage: 'fetch', path: 'pipeline[0].url', current: 'https://www.farmae.it/search?q=magnesio', kind: 'url' };

test('detects the keyword of a search URL', () => {
  assert.equal(detectUrlKeyword('https://x.it/search?q=magnesio&p=2'), 'magnesio');
  assert.equal(detectUrlKeyword('https://www.ebay.it/sch/i.html?_nkw=laptop'), 'laptop');
  assert.equal(detectUrlKeyword('https://x.it/products'), null);
});

test('keyword inside the URL: loader + sql_query building the URL, fetch reads it', () => {
  const r = templatizeYaml(YAML, [{ candidate: cand, column: 'keyword', mode: 'url_keyword' }]);
  assert.equal(r.count, 1);
  const lines = r.yaml.split('\n');
  assert.equal(lines[1], '  - stage: load_csv');
  assert.equal(lines[3], '      - "${INPUT_CSV_PATH}"');
  assert.equal(lines[4], '  - stage: sql_query');
  assert.match(r.yaml, /concat\('https:\/\/www\.farmae\.it\/search\?q=', replace\(`keyword`, ' ', '\+'\), ''\) AS __url_keyword FROM df/);
  assert.match(r.yaml, /- "\$__url_keyword"/);
  assert.doesNotMatch(r.yaml, /magnesio/);
});

test('whole URL from a column', () => {
  const r = templatizeYaml(YAML, [{ candidate: cand, column: 'url', mode: 'whole_url' }]);
  assert.match(r.yaml, /- "\$url"/);
  assert.doesNotMatch(r.yaml, /sql_query/);
  assert.match(r.yaml, /stage: load_csv/);
});

test('typed text value', () => {
  const y = 'pipeline:\n  - stage: visit\n    args:\n      - "https://x.it/"\n      - [{ action: input, selector: "#q", text: "iphone" }]\n';
  const r = templatizeYaml(y, [{ candidate: { stage: 'visit', path: 'p', current: 'iphone', kind: 'search_term' }, column: '$term', mode: 'value' }]);
  assert.match(r.yaml, /text: "\$term"/);
});

test('existing loader is kept, sql goes after it', () => {
  const y = 'pipeline:\n  - stage: load_csv\n    args:\n      - "${INPUT_CSV_PATH}"\n  - stage: fetch\n    args:\n      - "https://x.it/s?q=abc"\n';
  const r = templatizeYaml(y, [{ candidate: { stage: 'fetch', path: 'p', current: 'https://x.it/s?q=abc', kind: 'url' }, column: 'kw', mode: 'url_keyword' }]);
  const lines = r.yaml.split('\n');
  assert.equal(lines.filter((l) => /load_csv/.test(l)).length, 1);
  assert.equal(lines[4], '  - stage: sql_query');
  assert.equal(lines[7], '  - stage: fetch');
});

test('multi-source pipeline is left alone with a note', () => {
  const r = templatizeYaml('sources:\n  - source: a\n', [{ candidate: cand, column: 'k', mode: 'value' }]);
  assert.equal(r.count, 0);
  assert.equal(r.notes.length, 1);
});
