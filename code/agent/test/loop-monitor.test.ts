import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LoopMonitor, LOOP_MONITOR_MS, LOOP_MONITOR_QUIET_MS } from '../src/loop-monitor.js';
import { Store } from '../src/store.js';
import { Files } from '../src/files.js';
import { Workers, type WorkerSnapshot, type WorkerOperation } from '../src/worker.js';
import { TaskMessages } from '../src/cards.js';
import type { Channel, MessageCard } from '../src/channel.js';
import type { Input, QueueRow, TaskCard } from '../src/types.js';
import { Intake } from '../src/intake.js';
import { App } from '../src/app.js';
import { command } from '../src/loop.js';
import { kernelFacts } from '../src/loop-kernel.js';
import { canonical } from '../src/util.js';
import { SafeError } from '../src/errors.js';
import { fixture, until } from './helpers.js';

class LocalChannel implements Channel {
  readonly messages: { id: string; text: string; card?: MessageCard }[] = [];
  readonly updates: string[] = [];
  uncertain = false;
  sends = 0;
  async send(text: string) { this.sends++; if (this.uncertain) throw new Error('synthetic delivery uncertainty'); const id = `message-${this.messages.length}`; this.messages.push({ id, text }); return id; }
  async update(id: string, text: string) { this.updates.push(id); this.messages.find(m => m.id === id)!.text = text; }
  async sendCard(card: MessageCard) { const id = await this.send(card.text); this.messages.at(-1)!.card = card; return id; }
  async updateCard(id: string, card: MessageCard) { await this.update(id, card.text); this.messages.find(m => m.id === id)!.card = card; }
  async download() { throw new Error('no attachments in this fixture'); }
  async start() {}
  async stop() {}
}
const task = (project: string, id = 'original'): TaskCard => ({ id, title: `构造任务 ${id}`, goal: '原目标', completion: '原完成标准', boundary: '只用构造数据', status: 'running', waiting: '', dispatches: [], conclusion: '', updated: new Date().toISOString(), subscriptions: [{ kind: 'loop', value: join(project, `${id}.json`) }], worker: { kind: 'loop', project, batchFile: join(project, `${id}.json`) } });
const snapshot = (state = 'running'): WorkerSnapshot => ({ state, fingerprint: state, active: state === 'running', data: { project: 'fixture', batch: { name: 'fixture', file: '/unused' }, state, stages: [] } });
async function harness(t: TestContext) {
  const f = await fixture(); let store = new Store(f.config); const channel = new LocalChannel();
  let clock = Date.parse('2026-11-07T12:00:00Z'), calls = 0;
  let source: () => Promise<WorkerSnapshot> = async () => snapshot();
  const make = () => {
    const w = new Workers(f.config, store, channel, new Files(f.config, store));
    const m = new LoopMonitor(f.config, store, w, () => clock);
    m.workers.adapters.get('loop')!.status = async () => { calls++; return source(); };
    return m;
  };
  let monitor = make(); store.putTask(task(f.project));
  t.after(async () => { await monitor.stop(); store.close(); await f.close(); });
  return { f, channel, get store() { return store; }, get monitor() { return monitor; }, get calls() { return calls; }, get clock() { return clock; },
    source(fn: () => Promise<WorkerSnapshot>) { source = fn; }, advance(ms = LOOP_MONITOR_MS) { clock += ms; },
    async restart() { await monitor.stop(); store.close(); store = new Store(f.config); monitor = make(); },
  };
}
const notices = (store: Store) => Number(store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='loop_monitor_notice'").get()!.n);
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }

for (const uncertain of [false, true]) test(`acceptance repair: coordinated publisher preserves the underlying ${uncertain ? 'uncertain' : 'sent'} receipt`, async t => {
  const publish = TaskMessages.prototype.publish, underlying: unknown[] = [];
  t.mock.method(TaskMessages.prototype, 'publish', async function(this: TaskMessages, ...args: Parameters<TaskMessages['publish']>) {
    const result = await publish.apply(this, args); underlying.push(result); return result;
  });
  const h = await harness(t); h.channel.uncertain = uncertain;
  const result: unknown = await h.monitor.workers.messages.publish('original', 'receipt-contract');
  assert.equal(underlying.length, 1); assert.deepEqual(result, underlying[0], 'do not erase or synthesize the underlying publication result');
  if (result !== undefined) { assert.ok(result && typeof result === 'object' && 'status' in result); assert.equal(result.status, uncertain ? 'uncertain' : 'sent'); }
  assert.equal(h.store.get<any>('task-message:original', null).state, uncertain ? 'uncertain' : 'sent');
});

test('A3: default 60s timer, single-flight, and arbitrarily long healthy execution stay quiet', async t => {
  const h = await harness(t); assert.equal(LOOP_MONITOR_MS, 60_000);
  t.mock.timers.enable({ apis: ['setInterval'] });
  h.monitor.start(error => { throw error; }); t.mock.timers.tick(59_999); assert.equal(h.calls, 0);
  t.mock.timers.tick(1); await h.monitor.tick(); assert.equal(h.calls, 1);
  for (let n = 0; n < 4; n++) { h.advance(24 * 3600_000); await h.monitor.tick(); }
  assert.equal(h.calls, 5); assert.equal(h.channel.messages.length, 0); assert.equal(h.store.task('original')!.status, 'running');
  h.source(async () => snapshot('failed')); h.advance(); await h.monitor.tick();
  assert.equal(h.channel.messages.length, 1); assert.match(h.channel.messages[0]!.text, /失败已核实（不是业务完成）/);
  assert.match(h.channel.messages[0]!.text, /original.json/); assert.match(h.channel.messages[0]!.text, /最后成功核实：2026-/);
  assert.equal(h.store.task('original')!.status, 'failed'); assert.notEqual(h.store.task('original')!.status, 'done');
  const calls = h.calls; h.advance(LOOP_MONITOR_QUIET_MS); await h.monitor.tick(); assert.equal(h.calls, calls, 'known terminal execution stops polling');
});

test('60s cadence does not silently become 120s when a query takes time; ended observations resume after a new source event', async t => {
  const h = await harness(t); h.source(async () => { h.advance(250); return snapshot(); });
  await h.monitor.tick(); h.advance(59_750); await h.monitor.tick(); assert.equal(h.calls, 2);
  h.source(async () => snapshot('done')); h.advance(); await h.monitor.tick(); assert.equal(h.store.task('original')!.status, 'incomplete');
  const count = h.calls; h.advance(); await h.monitor.tick(); assert.equal(h.calls, count);
  const card = h.store.task('original')!; card.status = 'running'; h.store.putTask(card);
  h.source(async () => snapshot()); h.advance(); await h.monitor.tick(); assert.equal(h.calls, count + 1);
  assert.equal(h.channel.messages.length, 0, 'technical end does not generate a business-complete notification');
});

