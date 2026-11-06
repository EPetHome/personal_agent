import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, writeFile, symlink, link, stat, rename, open, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture, until } from './helpers.js';
import { canonical, sleep, parseJson, hash, atomicJson } from '../src/util.js';
import { alive, signalOwned, processes, privateJson } from '../src/pi-process.js';
import { scriptModel, type Script } from '../src/stubs/servers.js';
import { loadConfig } from '../src/config.js';
import { ScopedFiles } from '../src/file-policy.js';
import type { App } from '../src/app.js';
import type { WorkerAdapter, WorkerRequest, WorkerSnapshot } from '../src/worker.js';
import type { PiJob } from '../src/pi.js';

const args = { worker: 'pi', taskId: 'pi-task', project: 'p', title: '查构造事实', goal: '查清构造文件事实', completion: '给出依据及未知项', boundary: '只读授权项目，不联网，不跑命令', prompt: '查构造文件', options: JSON.stringify({ type: 'read' }) };
const dispatch = (arguments_: Record<string, unknown> = args): NonNullable<Script['flow']> => [{ tools: [{ name: 'worker_dispatch', arguments: arguments_ }] }, { text: '已受理' }];
async function piFixture(t: TestContext, script: Script = { turns: [dispatch(), [{ text: '事实已收到' }]] }) {
  const f = await fixture(script), control = join(f.root, 'pi-control.json'), callsFile = join(f.root, 'pi-calls.jsonl');
  Object.assign(f.config.pi, { command: process.execPath, args: [resolve('scripts/pi-worker-stub.mjs'), '--control', control, '--calls', callsFile], pollMs: 50, startupMs: 300 });
  await writeFile(control, JSON.stringify({ delayMs: 150 }));
  const calls = async () => (await readFile(callsFile, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e; })).split('\n').filter(Boolean).map(s => parseJson<Record<string, any>>(s));
  let app: App | undefined;
  const start = async () => {
    // Mutated fixture Config has the same canonical-root contract as loadConfig.
    for (const project of f.config.projects) if (project.pi) project.pi.writeDirs = await Promise.all(project.pi.writeDirs.map(canonical));
    return app = await f.start();
  };
  const stop = async () => { await f.stop(); app = undefined; };
  const done = (id = 'pi-task', status = 'done') => until(() => app?.store.task(id)?.status === status && f.feishu.messages.some(m => m.key === `task-message:${id}` && m.text.includes(status === 'timed-out' ? '超时' : status === 'needs-decision' ? '需要你决定' : '构造 Pi 结果')), 12000);
  const approval = (id = 'pi-task') => f.feishu.messages.find(m => m.key === `task-message:${id}`)?.card?.buttons.find(b => b.value.pa === 'worker' && b.value.choice === 'approve');
  const click = async (id = 'pi-task', event = `approve-${id}`) => { const message = f.feishu.messages.find(m => m.key === `task-message:${id}`)!; await f.inject({ id: event, quoteId: message.id, button: { value: approval(id)!.value } }); };
  t.after(async () => {
    try {
      if (app) {
        for (const job of app.router.workers.pi.jobs()) if (['queued', 'launching', 'running'].includes(job.state)) await app.router.workers.pi.stop({ ...job.request, batchFile: job.id, action: 'stop' });
        await until(async () => { await app!.router.workers.pi.tick(); return app!.router.workers.pi.jobs().every(j => !['queued', 'launching', 'running'].includes(j.state)); }, 10000);
        for (const job of app.router.workers.pi.jobs()) if (job.binding?.child) assert.equal(await alive(job.binding.child), false, 'test child cleaned');
      }
    } finally {
      // A failed stop regression must still close its test App and clean only its
      // recorded supervisors; normal production App.stop still never kills Pi.
      try {
        if (app) for (const job of app.router.workers.pi.jobs()) if (job.binding) {
          await signalOwned(job.binding.wrapper, 'SIGUSR1');
          await until(async () => !await alive(job.binding!.wrapper) && !await alive(job.binding!.child));
        }
      } finally { await f.close(); }
    }
  });
  return { ...f, start, stop, control, calls, callsFile, done, approval, click, get app() { return app!; } };
}

/** Force a real rename between opening a receipt and fstat; never fake the
 * metadata/error or bypass the actual privateJson/monitor implementation. */
async function receiptReadRace(t: TestContext, probePath: string, replace: (info: Stats) => Promise<void>) {
  const probe = await open(probePath, 'r'), prototype = Object.getPrototypeOf(probe), original = probe.stat; await probe.close();
  return t.mock.method(prototype, 'stat', async function (this: FileHandle, ...args: unknown[]) {
    // SAFETY: the exercised readers use FileHandle.stat() without bigint options;
    // the original syscall supplies both metadata snapshots, not test data.
    const info: Stats = await Reflect.apply(original, this, args);
    await replace(info);
    return Reflect.apply(original, this, args);
  });
}

async function editableQuestion(t: TestContext, retry = false) {
  const f = await piFixture(t), docs = join(f.project, 'docs'); await mkdir(docs);
  const file = join(docs, 'editable.md'); await writeFile(file, 'VERSION_ONE');
  f.config.projects[0]!.pi = { writeDirs: [docs], skills: {} };
  const reply = [{ tools: [{ name: 'worker_reply', arguments: { taskId: 'pi-task', mode: 'send', text: '按方案甲继续' } }] }, { text: '本次答复已处理' }];
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [dispatch({ ...args, options: JSON.stringify({ type: 'write', writeDirs: [docs], editFiles: [file] }) }), [{ text: '问题已呈现' }], reply, retry ? reply : [{ text: '结果已收到' }], [{ text: '结果已收到' }]] }) });
  await writeFile(f.control, JSON.stringify({ status: 'needs-decision', question: '按甲还是乙继续？', delayMs: 50 }));
  const app = await f.start(); await f.inject({ id: 'editable-start', text: '派 Pi 处理指定文件，取舍先问我' }); await until(() => !!f.approval()); await f.click(); await f.done('pi-task', 'needs-decision');
  const first = app.router.workers.pi.jobs()[0]!;
  await until(() => app.store.row(`pi:${first.id}:result`)?.state === 'done');
  await writeFile(f.control, JSON.stringify({ delayMs: 50 }));
  const answer = async (id: string) => {
    await f.inject({ id, quoteId: f.feishu.messages[0]!.id, text: '按方案甲继续' });
    await until(() => {
      const value = f.approval()?.value, op = value?.operation ? f.app.router.workers.operation(value.operation) : null;
      return op?.state === 'planned' && op.request.action === 'reply';
    });
    return f.approval()!.value.operation!;
  };
  return { f, file, docs, first, answer };
}

