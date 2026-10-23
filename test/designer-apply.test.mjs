// Designer proposal → canvas (10-23, Farmaè): the agent writes fields as flow mappings
// (`- - { selector: ".t", as: title }`); the line parser dropped them and flatSelect reached the canvas
// with NO fields. Build first, then run:  npm run build && node --test test/
import { extractPipelineYaml } from '../dist/client.js';
import { parsePipelineFromYaml, buildYamlFromPipeline } from '../dist/yaml.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const RESULT = { run: { designer: 'pipeline:\n  - stage: fetch\n    args:\n      - "https://www.farmae.it/search?q=crema%20solare"\n  - stage: flatSelect\n    args:\n      - ".product-card__wrapper"\n      - - { selector: ".product-card__title", method: text, as: name }\n        - { selector: ".f-price-item--regular", method: text, as: price }\n        - { selector: "a", method: "attr:href", as: url }\noutput: { format: parquet, mode: overwrite, path: "${OUTPUT_PARQUET_PATH}" }' } };

test('designer proposal with flow-style fields reaches the canvas with its fields', () => {
  const rows = parsePipelineFromYaml(extractPipelineYaml(RESULT), {});
  assert.equal(rows.length, 2);
  assert.equal(rows[1].stage, 'flatSelect');
  assert.equal(rows[1].args.segmentSelector, '.product-card__wrapper');
  assert.deepEqual(rows[1]._fields.map((f) => f.as), ['name', 'price', 'url']);
  assert.equal(rows[1]._fields[2].method, 'attr:href');
  // and back to YAML (what the designer saves) keeps the selectors
  const y = buildYamlFromPipeline(rows, {});
  assert.match(y, /\.product-card__title/);
  assert.match(y, /attr:href/);
});
