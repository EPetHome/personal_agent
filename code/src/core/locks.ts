import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 只恢复带本程序 owner 的锁，且须由内核确认原 PID 已退出。未知/活锁绝不清。 */
export async function recoverDeadLock(dataDir: string, name: string): Promise<void> {
  const release = await acquireLock(dataDir, `${name}.recovery`);
  const path = join(dataDir, name), owner = join(path, 'owner.json');
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('锁目录不是普通目录，保留现场');
    const file = await lstat(owner);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('锁所有者不可信，保留现场');
    const text = await readFile(owner, 'utf8');
    const value = JSON.parse(text);
    if (value.program !== 'personal-agent' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string') throw new Error('锁所有者不明，保留现场');
    try { process.kill(value.pid, 0); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    if ((await readdir(path)).some(n => n !== 'owner.json') || await readFile(owner, 'utf8') !== text) throw new Error('锁现场变化，拒绝恢复');
    await unlink(owner); await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  } finally { await release(); }
}
export async function acquireLock(dataDir: string, name: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, name);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`数据目录正被占用：${path}；未知锁须确认没有相关进程后人工恢复`);
    throw error;
  }
  const token = randomUUID();
  try { await writeFile(join(path, 'owner.json'), JSON.stringify({ program: 'personal-agent', pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { await rmdir(path).catch(() => {}); throw error; }
  return async () => {
    const owner = join(path, 'owner.json');
    if (JSON.parse(await readFile(owner, 'utf8')).token !== token) throw new Error('锁所有者变化，保留现场');
    await unlink(owner); await rmdir(path);
  };
}
export async function withNamedLock<T>(dataDir: string, name: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireLock(dataDir, name);
  try { return await operation(); } finally { await release(); }
}
