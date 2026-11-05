import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, until } from './helpers.js';
import { canonical, sleep } from '../src/util.js';
import type { Script } from '../src/stubs/servers.js';
import { App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeChannel, type MessageCard } from '../src/channel.js';
import { sdkStub } from './sdk-stub.js';
import type { WorkerAdapter, WorkerRequest } from '../src/worker.js';
import { observeLaunch } from '../src/loop-launch.js';
import { DISPATCH_MANUAL_ACK } from '../src/worker-journal.js';
import type { TaskCard } from '../src/types.js';

const dispatchArgs = { taskId: 'readme', project: 'p', worker: 'loop', title: '改 README 标题', goal: '将 code/README.md 标题改成 Hello', completion: '标题为 Hello、门禁过、评审无必修、提交批次分支', boundary: '只改 code/，不合入、不推送、不碰真实账号', prompt: '把 code/README.md 标题改成 Hello' };
const dispatchFlow: Script = { flow: [{ tools: [{ name: 'worker_dispatch', arguments: dispatchArgs }] }, { text: 'done' }] };
const replyFlow = [{ tools: [{ name: 'worker_reply', arguments: { taskId: '{{taskId}}', mode: 'resume', text: '再给它一轮', assessment: '构造环境问题，建议恢复' } }] }, { text: 'done' }];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=PA Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function workerFixture(script: Script = dispatchFlow) {
  const f = await fixture(script), root = await canonical(f.root), project = f.config.projects[0]!.root, workspace = join(root, 'workspace');
  await mkdir(join(project, 'code')); await writeFile(join(project, 'code/README.md'), '# Test\n');
  await writeFile(join(project, '.autoreview.json'), JSON.stringify({ workspaces: { dev: workspace } }));
  git(project, 'init', '-b', 'main'); git(project, 'add', '.'); git(project, 'commit', '-m', 'synthetic baseline'); git(project, 'worktree', 'add', '--detach', workspace);
  const batchDir = join(project, 'docs/batches'); await mkdir(batchDir, { recursive: true });
  f.config.projects[0]!.loop = { batchDir, workspace, workspaceName: 'dev', allow: ['code/'], deny: ['code/private/'] };
  const snapshot = join(f.root, 'loop.json'), callsFile = join(f.root, 'loop-calls.jsonl');
  const state = { v: 1, at: new Date().toISOString(), batches: [] as any[], test: { root: f.root, project, workspace } as Record<string, unknown> };
  const save = () => writeFile(snapshot, JSON.stringify(state)); await save();
  f.config.loop.args = [resolve('scripts/loop-worker-stub.mjs'), '--state', snapshot, '--calls', callsFile];
  const calls = async () => (await readFile(callsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(s => JSON.parse(s));
  const readState = async () => JSON.parse(await readFile(snapshot, 'utf8'));
  const writeState = async (value: unknown) => { await writeFile(snapshot, JSON.stringify(value)); };
  const event = async (id: string, status: string, batchFile: string, detail: Record<string, unknown> = {}, evidence: Record<string, string> = {}, stage: string | null = null, meta: { seq?: number; at?: string } = {}) => {
    const seq = meta.seq ?? (await readState()).batches.find((b: any) => b.batch.file === batchFile)?.events?.lastSeq ?? 1;
    await appendFile(join(f.events, 'events.jsonl'), JSON.stringify({ v: 1, id, seq, project, batch: { file: batchFile, name: 'synthetic' }, at: meta.at ?? new Date().toISOString(), status, stage, reason: { text: '构造事件原因' }, detail, evidence }) + '\n');
  };
  const seed = async (status = 'paused', next = 'resume') => {
    const batchFile = join(project, 'docs/batches/seed/批次.json');
    state.batches.push({ project, batch: { file: batchFile, name: '构造批次' }, state: status, next, stages: [], evidence: {}, events: { lastSeq: 1 } }); await save();
    return batchFile;
  };
  const click = async (id: string, value: Record<string, string>, messageId?: string) => f.inject({ id, quoteId: messageId ?? f.feishu.messages[0]!.id, button: { value } });
  const waitApproval = async (app: App) => until(() => !!app.store.db.prepare("SELECT 1 FROM inputs WHERE state='waiting'").get() && !!f.feishu.messages[0]?.card?.buttons.some(b => b.label === '好'));
  const approveValue = () => f.feishu.messages[0]!.card!.buttons.find(b => b.label === '好')!.value;
  return { ...f, project, workspace, state, snapshot, save, calls, readState, writeState, event, seed, click, waitApproval, approveValue };
}

async function pairedTasks(f: Awaited<ReturnType<typeof workerFixture>>) {
  const a = await f.seed(), b = join(f.project, 'docs/batches/second/批次.json');
  f.state.batches.push({ ...f.state.batches[0], batch: { file: b, name: 'B' }, events: { lastSeq: 1 } }); await f.save();
  return { a, b, put(app: App) {
    for (const [id, file] of [['a', a], ['b', b]]) {
      const card: TaskCard = { id: id!, title: id!, goal: `构造任务 ${id}`, completion: '构造完成标准', boundary: '只改 code/', status: 'paused', waiting: '', dispatches: [], conclusion: '', updated: new Date().toISOString(), subscriptions: [{ kind: 'loop', value: file! }], worker: { kind: 'loop', project: f.project, batchFile: file! } };
      app.store.putTask(card);
    }
  } };
}
const pairedReplyFlow = [{ tools: ['a', 'b'].map(taskId => ({ name: 'worker_reply', arguments: { taskId, mode: 'resume', text: '继续' } })) }, { text: '本组处理完毕' }];

for (const end of ['cancel', 'stale']) test(`R4: approve A then ${end} B still consumes A before finishing the original Loop checkpoint`, async t => {
  const second = end === 'cancel' ? [{ tools: [{ name: 'cancel_task', arguments: { id: 'b' } }] }, { text: 'done' }] : [{ text: '变化已知' }];
  const f = await workerFixture({ turns: [pairedReplyFlow, second] }); t.after(() => f.close()); const pair = await pairedTasks(f), app = await f.start(); pair.put(app);
  await f.event('group', 'paused', pair.b);
  await until(() => app.store.row('loop:group')?.state === 'waiting' && f.feishu.messages.length === 2 && f.feishu.messages.every(m => m.card?.buttons.some(b => b.label === '好')));
  const ma = f.feishu.messages.find(m => m.key === 'task-message:a')!, mb = f.feishu.messages.find(m => m.key === 'task-message:b')!;
  const va = ma.card!.buttons.find(b => b.label === '好')!.value, vb = mb.card!.buttons.find(b => b.label === '好')!.value;
  await f.click('approve-a', va, ma.id); await until(() => app.store.row('feishu:approve-a')?.state === 'done');
  assert.equal(app.router.workers.operation(va.operation!)!.state, 'approved'); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 0);
  if (end === 'cancel') {
    await f.inject({ id: 'cancel-b', quoteId: mb.id, text: 'B 算了，A 按刚才点头的做' }); await until(() => app.store.row('feishu:cancel-b')?.state === 'done');
  } else {
    Object.assign(f.state.batches[1], { state: 'running', next: null, events: { lastSeq: 2 } }); await f.save();
    await f.event('b-resumed', 'resumed', pair.b); await until(() => app.store.row('loop:b-resumed')?.state === 'done');
  }
  await until(() => app.store.row('loop:group')?.state === 'done');
  assert.equal(app.router.workers.operation(va.operation!)!.state, 'sent');
  assert.equal(app.router.workers.operation(vb.operation!)!.state, end === 'cancel' ? 'cancelled' : 'stale');
  const resumes = (await f.calls()).filter(c => c.verb === '续跑'); assert.equal(resumes.length, 1); assert.equal(resumes[0].args[0], pair.a);
  await f.click('repeat-a', va, ma.id); await until(() => app.store.row('feishu:repeat-a')?.state === 'done'); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
});

for (const cancelA of [false, true]) test(`R4: ready group survives restart and queued owner input keeps priority (${cancelA ? 'cancel A too' : 'consume A'})`, async t => {
  const f = await workerFixture({ turns: [pairedReplyFlow, [{ tools: [{ name: 'cancel_task', arguments: { id: 'a' } }] }, { text: 'done' }]] }); let recovering: App | undefined;
  t.after(async () => { await recovering?.stop(); await f.close(); }); const pair = await pairedTasks(f), app = await f.start(); pair.put(app);
  await f.event('group-restart', 'paused', pair.b); await until(() => app.store.row('loop:group-restart')?.state === 'waiting' && f.feishu.messages.length === 2 && f.feishu.messages.every(m => m.card?.buttons.some(b => b.label === '好')));
  const ma = f.feishu.messages.find(m => m.key === 'task-message:a')!, value = ma.card!.buttons.find(b => b.label === '好')!.value;
  await f.click('a-before-restart', value, ma.id); await until(() => app.store.row('feishu:a-before-restart')?.state === 'done'); await f.stop();
  recovering = await App.create(f.config);
  await recovering.router.workers.cancel('b', { id: 'owner-cancel-on-recovery', source: 'feishu', who: 'owner', chatType: 'p2p', at: new Date().toISOString(), text: 'B 算了', attachments: [] });
  assert.equal(recovering.store.row('loop:group-restart')!.state, 'pending'); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 0);
  recovering.store.wait('loop:group-restart'); // Simulate loss of the wake-up after the mixed decisions were already durable.
  if (cancelA) recovering.store.enqueue({ id: 'feishu:cancel-a-too', source: 'feishu', who: 'owner', chatType: 'p2p', at: new Date().toISOString(), text: 'A 也先取消', attachments: [] });
  await recovering.start(); await until(() => recovering!.store.row('loop:group-restart')?.state === 'done');
  assert.equal(recovering.router.workers.operation(value.operation!)!.state, cancelA ? 'cancelled' : 'sent'); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, cancelA ? 0 : 1);
});

