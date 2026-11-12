import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { draftGuard } from '../src/editor/guard.js';
test('rejects stock executable full and single-flow deploy routes before downstream mutation', async () => {
  const app = express();
  app.use(express.json());
  app.use(draftGuard);
  app.use((_q, r) => r.json({ mutated: true }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for (const [path, method, body] of [
      ['/flows', 'POST', [{ id: 'bad', type: 'function' }]],
      ['/flows', 'POST', { rev: 'x', flows: [{ id: 'bad', type: 'inject' }] }],
      ['/flow', 'POST', { nodes: [{ id: 'bad', type: 'exec' }] }],
      ['/flow/tab', 'PUT', { nodes: [], configs: [{ id: 'bad', type: 'function' }] }],
    ] as const) {
      const r = await fetch(url + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 400);
      assert.equal(((await r.json()) as any).mutated, undefined);
    }
    const r = await fetch(url + '/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ id: 's', type: 'af-start' }]),
    });
    assert.equal(r.status, 200);
  } finally {
    await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  }
});
