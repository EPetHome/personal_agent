import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { assertRegularFile } from './config.ts';
import { event, packProjection, project } from './events.ts';
import { acquireLock } from './locks.ts';
import { readEvents } from './store.ts';
import { hash, iso } from './utils.ts';
import type { AgentEvent } from './types.ts';

const compress = promisify(gzip), decompress = promisify(gunzip);
const RETENTION_MS = 7 * 86400000;
export type ArchiveStage = 'migration_synced' | 'migration_published' | 'archive_synced' | 'archive_published' | 'log_synced' | 'log_replaced';
export interface ArchiveOptions { onStage?: (stage: ArchiveStage) => Promise<void> }
async function readSafe(path: string): Promise<Buffer> {
  await assertRegularFile(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await file.readFile(); } finally { await file.close(); }
}
async function writeSynced(path: string, content: string | Buffer): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY);
  try { await file.sync(); } finally { await file.close(); }
}
async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('归档/备份目录必须是普通目录，不跟随链接');
}
const writerLocks = ['.model.lock', '.learning.lock', '.feedback.lock', '.outbox.lock', '.feishu-send.lock',
  '.feishu-reply-send.lock', '.feishu-sent.lock', '.feishu-receive.lock', '.feishu-inbound.lock'];
const knownLocks = ['.detect.lock', '.service.lock', '.launchd.lock', ...writerLocks];
function transientLock(name: string): boolean {
  return knownLocks.some(lock => name === lock || name === `${lock}.recovery`
    || (name.startsWith(`${lock}.`) && /^(?:owned|released)-[a-f0-9-]+$|^recovery\.owned-[a-f0-9-]+$/.test(name.slice(lock.length + 1))));
}
/** 复制所有持久文件及未知普通文件；运行中的锁不是数据，不能把活 PID/锁链接带进恢复副本。 */
async function copyData(from: string, to: string, root = true): Promise<void> {
  await directory(to);
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (root && transientLock(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) continue;
    const source = join(from, entry.name), target = join(to, entry.name);
    if (entry.isDirectory()) {
      const stat = await lstat(source);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('备份不跟随数据目录链接');
      await copyData(source, target, false);
    } else await writeSynced(target, await readSafe(source));
  }
  await syncDirectory(to);
}
async function backupData(dataDir: string, now: string): Promise<string> {
  const releases: (() => Promise<void>)[] = [];
  try {
    // 均不等待：如果另一个写入者正工作，保留原日志，下一轮再升级；不反向等锁造成死锁。
    for (const name of writerLocks) releases.push(await acquireLock(dataDir, name));
    const actual = await realpath(dataDir);
    const name = `backup-before-${now.slice(0, 10).replaceAll('-', '')}-event-store-${basename(actual)}-${randomUUID()}`;
    const target = join(dirname(actual), name), temporary = join(dirname(actual), `.${name}.tmp`);
    await copyData(dataDir, temporary);
    await rename(temporary, target);
    await syncDirectory(dirname(actual));
    return target;
  } finally { for (const release of releases.reverse()) await release(); }
}
async function cleanStateTemps(dataDir: string): Promise<void> {
  for (const name of await readdir(dataDir)) {
    if (!/^\.state-.+\.tmp$/.test(name)) continue;
    const path = join(dataDir, name), stat = await lstat(path);
    // 仅删除本程序状态临时文件的普通单链接对象；目录/链接/其他名字一律不碰。
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) await unlink(path);
  }
}
/** 调用方必须持有 .detect.lock。正常检测只读活动日志，不读取任何已封存文件。 */
export async function prepareEventLog(dataDir: string, nowInput: string, options: ArchiveOptions = {}): Promise<AgentEvent[]> {
  const now = iso(nowInput);
  let events = await readEvents(dataDir);
  if (!events.some(e => e.kind === 'store_format' || e.kind === 'store_checkpoint')) {
    // 新目录无需备份；旧格式在追加格式标记和任何封存之前，先完整备份持久数据。
    const backup = events.length ? await backupData(dataDir, now) : undefined;
    const marker = event({ kind: 'store_format', format: 2, ...(backup ? { backup } : {}) }, now);
    const path = join(dataDir, 'events.jsonl'), temporary = join(dataDir, `.events-${randomUUID()}.tmp`);
    try {
      // 格式标记也原子提交；首次升级在写标记时退出，不能把完好的旧日志变成半行。
      await writeSynced(temporary, Buffer.concat([await readSafe(path), Buffer.from(JSON.stringify(marker) + '\n')]));
      await options.onStage?.('migration_synced');
      await rename(temporary, path); await syncDirectory(dataDir);
      await options.onStage?.('migration_published');
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    events = [...events, marker];
  }
  await cleanStateTemps(dataDir);
  const previousCheckpoint = events[0]?.kind === 'store_checkpoint' ? events[0] : undefined;
  // 每天至多成功封存一次，避免稳定运行后每分钟生成一份小归档、重写整个检查点。
  // 失败没有提交新检查点，下一轮立即重试，不等一天。
  if (previousCheckpoint && Date.parse(now) - Date.parse(previousCheckpoint.at) < 86400000) return events;
  const cutoff = Date.parse(now) - RETENTION_MS;
  // 按追加顺序封存到最后一个过期事件。时钟回退/迟到事件前的较新记录随此前缀一起封存，避免重排事实。
  const last = events.findLastIndex(e => e.kind !== 'store_checkpoint' && Date.parse(e.at) < cutoff);
  if (last < 0) return events;
  const original = (await readSafe(join(dataDir, 'events.jsonl'))).toString('utf8');
  const lines = original.split(/(?<=\n)/), checkpoint = events[0]?.kind === 'store_checkpoint' ? events[0] : undefined;
  let row = -1, split = 0;
  const archived: string[] = [];
  for (; split < lines.length; split++) {
    const line = lines[split]!;
    if (line.trim()) row++;
    if (row > last) break;
    // 检查点是派生状态，不是原始事件；每个原始事件只归档一次，字节不变。
    if (!(checkpoint && row === 0 && line.trim())) archived.push(line);
  }
  const raw = archived.join(''), sequence = (checkpoint?.sequence ?? 0) + 1;
  const name = `events-${String(sequence).padStart(12, '0')}-${hash(raw)}.jsonl.gz`;
  const archives = join(dataDir, 'archives');
  await directory(archives);
  const archivePath = join(archives, name), archiveTemp = join(archives, `.archive-${randomUUID()}.tmp`);
  const logTemp = join(dataDir, `.events-${randomUUID()}.tmp`);
  const header = event({ kind: 'store_checkpoint', format: 2, sequence, archive: name, archives: [...(checkpoint?.archives ?? []), name],
    state: packProjection(project(events.slice(0, last + 1))) }, now);
  try {
    await writeSynced(archiveTemp, await compress(Buffer.from(raw)));
    await options.onStage?.('archive_synced');
    let published = false;
    try { await lstat(archivePath); published = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (published) {
      // 上次可能在归档落盘之后、替换日志之前退出。只复用逐字一致的同名归档，绝不覆盖。
      const existing = await decompress(await readSafe(archivePath));
      if (!existing.equals(Buffer.from(raw))) throw new Error('同名封存文件内容不符，保留活动日志与现场');
      await unlink(archiveTemp);
    } else await rename(archiveTemp, archivePath);
    await syncDirectory(archives);
    await options.onStage?.('archive_published');
    await writeSynced(logTemp, JSON.stringify(header) + '\n' + lines.slice(split).join(''));
    await options.onStage?.('log_synced');
    await assertRegularFile(join(dataDir, 'events.jsonl'));
    // 唯一提交点：旧活动日志或完整的「检查点 + 新事件」，没有半份状态/游标的窗口。
    await rename(logTemp, join(dataDir, 'events.jsonl'));
    await syncDirectory(dataDir);
    await options.onStage?.('log_replaced');
  } finally {
    await unlink(archiveTemp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    await unlink(logTemp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
  return [header, ...events.slice(last + 1)];
}
/** 显式恢复操作，调用方持数据锁。仅选择检查点确认过的归档，忽略中断留下的未提交归档。 */
export async function restoreEventLog(dataDir: string, output: string): Promise<void> {
  if (!isAbsolute(output)) throw new Error('恢复目标必须是新的绝对文件路径');
  const events = await readEvents(dataDir), checkpoint = events[0]?.kind === 'store_checkpoint' ? events[0] : undefined;
  const file = await open(output, 'wx', 0o600);
  try {
    for (const name of checkpoint?.archives ?? []) {
      const raw = await decompress(await readSafe(join(dataDir, 'archives', name)));
      if (hash(raw.toString('utf8')) !== name.slice(20, 84)) throw new Error('封存文件校验失败，未完成恢复；未修改原日志');
      await file.writeFile(raw);
    }
    const active = (await readSafe(join(dataDir, 'events.jsonl'))).toString('utf8');
    // 活动日志首行的检查点仅是派生状态，不复制到原始事件流。
    await file.writeFile(checkpoint ? active.slice(active.indexOf('\n') + 1) : active);
    await file.sync();
  } catch (error) {
    await file.close(); await unlink(output); throw error;
  }
  await file.close();
}
