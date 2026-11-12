import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManager } from '../src/manager/server.js';
import { startWorker } from '../src/worker/main.js';
import type { BrowserDriver, SendReceipt } from '../src/worker/browser.js';
test(
  'ten independent Worker agents process a bounded concurrent queue over real HTTP without duplicates',
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-fleet-'));
    const manager = await createManager({
      dataDir: join(dir, 'manager'),
      adminToken: 'admin',
      pairingToken: 'pair',
      editor: false,
    });
    const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
    const gestures = new Set<string>();
    try {
      await manager.start(0, '127.0.0.1');
      const url = `http://127.0.0.1:${(manager.server.address() as any).port}`;
      manager.engine.updateSettings({
        connection: {
          longPollWaitSec: 0.2,
          longPollHttpTimeoutSec: 2,
          heartbeatIntervalSec: 0.2,
          offlineAfterSec: 5,
          preSendLeaseSec: 10,
        },
        limits: { globalConcurrentRuns: 4, perWorkflowConcurrentRuns: 4 },
      });
      manager.engine.publish({
        id: 'fleet',
        name: 'Two steps',
        enabled: true,
        entry: 'start',
        triggers: [],
        nodes: [
          { id: 'start', type: 'start', next: 'first' },
          { id: 'first', type: 'task', next: 'second' },
          { id: 'second', type: 'task', input: '{{steps.first.text}}', next: 'end' },
          { id: 'end', type: 'end' },
        ],
      });
      for (let n = 0; n < 10; n++) {
        const values = new Map<string, string>();
        const driver: BrowserDriver = {
          ready: async () => true,
          prepare: async (prompt, marker) => {
            values.set(marker, prompt);
            return { marker, baselineUserIds: [] };
          },
          send: async (r, before, onReceipt) => {
            before();
            assert.equal(gestures.has(r.marker), false);
            gestures.add(r.marker);
            const receipt = { ...r, userMessageId: r.marker, conversationId: r.marker };
            onReceipt(receipt);
            return receipt;
          },
          observe: async (r: SendReceipt) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
              status: 'complete',
              text: `Processed ${values.get(r.marker)}`,
              parts: [`Processed ${values.get(r.marker)}`],
              userMessageId: r.userMessageId,
            };
          },
          close: async () => {},
        };
        workers.push(
          await startWorker(
            {
              managerUrl: url,
              workerId: `vm-${n}`,
              name: `VM ${n}`,
              roles: ['default'],
              pairingToken: 'pair',
              dataDir: join(dir, `worker-${n}`),
              headless: false,
              offscreen: false,
              cdpPort: 9223 + n,
              uiPort: 0,
            },
            { driver, tickMs: 20 },
          ),
        );
      }
      const runs = Array.from({ length: 12 }, (_, n) =>
        manager.engine.startRun('fleet', `input-${n}`),
      );
      let max = 0;
      const deadline = Date.now() + 20000;
      while (manager.engine.listRuns().filter((r) => r.status === 'succeeded').length < 12) {
        const active = manager.engine.listRuns().filter((r) => r.status === 'running').length;
        max = Math.max(active, max);
        assert.ok(active <= 4);
        if (Date.now() > deadline) assert.fail(JSON.stringify(manager.engine.snapshot()));
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(max > 1);
      assert.equal(gestures.size, 24);
      assert.equal(manager.engine.listWorkers().length, 10);
      for (let n = 0; n < runs.length; n++)
        assert.equal(
          manager.engine.getArtifact(manager.engine.getRun(runs[n].id).outputArtifactId).text,
          `Processed Processed input-${n}`,
        );
    } finally {
      for (const worker of workers) await worker.close();
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
