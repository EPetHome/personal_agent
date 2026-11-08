import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { processStarted } from '../src/loop-launch.js';
import { fixture, until } from './helpers.js';
import { canonical, hash } from '../src/util.js';
import { selectedLoopStopped, type DispatchCard } from '../src/dispatch-card.js';
import { LoopAdapter } from '../src/loop.js';
import type { Input, LoopBinding } from '../src/types.js';
import type { DispatchLaunch } from '../src/loop-launch.js';
import type { KernelFacts } from '../src/loop-kernel.js';
import type { WorkerAdapter, WorkerReceipt, WorkerRequest, WorkerSnapshot } from '../src/worker.js';

const args = { taskId: 'delegated', project: 'p', worker: 'loop', title: '构造开发委托', goal: '修改构造 README 标题', completion: '标题符合要求，分别说明技术检查及业务欠项', boundary: '只改 code/，不合入、不推送、不碰真实账号', prompt: '修改构造标题' };
const author = (id: string, text = ''): Input => ({ id, source: 'feishu', who: 'owner', chatType: 'p2p', messageId: id, at: new Date().toISOString(), text, attachments: [] });
const git = (root: string, ...a: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { stdio: 'pipe', encoding: 'utf8' }).trim();
// The local producer writes its formal index lazily. Publish fixture records in
// setup, just as a real executor does, BEFORE the product's source discovery.
const publishKernelFixture = (state: string, calls: string) => execFileSync(process.execPath,
  [resolve('scripts/loop-worker-stub.mjs'), '--state', state, '--calls', calls, '查询', '--all', '--json'], { env: { PATH: process.env.PATH }, stdio: 'pipe' });

async function cardFixture(t: TestContext, options: { receipt?: WorkerReceipt['status']; multi?: boolean } = {}) {
  const f = await fixture({ flow: [{ text: '构造脚本完成' }] }, { intake: { watch: false, fallbackMs: 60000 } }); t.after(() => f.close());
  const project = f.config.projects[0]!.root;
  await writeFile(join(project, 'result.txt'), 'PRESERVED-RESULT');
  git(project, 'init', '-b', 'dev'); git(project, 'add', '.'); git(project, 'commit', '-m', 'synthetic only');
  const binding: LoopBinding = { protocol: 'kernel:1', repository: join(project, '.git'), runId: 'original-run', cardFile: join(project, 'card.json'), ledger: join(f.config.projects[0]!.loopRunDirs[0]!, 'ledger.json'), taskId: options.multi ? 'a' : null };
  const task = (id: string) => ({ id, name: `任务 ${id}`, state: '进行中', node: '开发评审', reason: '构造事实', active: true, waiting: false, activityKind: 'developing', processIdentity: '存活', epoch: 0, integrated: false, release: {}, counters: {} });
  const facts: KernelFacts = { binding: { ...binding, taskId: null }, project, revision: 1, name: 'synthetic', state: '进行中', reason: '构造事实', node: '开发评审', tasks: options.multi ? [task('a'), task('b')] : [task('a')], candidate: null, checks: [], missing: [], publication: {}, acceptanceItems: [], results: [], release: {}, evidence: {}, verifiedAt: new Date().toISOString(), flow: ['开发评审', '验收'], executionEnded: false };
  let dispatches = 0, receipt = options.receipt ?? 'sent', stopUnknown = false, launch: DispatchLaunch;
  const stops: WorkerRequest[] = [];
  const snapshot = (selected: LoopBinding = binding): WorkerSnapshot => ({ state: facts.state, fingerprint: hash(JSON.stringify([facts, selected])), executable: true, active: true, loopBinding: { ...selected, runId: facts.binding.runId },
    data: { project, batch: { file: binding.cardFile, name: facts.name }, state: facts.state, stages: [], evidence: {}, kernel: structuredClone(facts) } });
  const ledger = async () => {
    const dir = dirname(binding.ledger);
    for (const item of facts.tasks) await mkdir(join(dir, 'tasks', item.id), { recursive: true });
    await writeFile(binding.ledger, JSON.stringify({ v: 1, id: facts.binding.runId, common: binding.repository, file: binding.cardFile, dir,
      revision: facts.revision, results: [], taskRecords: facts.tasks.map(t => ({ id: t.id, name: t.name, dir: join(dir, 'tasks', t.id), stopped: !t.active,
        ...(t.active ? { activity: { id: `attempt-${t.id}` } } : {}) })) }));
  };
  const adapter: WorkerAdapter = {
    kind: 'loop',
    async status(r) { if (r.action === 'dispatch') return { state: 'idle', fingerprint: 'idle', resources: [], data: {} }; await ledger(); return snapshot(r.loopBinding ?? binding); },
    async dispatch(r, bind) {
      dispatches++;
      launch = { operation: r.id, project, workspace: '', batchFile: binding.cardFile, name: 'synthetic', branch: '', specFile: join(f.root, 'synthetic.launch.json'), receiptFile: join(f.root, 'synthetic.receipt.json'), token: 'synthetic-private-launch-token', specHash: hash('synthetic'), protocol: 'kernel:1', repository: binding.repository };
      bind(binding.cardFile, launch);
      const s = snapshot(); s.dispatchProof = { operation: r.id, bindingHash: hash(JSON.stringify(launch)), evidence: { path: launch.receiptFile, sha256: hash('accepted') }, state: s.state, phase: 'accepted', terminal: false };
      return { status: receipt, reason: receipt === 'sent' ? '原执行者已核实接收' : receipt === 'blocked' ? '原执行者拒绝' : '原接收不确定，不重发', snapshot: s };
    },
    async stop(r) {
      const operation = app.router.workers.operation(r.id)!;
      assert.equal(operation.state, 'executing', 'stop effect is write-ahead');
      assert.ok(operation.cardStop); assert.equal(app.router.workers.dispatchCards.get(r.taskId)!.stopOperation, r.id);
      stops.push(r);
      if (!stopUnknown) { const selected = facts.tasks.find(t => t.id === r.loopBinding?.taskId)!; selected.active = false; selected.processIdentity = '无活动'; selected.state = '等你决定'; facts.revision++; facts.executionEnded = facts.tasks.every(t => !t.active); }
      return { status: 'sent', reason: '原停止请求已接收' };
    },
    async progress(e) { return e; }, async ask(e) { return e; }, async result() { return true; }, async reply() { return { status: 'blocked', reason: '本测试不续跑' }; },
  };
  await ledger();
  const app = await f.start(), workers = app.router.workers; workers.adapters.set('loop', adapter);
  const message = () => f.feishu.messages.find(m => m.key === `task-message:${args.taskId}`)!;
  const button = () => message().card!.buttons.find(b => b.label === '停止')!.value;
  const click = (id: string, value = button(), changes: Partial<Input> = {}) => workers.callback({ ...author(id), quoteId: message().id, button: { value }, ...changes });
  const delegate = async () => {
    const input = author('explicit-owner', '请在 p 项目修改构造 README 标题'); app.store.enqueue(input);
    const start = Date.now();
    const request = { ...args, instructionInput: input.id, instruction: input.text };
    const result = await workers.execute(input.id, 'worker_dispatch', request) as { status: string; delivery?: { status: string } };
    return { result, request, elapsed: Date.now() - start };
  };
  return { ...f, app, workers, adapter, facts, binding, message, button, click, delegate, snapshot, stops, dispatches: () => dispatches,
    unknownStop() { stopUnknown = true; }, setReceipt(value: WorkerReceipt['status']) { receipt = value; }, launch: () => launch };
}

