// Test-only launchd replacement. Owns only the exact child it spawned.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(2), split = args.indexOf('--');
const get = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (split < 0 || !args[split + 1]) throw new Error('用法：node scripts/supervisor-stub.mjs [--delay-ms 1000] [--pid-file /文件] -- node dist/src/main.js --config /配置');
let child, timer, stopping = false;
function start() {
  child = spawn(args[split + 1], args.slice(split + 2), { stdio: 'inherit', detached: true });
  const pid = child.pid;
  if (get('--pid-file')) void writeFile(get('--pid-file'), JSON.stringify({ pid, supervisor: process.pid }), { mode: 0o600 });
  console.log(JSON.stringify({ started: pid, supervisor: process.pid }));
  child.once('exit', (code, signal) => {
    if (stopping) process.exit(0);
    console.log(JSON.stringify({ exited: pid, code, signal }));
    timer = setTimeout(start, Number(get('--delay-ms') ?? 1000));
  });
  child.once('error', () => { console.error('替身无法启动指定子进程'); process.exit(1); });
}
function stop() {
  if (stopping) return; stopping = true; clearTimeout(timer);
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) process.exit(0);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { process.exit(0); }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} process.exit(0); }, 30000).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
start();
