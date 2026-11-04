import { join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendJsonl, measureHeldStoreLock } from './store.ts';
import { withNamedLock } from './locks.ts';
import { hash } from './utils.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { OperationFailure } from './failures.ts';
import type { LedgerChange, LedgerState, LedgerTable, LedgerTransaction } from './managed-types.ts';

const TABLES: LedgerTable[] = ['threads', 'tickets', 'assignments', 'assessments', 'attentions', 'cards', 'writes', 'deliveries', 'inputs', 'receipts', 'cursors', 'health', 'connections', 'modes', 'handoffs', 'proposals', 'conversations', 'choices', 'memoryCandidates', 'memories', 'materials', 'materialAssessments', 'calendars'];
export const ledgerPath = (dataDir: string) => join(dataDir, 'ledger.jsonl');
export function emptyLedger(): LedgerState {
  return { tables: Object.fromEntries(TABLES.map(table => [table, Object.create(null)])) as LedgerState['tables'], events: Object.create(null), observations: [], transactionIds: new Set(), seq: 0, checksum: '' };
}
function apply(state: LedgerState, change: LedgerChange, at: string) {
  if (change.kind === 'put') {
    if (!TABLES.includes(change.table) || !change.value || typeof change.value.id !== 'string' || !change.value.id
      || ['__proto__', 'prototype', 'constructor'].includes(change.value.id)) throw new OperationFailure('data_corrupt', '账本实体结构损坏；保留现场');
    if (Object.isFrozen(state.tables[change.table])) (state.tables[change.table] as Record<string, unknown>) = Object.assign(Object.create(null), state.tables[change.table]);
    (state.tables[change.table] as Record<string, unknown>)[change.value.id] = freezeValue(structuredClone(change.value));
  } else if (change.kind === 'loop_event') {
    if (!change.event || typeof change.event.id !== 'string' || !change.event.id || Object.hasOwn(state.events, change.event.id)) throw new OperationFailure('data_corrupt', '账本事件结构损坏或身份重复');
    if (Object.isFrozen(state.events)) state.events = Object.assign(Object.create(null), state.events);
    state.events[change.event.id] = freezeValue(structuredClone(change.event));
  } else if (change.kind === 'observation') {
    if (Object.isFrozen(state.observations)) state.observations = [...state.observations];
    state.observations.push(freezeValue(structuredClone({ ...change.observation, at })));
  }
  else throw new OperationFailure('data_corrupt', '不支持的账本变更；未改写');
}
function freezeValue<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}
/** 读者持有不可变快照；事务仅复制被改变的表，不能污染缓存或先前的读者。 */
function snapshot(state: LedgerState): LedgerState {
  for (const table of Object.values(state.tables)) Object.freeze(table);
  Object.freeze(state.tables); Object.freeze(state.events); Object.freeze(state.observations);
  if (!Object.isFrozen(state.transactionIds)) {
    const reject = () => { throw new TypeError('账本快照只读，请使用 updateLedger'); };
    Object.defineProperties(state.transactionIds, { add: { value: reject }, delete: { value: reject }, clear: { value: reject } });
    Object.freeze(state.transactionIds);
  }
  return Object.freeze(state);
}
function draft(state: LedgerState): LedgerState { return { ...state, tables: { ...state.tables } }; }
interface LedgerCache { state: LedgerState; stat: BigIntStats; offset: number; tail: Buffer; tailStart: number; digest: Hash }
// 只缓存少量活跃数据目录；缓存不是落盘格式，也不是另一份业务状态。
const caches = new Map<string, LedgerCache>();
const readTiming = new AsyncLocalStorage<{ fullReads: number }>();
export function measureLedgerReads<T>(operation: () => Promise<T>, counts: { fullReads: number }): Promise<T> { return readTiming.run(counts, operation); }
function replay(state: LedgerState, content: Buffer, path: string) {
  const text = content.toString('utf8');
  if (text && !text.endsWith('\n')) throw new OperationFailure('data_corrupt', `${path} 末行未完整提交；请先备份再恢复，未追加或覆盖`);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: LedgerTransaction;
    try { row = JSON.parse(line); }
    catch { throw new OperationFailure('data_corrupt', `${path} 账本行损坏；保留现场，未覆盖`); }
    if (!row || row.schema !== 1 || row.seq !== state.seq + 1 || row.previous !== state.checksum || !Array.isArray(row.changes)
      || typeof row.id !== 'string' || !row.id || state.transactionIds.has(row.id) || !Number.isFinite(Date.parse(row.at))) throw new OperationFailure('data_corrupt', '账本事务结构/顺序损坏；先备份，未覆盖');
    const { checksum, ...body } = row;
    if (checksum !== hash(JSON.stringify(body))) throw new OperationFailure('data_corrupt', '账本校验失败；保留现场，不截断恢复');
    for (const change of row.changes) apply(state, change, row.at);
    state.seq = row.seq; state.checksum = checksum; state.transactionIds.add(row.id);
  }
}
async function bytes(file: FileHandle, start: number, end: number): Promise<Buffer> {
  const content = Buffer.alloc(end - start);
  let read = 0;
  while (read < content.length) {
    const next = await file.read(content, read, content.length - read, start + read);
    if (!next.bytesRead) throw new OperationFailure('data_corrupt', '账本读取期间被截短；保留现场');
    read += next.bytesRead;
  }
  return content;
}
function sameFile(a: BigIntStats, b: BigIntStats) { return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs; }
function unchanged(a: BigIntStats, b: BigIntStats) { return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
/** 唯一状态来源。不读取/迁移旧 events、state、outbox 或个人目录。 */
export async function readLedger(dataDir: string): Promise<LedgerState> {
  return withNamedLock(dataDir, '.ledger.lock', () => measureHeldStoreLock(() => readLedgerUnlocked(dataDir)), 30000);
}
async function readLedgerUnlocked(dataDir: string): Promise<LedgerState> {
  const path = resolve(ledgerPath(dataDir)), cached = caches.get(path);
  let visible: BigIntStats;
  try { visible = await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (cached?.offset) throw new OperationFailure('data_corrupt', '已读取的账本消失；保留现场，不使用旧缓存');
    return snapshot(emptyLedger());
  }
  if (!visible.isFile() || visible.isSymbolicLink() || visible.nlink !== 1n) throw new OperationFailure('unsafe_file', '拒绝访问非普通账本或链接');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !sameFile(visible, stat)) throw new OperationFailure('unsafe_file', '账本读取期间文件身份变化；保留现场');
    let incremental = !!cached && sameFile(cached.stat, stat) && stat.size >= BigInt(cached.offset);
    const truncated = !!cached && sameFile(cached.stat, stat) && stat.size < BigInt(cached.offset);
    if (incremental && cached) {
      // 同尺寸的原地改写必须重放全链；追加也须核对原边界行的原字节/校验码。
      if (stat.size === cached.stat.size && !unchanged(stat, cached.stat)) incremental = false;
      else if (!(await bytes(file, cached.tailStart, cached.offset)).equals(cached.tail)) incremental = false;
      else if (stat.size > cached.stat.size) {
        // 其他进程的追加不能只凭末行信任整个前缀（可能先改中间再追加）。
        // 仅对跨进程变化核对原字节摘要，不重解析历史事务；本进程fsync成功会直接推进缓存。
        const prefix = createHash('sha256').update(await bytes(file, 0, cached.offset)).digest('hex');
        if (prefix !== cached.digest.copy().digest('hex')) incremental = false;
      }
    }
    let state: LedgerState, content: Buffer, start: number;
    if (incremental && cached) {
      start = cached.offset; content = await bytes(file, start, Number(stat.size));
      if (!content.length) state = cached.state;
      else {
        state = draft(cached.state); state.transactionIds = new Set(state.transactionIds);
        try { replay(state, content, path); }
        catch {
          // 接链失败或坏新增行不能静默沿用缓存；再从头核实，采用原有校验错误。
          start = 0; content = await bytes(file, 0, Number(stat.size)); state = fullReplay(content, path);
        }
      }
    } else { start = 0; content = await bytes(file, 0, Number(stat.size)); state = fullReplay(content, path); }
    if (truncated) throw new OperationFailure('data_corrupt', '账本被截短；保留现场，不使用旧缓存或自动恢复');
    const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    if (!unchanged(stat, after) || !unchanged(after, current) || !current.isFile() || current.nlink !== 1n) throw new OperationFailure('data_corrupt', '账本读取期间变化；未发布缓存，保留现场');
    if (cached && state === cached.state && unchanged(stat, cached.stat)) return state;
    let tail = cached?.tail ?? Buffer.alloc(0), tailStart = cached?.tailStart ?? 0;
    if (content.length) {
      const lastStart = content.length > 1 ? content.lastIndexOf(10, content.length - 2) + 1 : 0;
      tail = Buffer.from(content.subarray(lastStart)); tailStart = start + lastStart;
    } else if (!start) { tail = Buffer.alloc(0); tailStart = 0; }
    const digest = start && cached ? cached.digest.copy().update(content) : createHash('sha256').update(content);
    const value = { state: snapshot(state), stat, offset: Number(stat.size), tail, tailStart, digest };
    caches.delete(path); caches.set(path, value);
    if (caches.size > 8) caches.delete(caches.keys().next().value!);
    return value.state;
  } finally { await file.close(); }
}
function fullReplay(content: Buffer, path: string): LedgerState {
  const timing = readTiming.getStore(); if (timing) timing.fullReads++;
  const state = emptyLedger(); replay(state, content, path); return state;
}
/** 短事务：不得在回调内访问模型、渠道或 worker。整批变更一行 fsync 后才可产生副作用。 */
export async function updateLedger<T>(dataDir: string, at: string, operation: (state: LedgerState, add: (change: LedgerChange) => void) => T, id = randomUUID()): Promise<T> {
  return withNamedLock(dataDir, '.ledger.lock', () => measureHeldStoreLock(async () => {
    const state = draft(await readLedgerUnlocked(dataDir)), changes: LedgerChange[] = [];
    const result = operation(state, change => { apply(state, change, at); changes.push(structuredClone(change)); });
    if (changes.length && !state.transactionIds.has(id)) {
      const body = { schema: 1 as const, id, seq: state.seq + 1, at, previous: state.checksum, changes };
      const row = { ...body, checksum: hash(JSON.stringify(body)) }, path = resolve(ledgerPath(dataDir)), cached = caches.get(path);
      await appendJsonl(path, [row]);
      if (cached && cached.state.seq === state.seq && cached.state.checksum === state.checksum) {
        const content = Buffer.from(JSON.stringify(row) + '\n'), stat = await lstat(path, { bigint: true });
        if (stat.isFile() && stat.nlink === 1n && sameFile(cached.stat, stat) && stat.size === BigInt(cached.offset + content.length)) {
          // 缓存接入实际JSON字节，而不是回调里的临时对象（undefined等在落盘时会被省略）。
          const committed = draft(cached.state); committed.transactionIds = new Set(committed.transactionIds);
          replay(committed, content, path);
          caches.set(path, { state: snapshot(committed), stat, offset: Number(stat.size), tail: content, tailStart: cached.offset, digest: cached.digest.copy().update(content) });
        }
      }
    }
    return result;
  }), 30000);
}
/** worker交回结果不等于事情结束；只有后段经用户确认的动作才能真正收尾。 */
export function refreshTicketProgress(state: LedgerState, add: (change: LedgerChange) => void, ids = Object.keys(state.tables.tickets)) {
  for (const id of ids) {
    const ticket = state.tables.tickets[id]; if (!ticket) continue;
    // 飞书起草/查询/skill的进度由单次派工回执推进，不套用loop完成提交核实。
    if (state.tables.threads[ticket.threadId]?.source !== 'loop') continue;
    if (ticket.closure) {
      if (ticket.status !== ticket.closure.kind) add({ kind: 'put', table: 'tickets', value: { ...ticket, status: ticket.closure.kind } });
      continue;
    }
    // 已交回的补查只是历史派工；失败/完成都不能压住后来的干活派工。
    const active = Object.values(state.tables.assignments).filter(row => row.ticketId === id && !row.endedAt);
    const lifecycle = active.filter(row => row.state !== 'queue');
    const assignments = lifecycle.length ? lifecycle : active;
    const queuePaused = active.some(row => row.state === 'queue' && ['returned', 'returning', 'blocked', 'stopped'].includes(String(state.events[row.lastEventId]?.detail.status)));
    const assessment = (eventId: string) => state.tables.assessments[`assessment:${eventId}`];
    const stops = assignments.filter(row => ['needs_decision', 'paused', 'repair_limit', 'failed'].includes(row.state) && !assessment(row.lastEventId)?.suppressed);
    const readOnlyReturned = assignments.length && assignments.every(row => row.state === 'completed' && state.events[row.lastEventId]?.native?.batch.recipe === 'review-only');
    const status = readOnlyReturned ? 'result_returned' : stops.length ? stops.some(row => !!assessment(row.lastEventId)) ? 'waiting_user' : 'pending_verification'
      : queuePaused ? 'waiting' : assignments.some(row => ['started', 'resumed'].includes(row.state) || assessment(row.lastEventId)?.suppressed) ? 'running'
        : assignments.some(row => row.state === 'queue') ? 'waiting'
          : assignments.length && assignments.every(row => row.state === 'completed')
            ? assignments.every(row => {
              if (row.worker === 'pi') return Object.values(state.tables.writes).some(write => write.assignmentId === row.id && !!write.dispatch && write.state === 'consumed');
              const result = assessment(row.lastEventId)?.commit?.result;
              return result === 'branch' || result === 'candidate';
            }) ? 'done_pending_actions' : 'needs_verification'
            : 'pending_verification';
    if (ticket.status !== status) add({ kind: 'put', table: 'tickets', value: { ...ticket, status } });
  }
}
export function ledgerSummary(state: LedgerState) {
  const counts = (kind: string) => state.observations.filter(row => row.kind === kind).length;
  const choices = state.observations.filter(row => row.kind === 'suggestion');
  const models = [...Object.values(state.tables.assessments), ...Object.values(state.tables.materialAssessments)].filter(row => row.model?.used);
  return { schema: 1, transactions: state.seq, ...state.tables,
    observations: { called: counts('called'), notCalled: counts('not_called'), loopMisreports: counts('loop_misreport'),
      suggestionChoices: choices.length, suggestionRatio: choices.length ? choices.filter(row => row.value === 1).length / choices.length : null,
      modelCalls: models.length, unknownUsageCalls: models.filter(row => row.model?.usage?.totalTokens === undefined).length,
      knownTokens: models.reduce((sum, row) => sum + (row.model?.usage?.totalTokens ?? 0), 0),
      knownCostUSD: models.reduce((sum, row) => sum + (row.model?.usage?.costUSD ?? 0), 0),
      unknownCostCalls: models.filter(row => row.model?.usage?.costUSD === undefined).length,
      queries: counts('query'), queryMs: state.observations.filter(row => row.kind === 'query').reduce((sum, row) => sum + (row.value ?? 0), 0) } };
}