/** Only the dispatch receipt is constructed. Every stop/status below runs the
 * real LoopAdapter and its actual local CLI/protocol, including the final read. */
async function actualControlFixture(t: TestContext) {
  const f = await fixture({ flow: [{ text: '只核对构造控制' }] }, { intake: { watch: false, fallbackMs: 60000 } }); t.after(() => f.close());
  const project = f.config.projects[0]!.root, root = await canonical(f.root), stateFile = join(root, 'loop.json'), callsFile = join(root, 'calls.jsonl'), file = join(project, 'card.json');
  await writeFile(file, JSON.stringify({ version: 1, flow: ['开发评审', '验收'], tasks: [{ name: '甲' }, { name: '乙' }] }));
  await writeFile(join(project, 'result.txt'), 'PRESERVED-RESULT');
  git(project, 'init', '-b', 'dev'); git(project, 'add', '.'); git(project, 'commit', '-m', 'synthetic control only');
  const batch: any = { kernel: true, runId: randomUUID(), project, batch: { name: '构造并行', file }, state: 'running', events: { lastSeq: 1 },
    tasks: [{ id: 'a', name: '甲', active: true }, { id: 'b', name: '乙', active: true }], results: [] };
  const state = { v: 1, batches: [batch], test: { root, project, workspace: project, run: f.config.projects[0]!.loopRunDirs[0] } as Record<string, unknown> };
  const save = async () => {
    await writeFile(stateFile, JSON.stringify(state));
    if (!state.test.queryFailure) publishKernelFixture(stateFile, callsFile);
  }; await save();
  f.config.loop.args = [resolve('scripts/loop-worker-stub.mjs'), '--state', stateFile, '--calls', callsFile];
  const app = await f.start(), workers = app.router.workers, adapter = workers.adapters.get('loop') as LoopAdapter;
  const sourceRequest: WorkerRequest = { ...args, id: 'control-source', action: 'stop', batchFile: file, stage: null, text: '', mode: 'resume', redLine: false, options: {}, lookupKernel: true, sourceTaskId: 'a' };
  const source = await adapter.status(sourceRequest), binding = source.loopBinding!;
  workers.adapters.set('loop', {
    kind: 'loop', async status(r, signal) { return r.action === 'dispatch' ? { state: 'idle', fingerprint: 'idle', resources: [], data: {} } : adapter.status(r, signal); },
    async dispatch(r, bind) {
      const launch: DispatchLaunch = { operation: r.id, project, workspace: '', batchFile: file, name: batch.batch.name, branch: '', specFile: join(root, 'synthetic.launch.json'), receiptFile: join(root, 'synthetic.receipt.json'), token: 'synthetic-receipt-token', specHash: hash('fixture'), protocol: 'kernel:1', repository: binding.repository };
      bind(file, launch);
      return { status: 'sent', reason: '构造原派工接收事实', snapshot: { ...source, dispatchProof: { operation: r.id, bindingHash: hash(JSON.stringify(launch)), evidence: { path: launch.receiptFile, sha256: hash('accepted') }, phase: 'accepted', terminal: false, state: source.state } } };
    },
    stop: (r, signal) => adapter.stop(r, signal), reply: (r, signal) => adapter.reply(r, signal),
    progress: e => adapter.progress(e), ask: e => adapter.ask(e), result: (e, s, signal) => adapter.result(e, s, signal),
  });
  const input = author('actual-control-owner', '请在 p 项目修改构造 README 标题'); app.store.enqueue(input);
  await workers.execute(input.id, 'worker_dispatch', { ...args, instructionInput: input.id, instruction: input.text });
  const message = () => f.feishu.messages.find(m => m.key === `task-message:${args.taskId}`)!;
  const button = () => message().card!.buttons.find(b => b.label === '停止')!.value;
  const click = (id: string, value = button(), signal?: AbortSignal) => workers.callback({ ...author(id), quoteId: message().id, button: { value } }, signal);
  const calls = async () => (await readFile(callsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(s => JSON.parse(s));
  return { ...f, app, workers, adapter, sourceRequest, binding, project, state, batch, save, calls, message, button, click };
}

test('A1: authenticated ordinary delegation immediately publishes a verified receipt and one precise stop, without a second approval', async t => {
  const f = await cardFixture(t), { result, request, elapsed } = await f.delegate();
  assert.equal(result.status, 'sent'); assert.equal(result.delivery?.status, 'sent'); assert.ok(elapsed < 10000);
  const message = f.message(); assert.match(message.card!.title, /已派出/);
  for (const text of [args.goal, args.completion, args.boundary, f.binding.runId, f.binding.cardFile, '原来源任务：a']) assert.ok(message.text.includes(text));
  assert.ok(!message.card!.buttons.some(b => b.label === '好')); assert.equal(f.config.approval.stop, true); assert.equal(f.config.approval.dispatch, true);
  assert.notEqual(f.button().token, f.workers.operation(f.button().operation!)!.token);
  await f.workers.execute('explicit-owner', 'worker_dispatch', request);
  await f.workers.recover(); assert.equal(f.dispatches(), 1); assert.equal(f.feishu.messages.length, 1); assert.equal(f.message().id, message.id);
});

for (const outcome of ['sent', 'uncertain'] as const) test(`A1 delivery: a void-returning publisher still reports the durable ${outcome} receipt`, async t => {
  const f = await cardFixture(t), publish = f.workers.messages.publish.bind(f.workers.messages); let publications = 0, sends = 0;
  const send = f.app.channel.sendCard!.bind(f.app.channel);
  f.app.channel.sendCard = async (...a) => { sends++; if (outcome === 'uncertain') throw new Error('synthetic delivery failure'); return send(...a); };
  f.workers.messages.publish = async (...a) => { publications++; await publish(...a); }; // A coordinator need not forward a return value.
  const { result, request } = await f.delegate();
  assert.equal(result.status, 'sent'); assert.equal(result.delivery?.status, outcome);
  const message = f.app.store.get<{ state: string; id?: string; digest: string }>(`task-message:${args.taskId}`, { state: '', digest: '' });
  const outbox = f.app.store.db.prepare('SELECT state,message_id FROM outbox WHERE id=?').get(`task:${args.taskId}:${message.digest}`)!;
  assert.equal(message.state, outcome); assert.equal(outbox.state, outcome);
  if (outcome === 'sent') assert.equal(outbox.message_id, f.message().id);
  await f.workers.execute('explicit-owner', 'worker_dispatch', request);
  assert.equal(publications, 1); assert.equal(sends, 1); assert.equal(f.dispatches(), 1);
});

for (const oldView of [false, true]) test(`A1 delivery: ${oldView ? 'a previously sent view' : 'an admitted intent'} without the dispatch publication is pending, never falsely sent`, async t => {
  const f = await cardFixture(t), publish = f.workers.messages.publish.bind(f.workers.messages);
  if (oldView) {
    const input = author('explicit-owner', '请在 p 项目修改构造 README 标题'); f.app.store.enqueue(input);
    await f.workers.prepare(input.id, 'worker_dispatch', { ...args, instructionInput: input.id, instruction: input.text });
    await publish(args.taskId, 'older-sent-view');
  }
  const priorMessage = f.app.store.get(`task-message:${args.taskId}`, null);
  f.workers.messages.publish = async () => {}; // Persisted operation, publication not yet admitted to I/O.
  const { result } = await f.delegate(); assert.equal(result.status, 'sent'); assert.equal(result.delivery?.status, 'pending');
  assert.equal(f.feishu.messages.length, oldView ? 1 : 0); assert.deepEqual(f.app.store.get(`task-message:${args.taskId}`, null), priorMessage);
  f.workers.messages.publish = publish; await publish(args.taskId, 'admit-original-card');
  assert.equal(f.workers.messages.delivery(args.taskId).status, 'sent'); assert.equal(f.feishu.messages.length, 1); assert.equal(f.dispatches(), 1);
});

test('A1 delivery: an in-flight older view cannot acknowledge the queued dispatched view', async t => {
  const f = await cardFixture(t); f.config.feishu.timeoutMs = 5000;
  const input = author('explicit-owner', '请在 p 项目修改构造 README 标题'); f.app.store.enqueue(input);
  await f.workers.prepare(input.id, 'worker_dispatch', { ...args, instructionInput: input.id, instruction: input.text });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const send = f.app.channel.sendCard!.bind(f.app.channel);
  f.app.channel.sendCard = async (...a) => { entered(); await gate; return send(...a); };
  const background = f.workers.messages.publish(args.taskId, 'older-background-view'); let execution: ReturnType<typeof f.delegate> | undefined;
  try {
    await started; const acceptedAt = Date.now(); execution = f.delegate();
    await until(() => !!f.workers.dispatchCards.get(args.taskId));
    const digest = hash(JSON.stringify(f.workers.messages.view(f.app.store.task(args.taskId)!)));
    assert.equal(f.workers.messages.delivery(args.taskId, digest).status, 'pending');
    release(); await background; await execution;
    await until(() => f.workers.messages.delivery(args.taskId, digest).status === 'sent');
    assert.ok(Date.now() - acceptedAt < 10000); assert.equal(f.feishu.messages.length, 1); assert.match(f.message().text, /已派出/); assert.ok(f.button());
    assert.equal(f.dispatches(), 1);
  } finally { release(); await Promise.allSettled([background, ...(execution ? [execution] : [])]); }
});

for (const status of ['blocked', 'uncertain'] as const) test(`A1: ${status} is never labelled dispatched or given a stop capability`, async t => {
  const f = await cardFixture(t, { receipt: status }); const { result, request } = await f.delegate();
  assert.equal(result.status, status); assert.equal(f.workers.dispatchCards.get(args.taskId), null);
  assert.ok(!f.message().text.includes('已派出')); assert.ok(!f.message().card!.buttons.some(b => b.label === '停止'));
  await f.workers.execute('explicit-owner', 'worker_dispatch', request); assert.equal(f.dispatches(), 1);
});

test('A1 safeguards: proactive proposal still waits, rejection/hold never dispatch or mint stop tokens', async t => {
  for (const choice of ['reject', 'hold']) {
    const f = await cardFixture(t); const input = author(`proposal-${choice}`, '看看有什么可以做的'); f.app.store.enqueue(input);
    await f.workers.suspend(input.id, [{ name: 'worker_dispatch', args }]);
    assert.equal(f.dispatches(), 0); assert.equal(f.workers.dispatchCards.get(args.taskId), null);
    const m = f.message(), button = m.card!.buttons.find(b => b.value.choice === choice)!;
    assert.ok(m.card!.buttons.some(b => b.label === '好')); await f.click('decline', button.value);
    assert.equal(f.dispatches(), 0); assert.ok(!m.text.includes('已派出'));
  }
});

test('A1 recovery: an outstanding ordinary control approval stays on the same card', async t => {
  const f = await cardFixture(t); await f.delegate();
  const input = author('ordinary-stop', '请停止原执行'); f.app.store.enqueue(input);
  await f.workers.suspend(input.id, [{ name: 'worker_stop', args: { taskId: args.taskId } }]);
  const approval = f.message().card!.buttons.find(b => b.label === '好')!.value;
  await f.workers.recover();
  assert.deepEqual(f.message().card!.buttons.find(b => b.label === '好')!.value, approval);
  assert.equal(f.stops.length, 0); assert.equal(f.config.approval.stop, true);
});

test('A1 recovery: changed task definition cannot be relabelled as the old accepted delegation', async t => {
  const f = await cardFixture(t); await f.delegate(); const value = f.button();
  const card = f.app.store.task(args.taskId)!; card.goal = '未经原派工接受的新目标'; f.app.store.putTask(card);
  await f.workers.recover();
  assert.equal(f.workers.dispatchCards.current(f.app.store.task(args.taskId)), undefined);
  await f.click('old-definition', value); assert.equal(f.stops.length, 0);
});

test('A1: an exited/rejected host invocation is not a dispatch acceptance, even if its lease can be reconciled', async t => {
  const f = await cardFixture(t), original = f.adapter.dispatch;
  f.adapter.dispatch = async (r, bind, signal) => {
    const receipt = await original(r, bind, signal); receipt.snapshot!.dispatchProof!.phase = 'exited';
    receipt.snapshot!.launchObservation = { ended: true, live: false, fingerprint: 'exited', description: '构造拒绝回执', kernelReceipt: { id: f.binding.runId, card: f.binding.cardFile, dispatched: false } };
    return receipt;
  };
  await f.delegate(); assert.equal(f.workers.dispatchCards.get(args.taskId), null);
  assert.ok(!f.message().text.includes('已派出')); assert.ok(!f.message().card!.buttons.some(b => b.label === '停止'));
});

test('A2: card callback stops only its original task once, preserving results and independent approval.stop', async t => {
  const f = await cardFixture(t, { multi: true }); await f.delegate(); const value = f.button();
  await Promise.all(Array.from({ length: 5 }, (_, n) => f.click(`stop-${n}`, value)));
  assert.equal(f.stops.length, 1); assert.equal(f.stops[0]!.loopBinding!.taskId, 'a'); assert.equal(f.stops[0]!.loopBinding!.runId, 'original-run');
  assert.equal(f.facts.tasks[1]!.active, true); assert.equal(await readFile(join(f.config.projects[0]!.root, 'result.txt'), 'utf8'), 'PRESERVED-RESULT');
  assert.equal(f.app.store.task(args.taskId)!.status, 'stopped'); assert.match(f.message().text, /核实停止，保留成果/);
  assert.ok(!f.message().card!.buttons.some(b => b.label === '好' || b.label === '停止'));
  await f.click('replayed', value); await f.workers.recover(); await f.click('replayed-after-recovery', value);
  assert.equal(f.stops.length, 1); assert.equal(f.config.approval.stop, true); assert.equal(f.model.requests.length, 0);
});

for (const residual of ['test', 'acceptance', 'cleanup', 'missing-cleanup', 'shared']) test(`R1/A2: cleared task activity with ${residual} consumers is uncertain and never stopped twice`, async t => {
  const f = await cardFixture(t, { multi: true }); await f.delegate(); const value = f.button();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const ended = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM'); await ended; });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const consumer = { pgid: child.pid!, started: await processStarted(child.pid!), token: randomUUID(), ownerPid: process.pid };
  const base = residual === 'shared' ? dirname(f.binding.ledger) : join(dirname(f.binding.ledger), 'tasks', 'a');
  const attempt = randomUUID(), dir = join(base, 'attempts', attempt); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'attempt.json'), JSON.stringify({ id: attempt, task: residual === 'shared' ? f.binding.runId : 'a',
    node: residual === 'acceptance' ? '验收' : '测试', candidate: { commit: hash('commit'), tree: hash('tree') }, inputs: hash('input'), started: new Date().toISOString(), epoch: 0 }));
  await writeFile(join(dir, 'test.procs.json'), JSON.stringify(['cleanup', 'missing-cleanup'].includes(residual) ? [] : [consumer]));
  if (residual !== 'missing-cleanup') await writeFile(join(dir, 'test.procs.json.cleanup'), JSON.stringify(residual === 'cleanup' ? [consumer] : []));
  await f.click('stop-with-consumer', value); assert.equal(f.stops.length, 1);
  assert.equal(f.facts.tasks[0]!.active, false); assert.equal(f.facts.tasks[1]!.active, true);
  assert.equal(f.app.store.task(args.taskId)!.status, 'uncertain'); assert.match(f.message().text, /停止结果不确定/);
  assert.equal(f.workers.operation(f.workers.dispatchCards.get(args.taskId)!.stopOperation!)!.state, 'uncertain');
  process.kill(child.pid!, 0); await f.click('repeat', value); await f.workers.recover(); await f.click('repeat-after-recovery', value);
  assert.equal(f.stops.length, 1); assert.equal(await readFile(join(f.config.projects[0]!.root, 'result.txt'), 'utf8'), 'PRESERVED-RESULT');
});

