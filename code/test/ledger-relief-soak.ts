// 显式长跑回归；只造临时数据、假飞书、本机/Loop替身。默认4分钟/5分钟、末3分钟CPU，不属于门禁方法。
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { validateConfig } from '../src/core/config.ts';
import { readJsonl } from '../src/core/store.ts';
import { ledgerPath, readLedger } from '../src/core/ledger.ts';
import { readRuntimeState } from '../src/core/runtime-state.ts';
import type { Config } from '../src/core/types.ts';
import type { LoopEvent } from '../src/core/managed-types.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { largeLedger, notificationStub } from './ledger-relief-fixture.ts';

// 可显式传 A1毫秒、A2毫秒、A2末段CPU毫秒；一个短参数仍可用于两段同长的冒烟。
const fastMs = Number(process.argv[2] ?? 240000), idleMs = Number(process.argv[3] ?? process.argv[2] ?? 300000);
const cpuWindowMs = Number(process.argv[4] ?? Math.min(180000, idleMs));
assert.ok(process.argv.length <= 5 && [fastMs, idleMs].every(ms => Number.isSafeInteger(ms) && ms >= 3000)
  && Number.isSafeInteger(cpuWindowMs) && cpuWindowMs > 0 && cpuWindowMs <= idleMs, '参数须为A1/A2时长和不超过A2时长的CPU窗口（毫秒）');
const root = await realpath(await mkdtemp(join(tmpdir(), 'pa-ledger-soak-')));
const dataDir = join(root, 'data'), inboxDir = join(root, 'events'), workspace = join(root, 'materials'), worker = join(root, 'worker'), project = join(root, 'project');
for (const path of [inboxDir, workspace, worker, project, join(inboxDir, 'loop')]) await mkdir(path, { recursive: true });
await largeLedger(dataDir);
const executable = await notificationStub(root), scheduleFile = join(root, 'schedule.json');
await writeFile(scheduleFile, JSON.stringify({ meetings: [], minutes: [] }));
const config = await validateConfig({ dataDir, inboxDir, sources: {}, workspace: { inboxDir: workspace, pollEveryMs: 1000, settleMs: 0 },
  schedule: { mode: 'fake', calendarIds: ['test'], minuteTokens: [], fakeFile: scheduleFile, pollEveryMs: 1000 },
  feishu: { mode: 'fake', receiverId: 'ou_test', timeoutMs: 2000 }, localChannel: { executable, timeoutMs: 2000 },
  heartbeat: { everyMs: 1000, timeoutMs: 10000, executable }, managedLoop: { intakeEveryMs: 1000, inspectEveryMs: 1000, verifyAfterMs: 0 },
  worker: { executable: process.execPath, args: [resolve(import.meta.dirname, 'loop-stub.ts'), worker], timeoutMs: 3000 } });
const configPath = join(root, 'config.json'), cli = resolve(import.meta.dirname, '../src/cli/main.ts');
const logs = () => readJsonl<any>(join(dataDir, 'service.log.jsonl'));
async function waitFor<T>(get: () => Promise<T>, ready: (value: T) => boolean, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await get(); if (ready(value)) return value; await delay(50); }
  throw new Error('构造长跑等待超时');
}
function cpu(pid: number) {
  const result = spawnSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const value = result.stdout.trim(), [days, time] = value.includes('-') ? value.split('-') : ['0', value];
  return Number(days) * 86400 + time!.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}
