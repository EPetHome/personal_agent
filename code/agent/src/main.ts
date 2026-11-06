import { loadConfig } from './config.js';
import { App } from './app.js';
import { failure } from './errors.js';

// No tracing export to a third party, even if the parent shell enabled it.
process.env.LANGSMITH_TRACING = 'false'; process.env.LANGCHAIN_TRACING_V2 = 'false';
process.umask(0o077);
const path = process.argv[process.argv.indexOf('--config') + 1];
if (!process.argv.includes('--config') || !path) { console.error('用法：node dist/src/main.js --config /绝对路径/config.json'); process.exit(2); }
let app: App | undefined, stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  const limit = setTimeout(() => process.exit(code || 1), app?.c.queue.stopMs ?? 30000);
  try { await app?.stop(); } catch { code = 1; }
  clearTimeout(limit); process.exit(code);
}
process.on('SIGTERM', () => { void shutdown(0); }); process.on('SIGINT', () => { void shutdown(0); });
try {
  app = await App.create(await loadConfig(path));
  await app.start(() => { void shutdown(1); });
  console.log(JSON.stringify({ ready: true, pid: process.pid, dataDir: app.c.dataDir }));
} catch (error) { console.error(`个人助手未启动：${failure(error).error} 未打印原始异常或凭据。`); await shutdown(1); }