test('R1/A2: a released task with explicit empty interrupted-consumer records stops while its sibling stays active', async t => {
  const f = await cardFixture(t, { multi: true }); await f.delegate();
  const id = randomUUID(), dir = join(dirname(f.binding.ledger), 'tasks', 'a', 'attempts', id); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'attempt.json'), JSON.stringify({ id, task: 'a', node: '测试', candidate: { commit: hash('commit'), tree: hash('tree') }, inputs: hash('input'), started: new Date().toISOString(), epoch: 0 }));
  await writeFile(join(dir, 'test.procs.json'), '[]'); await writeFile(join(dir, 'test.procs.json.cleanup'), '[]');
  // This unrelated sibling's unfinished consumers must not gate task a.
  await writeFile(join(dirname(f.binding.ledger), 'tasks', 'b', 'review.procs.json'), '[{"pgid":999999,"started":"unverified sibling"}]');
  await f.click('stop-clean-task'); assert.equal(f.stops.length, 1); assert.equal(f.app.store.task(args.taskId)!.status, 'stopped'); assert.equal(f.facts.tasks[1]!.active, true);
});

test('A2: non-owner, non-P2P, cross-card, forged token/operation/target cannot stop anything', async t => {
  const f = await cardFixture(t, { multi: true }); await f.delegate(); const value = f.button();
  for (const change of [{ who: 'other' }, { chatType: 'group' }, { source: 'loop' as const }, { quoteId: 'other-card' }]) await f.click('invalid', value, change);
  for (const change of [{ token: 'forged' }, { task: 'other-task' }, { operation: 'other-dispatch' }] as Record<string, string>[]) await f.click('invalid-value', { ...value, ...change });
  assert.equal(f.stops.length, 0); assert.equal(f.workers.dispatchCards.get(args.taskId)!.stopOperation, undefined);
  await f.click('valid-with-untrusted-extra-target', { ...value, sourceTaskId: 'b', runId: 'forged-run' });
  assert.equal(f.stops.length, 1); assert.equal(f.stops[0]!.loopBinding!.taskId, 'a');
});

