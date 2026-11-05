import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { identity, privateJson, stopGroup, type ProcessIdentity } from './pi-process.js';
import { atomicJson, hash, parseJson } from './util.js';

export type PiState = 'queued' | 'launching' | 'running' | 'done' | 'needs-decision' | 'failed' | 'timed-out' | 'interrupted' | 'stopped';
export interface PiSpec { v: 1; operation: string; token: string; cwd: string; command: string; args: string[]; launchedAt: number; timeoutMs: number }
export interface PiIdentity { operation: string; token: string; specHash: string; wrapper: ProcessIdentity; child?: ProcessIdentity }
export interface PiAnswer { status: 'done' | 'needs-decision' | 'failed'; summary: string; question?: string; evidence: string[] }
export interface PiOutcome extends PiIdentity { state: PiState; answer: PiAnswer; cleaned: boolean; endedAt: number; exitCode: number | null }
interface AgentResult { operation: string; token: string; final: string; failed: boolean }
export async function answerFrom(dir: string, operation: string, token: string): Promise<PiAnswer> {
  try {
    const result = await privateJson<AgentResult>(join(dir, 'agent-result.json'));
    if (!result || result.operation !== operation || result.token !== token || result.failed || typeof result.final !== 'string' || result.final.length > 64000) throw new Error('missing_result');
    const answer = parseJson<PiAnswer>(result.final);
    if (!['done', 'needs-decision', 'failed'].includes(answer.status) || typeof answer.summary !== 'string' || !answer.summary.trim() || answer.summary.length > 32000 || answer.question !== undefined && typeof answer.question !== 'string' || answer.status === 'needs-decision' && !answer.question?.trim()) throw new Error('bad_result');
    if (answer.evidence !== undefined && (!Array.isArray(answer.evidence) || answer.evidence.length > 100 || answer.evidence.some(p => typeof p !== 'string'))) throw new Error('bad_evidence');
    return { status: answer.status, summary: answer.summary, ...(answer.question ? { question: answer.question } : {}), evidence: answer.evidence ?? [] };
  } catch { return { status: 'failed', summary: 'Pi 没有交回身份匹配的有效结果；没有自动重派，请核对本次派工日志。', evidence: [] }; }
}
export async function launchPi(dir: string, specHash: string, env: NodeJS.ProcessEnv) {
  const wrapper = spawn(process.execPath, [fileURLToPath(import.meta.url), '--pi-job', dir, specHash], { detached: true, stdio: 'ignore', env, shell: false, cwd: dir });
  await new Promise<void>((accept, reject) => { wrapper.once('spawn', accept); wrapper.once('error', reject); }); wrapper.unref();
  return wrapper.pid!;
}
async function supervise(dir: string, expectedHash: string) {
  const spec = await privateJson<PiSpec>(join(dir, 'spec.json'));
  if (!spec || hash(JSON.stringify(spec)) !== expectedHash) throw new Error('派工清单指纹不符');
  const own = await identity(process.pid); if (!own || own.pgid !== own.pid) throw new Error('没有独立进程组');
  const binding: PiIdentity = { operation: spec.operation, token: spec.token, specHash: expectedHash, wrapper: own };
  await atomicJson(join(dir, 'identity.json'), binding); // Before invoking Pi, survives PA exit.
  const output = await open(join(dir, 'stdout.jsonl'), 'a', 0o600), error = await open(join(dir, 'stderr.log'), 'a', 0o600);
  let forced: PiState | undefined, finishing: Promise<void> | undefined;
  const finish = (exitCode: number | null) => finishing ??= (async () => {
    clearTimeout(timeout);
    const cleaned = await stopGroup(own, true);
    let answer = await answerFrom(dir, spec.operation, spec.token);
    let state: PiState = forced ?? (exitCode === 0 ? answer.status : exitCode === null ? 'interrupted' : 'failed');
    if (state === 'interrupted') answer = { status: 'failed', summary: 'Pi 进程已中断，没有交回有效结果；没有自动重派。', evidence: [] };
    if (forced || !cleaned) answer = { status: 'failed', summary: forced === 'timed-out' ? 'Pi 派工超时，已按原进程身份结束；没有自动重派。' : forced === 'stopped' ? '本次 Pi 派工已按原进程身份停止；没有自动重派。' : 'Pi 已退出但没有有效结果或清理确认；没有自动重派。', evidence: [] };
    if (!cleaned) { state = 'failed'; answer.summary = '无法确认本次 Pi 的所有进程已结束，需要你在电脑核对；没有自动重派。'; }
    const ready = await privateJson<{ operation: string; token: string; pid: number }>(join(dir, 'ready.json'));
    if (!forced && (!ready || ready.operation !== spec.operation || ready.token !== spec.token || ready.pid !== binding.child?.pid)) { state = 'failed'; answer = { status: 'failed', summary: '读写检查扩展未确认加载，需要你决定；未开放任何内置工具，没有自动重派。', evidence: [] }; }
    await atomicJson(join(dir, 'result.json'), { ...binding, state, answer, cleaned, endedAt: Date.now(), exitCode } satisfies PiOutcome);
    await Promise.all([output.close(), error.close()]);
  })();
  const timeout = setTimeout(() => { forced = 'timed-out'; void finish(null).catch(() => { process.exitCode = 1; }); }, Math.max(1, spec.launchedAt + spec.timeoutMs - Date.now()));
  process.on('SIGUSR1', () => { forced = 'stopped'; void finish(null).catch(() => { process.exitCode = 1; }); });
  process.on('SIGUSR2', () => { forced = 'timed-out'; void finish(null).catch(() => { process.exitCode = 1; }); });
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, PA_PI_JOB_DIR: dir }, stdio: ['ignore', output.fd, error.fd], shell: false });
  child.once('error', () => { void finish(null).catch(() => { process.exitCode = 1; }); });
  child.once('close', code => { void finish(code).catch(() => { process.exitCode = 1; }); });
  await new Promise<void>(accept => { child.once('spawn', accept); child.once('error', accept); });
  if (child.pid) {
    binding.child = await identity(child.pid);
    await atomicJson(join(dir, 'identity.json'), binding);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--pi-job') supervise(process.argv[3]!, process.argv[4]!).catch(() => { process.exitCode = 1; });
