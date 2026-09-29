// Regressione per extractPipelineYaml — l'estrazione del corpo pipeline dal RESULT di un run
// agentico. Build first, then run:  npm run build && node --test test/
//
// Copre il bug del 29-09-2026: il result della riga arriva come STRINGA JSON (il campo lato
// server e' String/JSONB, non un oggetto), quindi l'estrazione DEVE aprirla prima, altrimenti
// finisce sul canvas il blob JSON grezzo invece della pipeline.
import { extractPipelineYaml } from '../dist/client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const YAML = 'pipeline:\n  - stage: wget\n    args:\n      - "https://example.com"';

test('extractPipelineYaml', () => {
  // 1. Oggetto {nodo:{crew:"<yaml>"}} — la forma "sul campo".
  assert.equal(extractPipelineYaml({ node1: { crew1: YAML } }), YAML);

  // 2. STRINGA JSON che impacchetta lo stesso oggetto — com'e' servito da /agentic/executions
  //    e ora da /agentic/{eid}. Questo e' il caso che prima falliva.
  assert.equal(extractPipelineYaml(JSON.stringify({ node1: { crew1: YAML } })), YAML);

  // 3. Corpo yaml nudo come stringa (nessun JSON da aprire).
  assert.equal(extractPipelineYaml(YAML), YAML);

  // 4. Avvolto in recinti markdown (l'agente non dovrebbe, ma capita).
  assert.equal(extractPipelineYaml('```yaml\n' + YAML + '\n```'), YAML);

  // 5. Manifest multi-documento → si prende lo spec: del kind: Pipeline.
  const manifest = [
    'apiVersion: v1', 'kind: Project', 'metadata: { name: p }',
    '---',
    'apiVersion: v1', 'kind: Pipeline', 'metadata: { name: pl }',
    'spec:', '  pipeline:', '    - stage: wget', '      args:', '        - "https://example.com"',
  ].join('\n');
  const got = extractPipelineYaml(manifest);
  assert.match(got, /^pipeline:/);
  assert.match(got, /stage: wget/);

  // 6. Niente di utilizzabile → null (meglio "nessuna proposta" che testo spazzatura).
  assert.equal(extractPipelineYaml(null), null);
  assert.equal(extractPipelineYaml(''), null);
  assert.equal(extractPipelineYaml('NEEDS: dammi l\'URL di partenza'), null);
  assert.equal(extractPipelineYaml({ node1: { crew1: 'NEEDS: url' } }), null);
});