test('A2 legacy compatibility: a replaced session on the same batch cannot consume the original stop', async t => {
  const f = await cardFixture(t); let sessionId = 'original-session';
  const oldStatus = f.adapter.status, oldDispatch = f.adapter.dispatch;
  const snapshot = (): WorkerSnapshot => ({ state: 'running', fingerprint: sessionId, executable: true,
    data: { project: f.config.projects[0]!.root, batch: { file: f.binding.cardFile, name: 'synthetic' }, branch: 'feat/original', state: 'running', stages: [{ stage: '开发', state: 'running', session: { id: sessionId, host: 'pi', alive: true } }] } });
  f.adapter.status = async (r, signal) => r.action === 'dispatch' ? oldStatus(r, signal) : snapshot();
  f.adapter.dispatch = async (r, bind, signal) => {
    const receipt = await oldDispatch(r, bind, signal), launch = f.launch(); delete launch.protocol; launch.branch = 'feat/original';
    receipt.snapshot = { ...snapshot(), dispatchProof: { operation: r.id, bindingHash: hash(JSON.stringify(launch)), evidence: { path: launch.receiptFile, sha256: hash('legacy accepted') }, phase: 'accepted', terminal: false, state: 'running', acceptance: { stage: '开发', host: 'pi', sessionId, source: 'spawn-event', wrapper: { pid: 999999, started: 'synthetic identity only' } } } };
    return receipt;
  };
  await f.delegate(); const value = f.button(); assert.match(f.message().text, /原会话：pi\/original-session/);
  sessionId = 'replacement-session'; await f.click('old-legacy-session', value);
  assert.equal(f.stops.length, 0); assert.equal(f.workers.dispatchCards.get(args.taskId)!.stopOperation, undefined);
});

for (const sourceOnly of [false, true]) test(`A2: old-run token cannot stop a replacement ${sourceOnly ? 'source' : 'card'} execution`, async t => {
  const f = await cardFixture(t); await f.delegate(); const value = f.button();
  if (sourceOnly) f.facts.binding.runId = 'replacement-run';
  else { const card = f.app.store.task(args.taskId)!; card.worker!.loop!.runId = 'replacement-run'; f.app.store.putTask(card); }
  await f.click('old-run', value); assert.equal(f.stops.length, 0);
});