for (const state of ['queued', 'needs-decision']) test(`A3: ${state} and waiting-for-owner are lower-frequency, never task failures`, async t => {
  const h = await harness(t); h.source(async () => snapshot(state));
  const card = h.store.task('original')!; card.status = state; if (state === 'needs-decision') card.waiting = '等本人决定'; h.store.putTask(card);
  await h.monitor.tick(); h.advance(); await h.monitor.tick(); assert.equal(h.calls, 1);
  h.advance(LOOP_MONITOR_QUIET_MS - LOOP_MONITOR_MS); await h.monitor.tick(); assert.equal(h.calls, 2);
  assert.equal(h.channel.messages.length, 0); assert.equal(h.store.task('original')!.status, state);
});

test('A4: two query failures, persistent episode across restart, recovery edits original notice without clearing action leases', async t => {
  const h = await harness(t); await h.monitor.tick(); const last = h.store.task('original')!.lastVerifiedAt;
  // An unresolved reply must not be reconciled by a successful ordinary query.
  const op: WorkerOperation = { id: 'unverified-reply', thread: 'old-input', tool: 'worker_reply', args: {}, token: 'original-token', state: 'uncertain', basis: snapshot(), definition: '', needsApproval: true, reason: '原操作回执未知', resources: ['fixture-resource'], resourceState: 'held',
    request: { id: 'unverified-reply', taskId: 'original', worker: 'loop', action: 'reply', project: h.f.project, batchFile: join(h.f.project, 'original.json'), stage: null, title: '', goal: '', completion: '', boundary: '', prompt: '', text: '', mode: 'resume', redLine: false, options: {} } };
  h.monitor.workers.journal.write(op); h.monitor.workers.journal.retain(op, ['fixture-resource']);
  h.source(async () => { throw new SafeError('timeout', '构造原查询超时'); });
  h.advance(); await h.monitor.tick(); assert.equal(h.channel.messages.length, 0);
  h.advance(); await h.monitor.tick(); assert.equal(h.channel.messages.length, 1);
  const id = h.channel.messages[0]!.id; assert.match(h.channel.messages[0]!.text, /状态待核实/); assert.match(h.channel.messages[0]!.text, new RegExp(last!));
  assert.match(h.channel.messages[0]!.text, /构造原查询超时/); assert.equal(h.store.task('original')!.status, 'running');
  assert.equal(h.store.task('original')!.lastVerifiedAt, last);
  for (let n = 0; n < 3; n++) { h.advance(); await h.monitor.tick(); }
  await h.restart(); h.advance(); await h.monitor.tick();
  assert.equal(h.channel.messages.length, 1); assert.equal(h.channel.updates.length, 0); assert.equal(notices(h.store), 1);
  h.source(async () => snapshot()); h.advance(); await h.monitor.tick();
  assert.equal(h.channel.messages.length, 1); assert.deepEqual(h.channel.updates, [id]); assert.match(h.channel.messages[0]!.text, /状态核实已恢复/);
  assert.doesNotMatch(h.channel.messages[0]!.text, /失败原因：/); assert.equal(h.monitor.workers.operation(op.id)!.state, 'uncertain');
  assert.equal(h.monitor.workers.operation(op.id)!.resourceState, 'held'); assert.deepEqual(h.monitor.workers.journal.owners(['fixture-resource']), [op.id]);
  assert.equal(notices(h.store), 2); h.advance(); await h.monitor.tick(); assert.equal(h.channel.updates.length, 1);
});

test('A4: an event/status lookup newer than the last poll remains the last reliable fact in an uncertainty notice', async t => {
  const h = await harness(t); h.source(async () => { throw new SafeError('unavailable', '构造查询离线'); });
  await h.monitor.tick(); h.advance(30_000);
  const card = h.store.task('original')!, at = new Date(h.clock).toISOString(); card.lastVerifiedAt = at; h.store.putTask(card);
  h.advance(30_000); await h.monitor.tick();
  assert.equal(h.channel.messages.length, 1); assert.match(h.channel.messages[0]!.text, new RegExp(`最后成功核实：${at}`));
  assert.match(h.channel.messages[0]!.text, /原任务最近的已核实记录/); assert.equal(h.store.task('original')!.lastVerifiedAt, at);
});

test('A4: timeout notification uses a fresh channel deadline, not the expired query signal', async t => {
  const h = await harness(t); h.f.config.loop.timeoutMs = 25;
  h.monitor.workers.adapters.get('loop')!.status = async (_request, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  await h.monitor.tick(); h.advance(); await h.monitor.tick();
  assert.equal(h.channel.messages.length, 1); assert.match(h.channel.messages[0]!.text, /状态待核实/);
  assert.equal(h.store.get<any>('task-message:original', null).state, 'sent');
});

test('A4: uncertain channel delivery never invents a delivered alert or repeats it, even on restart/recovery', async t => {
  const h = await harness(t); h.channel.uncertain = true; h.source(async () => { throw new SafeError('unavailable', '构造查询不可用'); });
  await h.monitor.tick(); h.advance(); await h.monitor.tick(); assert.equal(h.channel.sends, 1);
  assert.equal(h.store.get<any>('task-message:original', null).state, 'uncertain'); assert.equal(h.channel.messages.length, 0);
  await h.restart(); h.advance(); await h.monitor.tick(); h.channel.uncertain = false; h.source(async () => snapshot()); h.advance(); await h.monitor.tick();
  assert.equal(h.channel.sends, 1); assert.equal(h.channel.updates.length, 0); assert.equal(h.store.get<any>('task-message:original', null).state, 'uncertain');
});

test('monitor coalesces slow polls, never claims owner input, and stop cancels only its read, without counting shutdown as failure', async t => {
  const h = await harness(t); let active = 0, peak = 0;
  h.monitor.workers.adapters.get('loop')!.status = async (_request, signal) => {
    active++; peak = Math.max(active, peak);
    try { return await new Promise<WorkerSnapshot>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); }
    finally { active--; }
  };
  h.store.enqueue({ id: 'owner', source: 'feishu', who: 'owner', text: '本人优先', attachments: [], at: new Date().toISOString() });
  const first = h.monitor.tick(); assert.equal(h.monitor.tick(), first); assert.equal(h.monitor.tick(), first); assert.equal(active, 1);
  assert.equal(h.store.row('owner')!.state, 'pending', 'observer neither consumes nor delays the owner queue');
  assert.equal(h.f.model.requests.length, 0, 'observer never occupies a Router/model turn');
  await h.monitor.stop(); await first; assert.equal(active, 0); assert.equal(peak, 1); assert.equal(notices(h.store), 0);
  assert.equal(h.store.get('loop-monitor:original', null), null); await h.monitor.tick(); assert.equal(active, 0);
});

