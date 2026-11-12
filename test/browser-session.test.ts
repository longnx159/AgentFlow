import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromeBrowserSession } from '../src/worker/chrome.js';

test('browser session captures exact submitted user ID, journals receipt, and clicks once', async () => {
  const handlers = new Map<string, Function>();
  let gestures = 0;
  let persisted: any;
  let evaluated = 0;
  const page: any = {
    url: () => 'https://chatgpt.com/c/c12345678',
    on: (name: string, fn: Function) => handlers.set(name, fn),
    off: (name: string) => handlers.delete(name),
    evaluate: async () => {
      evaluated++;
      return { conversationId: 'c12345678', userIds: ['u-old'], loggedOut: false, marker: 'af-x' };
    },
    locator: (selector: string) => ({
      last() {
        return this;
      },
      first() {
        return this;
      },
      fill: async () => {},
      click: async () => {
        gestures++;
        handlers.get('request')?.({
          method: () => 'POST',
          url: () => 'https://chatgpt.com/backend-api/conversation',
          postDataJSON: () => ({
            messages: [
              {
                id: 'submitted-uuid',
                author: { role: 'user' },
                content: { parts: ['the exact prompt'] },
              },
            ],
          }),
        });
        throw Error('CDP disconnected after input dispatched');
      },
    }),
  };
  const browser: any = { contexts: () => [{ pages: () => [page], newPage: async () => page }] };
  const session = new ChromeBrowserSession({ dataDir: 'unused' }, async () => browser);
  const prepared = await session.prepare('the exact prompt', 'af-x');
  await assert.rejects(
    session.clickSend(prepared, (r) => {
      persisted = r;
    }),
    /CDP disconnected/,
  );
  assert.equal(gestures, 1);
  assert.equal(persisted.userMessageId, 'submitted-uuid');
  assert.equal(persisted.conversationId, 'c12345678');
  assert.ok(evaluated > 0);
});
