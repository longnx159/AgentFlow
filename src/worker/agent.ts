import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ConnectionSettings, BrowserResult } from '../shared/types.js';
import type { BrowserDriver } from './browser.js';
import { WorkerJournal, type LocalAttempt } from './journal.js';
export const DEFAULT_CONNECTION: ConnectionSettings = {
  longPollWaitSec: 25,
  longPollHttpTimeoutSec: 35,
  apiRequestTimeoutSec: 30,
  heartbeatIntervalSec: 10,
  offlineAfterSec: 30,
  preSendLeaseSec: 60,
  artifactTransferIdleSec: 60,
};
export class ManagerClient {
  connection = { ...DEFAULT_CONNECTION };
  settingsVersion = 0;
  constructor(
    public url: string,
    public credential?: string,
  ) {}
  async request(
    path: string,
    body?: unknown,
    timeoutSec = this.connection.apiRequestTimeoutSec,
    method = 'POST',
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(new URL(path, this.url), {
      method,
      headers: {
        ...(this.credential ? { Authorization: `Bearer ${this.credential}` } : {}),
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, timeoutSec) * 1000),
    });
    if (!response.ok) throw Error(`Manager ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as any;
    if (data.connection) this.connection = { ...this.connection, ...data.connection };
    if (data.settingsVersion !== undefined) this.settingsVersion = data.settingsVersion;
    return data;
  }
  async upload(id: string, result: BrowserResult, generation: string) {
    if (result.text === undefined) throw Error('Missing raw result');
    const bytes = Buffer.from(result.text, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { text, ...rawMetadata } = result;
    await this.request(`/api/v1/attempts/${encodeURIComponent(id)}/metadata`, {
      generation,
      metadata: rawMetadata,
    });
    const metadata = Buffer.from(
      JSON.stringify({
        generation,
        conversationId: result.conversationId,
        userMessageId: result.userMessageId,
        replyId: result.replyId,
      }),
    ).toString('base64');
    const controller = new AbortController();
    let timer: NodeJS.Timeout;
    const progress = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(Error('Artifact transfer idle timeout')),
        this.connection.artifactTransferIdleSec * 1000,
      );
    };
    const chunks = async function* () {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        progress();
        yield bytes.subarray(offset, offset + 65536);
      }
    };
    // Reset on every transferred chunk and every ACK chunk. No generation or
    // total transfer deadline limits a continuously progressing long response.
    progress();
    try {
      const response = await fetch(
        new URL(
          `/api/v1/attempts/${encodeURIComponent(id)}/result?status=${result.status === 'complete' ? 'complete' : 'partial'}`,
          this.url,
        ),
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${this.credential}`,
            'Content-Type': 'application/octet-stream',
            'X-Content-SHA256': sha256,
            'X-Result-Metadata': metadata,
          },
          body: Readable.from(chunks()),
          duplex: 'half',
          signal: controller.signal,
        } as any,
      );
      progress();
      const reader = response.body?.getReader();
      const responseChunks: Uint8Array[] = [];
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          progress();
          responseChunks.push(value);
        }
      const responseText = Buffer.concat(responseChunks).toString('utf8');
      if (!response.ok) throw Error(`Result upload ${response.status}: ${responseText}`);
      const ack = JSON.parse(responseText);
      if (!ack.accepted) throw Error('Result ACK not accepted');
      return { ...ack, sha256 };
    } finally {
      clearTimeout(timer!);
    }
  }
}
export interface WorkerAgentOptions {
  workerId: string;
  generation: string;
  journal: WorkerJournal;
  client: ManagerClient;
  driver: BrowserDriver;
}
export class WorkerAgent {
  private busy = false;
  constructor(public options: WorkerAgentOptions) {}
  private async flushEvent(row: LocalAttempt) {
    if (!row.event) return;
    const { client, journal, generation } = this.options;
    const e = row.event;
    const ack = await client.request(`/api/v1/attempts/${encodeURIComponent(row.id)}/events`, {
      generation,
      eventId: e.id,
      seq: e.seq,
      state: e.state,
      progressAt: row.progressAt,
      message: e.message,
    });
    if (ack.accepted)
      journal.update(row.id, {
        event: undefined,
        ...(e.state === 'notSent' ? { state: 'acked' as const } : {}),
      });
  }
  private async event(row: LocalAttempt, state: string, message?: string) {
    const { journal } = this.options;
    const next = journal.update(row.id, {
      seq: row.seq + 1,
      event: { id: randomUUID(), seq: row.seq + 1, state, message },
    });
    await this.flushEvent(next);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    const { journal, client, driver, generation } = this.options;
    try {
      let row = journal.active();
      if (!row) return;
      if (row.state !== 'result') {
        const remote = await client.request(
          `/api/v1/attempts/${encodeURIComponent(row.id)}`,
          undefined,
          client.connection.apiRequestTimeoutSec,
          'GET',
        );
        if (remote.state === 'resolved') {
          journal.update(row.id, { state: 'acked', event: undefined, error: 'Operator resolved' });
          return;
        }
        if (row.state === 'claimed' && remote.state === 'expired') {
          journal.update(row.id, {
            state: 'acked',
            event: undefined,
            error: 'Pre-send lease expired',
          });
          return;
        }
      }
      if (row.event) {
        await this.flushEvent(row);
        row = journal.get(row.id)!;
        if (row.state === 'acked' || row.event?.state === 'notSent') return;
      }
      if (row.state === 'claimed') {
        let receipt;
        try {
          receipt = await driver.prepare(row.job.prompt, `af-${row.id}`);
        } catch (error) {
          row = journal.update(row.id, { state: 'uncertain', error: String(error) });
          await this.event(row, 'notSent', String(error));
          return;
        }
        // Commit a non-replayable intent BEFORE the network grant request. If its
        // reply is lost, a restart can only observe, never request/send again.
        row = journal.update(row.id, { state: 'sending', receipt });
        const grant = await client.request(
          `/api/v1/attempts/${encodeURIComponent(row.id)}/send-intent`,
          { generation, fence: row.job.fence },
        );
        if (!grant.authorized) {
          row = journal.update(row.id, {
            state: 'uncertain',
            error: 'Send authority already consumed or fenced',
          });
          await this.event(row, 'uncertain', row.error);
          return;
        }
        const id = row.id;
        receipt = await driver.send(
          receipt,
          () => {
            journal.update(id, { state: 'sending' });
          },
          (next) => {
            journal.update(id, { receipt: next });
          },
        );
        row = journal.update(id, {
          receipt,
          state: receipt.userMessageId ? 'observing' : 'uncertain',
          error: receipt.error,
        });
      }
      if (row.state === 'result' && row.result) {
        const ack = await client.upload(row.id, row.result, generation);
        journal.update(row.id, { state: 'acked', sha256: ack.sha256, artifactId: ack.artifactId });
        return;
      }
      const receipt = row.receipt ?? { marker: `af-${row.id}`, baselineUserIds: [] };
      const result = await driver.observe(receipt);
      if (result.conversationId && result.conversationId !== row.receipt?.conversationId)
        row = journal.update(row.id, {
          receipt: { ...receipt, conversationId: result.conversationId },
        });
      if (
        (result.status === 'complete' ||
          (result.status === 'partial' && result.metadata?.terminal === true)) &&
        typeof result.text === 'string' &&
        result.text.length > 0
      ) {
        row = journal.update(row.id, { state: 'result', result, progressAt: Date.now() });
        const ack = await client.upload(row.id, result, generation);
        journal.update(row.id, { state: 'acked', sha256: ack.sha256, artifactId: ack.artifactId });
        return;
      }
      const changed = result.text !== undefined && result.text !== row.result?.text;
      row = journal.update(row.id, {
        state: result.status === 'partial' ? 'observing' : 'uncertain',
        result,
        progressAt: changed ? Date.now() : row.progressAt,
        error: result.error,
      });
      const timeout = row.job.execution.noProgressTimeoutSec;
      const stalled = timeout !== null && Date.now() - row.progressAt >= timeout * 1000;
      if (
        changed ||
        result.status === 'uncertain' ||
        (stalled && Date.now() - (row.lastWarningAt ?? 0) >= Math.max(1000, (timeout ?? 1) * 1000))
      ) {
        if (stalled) row = journal.update(row.id, { lastWarningAt: Date.now() });
        await this.event(
          row,
          result.status === 'partial' ? 'running' : 'uncertain',
          stalled ? 'No progress warning; observing continues without resubmission' : result.error,
        );
      }
    } catch (error) {
      const row = journal.active();
      if (row) {
        journal.update(row.id, {
          state: row.state === 'result' || row.state === 'claimed' ? row.state : 'uncertain',
          error: String(error),
        });
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