/** 独立观察账本锁的唯一owner链接，覆盖主轮以外的写者；采样间隙也计入保守上界。 */
function observeLedgerLock() {
  let stopped = false, previous = performance.now(), heldSince = previous, owner: string | undefined, maxHeldMs = 0, maxGapMs = 0;
  const sample = async () => {
    const before = performance.now();
    const next = await readlink(join(dataDir, '.ledger.lock')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    const after = performance.now(); maxGapMs = Math.max(maxGapMs, after - previous);
    if (next !== owner) {
      if (owner) maxHeldMs = Math.max(maxHeldMs, after - heldSince);
      owner = next; heldSince = previous;
    }
    if (owner) maxHeldMs = Math.max(maxHeldMs, after - heldSince);
    previous = before;
  };
  const running = (async () => { while (!stopped) { await sample(); await delay(50); } await sample(); })();
  return { async stop() { stopped = true; await running; return Math.ceil(Math.max(maxHeldMs, maxGapMs)); } };
}
async function phase(name: string, settings: Config, duration: number, cpuWindow: number) {
  await writeFile(configPath, JSON.stringify(settings)); const beforeLogs = (await logs()).length;
  const child = spawn(process.execPath, [cli, 'daemon', '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
  const lockObserver = observeLedgerLock();
  console.log(JSON.stringify({ phase: name, root, pid: child.pid, durationMs: duration, cpuWindowMs: cpuWindow, startedAt: new Date().toISOString() }));
  try {
    await waitFor(logs, rows => rows.slice(beforeLogs).some(row => row.kind === 'scan_completed'));
    await delay(1500); // 首次连接边界/日程快照建立后才开始空闲测量。
    const baseline = await readFile(ledgerPath(dataDir)), pulse = (await readRuntimeState(dataDir))!.completedAt;
    const began = Date.now(); await delay(duration - cpuWindow);
    const cpuStart = cpu(child.pid!), windowStart = Date.now(); await delay(cpuWindow);
    const cpuSeconds = cpu(child.pid!) - cpuStart, windowMs = Date.now() - windowStart;
    const maxLedgerLockBoundMs = await lockObserver.stop();
    const rows = (await logs()).slice(beforeLogs), scans = rows.filter(row => row.kind === 'scan_completed');
    const durations = scans.map(row => row.durationMs).sort((a, b) => a - b), medianMs = durations[Math.floor(durations.length / 2)]!;
    const maxLockMs = Math.max(...scans.map(row => row.storeLockHeldMs));
    const maxFullReads = Math.max(0, ...scans.slice(1).map(row => row.ledgerFullReads));
    assert.ok(medianMs < 1000); assert.ok(maxLockMs < 5000); assert.ok(maxLedgerLockBoundMs < 5000); assert.ok(maxFullReads <= 1);
    assert.ok(!rows.some(row => /failed|pending/.test(row.kind)), JSON.stringify(rows.filter(row => /failed|pending/.test(row.kind))));
    assert.ok((await readFile(ledgerPath(dataDir))).equals(baseline), '例行检查不应增加账本行');
    const state = await readLedger(dataDir); assert.equal(Object.keys(state.tables.cards).length, 50);
    if (duration >= settings.heartbeat!.everyMs) assert.notEqual((await readRuntimeState(dataDir))!.completedAt, pulse);
    if (name === 'real-frequency') assert.ok(cpuSeconds / (windowMs / 1000) <= 0.05, `CPU比例 ${cpuSeconds / (windowMs / 1000)}`);
    const report = { phase: name, root, wallMs: Date.now() - began, initialLines: baseline.toString().trimEnd().split('\n').length, finalLines: state.seq,
      scans: scans.length, medianMs, maxLockMs, maxLedgerLockBoundMs, maxFullReads, cpuWindowMs: windowMs, cpuSeconds, cpuPercent: cpuSeconds / (windowMs / 1000) * 100 };
    console.log(JSON.stringify(report));
    await writeFile(join(root, `${name}.json`), JSON.stringify(report, null, 2));
    if (name === 'real-frequency') {
      const began = Date.now(), at = new Date().toISOString();
      await writeFile(join(workspace, 'new-material.txt'), '构造材料，只出处理选项，不派真实工作。');
      const event: LoopEvent = { schema: 1, id: 'soak-new-decision', seq: 1, at, project, batch: '构造长跑决定', stage: '甲', state: 'needs_decision',
        reason: { category: 'decision', text: '请选择' }, evidence: [], detail: { question: '构造问题选甲还是乙？', options: ['甲', '乙'] } };
      await writeFile(join(worker, 'events.jsonl'), JSON.stringify(event) + '\n');
      await appendFile(join(inboxDir, 'loop', `${event.batch}.jsonl`), JSON.stringify(event) + '\n');
      const sentPath = join(dataDir, 'feishu-sent.jsonl');
      await waitFor(() => readJsonl<SentMessage>(sentPath), rows => rows.filter(row => row.type === 'interactive').length >= 2, 75000);
      await delay(1100);
      const sent = (await readJsonl<SentMessage>(sentPath)).filter(row => row.type === 'interactive');
      assert.equal(sent.filter(row => !row.operation).length, 2); assert.equal(new Set(sent.map(row => row.noticeId)).size, 2);
      const state = await readLedger(dataDir); assert.ok(state.events[event.id]); assert.equal(Object.keys(state.tables.materials).length, 1);
      const heartbeat = spawnSync(process.execPath, [cli, 'heartbeat-check', '--config', configPath, '--json'], { encoding: 'utf8', timeout: 10000 });
      assert.equal(heartbeat.status, 0, heartbeat.stderr); assert.equal(JSON.parse(heartbeat.stdout).status, 'healthy');
      const view = spawnSync(process.execPath, [cli, 'overview', '--config', configPath, '--json'], { encoding: 'utf8', timeout: 10000 });
      assert.equal(view.status, 0, view.stderr); const current = await readLedger(dataDir), overview = JSON.parse(view.stdout);
      assert.equal(overview.transactions, current.seq); for (const key of Object.keys(current.tables)) assert.deepEqual(overview[key], JSON.parse(JSON.stringify(current.tables[key as keyof typeof current.tables])));
      console.log(JSON.stringify({ phase: 'new-inputs', materialAndLoopMs: Date.now() - began, creates: sent.filter(row => !row.operation).length, heartbeat: 'healthy', tablesCompared: Object.keys(current.tables).length }));
    }
  } finally {
    try { await lockObserver.stop(); }
    finally {
      if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
      assert.equal(child.exitCode, 0, output);
    }
  }
}
try {
  await phase('fast', config, fastMs, Math.floor(fastMs / 2));
  await phase('real-frequency', { ...config, workspace: { ...config.workspace!, pollEveryMs: 60000 },
    managedLoop: { ...config.managedLoop!, intakeEveryMs: 5000, inspectEveryMs: 600000 }, heartbeat: { ...config.heartbeat!, everyMs: 60000, timeoutMs: 180000 } }, idleMs, cpuWindowMs);
  console.log(JSON.stringify({ status: 'passed', root, fastMs, idleMs, cpuWindowMs }));
} catch (error) { console.error(JSON.stringify({ status: 'failed', root, error: String(error) })); throw error; }
