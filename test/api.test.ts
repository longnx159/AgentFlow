import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createManager } from '../src/manager/server.js';
const definition = {
  id: 'api-flow',
  name: 'API flow',
  enabled: true,
  entry: 's',
  triggers: [{ id: 'm', type: 'manual' }],
  nodes: [
    { id: 's', type: 'start', next: 't' },
    { id: 't', type: 'task', next: 'e' },
    { id: 'e', type: 'end' },
  ],
};
test('authenticated HTTP queue streams large exact output and deduplicates result ACK loss', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'af-http-'));
  const m = await createManager({
    dataDir,
    adminToken: 'admin-secret',
    pairingToken: 'pair-secret',
    editor: false,
  });
  await m.start(0, '127.0.0.1');
  t.after(async () => {
    await m.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const port = (m.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const json = async (path: string, body: any, token = 'admin-secret') => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    assert.ok(res.ok, `${path}: ${res.status} ${!res.ok ? await res.text() : ''}`);
    return res.json() as Promise<any>;
  };
  assert.equal((await fetch(base + '/api/v1/settings')).status, 401);
  await json('/api/v1/workflows', definition);
  const run = await json('/api/v1/workflows/api-flow/runs', { input: 'Do it' });
  const reg = await json(
    '/api/v1/workers/register',
    {
      workerId: 'worker',
      name: 'Worker',
      roles: ['default'],
      generation: 'g1',
      pairingToken: 'pair-secret',
    },
    '',
  );
  const { attempt } = await json(
    '/api/v1/workers/worker/claim',
    { generation: 'g1', waitSeconds: 0 },
    reg.credential,
  );
  assert.equal(
    (
      await json(
        `/api/v1/attempts/${attempt.id}/send-intent`,
        { generation: 'g1', fence: attempt.fence },
        reg.credential,
      )
    ).authorized,
    true,
  );
  const raw = Buffer.from('  Nội dung\n```py\n    x = 1\n```\n'.repeat(40000));
  const sha = createHash('sha256').update(raw).digest('hex');
  const upload = () =>
    fetch(base + `/api/v1/attempts/${attempt.id}/result?status=complete`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${reg.credential}`,
        'content-type': 'application/octet-stream',
        'x-content-sha256': sha,
      },
      body: raw,
    });
  const response = await upload();
  assert.equal(response.status, 200);
  const result: any = await response.json();
  assert.equal((await upload()).status, 200);
  const output = await fetch(base + `/api/v1/artifacts/${result.artifactId}`, {
    headers: { authorization: 'Bearer admin-secret' },
  });
  assert.deepEqual(Buffer.from(await output.arrayBuffer()), raw);
  assert.equal(m.engine.getRun(run.id).status, 'succeeded');
  const plain = await fetch(base + `/api/v1/artifacts/${result.artifactId}?format=txt`, {
    headers: { authorization: 'Bearer admin-secret' },
  });
  assert.ok(plain.headers.get('content-type')?.startsWith('text/plain'));
  assert.deepEqual(Buffer.from(await plain.arrayBuffer()), raw);
  const wrapper = await fetch(base + `/api/v1/artifacts/${result.artifactId}?format=json`, {
    headers: { authorization: 'Bearer admin-secret' },
  });
  assert.equal(((await wrapper.json()) as any).response, raw.toString('utf8'));
});
test('bad artifact checksum cannot advance a run; foreign worker cannot alter attempt', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'af-http-'));
  const m = await createManager({
    dataDir,
    adminToken: 'admin',
    pairingToken: 'pair',
    editor: false,
  });
  await m.start(0, '127.0.0.1');
  t.after(async () => {
    await m.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(m.server.address() as any).port}`;
  m.engine.publish(definition as any);
  const r = m.engine.startRun('api-flow', 'x');
  const a1 = m.engine.registerWorker({
    workerId: 'a',
    roles: ['default'],
    generation: 'g',
    pairingToken: 'pair',
  });
  const b = m.engine.registerWorker({
    workerId: 'b',
    roles: ['default'],
    generation: 'g',
    pairingToken: 'pair',
  });
  const a = m.engine.claim('a', 'g')!;
  m.engine.sendIntent(a.id, { generation: 'g', fence: a.fence });
  assert.equal(
    (
      await fetch(`${base}/api/v1/attempts/${a.id}/result?status=complete`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${b.credential}`, 'x-content-sha256': '0'.repeat(64) },
        body: 'wrong',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/v1/attempts/${a.id}/result?status=complete`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${a1.credential}`, 'x-content-sha256': '0'.repeat(64) },
        body: 'wrong',
      })
    ).status,
    400,
  );
  assert.notEqual(m.engine.getRun(r.id).status, 'succeeded');
});
test('Node-RED bearer token does not shadow a valid Manager login cookie', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'af-auth-'));
  const m = await createManager({
    dataDir,
    adminToken: 'admin',
    pairingToken: 'pair',
    editor: false,
  });
  await m.start(0, '127.0.0.1');
  t.after(async () => {
    await m.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(m.server.address() as any).port}`;
  const response = await fetch(base + '/api/v1/settings', {
    headers: { authorization: 'Bearer a-node-red-token', cookie: 'af_admin=admin' },
  });
  assert.equal(response.status, 200);
});