test('R1: separately approved task IDs in one graph cannot concurrently open the same actual project/workspace', async t => {
  const args = ['a', 'b'].map(taskId => ({ ...dispatchArgs, taskId }));
  const f = await workerFixture({ flow: [{ tools: args.map(arguments_ => ({ name: 'worker_dispatch', arguments: arguments_ })) }, { text: 'done' }] }); t.after(() => f.close());
  args[1]!.project = f.project; // ID vs canonical root must still name the SAME resource.
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: args.map(arguments_ => ({ name: 'worker_dispatch', arguments: arguments_ })) }, { text: 'done' }] }) });
  f.state.test.delay = { 开工: 150, 启动: 250 }; await f.save(); const app = await f.start();
  await f.inject({ id: 'two-starts', text: '这两件活分别按原卡点头' });
  await until(() => app.store.row('feishu:two-starts')?.state === 'waiting' && f.feishu.messages.length === 2 && f.feishu.messages.every(m => m.card?.buttons.some(b => b.label === '好')));
  const approvals = f.feishu.messages.map(m => ({ message: m.id, value: m.card!.buttons.find(b => b.label === '好')!.value }));
  await f.click('head-a', approvals[0]!.value, approvals[0]!.message); await until(() => app.store.row('feishu:head-a')?.state === 'done');
  assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 0);
  await f.click('head-b', approvals[1]!.value, approvals[1]!.message); await until(() => app.store.row('feishu:head-b')?.state === 'done');
  await until(async () => (await f.calls()).some(c => c.verb === '启动'));
  await until(async () => (await f.readState()).batches[0]?.state === 'running'); // Let the owned delayed launcher finish before removing its fixture.
  const opens = (await f.calls()).filter(c => c.verb === '开工'); assert.equal(opens.length, 1);
  const operations = approvals.map(a => app.router.workers.operation(a.value.operation!)!);
  assert.equal(operations.filter(op => op.state === 'stale').length, 1);
  const launched = operations.find(op => op.state !== 'stale')!; assert.match(operations.find(op => op.state === 'stale')!.reason, /项目或开发空间.*占用/);
  assert.equal(git(f.workspace, 'branch', '--show-current'), `feat/pa-${launched.id}`);
});

test('dispatch reconciliation: delayed startup completes, then restart permits a NEW task without replaying the old launch', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); f.config.approval.dispatch = false;
  f.state.test.delay = { 启动: 300 }; await f.save(); let app = await f.start();
  const first = await app.router.workers.execute('slow-first', 'worker_dispatch', { ...dispatchArgs, taskId: 'slow-a' }) as { status: string };
  assert.equal(first.status, 'uncertain'); await until(async () => (await f.readState()).batches[0]?.state === 'running');
  const originalId = app.router.workers.journal.unresolved('slow-a')[0]!, launch = app.router.workers.operation(originalId)!.request.launch!;
  await until(async () => (await observeLaunch(f.config, launch)).ended);
  assert.equal((await app.router.files.read(launch.receiptFile, [])).ok, false, 'the model still cannot read private launch metadata');
  const state = await f.readState(), original = state.batches[0];
  original.state = 'done'; original.commit = git(f.workspace, 'rev-parse', 'HEAD'); original.stages = []; state.test.delay = {}; await f.writeState(state);
  await f.stop(); app = await f.start();
  assert.equal(app.router.workers.operation(originalId)!.state, 'sent'); assert.equal(app.router.workers.operation(originalId)!.resourceState, 'released'); assert.ok(app.router.workers.operation(originalId)!.resolution?.evidence);
  await app.router.workers.execute('slow-first', 'worker_dispatch', { ...dispatchArgs, taskId: 'slow-a' });
  const second = await app.router.workers.execute('new-second', 'worker_dispatch', { ...dispatchArgs, taskId: 'slow-b' }) as { status: string };
  assert.notEqual(second.status, 'stale', 'a completed original dispatch must not permanently lock the project');
  await until(async () => (await f.calls()).filter(c => c.verb === '启动').length === 2);
  const calls = await f.calls(); assert.equal(calls.filter(c => c.verb === '开工').length, 2); assert.equal(calls.filter(c => c.verb === '启动' && c.args[0] === original.batch.file).length, 1);
  const nextId = app.router.workers.journal.owners([`loop:workspace:${f.workspace}`])[0]!, nextLaunch = app.router.workers.operation(nextId)!.request.launch!;
  await until(async () => (await observeLaunch(f.config, nextLaunch)).ended);
});

test('dispatch reconciliation: a terminal-looking batch cannot release a still-live original launcher', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); f.config.approval.dispatch = false;
  f.state.test.delay = { 启动: 300 }; f.state.test.afterStartMs = 2000; await f.save(); const app = await f.start();
  await app.router.workers.execute('live-original', 'worker_dispatch', { ...dispatchArgs, taskId: 'live-a' });
  const id = app.router.workers.journal.unresolved('live-a')[0]!, launch = app.router.workers.operation(id)!.request.launch!;
  await until(async () => (await f.readState()).batches[0]?.state === 'running');
  const state = await f.readState(); Object.assign(state.batches[0], { state: 'done', commit: git(f.workspace, 'rev-parse', 'HEAD'), stages: [] }); state.test.delay = {}; state.test.afterStartMs = 0; await f.writeState(state);
  const held = await app.router.workers.execute('too-early', 'worker_dispatch', { ...dispatchArgs, taskId: 'live-b' }) as { status: string };
  assert.equal(held.status, 'stale'); assert.equal(app.router.workers.operation(id)!.state, 'uncertain');
  const entry = f.feishu.messages.find(m => m.key === 'task-message:live-a')!.card!.buttons.find(b => b.value.pa === 'dispatch-reconcile')!;
  await f.click('cannot-confirm-live', entry.value, f.feishu.messages.find(m => m.key === 'task-message:live-a')!.id); await until(() => app.store.row('feishu:cannot-confirm-live')?.state === 'done');
  assert.equal(app.router.workers.journal.review(id), null, 'known live launcher cannot even receive an override challenge');
  await until(async () => (await observeLaunch(f.config, launch)).ended);
  const next = await app.router.workers.execute('after-exit', 'worker_dispatch', { ...dispatchArgs, taskId: 'live-c' }) as { status: string };
  assert.notEqual(next.status, 'stale'); await until(async () => (await f.calls()).filter(c => c.verb === '启动').length === 2);
  assert.equal((await f.calls()).filter(c => c.verb === '启动' && c.args[0] === launch.batchFile).length, 1);
  const nextId = app.router.workers.journal.owners([`loop:workspace:${f.workspace}`])[0]!; await until(async () => (await observeLaunch(f.config, app.router.workers.operation(nextId)!.request.launch!)).ended);
});

for (const mismatch of ['receipt-token', 'receipt-path', 'signalled-exit', 'batch-name', 'missing-original']) test(`dispatch reconciliation: ${mismatch} is insufficient even after an ordinary done/queue update`, async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); f.config.approval.dispatch = false;
  f.state.test.delay = { 启动: 300 }; await f.save(); const app = await f.start();
  await app.router.workers.execute('bound-original', 'worker_dispatch', { ...dispatchArgs, taskId: 'bound-a' }); const id = app.router.workers.journal.unresolved('bound-a')[0]!, launch = app.router.workers.operation(id)!.request.launch!;
  await until(async () => (await observeLaunch(f.config, launch)).ended);
  const state = await f.readState(); Object.assign(state.batches[0], { state: 'done', commit: git(f.workspace, 'rev-parse', 'HEAD'), stages: [], events: { lastSeq: 2 } }); state.test.delay = {};
  if (mismatch === 'receipt-token' || mismatch === 'signalled-exit') {
    const receipt = JSON.parse(await readFile(launch.receiptFile, 'utf8'));
    if (mismatch === 'receipt-token') receipt.token = 'not-the-original-launch-token'; else { receipt.exitCode = null; receipt.signal = 'SIGTERM'; }
    await writeFile(launch.receiptFile, JSON.stringify(receipt));
  }
  if (mismatch === 'receipt-path') {
    const op = app.router.workers.operation(id)!; op.request.launch!.receiptFile = f.snapshot; app.router.workers.journal.write(op);
    assert.equal((await observeLaunch(f.config, op.request.launch!)).description, '原启动身份不完整，不能自动核销');
  }
  if (mismatch === 'batch-name') state.batches[0].batch.name = 'a-different-operation';
  if (mismatch === 'missing-original') state.batches = [];
  await f.writeState(state); await f.event('ordinary-queue', 'queue', launch.batchFile); await until(() => app.store.row('loop:ordinary-queue')?.state === 'done');
  const second = await app.router.workers.execute('unrelated-new', 'worker_dispatch', { ...dispatchArgs, taskId: 'bound-b' }) as { status: string };
  assert.equal(second.status, 'stale'); assert.equal(app.router.workers.operation(id)!.state, 'uncertain'); assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 1);
});