for (const type of ['read', 'write'] as const) test(`丙 A${type === 'read' ? '1' : '2'}: PA dispatches REAL Pi, ${type === 'read' ? 'secret read and cat are denied' : 'out-of-scope write is denied'}`, async t => {
  const f = await piFixture(t), docs = join(f.project, 'docs'), secret = join(f.project, '.ssh/id_rsa'), outside = join(f.project, 'outside.txt');
  await mkdir(docs); await mkdir(join(f.project, '.ssh')); await writeFile(secret, 'SYNTHETIC_SECRET_NEVER_EXPOSE');
  const options = { type, ...(type === 'write' ? { writeDirs: [docs] } : {}) };
  f.config.projects[0]!.pi = { writeDirs: [docs], skills: {} };
  const localPiModel = await scriptModel({ requireReasoning: true, flow: type === 'read' ? [
    { tools: [{ name: 'pa_read', arguments: { path: secret } }] },
    { tools: [{ name: 'bash', arguments: { command: `cat '${secret}'` } }] },
    { text: '{"status":"done","summary":"两种读法均未读到","evidence":[]}' },
  ] : [{ tools: [{ name: 'pa_write', arguments: { path: outside, content: 'NOT_ALLOWED' } }] }, { text: '{"status":"done","summary":"范围外未写入","evidence":[]}' }] }); t.after(() => localPiModel.close());
  Object.assign(f.config.pi, { command: 'pi', args: [], model: { url: `${localPiModel.url}/v1`, name: 'script-model' }, startupMs: 1500 });
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [dispatch({ ...args, options: JSON.stringify(options) }), [{ text: '已收到 Pi 结果' }]] }) });
  const app = await f.start(); await f.inject({ id: 'real-pi', text: '派 Pi 做构造任务' }); await until(() => !!f.approval());
  assert.equal(app.router.workers.pi.jobs().length, 0, 'approval before ANY subprocess'); await f.click();
  await until(async () => {
    const job = app.router.workers.pi.jobs()[0];
    if (job?.outcome && job.state !== 'done') assert.fail(`${job.state}: ${job.outcome.answer.summary}\n${await readFile(join(app.router.workers.pi.dir(job.id), 'stderr.log'), 'utf8')}\n${await readFile(join(app.router.workers.pi.dir(job.id), 'stdout.jsonl'), 'utf8')}`);
    return app.store.task('pi-task')?.status === 'done';
  }, 15000);
  const job = app.router.workers.pi.jobs()[0]!, dir = app.router.workers.pi.dir(job.id);
  assert.equal(job.outcome?.cleaned, true); assert.equal(await alive(job.binding!.child), false);
  await until(async () => !await alive(job.binding!.wrapper));
  assert.equal((await processes()).some(p => p.pgid === job.binding!.wrapper.pgid && !p.state.includes('Z')), false);
  assert.match(await readFile(join(dir, 'permissions.jsonl'), 'utf8'), /"kind":"denied"/);
  assert.equal(JSON.stringify(localPiModel.requests).includes('SYNTHETIC_SECRET_NEVER_EXPOSE'), false);
  if (type === 'read') {
    assert.equal(localPiModel.requests.length, 3);
    for (const request of localPiModel.requests) assert.ok(request.body.tools.every((tool: any) => !['bash', 'pa_bash', 'pa_fetch'].includes(tool.function.name)));
    assert.equal((await readFile(join(dir, 'stdout.jsonl'), 'utf8')).includes('SYNTHETIC_SECRET_NEVER_EXPOSE'), false);
  } else await assert.rejects(stat(outside), { code: 'ENOENT' });
});

test('丙 A3: 30-second hung Pi timeout kills owned process group including descendants, reports once, never redispatches', { timeout: 45000 }, async t => {
  const f = await piFixture(t); f.config.pi.timeoutMs = 30000; f.config.approval.readPi = false;
  await writeFile(f.control, JSON.stringify({ hang: true, child: true })); const app = await f.start();
  await f.inject({ id: 'hang', text: '派一次只读查询' }); await until(async () => (await f.calls()).some(c => c.event === 'child'));
  await until(() => {
    const job = app.router.workers.pi.jobs()[0]!;
    if (job.outcome && job.state !== 'timed-out') assert.fail(JSON.stringify({ state: job.state, outcome: job.outcome, card: app.store.task('pi-task')?.status }));
    return app.store.task('pi-task')?.status === 'timed-out';
  }, 35000);
  await until(() => f.feishu.messages[0]?.text.includes('超时') === true);
  const job = app.router.workers.pi.jobs()[0]!; assert.equal(job.outcome?.cleaned, true);
  await until(async () => !(await processes()).some(p => p.pgid === job.binding!.wrapper.pgid && !p.state.includes('Z')));
  const starts = (await f.calls()).filter(c => c.event === 'start'); assert.equal(starts.length, 1);
  await sleep(250); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1); assert.equal(f.feishu.messages.length, 1);
});

test('丙 A4: actual PA OS process stops/restarts without killing Pi; original card gets one result', async t => {
  const f = await piFixture(t); await writeFile(f.control, JSON.stringify({ delayMs: 2200 }));
  const raw = { ...f.raw, pi: f.config.pi, approval: { readPi: false } }; await writeFile(f.configPath, JSON.stringify(raw));
  const launch = () => spawn(process.execPath, [resolve('dist/src/main.js'), '--config', f.configPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  let pa = launch();
  const stop = async () => { if (pa.exitCode !== null || pa.signalCode) return; pa.kill('SIGTERM'); await new Promise(accept => pa.once('close', accept)); };
  t.after(stop);
  await f.inject({ id: 'survive', text: '只读派工后重启 PA' }); await until(async () => (await f.calls()).some(c => c.event === 'start'), 12000);
  const started = (await f.calls()).find(c => c.event === 'start')!, dir = join(f.config.dataDir, 'pi-jobs', started.operation), binding = parseJson<any>(await readFile(join(dir, 'identity.json'), 'utf8'));
  await stop(); assert.equal(await alive(binding.child), true); assert.equal(await alive(binding.wrapper), true);
  pa = launch(); await until(() => f.feishu.messages[0]?.text.includes('构造 Pi 结果') === true, 12000);
  await sleep(250); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1); assert.equal(f.feishu.messages.length, 1);
  assert.equal(f.feishu.messages[0]!.updates?.filter(text => text.includes('构造 Pi 结果')).length, 1);
  await stop();
});

test('丙 A5: five read dispatches run at most three Pi children, two queue; each reports', async t => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({ ...args, taskId: `read-${i}` }));
  const f = await piFixture(t, { turns: [[{ tools: tasks.map(arguments_ => ({ name: 'worker_dispatch', arguments: arguments_ })) }, { text: '已派' }], ...tasks.map(() => [{ text: '结果已收' }])] });
  f.config.approval.readPi = false; await writeFile(f.control, JSON.stringify({ delayMs: 900 })); const app = await f.start();
  await f.inject({ id: 'five', text: '同时派五个只读查询' });
  await until(() => app.router.workers.pi.jobs().length === 5 && app.router.workers.pi.jobs().filter(j => j.state === 'queued').length === 2);
  assert.equal((await f.calls()).filter(c => c.event === 'start').length <= 3, true);
  await until(() => {
    for (const job of app.router.workers.pi.jobs()) if (job.outcome && job.state !== 'done') assert.fail(JSON.stringify({ state: job.state, answer: job.outcome.answer }));
    return tasks.every(task => app.store.task(task.taskId)?.status === 'done');
  }, 15000);
  const calls = await f.calls(); let live = 0, max = 0;
  for (const call of calls) { if (call.event === 'start') max = Math.max(max, ++live); if (call.event === 'end') live--; }
  assert.equal(max, 3); assert.equal(live, 0); assert.equal(calls.filter(c => c.event === 'start').length, 5);
  assert.ok(calls.filter(c => c.event === 'start').every(c => !c.inheritedSecrets.length));
  await until(() => f.feishu.messages.filter(m => m.text.includes('构造 Pi 结果')).length === 5);
});

test('丙 A6: default read approval starts nothing; duplicate callback starts one process', async t => {
  const f = await piFixture(t), app = await f.start(); await f.inject({ id: 'ask-first', text: '派 Pi 查事实' }); await until(() => !!f.approval());
  assert.equal((await f.calls()).length, 0); assert.equal(app.router.workers.pi.jobs().length, 0);
  const message = f.feishu.messages[0]!, value = f.approval()!.value; await f.click();
  await f.inject({ id: 'again', quoteId: message.id, button: { value } }); await f.done(); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1);
});