test('A2: an old task epoch cannot stop a later attempt in the same run', async t => {
  const f = await cardFixture(t); await f.delegate(); const value = f.button();
  f.facts.tasks[0]!.epoch++;
  await f.click('old-epoch', value); assert.equal(f.stops.length, 0);
});

test('A2: uncertain stop is explicit, remains consumed across restart, and blocks normal chat retries', async t => {
  const f = await cardFixture(t); await f.delegate(); const value = f.button(); f.unknownStop(); await f.click('unknown-stop', value);
  const record = f.workers.dispatchCards.get(args.taskId)!, op = f.workers.operation(record.stopOperation!)!;
  assert.equal(op.state, 'uncertain'); assert.match(f.message().text, /停止结果不确定，不重复停止/);
  await f.click('repeat', value); await f.workers.recover(); await f.click('after-recovery', value);
  await assert.rejects(f.workers.prepare('new-chat-stop', 'worker_stop', { taskId: args.taskId }), /不确定/);
  assert.equal(f.stops.length, 1); assert.equal(f.feishu.messages.length, 1);
});

for (const change of ['own-progress', 'sibling-progress']) test(`R2/A2: ${change} between callback queries does not invalidate the original stop instruction`, async t => {
  const f = await cardFixture(t, { multi: true }); await f.delegate();
  const original = f.adapter.status; let checks = 0;
  f.adapter.status = async r => {
    if (r.action === 'stop' && ++checks === 2) { f.facts.revision++; f.facts.tasks[change === 'own-progress' ? 0 : 1]!.reason = '普通进度修订'; }
    return original(r);
  };
  await f.click('progress-stop'); assert.equal(f.stops.length, 1); assert.equal(f.stops[0]!.loopBinding!.taskId, 'a');
  assert.equal(f.app.store.task(args.taskId)!.status, 'stopped'); assert.equal(f.facts.tasks[1]!.active, true);
});

for (const query of [1, 2]) test(`R2/A2: pre-effect query ${query} failure leaves a usable stop entry, with no automatic effect`, async t => {
  const f = await cardFixture(t); await f.delegate(); const old = f.button(), status = f.adapter.status; let checks = 0;
  f.adapter.status = async r => { if (r.action === 'stop' && ++checks === query) throw new Error('synthetic query failure'); return status(r); };
  await f.click('failed-query', old); assert.equal(f.stops.length, 0); assert.match(f.message().text, /未发送停止|未调用停止/);
  const fresh = f.button();
  if (query === 2) { assert.notEqual(fresh.token, old.token); await f.click('old-callback', old); assert.equal(f.stops.length, 0); }
  f.adapter.status = status; await f.workers.recover(); assert.equal(f.stops.length, 0); assert.deepEqual(f.button(), fresh);
  await f.click('new-owner-click', fresh); assert.equal(f.stops.length, 1); assert.equal(f.config.approval.stop, true);
});

test('R2/A2: adapter final read guard explicitly blocks without calling stop, then only a fresh click may retry', async t => {
  const f = await cardFixture(t); await f.delegate(); const old = f.button(), stop = f.adapter.stop; let calls = 0;
  f.adapter.stop = async r => ++calls === 1 ? { status: 'blocked', reason: '执行前进度修订变化，未执行控制' } : stop(r);
  await f.click('blocked-before-cli', old); assert.equal(f.stops.length, 0);
  const fresh = f.button(); assert.notEqual(fresh.token, old.token);
  await f.click('replay-old', old); await f.workers.recover(); assert.equal(f.stops.length, 0); assert.deepEqual(f.button(), fresh);
  await f.click('fresh-after-check', fresh); assert.equal(f.stops.length, 1); assert.equal(calls, 2);
});

for (const failure of ['throw', 'timeout', 'abort']) test(`R2.1 actual adapter: final read ${failure} is definitely no stop and rearms only a fresh click`, async t => {
  const f = await actualControlFixture(t), old = f.button(), status = f.adapter.status.bind(f.adapter), timeout = f.config.loop.timeoutMs;
  const controller = new AbortController(); let reads = 0, rejected = '';
  f.adapter.status = async (r, signal) => {
    if (r.action === 'stop' && ++reads === 3) {
      rejected = r.id; assert.equal(f.workers.operation(r.id)!.state, 'executing');
      if (failure === 'throw') throw new Error('synthetic final-read failure');
      if (failure === 'timeout') { f.state.test.queryFailure = 'timeout'; f.config.loop.timeoutMs = 350; await f.save(); }
      else controller.abort(new Error('synthetic final-read cancellation'));
    }
    return status(r, signal);
  };
  await f.click('final-read-failure', old, controller.signal);
  assert.equal(reads, 3); assert.equal((await f.calls()).filter(c => c.verb === '停止').length, 0);
  const operation = f.workers.operation(rejected)!; assert.equal(operation.state, 'blocked'); assert.equal(operation.stopNotCalled, true);
  assert.deepEqual(f.workers.journal.unresolved(args.taskId), []); assert.deepEqual(f.workers.journal.unresolvedExecution(f.binding), []);
  assert.match(f.message().text, /未调用停止命令/); const fresh = f.button(); assert.notEqual(fresh.token, old.token);
  delete f.state.test.queryFailure; f.config.loop.timeoutMs = timeout; await f.save(); f.adapter.status = status;
  await f.click('replay-old-final-read', old); await f.workers.recover(); assert.deepEqual(f.button(), fresh);
  assert.equal((await f.calls()).filter(c => c.verb === '停止').length, 0);
  await f.click('fresh-after-final-read', fresh);
  const stops = (await f.calls()).filter(c => c.verb === '停止'); assert.equal(stops.length, 1);
  assert.ok(stops[0].args.includes('--task')); assert.ok(stops[0].args.includes('甲'));
  assert.equal(f.app.store.task(args.taskId)!.status, 'stopped'); assert.equal(f.config.approval.stop, true);
  const current = JSON.parse(await readFile(join(f.root, 'loop.json'), 'utf8')); assert.equal(current.batches[0].tasks[1].active, true);
});

for (const failure of ['timeout', 'lost-receipt']) test(`R2.1 actual adapter: stop command ${failure} remains uncertain and cannot rearm`, async t => {
  const f = await actualControlFixture(t), old = f.button();
  if (failure === 'timeout') { f.state.test.hang = '停止'; f.config.loop.actionTimeoutMs = 350; }
  else f.state.test.unknown = '停止';
  await f.save(); await f.click('lost-stop-result', old);
  const record = f.workers.dispatchCards.get(args.taskId)!, operation = f.workers.operation(record.stopOperation!)!;
  assert.equal(operation.state, 'uncertain'); assert.notEqual(operation.stopNotCalled, true);
  assert.equal((await f.calls()).filter(c => c.verb === '停止').length, 1); assert.ok(!f.message().card!.buttons.some(b => b.label === '停止'));
  await f.click('replay-lost-stop', old); await f.workers.recover(); await f.click('replay-after-recovery', old);
  assert.equal((await f.calls()).filter(c => c.verb === '停止').length, 1);
  await assert.rejects(f.workers.prepare('cannot-chat-retry-unknown-stop', 'worker_stop', { taskId: args.taskId }), /不确定/);
});

