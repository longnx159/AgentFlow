import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { WorkerJournal } from '../src/worker/journal.js';
import { WorkerAgent, ManagerClient } from '../src/worker/agent.js';
import type { BrowserDriver } from '../src/worker/browser.js';
import type { AttemptJob } from '../src/shared/types.js';

const job: AttemptJob = {
  id: 'a1',
  jobId: 'j1',
  runId: 'r1',
  nodeExecutionId: 'ne1',
  nodeId: 'n1',
  workerId: 'w1',
  generation: 'g1',
  fence: 'f1',
  state: 'leased',
  prompt: 'test',
  execution: {
    noProgressTimeoutSec: 1,
    stepTotalTimeoutSec: null,
    workflowTotalTimeoutSec: null,
    timeoutAction: 'warn',
  },
  createdAt: 1,
  leaseUntil: Date.now() + 60000,
};
async function setup(t: any, authorize = true) {
  const dir = mkdtempSync(join(tmpdir(), 'af-worker-'));
  let sends = 0;
  let remoteState = 'sending';
  let dropNextEventAck = false;
  let dropNextStatus = false;
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    let bytes = Buffer.alloc(0);
    for await (const chunk of req) bytes = Buffer.concat([bytes, chunk]);
    received.push({ url: req.url, headers: req.headers, bytes });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && dropNextStatus) {
      dropNextStatus = false;
      res.destroy();
      return;
    }
    if (req.url?.endsWith('/events') && dropNextEventAck) {
      dropNextEventAck = false;
      remoteState = 'failed';
      res.destroy();
      return;
    }
    res.end(
      JSON.stringify(
        req.method === 'GET'
          ? { state: remoteState }
          : req.url?.endsWith('send-intent')
            ? { authorized: authorize, state: 'sending' }
            : req.url?.includes('/result')
              ? { accepted: true, artifactId: 'art1' }
              : { accepted: true },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as any;
  const journal = new WorkerJournal(join(dir, 'worker.sqlite'));
  const journals = [journal];
  const client = new ManagerClient(`http://127.0.0.1:${address.port}`, 'credential');
  const driver: BrowserDriver = {
    async prepare(_p, marker) {
      return { marker, baselineUserIds: [] };
    },
    async send(r, before, onReceipt) {
      before();
      sends++;
      const out = { ...r, userMessageId: 'u1', conversationId: 'c1' };
      onReceipt(out);
      return out;
    },
    async observe() {
      return {
        status: 'complete',
        text: '  raw\n',
        parts: ['  raw\n'],
        userMessageId: 'u1',
        replyId: 'a1',
      };
    },
    async close() {},
  };
  t.after(async () => {
    for (const journal of journals) journal.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    journal,
    journals,
    client,
    driver,
    received,
    dir,
    get sends() {
      return sends;
    },
    set remoteState(value: string) {
      remoteState = value;
    },
    set dropNextEventAck(value: boolean) {
      dropNextEventAck = value;
    },
    set dropNextStatus(value: boolean) {
      dropNextStatus = value;
    },
  };
}
test('durable sending journal survives restart and reconciles without sending again', async (t) => {
  const s = await setup(t);
  s.journal.accept(job);
  s.journal.update(job.id, {
    state: 'sending',
    receipt: { marker: 'af-a1', baselineUserIds: [], userMessageId: 'u1', conversationId: 'c1' },
  });
  const reopened = new WorkerJournal(join(s.dir, 'worker.sqlite'));
  s.journals.push(reopened);
  const agent = new WorkerAgent({
    workerId: 'w1',
    generation: 'new-generation',
    journal: reopened,
    client: s.client,
    driver: s.driver,
  });
  await agent.tick();
  assert.equal(s.sends, 0);
  assert.equal(s.journal.get(job.id)?.state, 'acked');
  const upload = s.received.find((x) => x.url.includes('/result'));
  assert.equal(upload.bytes.toString(), '  raw\n');
  assert.equal(
    upload.headers['x-content-sha256'],
    createHash('sha256').update('  raw\n').digest('hex'),
  );
  assert.equal(
    JSON.parse(Buffer.from(upload.headers['x-result-metadata'], 'base64').toString()).generation,
    'new-generation',
  );
});
test('explicit remote operator resolution frees unknown work and preserves receipt without a send', async (t) => {
  const s = await setup(t);
  s.journal.accept(job);
  s.journal.update(job.id, {
    state: 'uncertain',
    receipt: { marker: 'af-a1', baselineUserIds: [], userMessageId: 'u1', conversationId: 'c1' },
  });
  s.remoteState = 'resolved';
  let observations = 0;
  s.driver.observe = async () => {
    observations++;
    return { status: 'uncertain' };
  };
  await new WorkerAgent({
    workerId: 'w1',
    generation: 'new-generation',
    journal: s.journal,
    client: s.client,
    driver: s.driver,
  }).tick();
  assert.equal(s.journal.active(), undefined);
  assert.equal(s.journal.get(job.id)?.error, 'Operator resolved');
  assert.equal(s.journal.get(job.id)?.receipt?.userMessageId, 'u1');
  assert.equal(s.sends, 0);
  assert.equal(observations, 0);
});
test('an expired old-generation claimed lease releases only the old slot without browser input', async (t) => {
  const s = await setup(t);
  s.journal.accept(job);
  s.remoteState = 'expired';
  await new WorkerAgent({
    workerId: 'w1',
    generation: 'new-generation',
    journal: s.journal,
    client: s.client,
    driver: s.driver,
  }).tick();
  assert.equal(s.journal.active(), undefined);
  assert.equal(s.sends, 0);
  assert.equal(
    s.received.some((x) => x.url.endsWith('/send-intent')),
    false,
  );
});
test('preparation failure reports notSent then releases slot without gesture or retry', async (t) => {
  const s = await setup(t);
  s.journal.accept(job);
  s.remoteState = 'assigned';
  s.driver.prepare = async () => {
    throw Error('login expired before preparation');
  };
  const agent = new WorkerAgent({
    workerId: 'w1',
    generation: 'g1',
    journal: s.journal,
    client: s.client,
    driver: s.driver,
  });
  await agent.tick();
  await agent.tick();
  assert.equal(s.journal.active(), undefined);
  assert.equal(s.sends, 0);
  assert.match(s.journal.get(job.id)?.error ?? '', /login expired/);
  assert.equal(
    s.received.some((x) => x.url.endsWith('/send-intent')),
    false,
  );
  const event = s.received.find((x) => x.url.endsWith('/events'));
  assert.equal(JSON.parse(event.bytes.toString()).state, 'notSent');
});
test('a transient status GET failure before send authority preserves the unsent claim for one eventual gesture', async (t) => {
  const s = await setup(t);
  s.journal.accept(job);
  s.dropNextStatus = true;
  const agent = new WorkerAgent({
    workerId: 'w1',
    generation: 'g1',
    journal: s.journal,
    client: s.client,
    driver: s.driver,
  });
  await assert.rejects(agent.tick());
  assert.equal(s.journal.active()?.state, 'claimed');
  assert.equal(s.sends, 0);
  await agent.tick();
  assert.equal(s.sends, 1);
  assert.equal(s.journal.active(), undefined);
});
test('notSent event ACK loss replays the same durable event before releasing without observation', async (t) => {
  const s = await setup(t);
  s.journal.accept(job);
  s.remoteState = 'assigned';
  s.dropNextEventAck = true;
  s.driver.prepare = async () => {
    throw Error('composer unavailable');
  };
  let observations = 0;
  s.driver.observe = async () => {
    observations++;
    return { status: 'uncertain' };
  };
  const options = {
    workerId: 'w1',
    generation: 'g1',
    journal: s.journal,
    client: s.client,
    driver: s.driver,
  };
  await assert.rejects(new WorkerAgent(options).tick());
  const pending = s.journal.active()!.event!;
  assert.equal(pending.state, 'notSent');
  await new WorkerAgent(options).tick();
  assert.equal(s.journal.active(), undefined);
  assert.equal(observations, 0);
  assert.equal(s.sends, 0);
  const events = s.received
    .filter((x) => x.url.endsWith('/events'))
    .map((x) => JSON.parse(x.bytes.toString()));
  assert.equal(events.length, 2);
  assert.equal(events[0].eventId, events[1].eventId);
  assert.equal(events[0].seq, events[1].seq);
});
test('duplicate send authorization never reaches browser and keeps one occupied slot', async (t) => {
  const s = await setup(t, false);
  s.journal.accept(job);
  const agent = new WorkerAgent({
    workerId: 'w1',
    generation: 'g1',
    journal: s.journal,
    client: s.client,
    driver: s.driver,
  });
  await agent.tick();
  assert.equal(s.sends, 0);
  assert.equal(s.journal.active()?.state, 'uncertain');
  assert.throws(() => s.journal.accept({ ...job, id: 'a2' }), /active/);
});
test('send gesture sees committed sending state and lost result ACK retries only upload', async (t) => {
  const s = await setup(t);
  s.journal.accept(job);
  let sawSending = false;
  const original = s.driver.send;
  s.driver.send = async (r, before, onReceipt) =>
    original(
      r,
      () => {
        before();
        sawSending = s.journal.get(job.id)?.state === 'sending';
      },
      onReceipt,
    );
  const agent = new WorkerAgent({
    workerId: 'w1',
    generation: 'g1',
    journal: s.journal,
    client: s.client,
    driver: s.driver,
  });
  await agent.tick();
  await agent.tick();
  await agent.tick();
  assert.equal(sawSending, true);
  assert.equal(s.sends, 1);
  assert.equal(s.journal.get(job.id)?.state, 'acked');
});
test('lost upload ACK survives actual journal reopen and retries identical bytes without another browser send', async (t) => {
  const s = await setup(t);
  s.journal.accept(job);
  let uploadCalls = 0;
  const upload = s.client.upload.bind(s.client);
  s.client.upload = async (...args) => {
    const ack = await upload(...args);
    if (++uploadCalls === 1) throw Error('ACK connection lost');
    return ack;
  };
  const agent = new WorkerAgent({
    workerId: 'w1',
    generation: 'g1',
    journal: s.journal,
    client: s.client,
    driver: s.driver,
  });
  await assert.rejects(agent.tick(), /ACK connection lost/);
  assert.equal(s.journal.active()?.state, 'result');
  const reopened = new WorkerJournal(join(s.dir, 'worker.sqlite'));
  s.journals.push(reopened);
  await new WorkerAgent({
    workerId: 'w1',
    generation: 'g2',
    journal: reopened,
    client: s.client,
    driver: s.driver,
  }).tick();
  assert.equal(s.sends, 1);
  assert.equal(reopened.get(job.id)?.state, 'acked');
  const uploads = s.received.filter((x) => x.url.includes('/result'));
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[0].bytes, uploads[1].bytes);
  assert.equal(uploads[0].headers['x-content-sha256'], uploads[1].headers['x-content-sha256']);
});
test('an indefinitely streaming reply changes progress without total timeout and retains its slot', async (t) => {
  const s = await setup(t);
  s.journal.accept({ ...job, createdAt: Date.now() - 3600000 });
  s.journal.update(job.id, {
    state: 'observing',
    receipt: { marker: 'af-a1', baselineUserIds: [], userMessageId: 'u1' },
    progressAt: 1,
  });
  s.driver.observe = async () => ({
    status: 'partial',
    text: 'still generating',
    parts: ['still generating'],
  });
  const agent = new WorkerAgent({
    workerId: 'w1',
    generation: 'g1',
    journal: s.journal,
    client: s.client,
    driver: s.driver,
  });
  await agent.tick();
  assert.equal(s.journal.active()?.state, 'observing');
  assert.ok(s.journal.active()!.progressAt > Date.now() - 1000);
  assert.equal(s.sends, 0);
  assert.equal(
    s.received.some((x) => x.url.includes('/result')),
    false,
  );
  const event = s.received.find((x) => x.url.endsWith('/events'));
  assert.equal(JSON.parse(event.bytes.toString()).state, 'running');
});
test('terminal clipped partial uploads its exact artifact without representing it as complete', async (t) => {
  const s = await setup(t);
  s.journal.accept(job);
  s.journal.update(job.id, {
    state: 'observing',
    receipt: { marker: 'af-a1', baselineUserIds: [], userMessageId: 'u1' },
  });
  s.driver.observe = async () => ({
    status: 'partial',
    text: '  unfinished\n',
    parts: ['  unfinished\n'],
    metadata: { terminal: true, finishDetails: { type: 'max_tokens' } },
  });
  await new WorkerAgent({
    workerId: 'w1',
    generation: 'g1',
    journal: s.journal,
    client: s.client,
    driver: s.driver,
  }).tick();
  assert.equal(s.journal.active(), undefined);
  assert.equal(s.sends, 0);
  const result = s.received.find((x) => x.url.includes('/result'));
  assert.equal(result.url, '/api/v1/attempts/a1/result?status=partial');
  assert.equal(result.bytes.toString(), '  unfinished\n');
  assert.equal(s.journal.get(job.id)?.result?.status, 'partial');
});