test('丙 A7: readPi=false loaded from file skips approval and marks the original finished card 已直接处理', async t => {
  const f = await piFixture(t);
  await writeFile(f.configPath, JSON.stringify({ ...f.raw, pi: f.config.pi, approval: { readPi: false } })); Object.assign(f.config, await loadConfig(f.configPath));
  const app = await f.start(); await f.inject({ id: 'direct', text: '派只读 Pi' }); await f.done();
  assert.equal(app.store.db.prepare("SELECT 1 FROM inputs WHERE state='waiting'").get(), undefined);
  assert.ok(f.feishu.messages.every(m => !m.card?.buttons.some(b => b.value.pa === 'worker'))); assert.match(f.feishu.messages[0]!.text, /已直接处理/); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1);
});

test('丙 A8: redLine=false configuration cannot enable merge; unavailable card and no worker execution', async t => {
  const f = await piFixture(t, { flow: [{ tools: [{ name: 'task_card', arguments: { id: 'red', cause: '请求合入', assessment: '合入是上线', suggestion: '请本人点头；当前不可用，请回电脑操作', buttons: '合入' } }] }, { text: '请回电脑操作' }] });
  await writeFile(f.configPath, JSON.stringify({ ...f.raw, pi: f.config.pi, approval: { dispatch: false, redLine: false, merge: false } }));
  await assert.rejects(loadConfig(f.configPath), /未知|不生效/);
  await writeFile(f.configPath, JSON.stringify({ ...f.raw, pi: f.config.pi, approval: { dispatch: false, redLine: false } })); Object.assign(f.config, await loadConfig(f.configPath));
  const app = await f.start(); app.store.putTask({ id: 'red', title: '合入请求', goal: '请求合入', completion: '本人明确点头', boundary: '不合入', status: 'done', waiting: '', dispatches: [], conclusion: '', updated: new Date().toISOString(), subscriptions: [] });
  await f.inject({ id: 'merge', text: '合入' }); await until(() => f.feishu.messages.some(m => m.card?.buttons.some(b => b.label.includes('合入') && b.disabled)));
  assert.equal(f.config.approval.redLine, true); assert.equal((await f.calls()).length, 0); assert.ok(f.feishu.messages.some(m => m.text.includes('当前不可用')));
});

test('丙 A9: owner asks to make reads direct; script sees system instructions naming approval.readPi, config unchanged', async t => {
  const f = await piFixture(t, { flow: [{ tools: [{ name: 'reply', arguments: { text: '请在启动 --config 的配置文件里手改 approval.readPi 为 false，正常重启生效；我不会修改配置。' } }] }, { text: 'done' }] });
  const before = await readFile(f.configPath, 'utf8'); const app = await f.start(); await f.inject({ id: 'preference', text: '派 Pi 查东西这类以后直接做' }); await until(() => app.store.row('feishu:preference')?.state === 'done');
  assert.equal(await readFile(f.configPath, 'utf8'), before); assert.match(f.feishu.messages[0]!.text, /approval\.readPi/);
  assert.match(f.model.requests[0]!.body.messages[0].content, /不改配置/); assert.match(f.model.requests[0]!.body.messages[0].content, /approval\.readPi/); assert.equal((await f.calls()).length, 0);
});

test('Pi needs-decision result ends process, owner answer dispatches a new ID on the same task, no auto-retry', async t => {
  const f = await piFixture(t, { turns: [dispatch(), [{ text: '问题已呈现' }], [{ tools: [{ name: 'worker_reply', arguments: { taskId: 'pi-task', mode: 'send', text: '选择方案甲' } }] }, { text: '已重派' }], [{ text: '已收到' }]] });
  await writeFile(f.control, JSON.stringify({ status: 'needs-decision', question: '甲还是乙？', delayMs: 100 })); const app = await f.start();
  await f.inject({ id: 'question', text: '查询后需要决定' }); await until(() => !!f.approval()); await f.click(); await f.done('pi-task', 'needs-decision');
  const first = app.router.workers.pi.jobs()[0]!; assert.equal(await alive(first.binding!.child), false); await sleep(150); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1);
  await writeFile(f.control, JSON.stringify({ delayMs: 100 })); await f.inject({ id: 'answer', quoteId: f.feishu.messages[0]!.id, text: '选择方案甲' }); await until(() => !!f.approval()); await f.click('pi-task', 'approve-answer'); await f.done();
  const jobs = app.router.workers.pi.jobs(); assert.equal(jobs.length, 2); assert.notEqual(jobs[0]!.id, jobs[1]!.id); assert.equal(app.store.taskTable().length, 1); assert.match(jobs[1]!.request.prompt, /选择方案甲/); assert.equal(f.feishu.messages.length, 1);
});

test('Pi scopes: recursive search, links, hard links, PEM files, attachment origins, evidence and config cannot bypass blacklist', async t => {
  const f = await piFixture(t), app = await f.start();
  const safe = join(f.project, 'safe.txt'); await writeFile(safe, 'SAFE_NEEDLE');
  const ssh = join(f.root, '.ssh'); await mkdir(ssh); await writeFile(join(ssh, 'id_rsa'), 'PRIVATE_NEEDLE');
  await symlink(ssh, join(f.project, 'alias')); await link(join(ssh, 'id_rsa'), join(f.project, 'hard.txt'));
  await writeFile(join(f.project, 'plain.txt'), '-----BEGIN PRIVATE KEY-----\nPRIVATE_NEEDLE');
  const attachment = join(f.config.attachmentDir, 'renamed.txt'); await mkdir(f.config.attachmentDir, { recursive: true }); await writeFile(attachment, 'PRIVATE_NEEDLE'); app.store.set(`attachment-origin:${await canonical(attachment)}`, { name: '.env' });
  const scoped = new ScopedFiles(await app.router.files.policy(f.config.projects[0]!.root));
  for (const path of [join(f.project, 'alias/id_rsa'), join(f.project, 'hard.txt'), join(f.project, 'plain.txt'), attachment, f.configPath]) await assert.rejects(scoped.read(path));
  const matches = await scoped.search(f.project, 'NEEDLE', true); assert.ok(JSON.stringify(matches).includes('SAFE_NEEDLE')); assert.equal(JSON.stringify(matches).includes('PRIVATE_NEEDLE'), false);
  const evidence = join(f.run, 'proof.txt'), adjacent = join(f.run, 'other.txt'); await writeFile(evidence, 'EVIDENCE'); await writeFile(adjacent, 'PRIVATE_NEEDLE'); await app.router.files.registerEvidence(f.project, { proof: evidence });
  const withEvidence = new ScopedFiles(await app.router.files.policy(f.config.projects[0]!.root)); assert.equal((await withEvidence.read(evidence)).content, 'EVIDENCE'); await assert.rejects(withEvidence.read(adjacent));
});

test('Pi skills serialize globally; overlapping write directories serialize by real path; different write directories run together', async t => {
  const f = await piFixture(t, { flow: [{ text: 'quiet' }] }), docs = join(f.project, 'docs'), other = join(f.project, 'other'); await mkdir(docs); await mkdir(other);
  const skill = join(f.project, 'SKILL.md'); await writeFile(skill, '# 构造技能\n只输出构造结果'); f.config.projects[0]!.pi = { writeDirs: [docs, other], skills: { sample: skill } }; f.config.approval.dispatch = false;
  await writeFile(f.control, JSON.stringify({ delayMs: 700 })); const app = await f.start();
  const run = (id: string, options: object) => app.router.workers.execute(id, 'worker_dispatch', { ...args, taskId: id, options: JSON.stringify(options) });
  await Promise.all([run('skill1', { type: 'skill', skill: 'sample' }), run('skill2', { type: 'skill', skill: 'sample' })]);
  assert.equal(app.router.workers.pi.jobs().filter(j => j.state === 'queued').length, 1);
  await Promise.all([run('write1', { type: 'write', writeDirs: [docs] }), run('write2', { type: 'write', writeDirs: [join(docs, 'nested')] }), run('write3', { type: 'write', writeDirs: [other] })]);
  assert.equal(app.router.workers.pi.jobs().filter(j => j.state === 'queued').length, 2);
  await until(() => app.router.workers.pi.jobs().every(j => j.state === 'done'), 12000);
  assert.equal((await f.calls()).filter(c => c.event === 'start').length, 5);
});