test('dispatch reconciliation: explicit owner-only manual review survives restart and never replays the original operation', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); f.config.approval.dispatch = false; f.state.test.unknown = '开工'; await f.save(); let app = await f.start();
  const originalArgs = { ...dispatchArgs, taskId: 'manual-a' }; await app.router.workers.execute('manual-original', 'worker_dispatch', originalArgs);
  const id = app.router.workers.journal.unresolved('manual-a')[0]!, original = app.router.workers.operation(id)!;
  const card = f.feishu.messages.find(m => m.key === 'task-message:manual-a')!;
  await f.click('forged-direct-confirm', { pa: 'dispatch-reconcile', operation: id, token: original.token, choice: 'confirm', ack: DISPATCH_MANUAL_ACK }, card.id);
  await until(() => app.store.row('feishu:forged-direct-confirm')?.state === 'done'); assert.equal(app.router.workers.operation(id)!.state, 'uncertain');
  const entry = card.card!.buttons.find(b => b.value.pa === 'dispatch-reconcile')!; await f.click('review', entry.value, card.id); await until(() => app.store.row('feishu:review')?.state === 'done');
  assert.equal(app.router.workers.operation(id)!.state, 'uncertain'); assert.match(card.text, /不代表业务通过/);
  const confirm = card.card!.buttons.find(b => b.value.choice === 'confirm')!.value;
  assert.notEqual(confirm.token, original.token); await f.stop(); app = await f.start();
  await f.inject({ id: 'other-person', who: 'someone-else', quoteId: card.id, button: { value: confirm } }); await f.click('wrong-card', confirm, 'om_not_the_original_card');
  await until(() => app.store.row('feishu:wrong-card')?.state === 'done'); assert.equal(app.router.workers.operation(id)!.state, 'uncertain');
  await f.click('manual-confirm', confirm, card.id); await until(() => app.store.row('feishu:manual-confirm')?.state === 'done');
  const resolved = app.router.workers.operation(id)!; assert.equal(resolved.state, 'blocked'); assert.equal(resolved.resourceState, 'released'); assert.equal(resolved.resolution?.manual, true); assert.equal(resolved.resolution?.by, 'owner'); assert.equal(resolved.resolution?.event, 'feishu:manual-confirm');
  assert.deepEqual(app.router.workers.journal.unresolved('manual-a'), []); assert.equal(app.store.task('manual-a')!.status, 'reconciled');
  await f.click('manual-confirm-again', confirm, card.id); await until(() => app.store.row('feishu:manual-confirm-again')?.state === 'done');
  await app.router.workers.execute('manual-original', 'worker_dispatch', originalArgs);
  await assert.rejects(app.router.workers.prepare('cannot-revive-manual', 'worker_reply', { taskId: 'manual-a', mode: 'resume', text: '继续' }), /人工核销/);
  assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 1); assert.equal(f.model.requests.length, 0);
  const second = await app.router.workers.execute('new-after-manual', 'worker_dispatch', { ...dispatchArgs, taskId: 'manual-b' }) as { status: string };
  assert.notEqual(second.status, 'stale'); assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 2);
});

for (const cancel of [false, true]) test(`dispatch reconciliation: ${cancel ? 'declining' : 'stale'} manual confirmation retains the original uncertainty`, async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); f.config.approval.dispatch = false; f.state.test.unknown = '开工'; await f.save(); const app = await f.start();
  await app.router.workers.execute('manual', 'worker_dispatch', { ...dispatchArgs, taskId: 'manual' }); const id = app.router.workers.journal.unresolved('manual')[0]!, card = f.feishu.messages[0]!;
  await f.click('review', card.card!.buttons.find(b => b.value.pa === 'dispatch-reconcile')!.value); await until(() => app.store.row('feishu:review')?.state === 'done');
  const confirm = card.card!.buttons.find(b => b.value.choice === 'confirm')!.value, decline = card.card!.buttons.find(b => b.value.choice === 'cancel')!.value;
  if (cancel) await f.click('decline', decline);
  else { const op = app.router.workers.operation(id)!; f.state.batches.push({ project: f.project, batch: { name: `pa-${id}`, file: op.request.batchFile }, branch: `feat/pa-${id}`, state: 'running', stages: [], evidence: {} }); await f.save(); }
  if (cancel) await until(() => app.store.row('feishu:decline')?.state === 'done');
  await f.click('late-confirm', confirm); await until(() => app.store.row('feishu:late-confirm')?.state === 'done');
  assert.equal(app.router.workers.operation(id)!.state, 'uncertain'); assert.equal(app.router.workers.operation(id)!.resourceState, 'held'); assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 1);
});

for (const wake of ['event', 'owner', 'done-owner', 'legacy-owner']) test(`live pause acceptance: delayed original CLI stays alive while owner approves one send (${wake})`, async t => {
  const text = '请按建议继续修复\n只动 code/';
  const f = await workerFixture({ flow: [{ tools: [{ name: 'worker_reply', arguments: { taskId: 'live-pause', mode: 'send', stage: '开发', text } }] }, { text: 'done' }] });
  const ready = join(f.root, 'publish-live-session'), exit = join(f.root, 'finish-live-session');
  t.after(async () => { await writeFile(ready, 'ready'); await writeFile(exit, 'finished'); await f.close(); });
  f.config.approval.dispatch = false; f.state.test.livePauseReady = ready; f.state.test.livePauseExit = exit; await f.save(); let app = await f.start();
  const first = await app.router.workers.execute('original-live', 'worker_dispatch', { ...dispatchArgs, taskId: 'live-pause' }) as { status: string };
  assert.equal(first.status, 'uncertain'); const id = app.router.workers.journal.unresolved('live-pause')[0]!, launch = app.router.workers.operation(id)!.request.launch!;
  await until(async () => (await observeLaunch(f.config, launch)).invoked === true);
  await writeFile(ready, 'ready'); await until(async () => (await f.calls()).some(c => c.verb === 'session-start'));
  const session = (await f.calls()).find(c => c.verb === 'session-start'); process.kill(session.pid, 0);
  if (wake === 'legacy-owner') {
    const receipt = JSON.parse(await readFile(launch.receiptFile, 'utf8')); delete receipt.child; await writeFile(launch.receiptFile, JSON.stringify(receipt));
  }
  if (wake === 'done-owner') {
    const state = await f.readState(); state.batches[0].state = 'done'; state.batches[0].commit = git(f.workspace, 'rev-parse', 'HEAD'); state.batches[0].stages[0].state = 'done'; await f.writeState(state);
  }
  assert.equal((await observeLaunch(f.config, launch)).ended, false, 'the startup command is still waiting for its real developer child');
  if (wake === 'event') {
    await f.stop(); app = await f.start(); process.kill(session.pid, 0);
    assert.equal(app.router.workers.operation(id)!.resolution?.dispatchPhase, 'accepted');
    assert.equal((await observeLaunch(f.config, launch)).ended, false, 'recovery must not wait for the paused startup CLI to exit');
    await f.event('live-pause', 'paused', launch.batchFile, { next: 'send', round: 1, repairs: 0 }, {}, '开发');
  } else await f.inject({ id: 'follow-live', quoteId: f.feishu.messages[0]!.id, text: '给原来活着的暂停会话答复，按建议继续' });
  await f.waitApproval(app);
  const accepted = app.router.workers.operation(id)!;
  assert.equal(accepted.state, 'sent'); assert.equal(accepted.resourceState, 'held'); assert.equal(accepted.resolution?.dispatchPhase, 'accepted');
  assert.equal(accepted.resolution?.acceptance?.sessionId, session.id);
  assert.equal(accepted.resolution?.acceptance?.source, wake === 'legacy-owner' ? 'legacy-running' : 'spawn-event');
  assert.equal(accepted.resolution?.acceptance?.child?.pid, wake === 'legacy-owner' ? undefined : session.cliPid);
  assert.equal(app.router.workers.journal.release(id, true), false, 'accepted delivery is NOT proof of resource release');
  const value = f.approveValue(); assert.equal((await f.calls()).filter(c => c.verb === '送话').length, 0);
  if (wake === 'event') { await f.stop(); app = await f.start(); process.kill(session.pid, 0); assert.equal((await observeLaunch(f.config, launch)).ended, false); }
  await assert.rejects(app.router.workers.execute('parallel-not-allowed', 'worker_dispatch', { ...dispatchArgs, taskId: 'parallel-live' }), /已有运行/);
  await f.click('send-live', value); await f.click('send-live-again', value); await f.click('send-live', value); await until(() => app.store.row('feishu:send-live-again')?.state === 'done');
  const calls = await f.calls(); assert.equal(calls.filter(c => c.verb === '送话').length, 1); assert.equal(calls.find(c => c.verb === '原文').text, text);
  assert.equal(calls.filter(c => c.verb === '开工').length, 1); assert.equal(calls.filter(c => c.verb === '启动').length, 1);
  assert.equal((await observeLaunch(f.config, launch)).ended, false); process.kill(session.pid, 0);
  assert.deepEqual(app.router.workers.journal.owners([`loop:workspace:${f.workspace}`]), [id]);
  await writeFile(exit, 'finished'); await until(async () => (await observeLaunch(f.config, launch)).ended);
  if (wake === 'event') {
    const state = await f.readState(); delete state.test.livePauseReady; delete state.test.livePauseExit; await f.writeState(state);
    const next = await app.router.workers.execute('new-after-live-exit', 'worker_dispatch', { ...dispatchArgs, taskId: 'after-live-exit' }) as { status: string };
    assert.notEqual(next.status, 'stale');
    const prior = app.router.workers.operation(id)!; assert.equal(prior.resourceState, 'released'); assert.equal(prior.resolution?.dispatchPhase, 'accepted'); assert.equal(prior.resourceResolution?.dispatchPhase, 'exited');
  }
});

