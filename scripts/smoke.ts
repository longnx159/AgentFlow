import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createManager } from '../src/manager/server.js';
import { startWorker } from '../src/worker/main.js';
import type { BrowserDriver, SendReceipt } from '../src/worker/browser.js';
import type { BrowserResult } from '../src/shared/types.js';

// Real HTTP/SQLite/Node-RED/Worker orchestration; only the external ChatGPT browser boundary is fake.
class FixtureDriver implements BrowserDriver {
  sends = 0;
  constructor(readonly reviewer = false) {}
  async ready() {
    return true;
  }
  async prepare(_prompt: string, marker: string) {
    return { marker, baselineUserIds: [] } as SendReceipt;
  }
  async send(r: SendReceipt, before: () => void, receipt: (r: SendReceipt) => void) {
    before();
    this.sends++;
    const next = {
      ...r,
      userMessageId: `user-${this.sends}`,
      conversationId: `conversation-${this.sends}`,
    };
    receipt(next);
    return next;
  }
  async observe(r: SendReceipt): Promise<BrowserResult> {
    const text = this.reviewer
      ? JSON.stringify({
          passed: this.sends > 1,
          score: this.sends > 1 ? 95 : 45,
          issues: this.sends > 1 ? [] : ['Bổ sung kiểm chứng'],
        })
      : `  # Bản viết ${this.sends}\n\nNội dung tiếng Việt.\n\n\`\`\`py\n    __init__\n\`\`\`\n`;
    return {
      status: 'complete',
      text,
      parts: [text],
      conversationId: r.conversationId,
      userMessageId: r.userMessageId,
      replyId: `reply-${this.sends}`,
      metadata: { fixture: true },
    };
  }
  async close() {}
}
const dir = mkdtempSync(join(tmpdir(), 'agent-flow-smoke-'));
const manager = await createManager({
  dataDir: join(dir, 'manager'),
  adminToken: 'smoke-admin',
  pairingToken: 'smoke-pair',
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
try {
  await manager.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(manager.server.address() as any).port}`;
  manager.engine.updateSettings({
    connection: {
      longPollWaitSec: 1,
      longPollHttpTimeoutSec: 5,
      heartbeatIntervalSec: 0.2,
      offlineAfterSec: 5,
      preSendLeaseSec: 10,
    },
  });
  const writer = new FixtureDriver(),
    reviewer = new FixtureDriver(true);
  for (const [index, driver] of [writer, reviewer].entries())
    workers.push(
      await startWorker(
        {
          managerUrl: base,
          workerId: `fixture-${index}`,
          name: `VM ${index + 1}`,
          roles: [index === 0 ? 'writer' : 'reviewer'],
          pairingToken: 'smoke-pair',
          dataDir: join(dir, `worker-${index}`),
          headless: false,
          offscreen: false,
          cdpPort: 9223 + index,
          uiPort: 0,
        },
        { driver, tickMs: 30 },
      ),
    );
  for (const worker of workers) assert.equal((await fetch(worker.url)).status, 200);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator('#token').fill('smoke-admin');
  await page.locator('#login-form button').click();
  await page.locator('#shell').waitFor({ state: 'visible' });
  await page.locator('#new-example').click();
  await page.locator('[data-publish]').first().waitFor();
  // The bundled example intentionally uses role "default" for out-of-box use.
  // Configure the two roles through the real draft API, as a user would in the editor.
  const draft = await (await page.request.get(base + '/api/v1/editor/drafts')).json();
  for (const n of draft.flows) {
    if (n.type === 'af-task') n.role = 'writer';
    if (n.type === 'af-review') n.role = 'reviewer';
  }
  assert.ok((await page.request.post(base + '/api/v1/editor/drafts', { data: draft })).ok());
  await page.locator('#refresh').click();
  await page.waitForTimeout(300);
  await page.locator('[data-publish]').first().click();
  await page.locator('[data-start]').first().waitFor();
  await page.locator('[data-start]').first().click();
  await page
    .locator('#dialog-json')
    .fill(JSON.stringify({ topic: 'Kiểm thử chuỗi Writer → Reviewer và chạy lại' }));
  await page.locator('#dialog-confirm').click();
  const until = Date.now() + 20000;
  while (!manager.engine.listRuns().some((r) => r.status === 'succeeded')) {
    if (Date.now() > until)
      throw new Error(`Smoke timeout ${JSON.stringify(manager.engine.snapshot())}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const run = manager.engine.listRuns().find((r) => r.status === 'succeeded')!;
  assert.equal(writer.sends, 2);
  assert.equal(reviewer.sends, 2);
  assert.ok(manager.engine.getArtifact(run.outputArtifactId).text.startsWith('  # Bản viết 2\n'));
  await page.locator('[data-view="settings"]').click();
  await page.locator('#set-noProgressTimeoutSec').fill('900');
  await page.locator('#save-settings').click();
  await page.waitForFunction(() =>
    document.getElementById('notice')?.textContent?.includes('Đã lưu'),
  );
  assert.equal(manager.engine.getSettings().execution.noProgressTimeoutSec, 900);
  await page.locator('[data-view="overview"]').click();
  await page.locator('#refresh').click();
  await page.locator('#recent-runs').getByText('succeeded').first().waitFor();
  mkdirSync(resolve('test-results'), { recursive: true });
  await page.screenshot({ path: resolve('test-results/manager.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      workers: 2,
      workflowRuns: 1,
      writerSends: writer.sends,
      reviewerSends: reviewer.sends,
      rawOutputPreserved: true,
      settingsSaved: true,
      screenshot: resolve('test-results/manager.png'),
    }),
  );
} finally {
  await browser?.close();
  for (const worker of workers) await worker.close();
  await manager.close();
  rmSync(dir, { recursive: true, force: true });
}