test('Pi capabilities require explicit approval even with dispatch/read switches off; readonly cannot request shell or network', async t => {
  const f = await piFixture(t, { flow: [{ text: 'quiet' }] }), docs = join(f.project, 'docs'); await mkdir(docs); f.config.projects[0]!.pi = { writeDirs: [docs], skills: {} }; f.config.approval.dispatch = false; f.config.approval.readPi = false;
  const app = await f.start(), worker = app.router.workers;
  for (const options of [{ type: 'write', writeDirs: [docs], commands: true }, { type: 'write', writeDirs: [docs], network: true }]) {
    const a = { ...args, options: JSON.stringify(options) }; assert.equal(worker.needsApproval('worker_dispatch', a), true);
    const op = await worker.prepare(JSON.stringify(options), 'worker_dispatch', a); assert.equal(worker.view(op).redLine, true); assert.match(worker.view(op).description, /true/);
    assert.equal((await worker.execute(JSON.stringify(options), 'worker_dispatch', a) as any).ok, false);
  }
  await assert.rejects(worker.prepare('read-shell', 'worker_dispatch', { ...args, options: '{"type":"read","commands":true}' })); assert.equal((await f.calls()).length, 0);
});

test('Pi REAL positive path: authorized read, new file and exact-version red-line edit; no unapproved capability appears', async t => {
  const f = await piFixture(t), docs = join(f.project, 'docs'); await mkdir(docs);
  const existing = join(docs, 'existing.md'), created = join(docs, 'new.md'); await writeFile(existing, 'BEFORE_SAFE'); f.config.projects[0]!.pi = { writeDirs: [docs], skills: {} };
  const model = await scriptModel({ requireReasoning: true, flow: [
    { tools: [{ name: 'pa_read', arguments: { path: existing } }] },
    { tools: [{ name: 'pa_write', arguments: { path: created, content: 'NEW_SAFE' } }] },
    { tools: [{ name: 'pa_edit', arguments: { path: existing, oldText: 'BEFORE_SAFE', newText: 'AFTER_SAFE' } }] },
    { text: JSON.stringify({ status: 'done', summary: '构造 Pi 结果', evidence: [created] }) },
  ] }); t.after(() => model.close());
  Object.assign(f.config.pi, { command: 'pi', args: [], model: { url: `${model.url}/v1`, name: 'script-model' }, startupMs: 1500 });
  const options = { type: 'write', writeDirs: [docs], editFiles: [existing] };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [dispatch({ ...args, options: JSON.stringify(options) }), [{ text: '已收到' }]] }) });
  const app = await f.start(); await f.inject({ id: 'positive', text: '明确批准创建和修改这两个构造文件' }); await until(() => !!f.approval());
  assert.equal(app.router.workers.pi.jobs().length, 0); assert.match(f.feishu.messages[0]!.text, /editFiles/); await f.click(); await f.done();
  assert.equal(await readFile(created, 'utf8'), 'NEW_SAFE'); assert.equal(await readFile(existing, 'utf8'), 'AFTER_SAFE');
  assert.ok(JSON.stringify(model.requests).includes('BEFORE_SAFE')); assert.ok(model.requests.every(r => !r.body.tools.some((tool: any) => ['pa_bash', 'pa_fetch'].includes(tool.function.name))));
});

test('Pi restart: missing original process is reported interrupted once, without respawn', async t => {
  const f = await piFixture(t); f.config.approval.readPi = false; await writeFile(f.control, JSON.stringify({ hang: true })); let app = await f.start();
  await f.inject({ id: 'interruption', text: '派只读 Pi' }); await until(async () => (await f.calls()).some(c => c.event === 'start'));
  const job = app.router.workers.pi.jobs()[0]!; await until(() => !!app.router.workers.pi.job(job.id)?.binding?.child); const binding = app.router.workers.pi.job(job.id)!.binding!;
  await f.stop(); await signalOwned(binding.child!, 'SIGKILL'); await until(async () => !await alive(binding.wrapper));
  app = await f.start(); await until(() => app.store.task('pi-task')?.status === 'interrupted'); await until(() => f.feishu.messages[0]?.text.includes('中断') === true);
  assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1); await f.stop(); app = await f.start(); await sleep(150);
  assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1); assert.equal(f.feishu.messages[0]!.updates?.filter(text => text.includes('中断')).length, 1);
});

test('Pi stop is identity-bound; stale PID/start identity never signals a live unrelated process', async t => {
  const f = await piFixture(t); f.config.approval.readPi = false; await writeFile(f.control, JSON.stringify({ hang: true, child: true })); const app = await f.start();
  await f.inject({ id: 'stop-owned', text: '派只读 Pi' }); await until(async () => (await f.calls()).some(c => c.event === 'child'));
  const job = app.router.workers.pi.jobs()[0]!; await until(() => !!app.router.workers.pi.job(job.id)?.binding?.child);
  const binding = app.router.workers.pi.job(job.id)!.binding!;
  assert.equal(await signalOwned({ ...binding.child!, started: 'different process start' }, 'SIGKILL'), false); assert.equal(await alive(binding.child), true);
  const request: WorkerRequest = { ...job.request, batchFile: job.id, action: 'stop' };
  assert.equal((await app.router.workers.pi.stop(request)).status, 'sent'); await until(() => app.store.task('pi-task')?.status === 'stopped');
  assert.equal(await alive(binding.child), false); await until(async () => !await alive(binding.wrapper)); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1);
});

test('Pi queued work persists across restart; owner cancellation and changed definitions prevent stale queued starts', async t => {
  const f = await piFixture(t, { flow: [{ text: 'quiet' }] }); f.config.approval.readPi = false; f.config.concurrency.read = 1; await writeFile(f.control, JSON.stringify({ delayMs: 700 })); let app = await f.start();
  for (const taskId of ['one', 'two', 'three']) await app.router.workers.execute(taskId, 'worker_dispatch', { ...args, taskId });
  assert.equal(app.router.workers.pi.jobs().filter(j => j.state === 'queued').length, 2);
  const card = app.store.task('two')!; card.status = 'cancelled'; app.store.putTask(card);
  const changed = app.store.task('three')!; changed.goal = '本人更改后的目标'; app.store.putTask(changed);
  await f.stop(); app = await f.start();
  await until(() => app.router.workers.pi.jobs().every(j => !['queued', 'launching', 'running'].includes(j.state)));
  assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1); assert.equal(app.store.task('two')!.status, 'cancelled');
  await until(() => app.store.task('three')?.status === 'failed'); assert.match(app.store.task('three')!.notice!, /定义或权限已变化/);
});

test('Pi narrower readAllow cannot be expanded by per-job readPaths; out-of-scope writes, symlinks and unapproved edits fail', async t => {
  const f = await piFixture(t), app = await f.start(), docs = join(f.project, 'docs'); await mkdir(docs); await writeFile(join(docs, 'file.md'), 'KEEP');
  const outer = join(f.project, 'outer.txt'); await writeFile(outer, 'DO_NOT_READ'); f.config.readAllow = [await canonical(docs)];
  const scoped = new ScopedFiles(await app.router.files.policy(f.config.projects[0]!.root, [await canonical(docs)], [f.project]));
  await assert.rejects(scoped.read(outer)); assert.equal((await scoped.read(join(docs, 'file.md'))).content, 'KEEP');
  await assert.rejects(scoped.write(outer, 'NO')); await assert.rejects(scoped.edit(join(docs, 'file.md'), 'KEEP', 'NO')); await assert.rejects(scoped.write(join(docs, 'file.md'), 'NO'));
  await symlink(f.root, join(docs, 'escape')); await assert.rejects(scoped.write(join(docs, 'escape/outside.txt'), 'NO'));
  assert.equal(await readFile(join(docs, 'file.md'), 'utf8'), 'KEEP');
});

