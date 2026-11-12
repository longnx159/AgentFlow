import { test } from 'node:test';
import assert from 'node:assert/strict';
const helper = () => import(new URL('../public/rules.js', import.meta.url).href);
test('visual condition builder creates typed AND/OR logic with multiple rules', async () => {
  const { buildRule } = await helper();
  assert.deepEqual(
    buildRule(
      [
        { field: 'review.passed', operator: '==', value: 'true' },
        { field: 'review.score', operator: '>=', value: '80' },
      ],
      'and',
    ),
    { and: [{ '==': [{ var: 'review.passed' }, true] }, { '>=': [{ var: 'review.score' }, 80] }] },
  );
  assert.deepEqual(
    buildRule(
      [
        { field: 'input.tag', operator: 'contains', value: 'ready' },
        { field: 'artifacts.draft.id', operator: 'exists', value: '' },
      ],
      'or',
    ),
    { or: [{ contains: [{ var: 'input.tag' }, 'ready'] }, { exists: 'artifacts.draft.id' }] },
  );
});
test('visual condition builder refuses empty rules, unknown operators and invalid conjunctions', async () => {
  const { buildRule } = await helper();
  assert.throws(() => buildRule([], 'and'), /rule/i);
  assert.throws(() => buildRule([{ field: '', operator: '==', value: '1' }], 'and'), /field/i);
  assert.throws(
    () => buildRule([{ field: 'a', operator: 'eval', value: '1' }], 'and'),
    /operator/i,
  );
  assert.throws(() => buildRule([{ field: 'a', operator: '==', value: '1' }], 'xor'), /and|or/i);
});