test('old result cannot revive a cancelled task or overwrite newer input; stopped/closed/unmanaged/Pi tasks are never scanned', async t => {
  const h = await harness(t); let finish!: (s: WorkerSnapshot) => void;
  h.source(() => new Promise(resolve => { finish = resolve; })); const work = h.monitor.tick();
  const card = h.store.task('original')!; card.status = 'cancelled'; card.notice = '本人刚取消'; h.store.putTask(card); finish(snapshot('failed')); await work;
  assert.equal(h.store.task('original')!.status, 'cancelled'); assert.equal(h.store.task('original')!.notice, '本人刚取消'); assert.equal(notices(h.store), 0);
  for (const status of ['closed', 'stopped', 'done', 'reconciled']) h.store.putTask({ ...task(h.f.project, status), status });
  h.store.putTask({ ...task(h.f.project, 'pi'), worker: { kind: 'pi', project: h.f.project, batchFile: 'pi-job' } });
  h.store.putTask({ ...task(h.f.project, 'undispatched'), worker: { kind: 'loop', project: h.f.project, batchFile: '' } });
  const calls = h.calls; h.advance(); await h.monitor.tick(); assert.equal(h.calls, calls);
});

test('monitor preserves pending approval buttons and unrelated task notices', async t => {
  const h = await harness(t);
  const card = h.store.task('original')!; card.notice = '原操作还未核实'; h.store.putTask(card);
  // Use a real Workers.prepare to generate the approval shape, but only a
  // read-only constructed adapter. There is no execution in this test.
  const w = h.monitor.workers;
  const op = await w.prepare('approval-input', 'worker_reply', { taskId: card.id, mode: 'resume', text: '继续' });
  h.store.set(`worker:pending:${card.id}`, op.id); h.source(async () => { throw new SafeError('unavailable', '构造离线'); });
  await h.monitor.tick(); h.advance(); await h.monitor.tick();
  assert.match(h.channel.messages[0]!.text, /原操作还未核实/); assert.ok(h.channel.messages[0]!.card!.buttons.some(b => b.label === '好' && b.value.operation === op.id));
  h.source(async () => snapshot()); h.advance(); await h.monitor.tick();
  assert.match(h.channel.messages[0]!.text, /原操作还未核实/); assert.match(h.channel.messages[0]!.text, /状态核实已恢复/);
  assert.equal(w.operation(op.id)!.state, 'planned');
});

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
async function nativeFixture(t: TestContext, waiting = false) {
  const f = await fixture({ flow: [{ text: '只用本地构造模型' }] }, { intake: { watch: false, fallbackMs: 3600_000 } });
  const root = await canonical(f.root), project = f.config.projects[0]!.root;
  git(project, 'init', '-b', 'dev'); await writeFile(join(project, 'README.md'), 'fixture'); git(project, 'add', '.'); git(project, 'commit', '-m', 'fixture');
  const file = join(project, 'docs/batches/original/开发卡.json'); await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, flow: ['开发评审', '测试', '验收'], tasks: [{ name: '甲' }, { name: '乙' }] }));
  const b = { kernel: true, runId: randomUUID(), project, batch: { file, name: '原执行' }, state: waiting ? 'paused' : 'running', events: { lastSeq: 1 }, tasks: [{ id: 'task-a', name: '甲', active: !waiting, reason: waiting ? '构造等待本人决定' : '正常长任务' }, { id: 'task-b', name: '乙', active: true, waiting: true, reason: '本机排队，无需本人操作' }] };
  const path = join(root, 'source.json'), callsPath = join(root, 'calls.jsonl');
  const source: any = { v: 1, batches: [b], test: { root, project, workspace: project, run: f.config.projects[0]!.loopRunDirs[0] } };
  const save = () => writeFile(path, JSON.stringify(source)); await save();
  f.config.loop.args = [resolve('scripts/loop-worker-stub.mjs'), '--state', path, '--calls', callsPath];
  const query = async (card: string, cwd: string) => JSON.parse(await command(f.config.loop.command, [...f.config.loop.args, '查询', card, '--json'], f.config.loop.timeoutMs, cwd));
  const initial = await query(file, project), store = new Store(f.config), files = new Files(f.config, store);
  const facts = await kernelFacts(f.config, files, initial, query);
  const card = task(project); card.worker!.batchFile = file; card.worker!.loop = { ...facts.binding, taskId: 'task-a' }; card.sourceRevision = facts.revision; card.lastVerifiedAt = facts.verifiedAt;
  card.subscriptions = [{ kind: 'loop', value: file }];
  if (waiting) card.status = '等你决定';
  card.verified = { event: 'seed', state: waiting ? '等你决定' : '进行中', stage: null, layers: { businessAcceptance: '未验证' }, manual: [], evidence: facts.evidence, snapshot: facts };
  store.putTask(card); store.close(); await writeFile(callsPath, '');
  const calls = async () => (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
  let app: App | undefined; const channel = new LocalChannel(); let clock = Date.now();
  const start = async (onFatal?: (error: unknown) => void) => { app = new App(f.config, channel); t.mock.method(app.loopMonitor, 'now', () => clock); await app.start(onFatal); return app; };
  t.after(async () => { await app?.stop(); await f.close(); });
  return { f, b, source, initial, save, query, channel, calls, start, advance(ms = LOOP_MONITOR_MS) { clock += ms; }, async stop() { await app?.stop(); } };
}

