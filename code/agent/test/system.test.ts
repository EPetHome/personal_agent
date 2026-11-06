import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fixture, until, settleLaunchers } from './helpers.js';
import { Store } from '../src/store.js';
import { sleep } from '../src/util.js';

async function launch(file: string, args: string[] = []) {
  const child = spawn(process.execPath, [resolve(file), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout!.on('data', x => { out += x; }); child.stderr!.on('data', x => { err += x; });
  try { await until(() => { if (child.exitCode !== null) throw new Error(`child exited: ${out} ${err}`); return out.split('\n').some(line => { try { return JSON.parse(line).ready === true; } catch { return false; } }); }, 12000); }
  catch (e) { child.kill('SIGKILL'); throw e; }
  return child;
}
async function stop(child?: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill(signal); await done;
}
async function cpu(pid: number) {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(pid), '-o', 'time=']);
  const units = stdout.trim().split(':').reverse().map(Number); return units.reduce((sum, v, i) => sum + v * 60 ** i, 0);
}

test('all script --help/-h invocations exit immediately without sandbox directories, services or file writes', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-v2-script-help-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['home', 'tmp', 'work', 'unbuilt']) await mkdir(join(root, name));
  const scriptsDir = resolve('scripts'), unbuilt = join(root, 'unbuilt/sandbox.mjs');
  await copyFile(join(scriptsDir, 'sandbox.mjs'), unbuilt); // No dist/ exists beside this copy.
  const baseline = (await readdir(root, { recursive: true })).sort();
  const scripts = (await readdir(scriptsDir)).filter(name => name.endsWith('.mjs')).sort((a, b) => a === 'sandbox.mjs' ? -1 : b === 'sandbox.mjs' ? 1 : a.localeCompare(b));
  assert.ok(scripts.length >= 6, 'exercise every .mjs entry, not a manually shortened list');
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), PI_CODING_AGENT_DIR: join(root, 'unused-agent'), PA_PROBE_URL: 'http://127.0.0.1:1' };
  const run = async (file: string, args: string[]) => {
    const running = promisify(execFile)(process.execPath, [file, ...args], { cwd: join(root, 'work'), env, timeout: 2000, killSignal: 'SIGTERM', maxBuffer: 64000 });
    const { stdout, stderr } = await running;
    assert.equal(running.child.killed, false, 'help must exit on its own, not return 0 only after the timeout sent SIGTERM');
    assert.match(stdout, /用法/); assert.match(stdout, /参数/); assert.match(stdout, /常驻/); assert.match(stdout, /停止/);
    assert.equal(stderr, ''); assert.deepEqual((await readdir(root, { recursive: true })).sort(), baseline, `${file} ${args.join(' ')} must have no filesystem effects`);
  };
  for (const name of scripts) for (const flag of ['--help', '-h']) await run(join(scriptsDir, name), [flag]);
  for (const flag of ['--help', '-h']) {
    await run(join(scriptsDir, 'sandbox.mjs'), ['--workers', '--dir', join(root, 'must-not-exist'), flag]);
    await run(unbuilt, [flag]);
  }
});