for (const mismatch of ['receipt-token', 'launcher-identity', 'invalid-spawn-child', 'batch-name', 'session-id', 'session-dead']) test(`live pause acceptance: ${mismatch} cannot be cleared by ordinary pause/queue facts`, async t => {
  const f = await workerFixture({ flow: [{ text: '只读记录，不提操作' }] }), ready = join(f.root, 'publish-session'), exit = join(f.root, 'finish-session');
  t.after(async () => { await writeFile(ready, 'ready'); await writeFile(exit, 'done'); await f.close(); });
  f.config.approval.dispatch = false; f.state.test.livePauseReady = ready; f.state.test.livePauseExit = exit; await f.save(); const app = await f.start();
  await app.router.workers.execute('unverified-live', 'worker_dispatch', { ...dispatchArgs, taskId: 'unverified-live' });
  const id = app.router.workers.journal.unresolved('unverified-live')[0]!, launch = app.router.workers.operation(id)!.request.launch!;
  await until(async () => (await observeLaunch(f.config, launch)).invoked === true); await writeFile(ready, 'ready');
  await until(async () => (await f.calls()).some(c => c.verb === 'session-start'));
  if (mismatch === 'receipt-token' || mismatch === 'launcher-identity' || mismatch === 'invalid-spawn-child') {
    const receipt = JSON.parse(await readFile(launch.receiptFile, 'utf8'));
    if (mismatch === 'receipt-token') receipt.token = 'different-original-operation'; else if (mismatch === 'launcher-identity') receipt.wrapper.pid = 0; else receipt.child = { pid: 0 };
    await writeFile(launch.receiptFile, JSON.stringify(receipt));
  }
  const state = await f.readState();
  if (mismatch === 'batch-name') state.batches[0].batch.name = 'a-different-original-batch';
  if (mismatch === 'session-id') state.batches[0].stages[0].session.id = '';
  if (mismatch === 'session-dead') state.batches[0].stages[0].session.alive = false;
  await f.writeState(state); await f.event('unverified-pause', 'paused', launch.batchFile, { next: 'send', round: 1, repairs: 0 }, {}, '开发');
  await f.event('unverified-queue', 'queue', launch.batchFile); await until(() => app.store.row('loop:unverified-pause')?.state === 'done' && app.store.row('loop:unverified-queue')?.state === 'done');
  await app.router.workers.status('unverified-live');
  assert.equal(app.router.workers.operation(id)!.state, 'uncertain'); assert.equal(app.router.workers.operation(id)!.resourceState, 'held');
  await assert.rejects(app.router.workers.prepare('cannot-send-unverified', 'worker_reply', { taskId: 'unverified-live', mode: 'send', stage: '开发', text: '继续' }), /不确定.*不重发/);
  assert.equal((await f.calls()).filter(c => c.verb === '送话').length, 0); assert.equal((await f.calls()).filter(c => c.verb === '启动').length, 1);
});

test('dispatch reconciliation: an ended original invocation may be reconciled at a real pause without releasing its still-managed workspace', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); f.config.approval.dispatch = false;
  f.state.test.delay = { 启动: 300 }; await f.save(); const app = await f.start();
  await app.router.workers.execute('pausing-original', 'worker_dispatch', { ...dispatchArgs, taskId: 'pause-a' }); const id = app.router.workers.journal.unresolved('pause-a')[0]!, launch = app.router.workers.operation(id)!.request.launch!;
  await until(async () => (await observeLaunch(f.config, launch)).ended);
  const state = await f.readState(); Object.assign(state.batches[0], { state: 'paused', next: 'resume', stages: [] }); state.test.delay = {}; await f.writeState(state);
  const followup = await app.router.workers.prepare('new-pause-proposal', 'worker_reply', { taskId: 'pause-a', mode: 'resume', text: '处理当前暂停' });
  assert.equal(followup.state, 'planned'); assert.equal(app.router.workers.operation(id)!.state, 'sent'); assert.equal(app.router.workers.operation(id)!.resourceState, 'held');
  const other = await app.router.workers.execute('not-parallel', 'worker_dispatch', { ...dispatchArgs, taskId: 'pause-b' }) as { status: string }; assert.equal(other.status, 'stale');
  assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 1); assert.equal((await f.calls()).filter(c => c.verb === '启动').length, 1); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 0);
});

test('dispatch reconciliation: a bound normal failed-exit receipt frees an ended failed batch, never claims business success', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); f.config.approval.dispatch = false; f.state.test.delay = { 启动: 300 }; await f.save(); const app = await f.start();
  await app.router.workers.execute('failed-original', 'worker_dispatch', { ...dispatchArgs, taskId: 'failed-a' }); const id = app.router.workers.journal.unresolved('failed-a')[0]!, launch = app.router.workers.operation(id)!.request.launch!;
  await until(async () => (await observeLaunch(f.config, launch)).ended);
  const receipt = JSON.parse(await readFile(launch.receiptFile, 'utf8')); receipt.exitCode = 1; await writeFile(launch.receiptFile, JSON.stringify(receipt)); // Construct a normal nonzero exit receipt, not a signal/unknown result.
  const state = await f.readState(); state.batches[0].state = 'failed'; state.batches[0].stages = []; await f.writeState(state);
  await app.router.workers.status('failed-a'); const resolved = app.router.workers.operation(id)!;
  assert.equal(resolved.state, 'sent'); assert.equal(resolved.resourceState, 'released'); assert.equal(app.store.task('failed-a')!.status, 'failed'); assert.match(resolved.reason, /不代表业务验收通过/);
  assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 1); assert.equal((await f.calls()).filter(c => c.verb === '启动').length, 1);
});

test('R1: unresolved open holds persistent resources even when queries say idle, including after restart', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); f.config.approval.dispatch = false;
  f.state.test.unknown = '开工'; await f.save(); let app = await f.start();
  const first = await app.router.workers.execute('first', 'worker_dispatch', { ...dispatchArgs, taskId: 'a' }) as { status: string };
  assert.equal(first.status, 'uncertain'); assert.equal((await f.readState()).batches.length, 0);
  const resource = `loop:workspace:${f.workspace}`, owners = app.router.workers.journal.owners([resource]); assert.equal(owners.length, 1);
  app.router.workers.journal.release(owners[0]!, true); assert.deepEqual(app.router.workers.journal.owners([resource]), owners, 'unknown launch cannot be force-released by an ordinary cleanup');
  await f.stop(); app = await f.start();
  const second = await app.router.workers.execute('second', 'worker_dispatch', { ...dispatchArgs, taskId: 'b' }) as { status: string; reason: string };
  assert.equal(second.status, 'stale'); assert.match(second.reason, /占用|未核销/); assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 1);
});

for (const status of ['paused', 'queue']) test(`R2: unknown resume -> verified ${status} -> restart/new operation id never resends`, async t => {
  const f = await workerFixture({ flow: replyFlow }); t.after(() => f.close()); const batch = await f.seed(); f.state.test.unknown = '续跑'; await f.save(); let app = await f.start();
  await f.event('pause', 'paused', batch); await f.waitApproval(app); const value = f.approveValue();
  await f.click('unknown', value); await until(() => app.store.row('feishu:unknown')?.state === 'done'); const op = app.router.workers.operation(value.operation!)!;
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ text: '普通状态变化，不重复送话' }] }) });
  f.state.batches[0].events.lastSeq = 2; await f.save(); await f.event('ordinary', status, batch); await until(() => app.store.row('loop:ordinary')?.state === 'done');
  assert.equal(app.store.task(op.request.taskId)!.status, 'paused', 'native display status may change independently of the unresolved execution');
  assert.equal(app.router.workers.operation(op.id)!.state, 'uncertain');
  await assert.rejects(app.router.workers.prepare('new-id', 'worker_reply', { taskId: op.request.taskId, mode: 'resume', text: '再给一轮' }), /不确定.*不重发/);
  await f.stop(); app = await f.start();
  await assert.rejects(app.router.workers.execute('after-restart-id', 'worker_reply', { taskId: op.request.taskId, mode: 'resume', text: '再给一轮' }), /不确定.*不重发/);
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
});

test('R2: an already prepared second operation cannot bypass a peer unknown result', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); const batch = await f.seed(); f.config.approval.send = false; f.state.test.unknown = '续跑'; await f.save();
  const app = await f.start(); await f.event('pause', 'paused', batch); await until(() => app.store.row('loop:pause')?.state === 'done');
  const taskId = app.store.taskTable()[0]!.id, args = { taskId, mode: 'resume', text: '继续' };
  await app.router.workers.prepare('first-id', 'worker_reply', args); await app.router.workers.prepare('second-id', 'worker_reply', args);
  await app.router.workers.execute('first-id', 'worker_reply', args);
  const second = await app.router.workers.execute('second-id', 'worker_reply', args) as { status: string };
  assert.equal(second.status, 'stale'); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
});