for (const change of ['decision', 'completion']) for (const arrival of ['queued-before-observation', 'arrives-after-observation']) test(`repair 1: ${change} ${arrival} still reaches Intake/Router exactly once`, async t => {
  const f = await nativeFixture(t), app = await f.start(), received: Input[] = [], offered: Input[] = [];
  const intake = new Intake(f.f.config, app.store, app.router.files, input => { offered.push(input); if (app.store.enqueue(input)) received.push(input); });
  const originalEvents = () => received.filter(input => input.workerId === 'original');
  const before = app.store.task('original')!;
  await fetch(`${f.f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'task_card', arguments: { id: 'original', cause: `构造 ${change} 修订`, assessment: '依据原执行核实，非业务完成', suggestion: '核对原执行结果后再决定' } }] }, { text: 'done' }] }) });
  f.b.events.lastSeq = 2; f.b.state = change === 'completion' ? 'done' : 'paused';
  for (const task of f.b.tasks) { task.active = false; task.waiting = false; task.reason = change === 'completion' ? '构造执行已结束，业务未验' : '构造待本人决定'; }
  await f.save(); await f.query(f.b.batch.file, f.f.config.projects[0]!.root);
  if (arrival === 'queued-before-observation') await intake.scan();
  await app.loopMonitor.tick();
  const observed = app.store.task('original')!;
  assert.equal(observed.sourceRevision, before.sourceRevision, 'observation must not consume the normal event cursor');
  assert.deepEqual(observed.verified, before.verified); assert.equal(observed.lastVerifiedAt, before.lastVerifiedAt);
  assert.equal(app.store.get<any>('loop-monitor:original', null).revision, 2); assert.equal(f.channel.messages.length, 0);
  if (arrival === 'arrives-after-observation') await intake.scan();
  assert.equal(originalEvents().length, 1); const event = originalEvents()[0]!;
  // Discovery can legitimately add task-b. Each identity/revision must enqueue
  // once; a sibling event is not a duplicate of task-a's original event.
  assert.equal(new Set(received.map(input => app.store.task(input.workerId!)!.worker!.loop!.taskId)).size, received.length);
  for (const input of received) {
    assert.equal((input.raw as { runId: string }).runId, f.b.runId);
    assert.ok(['task-a', 'task-b'].includes(app.store.task(input.workerId!)!.worker!.loop!.taskId!));
  }
  await intake.scan(); assert.equal(originalEvents().length, 1); assert.equal(offered.filter(input => input.workerId === 'original').length, 1, 'durably queued verification is not re-offered before consumption');
  assert.equal(Number(app.store.db.prepare('SELECT COUNT(*) AS n FROM inputs WHERE id=?').get(event.id)!.n), 1);
  assert.deepEqual(app.store.match(event).map(card => card.id), ['original']);
  app.store.start(event.id); assert.equal(await app.router.process(app.store.row(event.id)!, new AbortController().signal), 'done'); app.store.finish(event.id);
  assert.equal(app.store.task('original')!.sourceRevision, 2); assert.equal(app.store.task('original')!.verified!.event, event.id);
  assert.equal(f.channel.messages.length, 1); assert.match(f.channel.messages[0]!.text, new RegExp(`构造 ${change} 修订`));
  const turns = f.f.model.requests.length; assert.ok(turns > 0);
  await intake.scan(); await app.router.process(app.store.row(event.id)!, new AbortController().signal);
  assert.equal(originalEvents().length, 1); assert.equal(new Set(received.map(input => input.id)).size, received.length);
  assert.equal(f.f.model.requests.length, turns); assert.equal(f.channel.messages.length, 1);
  assert.equal(await app.router.workers.ingest({ ...event, id: `${event.id}:old`, raw: { ...(event.raw as object), revision: 1 } }), false);
  assert.equal(app.store.task('original')!.sourceRevision, 2); assert.ok((await f.calls()).every(c => c.verb === '查询'));
});

test('repair 1: independent observed revision rejects an older source instead of reporting false recovery', async t => {
  const f = await nativeFixture(t), app = await f.start();
  f.b.events.lastSeq = 3; await f.save(); await app.loopMonitor.tick();
  assert.equal(app.store.task('original')!.sourceRevision, 1); assert.equal(app.store.get<any>('loop-monitor:original', null).revision, 3);
  f.source.test.queryFailure = 'bad-receipt'; await f.save(); f.advance(); await app.loopMonitor.tick(); f.advance(); await app.loopMonitor.tick();
  assert.equal(f.channel.messages.length, 1); delete f.source.test.queryFailure; f.b.events.lastSeq = 2; await f.save();
  f.advance(); await app.loopMonitor.tick(); assert.equal(f.channel.updates.length, 0); assert.match(f.channel.messages[0]!.text, /状态待核实/);
  assert.equal(app.store.get<any>('loop-monitor:original', null).revision, 3); assert.equal(app.store.task('original')!.sourceRevision, 1);
  f.b.events.lastSeq = 3; await f.save(); f.advance(); await app.loopMonitor.tick();
  assert.equal(f.channel.updates.length, 1); assert.match(f.channel.messages[0]!.text, /状态核实已恢复/); assert.equal(app.store.task('original')!.sourceRevision, 1);
});

for (const phase of ['first-send', 'existing-update']) test(`repair 2: ${phase} in flight coalesces the latest confirmation on the original message without blocking owner input`, async t => {
  const entered = gate(), release = gate(); t.after(() => release.open());
  const f = await nativeFixture(t); f.f.config.feishu.timeoutMs = 10000; const app = await f.start();
  if (phase === 'existing-update') await app.router.workers.messages.publish('original', 'seed');
  let active = 0, peak = 0, requests = 0;
  const originalSend = f.channel.sendCard.bind(f.channel), originalUpdate = f.channel.updateCard.bind(f.channel);
  if (phase === 'first-send') t.mock.method(f.channel, 'sendCard', async (card: MessageCard) => {
    active++; peak = Math.max(peak, active); requests++;
    try { if (requests === 1) { entered.open(); await release.promise; } return await originalSend(card); } finally { active--; }
  });
  else t.mock.method(f.channel, 'updateCard', async (id: string, card: MessageCard) => {
    active++; peak = Math.max(peak, active); requests++;
    try { if (requests === 1) { entered.open(); await release.promise; } await originalUpdate(id, card); } finally { active--; }
  });
  f.source.test.queryFailure = 'bad-receipt'; await f.save(); await app.loopMonitor.tick(); f.advance();
  const notice = app.loopMonitor.tick(); await entered.promise;
  delete f.source.test.queryFailure; f.b.tasks[0]!.active = false; f.b.tasks[0]!.reason = '构造等待本人决定'; f.b.events.lastSeq = 2; await f.save();
  await fetch(`${f.f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'worker_reply', arguments: { taskId: 'original', mode: 'resume', text: '继续', assessment: '原执行等待决定' } }] }, { text: 'done' }] }) });
  const owner = 'owner-confirmation'; app.receive({ id: owner, source: 'feishu', who: 'owner', chatType: 'p2p', messageId: owner, text: '原任务的续跑方案是什么', attachments: [], at: new Date().toISOString() });
  await until(() => app.store.row(owner)?.state === 'waiting', 3000);
  const opId = app.store.get<string>('worker:pending:original', ''); assert.ok(opId); assert.equal(app.router.workers.operation(opId)!.state, 'planned');
  assert.equal(app.store.get<any>('task-message:original', null).state, 'sending', 'healthy in-flight delivery is not uncertain');
  const current = app.store.task('original')!; current.notice += '\n同任务最新构造事实'; app.store.putTask(current);
  assert.equal(await app.loopMonitor.workers.messages.publish('original', 'newer-background-view'), undefined, 'queued publication does not claim a sent receipt');
  await fetch(`${f.f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ text: '本人的普通输入仍能完成' }] }) });
  app.receive({ id: 'owner-next', source: 'feishu', who: 'owner', chatType: 'p2p', messageId: 'next', text: '普通问候', attachments: [], at: new Date().toISOString() });
  await until(() => app.store.row('owner-next')?.state === 'done', 1000); assert.equal(requests, 1, 'no overlapping physical card request');
  release.open(); await notice;
  await until(() => f.channel.messages.some(m => m.card?.buttons.some(b => b.label === '好' && b.value.operation === opId)));
  const cards = f.channel.messages.filter(m => m.card); assert.equal(cards.length, 1); assert.equal(peak, 1);
  assert.ok(f.channel.updates.every(id => id === cards[0]!.id)); assert.match(cards[0]!.text, /同任务最新构造事实/);
  assert.equal(app.store.get<any>('task-message:original', null).state, 'sent'); assert.equal(app.store.row(owner)!.state, 'waiting');
  assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='delivery_uncertain'").get()!.n), 0);
  assert.ok((await f.calls()).every(c => c.verb === '查询'), 'confirmation is reachable but no control action ran');
});

test('repair 2: a publication between send completion and drain retirement retains the current confirmation projection', async t => {
  const h = await harness(t), workers = h.monitor.workers;
  const op = await workers.prepare('retiring-publication', 'worker_reply', { taskId: 'original', mode: 'resume', text: '继续' }); h.store.set('worker:pending:original', op.id);
  const set = h.store.set.bind(h.store); let queued = false;
  t.mock.method(h.store, 'set', (key: string, value: unknown) => {
    set(key, value);
    if (key === 'loop-monitor:publication:original' && value === null && !queued) {
      queued = true; const card = h.store.task('original')!; card.notice = '刚送达后的最新构造事实'; h.store.putTask(card);
      void workers.messages.publish('original', 'queued-at-retirement');
    }
  });
  await workers.messages.publish('original', 'confirmation', workers.view(op));
  await until(() => h.channel.updates.length > 0 && h.store.get<any>('task-message:original', null).state === 'sent');
  assert.equal(h.channel.messages.length, 1); assert.match(h.channel.messages[0]!.text, /刚送达后的最新构造事实/);
  assert.ok(h.channel.messages[0]!.card!.buttons.some(b => b.label === '好' && b.value.operation === op.id));
  assert.equal(h.store.get<any>('task-message:original', null).state, 'sent');
});

for (const outcome of ['acknowledged', 'unknown']) test(`repair round 2: Router in flight, queued monitor notice, stop and restart preserve the delivery boundary (${outcome})`, async t => {
  const entered = gate(), release = gate(); t.after(() => release.open());
  const f = await nativeFixture(t); f.f.config.feishu.timeoutMs = 10000; let app = await f.start();
  await app.router.workers.messages.publish('original', 'seed'); const id = f.channel.messages[0]!.id;
  const current = app.store.task('original')!; current.notice = 'Router 正在更新原卡'; app.store.putTask(current);
  const update = f.channel.updateCard.bind(f.channel); let requests = 0;
  t.mock.method(f.channel, 'updateCard', async (messageId: string, card: MessageCard) => {
    if (messageId !== id) { await update(messageId, card); return; }
    requests++;
    if (requests === 1) {
      entered.open(); await release.promise; await update(messageId, card);
      if (outcome === 'unknown') throw new Error('constructed lost acknowledgement AFTER a physical update');
    } else await update(messageId, card);
  });
  const router = app.router.workers.messages.publish('original', 'router-in-flight'); await entered.promise;
  f.source.test.queryFailure = 'bad-receipt'; await f.save(); await app.loopMonitor.tick(); f.advance(); await app.loopMonitor.tick();
  const pending = app.store.get<any>('loop-monitor:publication:original', null); assert.ok(pending); assert.match(pending.inputId, /^loop-monitor:/);
  assert.equal(requests, 1); assert.equal(app.store.get<any>('task-message:original', null).state, 'sending');
  const stopping = app.stop(); release.open(); await Promise.all([router, stopping]);
  const stopped = new Store(f.f.config);
  try {
    assert.equal(stopped.get<any>('task-message:original', null).state, outcome === 'acknowledged' ? 'sent' : 'uncertain');
    assert.equal(stopped.get<any>('loop-monitor:publication:original', null)?.version, pending.version, 'unsent notice remains durable, not cleared as uncertain');
    assert.equal(Number(stopped.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id GLOB 'task:original:*'").get()!.n), 2, 'only the original task seed and Router update claimed physical attempts');
    assert.equal(Number(stopped.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE input_id='loop-monitor:original'").get()!.n), 0, 'the cancelled original notice never claims a physical attempt');
    assert.equal(Number(stopped.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='delivery_uncertain'").get()!.n), outcome === 'acknowledged' ? 0 : 1);
  } finally { stopped.close(); }
  assert.equal(requests, 1);
  app = await f.start(); await until(() => app.store.get('loop-monitor:publication:original', 'pending') === null);
  assert.equal(requests, outcome === 'acknowledged' ? 2 : 1);
  if (outcome === 'acknowledged') assert.match(f.channel.messages[0]!.text, /状态待核实/);
  f.advance(); await app.loopMonitor.tick(); assert.equal(requests, outcome === 'acknowledged' ? 2 : 1, 'continuous failure stays deduplicated');
  delete f.source.test.queryFailure; await f.save(); f.advance(); await app.loopMonitor.tick();
  if (outcome === 'acknowledged') {
    assert.equal(requests, 3); assert.equal(app.store.get<any>('task-message:original', null).state, 'sent'); assert.match(f.channel.messages[0]!.text, /状态核实已恢复/);
  } else {
    assert.equal(requests, 1, 'genuinely unknown physical delivery is never retried'); assert.equal(app.store.get<any>('task-message:original', null).state, 'uncertain');
  }
  const originalCards = f.channel.messages.filter(message => message.card?.title.startsWith(`${current.title} ·`));
  assert.deepEqual(originalCards.map(message => message.id), [id], 'no duplicate card for the original execution');
  assert.equal(f.channel.updates.filter(value => value === id).length, outcome === 'acknowledged' ? 3 : 1);
  for (const message of f.channel.messages.filter(message => message.card && message.id !== id)) {
    assert.match(message.text, /任务 task-b/); assert.doesNotMatch(message.text, /原执行：original；/);
  }
  assert.equal(f.f.model.requests.length, 0); assert.ok((await f.calls()).every(c => c.verb === '查询'));
});

test('repair round 2: pre-admission cancellation leaves a known original message intact and recovers its unsent intent', async t => {
  const h = await harness(t), workers = h.monitor.workers; await workers.messages.publish('original', 'seed');
  const before = h.store.get<any>('task-message:original', null), caller = new AbortController(); caller.abort();
  const card = h.store.task('original')!; card.notice = '尚未发送的构造通知'; h.store.putTask(card);
  await workers.messages.publish('original', 'cancelled-before-admission', undefined, caller.signal);
  await h.monitor.stop(); assert.deepEqual(h.store.get<any>('task-message:original', null), before);
  assert.ok(h.store.get('loop-monitor:publication:original', null)); assert.equal(h.channel.updates.length, 0);
  assert.equal(Number(h.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n), 1);
  await h.restart(); h.monitor.start(error => { throw error; });
  await until(() => h.store.get('loop-monitor:publication:original', 'pending') === null);
  assert.equal(h.channel.sends, 1); assert.deepEqual(h.channel.updates, [before.id]); assert.match(h.channel.messages[0]!.text, /尚未发送的构造通知/);
  assert.equal(h.store.get<any>('task-message:original', null).state, 'sent');
});

test('repair round 2: admitted delivery owns its bounded I/O even when caller cancellation precedes the channel microtask', async t => {
  const h = await harness(t), workers = h.monitor.workers; await workers.messages.publish('original', 'seed');
  const card = h.store.task('original')!; card.notice = '已受理的构造更新'; h.store.putTask(card);
  const caller = new AbortController(); queueMicrotask(() => caller.abort(new Error('constructed caller cancellation')));
  await workers.messages.publish('original', 'admitted-before-cancellation', undefined, caller.signal);
  await until(() => h.channel.updates.length === 1 && h.store.get<any>('task-message:original', null).state === 'sent', 1000);
  assert.equal(h.channel.sends, 1); assert.match(h.channel.messages[0]!.text, /已受理的构造更新/);
  assert.equal(Number(h.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='delivery_uncertain'").get()!.n), 0);
});

test('repair round 2: admitted I/O stays bounded after caller cancellation and actual timeout remains uncertain without retry', async t => {
  const h = await harness(t), workers = h.monitor.workers; await workers.messages.publish('original', 'seed'); h.f.config.feishu.timeoutMs = 50;
  const card = h.store.task('original')!; card.notice = '构造在途更新超时'; h.store.putTask(card);
  const entered = gate(); let requests = 0;
  t.mock.method(h.channel, 'updateCard', async () => { requests++; entered.open(); await new Promise<void>(() => {}); });
  const caller = new AbortController(), publication = workers.messages.publish('original', 'admitted-timeout', undefined, caller.signal);
  await entered.promise; caller.abort(); assert.equal(await publication, undefined, 'cancelled waiter does not claim delivery');
  assert.equal(h.store.get<any>('task-message:original', null).state, 'sending', 'cancelling the waiter is not a delivery outcome');
  const at = Date.now(); await h.monitor.stop(); assert.ok(Date.now() - at < 1000);
  assert.equal(h.store.get<any>('task-message:original', null).state, 'uncertain'); assert.equal(requests, 1);
  await h.restart(); h.monitor.start(error => { throw error; }); await h.monitor.workers.messages.publish('original', 'after-real-timeout');
  assert.equal(requests, 1); assert.equal(h.store.get<any>('task-message:original', null).state, 'uncertain');
});

for (const outcome of ['acknowledged', 'unknown']) test(`repair round 3: empty stop queue joins a later Router confirmation after grace cancellation (${outcome})`, async t => {
  const producerEntered = gate(), releaseProducer = gate(), monitorStopped = gate(), sendEntered = gate(), releaseReceipt = gate(), producersFinished = gate();
  let stopping: Promise<void> | undefined;
  t.after(async () => { releaseProducer.open(); releaseReceipt.open(); await stopping?.catch(() => {}); });
  const f = await nativeFixture(t, true); f.f.config.queue.stopMs = 4000; f.f.config.queue.inputTimeoutMs = 15000; f.f.config.feishu.timeoutMs = 3000;
  const errors: unknown[] = []; let app = await f.start(error => errors.push(error));
  await fetch(`${f.f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'worker_reply', arguments: { taskId: 'original', mode: 'resume', text: '继续', assessment: '原执行等待本人决定' } }] }, { text: 'done' }] }) });
  let caller: AbortSignal | undefined, stopResolved = false, requests = 0;
  const process = app.router.process.bind(app.router), stopMonitor = app.loopMonitor.stop.bind(app.loopMonitor), detach = app.router.workers.pi.idle.bind(app.router.workers.pi), send = f.channel.sendCard.bind(f.channel);
  t.mock.method(app.router, 'process', async (row: QueueRow, signal: AbortSignal) => { caller = signal; producerEntered.open(); await releaseProducer.promise; return process(row, signal); });
  t.mock.method(app.loopMonitor, 'stop', async () => { await stopMonitor(); monitorStopped.open(); });
  t.mock.method(app.router.workers.pi, 'idle', async () => { await detach(); producersFinished.open(); });
  t.mock.method(f.channel, 'sendCard', async (card: MessageCard) => {
    requests++; const id = await send(card); sendEntered.open(); await releaseReceipt.promise;
    if (outcome === 'unknown') throw new Error('constructed acknowledgement lost AFTER physical delivery');
    return id;
  });
  const owner = 'owner-late-shutdown-confirmation';
  app.receive({ id: owner, source: 'feishu', who: 'owner', chatType: 'p2p', messageId: owner, text: '原任务的续跑方案是什么', attachments: [], at: new Date().toISOString() });
  await producerEntered.promise;
  assert.equal(app.store.get('task-message:original', null), null); assert.equal(app.store.get('loop-monitor:publication:original', null), null);
  const began = Date.now(); stopping = app.stop().then(() => { stopResolved = true; }); await monitorStopped.promise;
  releaseProducer.open(); await sendEntered.promise; await producersFinished.promise;
  // All existing producers have finished after the real shutdown grace aborted
  // Router's waiter; the physical response is still held at the local channel.
  assert.ok(caller?.aborted); await new Promise<void>(resolve => setImmediate(resolve));
  const openBeforeReceipt = app.store.db.isOpen, stoppedBeforeReceipt = stopResolved;
  releaseReceipt.open(); await app.loopMonitor.stop().catch(error => errors.push(error)); await stopping;
  assert.equal(openBeforeReceipt, true, 'Store must remain open for late admitted delivery');
  assert.equal(stoppedBeforeReceipt, false, 'shutdown must not finish before the channel acknowledgement');
  assert.ok(Date.now() - began < f.f.config.queue.stopMs, 'local response returns within the unchanged total shutdown budget');
  assert.equal(errors.length, 0); assert.equal(app.store.db.isOpen, false); assert.equal(requests, 1);
  const stopped = new Store(f.f.config); let opId = '';
  try {
    const message = stopped.get<any>('task-message:original', null); opId = stopped.get<string>('worker:pending:original', ''); assert.ok(opId);
    assert.equal(message.state, outcome === 'acknowledged' ? 'sent' : 'uncertain'); assert.equal(stopped.row(owner)!.state, 'waiting');
    const original = stopped.task('original')!; assert.equal(stopped.get('owner', 'not-released'), null);
    if (outcome === 'acknowledged') {
      assert.equal(message.id, f.channel.messages[0]!.id); assert.ok(original.subscriptions.some(s => s.kind === 'message' && s.value === message.id));
      assert.equal(stopped.replies(owner).length, 1); assert.equal(stopped.get('loop-monitor:publication:original', 'pending'), null);
    }
    assert.equal(Number(stopped.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='delivery_uncertain'").get()!.n), outcome === 'acknowledged' ? 0 : 1);
  } finally { stopped.close(); }
  app = await f.start(error => errors.push(error)); assert.equal(requests, 1);
  if (outcome === 'acknowledged') {
    const reject = f.channel.messages[0]!.card!.buttons.find(button => button.label === '不要' && button.value.operation === opId); assert.ok(reject);
    const callback = 'reject-late-confirmation'; app.receive({ id: callback, source: 'feishu', who: 'owner', chatType: 'p2p', quoteId: f.channel.messages[0]!.id, text: '', attachments: [], button: { value: reject.value }, at: new Date().toISOString() });
    await until(() => app.store.row(callback)?.state === 'done' && app.store.row(owner)?.state === 'done');
    assert.equal(app.router.workers.operation(opId)!.state, 'rejected'); assert.equal(app.store.get<any>('task-message:original', null).state, 'sent');
  } else {
    const current = app.store.task('original')!; current.notice = '未知送达后的构造新事实'; app.store.putTask(current); await app.router.workers.messages.publish('original', 'after-unknown-receipt');
    assert.equal(app.store.get<any>('task-message:original', null).state, 'uncertain'); assert.equal(app.router.workers.operation(opId)!.state, 'planned');
  }
  assert.equal(requests, 1); assert.equal(f.channel.sends, 1); assert.equal(errors.length, 0); assert.ok((await f.calls()).every(c => c.verb === '查询'));
});