test('documented sandbox CLI plus main and launchd generator run entirely in a temporary directory', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-v2-cli-'));
  const sandbox = spawn(process.execPath, [resolve('scripts/sandbox.mjs'), '--dir', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let main: ChildProcess | undefined;
  t.after(async () => { await stop(main); await stop(sandbox); await rm(root, { recursive: true, force: true }); });
  await until(async () => { try { await readFile(join(root, 'ready.json')); return true; } catch { return false; } });
  const ready = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8'));
  main = await launch('dist/src/main.js', ['--config', ready.config]);
  await fetch(`${ready.feishu}/inject`, { method: 'POST', body: JSON.stringify({ id: 'cli', text: '现在还有几个loop在工作' }) });
  await until(async () => (await (await fetch(`${ready.feishu}/messages`)).json() as any[]).length === 1);
  const messages = await (await fetch(`${ready.feishu}/messages`)).json() as any[]; assert.match(messages[0].text, /3/);
  await promisify(execFile)(process.execPath, [resolve('dist/src/launchd.js'), '--config', ready.config, '--out', join(root, 'plists')]);
  assert.match(await readFile(join(root, 'plists/local.personal-agent-v2.plist'), 'utf8'), /main.js/);
  assert.match(await readFile(join(root, 'plists/local.personal-agent-v2.watchdog.plist'), 'utf8'), /watchdog-main.js/);
});

test('worker sandbox CLI dispatches only after a real fake-Feishu button callback', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-v2-worker-cli-'));
  const sandbox = spawn(process.execPath, [resolve('scripts/sandbox.mjs'), '--workers', '--dir', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let main: ChildProcess | undefined;
  t.after(async () => { await stop(main); await settleLaunchers(join(root, 'data')); await stop(sandbox); await rm(root, { recursive: true, force: true }); });
  await until(async () => { try { await readFile(join(root, 'ready.json')); return true; } catch { return false; } });
  const ready = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8'));
  const post = async (url: string, value: unknown) => { const r = await fetch(url, { method: 'POST', body: JSON.stringify(value) }); assert.ok(r.ok); };
  await post(`${ready.model}/script`, { flow: [{ tools: [{ name: 'worker_dispatch', arguments: { taskId: 'cli-task', project: 'fixture', title: 'README Hello', goal: 'code/README.md 改 Hello', completion: '门禁过、评审无必修、提交批次分支', boundary: '只改 code/，不合入不推送不碰真实账号', prompt: '改 README 标题为 Hello' } }] }, { text: 'done' }] });
  main = await launch('dist/src/main.js', ['--config', ready.config]);
  await post(`${ready.feishu}/inject`, { id: 'request', text: '改 README' });
  const messages = async () => await (await fetch(`${ready.feishu}/messages`)).json() as any[];
  await until(async () => (await messages())[0]?.card?.buttons.some((b: any) => b.label === '好'));
  let calls = await readFile(join(root, 'loop-calls.jsonl'), 'utf8'); assert.equal(calls.includes('开工'), false);
  const card = (await messages())[0], value = card.card.buttons.find((b: any) => b.label === '好').value;
  await post(`${ready.feishu}/inject`, { id: 'click', quoteId: card.id, button: { value } });
  await until(async () => (await readFile(join(root, 'loop-calls.jsonl'), 'utf8')).includes('启动'));
  calls = await readFile(join(root, 'loop-calls.jsonl'), 'utf8'); assert.equal(calls.split('\n').filter(s => s.includes('"verb":"开工"')).length, 1);
});

test('SIGKILL recovery resumes SQLite graph after sent reply without repeating it', { timeout: 20000 }, async t => {
  const f = await fixture({ flow: [{ tools: [{ name: 'reply', arguments: { text: 'one durable answer' } }] }, { hang: true }] });
  const raw = { ...f.raw, model: { url: `${f.model.url}/v1`, name: 'script-model', auth: { type: 'none' }, timeoutMs: 10000 } };
  const { writeFile } = await import('node:fs/promises'); await writeFile(f.configPath, JSON.stringify(raw));
  let child: ChildProcess | undefined;
  t.after(async () => { await stop(child); await f.close(); });
  child = await launch('dist/src/main.js', ['--config', f.configPath]);
  await f.inject({ id: 'crash', text: 'synthetic crash' }); await until(() => f.model.requests.length === 2 && f.feishu.messages.length === 1);
  await stop(child, 'SIGKILL'); child = await launch('dist/src/main.js', ['--config', f.configPath]);
  const observer = new Store(f.config, true); t.after(() => observer.close());
  await until(() => observer.row('feishu:crash')?.state === 'done');
  assert.equal(f.feishu.messages.length, 1); assert.equal(f.model.requests.length, 3);
  const calls = observer.events(0, 50).filter(e => e.event.includes('"kind":"model_call"')).map(e => JSON.parse(e.event).data.callId);
  assert.equal(new Set(calls).size, calls.length);
});

test('A6: independent watchdog sees 20s stale heartbeat, supervisor restarts exact child, one recovery', { timeout: 45000 }, async t => {
  const f = await fixture();
  Object.assign(f.raw, { watchdog: { heartbeatMs: 500, heartbeatStaleMs: 20000, pollMs: 150, local: { mode: 'fake', url: f.feishu.url } } });
  const { writeFile } = await import('node:fs/promises'); await writeFile(f.configPath, JSON.stringify(f.raw));
  let supervisor: ChildProcess | undefined, dog: ChildProcess | undefined;
  t.after(async () => { await stop(dog); await stop(supervisor); await f.close(); });
  const pidFile = join(f.root, 'child-pid.json');
  supervisor = await launch('scripts/supervisor-stub.mjs', ['--delay-ms', '25000', '--pid-file', pidFile, '--', process.execPath, resolve('dist/src/main.js'), '--config', f.configPath]);
  dog = await launch('dist/src/watchdog-main.js', ['--config', f.configPath]);
  const identity = JSON.parse(await readFile(pidFile, 'utf8')); process.kill(identity.pid, 'SIGKILL');
  await until(() => f.feishu.notifications.some(n => n.fault === 'heartbeat' && n.state === 'fault'), 23000);
  await until(() => f.feishu.notifications.some(n => n.fault === 'heartbeat' && n.state === 'recovery'), 10000);
  await sleep(500);
  assert.equal(f.feishu.notifications.filter(n => n.fault === 'heartbeat' && n.state === 'fault').length, 1);
  assert.equal(f.feishu.notifications.filter(n => n.fault === 'heartbeat' && n.state === 'recovery').length, 1);
  assert.equal(f.feishu.messages.filter(m => m.key.includes(':heartbeat:fault:')).length, 1);
  assert.equal(f.feishu.messages.filter(m => m.key.includes(':heartbeat:recovery:')).length, 1);
  assert.notEqual(JSON.parse(await readFile(pidFile, 'utf8')).pid, identity.pid);
});

test('A7+A9: real 3-minute idle process with 10001 events/200 closed tasks; independent hung input alerts once over 2 minutes', { timeout: 215000 }, async t => {
  const idle = await fixture();
  // Build process configs from fixture defaults, without accessing any real data or credentials.
  const stuck = await fixture({ flow: [{ hang: true }] });
  const { writeFile } = await import('node:fs/promises');
  const idleRaw = { ...idle.raw, feishu: { mode: 'fake', userId: 'owner', url: idle.feishu.url, pollMs: 500, timeoutMs: 1000 } };
  await writeFile(idle.configPath, JSON.stringify(idleRaw));
  const stuckRaw = { ...stuck.raw, model: { url: `${stuck.model.url}/v1`, name: 'script-model', auth: { type: 'none' }, timeoutMs: 240000 },
    queue: { busyMs: 10000, inputTimeoutMs: 240000, stopMs: 2000 }, watchdog: { inputStaleMs: 30000, pollMs: 200, local: { mode: 'fake', url: stuck.feishu.url } } };
  await writeFile(stuck.configPath, JSON.stringify(stuckRaw));
  let idleChild: ChildProcess | undefined, stuckChild: ChildProcess | undefined, dog: ChildProcess | undefined;
  t.after(async () => { await stop(dog); await Promise.all([stop(stuckChild), stop(idleChild)]); await Promise.all([idle.close(), stuck.close()]); });
  idleChild = await launch('dist/src/main.js', ['--config', idle.configPath]);
  const baselineObserver = new Store(idle.config, true), baseline: number[] = [];
  try {
    for (let n = 0; n < 3; n++) {
      const at = Date.now(); await idle.inject({ id: `baseline-${n}`, text: 'baseline chat' });
      await until(() => baselineObserver.row(`feishu:baseline-${n}`)?.state === 'done'); baseline.push(Date.now() - at);
    }
  } finally { baselineObserver.close(); }
  const baselineMs = baseline.sort((a, b) => a - b)[1]!;
  const modelCountBeforeIdle = idle.model.requests.length;
  const seed = new Store(idle.config);
  for (let n = 0; n < 10001; n++) seed.log('fixture_history', { n, text: 'synthetic history only' });
  for (let n = 0; n < 200; n++) seed.putTask({ id: `closed-${n}`, title: 'closed fixture', goal: 'invented', completion: 'done', boundary: 'fixture only', status: 'closed', waiting: '', dispatches: [], conclusion: 'fixture', updated: new Date().toISOString(), subscriptions: [] });
  const eventCount = Number(seed.db.prepare('SELECT COUNT(*) AS n FROM audit').get()!.n); seed.close();
  stuckChild = await launch('dist/src/main.js', ['--config', stuck.configPath]);
  dog = await launch('dist/src/watchdog-main.js', ['--config', stuck.configPath]);
  await stuck.inject({ id: 'hung', text: 'synthetic never-returning model' });
  const start = Date.now();
  await until(() => stuck.feishu.notifications.some(n => n.fault === 'input' && n.state === 'fault'), 35000);
  const firstAlert = Date.now();
  await sleep(Math.max(0, start + 60000 - Date.now())); const cpuStart = await cpu(idleChild.pid!); const wallStart = Date.now();
  await sleep(Math.max(0, start + 180000 - Date.now())); const cpuEnd = await cpu(idleChild.pid!); const wall = (Date.now() - wallStart) / 1000;
  assert.ok(Date.now() - firstAlert >= 120000, 'actually observed at least 2 minutes after stuck alert');
  assert.equal(stuck.feishu.notifications.filter(n => n.fault === 'input' && n.state === 'fault').length, 1);
  assert.equal(stuck.feishu.messages.filter(m => m.key.includes(':input:fault:')).length, 1);
  process.kill(stuckChild.pid!, 0); // Main event loop is still alive, not terminated by watchdog.
  const cpuRatio = (cpuEnd - cpuStart) / wall; t.diagnostic(`idle last-two-minute CPU/wall=${(cpuRatio * 100).toFixed(3)}%; observed=${wall.toFixed(2)}s`); assert.ok(cpuRatio <= 0.05);
  const observer = new Store(idle.config, true); const stuckObserver = new Store(stuck.config, true);
  try {
    assert.equal(Number(observer.db.prepare('SELECT COUNT(*) AS n FROM audit').get()!.n), eventCount, 'no routine log growth over 3 minutes');
    assert.equal(stuckObserver.row('feishu:hung')?.state, 'processing'); assert.equal(idle.model.requests.length, modelCountBeforeIdle);
    // Heavy history does not get replayed to Router; processing is indexed and bounded.
    const before = Date.now(); await idle.inject({ id: 'after-history', text: 'check state' }); await until(() => observer.row('feishu:after-history')?.state === 'done');
    const elapsed = Date.now() - before; t.diagnostic(`new input empty-history median=${baselineMs}ms; heavy-history=${elapsed}ms`); assert.ok(elapsed < 3000); assert.ok(elapsed <= Math.max(1000, baselineMs * 2));
    const requestChars = JSON.stringify(idle.model.requests).length; t.diagnostic(`bounded model request history chars=${requestChars}`);
    assert.ok(requestChars < 100000);
  } finally { observer.close(); stuckObserver.close(); }
});
