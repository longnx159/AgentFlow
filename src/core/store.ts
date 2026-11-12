import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export class Store {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS receipts(workflow TEXT,trigger_id TEXT,event_id TEXT,result TEXT NOT NULL,PRIMARY KEY(workflow,trigger_id,event_id));`,
    );
  }
  get<T = any>(kind: string, id: string): T | undefined {
    const r = this.db
      .prepare('SELECT data FROM records WHERE kind=? AND id=?')
      .get(kind, id) as any;
    return r ? JSON.parse(r.data) : undefined;
  }
  all<T = any>(kind: string): T[] {
    return (
      this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind) as any[]
    ).map((r) => JSON.parse(r.data));
  }
  put(kind: string, value: any) {
    this.db
      .prepare(
        'INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(kind, value.id, JSON.stringify(value));
    return value;
  }
  receipt(workflow: string, trigger: string, event: string) {
    const r = this.db
      .prepare('SELECT result FROM receipts WHERE workflow=? AND trigger_id=? AND event_id=?')
      .get(workflow, trigger, event) as any;
    return r ? JSON.parse(r.result) : undefined;
  }
  saveReceipt(workflow: string, trigger: string, event: string, result: any) {
    this.db
      .prepare('INSERT INTO receipts VALUES(?,?,?,?)')
      .run(workflow, trigger, event, JSON.stringify(result));
  }
  tx<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }
  close() {
    this.db.close();
  }
}