test('Pi event observed during normal PA stop is durable before emitted marker; restart receives it once', async t => {
  const f = await piFixture(t); f.config.approval.readPi = false; await writeFile(f.control, JSON.stringify({ delayMs: 80 })); let app = await f.start();
  await f.inject({ id: 'shutdown-race', text: '派只读 Pi' }); await until(() => app.router.workers.pi.jobs().length === 1);
  const job = app.router.workers.pi.jobs()[0]!;
  // Hold the already-started poll until stop has closed external intake, then emit.
  const adapter = app.router.workers.pi, poll = adapter.poll.bind(adapter); let entered = false, release!: () => void;
  const gate = new Promise<void>(accept => { release = accept; });
  adapter.poll = async emit => { entered = true; await gate; await poll(emit); };
  await until(() => entered); const stopping = f.stop(); await until(async () => { const r = await readFile(join(adapter.dir(job.id), 'result.json'), 'utf8').catch(() => ''); return !!r; }); release(); await stopping;
  app = await f.start(); await until(() => app.store.task('pi-task')?.status === 'done');
  assert.ok(app.store.row(`pi:${job.id}:result`)); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1);
});

for (const capability of ['commands', 'network'] as const) test(`Pi REAL capability grant: ${capability} requires explicit red-line consent and remains independent`, async t => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('LOCAL_NETWORK_OK'); }); await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture`;
  const f = await piFixture(t), docs = join(f.project, 'docs'); await mkdir(docs); f.config.projects[0]!.pi = { writeDirs: [docs], skills: {} }; f.config.approval.dispatch = false;
  const action = capability === 'network' ? { name: 'pa_fetch', arguments: { url } } : { name: 'pa_bash', arguments: { command: `/usr/bin/curl --max-time 1 '${url}' >/dev/null 2>&1; printf PA_COMMAND_OK` } };
  const model = await scriptModel({ requireReasoning: true, flow: [{ tools: [action] }, { text: '{"status":"done","summary":"构造 Pi 结果"}' }] }); t.after(() => model.close());
  Object.assign(f.config.pi, { command: 'pi', args: [], model: { url: `${model.url}/v1`, name: 'script-model' }, startupMs: 1500 });
  const options = { type: 'write', writeDirs: [docs], [capability]: true };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [dispatch({ ...args, options: JSON.stringify(options) }), [{ text: '已收到' }]] }) });
  const app = await f.start(); await f.inject({ id: capability, text: '本次明确许可指定能力，仅测试构造环境' }); await until(() => !!f.approval());
  assert.equal(app.router.workers.pi.jobs().length, 0); assert.match(f.feishu.messages[0]!.text, /红线权限须明确点头/); await f.click(); await f.done();
  const returned = JSON.stringify(model.requests.at(-1)!.body.messages);
  assert.match(returned, capability === 'network' ? /LOCAL_NETWORK_OK/ : /PA_COMMAND_OK/);
  assert.equal(requests, capability === 'network' ? 1 : 0);
  for (const req of model.requests) assert.equal(req.body.tools.some((tool: any) => tool.function.name === (capability === 'network' ? 'pa_bash' : 'pa_fetch')), false);
});

test('Pi fixed authorization roots cannot be redirected by replacing an approved write directory with a symlink', async t => {
  const f = await piFixture(t, { flow: [{ text: 'quiet' }] }), docs = join(f.project, 'docs'), other = join(f.project, 'not-approved'); await mkdir(docs); await mkdir(other);
  f.config.projects[0]!.pi = { writeDirs: [docs], skills: {} }; const app = await f.start();
  await rename(docs, join(f.project, 'original-docs')); await symlink(other, docs);
  await assert.rejects(app.router.workers.prepare('redirected-root', 'worker_dispatch', { ...args, options: JSON.stringify({ type: 'write', writeDirs: [docs] }) }), /写入范围/);
  assert.equal((await f.calls()).length, 0);
});

test('Pi preparation failure is reported once and never starts/retries a subprocess', async t => {
  const f = await piFixture(t, { flow: [{ text: 'quiet' }] }), app = await f.start(); f.config.approval.readPi = false;
  f.config.model.auth.type = 'env'; f.config.model.auth.variable = `PA_TEST_ABSENT_${Date.now()}`;
  await app.router.workers.execute('missing-key', 'worker_dispatch', args);
  const job = app.router.workers.pi.jobs()[0]!; assert.equal(job.state, 'failed'); assert.equal(job.outcome?.cleaned, true);
  await app.router.workers.pi.tick(); await app.router.workers.pi.tick(); assert.equal((await f.calls()).length, 0); assert.equal(app.router.workers.pi.jobs().length, 1);
});

test('Pi restart rejects a mismatched result token rather than claiming done or redispatching', async t => {
  const f = await piFixture(t); f.config.approval.readPi = false; let app = await f.start(); await f.inject({ id: 'tampered-receipt', text: '派只读 Pi' });
  await until(async () => (await f.calls()).some(c => c.event === 'start')); const job = app.router.workers.pi.jobs()[0]!, dir = app.router.workers.pi.dir(job.id);
  await f.stop(); await until(async () => { try { await stat(join(dir, 'result.json')); return true; } catch { return false; } });
  const result = parseJson<Record<string, unknown>>(await readFile(join(dir, 'result.json'), 'utf8')); result.token = 'not-original-token'; await writeFile(join(dir, 'result.json'), JSON.stringify(result));
  app = await f.start(); await until(() => app.store.task('pi-task')?.status === 'interrupted'); assert.equal(app.router.workers.pi.job(job.id)!.outcome?.cleaned, false);
  assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1); assert.match(app.store.task('pi-task')!.notice!, /无法核实/);
});

test('C R1: pending reply binds edit versions across restart; changed files stale the old approval and a fresh approval still works', async t => {
  const { f, file, answer } = await editableQuestion(t, true), operation = await answer('version-answer');
  await f.stop(); await writeFile(file, 'VERSION_TWO'); const app = await f.start();
  await f.click('pi-task', 'old-version-confirmation'); await until(() => app.store.row('feishu:old-version-confirmation')?.state === 'done');
  assert.equal(app.router.workers.operation(operation)!.state, 'stale', 'an old reply approval must not authorize a newly observed file version');
  assert.equal(app.router.workers.pi.jobs().length, 1); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1); assert.equal(await readFile(file, 'utf8'), 'VERSION_TWO');
  const fresh = await answer('fresh-version-answer'); assert.notEqual(fresh, operation);
  await f.click('pi-task', 'fresh-version-confirmation'); await f.done();
  const next = app.router.workers.pi.jobs().find(j => j.id === fresh)!; assert.ok(next); assert.equal(next.plan.policy.edit?.[await canonical(file)], hash('VERSION_TWO'));
  // Use exactly the generated worker policy: only the newly approved version may be edited.
  await new ScopedFiles(next.plan.policy).edit(file, 'VERSION_TWO', 'VERSION_TWO_APPROVED'); assert.equal(await readFile(file, 'utf8'), 'VERSION_TWO_APPROVED');
  assert.equal(app.store.taskTable().length, 1); assert.equal(f.feishu.messages.length, 1); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 2);
});

test('C R1: a file change after worker execution recheck but before reply enqueue cannot silently reauthorize the new version', async t => {
  const { f, file, answer } = await editableQuestion(t), operation = await answer('enqueue-gap-answer'), adapter = f.app.router.workers.pi, reply = adapter.reply.bind(adapter);
  adapter.reply = async request => { await writeFile(file, 'VERSION_TWO'); return reply(request); };
  try { await f.click('pi-task', 'enqueue-gap-confirmation'); await until(() => f.app.store.row('feishu:enqueue-gap-confirmation')?.state === 'done'); }
  finally { adapter.reply = reply; }
  assert.equal(f.app.router.workers.operation(operation)!.state, 'blocked'); assert.equal(adapter.jobs().length, 1);
  assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1); assert.equal(await readFile(file, 'utf8'), 'VERSION_TWO');
});

test('C R1: an approved reply queued behind another writer retains its approved version and rejects changes at dequeue', async t => {
  const { f, file, docs, answer } = await editableQuestion(t), app = f.app, adapter = app.router.workers.pi;
  f.config.approval.dispatch = false; await writeFile(f.control, JSON.stringify({ hang: true }));
  await app.router.workers.execute('holding-writer', 'worker_dispatch', { ...args, taskId: 'holding-writer', options: JSON.stringify({ type: 'write', writeDirs: [docs] }) });
  const holding = adapter.jobs().find(j => j.task === 'holding-writer')!; await until(async () => (await f.calls()).some(c => c.event === 'start' && c.operation === holding.id));
  await writeFile(f.control, JSON.stringify({ delayMs: 50 })); const operation = await answer('queued-version-answer'); await f.click('pi-task', 'queued-version-confirmation');
  await until(() => adapter.job(operation)?.state === 'queued'); assert.equal(adapter.job(operation)!.plan.policy.edit?.[await canonical(file)], hash('VERSION_ONE'));
  await writeFile(file, 'VERSION_TWO'); await adapter.stop({ ...holding.request, batchFile: holding.id, action: 'stop' });
  await until(async () => { await adapter.tick(); return adapter.job(operation)?.state === 'failed'; });
  assert.equal(adapter.job(operation)!.wrapperPid, undefined); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 2); assert.equal(await readFile(file, 'utf8'), 'VERSION_TWO');
});

test('C R2: a confirmed user stop survives an older observation paused mid-flight and kills the original group', async t => {
  const f = await piFixture(t, { turns: [dispatch(), [{ tools: [{ name: 'worker_stop', arguments: { taskId: 'pi-task' } }] }, { text: '停止请求已处理' }], [{ text: '停止已确认' }]] });
  f.config.approval.readPi = false; f.config.pi.pollMs = 60000; await writeFile(f.control, JSON.stringify({ hang: true, child: true })); const app = await f.start(), adapter = app.router.workers.pi;
  await f.inject({ id: 'stop-race-start', text: '派 Pi 查构造事实' }); await until(async () => (await f.calls()).some(c => c.event === 'child'));
  const job = adapter.jobs()[0]!; await until(async () => { await adapter.tick(); return !!adapter.job(job.id)?.binding?.child; });
  await f.inject({ id: 'stop-race-owner', text: '停止这个 Pi' }); await until(() => !!f.approval());
  // SAFETY: TS-private methods are ordinary prototype methods at runtime. This test
  // delays only observation of the old snapshot; it never replaces the stop action.
  const internal = adapter as unknown as { observe(job: PiJob): Promise<void> }, observe = internal.observe.bind(adapter);
  let snapshot: PiJob | undefined, release!: () => void; const gate = new Promise<void>(accept => { release = accept; });
  internal.observe = async current => { if (!snapshot && current.id === job.id) { snapshot = current; await gate; } await observe(current); };
  const watching = adapter.tick();
  try {
    await until(() => !!snapshot); await f.click('pi-task', 'stop-race-confirm');
    await until(() => adapter.job(job.id)?.stopRequested === true); assert.equal(snapshot!.stopRequested, undefined, 'the observation really holds a pre-stop snapshot');
    release(); await watching; await until(() => app.store.row('feishu:stop-race-confirm')?.state === 'done');
    assert.equal(adapter.job(job.id)!.stopRequested, true, 'stale monitoring must never clear a persisted stop intent');
    await until(async () => { await adapter.poll(input => app.receive(input)); return app.store.task('pi-task')?.status === 'stopped'; });
    const stopped = adapter.job(job.id)!; assert.equal(stopped.outcome?.cleaned, true); await until(async () => !await alive(stopped.binding!.wrapper));
    assert.equal((await processes()).some(p => p.pgid === stopped.binding!.wrapper.pgid && !p.state.includes('Z')), false); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1);
  } finally { release(); internal.observe = observe; await watching; }
});

test('C R2: stop intent arriving while a queued launch is awaiting plan validation prevents any subprocess spawn', async t => {
  const f = await piFixture(t, { flow: [{ text: 'quiet' }] }); f.config.approval.readPi = false; f.config.pi.pollMs = 60000; f.config.concurrency.read = 1;
  await writeFile(f.control, JSON.stringify({ hang: true })); const app = await f.start(), adapter = app.router.workers.pi;
  for (const taskId of ['occupy', 'queued-stop']) await app.router.workers.execute(taskId, 'worker_dispatch', { ...args, taskId });
  const holder = adapter.jobs().find(j => j.task === 'occupy')!, queued = adapter.jobs().find(j => j.task === 'queued-stop')!;
  await until(async () => (await f.calls()).some(c => c.event === 'start')); await adapter.stop({ ...holder.request, batchFile: holder.id, action: 'stop' });
  await until(async () => { try { await stat(join(adapter.dir(holder.id), 'result.json')); return true; } catch { return false; } });
  // SAFETY: pause the real plan check at its await boundary, without replacing it.
  const internal = adapter as unknown as { plan(request: WorkerRequest): Promise<unknown> }, plan = internal.plan.bind(adapter);
  let entered = false, release!: () => void; const gate = new Promise<void>(accept => { release = accept; });
  internal.plan = async request => { const result = await plan(request); if (request.id === queued.id && !entered) { entered = true; await gate; } return result; };
  const starting = adapter.tick(); let stopping: Promise<unknown> | undefined;
  try {
    await until(() => entered); stopping = adapter.stop({ ...queued.request, batchFile: queued.id, action: 'stop' }); await until(() => adapter.job(queued.id)?.stopRequested === true);
    release(); await Promise.all([starting, stopping]);
    assert.equal(adapter.job(queued.id)!.wrapperPid, undefined, 'queued stop must win before the irreversible spawn'); assert.equal(adapter.job(queued.id)!.state, 'stopped'); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1);
  } finally { release(); internal.plan = plan; await starting; await stopping; }
});

test('C R3: exact edits insert dollar replacement sequences literally and retain unique-match/version guards', async t => {
  const f = await piFixture(t), app = await f.start(), docs = join(f.project, 'docs'); await mkdir(docs);
  const file = join(docs, 'literal.md'), before = '前缀 TOKEN 后缀', literal = "$$x$$ | $& | $` | $' | $1 | $<name> | 中文\n"; await writeFile(file, before);
  const policy = await app.router.files.policy(f.config.projects[0]!.root, [await canonical(docs)]); policy.edit = { [await canonical(file)]: hash(before) }; const scoped = new ScopedFiles(policy);
  const first = await scoped.edit(file, 'TOKEN', literal), expected = `前缀 ${literal} 后缀`;
  assert.equal(await readFile(file, 'utf8'), expected); assert.equal(first.sha256, hash(expected));
  const second = await scoped.edit(file, literal, '$&$$literal'); assert.equal(await readFile(file, 'utf8'), '前缀 $&$$literal 后缀'); assert.equal(second.sha256, hash('前缀 $&$$literal 后缀'));
  await writeFile(file, 'TOKEN TOKEN'); policy.edit[await canonical(file)] = hash('TOKEN TOKEN'); await assert.rejects(scoped.edit(file, 'TOKEN', literal)); assert.equal(await readFile(file, 'utf8'), 'TOKEN TOKEN');
  await writeFile(file, 'CHANGED TOKEN'); await assert.rejects(scoped.edit(file, 'TOKEN', literal)); assert.equal(await readFile(file, 'utf8'), 'CHANGED TOKEN');
});

