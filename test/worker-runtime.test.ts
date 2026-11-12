import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker } from '../src/worker/main.js';
test('local async observer responds 202, persists pairing, and never claims before human login', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-runtime-'));
  let claims = 0;
  let ready = false;
  const requests: any[] = [];
  const manager = createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(text || '{}') });
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/claim')) claims++;
    res.end(
      JSON.stringify(
        req.url?.endsWith('/register')
          ? {
              credential: 'issued-local',
              settingsVersion: 3,
              connection: { heartbeatIntervalSec: 1, longPollWaitSec: 0 },
            }
          : { attempt: null, settingsVersion: 3 },
      ),
    );
  });
  await new Promise<void>((r) => manager.listen(0, '127.0.0.1', r));
  const runtime = await startWorker(
    {
      managerUrl: `http://127.0.0.1:${(manager.address() as any).port}`,
      workerId: 'w-runtime',
      name: 'test',
      roles: ['writer'],
      pairingToken: 'pair',
      dataDir: dir,
      headless: false,
      offscreen: false,
      cdpPort: 9335,
      uiPort: 0,
    },
    {
      driver: {
        async ready() {
          return ready;
        },
        async prepare() {
          throw Error('must not send');
        },
        async send() {
          throw Error('must not send');
        },
        async observe() {
          return { status: 'uncertain' };
        },
        async close() {},
      },
      tickMs: 20,
    },
  );
  try {
    const status = (await fetch(`${runtime.url}/api/local/status`).then((r) => r.json())) as any;
    assert.equal(status.workerId, 'w-runtime');
    assert.equal((await fetch(`${runtime.url}/api/local/start`, { method: 'POST' })).status, 202);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(claims, 0);
    assert.equal(runtime.journal.setting('credential'), 'issued-local');
    assert.equal(JSON.stringify(status).includes('issued-local'), false);
    const crossOrigin = await fetch(`${runtime.url}/api/local/start`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.invalid' },
    });
    assert.equal(crossOrigin.status, 403);
    ready = true;
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(claims > 0);
    assert.equal(requests[0].body.pairingToken, 'pair');
    assert.ok(
      requests
        .filter((r) => r.url.endsWith('/claim'))
        .every((r) => r.headers.authorization === 'Bearer issued-local'),
    );
  } finally {
    await runtime.close();
    await new Promise<void>((r) => manager.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
test('lost initial pairing ACK recovers the same generation and token after a cold restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-pair-restart-'));
  const registrations: any[] = [];
  const manager = createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const body = JSON.parse(text || '{}');
    if (req.url?.endsWith('/register')) {
      if (!body.pairingToken) {
        res.statusCode = 401;
        res.end('{"error":"pair first"}');
        return;
      }
      registrations.push(body);
      if (registrations.length === 1) {
        res.destroy();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ credential: 'recovered-credential', settingsVersion: 1 }));
    } else res.end('{}');
  });
  await new Promise<void>((r) => manager.listen(0, '127.0.0.1', r));
  const config = {
    managerUrl: `http://127.0.0.1:${(manager.address() as any).port}`,
    workerId: 'cold-pair',
    name: 'cold',
    roles: ['default'],
    dataDir: dir,
    headless: false,
    offscreen: false,
    cdpPort: 9335,
    uiPort: 0,
  };
  const driver: any = { ready: async () => false, close: async () => {} };
  let runtime = await startWorker(config, { driver, tickMs: 20 });
  try {
    await fetch(`${runtime.url}/api/local/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingToken: 'local-pair-token' }),
    });
    await new Promise((r) => setTimeout(r, 70));
    await runtime.close();
    runtime = await startWorker(config, { driver, tickMs: 20 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(runtime.journal.setting('credential'), 'recovered-credential');
    assert.equal(registrations[0].generation, registrations[1].generation);
    assert.equal(registrations[1].pairingToken, 'local-pair-token');
  } finally {
    await runtime.close();
    manager.closeAllConnections();
    await new Promise<void>((r) => manager.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
