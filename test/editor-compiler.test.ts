import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileFlow, assertAllowedDraft } from '../src/editor/compiler.js';
const flow = [
  {
    id: 'wf',
    type: 'tab',
    label: 'Review loop',
    enabled: true,
    execution: '{"timeoutAction":"pause"}',
    limits: '{"maxStepExecutions":30}',
  },
  { id: 's', z: 'wf', type: 'af-start', triggers: '[{"id":"m","type":"manual"}]', wires: [['t']] },
  {
    id: 't',
    z: 'wf',
    type: 'af-task',
    name: 'Draft',
    skill: 'Write raw markdown',
    role: 'writer',
    input: '{{input.topic}}',
    timeout: '{"noProgressTimeoutSec":120}',
    wires: [['r']],
  },
  { id: 'r', z: 'wf', type: 'af-review', rubric: 'Check facts', wires: [['c']] },
  {
    id: 'c',
    z: 'wf',
    type: 'af-condition',
    cases: '[{"and":[{"==":[{"var":"input.approved"},true]},{">":[{"var":"input.score"},3]}]}]',
    wires: [['e'], ['p']],
  },
  { id: 'p', z: 'wf', type: 'af-repeat', target: 't', maxIterations: 3, wires: [['e']] },
  { id: 'e', z: 'wf', type: 'af-end', outcome: 'succeeded', wires: [] },
];
test('compiles selected tab preserving prompts, gates, branches, repeat budgets and overrides', () => {
  const result = compileFlow(flow, 'wf');
  assert.equal(result.id, 'wf');
  assert.equal(result.entry, 's');
  assert.deepEqual(
    result.nodes.find((n) => n.id === 't'),
    {
      id: 't',
      type: 'task',
      name: 'Draft',
      next: 'r',
      skill: 'Write raw markdown',
      role: 'writer',
      input: '{{input.topic}}',
      timeout: { noProgressTimeoutSec: 120 },
    },
  );
  assert.deepEqual(result.nodes.find((n) => n.id === 'c')?.cases, [
    {
      when: {
        and: [{ '==': [{ var: 'input.approved' }, true] }, { '>': [{ var: 'input.score' }, 3] }],
      },
      next: 'e',
    },
  ]);
  assert.equal(result.nodes.find((n) => n.id === 'c')?.otherwise, 'p');
  assert.equal(result.nodes.find((n) => n.id === 'p')?.target, 't');
  assert.deepEqual(result.execution, { timeoutAction: 'pause' });
  assert.deepEqual(result.limits, { maxStepExecutions: 30 });
  assert.deepEqual(result.triggers, [{ id: 'm', type: 'manual' }]);
});
test('draft allowlist rejects executable stock nodes even in another tab', () => {
  for (const type of ['function', 'inject', 'exec', 'http request'])
    assert.throws(
      () => assertAllowedDraft([...flow, { id: 'bad', z: 'other', type }]),
      /not allowed/i,
    );
  assert.doesNotThrow(() => assertAllowedDraft(flow));
});
test('refuses ambiguous branches, missing tabs, unsupported types and cross-tab wires', () => {
  assert.throws(() => compileFlow(flow, 'absent'), /tab/i);
  assert.throws(
    () =>
      compileFlow(
        flow.map((n) => (n.id === 't' ? { ...n, wires: [['r', 'e']] } : n)),
        'wf',
      ),
    /wire|branch/i,
  );
  assert.throws(
    () =>
      compileFlow(
        flow.map((n) => (n.id === 't' ? { ...n, wires: [['outside']] } : n)),
        'wf',
      ),
    /outside|target/i,
  );
  assert.throws(
    () =>
      compileFlow(
        flow.map((n) => (n.id === 'c' ? { ...n, cases: 'not json' } : n)),
        'wf',
      ),
    /JSON/i,
  );
});

test('repeat delay is retained when compiling a bounded loop', () => {
  const result = compileFlow(
    flow.map((n) => (n.id === 'p' ? { ...n, delaySec: 15 } : n)),
    'wf',
  );
  assert.equal(result.nodes.find((n) => n.id === 'p')?.delaySec, 15);
});

test('End can select a candidate output node instead of returning review JSON', () => {
  const result = compileFlow(
    flow.map((n) => (n.id === 'e' ? { ...n, outputNodeId: 't' } : n)),
    'wf',
  );
  assert.equal(result.nodes.find((n) => n.id === 'e')?.outputNodeId, 't');
  assert.throws(
    () =>
      compileFlow(
        flow.map((n) => (n.id === 'e' ? { ...n, outputNodeId: 'outside' } : n)),
        'wf',
      ),
    /outside|target/,
  );
});