test('R2 recovery: an approved click interrupted before execution claim is rearmed, never replayed', async t => {
  const f = await cardFixture(t); await f.delegate(); const old = f.button(), status = f.adapter.status; let checks = 0;
  let savedRecord: ReturnType<typeof f.workers.dispatchCards.get> = null, savedOperation: ReturnType<typeof f.workers.operation> = null;
  f.adapter.status = async r => {
    if (r.action === 'stop' && ++checks === 2) {
      savedRecord = f.workers.dispatchCards.get(args.taskId); savedOperation = f.workers.operation(savedRecord!.stopOperation!);
      throw new Error('freeze approved crash window');
    }
    return status(r);
  };
  await f.click('interrupted-before-claim', old); assert.equal(savedOperation!.state, 'approved');
  f.app.store.set(`worker:op:${savedOperation!.id}`, savedOperation); f.app.store.set(`worker:dispatch-card:${args.taskId}`, savedRecord); f.adapter.status = status;
  await f.workers.recover(); assert.equal(f.workers.operation(savedOperation!.id)!.state, 'stale'); assert.equal(f.stops.length, 0);
  const fresh = f.button(); assert.notEqual(fresh.token, old.token); await f.click('old-after-recovery', old); assert.equal(f.stops.length, 0);
  await f.click('new-click-after-recovery', fresh); assert.equal(f.stops.length, 1);
});

test('R2 recovery: an executing claim is ambiguous and never rearms or replays the stop', async t => {
  const f = await cardFixture(t); await f.delegate(); const old = f.button();
  let claimed: ReturnType<typeof f.workers.operation> = null;
  f.adapter.stop = async r => { claimed = f.workers.operation(r.id); throw new Error('stop invocation outcome lost'); };
  await f.click('effect-window', old); assert.equal(claimed!.state, 'executing');
  f.app.store.set(`worker:op:${claimed!.id}`, claimed); await f.workers.recover();
  assert.equal(f.workers.operation(claimed!.id)!.state, 'uncertain'); assert.equal(f.workers.dispatchCards.get(args.taskId)!.stopOperation, claimed!.id);
  assert.ok(!f.message().card!.buttons.some(b => b.label === '停止')); await f.click('repeat-ambiguous', old); assert.equal(f.stops.length, 0);
  assert.match(f.message().text, /停止结果不确定/);
});

test('A1 recovery: sent operation without its first publication is restored once from the same receipt', async t => {
  const f = await cardFixture(t); const publish = f.workers.messages.publish.bind(f.workers.messages);
  f.workers.messages.publish = async () => undefined; await f.delegate();
  f.app.store.db.prepare('DELETE FROM kv WHERE key=?').run(`worker:dispatch-card:${args.taskId}`);
  assert.equal(f.feishu.messages.length, 0); f.workers.messages.publish = publish;
  await f.workers.recover(); await f.workers.recover();
  assert.match(f.message().text, /已派出/); assert.ok(f.button()); assert.equal(f.dispatches(), 1); assert.equal(f.feishu.messages.length, 1);
});

for (const historyWritten of [false, true]) test(`A1 recovery: receipt committed before ${historyWritten ? 'kernel enrichment' : 'task presentation'} is completed without a second execution`, async t => {
  const f = await cardFixture(t), publish = f.workers.messages.publish.bind(f.workers.messages);
  f.workers.messages.publish = async () => undefined; await f.delegate();
  const card = f.app.store.task(args.taskId)!;
  card.status = historyWritten ? 'resume-requested' : 'waiting-approval'; card.waiting = historyWritten ? '' : '本次操作等你点头'; card.sourceRevision = undefined; card.verified = undefined; delete card.worker!.loop;
  if (!historyWritten) card.dispatches = [];
  f.app.store.putTask(card); f.app.store.db.prepare('DELETE FROM kv WHERE key=?').run(`worker:dispatch-card:${args.taskId}`);
  f.workers.messages.publish = publish; await f.workers.recover();
  assert.equal(f.app.store.task(args.taskId)!.status, '进行中'); assert.equal(f.app.store.task(args.taskId)!.waiting, '');
  assert.match(f.message().text, /已派出/); assert.ok(!f.message().text.includes('等你点头')); assert.ok(f.button());
  await f.workers.recover(); assert.equal(f.dispatches(), 1); assert.equal(f.feishu.messages.length, 1);
});

for (const crashed of [false, true]) test(`A1 transport: ${crashed ? 'interrupted send' : 'delivery failure'} never becomes dispatch failure or triggers a blind resend`, async t => {
  const f = await cardFixture(t);
  if (crashed) f.workers.messages.publish = async () => { f.app.store.set(`task-message:${args.taskId}`, { state: 'sending', digest: 'interrupted-send' }); return undefined; };
  else f.app.channel.sendCard = async () => { throw new Error('synthetic transport uncertainty'); };
  const { result, request } = await f.delegate(); assert.equal(result.status, 'sent');
  if (!crashed) assert.equal(result.delivery?.status, 'uncertain');
  // New message owner simulates a restarted transport with an empty in-flight map.
  const { TaskMessages } = await import('../src/cards.js');
  const messages = new TaskMessages(f.app.store, f.app.channel);
  await messages.publish(args.taskId, 'recovery');
  assert.equal(messages.delivery(args.taskId).status, 'uncertain');
  await f.workers.execute('explicit-owner', 'worker_dispatch', request);
  assert.equal(f.dispatches(), 1); assert.equal(f.feishu.messages.length, 0);
  const record = f.workers.dispatchCards.get(args.taskId)!;
  await f.workers.callback({ ...author('forged-undelivered'), quoteId: 'not-delivered', button: { value: { pa: 'dispatch-stop', task: args.taskId, operation: record.operation, token: record.token } } });
  assert.equal(f.stops.length, 0);
});

test('A1 transport: concurrent receipt publications serialize onto the same message', async t => {
  const f = await cardFixture(t); await f.delegate(); const id = f.message().id;
  const card = f.app.store.task(args.taskId)!; card.notice = '构造新事实'; f.app.store.putTask(card);
  await Promise.all(Array.from({ length: 8 }, (_, n) => f.workers.messages.publish(args.taskId, `parallel-${n}`)));
  assert.equal(f.feishu.messages.length, 1); assert.equal(f.message().id, id); assert.equal(f.message().updates!.length, 1);
});

