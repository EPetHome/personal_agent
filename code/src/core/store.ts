import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRegularFile } from './config.ts';
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
    catch { throw new Error(`${path} 第 ${index + 1} 行损坏；保留现场，请先备份再人工恢复，未覆盖事实记录`); }
  }
  if (text && !text.endsWith('\n')) throw new Error(`${path} 末行未完整提交；请先备份再恢复，未追加或覆盖`);
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
  const kinds = ['session_observed', 'push_observed', 'push_validated', 'push_cursor', 'source_health', 'scan_completed', 'notice_planned', 'notices_delivered'];
  for (const row of rows) {
    if (!row || row.version !== 1 || typeof row.id !== 'string' || typeof row.at !== 'string' || !kinds.includes(row.kind)) {
      throw new Error('events.jsonl 事件版本/结构不受支持；未改写，请先备份再恢复');
    }
    if (row.kind === 'session_observed' && (!row.record?.key || !row.record.originals || !row.record.intent)) throw new Error('会话事件结构损坏');
    if (row.kind === 'source_health' && !Array.isArray(row.report?.errors)) throw new Error('来源健康事件结构损坏');
    if (row.kind === 'push_observed' && !row.push?.sessionId) throw new Error('推送事件结构损坏');
    if (row.kind === 'push_validated' && (typeof row.pushId !== 'string' || !row.pushId || typeof row.recordKey !== 'string' || !row.recordKey)) throw new Error('推送对账事件结构损坏');
    if (row.kind === 'notice_planned' && !row.notice?.id) throw new Error('发件事件结构损坏');
    if (row.kind === 'notices_delivered' && (!Array.isArray(row.ids) || row.ids.some(id => typeof id !== 'string'))) throw new Error('发件确认事件结构损坏');
  }
  return rows;
}
export async function readOutbox(dataDir: string): Promise<Notice[]> {
  const rows = await readJsonl<Notice>(join(dataDir, 'outbox.jsonl'));
  if (rows.some(row => !row || row.version !== 1 || typeof row.id !== 'string' || typeof row.text !== 'string')) {
    throw new Error('outbox.jsonl 结构损坏；未改写，请先备份再恢复');
  }
  return rows;
}
export async function writeState(dataDir: string, state: unknown): Promise<void> {
  const path = join(dataDir, 'state.json');
  if (await exists(path)) await assertRegularFile(path);
  const temporary = join(dataDir, `.state-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
export async function withStoreLock<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = join(dataDir, '.detect.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`数据目录正被占用；如进程异常退出，请确认没有检测进程后删除 ${lock}`);
    throw error;
  }
  try {
    for (const name of ['events.jsonl', 'outbox.jsonl', 'feedback.jsonl']) {
      const path = join(dataDir, name);
      if (await exists(path)) await assertRegularFile(path);
      else { const handle = await open(path, 'ax', 0o600); await handle.close(); }
    }
    return await operation();
  } finally { await rmdir(lock); }
}