test('R2: only matching original PA operation evidence reconciles an unknown receipt', async t => {
  const f = await workerFixture({ flow: replyFlow }); t.after(() => f.close()); const batch = await f.seed(); f.state.test.unknown = '续跑'; await f.save(); const app = await f.start();
  await f.event('pause', 'paused', batch); await f.waitApproval(app); const value = f.approveValue();
  await f.click('unknown', value); await until(() => app.store.row('feishu:unknown')?.state === 'done'); const op = app.router.workers.operation(value.operation!)!;
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ text: '只看已核实事实' }] }) });
  Object.assign(f.state.batches[0], { state: 'running', next: null, events: { lastSeq: 2 } }); await f.save();
  await f.event('wrong-id', 'resumed', batch, { via: 'pa', id: 'not-the-original-id' }); await until(() => app.store.row('loop:wrong-id')?.state === 'done');
  assert.equal(app.router.workers.operation(op.id)!.state, 'uncertain'); assert.deepEqual(app.router.workers.journal.unresolved(op.request.taskId), [op.id]);
  f.state.batches[0].events.lastSeq = 3; await f.save(); await f.event('matched', 'resumed', batch, { via: 'pa', id: op.id }); await until(() => app.store.row('loop:matched')?.state === 'done');
  assert.equal(app.router.workers.operation(op.id)!.state, 'sent'); assert.equal(app.router.workers.operation(op.id)!.resolution!.event, 'loop:matched'); assert.deepEqual(app.router.workers.journal.unresolved(op.request.taskId), []);
  Object.assign(f.state.batches[0], { state: 'paused', next: 'resume', events: { lastSeq: 4 } }); await f.save();
  await f.event('new-pause', 'paused', batch); await until(() => app.store.row('loop:new-pause')?.state === 'done');
  const fresh = await app.router.workers.prepare('genuinely-new-input', 'worker_reply', { taskId: op.request.taskId, mode: 'resume', text: '处理新的暂停' }); assert.equal(fresh.state, 'planned');
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1, 'reconciliation itself must never resend');
});

test('R1: a confirmed terminal owner releases resources, and restart never resurrects its released lease', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); f.config.approval.dispatch = false;
  let released = false, dispatches = 0, app = await f.start(); const resource = `constructed-workspace:${f.workspace}`;
  const adapter: WorkerAdapter = {
    kind: 'constructed', async dispatch(_request, bind) { dispatches++; bind('original-batch'); return { status: 'sent', reason: '构造原批次已核实启动' }; },
    async status(request) { return request.action === 'dispatch' ? { state: 'idle', fingerprint: 'idle', resources: [resource], data: {} } : { state: released ? 'done' : 'running', fingerprint: 'original', resourceReleased: released, data: {} }; },
    async progress(e) { return e; }, async ask(e) { return e; }, async result() { return true; }, async reply() { return { status: 'sent', reason: 'fixture' }; }, async stop() { return { status: 'sent', reason: 'fixture' }; },
  };
  app.router.workers.adapters.set('constructed', adapter);
  const args = { ...dispatchArgs, worker: 'constructed', taskId: 'a' };
  await app.router.workers.execute('a', 'worker_dispatch', args);
  const blocked = await app.router.workers.execute('b', 'worker_dispatch', { ...args, taskId: 'b' }) as { status: string }; assert.equal(blocked.status, 'stale'); assert.equal(dispatches, 1);
  released = true; await app.router.workers.execute('c', 'worker_dispatch', { ...args, taskId: 'c' }); assert.equal(dispatches, 2);
  const [owner] = app.router.workers.journal.owners([resource]); assert.ok(owner); assert.equal(app.router.workers.operation(owner!)!.request.taskId, 'c');
  await f.stop(); app = await f.start(); assert.deepEqual(app.router.workers.journal.owners([resource]), [owner]);
});

for (const queueFirst of [false, true]) test(`R3: done/queue burst preserves completion on the original card (${queueFirst ? 'queue first' : 'done first'})`, async t => {
  const f = await workerFixture({ flow: [{ text: '已核实，不额外发消息' }] }); t.after(() => f.close()); const pair = await pairedTasks(f);
  const commit = git(f.project, 'rev-parse', 'HEAD'); git(f.project, 'branch', 'feat/burst');
  Object.assign(f.state.batches[0], { state: 'done', branch: 'feat/burst', commit, events: { lastSeq: 11 }, queue: { status: 'ready' } }); await f.save();
  const app = await f.start(); pair.put(app); const card = app.store.task('a')!; card.status = 'running'; app.store.putTask(card);
  await app.router.workers.messages.publish('a', 'seed'); const original = f.feishu.messages[0]!.id;
  const detail = { branch: 'feat/burst', commit, scope: '整批', gate: '通过', review: { verdict: '通过', mustFix: 0 }, acceptance: { verdict: '通过', failed: [], partial: [], manual: [{ id: 'M1', text: '构造人工验收' }] } };
  for (const kind of queueFirst ? ['queue', 'done'] : ['done', 'queue']) await f.event(kind, kind, pair.a, kind === 'done' ? detail : { queueStatus: 'ready' }, {}, null, { seq: kind === 'done' ? 10 : 11 });
  await until(() => app.store.row('loop:queue')?.state === 'done' && app.store.row('loop:done')?.state === 'done');
  assert.equal(app.store.task('a')!.status, 'done'); assert.equal(app.store.task('a')!.verified!.commit, commit);
  assert.equal(f.feishu.messages.length, 1); assert.equal(f.feishu.messages[0]!.id, original); assert.match(f.feishu.messages[0]!.text, /做完/); assert.match(f.feishu.messages[0]!.text, /构造人工验收/);
});

test('R3: an old done commit is rejected even when it remains an ancestor of the current branch', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); const batch = await f.seed('done');
  const old = git(f.project, 'rev-parse', 'HEAD'); git(f.project, 'checkout', '-b', 'feat/current'); git(f.project, 'commit', '--allow-empty', '-m', 'new lifecycle'); const current = git(f.project, 'rev-parse', 'HEAD');
  Object.assign(f.state.batches[0], { branch: 'feat/current', commit: current, events: { lastSeq: 7 } }); await f.save(); const app = await f.start();
  await f.event('old-done', 'done', batch, { branch: 'feat/current', commit: old }, {}, null, { seq: 5 }); await until(() => app.store.row('loop:old-done')?.state === 'done');
  assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0); assert.ok(app.store.events().some(e => e.event.includes('核实不了，没叫你')));
});

for (const obsolete of [true, false]) test(`R3: stage pause uses its round/lifecycle facts, not batch queue sequence (${obsolete ? 'obsolete' : 'current'})`, async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); const batch = await f.seed();
  f.state.batches[0].stages = [{ stage: '开发', state: 'paused', round: 3, repairs: 1, pause: { since: '2026-11-04T10:00:00.000Z' } }]; f.state.batches[0].events.lastSeq = 9; await f.save(); const app = await f.start();
  await f.event('stage', 'paused', batch, { round: obsolete ? 2 : 3, repairs: obsolete ? 0 : 1, next: 'send' }, {}, '开发', { seq: 8, at: obsolete ? '2026-11-04T09:00:00.000Z' : '2026-11-04T10:00:00.001Z' });
  await until(() => app.store.row('loop:stage')?.state === 'done'); assert.equal(f.model.requests.length, obsolete ? 0 : 1);
});

test('R3: an accepted lifecycle transition rejects an older same-status signal, while later queue noise does not', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); const batch = await f.seed('running'); f.state.batches[0].events.lastSeq = 20; await f.save(); const app = await f.start();
  await f.event('lifecycle', 'resumed', batch, {}, {}, null, { seq: 20 }); await until(() => app.store.row('loop:lifecycle')?.state === 'done'); const before = f.model.requests.length;
  Object.assign(f.state.batches[0], { state: 'paused', next: 'resume', events: { lastSeq: 22 } }); await f.save();
  await f.event('old-pause', 'paused', batch, {}, {}, null, { seq: 10 }); await until(() => app.store.row('loop:old-pause')?.state === 'done'); assert.equal(f.model.requests.length, before);
  await f.event('current-pause', 'paused', batch, {}, {}, null, { seq: 21 }); await until(() => app.store.row('loop:current-pause')?.state === 'done'); assert.equal(f.model.requests.length, before + 1);
});

