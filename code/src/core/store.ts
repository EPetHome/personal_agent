import { constants } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRegularFile } from './config.ts';
import { acquireLock } from './locks.ts';
import { OperationFailure } from './failures.ts';
import { unpackProjection } from './events.ts';
import { validateSessionDelta } from './session-delta.ts';
import type { AgentEvent, Notice } from './types.ts';

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function readJsonl<T>(path: string): Promise<T[]> {
  if (!await exists(path)) return [];
  await assertRegularFile(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try { text = await handle.readFile('utf8'); } finally { await handle.close(); }
  const rows: T[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { throw new OperationFailure('data_corrupt', `${path} 第 ${index + 1} 行损坏；保留现场，请先备份再人工恢复，未覆盖事实记录`); }
  }
  if (text && !text.endsWith('\n')) throw new OperationFailure('data_corrupt', `${path} 末行未完整提交；请先备份再恢复，未追加或覆盖`);
  return rows;
}
export async function appendJsonl(path: string, rows: unknown[]): Promise<void> {
  if (!rows.length) return;
  if (await exists(path)) await assertRegularFile(path);
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(rows.map(row => JSON.stringify(row) + '\n').join(''));
    await handle.sync();
  } finally { await handle.close(); }
}
export async function readEvents(dataDir: string): Promise<AgentEvent[]> {
  const rows = await readJsonl<AgentEvent>(join(dataDir, 'events.jsonl'));
  const kinds = ['store_format', 'store_checkpoint', 'session_delta', 'push_mismatches', 'session_observed', 'session_seen', 'push_observed', 'push_validated', 'push_empty', 'feishu_connection', 'push_deferred', 'push_cursor', 'source_health', 'scan_completed', 'notice_planned', 'notice_suppressed', 'notices_delivered', 'model_call_started', 'model_checked', 'notice_snapshot_written', 'notice_reply_observed', 'channel_delivery'];
  for (const row of rows) {
    if (!row || row.version !== 1 || typeof row.id !== 'string' || typeof row.at !== 'string' || !kinds.includes(row.kind)) {
      throw new Error('events.jsonl 事件版本/结构不受支持；未改写，请先备份再恢复');
    }
    if (row.kind === 'store_format' && row.format !== 2) throw new Error('不支持的数据格式');
    if (row.kind === 'store_checkpoint') {
      if (row !== rows[0] || row.format !== 2 || !Number.isSafeInteger(row.sequence) || row.sequence < 1
        || !Array.isArray(row.archives) || row.archives.length !== row.sequence || row.archives.at(-1) !== row.archive
        || row.archives.some((name, index) => typeof name !== 'string' || !/^events-\d{12}-[a-f0-9]{64}\.jsonl\.gz$/.test(name)
          || Number(name.slice(7, 19)) !== index + 1)) throw new Error('封存状态头损坏');
      unpackProjection(row.state);
    }
    if (row.kind === 'session_delta') validateSessionDelta(row.delta);
    if (row.kind === 'push_mismatches' && (!Array.isArray(row.mismatches) || row.mismatches.some(m => !m
      || typeof m.pushId !== 'string' || !m.pushId || typeof m.reason !== 'string'
      || (m.recordKey !== undefined && typeof m.recordKey !== 'string')))) throw new Error('会话对账故障结构损坏');
    if (row.kind === 'session_observed' && (!row.record?.key || !row.record.originals || !row.record.intent)) throw new Error('会话事件结构损坏');
    if (row.kind === 'session_seen' && (!['cc', 'codex', 'pi', 'loop'].includes(row.tool) || typeof row.sessionId !== 'string' || !row.sessionId)) throw new Error('会话身份事件结构损坏');
    if (row.kind === 'push_empty' && (typeof row.pushId !== 'string' || !row.pushId || typeof row.reason !== 'string')) throw new Error('空会话事件结构损坏');
    if (row.kind === 'feishu_connection' && (!row.connection || !['connecting', 'connected', 'reconnecting', 'failed', 'stopped', 'fake'].includes(row.connection.state))) throw new Error('飞书连接事件结构损坏');
    if (row.kind === 'source_health' && !Array.isArray(row.report?.errors)) throw new Error('来源健康事件结构损坏');
    if (row.kind === 'push_observed' && !row.push?.sessionId) throw new Error('推送事件结构损坏');
    if (row.kind === 'push_validated' && (typeof row.pushId !== 'string' || !row.pushId || typeof row.recordKey !== 'string' || !row.recordKey)) throw new Error('推送对账事件结构损坏');
    if (row.kind === 'push_deferred' && (typeof row.pushId !== 'string' || !Number.isInteger(row.rounds) || row.rounds < 1 || row.rounds > 2)) throw new Error('推送宽限事件结构损坏');
    if (row.kind === 'notice_planned' && !row.notice?.id) throw new Error('发件事件结构损坏');
    if (row.kind === 'notice_reply_observed' && (typeof row.noticeId !== 'string' || !row.noticeId
      || !row.reply || !Number.isInteger(row.reply.index) || row.reply.index < -1
      || !Number.isFinite(Date.parse(row.reply.at)) || typeof row.reply.sessionId !== 'string')) throw new Error('卡片回话引用结构损坏');
    if (row.kind === 'notice_suppressed' && (typeof row.dedupeKey !== 'string' || typeof row.evidenceAt !== 'string')) throw new Error('历史提醒抑制事件结构损坏');
    if (row.kind === 'model_call_started' && (typeof row.key !== 'string' || !['drift', 'waiting', 'snapshot', 'attribution', 'same_problem'].includes(row.task))) throw new Error('模型用量事件结构损坏');
    if (row.kind === 'notice_snapshot_written' && (typeof row.key !== 'string' || !row.key || !row.snapshot
      || (row.snapshot.goal !== null && typeof row.snapshot.goal !== 'string')
      || (row.snapshot.currentTask !== null && typeof row.snapshot.currentTask !== 'string')
      || typeof row.snapshot.lastOutput !== 'string' || !['在等你', '跑偏', '停滞', 'loop 完成', 'loop 暂停', '看不见了'].includes(row.snapshot.factualStatus)
      || typeof row.snapshot.situation !== 'string' || typeof row.snapshot.action !== 'string'
      || !['回答问题', '做个决定', '去看一眼', '不用管'].includes(row.snapshot.actionType)
      || !['模型', '规则'].includes(row.snapshot.source))) throw new Error('事情快照事件结构损坏');
    if (row.kind === 'model_checked' && (!row.check || typeof row.check.key !== 'string' || typeof row.check.fingerprint !== 'string' || !Array.isArray(row.check.stepIds))) throw new Error('模型判断事件结构损坏');
    if (row.kind === 'channel_delivery' && (typeof row.channel !== 'string' || typeof row.noticeId !== 'string' || typeof row.ok !== 'boolean')) throw new Error('渠道交付事件结构损坏');
    if (row.kind === 'notices_delivered' && (!Array.isArray(row.ids) || row.ids.some(id => typeof id !== 'string'))) throw new Error('发件确认事件结构损坏');
  }
  return rows;
}
async function readOutboxUnlocked(dataDir: string): Promise<Notice[]> {
  const rows = await readJsonl<Notice>(join(dataDir, 'outbox.jsonl'));
  if (rows.some(row => !row || row.version !== 1 || typeof row.id !== 'string' || typeof row.text !== 'string')) {
    throw new OperationFailure('data_corrupt', 'outbox.jsonl 结构损坏；未改写，请先备份再恢复');
  }
  return rows;
}
/** 发件的短锁只覆盖读写 JSONL，不包含通知/API，供反馈安全核对提醒。 */
async function withOutboxLock<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireLock(dataDir, '.outbox.lock', 30000);
  try { return await operation(); } finally { await release(); }
}
export async function readOutbox(dataDir: string): Promise<Notice[]> {
  return withOutboxLock(dataDir, () => readOutboxUnlocked(dataDir));
}
export async function appendOutbox(dataDir: string, notice: Notice): Promise<void> {
  return withOutboxLock(dataDir, async () => {
    if (!(await readOutboxUnlocked(dataDir)).some(row => row.id === notice.id))
      await appendJsonl(join(dataDir, 'outbox.jsonl'), [notice]);
  });
}
export async function writeState(dataDir: string, state: unknown): Promise<void> {
  const path = join(dataDir, 'state.json');
  if (await exists(path)) await assertRegularFile(path);
  const temporary = join(dataDir, `.state-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(state) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
/** 只防止重复模型批次，不阻挡规则检测或反馈；忙时跳过本轮模型阶段。 */
export async function withModelLock<T>(dataDir: string, operation: () => Promise<T>): Promise<T | null> {
  let release: () => Promise<void>;
  try { release = await acquireLock(dataDir, '.model.lock'); }
  catch (error) { if ((error as Error).message.includes('正被占用')) return null; throw error; }
  try { return await operation(); }
  finally { await release(); }
}
/** 按异步检测轮次汇总实际持锁时间（含初始化/释放，不含等锁和模型等待），不改变加锁范围。 */
const storeLockTiming = new AsyncLocalStorage<{ active: boolean; value: { heldMs: number } }>();
export async function measureStoreLocks<T>(operation: () => Promise<T>, value: { heldMs: number }): Promise<T> {
  const timing = { active: true, value };
  try { return await storeLockTiming.run(timing, operation); }
  finally { timing.active = false; }
}
export async function withStoreLock<T>(dataDir: string, operation: () => Promise<T>, waitMs = 0): Promise<T> {
  const release = await acquireLock(dataDir, '.detect.lock', waitMs);
  const began = performance.now(), timing = storeLockTiming.getStore();
  try {
    for (const name of ['events.jsonl', 'outbox.jsonl', 'feedback.jsonl']) {
      const path = join(dataDir, name);
      if (await exists(path)) await assertRegularFile(path);
      else {
        try { const handle = await open(path, 'ax', 0o600); await handle.close(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await assertRegularFile(path); }
      }
    }
    return await operation();
  } finally {
    try { await release(); }
    finally { if (timing?.active) timing.value.heldMs += performance.now() - began; }
  }
}