for (const delivery of ['sent', 'sending']) test(`repair 2: persisted latest publication recovers only a known original delivery (${delivery})`, async t => {
  const h = await harness(t), workers = h.monitor.workers;
  const op = await workers.prepare('durable-confirmation', 'worker_reply', { taskId: 'original', mode: 'resume', text: '继续' }); h.store.set('worker:pending:original', op.id);
  if (delivery === 'sent') await workers.messages.publish('original', 'seed');
  else h.store.set('task-message:original', { state: 'sending', digest: 'interrupted-physical-request' });
  await h.monitor.stop(); // Simulate only the durable post-send/pre-drain crash window, not a live drain.
  h.store.set('loop-monitor:publication:original', { version: 'durable-latest-intent', inputId: 'durable-confirmation', approval: workers.view(op) });
  await h.restart(); h.monitor.start(error => { throw error; });
  await until(() => h.store.get('loop-monitor:publication:original', 'pending') === null);
  if (delivery === 'sent') {
    assert.equal(h.channel.sends, 1); assert.equal(h.channel.messages.length, 1);
    assert.ok(h.channel.messages[0]!.card!.buttons.some(b => b.label === '好' && b.value.operation === op.id));
  } else {
    assert.equal(h.channel.sends, 0); assert.equal(h.store.get<any>('task-message:original', null).state, 'uncertain');
  }
  assert.equal(h.monitor.workers.operation(op.id)!.state, 'planned');
});

