import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, loadNotificationConfig } from './config.js';
import { failure } from './errors.js';
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
  let configurationError: string | undefined;
  try { await loadConfig(path); } catch (error) { configurationError = failure(error).error; console.error(`业务配置未加载：${configurationError}`); }
  const c = await loadNotificationConfig(path);
  // Own state/lock only: never create or migrate the main database.
  await mkdir(c.dataDir, { recursive: true, mode: 0o700 });
  lock = join(c.dataDir, 'watchdog-owner.json');
  try { const old = await jsonFile<{ pid: number }>(lock); try { process.kill(old.pid, 0); throw new Error('watchdog already active'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } await unlink(lock); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const fd = await open(lock, 'wx', 0o600); try { await fd.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await fd.close(); }
  dog = new Watchdog(c, await makeChannel(c), undefined, configurationError); await dog.start();
  console.log(JSON.stringify({ ready: true, watchdog: true, pid: process.pid }));
} catch (error) { console.error(`看门狗/通知启动失败，未确认飞书告警：${failure(error).error}`); await shutdown(1); }
