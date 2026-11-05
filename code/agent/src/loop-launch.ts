import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Config } from './types.js';
import { atomicJson, canonical, hash, parseJson } from './util.js';

export interface OwnedLauncher { pid: number; started?: string }
export interface DispatchLaunch {
  operation: string; project: string; workspace: string; batchFile: string; name: string; branch: string;
  specFile: string; receiptFile: string; token: string; specHash: string; launcher?: OwnedLauncher;
}
interface LaunchSpec {
  v: 1; operation: string; project: string; workspace: string; batchFile: string; name: string; branch: string;
  receiptFile: string; token: string; command: string; args: string[]; log: string;
}
interface LaunchReceipt {
  v: 1; operation: string; token: string; specHash: string; project: string; workspace: string; batchFile: string; name: string; branch: string;
  state: 'starting' | 'running' | 'exited'; wrapper: OwnedLauncher; child?: OwnedLauncher; at: string; exitCode?: number | null; signal?: string | null;
}
export interface LaunchObservation { ended: boolean; live: boolean; invoked?: boolean; invocationSource?: 'spawn-event' | 'legacy-running'; processes?: { wrapper: OwnedLauncher; child?: OwnedLauncher }; fingerprint: string; evidence?: { path: string; sha256: string }; description: string }
const exec = promisify(execFile);
export async function processStarted(pid: number) {
  try { const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 1000, env: { LC_ALL: 'C' } }); return stdout.trim() || undefined; }
  catch { return undefined; } // No process name/command line, secrets or guessed kill target.
}
async function knownAlive(identity?: OwnedLauncher) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return false;
  try { process.kill(identity.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; }
  const current = await processStarted(identity.pid);
  return !!identity.started && current === identity.started;
}
async function privateJson<T>(path: string) {
  try {
    if (await canonical(path) !== resolve(path)) return;
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await fd.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > 64000) return;
      const text = await fd.readFile('utf8'); return { value: parseJson<T>(text), sha256: hash(text) };
    } finally { await fd.close(); }
  } catch { return undefined; } // An absent, corrupt or linked receipt never grants permission.
}
export async function prepareLaunch(c: Config, operation: string, identity: Pick<DispatchLaunch, 'project' | 'workspace' | 'batchFile' | 'name' | 'branch'>): Promise<DispatchLaunch> {
  const dir = join(c.dataDir, 'worker-launches');
  if (await canonical(dir) !== dir) throw new Error('启动记录目录已变化');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (await canonical(dir) !== dir) throw new Error('启动记录目录已变化');
  const specFile = join(dir, `${operation}.launch.json`), receiptFile = join(dir, `${operation}.receipt.json`), token = randomUUID();
  const spec: LaunchSpec = { v: 1, operation, ...identity, receiptFile, token, command: c.loop.command, args: [...c.loop.args, '启动', identity.batchFile, '--json'], log: join(dir, `${operation}.log`) };
  const text = JSON.stringify(spec); await writeFile(specFile, text, { flag: 'wx', mode: 0o600 });
  return { operation, ...identity, specFile, receiptFile, token, specHash: hash(text) };
}
export async function spawnLaunch(binding: DispatchLaunch, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), binding.specFile], { cwd: binding.project, env, detached: true, stdio: 'ignore', shell: false });
  await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject); }); child.unref();
  return { ...binding, launcher: { pid: child.pid!, started: await processStarted(child.pid!) } };
}
export async function observeLaunch(c: Config, binding: DispatchLaunch): Promise<LaunchObservation> {
  const dir = join(c.dataDir, 'worker-launches');
  if (!/^[a-f0-9]{48}$/.test(binding.operation) || binding.specFile !== join(dir, `${binding.operation}.launch.json`) || binding.receiptFile !== join(dir, `${binding.operation}.receipt.json`)) return { ended: false, live: false, fingerprint: 'invalid-binding', description: '原启动身份不完整，不能自动核销' };
  const spec = await privateJson<LaunchSpec>(binding.specFile), receipt = await privateJson<LaunchReceipt>(binding.receiptFile), r = receipt?.value;
  const identity = ['operation', 'project', 'workspace', 'batchFile', 'name', 'branch', 'token'] as const;
  const writerMatches = !binding.launcher || r?.wrapper?.pid === binding.launcher.pid
    && (!binding.launcher.started || !r.wrapper.started || r.wrapper.started === binding.launcher.started);
  const matched = !!spec && !!r && writerMatches && spec.sha256 === binding.specHash && r.v === 1 && r.specHash === binding.specHash && identity.every(k => r[k] === binding[k] && spec.value[k] === binding[k]);
  const ended = !!matched && r.state === 'exited' && Number.isInteger(r.exitCode) && !r.signal;
  const spawned = !!matched && ['running', 'exited'].includes(r.state) && Number.isSafeInteger(r.child?.pid) && (r.child?.pid ?? 0) > 0 && Number.isSafeInteger(r.wrapper?.pid) && r.wrapper.pid > 0;
  const live = !ended && await knownAlive(binding.launcher?.started ? binding.launcher : matched ? r.wrapper : binding.launcher);
  // Older receipts were written after invoking spawn but had no child field.
  // They need the additional CURRENT wrapper PID/start identity check; neither
  // this legacy evidence nor spawn-event evidence alone proves worker receipt.
  const legacy = !!matched && r.state === 'running' && r.child === undefined && live;
  const invoked = spawned || legacy, invocationSource = spawned ? 'spawn-event' as const : legacy ? 'legacy-running' as const : undefined;
  return { ended, live, invoked, invocationSource, ...(invoked ? { processes: { wrapper: r!.wrapper, ...(spawned ? { child: r!.child! } : {}) } } : {}), fingerprint: hash(JSON.stringify({ spec: spec?.sha256, receipt: receipt?.sha256, ended, live, invoked, invocationSource })),
    ...(ended || invoked ? { evidence: { path: binding.receiptFile, sha256: receipt!.sha256 } } : {}),
    description: ended ? `原启动调用已结束（退出码 ${r!.exitCode}），有原编号及身份绑定的结束回执；不代表业务成功` : invoked ? '原启动命令已实际创建；须再核对原批次和存活会话才能确认接收，不能据此释放占用' : live ? '原启动器仍在运行，不能人工释放占用' : '原启动结束证据不足；只能保留占用或由本人在电脑核对后人工核销' };
}
async function runLaunch(path: string) {
  if (!/^[a-f0-9]{48}\.launch\.json$/.test(basename(path))) throw new Error('启动清单身份无效');
  const loaded = await privateJson<LaunchSpec>(path), s = loaded?.value;
  if (!s || s.v !== 1 || basename(path) !== `${s.operation}.launch.json` || s.receiptFile !== join(dirname(path), `${s.operation}.receipt.json`) || s.log !== join(dirname(path), `${s.operation}.log`) || !Array.isArray(s.args) || s.args.some(a => typeof a !== 'string')) throw new Error('启动清单不完整');
  const wrapper = { pid: process.pid, started: await processStarted(process.pid) };
  const receipt = (state: LaunchReceipt['state'], result: Partial<LaunchReceipt> = {}) => atomicJson(s.receiptFile, { v: 1, ...Object.fromEntries(['operation', 'project', 'workspace', 'batchFile', 'name', 'branch', 'token'].map(k => [k, s[k as keyof LaunchSpec]])), specHash: loaded.sha256, wrapper, state, at: new Date().toISOString(), ...result });
  if (await canonical(s.log) !== s.log) throw new Error('启动日志路径已变化');
  await receipt('starting'); const log = await open(s.log, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await log.stat(); if (!info.isFile() || info.nlink !== 1) throw new Error('启动日志不是独立普通文件');
    // One invocation only. This detached supervisor outlives PA, and writes an
    // exit receipt only AFTER the original CLI has closed. It never relaunches.
    const child = spawn(s.command, s.args, { cwd: s.project, env: process.env, stdio: ['ignore', log.fd, log.fd], shell: false });
    const spawned = new Promise<boolean>(resolve => { child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false)); });
    const done = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => {
      child.once('error', () => resolve({ exitCode: null, signal: 'spawn-error' }));
      child.once('close', (code, signal) => resolve({ exitCode: code, signal }));
    });
    let invocation: OwnedLauncher | undefined;
    if (await spawned) {
      invocation = { pid: child.pid! };
      // This proves the fixed original CLI was actually spawned, NOT that the
      // Loop worker accepted it. Acceptance also requires the bound live session.
      await receipt('running', { child: invocation });
    }
    const result = await done; await receipt('exited', { ...result, ...(invocation ? { child: invocation } : {}) });
  } finally { await log.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runLaunch(resolve(process.argv[2] ?? '')).catch(() => { console.error('原 Loop 启动调用未完成核实；保留未决记录，不重试。'); process.exitCode = 1; });
}
