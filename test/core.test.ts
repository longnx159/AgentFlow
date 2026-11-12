import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/core/engine.js';
import { defaults, resolveExecution, validateSettings } from '../src/core/settings.js';
import { validateWorkflow, evaluateRule } from '../src/core/workflow.js';
import type { WorkflowDefinition } from '../src/shared/types.js';

const flow = (): WorkflowDefinition => ({
  id: 'sample',
  name: 'Example',
  enabled: true,
  entry: 'start',
  triggers: [{ id: 'manual', type: 'manual' }],
  nodes: [
    { id: 'start', type: 'start', next: 'task' },
    { id: 'task', type: 'task', skill: 'Do the work.', next: 'end' },
    { id: 'end', type: 'end' },
  ],
});
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-'));
  let clock = Date.parse('2026-11-12T00:00:00Z');
  const e = new Engine({ dataDir: dir, now: () => clock, pairingToken: 'pair' });
  t.after(() => {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    e,
    dir,
    jump: (n: number) => {
      clock += n;
    },
    advance: (n: number) => {
      clock += n;
      e.tick();
    },
  };
}
function worker(e: Engine, id = 'w1', roles = ['default']) {
  return e.registerWorker({
    workerId: id,
    name: id,
    roles,
    generation: 'boot',
    pairingToken: 'pair',
  });
}
function finish(e: Engine, a: any, text: string) {
  const grant = e.sendIntent(a.id, { generation: a.generation, fence: a.fence });
  assert.equal(grant.authorized, true);
  return e.completeText(a.id, text, 'complete', {});
}

