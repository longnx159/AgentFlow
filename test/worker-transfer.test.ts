import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ManagerClient } from '../src/worker/agent.js';

test('result upload timeout measures idle gaps, so a progressing response can exceed the idle interval', async () => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/metadata')) {
      res.end('{"accepted":true}');
      return;
    }
    res.write('{"accepted":');
    await new Promise((r) => setTimeout(r, 40));
    res.write('true,');
    await new Promise((r) => setTimeout(r, 40));
    res.write('"artifactId":');
    await new Promise((r) => setTimeout(r, 40));
    res.end('"art"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new ManagerClient(`http://127.0.0.1:${(server.address() as any).port}`, 'cred');
    client.connection.artifactTransferIdleSec = 0.09;
    const ack = await client.upload('a', { status: 'complete', text: 'raw', parts: ['raw'] }, 'g');
    assert.equal(ack.artifactId, 'art');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
