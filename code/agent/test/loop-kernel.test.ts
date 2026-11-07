import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, until } from './helpers.js';
import { canonical, hash } from '../src/util.js';
import { queryLoop, LoopAdapter } from '../src/loop.js';
import { Store } from '../src/store.js';
import { Files } from '../src/files.js';
import { observeLaunch, processStarted } from '../src/loop-launch.js';
import type { Input, TaskCard } from '../src/types.js';
import type { WorkerRequest } from '../src/worker.js';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const args = { taskId: 'ordinary', worker: 'loop', project: 'p', title: '构造开发委托', goal: '修改 code/README.md 的构造标题', completion: '构造标题正确并说明检查及欠项', boundary: '仅 code/，不发布不推送不碰真实账号', prompt: '修改构造标题' };
const author = (id: string): Input => ({ id, source: 'feishu', who: 'owner', chatType: 'p2p', messageId: id, at: new Date().toISOString(), text: '请在 p 项目修改 code/README.md 的构造标题。', attachments: [] });
async function detachedConsumer(t: TestContext, root: string) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, env: { PATH: process.env.PATH, LC_ALL: 'C' }, detached: true, stdio: 'ignore' });
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
  t.after(async () => { if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM'); await closed; });
  await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
  const started = await processStarted(child.pid!); assert.ok(started);
  return { pgid: child.pid!, started, token: randomUUID(), ownerPid: process.pid, at: new Date().toISOString(), role: 'synthetic consumer', command: 'isolated node fixture' };
}
async function kernelFixture(t: TestContext, overrides: Record<string, unknown> = {}) {
  const f = await fixture({ flow: [{ text: '已收到构造来源变化' }] }, overrides);
  t.after(async () => {
    for (const path of [state.test.livePauseReady, state.test.livePauseExit]) if (typeof path === 'string') await writeFile(path, 'fixture cleanup');
    await f.close();
  });
  const p = f.config.projects[0]!, project = p.root, root = await canonical(f.root);
  await mkdir(join(project, 'code')); await writeFile(join(project, 'code/README.md'), '# synthetic\n');
  await writeFile(join(project, '.gitignore'), '.autoreview.json\n'); await writeFile(join(project, '.autoreview.json'), '{"acceptance":{}}');
  git(project, 'init', '-b', 'dev'); git(project, 'add', '.'); git(project, 'commit', '-m', 'synthetic baseline');
  p.loop = { batchDir: join(project, 'docs/batches'), allow: ['code/'], deny: ['code/private/'] };
  const snapshot = join(root, 'loop.json'), callsFile = join(root, 'calls.jsonl');
  const state = { v: 1, batches: [] as any[], test: { root, project, workspace: project, run: p.loopRunDirs[0], ...overrides.test as object } as Record<string, any> };
  const save = () => writeFile(snapshot, JSON.stringify(state)); await save();
  const load = async () => Object.assign(state, JSON.parse(await readFile(snapshot, 'utf8')));
  const calls = async () => (await readFile(callsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(s => JSON.parse(s));
  f.config.loop.args = [resolve('scripts/loop-worker-stub.mjs'), '--state', snapshot, '--calls', callsFile];
  const seed = async (tasks: Record<string, any>[] = [{ id: 'task-a', name: '甲', active: true }, { id: 'task-b', name: '乙', active: true, waiting: true }]) => {
    const file = join(project, 'docs/batches/external/开发卡.json'); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ version: 1, flow: ['开发评审', '验收'], tasks: tasks.map(t => ({ name: t.name })) }));
    const b: Record<string, any> = { kernel: true, runId: randomUUID(), project, batch: { name: '同名构造批次', file }, state: 'running', tasks, events: { lastSeq: 1 } };
    state.batches.push(b); await save(); return b;
  };
  return { ...f, p, project, snapshot, state, save, load, calls, seed };
}

for (const failure of ['bad-receipt', 'timeout']) test(`R5: final unchanged revision survives failed verification and restart, then notifies once (${failure})`, async t => {
  const f = await kernelFixture(t), b = await f.seed(); f.config.intake.watch = false; f.config.intake.fallbackMs = 60000;
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'reply', arguments: { text: '已核实最终构造修订' } }] }, { text: 'done' }] }) });
  let app = await f.start(); const card = await app.router.workers.trackLoop('p', b.batch.file, 'task-a'), binding = card.worker!.loop!;
  b.events.lastSeq = 7; b.tasks.forEach((task: any) => { task.active = false; task.state = 'done'; }); b.state = 'done';
  b.checks = ['最终修订：验收通过']; await f.save(); await queryLoop(f.config, app.router.files, []);
  const signature = async () => { const s = await stat(binding.ledger); return `${s.ino}:${s.size}:${s.mtimeMs}`; };
  const unchanged = await signature(), inputId = `kernel:${hash(JSON.stringify([binding, 7]))}`;
  f.state.test.queryFailure = failure; f.config.loop.timeoutMs = 350; await f.save(); await app.intake.scan();
  await until(() => app.store.row(inputId)?.state === 'done' && app.store.get(`kernel:verification:${inputId}`, false));
  assert.equal(app.store.task(card.id)!.sourceRevision, 1); assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
  await f.stop(); app = await f.start();
  await until(() => app.store.row(inputId)?.state === 'done' && app.store.get(`kernel:verification:${inputId}`, false));
  assert.equal(await signature(), unchanged, 'the last source ledger did not change while verification was unavailable');
  delete f.state.test.queryFailure; f.config.loop.timeoutMs = 15000; await f.save(); await app.intake.scan();
  try { await until(() => app.store.task(card.id)!.sourceRevision === 7 && app.store.row(inputId)?.state === 'done' && f.feishu.messages.length === 1); }
  catch (error) { t.diagnostic(JSON.stringify({ revision: app.store.task(card.id)!.sourceRevision, input: app.store.row(inputId), marker: app.store.get(`kernel:verification:${inputId}`, null), modelTurns: f.model.requests.length, messages: f.feishu.messages, events: app.store.events(0, 50).slice(-8) })); throw error; }
  assert.deepEqual((app.store.task(card.id)!.verified!.layers as any).checks, ['最终修订：验收通过']);
  assert.equal(app.store.get(`kernel:verification:${inputId}`, true), false);
  assert.equal(Number(app.store.db.prepare('SELECT COUNT(*) AS n FROM inputs WHERE id=?').get(inputId)!.n), 1);
  const turns = f.model.requests.length; await app.intake.scan(); await f.stop(); app = await f.start(); await app.intake.scan();
  assert.equal(f.model.requests.length, turns); assert.equal(f.feishu.messages.length, 1);
  assert.equal((await f.calls()).some(c => c.verb !== '查询'), false);
  assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key GLOB 'worker:op:*'").get()!.n), 0);
});

