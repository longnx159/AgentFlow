import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatGptDriver,
  correlateConversation,
  type BrowserSession,
  type SendReceipt,
} from '../src/worker/browser.js';

const receipt: SendReceipt = {
  marker: 'af-test',
  baselineUserIds: ['old'],
  userMessageId: 'u1',
  conversationId: 'c1',
};
function tree(message: any, parent = 'u1') {
  return {
    current_node: 'a1',
    mapping: {
      u1: { parent: null, message: { id: 'u1', author: { role: 'user' } } },
      a1: { parent, message },
    },
  };
}

test('raw ordered text parts retain whitespace, citations and code without separators', () => {
  const result = correlateConversation(
    tree({
      id: 'a1',
      author: { role: 'assistant' },
      recipient: 'all',
      channel: 'final',
      status: 'finished_successfully',
      end_turn: true,
      content: { content_type: 'text', parts: ['  ```py\n    x=1\n', '```\ncite  '] },
      metadata: { content_references: [{ url: 'https://example.org/source', title: 'Source' }] },
    }),
    receipt,
  );
  assert.equal(result.status, 'complete');
  assert.equal(result.text, '  ```py\n    x=1\n```\ncite  ');
  assert.deepEqual(result.parts, ['  ```py\n    x=1\n', '```\ncite  ']);
  assert.deepEqual(result.metadata?.messageMetadata.content_references, [
    { url: 'https://example.org/source', title: 'Source' },
  ]);
});
test('sibling branch, analysis, tool output and missing end-turn never complete', () => {
  const base = {
    id: 'a1',
    author: { role: 'assistant' },
    recipient: 'all',
    channel: 'final',
    status: 'finished_successfully',
    end_turn: true,
    content: { content_type: 'text', parts: ['answer'] },
  };
  assert.equal(correlateConversation(tree(base, 'different-user'), receipt).status, 'uncertain');
  for (const override of [
    { channel: 'analysis' },
    { recipient: 'python' },
    { end_turn: false },
    { status: 'in_progress' },
  ]) {
    assert.notEqual(
      correlateConversation(tree({ ...base, ...override }), receipt).status,
      'complete',
    );
  }
  assert.notEqual(
    correlateConversation(tree({ ...base, content: { content_type: 'text', parts: [] } }), receipt)
      .status,
    'complete',
  );
});
test('ambiguous click is never followed by another gesture; receipt permits later reconciliation', async () => {
  let gestures = 0,
    persisted = false;
  const session: BrowserSession = {
    async prepare() {
      return { marker: 'af-test', baselineUserIds: [] };
    },
    async clickSend(_r, onReceipt) {
      assert.equal(persisted, true);
      gestures++;
      onReceipt(receipt);
      throw new Error('connection lost after click');
    },
    async read() {
      return tree({
        id: 'a1',
        author: { role: 'assistant' },
        channel: 'final',
        status: 'finished_successfully',
        end_turn: true,
        content: { content_type: 'text', parts: ['late'] },
      });
    },
    async close() {},
  };
  const driver = new ChatGptDriver(session);
  const initial = await driver.prepare('prompt', 'af-test');
  const sent = await driver.send(
    initial,
    () => {
      persisted = true;
    },
    () => {},
  );
  assert.equal(gestures, 1);
  assert.equal(sent.userMessageId, 'u1');
  assert.equal((await driver.observe(sent)).text, 'late');
  assert.equal(gestures, 1);
});
test('receiptless cold restart cannot attribute another conversation response', async () => {
  let reads = 0;
  const driver = new ChatGptDriver({
    async prepare() {
      throw Error();
    },
    async clickSend() {
      throw Error();
    },
    async read() {
      reads++;
      return {};
    },
    async close() {},
  });
  assert.equal((await driver.observe({ marker: 'lost', baselineUserIds: [] })).status, 'uncertain');
  assert.equal(reads, 0);
});
test('a token-clipped final message is terminal partial with raw finish details', () => {
  const result = correlateConversation(
    tree({
      id: 'a1',
      author: { role: 'assistant' },
      recipient: 'all',
      channel: 'final',
      status: 'finished_successfully',
      end_turn: true,
      metadata: { finish_details: { type: 'max_tokens' } },
      content: { content_type: 'text', parts: ['  truncated code\n'] },
    }),
    receipt,
  );
  assert.equal(result.status, 'partial');
  assert.equal(result.metadata?.terminal, true);
  assert.deepEqual(result.metadata?.finishDetails, { type: 'max_tokens' });
  assert.equal(result.text, '  truncated code\n');
});
