import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { makeChannel } from './channel.js';
import { Watchdog } from './watchdog.js';
import { jsonFile } from './util.js';

process.umask(0o077);
const path = process.argv[process.argv.indexOf('--config') + 1];
if (!process.argv.includes('--config') || !path) { console.error('用法：node dist/src/watchdog-main.js --config /绝对路径/config.json'); process.exit(2); }
let dog: Watchdog | undefined, lock: string | undefined, token = randomUUID(), stopped = false;
async function shutdown(code: number) {
  if (stopped) return; stopped = true;
  const timer = setTimeout(() => process.exit(code || 1), 30000);
  await dog?.stop();
  if (lock && (await jsonFile<any>(lock).catch(() => null))?.token === token) await unlink(lock).catch(() => {});
  clearTimeout(timer); process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); }); process.on('SIGTERM', () => { void shutdown(0); });
try {
  const c = await loadConfig(path);
  // Own state/lock only: never create or migrate the main database.
  await mkdir(c.dataDir, { recursive: true, mode: 0o700 });
  lock = join(c.dataDir, 'watchdog-owner.json');
  try { const old = await jsonFile<{ pid: number }>(lock); try { process.kill(old.pid, 0); throw new Error('watchdog already active'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } await unlink(lock); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const fd = await open(lock, 'wx', 0o600); try { await fd.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await fd.close(); }
  dog = new Watchdog(c, await makeChannel(c)); await dog.start();
  console.log(JSON.stringify({ ready: true, watchdog: true, pid: process.pid }));
} catch { console.error('看门狗启动失败（未打印原始异常）'); lock = undefined; await shutdown(1); }
