// Test-only launchd replacement. Owns only the exact child it spawned.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(2), split = args.indexOf('--');
if (args.slice(0, split < 0 ? args.length : split).some(arg => arg === '--help' || arg === '-h')) {
  console.log(`用法：node scripts/supervisor-stub.mjs [--delay-ms <毫秒>] [--pid-file <文件>] -- <可执行程序> [子进程参数...]
参数：--delay-ms 是退出后重启间隔，默认1000；--pid-file 写本次子进程及监督器 PID；-- 后原样传给子进程；--help/-h 只显示帮助。
常驻：是，启动指定构造子进程，退出后继续拉起，直到监督器收到停止信号。
停止：向本次监督器发送 SIGTERM 或前台 Ctrl-C；只结束它启动的子进程组，最多等待30秒后强制结束。
帮助立即以退出码 0 结束，不启动子进程，不建目录、不写 PID 文件。`);
  process.exit(0);
}
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