test('A1/A2 message entry: dispatch and card stop are program-owned, callback never asks the model for permission again', async t => {
  const f = await cardFixture(t, { multi: true }), text = '请在 p 项目修改构造 README 标题';
  const request = { ...args, instructionInput: 'feishu:entry-owner', instruction: text };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'worker_dispatch', arguments: request }] }, { text: '完成构造入口' }] }) });
  await f.inject({ id: 'entry-owner', text }); await f.inject({ id: 'entry-owner', text });
  await until(() => f.app.store.row('feishu:entry-owner')?.state === 'done');
  assert.match(f.message().text, /已派出/); const requests = f.model.requests.length, value = f.button();
  await f.inject({ id: 'entry-stop', quoteId: f.message().id, button: { value } });
  await until(() => f.app.store.row('feishu:entry-stop')?.state === 'done');
  await f.inject({ id: 'entry-stop-replay', quoteId: f.message().id, button: { value } });
  await until(() => f.app.store.row('feishu:entry-stop-replay')?.state === 'done');
  assert.equal(f.stops.length, 1); assert.equal(f.dispatches(), 1); assert.equal(f.model.requests.length, requests);
  assert.equal(f.feishu.messages.length, 1); assert.ok(!f.message().card!.buttons.some(b => b.label === '好'));
});

test('A1/A2 actual Pi path: original job receipt and one stop retain identity and results through recovery', async t => {
  const f = await fixture({ flow: [{ text: '只处理构造输入' }] });
  const control = join(f.root, 'control.json'), calls = join(f.root, 'pi-calls.jsonl'); await writeFile(control, '{"hang":true}');
  f.config.pi.command = process.execPath; f.config.pi.args = [resolve('scripts/pi-worker-stub.mjs'), '--control', control, '--calls', calls]; f.config.pi.pollMs = 50;
  let app = await f.start(), jobId = '';
  t.after(async () => {
    if (jobId) { const job = app.router.workers.pi.job(jobId); if (job && !job.outcome) { await app.router.workers.pi.stop({ ...job.request, batchFile: jobId }); await until(async () => { await app.router.workers.pi.tick(); return !!app.router.workers.pi.job(jobId)?.outcome; }); } }
    await f.close();
  });
  const input = author('pi-owner', '请读取构造文本并报告来源'); app.store.enqueue(input);
  const request = { ...args, worker: 'pi', options: '{"type":"read"}', instructionInput: input.id, instruction: input.text };
  await app.router.workers.execute(input.id, 'worker_dispatch', request);
  const card = app.store.task(args.taskId)!, message = f.feishu.messages[0]!; jobId = card.worker!.batchFile;
  assert.match(message.text, /已派出/); const value = message.card!.buttons.find(b => b.label === '停止')!.value;
  await until(async () => (await readFile(calls, 'utf8').catch(() => '')).includes('"event":"start"'));
  await f.stop(); app = await f.start();
  const stop = () => app.router.workers.callback({ ...author('pi-stop'), quoteId: message.id, button: { value } });
  await stop(); await stop();
  await until(() => app.store.task(args.taskId)!.status === 'stopped');
  assert.equal(app.router.workers.dispatchCards.get(args.taskId)!.operation, value.operation);
  assert.equal(app.router.workers.pi.job(jobId)!.stopRequested, true);
  assert.equal(app.store.task(args.taskId)!.worker!.batchFile, jobId);
  const logged = (await readFile(calls, 'utf8')).split('\n').filter(Boolean).map(s => JSON.parse(s));
  assert.equal(logged.filter(c => c.event === 'start').length, 1); assert.equal(f.feishu.messages.length, 1); assert.equal(f.feishu.messages[0]!.id, message.id);
});

async function completedControlAttempt(f: Awaited<ReturnType<typeof actualControlFixture>>, scope: 'own' | 'shared', variant = 'valid') {
  const task = scope === 'own' ? 'a' : f.binding.runId, base = scope === 'own' ? join(dirname(f.binding.ledger), 'tasks', 'a') : dirname(f.binding.ledger);
  const id = randomUUID(), dir = join(base, 'attempts', id), path = join(dir, 'attempt.json'); await mkdir(dir, { recursive: true });
  const candidate = { commit: git(f.project, 'rev-parse', 'HEAD'), tree: git(f.project, 'rev-parse', 'HEAD^{tree}') };
  const node = scope === 'own' ? '测试' : '验收', inputs = hash('completed-inputs'), started = new Date().toISOString();
  const request = { id, task, node, candidate, inputs, started, epoch: variant === 'invalid-attempt-epoch' ? -1 : 0 };
  // Actual NodeResult (node-ledger.ts): it deliberately has NO epoch field.
  // Do not spread attempt.json here or add a field the producer never writes.
  const result: any = { id, task, node, candidate, inputs, started, ended: new Date().toISOString(), status: '通过', evidence: [path], operations: [], released: true };
  if (variant === 'changed-input') result.inputs = hash('other-inputs');
  if (variant === 'changed-candidate') result.candidate = { ...candidate, tree: hash('other-tree') };
  if (variant === 'missing-ended') delete result.ended;
  await writeFile(path, JSON.stringify(request)); await writeFile(join(dir, 'test.procs.json'), '[]');
  await writeFile(join(dir, 'test.procs.json.cleanup'), variant === 'residual-cleanup' ? '[{"pgid":999999,"started":"unverified cleanup","token":"synthetic"}]' : '[]');
  f.batch.results = [result]; f.batch.events.lastSeq++; await f.save();
  assert.equal(Object.hasOwn(request, 'epoch'), true); assert.equal(Object.hasOwn(result, 'epoch'), false);
  return { request, result };
}

for (const scope of ['own', 'shared'] as const) test(`R2.2 actual protocol: ${scope} completed result without epoch confirms stopped with a live sibling`, async t => {
  const f = await actualControlFixture(t); await completedControlAttempt(f, scope); await f.click('stop-with-completed-result');
  assert.equal(f.app.store.task(args.taskId)!.status, 'stopped'); assert.match(f.message().text, /已按卡上原执行身份核实停止/);
  assert.deepEqual(f.workers.journal.unresolved(args.taskId), []); assert.equal((await f.calls()).filter(c => c.verb === '停止').length, 1);
  const raw = JSON.parse(await readFile(f.binding.ledger, 'utf8')), current = JSON.parse(await readFile(join(f.root, 'loop.json'), 'utf8'));
  assert.equal(Object.hasOwn(raw.results[0], 'epoch'), false); assert.equal(current.batches[0].tasks[1].active, true);
  assert.equal(await readFile(join(f.project, 'result.txt'), 'utf8'), 'PRESERVED-RESULT');
});

for (const variant of ['changed-input', 'changed-candidate', 'missing-ended', 'invalid-attempt-epoch', 'residual-cleanup']) test(`R2.2 actual protocol: ${variant} still prevents a stopped claim`, async t => {
  const f = await actualControlFixture(t); await completedControlAttempt(f, 'own', variant); const old = f.button();
  await f.click('stop-with-insufficient-proof', old);
  assert.equal(f.app.store.task(args.taskId)!.status, 'uncertain'); assert.match(f.message().text, /停止结果不确定/);
  const record = f.workers.dispatchCards.get(args.taskId)!, operation = f.workers.operation(record.stopOperation!)!;
  assert.equal(operation.state, 'uncertain'); assert.notEqual(operation.stopNotCalled, true);
  await f.click('no-retry-of-unknown-stop', old); assert.equal((await f.calls()).filter(c => c.verb === '停止').length, 1);
});