for (const mapping of ['same-root', 'same-repository-worktree', 'unverifiable']) test(`R2: legacy unresolved keys survive restart without configured workspace (${mapping})`, async t => {
  const f = await kernelFixture(t); f.config.approval.dispatch = false; let app = await f.start();
  const op = await app.router.workers.prepare('legacy', 'worker_dispatch', { ...args, taskId: 'legacy-task' });
  const origin = mapping === 'unverifiable' ? join(await canonical(f.root), 'missing-original') : f.project;
  const oldKeys = [`loop:project:${origin}`, `loop:workspace:${join(await canonical(f.root), 'old-workspace')}`];
  op.state = 'uncertain'; op.request.batchFile = join(origin, 'old-card.json'); op.basis.resources = [...oldKeys];
  app.router.workers.journal.retain(op, [...oldKeys]);
  const card = app.store.task('legacy-task')!; card.worker!.batchFile = op.request.batchFile; card.status = 'uncertain'; app.store.putTask(card);
  await f.stop();
  if (mapping === 'same-repository-worktree') {
    const sibling = join(await canonical(f.root), 'next-worktree'); git(f.project, 'worktree', 'add', '--detach', sibling);
    await writeFile(join(sibling, '.autoreview.json'), '{"acceptance":{}}'); f.p.root = sibling; f.p.loop!.batchDir = join(sibling, 'docs/batches');
  }
  assert.equal(f.p.loop!.workspace, undefined); app = await f.start();
  const recovered = app.router.workers.operation(op.id)!;
  assert.equal(recovered.id, op.id); assert.equal(recovered.token, op.token); assert.equal(recovered.state, 'uncertain'); assert.ok(oldKeys.every(key => recovered.resources!.includes(key)));
  if (mapping === 'unverifiable') assert.ok(recovered.resources!.includes('loop:unverified-history'));
  else assert.ok(recovered.resources!.includes(`loop:repository:${git(f.project, 'rev-parse', '--path-format=absolute', '--git-common-dir')}`));
  const second = await app.router.workers.execute('new-input', 'worker_dispatch', { ...args, taskId: 'new-task' }) as any;
  assert.equal(second.status, 'stale'); assert.equal(app.router.workers.operation(op.id)!.resourceState, 'held');
  assert.equal((await f.calls()).filter(c => ['启动', '开工', '续跑'].includes(c.verb)).length, 0);
});

for (const scope of ['batch', 'task']) test(`R6: incomplete ${scope} attempt is checked under its original owner without a result`, async t => {
  const f = await kernelFixture(t), b = await f.seed([{ id: 'task-a', name: '甲', active: false }, { id: 'task-b', name: '乙', active: false }]);
  b.state = 'failed'; b.stopped = true; await f.save();
  const app = await f.start(), card = await app.router.workers.trackLoop('p', b.batch.file, 'task-a'), binding = card.worker!.loop!;
  const base = scope === 'batch' ? dirname(binding.ledger) : join(dirname(binding.ledger), 'tasks', 'task-b');
  const attemptId = randomUUID(), dir = join(base, 'attempts', attemptId), consumer = await detachedConsumer(t, f.root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'attempt.json'), JSON.stringify({ id: attemptId, task: scope === 'batch' ? b.runId : 'task-b', node: scope === 'batch' ? '验收' : '测试', candidate: { commit: git(f.project, 'rev-parse', 'HEAD'), tree: git(f.project, 'rev-parse', 'HEAD^{tree}') }, inputs: hash('bound attempt'), started: new Date().toISOString(), epoch: 0 }));
  await writeFile(join(dir, 'test.procs.json'), '[]'); await writeFile(join(dir, 'test.procs.json.cleanup'), JSON.stringify([consumer]));
  b.events.lastSeq++; await f.save();
  const snapshot = (await app.router.workers.status(card.id)).snapshot!;
  assert.equal(snapshot.resourceReleased, false); assert.equal((snapshot.data as any).kernel.executionEnded, false);
  assert.deepEqual((snapshot.data as any).kernel.results, []); process.kill(consumer.pgid, 0);
  assert.equal((await app.router.files.read(join(dir, 'test.procs.json.cleanup'), [], true)).ok, false, 'consumer verification is not a model directory grant');
});

