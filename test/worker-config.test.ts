import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkerConfig } from '../src/worker/config.js';
test('environment config separates browser, polling and Manager API settings', () => {
  const config = loadWorkerConfig({
    AF_MANAGER_URL: 'http://manager:7070',
    AF_WORKER_ID: 'vm2',
    AF_WORKER_ROLES: 'review, writer',
    AF_WORKER_DATA_DIR: './data-vm2',
    HEADLESS: 'false',
    CDP_PORT: '9333',
    AF_WORKER_UI_PORT: '7071',
  });
  assert.equal(config.managerUrl, 'http://manager:7070');
  assert.deepEqual(config.roles, ['review', 'writer']);
  assert.equal(config.headless, false);
  assert.equal(config.cdpPort, 9333);
  assert.equal(config.uiPort, 7071);
  assert.throws(() => loadWorkerConfig({ CDP_PORT: 'NaN' }), /CDP_PORT/);
  assert.throws(() => loadWorkerConfig({ AF_MANAGER_URL: 'file:///tmp/manager' }), /http/);
  assert.deepEqual(loadWorkerConfig({}).roles, ['default']);
  assert.equal(loadWorkerConfig({ HEADLESS: 'offscreen' }).offscreen, true);
  assert.equal(loadWorkerConfig({ HEADLESS: 'offscreen' }).headless, false);
});