test('A3/A9 source path: no events, original kernel task only, explicit native exit in the evidence round, no all-history query or control', async t => {
  const f = await nativeFixture(t), app = await f.start();
  const other = { ...app.store.task('original')!, id: 'other', title: '原任务乙', worker: { ...app.store.task('original')!.worker!, loop: { ...app.store.task('original')!.worker!.loop!, taskId: 'task-b' } } };
  app.store.putTask(other); await app.loopMonitor.tick(); assert.equal(f.channel.messages.length, 0);
  f.b.tasks[0]!.active = false; f.b.tasks[0]!.reason = '开发会话已退出（退出码 7），节点不再执行；恢复入口：原卡'; f.b.events.lastSeq++; await f.save();
  f.advance(); await app.loopMonitor.tick();
  assert.equal(f.channel.messages.length, 1); assert.match(f.channel.messages[0]!.text, /任务 task-a/); assert.match(f.channel.messages[0]!.text, /退出码 7/); assert.match(f.channel.messages[0]!.text, /修订 2/);
  assert.equal(app.store.task('original')!.worker!.loop!.taskId, 'task-a'); assert.equal(app.store.task('other')!.worker!.loop!.taskId, 'task-b');
  assert.notEqual(app.store.task('original')!.status, 'done'); assert.equal((app.store.task('original')!.verified!.layers as any).businessAcceptance, '未验证');
  assert.ok((await f.calls()).every(c => c.verb === '查询' && c.args[0] === f.b.batch.file && !c.args.includes('--all')));
  assert.equal(f.f.model.requests.length, 0, 'observer does not need a model turn');
});