for (const end of ['done', 'stopped', 'unknown-group', 'unreleased-consumer', 'unfinished-test', 'unfinished-acceptance', 'unfinished-cleanup', 'missing-request', 'missing-consumers', 'completed-attempt', 'cleared-unfinished']) test(`R3: execution lease is independent of retained worktree (${end})`, async t => {
  const f = await kernelFixture(t); f.config.approval.dispatch = false; f.config.intake.watch = false; f.config.intake.fallbackMs = 60000;
  const ready = join(await canonical(f.root), 'ready'), exit = join(await canonical(f.root), 'exit');
  f.state.test.livePauseReady = ready; f.state.test.livePauseExit = exit; await f.save();
  const app = await f.start(); await app.router.workers.execute('original', 'worker_dispatch', args);
  const id = app.router.workers.journal.unresolved(args.taskId)[0]!, launch = app.router.workers.operation(id)!.request.launch!;
  await writeFile(ready, 'ready'); await until(async () => (await f.calls()).some(c => c.verb === 'session-start'));
  await app.router.workers.status(args.taskId); assert.equal(app.router.workers.operation(id)!.state, 'sent');
  const binding = app.store.task(args.taskId)!.worker!.loop!;
  await writeFile(exit, 'exit'); await until(async () => (await observeLaunch(f.config, launch)).ended);
  await f.load(); delete f.state.test.livePauseReady; delete f.state.test.livePauseExit;
  const b = f.state.batches[0]; b.events.lastSeq++;
  if (end === 'stopped') { b.state = 'failed'; b.stopped = true; }
  if (end === 'unknown-group') b.launch = { pid: b.stages[0].session.pid, processStarted: b.stages[0].session.started, token: '' };
  if (end === 'unreleased-consumer') await writeFile(join(dirname(binding.ledger), 'review.procs.json'), '[{"pgid":99,"started":"unknown"}]');
  if (end.startsWith('unfinished-') || ['missing-request', 'missing-consumers', 'completed-attempt', 'cleared-unfinished'].includes(end)) {
    b.state = 'failed'; b.stopped = true; // pauseManaged cleared activity; the host/worker already exited above.
    const attemptId = randomUUID(), dir = join(dirname(binding.ledger), 'attempts', attemptId), request = join(dir, 'attempt.json');
    await mkdir(dir, { recursive: true });
    const attempt = { id: attemptId, task: '开发', node: end === 'unfinished-acceptance' ? '验收' : '测试', candidate: { commit: git(f.project, 'rev-parse', 'HEAD'), tree: git(f.project, 'rev-parse', 'HEAD^{tree}') }, inputs: hash('attempt input'), started: new Date().toISOString(), epoch: 0 };
    if (end !== 'missing-request') await writeFile(request, JSON.stringify(attempt));
    if (end === 'completed-attempt') b.results = [{ ...attempt, ended: new Date().toISOString(), released: true, status: '通过', evidence: [request] }];
    else if (end === 'cleared-unfinished') { await writeFile(join(dir, 'test.procs.json'), '[]'); await writeFile(join(dir, 'test.procs.json.cleanup'), '[]'); }
    else {
      const consumer = await detachedConsumer(t, f.root); consumer.ownerPid = (await f.calls()).find(c => c.verb === 'session-start').cliPid;
      process.kill(consumer.pgid, 0); // A real independent group outlives the original host, not just stale metadata.
      if (end !== 'missing-consumers') {
        await writeFile(join(dir, 'test.procs.json'), JSON.stringify(end === 'unfinished-cleanup' ? [] : [consumer]));
        await writeFile(join(dir, 'test.procs.json.cleanup'), JSON.stringify(end === 'unfinished-cleanup' ? [consumer] : []));
      }
      assert.equal((b.results ?? []).length, 0);
    }
  }
  await f.save();
  const snapshot = (await app.router.workers.status(args.taskId)).snapshot!;
  assert.equal((snapshot.data as any).kernel.release.status, '未释放', 'Loop deliberately retains unpublished artifacts');
  const next = await app.router.workers.execute('new-work', 'worker_dispatch', { ...args, taskId: 'next-work' }) as any;
  if (['done', 'stopped', 'completed-attempt', 'cleared-unfinished'].includes(end)) {
    assert.notEqual(next.status, 'stale'); assert.equal(app.router.workers.operation(id)!.resourceState, 'released');
    await until(async () => (await f.calls()).filter(c => c.verb === '启动').length === 2);
    assert.equal((await app.router.workers.status(args.taskId)).snapshot!.resourceReleased, true);
  } else {
    assert.equal(next.status, 'stale'); assert.equal(app.router.workers.operation(id)!.resourceState, 'held');
    assert.equal((await f.calls()).filter(c => c.verb === '启动').length, 1);
  }
  await readFile(binding.ledger); await readFile(join(dirname(binding.ledger), 'frozen-card.json'));
  assert.notEqual(app.store.task(args.taskId)!.status, 'done'); assert.equal((app.store.task(args.taskId)!.verified!.layers as any).businessAcceptance, '未验证');
});

for (const consequence of ['提交', '发布事务', '待生效改卡']) test(`R1: external card ${consequence} blocks ordinary resume, preserves query/stop and the frozen card`, async t => {
  const f = await kernelFixture(t), b = await f.seed([{ id: 'task-a', name: '甲', active: false }, { id: 'task-b', name: '乙', active: false }]);
  if (consequence === '提交') {
    const card = JSON.parse(await readFile(b.batch.file, 'utf8')); card.flow.push('提交'); await writeFile(b.batch.file, JSON.stringify(card));
  } else if (consequence === '发布事务') b.publication = { local: 'intent', push: '未开始' };
  else { b.pendingCard = 'change'; b.changes = [{ state: 'pending', card: { flow: ['开发评审', '提交'] } }]; }
  await f.save(); f.config.approval.send = false; f.config.approval.stop = false;
  const original = await readFile(b.batch.file, 'utf8'), app = await f.start(), card = await app.router.workers.trackLoop('p', b.batch.file, 'task-a');
  assert.equal((await app.router.workers.status(card.id)).ok, true); assert.match(app.store.task(card.id)!.control!, /普通续跑不可用/);
  await assert.rejects(app.router.workers.prepare('resume', 'worker_reply', { taskId: card.id, mode: 'resume', text: '继续' }), /发布|推送|后果/);
  const request: WorkerRequest = { ...args, id: 'direct', taskId: card.id, project: 'p', action: 'reply', batchFile: b.batch.file, stage: null, text: '继续', mode: 'resume', redLine: false, options: {}, loopBinding: card.worker!.loop };
  assert.equal((await new LoopAdapter(f.config, app.router.files).reply(request)).status, 'blocked');
  assert.equal((await app.router.workers.execute('stop', 'worker_stop', { taskId: card.id }) as any).status, 'sent');
  assert.equal(await readFile(b.batch.file, 'utf8'), original);
  const actions = (await f.calls()).filter(c => c.verb !== '查询'); assert.equal(actions.length, 1); assert.equal(actions[0].verb, '停止');
});