for (const residual of ['cleared', 'cleanup', 'missing-cleanup', 'own-process']) test(`R1 actual kernel protocol: ${residual} selected-task proof is independent of a live sibling`, async t => {
  const f = await fixture({ flow: [{ text: '只核对构造协议' }] }, { intake: { watch: false, fallbackMs: 60000 } }); t.after(() => f.close());
  const project = f.config.projects[0]!.root, root = await canonical(f.root), stateFile = join(root, 'loop.json'), file = join(project, 'card.json');
  await writeFile(file, JSON.stringify({ version: 1, flow: ['开发评审', '验收'], tasks: [{ name: '甲' }, { name: '乙' }] }));
  git(project, 'init', '-b', 'dev'); git(project, 'add', '.'); git(project, 'commit', '-m', 'synthetic protocol only');
  const consumer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const closed = new Promise<void>(resolve => consumer.once('close', () => resolve()));
  t.after(async () => { if (consumer.exitCode === null && !consumer.signalCode) consumer.kill('SIGTERM'); await closed; });
  await new Promise<void>((resolve, reject) => { consumer.once('spawn', resolve); consumer.once('error', reject); });
  const owned = { pid: consumer.pid!, processStarted: await processStarted(consumer.pid!), token: randomUUID() };
  const state = { v: 1, batches: [{ kernel: true, runId: randomUUID(), project, batch: { name: '构造并行', file }, state: 'running', events: { lastSeq: 2 },
    tasks: [{ id: 'task-a', name: '甲', active: false, ...(residual === 'own-process' ? { worker: owned } : {}) }, { id: 'task-b', name: '乙', active: true }] }],
    test: { root, project, workspace: project, run: f.config.projects[0]!.loopRunDirs[0] } };
  await writeFile(stateFile, JSON.stringify(state)); f.config.loop.args = [resolve('scripts/loop-worker-stub.mjs'), '--state', stateFile, '--calls', join(root, 'calls.jsonl')];
  publishKernelFixture(stateFile, join(root, 'calls.jsonl'));
  const app = await f.start(), adapter = app.router.workers.adapters.get('loop')!;
  const request: WorkerRequest = { ...args, id: 'scoped-read', action: 'stop', project: 'p', batchFile: file, stage: null, text: '', mode: 'resume', redLine: false, options: {}, lookupKernel: true, sourceTaskId: 'task-a' };
  let snapshot = await adapter.status(request); const binding = snapshot.loopBinding!;
  const dir = join(dirname(binding.ledger), 'tasks', 'task-a', 'attempts', randomUUID()); await mkdir(dir, { recursive: true });
  const id = dir.split('/').at(-1)!;
  await writeFile(join(dir, 'attempt.json'), JSON.stringify({ id, task: 'task-a', node: '验收', candidate: { commit: git(project, 'rev-parse', 'HEAD'), tree: git(project, 'rev-parse', 'HEAD^{tree}') }, inputs: hash('inputs'), started: new Date().toISOString(), epoch: 0 }));
  await writeFile(join(dir, 'test.procs.json'), '[]');
  if (residual !== 'missing-cleanup') await writeFile(join(dir, 'test.procs.json.cleanup'), JSON.stringify(residual === 'cleanup' ? [{ pgid: consumer.pid, started: owned.processStarted, token: owned.token, ownerPid: process.pid }] : []));
  snapshot = await adapter.status({ ...request, loopBinding: binding });
  const record: DispatchCard = { task: args.taskId, operation: 'synthetic-dispatch', token: 'synthetic-token', owner: 'synthetic-owner', acceptedAt: new Date().toISOString(), target: { worker: 'loop', project, batchFile: file, loop: binding } };
  assert.equal(snapshot.resourceReleased, false); assert.equal((snapshot.data as any).kernel.tasks[1].active, true);
  assert.equal(await selectedLoopStopped(f.config, app.router.files, record, snapshot), residual === 'cleared');
  process.kill(consumer.pid!, 0);
});

test('A1 actual Loop path: delayed acceptance is published by reconciliation, survives process recovery, and never starts a second execution', async t => {
  const f = await fixture({ flow: [{ text: '只处理构造事实' }] });
  const ready = join(f.root, 'ready'), exit = join(f.root, 'exit');
  t.after(async () => { await writeFile(ready, 'cleanup'); await writeFile(exit, 'cleanup'); await f.close(); });
  const p = f.config.projects[0]!, project = p.root, callsFile = join(f.root, 'calls.jsonl'), stateFile = join(f.root, 'loop.json');
  await mkdir(join(project, 'code')); await writeFile(join(project, 'code/README.md'), 'synthetic');
  await writeFile(join(project, '.gitignore'), '.autoreview.json\n'); await writeFile(join(project, '.autoreview.json'), '{"acceptance":{}}');
  git(project, 'init', '-b', 'dev'); git(project, 'add', '.'); git(project, 'commit', '-m', 'synthetic only');
  p.loop = { batchDir: join(project, 'docs/batches'), allow: ['code/'], deny: [] };
  await writeFile(stateFile, JSON.stringify({ v: 1, batches: [], test: { root: f.root, project, workspace: project, run: p.loopRunDirs[0], livePauseReady: ready, livePauseExit: exit } }));
  f.config.loop.args = [resolve('scripts/loop-worker-stub.mjs'), '--state', stateFile, '--calls', callsFile];
  let app = await f.start(); const input = author('real-adapter-owner', '请在 p 项目修改构造 README 标题'); app.store.enqueue(input);
  const request = { ...args, instructionInput: input.id, instruction: input.text };
  await app.router.workers.execute(input.id, 'worker_dispatch', request);
  await writeFile(ready, 'start constructed consumer');
  const acceptedAfter = Date.now();
  await until(async () => { await app.router.workers.status(args.taskId); return !!app.router.workers.dispatchCards.get(args.taskId); });
  assert.ok(Date.now() - acceptedAfter < 10000);
  const message = f.feishu.messages.find(m => m.key === `task-message:${args.taskId}`)!;
  assert.match(message.text, /已派出/); assert.ok(message.card!.buttons.some(b => b.label === '停止')); assert.ok(!message.card!.buttons.some(b => b.label === '好'));
  const calls = async () => (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean).map(s => JSON.parse(s));
  await f.stop(); app = await f.start(); await app.router.workers.execute(input.id, 'worker_dispatch', request);
  assert.equal((await calls()).filter(c => c.verb === '启动').length, 1); assert.equal(f.feishu.messages.length, 1);
  assert.equal(f.feishu.messages[0]!.id, message.id);
});