test('A4 source path: consecutive real query subprocess failures, isolated App restart, and successful recovery update the same task message', async t => {
  const f = await nativeFixture(t); let app = await f.start(); await app.loopMonitor.tick(); const last = app.store.task('original')!.lastVerifiedAt;
  f.source.test.queryFailure = 'bad-receipt'; await f.save(); f.advance(); await app.loopMonitor.tick(); assert.equal(f.channel.messages.length, 0);
  f.advance(); await app.loopMonitor.tick(); assert.equal(f.channel.messages.length, 1); assert.match(f.channel.messages[0]!.text, /状态待核实/);
  assert.equal(app.store.task('original')!.lastVerifiedAt, last); assert.equal(app.store.task('original')!.sourceRevision, 1);
  await f.stop(); app = await f.start(); f.advance(); await app.loopMonitor.tick(); assert.equal(f.channel.messages.length, 1); assert.equal(f.channel.updates.length, 0);
  delete f.source.test.queryFailure; await f.save(); f.advance(); await app.loopMonitor.tick();
  assert.equal(f.channel.messages.length, 1); assert.deepEqual(f.channel.updates, [f.channel.messages[0]!.id]); assert.match(f.channel.messages[0]!.text, /状态核实已恢复/);
  assert.equal(app.store.task('original')!.sourceRevision, 1); assert.equal(f.f.model.requests.length, 0);
  assert.ok((await f.calls()).every(c => c.verb === '查询' && !c.args.includes('--all')));
});

