import { lstat, mkdir, readFile, readdir, readlink, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OperationFailure } from './failures.ts';

interface LockSnapshot {
  directory: string;
  /** 仅允许同目录、本锁名前缀和 owner token 完全匹配的已发布链接。 */
  link?: string;
  text: string;
  value: { program: 'personal-agent'; pid: number; token: string };
}
async function readLock(path: string): Promise<LockSnapshot> {
  const stat = await lstat(path);
  let directory = path, link: string | undefined;
  if (stat.isSymbolicLink()) {
    link = await readlink(path);
    const prefix = `${basename(path)}.owned-`;
    // 先做词法校验，绝不沿任意绝对路径、../ 或未知链接去读 owner。
    if (!link.startsWith(prefix) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(link.slice(prefix.length))) {
      throw new Error('锁目录链接不可信，保留现场');
    }
    directory = join(dirname(path), link);
    const target = await lstat(directory);
    if (!target.isDirectory() || target.isSymbolicLink()) throw new Error('锁目录不是普通目录，保留现场');
  } else if (!stat.isDirectory()) throw new Error('锁目录不是普通目录，保留现场');
  const owner = join(directory, 'owner.json'), file = await lstat(owner);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('锁所有者不可信，保留现场');
  const text = await readFile(owner, 'utf8');
  const value = JSON.parse(text) as { program?: unknown; pid?: unknown; token?: unknown } | null;
  if (!value || value.program !== 'personal-agent' || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid)
    || value.pid <= 0 || typeof value.token !== 'string') throw new Error('锁所有者不明，保留现场');
  if (link && link !== `${basename(path)}.owned-${value.token}`) throw new Error('锁所有者与链接不符，保留现场；所有者不可信');
  return { directory, link, text, value: { program: 'personal-agent', pid: value.pid, token: value.token } };
}
/** 只在已核验 owner 后调用。先原子移出活跃名字，再只清理自己的旧目录。 */
async function retireLock(path: string, snapshot: LockSnapshot): Promise<void> {
  const retired = `${path}.released-${randomUUID()}`;
  await rename(path, retired);
  const directory = snapshot.link ? snapshot.directory : retired;
  await unlink(join(directory, 'owner.json'));
  await rmdir(directory);
  if (snapshot.link) await unlink(retired);
}
/** 只恢复带本程序 owner 的锁，且须由内核确认原 PID 已退出。未知/活锁绝不清。 */
export async function recoverDeadLock(dataDir: string, name: string): Promise<void> {
  const release = await acquireLock(dataDir, `${name}.recovery`);
  const path = join(dataDir, name);
  try {
    const snapshot = await readLock(path);
    try { process.kill(snapshot.value.pid, 0); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    if ((await readdir(snapshot.directory)).some(n => n !== 'owner.json')
      || await readFile(join(snapshot.directory, 'owner.json'), 'utf8') !== snapshot.text
      || (snapshot.link && await readlink(path) !== snapshot.link)) throw new Error('锁现场变化，拒绝恢复');
    await retireLock(path, snapshot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  } finally { await release(); }
}
export async function acquireLock(dataDir: string, name: string, waitMs = 0): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, name), token = randomUUID();
  const directory = `${path}.owned-${token}`, owner = join(directory, 'owner.json');
  const deadline = performance.now() + waitMs;
  let prepared = false, published = false;
  try {
    // 初始化发生在独立目录；即使在创建/写 owner 的任一阶段 SIGKILL，活跃名字仍不存在。
    await mkdir(directory, { mode: 0o700 }); prepared = true;
    await writeFile(owner, JSON.stringify({ program: 'personal-agent', pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
    while (true) {
      try {
        // symlink 为原子且不覆盖的发布点；不能用可能覆盖空未知目录的 rename。
        await symlink(basename(directory), path, 'dir'); published = true; break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (waitMs <= 0) throw new OperationFailure('lock_busy', `数据目录正被占用：${path}；未知锁须确认没有相关进程后人工恢复`);
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new OperationFailure('lock_timeout', '记录文件正忙，这次反馈尚未记下，请检查本机服务后再试。');
        await delay(Math.min(50, remaining));
      }
    }
  } finally {
    // 只清本次已创建、但尚未发布的目录；从不猜测或改写占住活跃名字的未知对象。
    if (prepared && !published) {
      await unlink(owner).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      await rmdir(directory);
    }
  }
  return async () => {
    let snapshot: LockSnapshot;
    try { snapshot = await readLock(path); }
    catch { throw new Error('锁所有者变化，保留现场'); }
    if (snapshot.value.token !== token || snapshot.directory !== directory || snapshot.link !== basename(directory)) {
      throw new Error('锁所有者变化，保留现场');
    }
    await retireLock(path, snapshot);
  };
}
export async function withNamedLock<T>(dataDir: string, name: string, operation: () => Promise<T>, waitMs = 0): Promise<T> {
  const release = await acquireLock(dataDir, name, waitMs);
  try { return await operation(); } finally { await release(); }
}
