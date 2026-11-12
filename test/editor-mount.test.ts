import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mountEditor } from '../src/editor/index.js';
test('embedded editor protects drafts, rejects executable deploys, and publishes only explicit validated snapshots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'af-editor-'));
  const app = express();
  const server = createServer(app);
  let published: any;
  const editor = await mountEditor({
    app,
    server,
    dataDir: dir,
    adminToken: 'test-admin-token',
    authorize: (q, r, n) =>
      q.get('authorization') === 'Bearer test-admin-token' ||
      q.get('cookie') === 'af_admin=test-admin-token'
        ? n()
        : r.status(401).json({ error: 'unauthorized' }),
    engine: {
      publish: (w: any) => {
        if (w.nodes.some((n: any) => n.type === 'task' && !n.skill))
          throw new Error('skill required');
        published = structuredClone(w);
        return { ...w, version: 1 };
      },
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };
  const draft = [
    { id: 'wf', type: 'tab', label: 'Safe draft' },
    { id: 's', type: 'af-start', z: 'wf', wires: [['e']] },
    { id: 'e', type: 'af-end', z: 'wf', wires: [] },
  ];
  try {
    assert.equal((await fetch(base + '/api/v1/editor/drafts')).status, 401);
    assert.equal((await fetch(base + '/flows/')).status, 401);
    assert.equal(
      (
        await fetch(base + '/api/v1/editor/drafts', {
          method: 'POST',
          headers,
          body: JSON.stringify({ flows: draft }),
        })
      ).status,
      200,
    );
    assert.equal(published, undefined);
    assert.equal(
      (
        await fetch(base + '/flows/flows', {
          method: 'POST',
          headers,
          body: JSON.stringify([{ id: 'x', type: 'function' }]),
        })
      ).status,
      400,
    );
    const RED = createRequire(import.meta.url)('node-red');
    for (const kind of ['start', 'task', 'review', 'condition', 'repeat', 'delay', 'end'])
      assert.equal(typeof RED.nodes.getType('af-' + kind), 'function');
    for (const kind of ['function', 'inject', 'exec'])
      assert.equal(RED.nodes.getType(kind), undefined);
    for (let i = 0; i < 50 && !RED.nodes.getNode('s'); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(RED.nodes.getNode('s').listenerCount('input'), 0);
    let r = await fetch(base + '/api/v1/editor/drafts', { headers });
    let saved: any = await r.json();
    assert.equal(saved.flows.length, 3);
    assert.ok(saved.rev);
    r = await fetch(base + '/api/v1/editor/publish', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: 'wf', revision: 'stale' }),
    });
    assert.equal(r.status, 409);
    assert.equal(published, undefined);
    r = await fetch(base + '/api/v1/editor/publish', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: 'wf', revision: saved.rev }),
    });
    assert.equal(r.status, 200);
    assert.equal((published as any).entry, 's');
    r = await fetch(base + '/api/v1/editor/drafts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        flows: [...draft, { id: 'bad', z: 'wf', type: 'af-task', wires: [] }],
      }),
    });
    assert.equal(r.status, 200);
    r = await fetch(base + '/api/v1/editor/publish', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: 'wf' }),
    });
    assert.equal(r.status, 400);
    assert.equal((published as any).nodes.length, 2);
  } finally {
    await editor.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('unsafe persisted startup draft fails closed before Node-RED initialization', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'af-editor-unsafe-'));
  await mkdir(path.join(dir, 'editor'));
  await writeFile(
    path.join(dir, 'editor', 'flows.json'),
    JSON.stringify([{ id: 'evil', type: 'exec' }]),
  );
  const app = express();
  const server = createServer(app);
  try {
    await assert.rejects(
      mountEditor({
        app,
        server,
        dataDir: dir,
        adminToken: 'test-admin-token',
        authorize: (_q, _r, n) => n(),
        engine: {
          publish: () => {
            throw new Error('must not publish');
          },
        },
      }),
      /not allowed/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
