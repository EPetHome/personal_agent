import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdirSync, readSync, openSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Input, LoopBinding, QueueRow, TaskCard } from './types.js';
import { parseJson, tokenBudget } from './util.js';

type Row = Record<string, unknown>;
type AuditRow = { seq: number; file: string; offset: number; length: number };
type OutboxRow = { id: string; input_id: string; text: string; state: string; message_id: string | null };
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly config: Pick<Config, 'dataDir' | 'feishu' | 'windowTokens'>, readonly readOnly = false) {
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
  loopVerification(input: Input, pending: boolean) { this.set(`kernel:verification:${input.id}`, pending); }
  /** Retry ONLY the read-only pre-Router verification stage. Its marker is
   * cleared before any model/tool turn, so done actions/notifications never replay. */
  retryLoopSource(input: Input) {
    const row = this.row(input.id), previous = row?.input;
    if (!row || !['done', 'failed'].includes(row.state) || input.source !== 'loop' || previous?.source !== 'loop'
      || !this.get<boolean>(`kernel:verification:${input.id}`, false)) return false;
    const identity = (i: Input) => { const raw = i.raw as { kernel?: number; runId?: string; revision?: number; ledger?: string } | undefined;
      return raw?.kernel === 1 ? JSON.stringify([i.workerId, i.batchFile, raw.runId, raw.revision, raw.ledger]) : undefined; };
    if (!identity(input) || identity(input) !== identity(previous)) return false;
    return !!this.db.prepare("UPDATE inputs SET state='pending',started=NULL,finished=NULL WHERE id=? AND state IN ('done','failed')").run(input.id).changes;
  }
  pendingLoopInput(binding: LoopBinding, revision: number) {
    // One queued verification per formal run revision, not per projected task.
    // Retrying is still limited to the durable pre-Router verification marker.
    return this.decode(this.db.prepare("SELECT i.* FROM inputs i LEFT JOIN kv v ON v.key='kernel:verification:'||i.id WHERE json_extract(i.body,'$.source')='loop' AND json_extract(i.body,'$.raw.kernel')=1 AND json_extract(i.body,'$.raw.runId')=? AND json_extract(i.body,'$.raw.ledger')=? AND json_extract(i.body,'$.batchFile')=? AND json_extract(i.body,'$.raw.revision')=? AND (i.state IN ('pending','processing') OR (i.state IN ('done','failed') AND v.value='true')) ORDER BY i.seq LIMIT 1").get(binding.runId, binding.ledger, binding.cardFile, revision));
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
  taskTarget(id: string) {
    const seen = new Set<string>();
    while (true) {
      if (seen.has(id) || seen.size >= 64) throw new Error('事项关联存在循环，未沿猜测归属继续');
      seen.add(id); const next = this.get<string | null>(`work:alias:${id}`, null);
      if (!next) return id; id = next;
    }
  }
  workTask(id: string): TaskCard | undefined {
    const card = this.task(id); if (!card?.work?.current) return card;
    const fields = Object.fromEntries(Object.entries(card.work.current).map(([key, value]) => [key, value === null ? undefined : value]));
    return { ...card, ...fields, ...(['cancelled', 'closed', 'reconciled'].includes(card.status) ? { status: card.status, waiting: card.waiting, notice: card.notice } : {}) };
  }
  private matched(ids: string[], original = false) { return [...new Set(ids.map(id => original ? id : this.taskTarget(id)))].flatMap(id => { const card = original ? this.task(id) : this.workTask(id); return card ? [card] : []; }); }
  /** Stable insertion-order paging. A cursor freezes the upper rowid, so concurrent
   * updates/new discoveries cannot repeat or silently skip rows on later pages. */
  taskPage(projects: string[], options: { project?: string | string[]; businessProject?: string; cursor?: string; limit?: number; includeClosed?: boolean; protocol?: string; decisionOnly?: boolean; observationSources?: string[]; observationDeny?: string[] } = {}) {
    const scope = JSON.stringify([projects, options.project ?? '', !!options.includeClosed, options.protocol ?? '', !!options.decisionOnly, options.observationSources ?? [], options.observationDeny ?? [], options.businessProject ?? '']);
    let after = 0, upper = Number(this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM tasks').get()!.n);
    if (options.cursor) {
      const cursor = parseJson<{ scope: string; after: number; upper: number }>(Buffer.from(options.cursor, 'base64url').toString());
      if (cursor.scope !== scope || !Number.isSafeInteger(cursor.after) || !Number.isSafeInteger(cursor.upper) || cursor.after < 0 || cursor.upper < cursor.after) throw new Error('分页位置无效或权限/范围已变，请从第一页重新查询');
      ({ after, upper } = cursor);
    }
    const project = "json_extract(body,'$.worker.project')", permitted = projects.length ? `${project} IN (${projects.map(() => '?').join(',')})` : '0';
    const selected = options.project ? Array.isArray(options.project) ? options.project : [options.project] : [];
    const projected = "json_patch(body,COALESCE(json_extract(body,'$.work.current'),'{}'))", state = "COALESCE(json_extract(body,'$.work.current.status'),status)";
    const clauses = ['rowid<=?', `(${project} IS NULL OR ${permitted})`, ...(options.includeClosed ? [] : ["status NOT IN ('closed','cancelled','reconciled')", `${state} NOT IN ('done','已合入','已放弃')`, "json_extract(body,'$.work.linkedTo') IS NULL"]), ...(selected.length ? [`${project} IN (${selected.map(() => '?').join(',')})`] : []), ...(options.protocol ? ["json_extract(body,'$.worker.loop.protocol')=?"] : []), ...(options.decisionOnly ? ["(COALESCE(json_extract(body,'$.waiting'),'')<>'' OR json_extract(body,'$.deferred')=1 OR status IN ('waiting-approval','等你决定'))"] : [])];
    const observed = options.observationSources ?? [];
    clauses.push(`(json_extract(body,'$.observation.sourceId') IS NULL OR json_extract(body,'$.observation.sourceId') IN (${observed.length ? observed.map(() => '?').join(',') : 'NULL'}))`);
    clauses.push(`NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(body,'$.work.executions'),'[]')) e WHERE json_extract(e.value,'$.kind')='pi-observation' AND json_extract(e.value,'$.sourceId') NOT IN (${observed.length ? observed.map(() => '?').join(',') : "''"}))`);
    if (options.observationDeny?.length) clauses.push("NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(body,'$.work.executions'),'[]')) e, json_each(?) d WHERE json_extract(e.value,'$.kind')='pi-observation' AND (json_extract(e.value,'$.recordPath')=d.value OR substr(json_extract(e.value,'$.recordPath'),1,length(d.value)+1)=d.value||'/'))");
    if (options.businessProject) clauses.push("json_extract(body,'$.work.ownership.kind')='project' AND json_extract(body,'$.work.ownership.id')=?");
    const params = [upper, ...projects, ...selected, ...(options.protocol ? [options.protocol] : []), ...observed, ...observed, ...(options.observationDeny?.length ? [JSON.stringify(options.observationDeny)] : []), ...(options.businessProject ? [options.businessProject] : [])];
    const where = clauses.join(' AND '), limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 10)));
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...params)!.n);
    const rows = this.db.prepare(`SELECT rowid AS position,id,${state} AS status,updated,
      json_extract(body,'$.title') AS title, substr(json_extract(body,'$.goal'),1,180) AS goal,
      ${project} AS project, json_extract(body,'$.worker.kind') AS worker,
      json_extract(body,'$.worker.origin') AS origin, json_extract(${projected},'$.lastVerifiedAt') AS lastVerifiedAt,
      json_extract(${projected},'$.sourceCurrent.state') AS sourceState,
      json_extract(${projected},'$.sourceDefinition.state') AS definitionState,
      json_extract(${projected},'$.sourceHealth') AS health,
      CASE WHEN COALESCE(json_extract(body,'$.waiting'),'')<>'' OR json_extract(body,'$.deferred')=1 THEN 1 ELSE 0 END AS decision
      FROM tasks WHERE ${where} AND rowid>? ORDER BY rowid LIMIT ?`).all(...params, after, limit + 1);
    const more = rows.length > limit, page = rows.slice(0, limit), last = page.at(-1);
    return { total, count: page.length, hasMore: more, nextCursor: more && last ? Buffer.from(JSON.stringify({ scope, after: Number(last.position), upper })).toString('base64url') : null,
      rows: page.map(({ position: _position, health, ...row }) => ({ ...row, id: String(row.id), title: String(row.title), status: String(row.status), localTaskState: String(row.status), ...(health ? { health: parseJson(String(health)) } : {}), goal: row.definitionState === 'pending' ? '任务定义待读取' : row.goal })) };
  }
  transaction<T>(run: () => T): T {
    const own = !this.db.isTransaction;
    if (own) this.db.exec('BEGIN IMMEDIATE');
    try { const value = run(); if (own) this.db.exec('COMMIT'); return value; }
    catch (error) { if (own) this.db.exec('ROLLBACK'); throw error; }
  }
  taskTable() { return (this.db.prepare("SELECT body FROM tasks WHERE status<>'closed' AND json_extract(body,'$.work.linkedTo') IS NULL ORDER BY updated DESC").all() as Row[]).map(r => { const t = this.workTask(parseJson<TaskCard>(String(r.body)).id)!; return { id: t.id, title: t.title, status: t.status, waiting: t.waiting, updated: t.updated }; }); }
  searchClosed(query: string, limit = 20) { return (this.db.prepare("SELECT body FROM tasks WHERE status='closed' AND instr(body,?)>0 ORDER BY updated DESC LIMIT ?").all(query, Math.min(50, Math.max(1, limit))) as Row[]).map(r => parseJson<TaskCard>(String(r.body))); }
  match(input: Input, original = false): TaskCard[] {
    if (input.source === 'pi' && (input.raw as { observation?: number } | undefined)?.observation === 1) {
      const raw = input.raw as { sourceId?: string; recordKey?: string };
      const card = input.workerId ? this.task(input.workerId) : undefined;
      return card && card.observation && card.observation.sourceId === raw.sourceId && card.observation.recordKey === raw.recordKey ? this.matched([card.id], original) : [];
    }
    if (input.source === 'loop' && (input.raw as { kernel?: number } | undefined)?.kernel === 1) {
      const card = input.workerId ? this.task(input.workerId) : undefined, binding = card?.worker?.loop;
      if (!card || !binding) return [];
      const linked = this.db.prepare("SELECT t.body FROM task_events e JOIN tasks t ON t.id=e.task WHERE e.event=? AND json_extract(t.body,'$.worker.loop.repository')=? AND json_extract(t.body,'$.worker.loop.runId')=? AND json_extract(t.body,'$.worker.loop.cardFile')=? AND json_extract(t.body,'$.worker.loop.ledger')=? ORDER BY t.rowid").all(input.id, binding.repository, binding.runId, binding.cardFile, binding.ledger);
      return this.matched(linked.length ? linked.map(row => parseJson<TaskCard>(String(row.body)).id) : [card.id], original);
    }
    const sources = [['message', input.quoteId], ['message', input.messageId], ['loop', input.batchFile], ['pi', input.workerId]].filter((x): x is [string, string] => !!x[1]);
    const ids = new Set<string>();
    for (const [kind, value] of sources) for (const r of this.db.prepare('SELECT task FROM subscriptions WHERE kind=? AND value=?').all(kind, value)) ids.add(String(r.task));
    return this.matched([...ids], original);
  }
  /** JSON-only additive enrichment; no schema rewrite or second task ledger. */
  applyLoopSnapshot(card: TaskCard, revision: number, fingerprint: string, update: () => void) {
    const own = !this.db.isTransaction;
    if (own) this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.task(card.id);
      if (!current || ['closed', 'cancelled', 'reconciled'].includes(current.status) || revision < (current.sourceRevision ?? -1)) { if (own) this.db.exec('COMMIT'); return false; }
      if (revision === current.sourceRevision && fingerprint === current.sourceFingerprint) {
        // An identical read only refreshes freshness. A pure query can reveal a
        // changed process/external-merge fact even when ledger bytes are unchanged.
        current.lastVerifiedAt = new Date().toISOString();
        current.sourceHealth = { checkedAt: current.lastVerifiedAt, ok: true };
        this.putTask(current); if (own) this.db.exec('COMMIT'); return false;
      }
      const historyLength = card.dispatches.length;
      update();
      // A read-only query may overlap a user definition/approval/message update.
      // Enrich only source-owned fields; never overwrite that newer local work.
      const next: TaskCard = { ...current, status: card.status, sourceRevision: revision, sourceFingerprint: fingerprint,
        lastVerifiedAt: card.lastVerifiedAt, sourceHealth: card.sourceHealth, control: card.control, verified: card.verified,
        worker: current.worker ? { ...current.worker, ...(card.worker?.loop ? { loop: card.worker.loop } : {}) } : card.worker,
        sourceDefinition: current.sourceDefinition ? { ...current.sourceDefinition, state: 'pending' } : card.sourceDefinition,
        dispatches: [...current.dispatches, ...card.dispatches.slice(historyLength)], updated: current.updated > card.updated ? current.updated : card.updated };
      this.putTask(next); Object.assign(card, next); if (own) this.db.exec('COMMIT'); return true;
    } catch (error) { if (own) this.db.exec('ROLLBACK'); throw error; }
  }
  boundLoopPage(cursor: { after: number; upper?: number }, limit = 24) {
    const upper = cursor.upper ?? Number(this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM tasks').get()!.n);
    const rows = this.db.prepare("SELECT rowid,body FROM tasks WHERE rowid>? AND rowid<=? AND json_extract(body,'$.worker.loop.protocol')='kernel:1' AND status NOT IN ('closed','cancelled','reconciled','已合入','已放弃') AND COALESCE(json_extract(body,'$.verified.state'),'')<>'source-removed' ORDER BY rowid LIMIT ?").all(cursor.after, upper, limit + 1);
    const page = rows.slice(0, limit), hasMore = rows.length > limit;
    return { cards: page.map(r => parseJson<TaskCard>(String(r.body))), hasMore, cursor: hasMore ? { after: Number(page.at(-1)!.rowid), upper } : { after: 0 } };
  }
  boundLoops() {
    return this.db.prepare("SELECT body FROM tasks WHERE json_extract(body,'$.worker.loop.protocol')='kernel:1' AND status NOT IN ('closed','cancelled','reconciled')").all().map(r => parseJson<TaskCard>(String(r.body)));
  }
  recordTaskEvent(card: TaskCard, input: Input, status: string) {
    this.transaction(() => {
      if (this.db.prepare('INSERT OR IGNORE INTO task_events VALUES(?,?)').run(card.id, input.id).changes) {
        card.status = status;
        card.dispatches.push({ event: input.id, at: input.at, status, reported: input.status, source: input.source });
        card.updated = new Date().toISOString(); this.putTask(card);
      }
    });
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
  window() { return this.db.prepare('SELECT id,role,text,tokens FROM window ORDER BY seq').all() as { id: string; role: 'user' | 'assistant'; text: string; tokens: number }[]; }
  replies(inputId: string) { return this.db.prepare("SELECT * FROM outbox WHERE input_id=? AND state='sent' ORDER BY rowid").all(inputId) as OutboxRow[]; }
  close() { this.db.close(); }
}