for (const count of [1, 3]) test(`A5 receipt replacement: ${count === 1 ? 'reopen an atomically retired handle' : 'bound retries under repeated replacements, then recover'}`, async t => {
  const f = await piFixture(t), path = join(f.root, 'receipt.json'); await atomicJson(path, { version: 0 }); let replaced = 0;
  const race = await receiptReadRace(t, path, async info => {
    if (replaced >= count || info.nlink !== 1) return;
    const current = await stat(path);
    if (info.ino === current.ino && info.dev === current.dev) { replaced++; await atomicJson(path, { version: replaced }); }
  });
  let value: unknown;
  try { value = await privateJson(path); } finally { race.mock.restore(); }
  assert.equal(replaced, count, 'the real open/stat/rename overlap must occur');
  assert.deepEqual(value, count === 1 ? { version: 1 } : undefined, 'a retired inode is transient, not corrupt and not an unsafe grant');
  assert.deepEqual(await privateJson(path), { version: count }, 'the next normal read sees the complete current receipt');
});

test('A5 receipt security: retry does not allow symlinks, multiple hard links, malformed JSON or oversized records', async t => {
  const f = await piFixture(t), path = join(f.root, 'record.json'); await atomicJson(path, { safe: true });
  const alias = join(f.root, 'alias.json'); await symlink(path, alias); await assert.rejects(privateJson(alias));
  const hard = join(f.root, 'hard.json'); await link(path, hard); await assert.rejects(privateJson(path)); await assert.rejects(privateJson(hard));
  const broken = join(f.root, 'broken.json'); await writeFile(broken, '{not-json'); await assert.rejects(privateJson(broken));
  const large = join(f.root, 'large.json'); await atomicJson(large, { text: 'too large for this configured bound' }); await assert.rejects(privateJson(large, 8));
  assert.equal(await privateJson(join(f.root, 'missing.json')), undefined);
});