test('乙 A1+A2+A3: real HITL, duplicate callbacks execute once, verified completion updates the SAME card', async t => {
  const f = await workerFixture({ turns: [dispatchFlow.flow!, [{ text: '已完成，不再另派' }]] }); t.after(() => f.close()); const app = await f.start();
  await f.inject({ id: 'dispatch', text: '帮我在测试项目里把 README 标题改成 Hello' }); await f.waitApproval(app);
  assert.equal(f.feishu.messages.length, 1); assert.match(f.feishu.messages[0]!.text, /派给 Loop/); assert.match(f.feishu.messages[0]!.text, /README/);
  assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 0);
  assert.equal(app.store.row('feishu:dispatch')!.state, 'waiting');
  const paused = await (app.router.agent.getState({ configurable: { thread_id: 'feishu:dispatch' } }) as unknown as Promise<{ tasks: { interrupts: unknown[] }[] }>); assert.ok(paused.tasks.some(task => task.interrupts.length));
  const value = f.approveValue(), messageId = f.feishu.messages[0]!.id;
  await f.click('yes1', value); await f.click('yes2', value); await f.click('yes1', value);
  await until(() => app.store.row('feishu:yes2')?.state === 'done');
  await until(async () => (await f.calls()).some(c => c.verb === '启动'));
  assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 1); assert.equal((await f.calls()).filter(c => c.verb === '启动').length, 1);
  const card = app.store.task('readme')!; const file = card.worker!.batchFile;
  const plan = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(plan.stages.开发.scope.allow, ['code/']); assert.ok(plan.stages.开发.scope.deny.includes('docs/')); assert.ok(plan.stages.开发.scope.deny.includes('.autoreview.json'));
  const state = await f.readState(), b = state.batches[0]; b.state = 'done'; b.commit = git(f.workspace, 'rev-parse', 'HEAD'); b.events = { lastSeq: 2 }; await f.writeState(state);
  const report = join(f.project, 'report.txt'); await writeFile(report, 'synthetic evidence');
  await f.event('done', 'done', file, { branch: b.branch, commit: b.commit, gate: '通过', review: { verdict: '通过', mustFix: 0 }, acceptance: { verdict: '通过', failed: [], partial: [], manual: [{ id: 'M1', text: '人工看标题' }] } }, { report });
  await until(() => app.store.row('loop:done')?.state === 'done');
  assert.equal(app.store.task('readme')!.status, 'done'); assert.equal(f.feishu.messages.length, 1); assert.equal(f.feishu.messages[0]!.id, messageId);
  assert.match(f.feishu.messages[0]!.text, /做完/); assert.match(f.feishu.messages[0]!.text, new RegExp(b.commit)); assert.match(f.feishu.messages[0]!.text, /分支含此提交/); assert.match(f.feishu.messages[0]!.text, /人工看标题/);
  assert.ok(f.feishu.messages[0]!.card!.buttons.filter(b => /合入|推送/.test(b.label)).every(b => b.disabled));
  assert.deepEqual(app.store.match({ id: 'quote', source: 'feishu', who: 'owner', at: '', text: '', quoteId: messageId, attachments: [] }).map(c => c.id), ['readme']);
});

test('乙 A4: verified pause updates card before Router, suggestion resumes once', async t => {
  const f = await workerFixture({ flow: replyFlow }); t.after(() => f.close()); const batch = await f.seed(); const app = await f.start();
  await f.event('paused', 'paused', batch, { next: 'resume' }); await f.waitApproval(app);
  const first = f.model.requests[0].body.messages, context = JSON.parse(first.at(-2).content), card = context.matchedCards[0];
  assert.equal(card.status, 'paused'); assert.equal(card.dispatches[0].event, 'loop:paused'); assert.equal(card.worker.batchFile, batch); assert.ok(card.goal && card.completion && card.boundary && card.verified);
  assert.match(f.feishu.messages[0]!.text, /续跑/);
  const value = f.approveValue(); await f.click('resume1', value); await f.click('resume2', value); await f.click('resume1', value);
  await until(() => app.store.row('feishu:resume2')?.state === 'done'); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
});

test('乙 A5: batch self-resumes before approval; stale approval never resumes it', async t => {
  const f = await workerFixture({ turns: [replyFlow, [{ text: '不需要叫用户' }]] }); t.after(() => f.close()); const batch = await f.seed(); const app = await f.start();
  await f.event('paused', 'paused', batch); await f.waitApproval(app); const value = f.approveValue();
  f.state.batches[0].state = 'running'; f.state.batches[0].next = null; f.state.batches[0].events.lastSeq = 2; await f.save();
  await f.event('resumed', 'resumed', batch); await until(() => app.store.row('loop:resumed')?.state === 'done');
  await f.click('stale', value); await until(() => app.store.row('feishu:stale')?.state === 'done');
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 0); assert.equal(f.feishu.messages.length, 1); assert.match(f.feishu.messages[0]!.text, /批次已自己恢复/);
  assert.ok(f.model.requests.some(r => JSON.stringify(r.body).includes('"status":"stale"') || JSON.stringify(r.body).includes('批次已自己恢复')));
});

test('乙 A6: unverified pause neither calls model nor sends card', async t => {
  const f = await workerFixture(); t.after(() => f.close()); const batch = await f.seed('running'); const app = await f.start();
  await f.event('false-pause', 'paused', batch); await until(() => app.store.row('loop:false-pause')?.state === 'done');
  assert.equal(f.feishu.messages.length, 0); assert.equal(f.model.requests.length, 0); assert.equal(app.store.taskTable().length, 0);
  assert.ok(app.store.events().some(e => e.event.includes('核实不了，没叫你')));
});

test('乙 A7: completion with two must-fixes stays incomplete; model cannot enable merge, another round is actionable', async t => {
  const f = await workerFixture({ flow: [
    { tools: [{ name: 'task_card', arguments: { id: '{{taskId}}', cause: '评审还有 2 条必修', assessment: '是真问题', suggestion: '建议再给一轮', buttons: '按建议,再给它一轮,仍要合入,回电脑再说' } }] }, ...replyFlow] });
  // The official Loop resume endpoint requires a resumable position even if
  // the reported lifecycle says done. Do not hide that prerequisite in seed().
  t.after(() => f.close()); const batch = await f.seed('done', 'resume');
  const commit = git(f.project, 'rev-parse', 'HEAD'); git(f.project, 'branch', 'feat/incomplete');
  Object.assign(f.state.batches[0], { branch: 'feat/incomplete', commit }); await f.save(); const app = await f.start();
  await f.event('incomplete', 'done', batch, { branch: 'feat/incomplete', commit, gate: '通过', review: { verdict: '需返修', mustFix: 2 }, acceptance: { verdict: '通过', failed: [], partial: [], manual: [] } });
  await f.waitApproval(app); const card = f.feishu.messages[0]!.card!;
  assert.equal(app.store.taskTable()[0]!.status, 'incomplete'); assert.ok(card.buttons.find(b => b.label === '仍要合入')?.disabled);
  const again = card.buttons.find(b => b.label === '再给它一轮')!; assert.ok(again && !again.disabled);
  await f.click('unavailable', card.buttons.find(b => b.label === '仍要合入')!.value); await until(() => app.store.row('feishu:unavailable')?.state === 'done');
  assert.equal((await f.calls()).filter(c => ['合入', '推送', '续跑'].includes(c.verb)).length, 0);
  await f.click('again', again.value); await until(() => app.store.row('feishu:again')?.state === 'done'); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
});

test('乙 A7 protocol prerequisite: done without next cannot resume; a verified resume position enables the same suggestion', async t => {
  const f = await workerFixture({ flow: replyFlow }); t.after(() => f.close());
  const batch = await f.seed('done');
  const commit = git(f.project, 'rev-parse', 'HEAD'); git(f.project, 'branch', 'feat/a7-protocol');
  Object.assign(f.state.batches[0], { next: null, pause: null, branch: 'feat/a7-protocol', commit, stages: [{ stage: '开发', state: 'done' }] });
  await f.save(); const app = await f.start();
  await f.event('a7-no-position', 'done', batch, { scope: '整批', branch: 'feat/a7-protocol', commit, gate: '通过', review: { verdict: '需返修', mustFix: 2 }, acceptance: { verdict: '通过', failed: [], partial: [], manual: [] } });
  // This reproduces r14's missing-button/input_failed result, not an A7 pass.
  // Loop's real pa-resume.ts also rejects a missing/null next before launch.
  await until(() => app.store.row('loop:a7-no-position')?.state === 'failed');
  const task = app.store.task(app.store.taskTable()[0]!.id)!, message = f.feishu.messages[0]!;
  assert.equal(task.status, 'incomplete');
  const snapshot = task.verified!.snapshot as { state: string; next: unknown; executable: boolean };
  assert.equal(snapshot.state, 'done'); assert.equal(snapshot.next, null); assert.equal(snapshot.executable, false);
  assert.ok(message.card!.buttons.find(b => b.label === '仍要合入')?.disabled);
  assert.ok(!message.card!.buttons.some(b => ['按建议', '再给它一轮'].includes(b.label)));
  await f.inject({ id: 'a7-owner-no-position', quoteId: message.id, text: '再给它一轮' });
  await until(() => app.store.row('feishu:a7-owner-no-position')?.state === 'failed');
  await assert.rejects(app.router.workers.prepare('a7-preflight', 'worker_reply', { taskId: task.id, mode: 'resume', text: '按两条必修继续返修一轮' }), /worker 当前不能接受/);
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 0);

  // Change only the fake query's capability, not state/commit/layers or product
  // guards. A new owner instruction may now propose a genuine resume operation.
  f.state.batches[0].next = 'resume'; await f.save();
  await f.inject({ id: 'a7-owner-resumable', quoteId: message.id, text: '再给它一轮' });
  await f.waitApproval(app);
  const current = f.feishu.messages[0]!.card!, again = current.buttons.find(b => b.label === '再给它一轮')!;
  assert.ok(again && !again.disabled); assert.ok(current.buttons.find(b => b.label === '按建议') && !current.buttons.find(b => b.label === '按建议')!.disabled);
  assert.ok(current.buttons.find(b => b.label === '仍要合入')?.disabled); assert.ok(current.buttons.find(b => b.label === '推送')?.disabled);
  assert.equal(f.feishu.messages.filter(m => m.key === `task-message:${task.id}`).length, 1);
  assert.equal(f.feishu.messages[0]!.id, message.id);
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 0);
  await f.click('a7-again-once', again.value); await until(() => app.store.row('feishu:a7-again-once')?.state === 'done');
  await until(() => app.store.row('feishu:a7-owner-resumable')?.state === 'done');
  await f.click('a7-again-repeat', again.value); await until(() => app.store.row('feishu:a7-again-repeat')?.state === 'done');
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
  assert.equal((await f.calls()).filter(c => c.verb === '续跑')[0].args[0], batch);
  assert.equal((await f.calls()).filter(c => ['开工', '启动', '合入', '推送'].includes(c.verb)).length, 0);
});

