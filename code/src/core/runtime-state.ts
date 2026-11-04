import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OperationFailure } from './failures.ts';
import { withNamedLock } from './locks.ts';

export interface RuntimeState { schema: 1; runId?: string; startedAt?: string; completedAt?: string; inspectedAt?: string }
export const runtimeStatePath = (dataDir: string) => join(dataDir, 'runtime-state.json');
export const heartbeatAlertPath = (dataDir: string) => join(dataDir, 'heartbeat-alert.json');
/** 仅运行信号，不是业务状态。普通文件、限长读取；覆盖写通过同目录原子替换发布。 */
export async function readRuntimeFile<T>(path: string): Promise<T | undefined> {
  let visible;
  try { visible = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!visible.isFile() || visible.isSymbolicLink() || visible.nlink !== 1) throw new OperationFailure('unsafe_file', '运行状态不是安全的普通文件；保留现场');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    // 主流程原子替换时允许打开到新文件或已解除目录链接的旧文件；两者都是完整快照。
    if (!stat.isFile() || stat.nlink > 1 || stat.size > 16384) throw new OperationFailure('data_corrupt', '运行状态身份/大小异常；保留现场');
    try { return JSON.parse(await file.readFile('utf8')) as T; }
    catch { throw new OperationFailure('data_corrupt', '运行状态损坏；保留现场'); }
  } finally { await file.close(); }
}
export async function writeRuntimeFile(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // 不覆盖未知的链接/硬链接，沿用数据文件安全边界。
  await readRuntimeFile(path);
  const temporary = join(dirname(path), `.runtime-${randomUUID()}.tmp`), file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
export async function readRuntimeState(dataDir: string): Promise<RuntimeState | undefined> {
  const value = await readRuntimeFile<RuntimeState>(runtimeStatePath(dataDir));
  if (value !== undefined && (!value || value.schema !== 1 || [value.startedAt, value.completedAt].some(at => at !== undefined && (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || typeof value.runId !== 'string' || !value.runId))
    || value.inspectedAt !== undefined && !Number.isFinite(Date.parse(value.inspectedAt)))) throw new OperationFailure('data_corrupt', '主流程运行状态结构损坏；保留现场');
  return value;
}
export async function recordRuntimeProgress(dataDir: string, progress: Omit<RuntimeState, 'schema'>) {
  await withNamedLock(dataDir, '.runtime-state.lock', async () => {
    const old = await readRuntimeState(dataDir);
    await writeRuntimeFile(runtimeStatePath(dataDir), { ...old, schema: 1, ...progress });
  }, 30000);
}