test('A5 approved five reads: atomic identity replacement during monitoring preserves 3-running/2-queued and all five original-card results', { timeout: 30000 }, async t => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({ ...args, taskId: `approved-${i}` }));
  const f = await piFixture(t, { turns: [[{ tools: tasks.map(arguments_ => ({ name: 'worker_dispatch', arguments: arguments_ })) }, { text: '五件已派' }], ...tasks.map(() => [{ text: '结果已收' }])] });
  await writeFile(f.control, JSON.stringify({ delayMs: 4000, summary: '替身读取完成' })); const app = await f.start(), adapter = app.router.workers.pi;
  let collided: string | undefined;
  const race = await receiptReadRace(t, f.configPath, async info => {
    if (collided || !info.isFile() || info.nlink !== 1) return;
    for (const job of adapter.jobs().filter(j => ['launching', 'running'].includes(j.state))) {
      const path = join(adapter.dir(job.id), 'identity.json');
      const current = await stat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
      if (current?.ino !== info.ino || current.dev !== info.dev) continue;
      collided = job.id;
      // Preserve every identity field; only replace the inode as the supervisor does.
      await atomicJson(path, parseJson(await readFile(path, 'utf8'))); return;
    }
  });
  try {
    await f.inject({ id: 'five-approved', text: '同时派五个只读查询' }); await until(() => tasks.every(task => !!f.approval(task.taskId)));
    assert.equal(adapter.jobs().length, 0); assert.equal((await f.calls()).length, 0);
    for (const task of tasks) await f.click(task.taskId);
    await until(() => app.store.row('feishu:approve-approved-4')?.state === 'done');
    await sleep(1500);
    const sample = adapter.jobs().map(j => ({ task: j.task, state: j.state })); t.diagnostic(`1.5s sample: ${JSON.stringify(sample)}`);
    assert.equal((await f.calls()).filter(c => c.event === 'start').length, 3); assert.equal(sample.filter(j => j.state === 'queued').length, 2);
    await until(async () => (await f.calls()).filter(c => c.event === 'end').length === 5, 18000);
    await until(() => adapter.jobs().every(j => j.emitted && app.store.row(`pi:${j.id}:result`)?.state === 'done'));
    assert.ok(collided, 'the identity replacement must overlap the real monitor read');
    for (const job of adapter.jobs()) {
      const physical = await privateJson<{ state: string; answer: { summary: string }; cleaned: boolean }>(join(adapter.dir(job.id), 'result.json'));
      assert.equal(physical?.state, 'done'); assert.equal(physical.cleaned, true); assert.equal(physical.answer.summary, '替身读取完成');
      assert.equal(job.state, 'done'); assert.equal(app.store.task(job.task)?.status, 'done');
      const card = f.feishu.messages.find(m => m.key === `task-message:${job.task}`)!;
      assert.match(card.text, /替身读取完成/); assert.equal(card.updates?.filter(text => text.includes('替身读取完成')).length, 1);
    }
    assert.equal(f.feishu.messages.length, 5);
    const calls = await f.calls(); let live = 0, max = 0;
    for (const call of calls) { if (call.event === 'start') max = Math.max(max, ++live); if (call.event === 'end') live--; }
    assert.equal(calls.filter(c => c.event === 'start').length, 5); assert.equal(max, 3); assert.equal(live, 0);
    await until(async () => (await Promise.all(adapter.jobs().map(j => alive(j.binding?.wrapper)))).every(value => !value));
  } finally { race.mock.restore(); }
});