test('execution settings inherit explicit null and reject a long-poll timeout shorter than its wait', () => {
  assert.equal(
    resolveExecution(
      defaults().execution,
      { stepTotalTimeoutSec: 100 },
      { stepTotalTimeoutSec: null },
    ).stepTotalTimeoutSec,
    null,
  );
  const s = defaults();
  s.connection.longPollHttpTimeoutSec = 20;
  assert.throws(() => validateSettings(s), /longPoll/);
});
test('graph rejects stock executable nodes and cycles without a budget-consuming Repeat', () => {
  const f = flow();
  (f.nodes[1] as any).type = 'exec';
  assert.throws(() => validateWorkflow(f), /type|node/i);
  const loop = flow();
  loop.nodes[1].next = 'task';
  assert.throws(() => validateWorkflow(loop), /cycle|Repeat/i);
  assert.equal(
    evaluateRule(
      {
        and: [{ '>=': [{ var: 'review.score' }, 80] }, { '===': [{ var: 'review.passed' }, true] }],
      },
      { review: { score: 85, passed: true } },
    ),
    true,
  );
});
test('send authority is one-time; duplicate result advances exactly once and preserves Markdown', (t) => {
  const { e } = fixture(t);
  e.publish(flow());
  worker(e);
  const run = e.startRun('sample', 'input');
  const a = e.claim('w1', 'boot')!;
  assert.ok(a);
  assert.equal(e.sendIntent(a.id, { generation: 'boot', fence: a.fence }).authorized, true);
  assert.equal(e.sendIntent(a.id, { generation: 'boot', fence: a.fence }).authorized, false);
  const raw = '  # Tiếng Việt\n\n```py\n    __init__\n```\n';
  e.completeText(a.id, raw, 'complete', {});
  e.completeText(a.id, raw, 'complete', {});
  assert.equal(e.getRun(run.id).status, 'succeeded');
  assert.equal(e.getArtifact(e.getRun(run.id).outputArtifactId).text, raw);
  assert.throws(() => e.completeText(a.id, 'different', 'complete', {}), /conflict/i);
});
test('lost heartbeat after send never returns the job to the queue; late result resolves it', (t) => {
  const { e, advance } = fixture(t);
  e.publish(flow());
  worker(e);
  const run = e.startRun('sample', 'input');
  const a = e.claim('w1', 'boot')!;
  e.sendIntent(a.id, { generation: 'boot', fence: a.fence });
  advance(31000);
  assert.equal(e.getRun(run.id).status, 'uncertain');
  assert.equal(e.claim('w1', 'boot'), null);
  e.completeText(a.id, 'late result', 'complete', {});
  assert.equal(e.getRun(run.id).status, 'succeeded');
});
test('expired pre-send lease fences an old worker and may create a new attempt', (t) => {
  const { e, advance } = fixture(t);
  e.publish(flow());
  worker(e);
  worker(e, 'w2');
  e.startRun('sample', 'input');
  const old = e.claim('w1', 'boot')!;
  advance(61000);
  e.heartbeat('w2', { generation: 'boot', settingsVersion: 1 });
  const newer = e.claim('w2', 'boot')!;
  assert.ok(newer);
  assert.notEqual(newer.id, old.id);
  assert.throws(
    () => e.sendIntent(old.id, { generation: 'boot', fence: old.fence }),
    /expired|state|lease/i,
  );
});
test('review failure loops with new executions; missing review does not pass; loop budget includes first try', (t) => {
  const { e } = fixture(t);
  const f = flow();
  f.nodes = [
    { id: 'start', type: 'start', next: 'task' },
    { id: 'task', type: 'task', next: 'review' },
    { id: 'review', type: 'review', rubric: 'Be correct', next: 'gate' },
    {
      id: 'gate',
      type: 'condition',
      cases: [{ when: { '===': [{ var: 'review.passed' }, true] }, next: 'end' }],
      otherwise: 'repeat',
    },
    { id: 'repeat', type: 'repeat', target: 'task', maxIterations: 2 },
    { id: 'end', type: 'end' },
  ];
  e.publish(f);
  worker(e);
  const run = e.startRun('sample', 'data');
  const first = e.claim('w1', 'boot')!;
  finish(e, first, 'draft one');
  finish(
    e,
    e.claim('w1', 'boot')!,
    JSON.stringify({ passed: false, score: 40, issues: ['Wrong'] }),
  );
  const second = e.claim('w1', 'boot')!;
  assert.notEqual(second.nodeExecutionId, first.nodeExecutionId);
  assert.ok(second.prompt.includes('data'));
  finish(e, second, 'draft two');
  finish(e, e.claim('w1', 'boot')!, JSON.stringify({ passed: false, score: 50, issues: [] }));
  assert.equal(e.getRun(run.id).status, 'needsReview');
});
test('partial output never starts the next node', (t) => {
  const { e } = fixture(t);
  e.publish(flow());
  worker(e);
  const r = e.startRun('sample', 'input');
  const a = e.claim('w1', 'boot')!;
  e.sendIntent(a.id, { generation: 'boot', fence: a.fence });
  e.completeText(a.id, 'unfinished', 'partial', {});
  assert.equal(e.getRun(r.id).status, 'needsReview');
  assert.equal(e.claim('w1', 'boot'), null);
});
test('redeploy cannot mutate an active skill snapshot; event dedup survives version changes', (t) => {
  const { e } = fixture(t);
  const f = flow();
  e.publish(f);
  worker(e);
  const r = e.startRun('sample', 'input', { eventId: 'same', triggerId: 'manual' });
  f.nodes[1].skill = 'Changed';
  e.publish(f);
  const again = e.startRun('sample', 'input', { eventId: 'same', triggerId: 'manual' });
  assert.equal(again.id, r.id);
  assert.ok(e.claim('w1', 'boot')!.prompt.startsWith('Do the work.'));
});
test('durable delay survives a Manager restart without replaying completed task', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-restart-'));
  let clock = 100000;
  let e = new Engine({ dataDir: dir, now: () => clock, pairingToken: 'pair' });
  t.after(() => {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const f = flow();
  f.nodes = [
    { id: 'start', type: 'start', next: 'delay' },
    { id: 'delay', type: 'delay', delaySec: 100, next: 'end' },
    { id: 'end', type: 'end' },
  ];
  e.publish(f);
  const r = e.startRun('sample', 'x');
  e.close();
  clock += 101000;
  e = new Engine({ dataDir: dir, now: () => clock, pairingToken: 'pair' });
  e.tick();
  assert.equal(e.getRun(r.id).status, 'succeeded');
});
test('queue rejects admission visibly at capacity and respects global/per-flow concurrency', (t) => {
  const { e } = fixture(t);
  e.updateSettings({ limits: { globalConcurrentRuns: 1, maxQueuedRuns: 1 } });
  e.publish(flow());
  e.startRun('sample', 'one');
  e.startRun('sample', 'two');
  const r = e.startRun('sample', 'three');
  assert.equal(r.status, 'rejected');
  assert.equal(e.listRuns().filter((x: any) => x.status === 'running').length, 1);
});
test('default End publishes candidate Task output, not the reviewer JSON', (t) => {
  const { e } = fixture(t);
  const f = flow();
  f.nodes[1].next = 'review';
  f.nodes.splice(2, 0, { id: 'review', type: 'review', next: 'end' });
  e.publish(f);
  worker(e);
  const r = e.startRun('sample', 'x');
  finish(e, e.claim('w1', 'boot')!, 'candidate text');
  finish(e, e.claim('w1', 'boot')!, JSON.stringify({ passed: true, score: 90, issues: [] }));
  assert.equal(e.getArtifact(e.getRun(r.id).outputArtifactId).text, 'candidate text');
});
test('duplicate progress event ACK is idempotent after a lost HTTP response', (t) => {
  const { e } = fixture(t);
  e.publish(flow());
  worker(e);
  e.startRun('sample', 'x');
  const a = e.claim('w1', 'boot')!;
  e.sendIntent(a.id, { generation: 'boot', fence: a.fence });
  const event = { generation: 'boot', eventId: 'event-one', seq: 1, state: 'running' };
  assert.equal(e.event(a.id, event).accepted, true);
  assert.equal(e.event(a.id, event).accepted, true);
});
test('lost initial pairing response can recover the same credential, not lock out the Worker', (t) => {
  const { e } = fixture(t);
  const data = { workerId: 'a', roles: ['default'], generation: 'first', pairingToken: 'pair' };
  const first = e.registerWorker(data);
  const replay = e.registerWorker(data);
  assert.equal(first.credential, replay.credential);
  assert.ok(replay.credential);
});
test('explicit operator resolution releases an uncertain slot without reusing its send authority', (t) => {
  const { e } = fixture(t);
  e.publish(flow());
  worker(e);
  const r = e.startRun('sample', 'x');
  const a = e.claim('w1', 'boot')!;
  e.sendIntent(a.id, { generation: 'boot', fence: a.fence });
  e.resolveAttempt(a.id, 'notSent', 'Inspected conversation: no submitted user turn');
  const next = e.claim('w1', 'boot')!;
  assert.ok(next);
  assert.notEqual(next.id, a.id);
  assert.throws(() => e.sendIntent(a.id, { generation: 'boot', fence: a.fence }), /state/i);
  assert.equal(e.getRun(r.id).status, 'running');
});
test('pre-send preparation failure can be acknowledged and manually resumed as a new attempt', (t) => {
  const { e } = fixture(t);
  e.publish(flow());
  worker(e);
  const r = e.startRun('sample', 'x');
  const a = e.claim('w1', 'boot')!;
  const event = {
    generation: 'boot',
    eventId: 'prepare-failed',
    seq: 1,
    state: 'notSent',
    message: 'Composer unavailable',
  };
  assert.equal(e.event(a.id, event).accepted, true);
  assert.equal(e.event(a.id, event).accepted, true);
  assert.equal(e.getRun(r.id).status, 'needsReview');
  e.controlRun(r.id, 'resume');
  assert.notEqual(e.claim('w1', 'boot')!.id, a.id);
});
test('role dispatch rotates across three backlogged workflows instead of starving the third', (t) => {
  const { e } = fixture(t);
  e.updateSettings({ limits: { globalConcurrentRuns: 9, perWorkflowConcurrentRuns: 3 } });
  for (const id of ['a', 'b', 'c']) {
    const f = flow();
    f.id = id;
    e.publish(f);
    for (let n = 0; n < 3; n++) e.startRun(id, `${id}${n}`);
  }
  worker(e);
  const picked = [];
  for (let n = 0; n < 3; n++) {
    const a = e.claim('w1', 'boot')!;
    picked.push(e.getRun(a.runId).workflowId);
    finish(e, a, 'done');
  }
  assert.deepEqual(picked, ['a', 'b', 'c']);
});
test('cron timezone, missed schedules and catch-up latest are durable and deduplicated', (t) => {
  const { e, advance } = fixture(t);
  const f = flow();
  f.triggers = [{ id: 'eight', type: 'schedule', cron: '0 8 * * *', timezone: 'Asia/Saigon' }];
  e.publish(f);
  advance(3600000);
  assert.equal(e.listRuns().length, 1);
  e.tick();
  assert.equal(e.listRuns().length, 1);
  const late = flow();
  late.id = 'late';
  late.triggers = [{ id: 'every', type: 'schedule', intervalSec: 10, missed: 'catchUpLatest' }];
  e.publish(late);
  advance(45000);
  assert.equal(e.listRuns().filter((x) => x.workflowId === 'late').length, 1);
});
test('cross-workflow trigger cycles consume a shared lineage budget', (t) => {
  const { e } = fixture(t);
  e.updateSettings({ limits: { maxChainRuns: 3 } });
  for (const id of ['a', 'b']) {
    const f = flow();
    f.id = id;
    f.nodes = [
      { id: 'start', type: 'start', next: 'end' },
      { id: 'end', type: 'end' },
    ];
    f.triggers = [{ id: 'chain', type: 'workflow', sourceWorkflowId: id === 'a' ? 'b' : 'a' }];
    e.publish(f);
  }
  e.startRun('a', 'x');
  assert.equal(e.listRuns().filter((r) => r.status === 'succeeded').length, 3);
  assert.equal(e.listRuns().filter((r) => r.status === 'rejected').length, 1);
});
test('long generation is not failed by a six-minute deadline when heartbeat and progress continue', (t) => {
  const { e, advance } = fixture(t);
  e.publish(flow());
  worker(e);
  const r = e.startRun('sample', 'x');
  const a = e.claim('w1', 'boot')!;
  e.sendIntent(a.id, { generation: 'boot', fence: a.fence });
  for (let n = 0; n < 40; n++) {
    e.heartbeat('w1', {
      generation: 'boot',
      settingsVersion: 1,
      attemptId: a.id,
      progressAt: a.createdAt + n * 20000,
    });
    advance(20000);
  }
  assert.equal(e.getRun(r.id).status, 'running');
  e.completeText(a.id, 'long response', 'complete', {});
  assert.equal(e.getRun(r.id).status, 'succeeded');
});
test('overdue Delay honors workflow stop deadline before advancing after downtime', (t) => {
  const { e, advance } = fixture(t);
  const f = flow();
  f.execution = { workflowTotalTimeoutSec: 5, timeoutAction: 'stop' };
  f.nodes = [
    { id: 'start', type: 'start', next: 'delay' },
    { id: 'delay', type: 'delay', delaySec: 10, next: 'end' },
    { id: 'end', type: 'end' },
  ];
  e.publish(f);
  const r = e.startRun('sample', 'x');
  advance(11000);
  assert.equal(e.getRun(r.id).status, 'cancelled');
});
test('Delay node execution timeout override takes precedence over workflow defaults', (t) => {
  const { e, advance } = fixture(t);
  const f = flow();
  f.nodes = [
    { id: 'start', type: 'start', next: 'delay' },
    {
      id: 'delay',
      type: 'delay',
      delaySec: 100,
      timeout: { stepTotalTimeoutSec: 5, timeoutAction: 'stop' },
      next: 'end',
    },
    { id: 'end', type: 'end' },
  ];
  e.publish(f);
  const r = e.startRun('sample', 'x');
  advance(6000);
  assert.equal(e.getRun(r.id).status, 'cancelled');
});
test('Repeat invalidates cached last output so a branch cannot publish stale candidate', (t) => {
  const { e } = fixture(t);
  const f = flow();
  f.nodes = [
    { id: 'start', type: 'start', next: 'gate' },
    {
      id: 'gate',
      type: 'condition',
      cases: [{ when: { '>=': [{ var: 'iteration' }, 2] }, next: 'end' }],
      otherwise: 'task',
    },
    { id: 'task', type: 'task', next: 'repeat' },
    { id: 'repeat', type: 'repeat', target: 'gate', maxIterations: 2 },
    { id: 'end', type: 'end' },
  ];
  e.publish(f);
  worker(e);
  const r = e.startRun('sample', 'x');
  finish(e, e.claim('w1', 'boot')!, 'old output');
  const finished = e.getRun(r.id);
  assert.equal(finished.outputArtifactId, undefined);
  assert.equal(finished.context.lastOutput, '');
  assert.equal(finished.context.previousOutput, 'old output');
});
test('send authorization checks the deadline even before the scheduler next ticks', (t) => {
  const { e, jump } = fixture(t);
  const f = flow();
  f.execution = { workflowTotalTimeoutSec: 5, timeoutAction: 'stop' };
  e.publish(f);
  worker(e);
  const r = e.startRun('sample', 'x');
  const a = e.claim('w1', 'boot')!;
  jump(6000);
  assert.throws(() => e.sendIntent(a.id, { generation: 'boot', fence: a.fence }), /not running/i);
  assert.equal(e.getRun(r.id).status, 'cancelled');
});
test('late result is saved but does not advance past an expired stop deadline', (t) => {
  const { e, jump } = fixture(t);
  const f = flow();
  f.execution = { workflowTotalTimeoutSec: 5, timeoutAction: 'stop' };
  e.publish(f);
  worker(e);
  const r = e.startRun('sample', 'x');
  const a = e.claim('w1', 'boot')!;
  e.sendIntent(a.id, { generation: 'boot', fence: a.fence });
  jump(6000);
  const result = e.completeText(a.id, 'late', 'complete', {});
  assert.equal(e.getRun(r.id).status, 'cancelled');
  assert.equal(e.getArtifact(result.artifactId).text, 'late');
});
test('Start conditions gate scheduled input as well as event-triggered input', (t) => {
  const { e, advance } = fixture(t);
  const f = flow();
  f.triggers = [
    {
      id: 'timed',
      type: 'schedule',
      intervalSec: 10,
      input: { topic: 'scheduled task', ready: false },
      when: { '===': [{ var: 'ready' }, true] },
    },
  ];
  e.publish(f);
  advance(10000);
  assert.equal(e.listRuns()[0].status, 'rejected');
  f.triggers[0].input = { topic: 'scheduled task', ready: true };
  e.publish(f);
  advance(10000);
  assert.ok(e.listRuns().some((r) => r.status === 'running'));
  worker(e);
  assert.ok(e.claim('w1', 'boot')!.prompt.includes('scheduled task'));
});