test('乙 A8: event-provided outside evidence cannot bypass file allow/deny', async t => {
  const f = await workerFixture(); t.after(() => f.close()); const batch = await f.seed();
  const outside = join(f.root, 'outside.txt'); await writeFile(outside, 'OUTSIDE_SYNTHETIC_CONTENT');
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'read_file', arguments: { path: outside, evidence: true } }] }, { text: '已拒绝，不需要通知' }] }) });
  const app = await f.start(); await f.event('bad-evidence', 'paused', batch, {}, { report: outside }); await until(() => app.store.row('loop:bad-evidence')?.state === 'done');
  const result = JSON.parse(f.model.requests[1].body.messages.find((m: any) => m.role === 'tool').content); assert.equal(result.ok, false); assert.match(result.error, /不在授权范围/);
  assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='file_read'").get()!.n), 0); assert.equal(JSON.stringify(f.model.requests).includes('OUTSIDE_SYNTHETIC_CONTENT'), false);
});

test('乙 A9: model resolves owner cancellation; all pending approvals invalid', async t => {
  const f = await workerFixture({ turns: [dispatchFlow.flow!, [{ tools: [{ name: 'cancel_task', arguments: { id: 'readme' } }] }, { text: 'done' }]] });
  t.after(() => f.close()); const app = await f.start(); await f.inject({ id: 'dispatch', text: '改 README' }); await f.waitApproval(app); const value = f.approveValue();
  await f.inject({ id: 'cancel', text: '刚才那个算了' }); await until(() => app.store.row('feishu:cancel')?.state === 'done');
  await f.click('late', value); await until(() => app.store.row('feishu:late')?.state === 'done');
  assert.equal(app.store.task('readme')!.status, 'cancelled'); assert.match(f.feishu.messages[0]!.text, /已取消/); assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 0);
});

test('乙 A10: graceful restart preserves HITL checkpoint and callback binding, exactly one dispatch', async t => {
  const f = await workerFixture(); t.after(() => f.close()); let app = await f.start();
  await f.inject({ id: 'restart', text: '改 README' }); await f.waitApproval(app); const value = f.approveValue();
  await f.stop(); app = await f.start(); assert.equal(app.store.row('feishu:restart')!.state, 'waiting');
  await f.click('post-restart', value); await f.click('post-restart-2', value); await until(() => app.store.row('feishu:post-restart-2')?.state === 'done');
  await until(async () => (await f.calls()).some(c => c.verb === '启动'));
  assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 1); assert.equal((await f.calls()).filter(c => c.verb === '启动').length, 1);
});

test('worker safety: missing commit is not completion, verification failure is silent', async t => {
  const f = await workerFixture(); t.after(() => f.close()); const batch = await f.seed('done'); const app = await f.start();
  Object.assign(f.state.batches[0], { branch: 'feat/not-there', commit: 'a'.repeat(40) }); await f.save();
  await f.event('not-committed', 'done', batch, { branch: 'feat/not-there', commit: 'a'.repeat(40), gate: '通过', review: { verdict: '通过', mustFix: 0 }, acceptance: { verdict: '通过', failed: [], partial: [] } });
  await until(() => app.store.row('loop:not-committed')?.state === 'done'); assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
});

test('worker safety: latest query changes WITHOUT an event; old approval does not stop batch', async t => {
  const f = await workerFixture({ flow: [{ tools: [{ name: 'worker_stop', arguments: { taskId: '{{taskId}}' } }] }, { text: 'done' }] }); t.after(() => f.close()); const batch = await f.seed(); const app = await f.start();
  await f.event('paused', 'paused', batch); await f.waitApproval(app); const value = f.approveValue();
  f.state.batches[0].commit = 'b'.repeat(40); await f.save(); await f.click('changed', value); await until(() => app.store.row('feishu:changed')?.state === 'done');
  assert.equal((await f.calls()).filter(c => c.verb === '停止').length, 0); assert.match(f.feishu.messages[0]!.text, /状态或提交已变化/);
});

test('worker safety: unknown receipt is not retried, including duplicated callbacks and restart', async t => {
  const f = await workerFixture({ flow: replyFlow }); t.after(() => f.close()); const batch = await f.seed(); f.state.test.unknown = '续跑'; await f.save(); let app = await f.start();
  await f.event('paused', 'paused', batch); await f.waitApproval(app); const value = f.approveValue(); await f.click('unknown', value); await until(() => app.store.row('feishu:unknown')?.state === 'done');
  assert.equal(app.store.taskTable()[0]!.status, 'uncertain'); assert.match(f.feishu.messages[0]!.text, /不重发/);
  await f.stop(); app = await f.start(); await f.click('unknown-again', value); await until(() => app.store.row('feishu:unknown-again')?.state === 'done');
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
});

test('worker safety: approval switch false executes directly; red-line request STILL pauses and has no one-click recommendation', async t => {
  const f = await workerFixture({ flow: replyFlow }); t.after(() => f.close()); const batch = await f.seed(); f.config.approval.send = false; const app = await f.start();
  await f.event('auto', 'paused', batch); await until(() => app.store.row('loop:auto')?.state === 'done');
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1); assert.match(f.feishu.messages[0]!.text, /已直接处理/);
  await f.stop(); f.state.batches[0].state = 'paused'; f.state.batches[0].next = 'resume'; f.state.batches[0].events.lastSeq++; await f.save();
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'worker_reply', arguments: { taskId: '{{taskId}}', mode: 'resume', text: '构造红线说明', redLine: true } }] }, { text: 'done' }] }) });
  const restarted = await f.start(); await f.event('redline', 'paused', batch); await f.waitApproval(restarted);
  assert.equal(restarted.store.row('loop:redline')?.state, 'waiting');
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
  const buttons = f.feishu.messages[0]!.card!.buttons; assert.ok(buttons.some(b => b.label === '好')); assert.equal(buttons.some(b => b.label === '按建议' || b.label === '再给它一轮'), false);
});

test('worker safety: owner rejection and hold do not execute, do not create a second task message', async t => {
  for (const choice of ['不要', '回电脑再说']) {
    const f = await workerFixture(); try {
      const app = await f.start(); await f.inject({ id: 'dispatch', text: '改 README' }); await f.waitApproval(app);
      const button = f.feishu.messages[0]!.card!.buttons.find(b => b.label === choice)!;
      await f.click('no', button.value); await until(() => app.store.row('feishu:no')?.state === 'done'); await sleep(200);
      assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 0); assert.equal(f.feishu.messages.length, 1);
    } finally { await f.close(); }
  }
});

test('worker safety: interface-level parallel calls share one durable execution, stop is also write-ahead', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); const batch = await f.seed(); f.config.approval.send = false; f.config.approval.stop = false;
  const app = await f.start(); await f.event('pause', 'paused', batch); await until(() => app.store.row('loop:pause')?.state === 'done');
  const taskId = app.store.taskTable()[0]!.id, args = { taskId, mode: 'resume', text: '继续', reason: '构造并发调用', plan: '只续跑一次' };
  await Promise.all(Array.from({ length: 5 }, () => app.router.workers.execute('parallel', 'worker_reply', args)));
  await app.router.workers.execute('parallel', 'worker_reply', args);
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
  await app.router.workers.execute('stop-thread', 'worker_stop', { taskId, reason: '构造停止', plan: '保留成果' });
  assert.equal((await f.calls()).filter(c => c.verb === '停止').length, 1); assert.equal(app.store.task(taskId)!.status, 'stopped');
  const audit = app.store.events(0, 50).map(e => JSON.parse(e.event));
  const intents = audit.filter(e => e.kind === 'worker_intent'); assert.equal(intents.length, 2);
  for (const intent of intents) assert.ok(audit.findIndex(e => e === intent) < audit.findIndex(e => e.kind === 'worker_result' && e.data.operation === intent.data.id));
});

test('worker safety: crash after execution claim recovers as uncertain, NEVER replays CLI', async t => {
  const f = await workerFixture({ flow: replyFlow }); t.after(() => f.close()); const batch = await f.seed(); let app = await f.start();
  await f.event('claim', 'paused', batch); await f.waitApproval(app);
  const value = f.approveValue(), id = value.operation!, op = app.router.workers.operation(id)!;
  op.state = 'executing'; op.by = 'synthetic-accepted-before-crash'; app.store.set(`worker:op:${id}`, op); app.store.start(op.thread);
  await f.stop(); app = await f.start(); await until(() => app.store.row('loop:claim')?.state === 'done');
  assert.equal(app.router.workers.operation(id)!.state, 'uncertain'); assert.equal(app.store.taskTable()[0]!.status, 'uncertain'); assert.match(f.feishu.messages[0]!.text, /不确定.*不重发/);
  await f.click('late', value); await until(() => app.store.row('feishu:late')?.state === 'done'); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 0);
});