for (const condition of ['missing-activity', 'unknown-identity', 'pid-reuse']) test(`A3: ${condition} is unverified progress, never execution/business failure`, async t => {
  const h = await harness(t), card = h.store.task('original')!;
  const binding = { protocol: 'kernel:1' as const, repository: '/fixture/git', runId: 'original-run', cardFile: card.worker!.batchFile, ledger: '/fixture/ledger.json', taskId: 'task-a' };
  card.worker!.loop = binding; card.lastVerifiedAt = '2026-11-07T11:00:00Z'; h.store.putTask(card);
  h.source(async () => ({ ...snapshot('等你决定'), loopBinding: binding, data: { kernel: { binding, project: h.f.project, revision: 1, state: '进行中', verifiedAt: new Date(h.clock).toISOString(), tasks: [{ id: 'task-a', state: '等你决定', active: false, waiting: false, reason: condition === 'missing-activity' ? '登记节点已不执行或身份无法确认' : '原 PID 不足以确认原进程', processIdentity: condition === 'missing-activity' ? '无活动' : '未确认' }] } } }));
  await h.monitor.tick(); h.advance(); await h.monitor.tick();
  assert.equal(h.channel.messages.length, 1); assert.match(h.channel.messages[0]!.text, /进展待核实/); assert.match(h.channel.messages[0]!.text, /不能判断原执行失败/);
  assert.notEqual(h.store.task('original')!.status, 'failed'); assert.notEqual(h.store.task('original')!.status, 'done');
});

test('source identity unknown preserves the previous verified snapshot, not just the task label', async t => {
  const f = await nativeFixture(t), app = await f.start(), previous = app.store.task('original')!;
  const unknown = structuredClone(f.initial); unknown.tasks[0].processIdentity = '未确认'; unknown.tasks[0].reason = '登记节点已不执行或身份无法确认';
  const source = join(await canonical(f.f.root), 'unknown.json'); await writeFile(source, JSON.stringify({ v: 1, batches: [unknown] }));
  f.f.config.loop.args = [resolve('scripts/loop-stub.mjs'), '--state', source];
  await app.loopMonitor.tick(); f.advance(); await app.loopMonitor.tick();
  const current = app.store.task('original')!;
  assert.equal(current.status, previous.status); assert.deepEqual(current.verified, previous.verified); assert.equal(current.lastVerifiedAt, previous.lastVerifiedAt);
  assert.equal(f.channel.messages.length, 1); assert.match(f.channel.messages[0]!.text, /进展待核实/);
});

test('original source query completing after cancellation cannot revive the task', async t => {
  const f = await nativeFixture(t), app = await f.start(); f.source.test.delay = { 查询: 80 }; await f.save();
  const work = app.loopMonitor.tick(); await until(async () => (await f.calls()).length > 0);
  const card = app.store.task('original')!; card.status = 'cancelled'; card.notice = '本人已取消'; app.store.putTask(card);
  await work; assert.equal(app.store.task(card.id)!.status, 'cancelled'); assert.equal(app.store.task(card.id)!.notice, '本人已取消'); assert.equal(f.channel.messages.length, 0);
});

test('App keeps owner input responsive during a hanging observation and stop aborts only its query before closing Store', async t => {
  const f = await nativeFixture(t), app = await f.start(); f.source.test.queryFailure = 'timeout'; await f.save();
  const work = app.loopMonitor.tick(); await until(async () => (await f.calls()).length >= 1);
  app.receive({ id: 'owner-during-observation', source: 'feishu', who: 'owner', chatType: 'p2p', messageId: 'owner-message', text: '普通问候，不是派工', attachments: [], at: new Date().toISOString() });
  await until(() => app.store.row('owner-during-observation')?.state === 'done', 1000);
  assert.equal(f.channel.messages.length, 1); assert.equal(notices(app.store), 0, 'observer does not occupy the owner input queue');
  const at = Date.now(); await app.stop(); await work; assert.ok(Date.now() - at < 1000);
  const store = new Store(f.f.config); assert.equal(notices(store), 0); assert.equal(store.task('original')!.worker!.loop!.runId, f.b.runId); store.close();
  assert.ok((await f.calls()).every(c => c.verb === '查询'));
});

test('App fatal background cleanup detaches the observer without inventing a Loop failure', async t => {
  const f = await nativeFixture(t); f.f.config.pi.pollMs = 20;
  const errors: unknown[] = [], app = await f.start(error => errors.push(error));
  f.source.test.queryFailure = 'timeout'; await f.save();
  const work = app.loopMonitor.tick(); await until(async () => (await f.calls()).length > 0);
  let thrown = false;
  app.router.workers.pi.poll = async () => { if (!thrown) { thrown = true; throw new Error('constructed background failure'); } };
  await until(() => errors.length === 1); await work; assert.equal(notices(app.store), 0);
  const before = (await f.calls()).length; f.advance(); await app.loopMonitor.tick(); assert.equal((await f.calls()).length, before);
  assert.equal(app.store.task('original')!.worker!.loop!.runId, f.b.runId);
});
