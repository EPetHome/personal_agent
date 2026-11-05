import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdirSync, readSync, openSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Input, QueueRow, TaskCard } from './types.js';
import { parseJson, tokenBudget } from './util.js';

type Row = Record<string, unknown>;
type AuditRow = { seq: number; file: string; offset: number; length: number };
type OutboxRow = { id: string; input_id: string; text: string; state: string; message_id: string | null };
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly config: Config, readonly readOnly = false) {
    if (!readOnly) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(config.dataDir, 'state.sqlite'), { readOnly });
    this.db.exec('PRAGMA busy_timeout=5000;');
    if (readOnly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS inputs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,priority INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',body TEXT NOT NULL,prepared INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,started INTEGER,finished INTEGER,pruned INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS queue_ready ON inputs(state,priority,seq);
      CREATE INDEX IF NOT EXISTS queue_age ON inputs(state,created);
      CREATE INDEX IF NOT EXISTS checkpoint_prune ON inputs(pruned,state,finished DESC);
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,input_id TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,message_id TEXT);
      CREATE INDEX IF NOT EXISTS outbox_input ON outbox(input_id);
      CREATE TABLE IF NOT EXISTS window(id TEXT PRIMARY KEY,seq INTEGER NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,tokens INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS window_order ON window(seq);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,body TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_status ON tasks(status,updated);
      CREATE TABLE IF NOT EXISTS subscriptions(kind TEXT NOT NULL,value TEXT NOT NULL,task TEXT NOT NULL,PRIMARY KEY(kind,value,task));
      CREATE TABLE IF NOT EXISTS task_events(task TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(task,event));
      CREATE TABLE IF NOT EXISTS evidence(path TEXT PRIMARY KEY,project TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY,signature TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,at TEXT NOT NULL,file TEXT NOT NULL,offset INTEGER NOT NULL,length INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_kind ON audit(kind,seq);
    `);
  }
  get<T>(key: string, fallback: T): T { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? parseJson<T>(String(row.value)) : fallback; }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  log(kind: string, data: unknown) {
    const at = new Date().toISOString(), file = join(this.config.dataDir, 'events', `${at.slice(0, 10)}.jsonl`);
    mkdirSync(join(this.config.dataDir, 'events'), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify({ at, kind, data }) + '\n');
    let offset = 0; try { offset = statSync(file).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    appendFileSync(file, bytes, { mode: 0o600 });
    this.db.prepare('INSERT INTO audit(kind,at,file,offset,length) VALUES(?,?,?,?,?)').run(kind, at, file, offset, bytes.length);
  }
  events(after = 0, limit = 20) {
    const rows = this.db.prepare('SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT ?').all(after, Math.min(50, Math.max(1, limit))) as AuditRow[];
    return rows.map(row => {
      const fd = openSync(row.file, 'r');
      try { const buf = Buffer.alloc(Math.min(row.length, 256 * 1024)); readSync(fd, buf, 0, buf.length, row.offset); return { seq: row.seq, event: buf.toString('utf8'), truncated: row.length > buf.length }; }
      finally { closeSync(fd); }
    });
  }
  enqueue(input: Input): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO inputs(id,priority,body,created) VALUES(?,?,?,?)').run(input.id, input.source === 'feishu' ? 0 : 1, JSON.stringify(input), Date.now());
    if (result.changes) this.log('input', input);
    return !!result.changes;
  }
  decode(row: Row | undefined): QueueRow | undefined { return row && { id: String(row.id), seq: Number(row.seq), state: String(row.state), input: parseJson<Input>(String(row.body)), prepared: Boolean(row.prepared), started: row.started === null ? null : Number(row.started) }; }
  row(id: string) { return this.decode(this.db.prepare('SELECT * FROM inputs WHERE id=?').get(id)); }
  next() { return this.decode(this.db.prepare("SELECT * FROM inputs WHERE state IN ('pending','processing') ORDER BY CASE WHEN state='processing' THEN 0 ELSE 1 END,priority,seq LIMIT 1").get()); }
  pending() { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM inputs WHERE state IN ('pending','processing')").get()!.n); }
  oldest() { return this.db.prepare("SELECT id,created,started FROM inputs WHERE state IN ('pending','processing') ORDER BY created LIMIT 1").get() as { id: string; created: number; started: number | null } | undefined; }
  start(id: string) { this.db.prepare("UPDATE inputs SET state='processing',started=COALESCE(started,?) WHERE id=?").run(Date.now(), id); }
  prepared(id: string, input: Input) { this.db.prepare('UPDATE inputs SET body=?,prepared=1 WHERE id=?').run(JSON.stringify(input), id); }
  wait(id: string) { this.db.prepare("UPDATE inputs SET state='waiting',started=NULL WHERE id=?").run(id); }
  ready(id: string) { this.db.prepare("UPDATE inputs SET state='pending',started=? WHERE id=? AND state='waiting'").run(Date.now(), id); }
  finish(id: string, state = 'done') { this.db.prepare('UPDATE inputs SET state=?,finished=? WHERE id=?').run(state, Date.now(), id); }
  putTask(card: TaskCard) {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body,updated=excluded.updated').run(card.id, card.status, JSON.stringify(card), card.updated);
      this.db.prepare('DELETE FROM subscriptions WHERE task=?').run(card.id);
      for (const sub of card.subscriptions) this.db.prepare('INSERT OR IGNORE INTO subscriptions VALUES(?,?,?)').run(sub.kind, sub.value, card.id);
      if (ownsTransaction) this.db.exec('COMMIT');
    } catch (e) { if (ownsTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  task(id: string): TaskCard | undefined { const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id); return row ? parseJson<TaskCard>(String(row.body)) : undefined; }
  taskTable() { return (this.db.prepare("SELECT body FROM tasks WHERE status<>'closed' ORDER BY updated DESC").all() as Row[]).map(r => { const t = parseJson<TaskCard>(String(r.body)); return { id: t.id, title: t.title, status: t.status, waiting: t.waiting, updated: t.updated }; }); }
  searchClosed(query: string, limit = 20) { return (this.db.prepare("SELECT body FROM tasks WHERE status='closed' AND instr(body,?)>0 ORDER BY updated DESC LIMIT ?").all(query, Math.min(50, Math.max(1, limit))) as Row[]).map(r => parseJson<TaskCard>(String(r.body))); }
  match(input: Input) {
    const sources = [['message', input.quoteId], ['message', input.messageId], ['loop', input.batchFile], ['pi', input.workerId]].filter((x): x is [string, string] => !!x[1]);
    const ids = new Set<string>();
    for (const [kind, value] of sources) for (const r of this.db.prepare('SELECT task FROM subscriptions WHERE kind=? AND value=?').all(kind, value)) ids.add(String(r.task));
    return [...ids].flatMap(id => {
      const card = this.task(id); if (!card) return [];
      return [card];
    });
  }
  recordTaskEvent(card: TaskCard, input: Input, status: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('INSERT OR IGNORE INTO task_events VALUES(?,?)').run(card.id, input.id).changes) {
        card.status = status;
        card.dispatches.push({ event: input.id, at: input.at, status, reported: input.status, source: input.source });
        card.updated = new Date().toISOString(); this.putTask(card);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  addWindow(id: string, seq: number, role: 'user' | 'assistant', text: string) {
    this.db.prepare('INSERT OR IGNORE INTO window VALUES(?,?,?,?,?)').run(id, seq, role, text, tokenBudget(text));
    const total = Number(this.db.prepare('SELECT COALESCE(SUM(tokens),0) AS n FROM window').get()!.n);
    if (total <= this.config.windowTokens) return;
    let left = total;
    for (const row of this.db.prepare('SELECT id,tokens FROM window ORDER BY seq').all() as { id: string; tokens: number }[]) {
      this.db.prepare('DELETE FROM window WHERE id=?').run(row.id); left -= row.tokens;
      if (left <= Math.floor(this.config.windowTokens * 0.6)) break;
    }
  }
  window() { return this.db.prepare('SELECT role,text,tokens FROM window ORDER BY seq').all() as { role: 'user' | 'assistant'; text: string; tokens: number }[]; }
  replies(inputId: string) { return this.db.prepare("SELECT * FROM outbox WHERE input_id=? AND state='sent' ORDER BY rowid").all(inputId) as OutboxRow[]; }
  close() { this.db.close(); }
}