const r1Definition = { title: '新建构造说明', goal: '在授权输出目录新建构造说明', completion: '报告构造说明与来源', boundary: '只使用已有授权输出子目录', prompt: '整理构造材料为新说明' };
for (const workerName of ['omitted', 'pi', 'conflict'] as const) for (const capability of ['commands', 'network', 'editFiles'] as const) test(`R1 approval: deferred ${workerName} ${capability} cannot inherit ordinary instruction consent`, async t => {
  const f = await piFixture(t, { flow: [{ text: 'quiet' }] }), docs = await canonical(join(f.project, 'output')); await mkdir(docs);
  const file = join(docs, 'existing.txt'); await writeFile(file, 'SYNTHETIC_EDIT_BASELINE'); f.config.projects[0]!.pi = { writeDirs: [docs], skills: {} };
  const ordinary = { ...args, ...r1Definition, options: JSON.stringify({ type: 'write', writeDirs: [docs] }) };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: dispatch(ordinary) }) });
  const app = await f.start(); await f.inject({ id: 'r1-proposal', text: '有哪些构造材料可整理？' }); await until(() => !!f.approval());
  const message = f.feishu.messages.find(m => m.key === 'task-message:pi-task')!, hold = message.card!.buttons.find(b => b.label === '回电脑再说')!;
  await f.inject({ id: 'r1-hold', quoteId: message.id, button: { value: hold.value } }); await until(() => app.store.row('feishu:r1-hold')?.state === 'done' && app.store.row('feishu:r1-proposal')?.state === 'done');
  assert.equal(app.store.task('pi-task')!.deferred, true); assert.equal(app.router.workers.pi.jobs().length, 0);
  // Even permanent ordinary-action switches cannot authorize a new capability.
  f.config.approval.readPi = false; f.config.approval.dispatch = false;
  const instruction = '请在授权输出目录新建构造说明';
  const { worker: _worker, ...base } = ordinary;
  const request = { ...base, ...(workerName === 'omitted' ? {} : { worker: workerName === 'conflict' ? 'loop' : 'pi' }),
    options: JSON.stringify({ type: 'write', writeDirs: [docs], [capability]: capability === 'editFiles' ? [file] : true }), instructionInput: 'feishu:r1-renewed', instruction };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: dispatch(request) }) });
  await f.inject({ id: 'r1-renewed', quoteId: message.id, text: instruction });
  await until(() => ['waiting', 'done', 'failed'].includes(app.store.row('feishu:r1-renewed')?.state ?? ''));
  assert.equal(app.router.workers.pi.jobs().length, 0, 'no Pi policy/job may exist before independent confirmation');
  assert.equal((await f.calls()).length, 0, 'no worker may start from ordinary instruction consent');
  if (workerName === 'conflict') {
    assert.equal(app.store.row('feishu:r1-renewed')!.state, 'failed');
    await assert.rejects(app.router.workers.prepare('feishu:r1-renewed', 'worker_dispatch', request), /worker.*身份.*冲突/);
    assert.equal(app.store.task('pi-task')!.worker!.kind, 'pi'); return;
  }
  assert.equal(app.store.row('feishu:r1-renewed')!.state, 'waiting');
  await until(() => !!f.approval()); const value = f.approval()!.value, op = app.router.workers.operation(value.operation!)!;
  assert.equal(op.request.worker, 'pi'); assert.equal(op.request.redLine, true); assert.equal(op.needsApproval, true); assert.equal(op.confirmation, undefined);
  assert.match(f.feishu.messages.find(m => m.id === message.id)!.text, /红线权限须明确点头/);
  await f.click('pi-task', 'r1-capability-approve'); await f.done();
  const job = app.router.workers.pi.jobs()[0]!, policy = parseJson<{ commands: boolean; network: boolean; edit: Record<string, string> }>(await readFile(join(app.router.workers.pi.dir(job.id), 'policy.json'), 'utf8'));
  assert.equal(policy.commands, capability === 'commands'); assert.equal(policy.network, capability === 'network');
  assert.deepEqual(Object.keys(policy.edit), capability === 'editFiles' ? [file] : []);
  assert.equal(await readFile(file, 'utf8'), 'SYNTHETIC_EDIT_BASELINE', 'the worker stub never performs the granted mutation');
  await f.inject({ id: 'r1-capability-replay', quoteId: message.id, button: { value } }); await until(() => app.store.row('feishu:r1-capability-replay')?.state === 'done');
  await f.inject({ id: 'r1-renewed', quoteId: message.id, text: instruction }); await sleep(100);
  assert.equal(app.router.workers.pi.jobs().length, 1); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1);
});

test('R1 approval: deferred ordinary Pi dispatch with omitted worker still uses current instruction once', async t => {
  const f = await piFixture(t, { flow: [{ text: 'quiet' }] }), docs = await canonical(join(f.project, 'output')); await mkdir(docs); f.config.projects[0]!.pi = { writeDirs: [docs], skills: {} };
  const ordinary = { ...args, ...r1Definition, options: JSON.stringify({ type: 'write', writeDirs: [docs] }) };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: dispatch(ordinary) }) }); const app = await f.start();
  await f.inject({ id: 'r1-ordinary-proposal', text: '看看构造材料如何处理？' }); await until(() => !!f.approval());
  const message = f.feishu.messages.find(m => m.key === 'task-message:pi-task')!;
  await f.inject({ id: 'r1-ordinary-hold', quoteId: message.id, button: { value: message.card!.buttons.find(b => b.label === '回电脑再说')!.value } });
  await until(() => app.store.row('feishu:r1-ordinary-hold')?.state === 'done' && app.store.row('feishu:r1-ordinary-proposal')?.state === 'done');
  const instruction = '请在授权输出目录新建构造说明', { worker: _worker, ...base } = ordinary;
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: dispatch({ ...base, instructionInput: 'feishu:r1-ordinary-renewed', instruction }) }) });
  await f.inject({ id: 'r1-ordinary-renewed', quoteId: message.id, text: instruction }); await f.done();
  const job = app.router.workers.pi.jobs()[0]!, op = app.router.workers.operation(job.id)!;
  assert.equal(op.request.worker, 'pi'); assert.equal(op.request.redLine, false); assert.equal(op.needsApproval, false); assert.equal(op.confirmation!.inputId, 'feishu:r1-ordinary-renewed');
  assert.equal(f.config.approval.dispatch, true); assert.equal(f.config.approval.readPi, true); assert.equal(f.approval(), undefined);
  await f.inject({ id: 'r1-ordinary-renewed', quoteId: message.id, text: instruction }); await sleep(100); assert.equal(app.router.workers.pi.jobs().length, 1); assert.equal((await f.calls()).filter(c => c.event === 'start').length, 1);
});

for (const capability of ['commands', 'network', 'editFiles'] as const) test(`R1 approval: saved false flags cannot bypass execution-time ${capability} confirmation`, async t => {
  const f = await piFixture(t, { flow: [{ text: 'quiet' }] }), docs = await canonical(join(f.project, 'output')); await mkdir(docs); const file = join(docs, 'existing.txt'); await writeFile(file, 'SYNTHETIC_EDIT_BASELINE'); f.config.projects[0]!.pi = { writeDirs: [docs], skills: {} };
  const app = await f.start(); f.config.approval.dispatch = false;
  const request = { ...args, ...r1Definition, options: JSON.stringify({ type: 'write', writeDirs: [docs], [capability]: capability === 'editFiles' ? [file] : true }) };
  const op = await app.router.workers.prepare('r1-legacy', 'worker_dispatch', request);
  op.needsApproval = false; op.request.redLine = false; app.router.workers.journal.write(op); // Simulate a previously persisted unsafe decision, not owner approval.
  const result = await app.router.workers.execute('r1-legacy', 'worker_dispatch', request) as { ok: boolean; reason: string };
  assert.equal(result.ok, false); assert.match(result.reason, /本人.*点头/); assert.equal(app.router.workers.pi.jobs().length, 0); assert.equal((await f.calls()).length, 0);
});

test('R1 approval: mandatory capability fence runs again after awaited state verification and before execution claim', async t => {
  const f = await piFixture(t, { flow: [{ text: 'quiet' }] }), docs = await canonical(join(f.project, 'output')); await mkdir(docs); f.config.projects[0]!.pi = { writeDirs: [docs], skills: {} }; const app = await f.start();
  const instruction = '请在授权输出目录新建构造说明', input = { id: 'feishu:r1-final-fence', source: 'feishu' as const, who: 'owner', chatType: 'p2p', messageId: 'r1-final-fence', at: new Date().toISOString(), text: instruction, attachments: [] }; app.store.enqueue(input);
  let snapshot: WorkerSnapshot | undefined, effects = 0;
  const original = app.router.workers.pi;
  const adapter: WorkerAdapter = { kind: 'pi', async status(request) {
    if (!snapshot) return snapshot = await original.status(request);
    request.options.network = true; request.redLine = false; return snapshot; // Fault injection at the await boundary; no external action.
  }, async dispatch() { effects++; return { status: 'sent', reason: 'must not happen' }; }, progress: original.progress.bind(original), ask: original.ask.bind(original), reply: original.reply.bind(original), result: original.result.bind(original), stop: original.stop.bind(original) };
  app.router.workers.adapters.set('pi', adapter);
  const result = await app.router.workers.execute(input.id, 'worker_dispatch', { ...args, ...r1Definition, options: JSON.stringify({ type: 'write', writeDirs: [docs] }), instructionInput: input.id, instruction }) as { status: string; reason: string };
  assert.equal(result.status, 'stale'); assert.match(result.reason, /本人.*点头/); assert.equal(effects, 0); assert.equal(app.router.workers.pi.jobs().length, 0);
  assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='worker_intent'").get()!.n), 0);
});