for (const races of [1, 3]) test(`R4: query/ledger interleaving keeps facts paired to revision (${races} changes)`, async t => {
  const f = await kernelFixture(t), b = await f.seed(); f.config.intake.watch = false; f.config.intake.fallbackMs = 60000;
  const app = await f.start(), card = await app.router.workers.trackLoop('p', b.batch.file, 'task-a');
  f.state.test.queryRace = races; await f.save();
  if (races === 1) {
    await app.router.workers.status(card.id);
    const updated = app.store.task(card.id)!;
    assert.equal(updated.sourceRevision, 2); assert.deepEqual((updated.verified!.layers as any).checks, ['构造新修订 2：验收通过']);
    assert.equal((updated.verified!.layers as any).publication.push, '失败');
  } else {
    await assert.rejects(app.router.workers.status(card.id), /不能唯一核对/);
    assert.equal(app.store.task(card.id)!.sourceRevision, 1, 'unstable query must not advance the verified revision');
    await f.load(); f.state.test.queryRace = 0; await f.save();
    await app.router.workers.status(card.id);
    const updated = app.store.task(card.id)!;
    assert.equal(updated.sourceRevision, 3); assert.deepEqual((updated.verified!.layers as any).checks, ['构造新修订 3：验收通过']);
  }
  assert.equal((await f.calls()).some(c => c.verb !== '查询'), false);
});

test('A1: actual Router owner instruction produces one version:1 startup, official parser/dry-run accepts it without publication', async t => {
  const f = await kernelFixture(t);
  const toolArgs = { ...args, instructionInput: 'feishu:delegate', instruction: author('unused').text };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'worker_dispatch', arguments: toolArgs }] }, { text: '已记录原委托，接收未核实不重发' }] }) });
  const app = await f.start();
  await f.inject({ id: 'delegate', text: author('unused').text }); await f.inject({ id: 'delegate', text: author('unused').text });
  await until(() => app.store.row('feishu:delegate')?.state === 'done');
  await until(async () => (await f.calls()).filter(c => c.verb === '启动').length === 1);
  const op = app.router.workers.operation(app.router.workers.journal.unresolved('ordinary')[0]!)!;
  assert.equal(op.confirmation?.kind, 'owner-instruction'); assert.equal(op.state, 'uncertain');
  const plan = JSON.parse(await readFile(op.request.batchFile, 'utf8'));
  assert.equal(plan.version, 1); assert.equal(plan.tasks.length, 1); assert.equal(plan.stages, undefined); assert.equal(plan.steps, undefined);
  assert.deepEqual(plan.flow, ['开发评审', '验收']); assert.equal(plan.flow.includes('提交'), false); assert.equal(plan.flow.includes('部署'), false);
  assert.equal((await f.calls()).some(c => ['开工', '合入', '推送'].includes(c.verb)), false);
  const loop = '/Users/Admin/Desktop/loop', isolated = join(f.root, 'isolated-kernel');
  const script = `import {readDevelopmentCard} from ${JSON.stringify(`${loop}/development-card.ts`)}; import {createKernelRun} from ${JSON.stringify(`${loop}/kernel.ts`)}; console.log(JSON.stringify({card:readDevelopmentCard(process.argv[1],process.argv[2]).card,lines:createKernelRun(process.argv[1],process.argv[2],true).lines}));`;
  const parsed = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, op.request.batchFile, f.project], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(f.root, 'home'), AUTOREVIEW_KERNEL_ROOT: isolated, AUTOREVIEW_LOCAL_QUEUE_ROOT: join(f.root, 'queue') } }));
  assert.equal(parsed.card.version, 1); assert.ok(parsed.lines.some((s: string) => s.includes('核对通过')));
  await assert.rejects(readdir(isolated)); assert.equal(git(f.project, 'branch', '--list'), '* dev');
  t.diagnostic('Official current readDevelopmentCard + createKernelRun(...,true): accepted; no host/model/run resources started.');
});

test('A2: explicit bindings separate two source tasks, waiting/completion never completes the batch or business acceptance', async t => {
  const f = await kernelFixture(t), b = await f.seed(), app = await f.start();
  const a = await app.router.workers.trackLoop('p', b.batch.file, 'task-a'), other = await app.router.workers.trackLoop('p', b.batch.file, 'task-b');
  assert.notEqual(a.id, other.id); assert.equal(a.worker!.loop!.runId, other.worker!.loop!.runId);
  assert.equal(a.verified!.state, '进行中');
  assert.equal((other.verified!.layers as any).execution.waiting, true);
  b.tasks[0] = { ...b.tasks[0], active: false, state: 'done' }; b.events.lastSeq++;
  b.checks = ['甲 / 评审：通过', '乙 / 评审：没验证']; b.publication = { local: 'merged', push: '失败', reason: '构造远端拒绝' }; await f.save();
  await queryLoop(f.config, app.router.files, []); // The substitute producer publishes its constructed ledger revision.
  await app.intake.scan(); await until(() => app.store.task(a.id)!.sourceRevision === 2);
  const updated = app.store.task(a.id)!, layers = updated.verified!.layers as any;
  assert.equal(updated.status, '等你决定', 'official task status is not inferred from integrated/completed candidate');
  assert.equal((updated.verified!.snapshot as any).state, '进行中');
  assert.equal(app.store.task(other.id)!.worker!.loop!.taskId, 'task-b');
  assert.equal(layers.publication.local, 'merged'); assert.equal(layers.publication.push, '失败'); assert.equal(layers.businessAcceptance, '未验证'); assert.ok(layers.missing.length);
  assert.equal(JSON.stringify(f.model.requests).includes('SYNTHETIC_PRIVATE_INPUT_NOT_FOR_MODEL'), false);
});

