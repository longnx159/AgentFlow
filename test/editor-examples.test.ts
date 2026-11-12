import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileFlow } from '../src/editor/compiler.js';
import { validateWorkflow } from '../src/core/workflow.js';
test('bundled simple and review-repeat graphs publish through the real core validator', async () => {
  for (const name of ['simple', 'review-repeat']) {
    const flows = JSON.parse(
      await readFile(new URL('../examples/' + name + '.json', import.meta.url), 'utf8'),
    );
    const w = compileFlow(flows, flows.find((n: any) => n.type === 'tab').id);
    assert.doesNotThrow(() => validateWorkflow(w));
    if (name === 'review-repeat') {
      assert.equal(w.nodes.find((n) => n.type === 'review')?.input, '{{lastOutput}}');
      assert.equal(w.nodes.find((n) => n.type === 'repeat')?.maxIterations, 3);
    }
  }
});