test('worker safety: callback needs owner, opaque approval token AND original message subscription', async t => {
  const f = await workerFixture({ flow: replyFlow }); t.after(() => f.close()); const batch = await f.seed(); const app = await f.start();
  await f.event('pause', 'paused', batch); await f.waitApproval(app); const value = f.approveValue();
  await f.click('wrong-token', { ...value, token: 'not-a-issued-token' }); await f.click('wrong-message', value, 'om_not_this_card');
  await f.inject({ id: 'other', who: 'other-user', quoteId: f.feishu.messages[0]!.id, button: { value } });
  await until(() => app.store.row('feishu:wrong-message')?.state === 'done'); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 0); assert.equal(app.store.row('loop:pause')!.state, 'waiting');
  await f.click('owner', value); await until(() => app.store.row('feishu:owner')?.state === 'done'); assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
});

test('worker safety: sends exact multiline text to original stage once, with host Loop identity removed', async t => {
  const text = '  第一行\n第二行 \n';
  const f = await workerFixture({ flow: [{ tools: [{ name: 'worker_reply', arguments: { taskId: '{{taskId}}', mode: 'send', stage: '开发', text } }] }, { text: 'done' }] }); t.after(() => f.close());
  const batch = await f.seed(); f.state.batches[0].stages = [{ stage: '开发', state: 'paused', session: { id: 'synthetic-session', alive: true } }]; await f.save();
  const app = await f.start(); await f.event('stage-pause', 'paused', batch, { next: 'send' }, {}, '开发'); await f.waitApproval(app);
  const value = f.approveValue(); await f.click('send1', value); await f.click('send2', value); await until(() => app.store.row('feishu:send2')?.state === 'done');
  const calls = await f.calls(); assert.equal(calls.filter(c => c.verb === '送话').length, 1); assert.equal(calls.find(c => c.verb === '原文').text, text);
  assert.ok(calls.filter(c => c.verb !== '原文').every(c => c.env.stage === null && c.env.pipeline === null));
});

test('worker safety: proposal definition change expires approval even if Loop snapshot is unchanged', async t => {
  const f = await workerFixture({ turns: [replyFlow, [{ tools: [{ name: 'update_task', arguments: { id: '{{taskId}}', goal: '新目标', completion: '新标准', boundary: '只改 code/' } }] }, { text: 'done' }]] });
  t.after(() => f.close()); const batch = await f.seed(); const app = await f.start(); await f.event('pause', 'paused', batch); await f.waitApproval(app); const value = f.approveValue();
  await f.inject({ id: 'edit', quoteId: f.feishu.messages[0]!.id, text: '补充要求，换成新目标' }); await until(() => app.store.row('feishu:edit')?.state === 'done');
  await f.click('old-definition', value); await until(() => app.store.row('feishu:old-definition')?.state === 'done');
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 0); assert.match(f.feishu.messages[0]!.text, /任务定义.*变化/); assert.match(f.feishu.messages[0]!.text, /新目标/);
});

test('worker safety: native multi-stage gate/review shapes are explicitly verified', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); const batch = await f.seed('done');
  const commit = git(f.project, 'rev-parse', 'HEAD'); git(f.project, 'branch', 'feat/multi'); Object.assign(f.state.batches[0], { branch: 'feat/multi', commit }); await f.save();
  const app = await f.start(); await f.event('multi', 'done', batch, { branch: 'feat/multi', commit, gate: [{ stage: '甲', result: '通过' }, { stage: '乙', result: '通过' }], review: { stages: [{ stage: '甲', verdict: '通过', mustFix: 0 }, { stage: '乙', verdict: '通过', mustFix: 0 }] }, acceptance: { verdict: '通过', failed: [], partial: [], manual: [] } });
  await until(() => app.store.row('loop:multi')?.state === 'done'); assert.equal(app.store.taskTable()[0]!.status, 'done');
});

test('worker safety: timed-out CLI is uncertain, no callback or new operation id can retry it', async t => {
  const f = await workerFixture({ flow: replyFlow }); t.after(() => f.close()); const batch = await f.seed();
  f.state.test.hang = '续跑'; await f.save(); f.config.loop.actionTimeoutMs = 1500; const app = await f.start(); // Reach the deliberately hung stub even on a loaded host; still assert exactly one received call.
  await f.event('pause', 'paused', batch); await f.waitApproval(app); const value = f.approveValue();
  await f.click('timeout', value); await until(() => app.store.row('feishu:timeout')?.state === 'done');
  assert.equal(app.store.taskTable()[0]!.status, 'uncertain');
  await assert.rejects(app.router.workers.prepare('different-id', 'worker_reply', { taskId: app.store.taskTable()[0]!.id, mode: 'resume', text: '继续' }), /不确定.*不重发/);
  await f.click('timeout-replay', value); await until(() => app.store.row('feishu:timeout-replay')?.state === 'done');
  assert.equal((await f.calls()).filter(c => c.verb === '续跑').length, 1);
});

test('worker safety: config cannot widen scope beyond code, redLine false is ignored, invalid mode is NEVER resume', async t => {
  const f = await workerFixture({ flow: [{ text: 'quiet' }] }); t.after(() => f.close()); const path = join(f.root, 'config-check.json');
  for (const allow of [['docs/'], ['code/../../outside'], ['/code/']]) {
    await writeFile(path, JSON.stringify({ ...f.raw, projects: [{ ...f.config.projects[0], loop: { ...f.config.projects[0]!.loop, allow } }] }));
    await assert.rejects(loadConfig(path), /scope|目录/);
  }
  await writeFile(path, JSON.stringify({ ...f.raw, projects: f.config.projects, approval: { dispatch: false, send: false, stop: false, redLine: false } }));
  assert.equal((await loadConfig(path)).approval.redLine, true);
  const app = await f.start(); await assert.rejects(app.router.workers.prepare('invalid-mode', 'worker_reply', { taskId: 'none', mode: 'merge', text: '合入' }), /当前不可用/);
  assert.equal((await f.calls()).filter(c => c.verb === '续跑' || c.verb === '合入' || c.verb === '推送').length, 0);
});

test('worker card transport: real official SDK against local REST emits interactive card and PATCH, unavailable buttons are never interactive', async t => {
  const f = await fixture(); t.after(() => f.close()); const rest = await sdkStub(); t.after(() => rest.close());
  f.config.feishu.mode = 'real';
  const channel = await makeChannel(f.config, undefined, { credentials: { appId: 'SYNTHETIC_APP_ID', appSecret: 'SYNTHETIC_APP_SECRET' }, domain: rest.url });
  t.after(() => channel.stop());
  const card: MessageCard = { title: '构造点头卡', text: '确认只改 code/，合入当前不可用，请回电脑操作', buttons: [{ label: '好', value: { pa: 'worker', token: 'synthetic-token' } }, { label: '仍要合入', value: { pa: 'unavailable' }, disabled: true }] };
  const id = await channel.sendCard!(card, 'synthetic-card'); await channel.updateCard!(id, { ...card, text: '做完' });
  const create = rest.calls.find(c => c.method === 'POST' && !c.path.includes('/auth/'))!, patch = rest.calls.find(c => c.method === 'PATCH')!;
  assert.ok(create && patch); const body = JSON.parse(create.body); assert.equal(body.msg_type, 'interactive');
  const payload = JSON.parse(body.content), actions = payload.elements.filter((e: any) => e.tag === 'action').flatMap((e: any) => e.actions);
  assert.deepEqual(actions.map((a: any) => a.text.content), ['好']); assert.ok(JSON.stringify(payload).includes('当前不可用，请回电脑操作'));
  assert.equal(JSON.parse(JSON.parse(patch.body).content).elements[0].text.content, '做完');
});

test('worker interface: a constructed seven-action adapter works through unchanged Router tools and generic options', async t => {
  const { project: _project, ...base } = dispatchArgs;
  const f = await workerFixture({ flow: [{ tools: [{ name: 'worker_dispatch', arguments: { ...base, worker: 'constructed', taskId: 'generic', options: '{"type":"fixture-read"}' } }] }, { tools: [{ name: 'worker_status', arguments: { id: 'generic' } }] }, { text: 'done' }] });
  t.after(() => f.close()); const app = await f.start(), dispatched: WorkerRequest[] = [];
  const adapter: WorkerAdapter = {
    kind: 'constructed',
    async dispatch(request, bind) { dispatched.push(request); bind('constructed-operation'); return { status: 'sent', reason: '构造 worker 已接收' }; },
    async status() { return { state: 'idle', fingerprint: 'constant-fixture-state', executable: true, data: { fixture: true } }; },
    async progress(event) { return event; }, async ask(event) { return event; },
    async reply() { return { status: 'sent', reason: '构造答复' }; },
    async result() { return true; }, async stop() { return { status: 'sent', reason: '构造停止' }; },
  };
  app.router.workers.adapters.set(adapter.kind, adapter);
  await f.inject({ id: 'generic-request', text: '构造新 worker 的任务' }); await f.waitApproval(app);
  const ctx = JSON.parse(f.model.requests[0].body.messages.at(-2).content); assert.ok(ctx.workers.includes('constructed')); assert.equal(ctx.projects[0].id, 'p');
  await f.click('generic-yes', f.approveValue()); await until(() => app.store.row('feishu:generic-yes')?.state === 'done');
  assert.equal(dispatched.length, 1); assert.deepEqual(dispatched[0]!.options, { type: 'fixture-read' }); assert.equal((await f.calls()).length, 0);
  const results = f.model.requests.at(-1).body.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content)); assert.ok(results.some((r: any) => r.snapshot?.data?.fixture));
});