test('A3: repeated/new/late revisions and PA restart keep latest original execution and do not replay actions', async t => {
  const f = await kernelFixture(t), b = await f.seed(); let app = await f.start();
  const a = await app.router.workers.trackLoop('p', b.batch.file, 'task-a'), binding = a.worker!.loop!;
  b.events.lastSeq = 9; b.reason = '新版本事实'; await f.save(); await queryLoop(f.config, app.router.files, []); await app.intake.scan();
  await until(() => app.store.task(a.id)!.sourceRevision === 9);
  const at = app.store.task(a.id)!.lastVerifiedAt, history = app.store.task(a.id)!.dispatches.length;
  const delayed = (revision: number): Input => ({ id: `late-${revision}`, source: 'loop', who: 'loop', at: new Date().toISOString(), text: '', attachments: [], project: f.project, batchFile: b.batch.file, workerId: a.id, raw: { kernel: 1, runId: binding.runId, revision, ledger: binding.ledger } });
  assert.equal(await app.router.workers.ingest(delayed(9)), false); assert.equal(await app.router.workers.ingest(delayed(2)), false);
  b.events.lastSeq = 2; await f.save(); await app.router.workers.status(a.id);
  assert.equal(app.store.task(a.id)!.sourceRevision, 9); assert.equal(app.store.task(a.id)!.lastVerifiedAt, at);
  await f.stop(); app = await f.start();
  assert.equal(app.store.task(a.id)!.dispatches.length, history); assert.deepEqual(app.store.task(a.id)!.worker!.loop, binding);
  assert.equal((await f.calls()).some(c => c.verb !== '查询'), false);
});

test('A4: uncertain startup is never resent, original live session reconciles; child stop preserves --task exactly once', async t => {
  const f = await kernelFixture(t); f.config.approval.dispatch = false; f.config.approval.stop = false;
  const ready = join(await canonical(f.root), 'ready'), exit = join(await canonical(f.root), 'exit');
  f.state.test.livePauseReady = ready; f.state.test.livePauseExit = exit; await f.save();
  let app = await f.start();
  await app.router.workers.execute('dispatch', 'worker_dispatch', args);
  const id = app.router.workers.journal.unresolved(args.taskId)[0]!, launch = app.router.workers.operation(id)!.request.launch!;
  await until(async () => (await observeLaunch(f.config, launch)).invoked === true);
  await writeFile(ready, 'ready'); await until(async () => (await f.calls()).some(c => c.verb === 'session-start'));
  const result = await app.router.workers.status(args.taskId);
  assert.equal(result.ok, true); assert.equal(app.router.workers.operation(id)!.state, 'sent'); assert.equal(app.router.workers.operation(id)!.resourceState, 'held');
  assert.equal(app.router.workers.operation(id)!.resolution!.dispatchPhase, 'accepted');
  await f.stop(); app = await f.start();
  await app.router.workers.execute('dispatch', 'worker_dispatch', args);
  assert.equal((await f.calls()).filter(c => c.verb === '启动').length, 1);
  // Select the original single task explicitly, never translate it to an entire-batch stop.
  const stopArgs = { taskId: args.taskId, sourceTaskId: '开发' };
  const stopped = await app.router.workers.execute('stop', 'worker_stop', stopArgs) as any;
  assert.equal(stopped.status, 'sent'); await app.router.workers.execute('stop', 'worker_stop', stopArgs);
  const calls = (await f.calls()).filter(c => c.verb === '停止'); assert.equal(calls.length, 1); assert.deepEqual(calls[0].args.slice(1, 3), ['--task', '开发']);
  assert.notEqual(app.store.task(args.taskId)!.status, 'done');
  await writeFile(exit, 'exit'); await until(async () => (await observeLaunch(f.config, launch)).ended);
});

test('A4: unknown child stop blocks new operation IDs after restart; unsupported send cannot use legacy --stage/--id', async t => {
  const f = await kernelFixture(t), b = await f.seed(); f.config.approval.stop = false; f.state.test.unknown = '停止'; await f.save(); let app = await f.start();
  const a = await app.router.workers.trackLoop('p', b.batch.file, 'task-b');
  const r = await app.router.workers.execute('stop-unknown', 'worker_stop', { taskId: a.id }) as any; assert.equal(r.status, 'uncertain');
  await app.router.workers.execute('stop-unknown', 'worker_stop', { taskId: a.id });
  await assert.rejects(app.router.workers.execute('other-id', 'worker_stop', { taskId: a.id }), /不确定/);
  await f.stop(); app = await f.start(); await assert.rejects(app.router.workers.execute('after-restart', 'worker_stop', { taskId: a.id }), /不确定/);
  const adapter = new LoopAdapter(f.config, app.router.files), request: WorkerRequest = { id: 'x', taskId: a.id, worker: 'loop', action: 'reply', project: 'p', batchFile: b.batch.file, stage: null, title: '', goal: '', completion: '', boundary: '', prompt: '', text: '新增要求', mode: 'send', redLine: false, options: {}, loopBinding: a.worker!.loop };
  assert.equal((await adapter.reply(request)).status, 'blocked');
  const calls = (await f.calls()).filter(c => c.verb !== '查询'); assert.equal(calls.length, 1); assert.ok(calls[0].args.includes('--task')); assert.equal(calls[0].args.includes('--stage'), false); assert.equal(calls[0].args.includes('--id'), false);
});

