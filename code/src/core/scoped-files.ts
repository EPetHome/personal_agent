import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

/** 只允许macOS系统/tmp、/var到/private的精确别名；用户链接仍拒绝。 */
export async function safeDirectory(path: string, create = false): Promise<string> {
  const absolute = resolve(path);
  try {
    const stat = await lstat(absolute), actual = await realpath(absolute);
    const systemAlias = ['/tmp', '/var'].some(root => absolute === root || absolute.startsWith(`${root}/`)) && actual === `/private${absolute}`;
    if (stat.isSymbolicLink()) {
      if (systemAlias && ['/tmp', '/var'].includes(absolute)) return safeDirectory(actual);
      throw new Error('目录是用户链接');
    }
    if (!stat.isDirectory()) throw new Error('目录不是普通目录');
    if (actual !== absolute && !systemAlias) throw new Error('目录祖先含链接');
    return actual;
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = await safeDirectory(dirname(absolute), true), target = join(parent, relative(dirname(absolute), absolute));
    try { await mkdir(target, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    return safeDirectory(target);
  }
}
export async function exclusiveText(path: string, text: string) {
  const parent = await safeDirectory(dirname(path));
  const file = await open(join(parent, relative(dirname(resolve(path)), resolve(path))), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
}
