import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManager } from '../src/manager/server.js';
import { ManagerClient, WorkerAgent } from '../src/worker/agent.js';
import { WorkerJournal } from '../src/worker/journal.js';
import { ChatGptDriver } from '../src/worker/browser.js';

test('real Manager HTTP accepts pre-send preparation failure and operator resume creates a fresh attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-worker-manager-'));
  const manager = await createManager({
    dataDir: join(dir, 'manager'),
    adminToken: 'admin',
    pairingToken: 'pair',
    editor: false,
  });
  await manager.start(0, '127.0.0.1');
  const client = new ManagerClient(`http://127.0.0.1:${(manager.server.address() as any).port}`);
  const journal = new WorkerJournal(join(dir, 'worker.sqlite'));
  try {
    const ack = await client.request('/api/v1/workers/register', {
      workerId: 'w',
      name: 'worker',
      roles: ['default'],
      generation: 'g',
      pairingToken: 'pair',
    });
    client.credential = ack.credential;
    manager.engine.publish({
      id: 'prep',
      name: 'Prep',
      enabled: true,
      entry: 'start',
      triggers: [],
      nodes: [
        { id: 'start', type: 'start', next: 'task' },
        { id: 'task', type: 'task', skill: 'Write raw Markdown', next: 'done' },
        { id: 'done', type: 'end' },
      ],
    });
    const run = manager.engine.startRun('prep', 'input');
    const claim = await client.request('/api/v1/workers/w/claim', {
      generation: 'g',
      waitSeconds: 0,
    });
    journal.accept(claim.attempt);
    let gestures = 0;
    const driver = new ChatGptDriver({
      async prepare() {
        throw Error('Login expired before filling prompt');
      },
      async clickSend() {
        gestures++;
        throw Error('must not click');
      },
      async read() {
        throw Error('must not read');
      },
      async close() {},
    });
    await new WorkerAgent({ workerId: 'w', generation: 'g', journal, client, driver }).tick();
    assert.equal(journal.active(), undefined);
    assert.equal(gestures, 0);
    const failed = manager.engine.getAttempt(claim.attempt.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.sentAt, undefined);
    assert.equal(manager.engine.getRun(run.id).status, 'needsReview');
    manager.engine.controlRun(run.id, 'resume');
    const next = await client.request('/api/v1/workers/w/claim', {
      generation: 'g',
      waitSeconds: 0,
    });
    assert.ok(next.attempt);
    assert.notEqual(next.attempt.id, claim.attempt.id);
  } finally {
    journal.close();
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