test('A5: same-name repositories never mix; same-repository worktrees are accepted; unauthorized/linked ledgers and evidence are excluded', async t => {
  const f = await kernelFixture(t), b = await f.seed(), app = await f.start();
  const first = await app.router.workers.trackLoop('p', b.batch.file, 'task-a');
  assert.equal((await app.router.workers.trackLoop('p', b.batch.file, 'task-a')).id, first.id);
  const sibling = join(await canonical(f.root), 'legal-worktree'); git(f.project, 'worktree', 'add', '--detach', sibling);
  const secondFile = join(sibling, 'card/开发卡.json'); await mkdir(dirname(secondFile)); await writeFile(secondFile, '{"version":1}');
  // Feed a second legitimate worktree, using its own repo identity in the fixture producer.
  const common = git(f.project, 'rev-parse', '--path-format=absolute', '--git-common-dir'); assert.equal(git(sibling, 'rev-parse', '--path-format=absolute', '--git-common-dir'), common);
  const loop = '/Users/Admin/Desktop/loop', isolated = join(f.root, 'isolated');
  const script = `import {repositoryIdentity} from ${JSON.stringify(`${loop}/node-ledger.ts`)}; console.log(JSON.stringify(repositoryIdentity(process.argv[1])));`;
  const identity = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, sibling], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: isolated } }));
  assert.equal(identity.common, first.worker!.loop!.repository);
  const siblingRow = { ...b, repo: sibling, runId: randomUUID(), batch: { name: b.batch.name, file: secondFile } };
  f.state.batches.push(siblingRow); await f.save();
  const siblingTask = await app.router.workers.trackLoop('p', secondFile, 'task-a');
  assert.equal(siblingTask.worker!.loop!.repository, first.worker!.loop!.repository); assert.notEqual(siblingTask.id, first.id);
  const foreign = join(await canonical(f.root), 'foreign'); await mkdir(foreign); git(foreign, 'init', '-b', 'dev'); await writeFile(join(foreign, 'file'), 'foreign'); git(foreign, 'add', '.'); git(foreign, 'commit', '-m', 'foreign');
  const outside = join(f.root, 'forbidden.txt'); await writeFile(outside, 'SYNTHETIC_OUTSIDE_BODY');
  const link = join(f.project, 'linked-evidence.txt'); await symlink(outside, link);
  const facts = (await queryLoop(f.config, app.router.files, [])).batches[0]!.kernel!;
  assert.equal((await app.router.files.read(facts.binding.ledger, [], true)).ok, false, 'protocol read did not grant raw ledger access');
  await app.router.files.registerEvidence(f.project, { link }); assert.equal((await app.router.files.read(link, [], true)).ok, false);
  const ledger = facts.binding.ledger, moved = `${ledger}.original`; await rename(ledger, moved); await symlink(outside, ledger);
  // Use the real gate directly (the producer intentionally reconstructs its own ledger on query).
  await assert.rejects(app.router.files.protocolPath(f.project, ledger));
  await rm(ledger); await rename(moved, ledger);
  const foreignFile = join(foreign, '开发卡.json'); await writeFile(foreignFile, '{"version":1}');
  const foreignRow = { ...b, repo: foreign, runId: randomUUID(), batch: { name: b.batch.name, file: foreignFile }, state: 'running', stages: [] };
  f.state.batches.push(foreignRow); await f.save();
  const safe = await queryLoop(f.config, app.router.files, []); assert.equal(safe.batches.length, 2); assert.equal(safe.batches[0]!.kernel!.binding.repository, common);
  assert.equal(safe.batches.some(row => row.batch.file === foreignFile), false, 'a source cannot self-authorize another same-name repository');
  f.config.projects.push({ id: 'p2', root: await canonical(foreign), loopRunDirs: [...f.p.loopRunDirs] });
  const foreignTask = await app.router.workers.trackLoop('p2', foreignFile, 'task-a');
  assert.notEqual(foreignTask.id, first.id); assert.notEqual(foreignTask.worker!.loop!.repository, first.worker!.loop!.repository);
  assert.equal(app.store.task(first.id)!.worker!.loop!.cardFile, b.batch.file);
  assert.equal(JSON.stringify(safe).includes('SYNTHETIC_PRIVATE_INPUT_NOT_FOR_MODEL'), false); assert.equal(JSON.stringify(f.model.requests).includes('SYNTHETIC_OUTSIDE_BODY'), false);
});

test('A6: additive JSON upgrade preserves legacy tasks, original operations/messages/confirmations/checkpoints; failure rolls back and offline backup restores', async t => {
  const f = await kernelFixture(t); let app = await f.start();
  const old: TaskCard = { id: 'legacy', title: '旧派单', goal: '保留', completion: '未知', boundary: '原权限', status: 'waiting-approval', waiting: '旧未决确认', dispatches: [{ id: 'old-operation' }], conclusion: '', updated: '2026-01-01', subscriptions: [{ kind: 'message', value: 'om-old' }, { kind: 'loop', value: join(f.project, 'missing.json') }], worker: { kind: 'loop', project: f.project, batchFile: join(f.project, 'missing.json') } };
  app.store.putTask(old); app.store.set('worker:group:legacy', { operations: ['old-operation'] }); app.store.set('worker:op:old-operation', { id: 'old-operation', state: 'planned', request: { action: 'stop', taskId: old.id, worker: 'loop' } });
  app.store.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?)').run('old-card', 'old-input', '旧已发送卡', 'sent', 'om-old');
  await f.inject({ id: 'checkpoint', text: '构造会话' }); await until(() => app.store.row('feishu:checkpoint')?.state === 'done');
  await f.stop(); const copy = join(f.root, 'offline-snapshot'); await cp(f.config.dataDir, copy, { recursive: true });
  const checkpoint = await readFile(join(copy, 'checkpoints.sqlite'));
  app = await f.start(); assert.deepEqual(app.store.task(old.id), old); assert.equal(app.store.get<any>('worker:op:old-operation', null).id, 'old-operation'); assert.equal(app.store.replies('old-input')[0]!.message_id, 'om-old');
  await assert.rejects(app.router.workers.prepare('legacy-control', 'worker_stop', { taskId: old.id }), /不能唯一核对/);
  app.store.db.exec("CREATE TRIGGER synthetic_upgrade_failure BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'constructed failure'); END;");
  assert.throws(() => app.store.applyLoopSnapshot(old, 1, 'new', () => { old.status = 'changed'; }), /constructed failure/);
  assert.equal(app.store.task('legacy')!.status, 'waiting-approval'); assert.equal(app.store.db.isTransaction, false);
  await f.stop(); await rm(f.config.dataDir, { recursive: true }); await cp(copy, f.config.dataDir, { recursive: true });
  assert.deepEqual(await readFile(join(f.config.dataDir, 'checkpoints.sqlite')), checkpoint);
  app = await f.start(); assert.equal(app.store.task(old.id)!.waiting, '旧未决确认'); assert.equal(app.store.replies('old-input').length, 1);
  assert.equal((await f.calls()).some(c => ['启动', '停止', '续跑'].includes(c.verb)), false);
});

