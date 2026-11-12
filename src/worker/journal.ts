import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { AttemptJob, BrowserResult } from '../shared/types.js';
import type { SendReceipt } from './browser.js';
export interface LocalAttempt {
  id: string;
  job: AttemptJob;
  state: 'claimed' | 'sending' | 'observing' | 'uncertain' | 'result' | 'acked';
  receipt?: SendReceipt;
  result?: BrowserResult;
  progressAt: number;
  seq: number;
  event?: { id: string; seq: number; state: string; message?: string };
  lastWarningAt?: number;
  error?: string;
  sha256?: string;
  artifactId?: string;
}
export class WorkerJournal {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,state TEXT NOT NULL,data TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_active ON attempts((1)) WHERE state <> 'acked';`,
    );
  }
  close() {
    this.db.close();
  }
  setting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;
    return row ? JSON.parse(row.value) : undefined;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  accept(job: AttemptJob) {
    if (this.get(job.id)) return;
    if (this.active()) throw Error('Worker already has an active attempt');
    const row: LocalAttempt = { id: job.id, job, state: 'claimed', progressAt: Date.now(), seq: 0 };
    this.db
      .prepare('INSERT INTO attempts VALUES(?,?,?)')
      .run(job.id, row.state, JSON.stringify(row));
  }
  update(id: string, value: Partial<LocalAttempt>) {
    const old = this.get(id);
    if (!old) throw Error('Unknown local attempt');
    const row = { ...old, ...value };
    this.db
      .prepare('UPDATE attempts SET state=?,data=? WHERE id=?')
      .run(row.state, JSON.stringify(row), id);
    return row;
  }
  get(id: string): LocalAttempt | undefined {
    const row = this.db.prepare('SELECT data FROM attempts WHERE id=?').get(id) as any;
    return row ? JSON.parse(row.data) : undefined;
  }
  active(): LocalAttempt | undefined {
    const row = this.db
      .prepare("SELECT data FROM attempts WHERE state <> 'acked' LIMIT 1")
      .get() as any;
    return row ? JSON.parse(row.data) : undefined;
  }
  recent(): LocalAttempt[] {
    return (
      this.db.prepare('SELECT data FROM attempts ORDER BY rowid DESC LIMIT 30').all() as any[]
    ).map((r) => JSON.parse(r.data));
  }
}