test('A7: actual Pi path still completes a non-Git office task under original operation and once-only owner confirmation', async t => {
  const f = await fixture({ flow: [{ text: '已收到结果' }] }); t.after(() => f.close());
  const control = join(f.root, 'pi-control.json'), calls = join(f.root, 'pi-calls.jsonl');
  await writeFile(control, JSON.stringify({ delayMs: 50, summary: '构造办公任务完成' }));
  Object.assign(f.config.pi, { command: process.execPath, args: [resolve('scripts/pi-worker-stub.mjs'), '--control', control, '--calls', calls], pollMs: 30, startupMs: 300 });
  const app = await f.start(), input = { ...author('office'), text: '请核对 p 的构造办公材料，只读并交回结果。' }; app.store.enqueue(input);
  const request = { ...args, worker: 'pi', taskId: 'office', title: '构造办公查询', goal: '核对构造材料', prompt: '核对构造材料', options: '{"type":"read"}', instructionInput: input.id, instruction: input.text };
  await app.router.workers.execute(input.id, 'worker_dispatch', request); await app.router.workers.execute(input.id, 'worker_dispatch', request);
  await until(() => app.store.task('office')?.status === 'done', 12000);
  const job = app.router.workers.pi.jobs()[0]!; assert.equal(job.task, 'office'); assert.equal(app.store.task('office')!.worker!.batchFile, job.id);
  assert.equal(app.router.workers.operation(job.id)!.confirmation!.kind, 'owner-instruction');
  const status = await app.router.workers.status('office'); assert.equal(status.ok, true);
  assert.equal((await readFile(calls, 'utf8')).split('\n').filter(Boolean).map(s => JSON.parse(s)).filter(c => c.event === 'start').length, 1);
  await assert.rejects(readFile(join(f.project, '.git')));
  assert.equal(app.store.task('office')!.worker!.loop, undefined);
});

test('kernel controls: real HITL rejects stale approval; fresh child stop executes once and never touches its sibling', async t => {
  const f = await kernelFixture(t), b = await f.seed();
  f.config.intake.watch = false; f.config.intake.fallbackMs = 60000; // Change without a source signal: the execution guard must still recheck.
  const app = await f.start();
  const card = await app.router.workers.trackLoop('p', b.batch.file, 'task-a');
  const flow = { flow: [{ tools: [{ name: 'worker_stop', arguments: { taskId: card.id } }] }, { text: '已按原对象处理' }] };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify(flow) });
  await f.inject({ id: 'stop-old', text: '停止甲这项工作，别停乙。' });
  const approval = () => f.feishu.messages.find(m => m.key === `task-message:${card.id}`)?.card?.buttons.find(b => b.label === '好')?.value;
  await until(() => app.store.row('feishu:stop-old')?.state === 'waiting' && !!approval());
  const old = approval()!, message = f.feishu.messages.find(m => m.key === `task-message:${card.id}`)!;
  b.events.lastSeq++; b.tasks[0].epoch = 2; await f.save();
  await f.inject({ id: 'stale', quoteId: message.id, button: { value: old } });
  await until(() => app.store.row('feishu:stale')?.state === 'done');
  assert.equal(app.router.workers.operation(old.operation!)!.state, 'stale'); assert.equal((await f.calls()).filter(c => c.verb === '停止').length, 0);
  await f.inject({ id: 'stop-fresh', text: '按当前原身份停止甲，仍不要停乙。' });
  await until(() => app.store.row('feishu:stop-fresh')?.state === 'waiting' && approval()?.operation !== old.operation);
  const fresh = approval()!;
  await f.inject({ id: 'yes', quoteId: message.id, button: { value: fresh } }); await f.inject({ id: 'yes-again', quoteId: message.id, button: { value: fresh } });
  await until(() => app.store.row('feishu:yes-again')?.state === 'done');
  const stops = (await f.calls()).filter(c => c.verb === '停止'); assert.equal(stops.length, 1); assert.ok(stops[0].args.includes('--task')); assert.ok(stops[0].args.includes('甲'));
  await f.load(); assert.equal(f.state.batches[0].tasks[1].active, true); assert.equal(app.store.task(card.id)!.worker!.loop!.taskId, 'task-a');
});

test('kernel controls: child resume uses current --task without legacy --id/stage or replay', async t => {
  const f = await kernelFixture(t), b = await f.seed([{ id: 'task-a', name: '甲', active: false }, { id: 'task-b', name: '乙', active: true }]);
  f.config.approval.send = false; const app = await f.start(), card = await app.router.workers.trackLoop('p', b.batch.file, 'task-a');
  const reply = { taskId: card.id, mode: 'resume', text: '继续' };
  const result = await app.router.workers.execute('resume', 'worker_reply', reply) as any; assert.equal(result.status, 'sent');
  await app.router.workers.execute('resume', 'worker_reply', reply);
  const resumes = (await f.calls()).filter(c => c.verb === '续跑'); assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].args.slice(1, 3), ['--task', '甲']); assert.equal(resumes[0].args.some((a: string) => ['--id', '--stage'].includes(a)), false);
  await assert.rejects(app.router.workers.prepare('unsupported-send', 'worker_reply', { taskId: card.id, mode: 'send', text: '新增范围' }), /不能接受/);
});

test('kernel dispatch: unknown acceptance keeps repository lease across restart even when source reports no active host', async t => {
  const f = await kernelFixture(t); f.config.approval.dispatch = false; let app = await f.start();
  await app.router.workers.execute('first', 'worker_dispatch', args);
  const id = app.router.workers.journal.unresolved(args.taskId)[0]!, launch = app.router.workers.operation(id)!.request.launch!;
  await until(async () => (await observeLaunch(f.config, launch)).ended);
  await f.stop(); app = await f.start();
  const second = await app.router.workers.execute('second', 'worker_dispatch', { ...args, taskId: 'another' }) as any;
  assert.equal(second.status, 'stale'); assert.equal(app.router.workers.operation(id)!.state, 'uncertain'); assert.equal(app.router.workers.operation(id)!.resourceState, 'held');
  assert.equal((await f.calls()).filter(c => c.verb === '启动').length, 1); assert.equal((await f.calls()).filter(c => c.verb === '开工').length, 0);
});

test('A3+A4: late live-source revision cannot reconcile a newer still-uncertain original dispatch', async t => {
  const f = await kernelFixture(t); f.config.approval.dispatch = false; f.config.intake.watch = false; f.config.intake.fallbackMs = 60000;
  const ready = join(await canonical(f.root), 'ready'), exit = join(await canonical(f.root), 'exit');
  f.state.test.livePauseReady = ready; f.state.test.livePauseExit = exit; await f.save();
  const app = await f.start(); await app.router.workers.execute('original', 'worker_dispatch', args);
  const id = app.router.workers.journal.unresolved(args.taskId)[0]!;
  await writeFile(ready, 'ready'); await until(async () => (await f.calls()).some(c => c.verb === 'session-start'));
  await f.load(); const late = JSON.parse(JSON.stringify(f.state.batches[0]));
  f.state.batches[0].events.lastSeq = 9; f.state.batches[0].stages[0].session.alive = false; await f.save();
  await app.router.workers.status(args.taskId);
  assert.equal(app.store.task(args.taskId)!.sourceRevision, 9); assert.equal(app.router.workers.operation(id)!.state, 'uncertain');
  f.state.batches[0] = late; await f.save();
  const stale = await app.router.workers.status(args.taskId);
  assert.equal(stale.ok, false); assert.equal(app.router.workers.operation(id)!.state, 'uncertain'); assert.equal(app.store.task(args.taskId)!.sourceRevision, 9);
  assert.equal((await f.calls()).filter(c => c.verb === '启动').length, 1);
  await writeFile(exit, 'exit'); await until(async () => (await observeLaunch(f.config, app.router.workers.operation(id)!.request.launch!)).ended);
});

test('kernel security: malformed source identities/linked ledger and unbound legacy cards cannot grant control or model evidence', async t => {
  const f = await kernelFixture(t), b = await f.seed(), app = await f.start();
  const rawText = await import('../src/loop.js').then(m => m.command(f.config.loop.command, [...f.config.loop.args, '查询', '--all', '--json'], 3000));
  const source = JSON.parse(rawText), row = source.batches[0], outside = join(await canonical(f.root), 'outside.txt'); await writeFile(outside, 'OUTSIDE_MUST_NOT_ENTER_MODEL');
  row.results = [{ id: 'attempt', task: 'task-a', node: '测试', status: '通过', evidence: [outside, join(f.project, '.env')], operations: ['PRIVATE_SESSION_BODY'] }];
  row.userInputs = ['PRIVATE_INPUT_BODY']; row.sessions = ['PRIVATE_SESSION_BODY'];
  const receipt = join(f.root, 'readonly.json'); await writeFile(receipt, JSON.stringify(source));
  f.config.loop.args = [resolve('scripts/loop-stub.mjs'), '--state', receipt];
  const safe = await queryLoop(f.config, app.router.files, []); assert.equal(safe.batches.length, 1); assert.deepEqual(safe.batches[0]!.kernel!.evidence, { summary: row.summary });
  assert.equal(JSON.stringify(safe).includes(outside), false); assert.equal(JSON.stringify(safe).includes('PRIVATE_'), false);
  const legacy: TaskCard = { id: 'unmapped', title: b.batch.name, goal: '', completion: '', boundary: '', status: 'uncertain', waiting: '', dispatches: [], conclusion: '', updated: '', subscriptions: [], worker: { kind: 'loop', project: 'p', batchFile: b.batch.file } };
  app.store.putTask(legacy); await assert.rejects(app.router.workers.prepare('wrong-map', 'worker_stop', { taskId: legacy.id }), /未猜映射/);
  row.tasks[0].id = 'another-task'; await writeFile(receipt, JSON.stringify(source)); assert.equal((await queryLoop(f.config, app.router.files, [])).batches.length, 0);
  row.tasks[0].id = 'task-a'; const link = join(f.p.loopRunDirs[0]!, 'ledger-link.json'); await symlink(outside, link); row.ledger = link;
  await writeFile(receipt, JSON.stringify(source)); assert.equal((await queryLoop(f.config, app.router.files, [])).batches.length, 0);
  assert.equal((await app.router.files.read(outside, [], true)).ok, false);
});
