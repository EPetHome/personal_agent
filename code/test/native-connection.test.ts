// A1–A8：真实安装程序/解析边界，只有模型、宿主、转写和launchd用隔离返回。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { validateConfig } from '../src/core/config.ts';
import { commandWorker } from '../src/core/worker-adapter.ts';
import { inspectLoopStatuses, intakeLoop } from '../src/core/loop-intake.ts';
import { readLedger, updateLedger } from '../src/core/ledger.ts';
import { processManagedLoop } from '../src/core/managed-loop.ts';
import { dispatchWrites } from '../src/core/managed-actions.ts';
import { dispatchTask } from '../src/core/task-adapter.ts';
import { recordManagedText } from '../src/core/task-intake.ts';

import { feishuChannel } from '../src/channels/feishu/index.ts';
import { sidebarSnapshot, startSidebar } from '../src/channels/sidebar/index.ts';
import { deploymentPlan, applyDeployment, rollbackDeployment } from '../deploy/connect.ts';
import { probeConnections } from '../deploy/probe.ts';
import { readJsonl } from '../src/core/store.ts';
import type { DispatchRequest, LoopWorker, ManagedCard } from '../src/core/managed-types.ts';

const LOOP = process.env.PA_TEST_LOOP_ROOT ?? '/Users/Admin/Desktop/loop';
const PI_ARGS = '/Users/Admin/.local/share/pi-versions/1.2.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js';
const fixtureProgram = resolve(import.meta.dirname, 'installed-loop-fixture.ts'), loopCommand = resolve(import.meta.dirname, 'installed-loop-command.ts');
async function fixture(t: TestContext) {
  await lstat(join(LOOP, 'loop.ts')); await lstat(PI_ARGS); // 缺安装程序必须失败，不用skip掩盖接线。
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pa-native-'))), home = join(root, 'home'), project = join(root, 'project'), workspace = join(root, 'workspace'), events = join(root, 'loop-events'), dir = join(root, 'runtime'), file = join(project, 'batch.json');
  for (const path of [home, project, workspace, events, dir]) await mkdir(path);
  const environment: Record<string, string> = { HOME: home, PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), LOOP_PA_CONFIG: join(root, 'loop.json'), AUTOREVIEW_MERGE_QUEUE_ROOT: join(root, 'queues'), AUTOREVIEW_PROJECTS_ROOT: join(root, 'projects-state'), AUTOREVIEW_RESOURCE_ROOT: join(root, 'resources'), PA_TEST_PI_ARGS: PI_ARGS };
  const before = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(async () => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await rm(root, { recursive: true, force: true }); });
  await writeFile(environment.LOOP_PA_CONFIG!, JSON.stringify({ pa: { eventsDir: events, localNotify: false } }));
  await writeFile(join(project, '.autoreview.json'), '{}'); await writeFile(join(project, 'component.ts'), 'export const component = 1;\n');
  await writeFile(file, JSON.stringify({ name: '同名批次', dir, branch: 'feat/test', stages: { 开发: { cwd: project, start: 'never-run-model # autoreview.ts' } } }));
  const calls = join(root, 'loop-calls.jsonl');
  const config = await validateConfig({ sources: {}, inboxDir: null, dataDir: join(root, 'data'), loopEvents: { dir: events, since: '2000-01-01T00:00:00Z' },
    worker: { executable: process.execPath, args: [loopCommand, LOOP, calls], protocol: 'loop-v1', timeoutMs: 20000 },
    dispatch: { projects: [{ name: '构造项目', path: project, workspace, loop: { batchDir: 'docs/batches/pa', allow: ['component.ts'], deny: ['.autoreview.json'] } }], skills: { transcribe: 'voice', summary: 'brief', wiki: 'knowledge' } },
    sidebar: { port: 0 }, managedLoop: { verifyAfterMs: 0 }, feishu: { mode: 'fake', receiverId: 'ou_test' } });
  const invoke = (action: string, extra = {}) => {
    const result = spawnSync(process.execPath, [fixtureProgram, LOOP, action], { env: process.env, cwd: project, input: JSON.stringify({ file, project, dir, pid: process.pid, prompt: join(project, 'component.ts'), ...extra }), encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const channel = feishuChannel(config, undefined, { managed: true }), now = () => new Date().toISOString();
  const tick = (worker?: LoopWorker) => processManagedLoop(config, now(), { channels: [channel], worker });
  const state = () => readLedger(config.dataDir);
  const sent = () => readJsonl<any>(join(config.dataDir, 'feishu-sent.jsonl'));
  const latest = async () => Object.values((await state()).tables.cards).filter(card => !card.id.startsWith('health:')).at(-1)!;
  const click = async (action: string, card?: ManagedCard, option?: number) => {
    card ??= await latest(); const original = (await sent()).find(row => row.noticeId === card.id)!;
    await appendFile(join(config.dataDir, 'feishu-inbox.jsonl'), JSON.stringify({ id: randomUUID(), type: 'action', at: now(), actor: 'ou_test', messageId: original.messageId, value: { action: `managed_${action}`, noticeId: card.id, revision: String(card.revision), ...(option === undefined ? {} : { option: String(option) }) } }) + '\n');
    await channel.drain(now());
  };
  return { root, home, project, workspace, events, dir, file, calls, config, invoke, now, channel, tick, state, sent, latest, click };
}
async function snapshot(root: string): Promise<unknown[]> {
  const stat = await lstat(root);
  if (stat.isDirectory()) return [root, stat.mtimeMs, ...(await Promise.all((await readdir(root)).sort().map(name => snapshot(join(root, name)))))];
  return [root, stat.mtimeMs, stat.size, (await readFile(root)).toString('base64')];
}
async function localGet(port: number, path: string, token?: string): Promise<{ status: number; text: string }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('构造本机端口不合法');
  return new Promise((accept, reject) => {
    get({ hostname: '127.0.0.1', port, path, headers: token ? { 'x-pa-token': token } : {} }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk);
      response.once('error', reject); response.once('end', () => accept({ status: response.statusCode!, text }));
    }).once('error', reject);
  });
}
async function text(f: Awaited<ReturnType<typeof fixture>>, value: string, ref?: string) {
  await appendFile(join(f.config.dataDir, 'feishu-inbox.jsonl'), JSON.stringify({ type: 'text', id: randomUUID(), actor: 'ou_test', at: f.now(), messageId: randomUUID(), chatType: 'p2p', text: value, ...(ref ? { ref } : {}) }) + '\n');
  await f.channel.drain(f.now());
}
function request(f: Awaited<ReturnType<typeof fixture>>, kind: DispatchRequest['kind'] = 'query'): DispatchRequest {
  return { schema: 1, requestId: `test-${randomUUID()}`, ticketId: 'synthetic', proposalId: 'synthetic', project: f.project, batch: '任务', kind, source: 'user_via_pa', mode: 'suggest',
    definition: { version: 1, at: f.now(), source: '构造本人点击', confirmed: true, goal: '构造目标', result: '只查构造事实', stage: '单次', nonGoals: '不接账号、不发布', done: '带依据交回', askFirst: '扩大范围先问', boundaries: { read: [join(f.project, 'component.ts')], write: kind === 'skill' ? [f.workspace] : [], execute: ['dispatch:synthetic'], outbound: [], realDevice: false } },
    sheet: { goal: '只查component.ts', questions: ['有何导出'], boundary: { read: [join(f.project, 'component.ts')], write: [], tools: [], realDevice: false, outbound: false }, arrival: '一次带依据交回', budget: { timeoutMs: 20000, maxRounds: 1 } } };
}
async function pi(f: Awaited<ReturnType<typeof fixture>>, kind = 'query') {
  const executable = join(f.root, 'pi-model.mjs'), settings = join(f.root, 'pi-model.json');
  await writeFile(executable, await readFile(resolve(import.meta.dirname, 'installed-pi-model.mjs'))); await chmod(executable, 0o700);
  await writeFile(settings, JSON.stringify({ kind, basis: join(f.project, 'component.ts'), outside: join(f.root, 'MUST-NOT-WRITE'), capture: join(f.root, 'pi-calls.jsonl') }));
  f.config.piWorker = { executable, args: [], timeoutMs: 20000, protocol: 'pi-v1', model: settings };
  return settings;
}

test('真机接通 A1/A2：官方事件出口→账本→同账本侧边栏；真实查询保真且全只读', async t => {
  const f = await fixture(t), emitted = f.invoke('emit');
  assert.equal(await intakeLoop(f.config, f.now()), 2); assert.equal(await intakeLoop(f.config, f.now()), 0);
  await f.tick(); const state = await f.state(), ticket = Object.values(state.tables.tickets)[0]!;
  assert.equal(Object.keys(state.tables.tickets).length, 1); assert.equal(ticket.status, 'waiting_user');
  assert.equal(state.events[emitted.paused.id]!.native!.batch.file, f.file); assert.deepEqual(state.events[emitted.paused.id]!.native, emitted.paused);
  const before = await snapshot(f.root), worker = commandWorker(f.config)!;
  const status = await worker.status('同名批次', f.project, f.file);
  assert.equal(status.batchFile, f.file); assert.equal(status.stages.find(stage => stage.name === '开发')!.sessionId, 'synthetic-session');
  assert.equal(status.stages.find(stage => stage.name === '开发')!.state, 'needs_decision');
  // 只忽略测试调用捕获文件；安装版查询自身不写状态/恢复队列。
  const after = await snapshot(f.root);
  const strip = (value: unknown): unknown => Array.isArray(value) ? value.filter(item => !(Array.isArray(item) && item[0] === f.calls)).map(strip) : value;
  assert.deepEqual(strip(after), strip(before));
  assert.ok((await readJsonl<any>(f.calls)).every(row => row.argv[0] === '查询'));
  const sidebar = await startSidebar(f.config); t.after(() => sidebar.close());
  const port = Number(new URL(sidebar.url).port), page = (await localGet(port, '/')).text; assert.match(page, /PA|personal|侧边栏/);
  const token = /nonce="([^"]+)"/.exec(page)![1]!;
  const response = await localGet(port, '/api/state', token);
  assert.equal(response.status, 200); assert.match(response.text, /同名批次/);
});

test('真机接通返修1-1：官方done→queue同轮回原卡，保留完成依据/欠项和第三次退回提醒', async t => {
  const f = await fixture(t), git = (...args: string[]) => {
    const output = spawnSync('git', args, { cwd: f.project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(output.status, 0, output.stderr); return output.stdout.trim();
  };
  git('init', '-qb', 'main'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'feat/test');
  f.invoke('emit'); await f.tick(); const original = (await f.sent()).find(row => row.type === 'interactive')!.messageId;
  const emitted = f.invoke('done-queue', { commit: git('rev-parse', 'feat/test') });
  assert.equal(emitted.done.stage, null); assert.equal(emitted.queue.stage, null); assert.ok(emitted.queue.seq > emitted.done.seq);
  await f.tick(); let state = await f.state(), ticket = Object.values(state.tables.tickets)[0]!, card = state.tables.cards[ticket.id]!;
  assert.equal(card.eventId, emitted.done.id); assert.match(card.title, /做完/); assert.match(card.fact, /门禁（loop 报告）：passed/); assert.match(card.fact, /"verdict":"通过"/);
  assert.match(card.fact, /部分验证/); assert.match(card.fact, /构造手机通知/); assert.match(card.fact, /构造人工文案/);
  assert.equal(ticket.status, 'done_pending_actions'); assert.equal(ticket.reportedState, 'completed');
  assert.equal(state.tables.assignments[card.assignmentId]!.lastEventId, emitted.done.id);
  assert.equal(Object.values(state.tables.assignments).filter(row => row.state === 'queue' && !row.endedAt).length, 1);
  assert.deepEqual(state.events[emitted.done.id]!.native, emitted.done);
  const completion = card.fact, revision = card.revision, delivered = (await f.sent()).filter(row => row.type === 'interactive');
  assert.ok(delivered.length >= 2); assert.ok(delivered.every(row => row.messageId === original));
  await processManagedLoop(f.config, f.now(), { channels: [f.channel], inspect: true });
  assert.equal((await f.state()).tables.cards[ticket.id]!.eventId, emitted.done.id);
  for (const status of ['testing', 'ready']) { f.invoke('queue', { status }); await f.tick(); }
  assert.equal((await f.state()).tables.cards[ticket.id]!.revision, revision);
  for (const returns of [1, 2]) { f.invoke('queue', { status: 'returned', returns }); await f.tick(); }
  assert.equal((await f.state()).tables.cards[ticket.id]!.revision, revision);
  f.invoke('queue', { status: 'returned', returns: 3 }); await f.tick(); state = await f.state(); card = state.tables.cards[ticket.id]!;
  assert.match(card.title, /退回三次/); assert.ok(card.fact.includes(completion)); assert.match(card.basis, new RegExp(emitted.done.id));
  assert.equal(state.events[emitted.done.id]!.detail.acceptance && (state.events[emitted.done.id]!.detail.acceptance as any).manual[0].id, 'A3');
  assert.ok((await f.sent()).filter(row => row.type === 'interactive').every(row => row.messageId === original));
});

test('真机接通返修1-2：整批会话不适用不报消失，实际段死亡仍告警且恢复可核销', async t => {
  const f = await fixture(t), running = f.invoke('running');
  await processManagedLoop(f.config, f.now(), { channels: [f.channel], inspect: true });
  let state = await f.state(); const ticket = Object.values(state.tables.tickets)[0]!;
  const batch = Object.values(state.tables.assignments).find(row => row.stage === '@batch')!, stage = Object.values(state.tables.assignments).find(row => row.stage === '开发')!;
  const snapshot = await commandWorker(f.config)!.status(ticket.batch, f.project, f.file);
  assert.equal(snapshot.stages.find(row => row.name === '@batch')!.sessionPresent, undefined);
  assert.equal(batch.session, undefined); assert.equal(stage.session!.present, true);
  assert.ok(!Object.values(state.tables.attentions).some(row => row.id.startsWith('session:') && row.status !== 'resolved'));
  assert.ok(sidebarSnapshot(state).groups.find(group => group.name === '在跑')!.items.some(row => row.id === ticket.id));
  // 旧版本留下的整批false事实/告警也必须在下次只读巡检核销，不能永久留在卡住组。
  await updateLedger(f.config.dataDir, f.now(), (_state, add) => {
    add({ kind: 'put', table: 'assignments', value: { ...batch, session: { present: false, at: f.now() } } });
    add({ kind: 'put', table: 'attentions', value: { id: `session:${batch.id}`, ticketId: ticket.id, assignmentId: batch.id, eventId: running.batch.id, status: 'waiting', reason: '旧整批误判' } });
  });
  await processManagedLoop(f.config, f.now(), { channels: [f.channel], inspect: true }); state = await f.state();
  assert.equal(state.tables.assignments[batch.id]!.session, undefined); assert.equal(state.tables.attentions[`session:${batch.id}`]!.status, 'resolved');
  f.invoke('session', { alive: false }); await processManagedLoop(f.config, f.now(), { channels: [f.channel], inspect: true }); state = await f.state();
  assert.equal(state.tables.assignments[stage.id]!.session!.present, false); assert.equal(state.tables.attentions[`session:${stage.id}`]!.status, 'waiting');
  assert.ok(sidebarSnapshot(state).groups.find(group => group.name === '卡住')!.items.some(row => row.id === ticket.id));
  f.invoke('session', { alive: true }); await processManagedLoop(f.config, f.now(), { channels: [f.channel], inspect: true }); state = await f.state();
  assert.equal(state.tables.attentions[`session:${stage.id}`]!.status, 'resolved');
  assert.ok(sidebarSnapshot(state).groups.find(group => group.name === '在跑')!.items.some(row => row.id === ticket.id));
  assert.ok(!(await f.sent()).some(row => JSON.stringify(row.content).includes('没人在做')));
});

test('真机接通 A1：坏行不吞、链接不读；首次连接不回灌历史完成，重启游标不重放', async t => {
  const f = await fixture(t), event = f.invoke('emit');
  const file = join(f.events, (await readdir(f.events))[0]!);
  await appendFile(file, '{bad-json}\n'); await symlink(file, join(f.events, 'events-2000-01-01.jsonl'));
  await intakeLoop(f.config, f.now()); let state = await f.state();
  assert.ok(state.observations.some(row => row.kind === 'invalid_event')); assert.equal(state.tables.health.loop!.ok, false);
  assert.equal(Object.keys(state.tables.tickets).length, 1);
  const fresh = { ...f.config, dataDir: join(f.root, 'new-ledger'), loopEvents: { dir: f.events, since: new Date(Date.parse(event.paused.at) + 1000).toISOString() } };
  await intakeLoop(fresh, f.now()); await intakeLoop(fresh, f.now());
  state = await readLedger(fresh.dataDir); assert.equal(Object.keys(state.tables.tickets).length, 0); assert.ok(Object.keys(state.tables.cursors).length);
});

test('真机接通 A2/A3：同名不同项目不串线；假飞书原话换行送原段，已投递/已读对账', async t => {
  const f = await fixture(t); f.invoke('emit'); await f.tick();
  const worker = commandWorker(f.config)!;
  await assert.rejects(worker.status('同名批次', join(f.root, 'wrong-project'), f.file));
  const original = (await f.sent()).find(row => row.type === 'interactive')!.messageId, words = '  选甲\r\n保留空格  \n';
  await text(f, words, original); await f.tick();
  let state = await f.state(), write = Object.values(state.tables.writes)[0]!;
  assert.equal(write.state, 'delivered'); const record = JSON.parse(await readFile(join(f.dir, '开发.words', `${write.id}.json`), 'utf8'));
  assert.equal(record.text, words); assert.equal(record.id, write.id);
  f.invoke('consume', { id: write.id, text: words });
  await inspectLoopStatuses(f.config, f.now(), worker); // 不读新事件，只用官方paRelays核销已读。
  state = await f.state(); assert.equal(state.tables.writes[write.id]!.state, 'consumed');
  await f.tick();
  const command = (await readJsonl<any>(f.calls)).find(row => row.argv[0] === '送话'); assert.equal(command.input, words);
  assert.ok(command.argv.includes(f.file)); assert.ok(command.argv.includes(write.id));
});

test('真机接通 A3：整批resume/grant/manual分别路由；续跑执行边界用隔离宿主', async t => {
  const f = await fixture(t); f.invoke('emit');
  f.invoke('phase', { next: 'resume' }); await f.tick(); await f.click('continue'); await f.tick();
  let calls = await readJsonl<any>(f.calls); assert.equal(calls.filter(row => row.launch).length, 1);
  const resumed = calls.find(row => row.argv?.[0] === '续跑'); assert.ok(resumed); assert.equal(resumed.input, '继续');
  f.invoke('phase', { next: 'manual' }); await f.tick();
  const receipt = await commandWorker(f.config)!.send({ requestId: 'manual-request', project: f.project, batch: '同名批次', batchFile: f.file, stage: '@batch', source: 'user_via_pa', text: '继续' });
  assert.equal(receipt.status, 'failed'); assert.match(receipt.reason!, /电脑/);
  // 真实grant入口解析当前授权文本，非授权的“继续”必须拒绝，不伪造已授权。
  const criteria = join(f.root, 'criteria.md'); await writeFile(criteria, '# 构造标准\n## 验收标准\nA1. [授权] 操作：构造外部动作\n    预期：只在构造资源执行\n');
  const raw = JSON.parse(await readFile(f.file, 'utf8')); raw.acceptance = { workDir: f.project, criteria, maxRounds: 1 }; await writeFile(f.file, JSON.stringify(raw));
  f.invoke('phase', { next: 'grant' });
  const denied = await commandWorker(f.config)!.send({ requestId: 'grant-invalid', project: f.project, batch: '同名批次', batchFile: f.file, stage: '@batch', source: 'user_via_pa', text: '继续\n不是授权' });
  assert.equal(denied.status, 'failed'); calls = await readJsonl<any>(f.calls); const grant = calls.find(row => row.argv?.includes('--grant-file')); assert.equal(grant.input, '继续\n不是授权');
  const original = '同意授权：A1\r\n只限构造资源  \n';
  const accepted = await commandWorker(f.config)!.send({ requestId: 'grant-valid', project: f.project, batch: '同名批次', batchFile: f.file, stage: '@batch', source: 'user_via_pa', text: original });
  assert.equal(accepted.status, 'consumed', accepted.reason); assert.match(accepted.reason!, /编排已启动/);
  const grants = await readJsonl<any>(join(f.dir, 'grants.pa.jsonl')); assert.equal(grants[0].id, 'grant-valid'); assert.equal(grants[0].text, original);
});

test('真机接通 A4：官方已收但回执丢失不重投；目标移动/执行端缺口拒绝且远端/发布分支未变', async t => {
  const f = await fixture(t); f.invoke('emit'); await f.tick(); await f.click('continue');
  const actual = commandWorker(f.config)!, lost: LoopWorker = { ...actual, async send(input) { await actual.send(input); throw new Error('构造回执丢失'); } };
  await f.tick(lost); await dispatchWrites(f.config, f.now(), lost); await dispatchWrites(f.config, f.now(), actual);
  const state = await f.state(), write = Object.values(state.tables.writes)[0]!; assert.equal(write.state, 'uncertain');
  assert.equal((await readJsonl<any>(f.calls)).filter(row => row.argv[0] === '送话').length, 1);
  f.invoke('phase', { commit: 'b'.repeat(40), next: 'manual' });
  const git = (...args: string[]) => { const result = spawnSync('git', args, { cwd: f.project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-qb', 'main'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'feat/test');
  const remote = join(f.root, 'test-remote.git'); git('init', '--bare', remote); git('remote', 'add', 'origin', remote);
  const before = await snapshot(f.project), remoteBefore = await snapshot(remote), main = git('rev-parse', 'main');
  for (const action of ['push', 'merge'] as const) {
    const receipt = await actual.execute!({ requestId: `target-${action}`, project: f.project, batch: '同名批次', batchFile: f.file, stage: '@batch', action, branch: 'feat/test', commit: 'a'.repeat(40), source: 'user_via_pa', force: false, checkSecrets: true, protectedBranches: ['main'] });
    assert.equal(receipt.code, 'target_changed');
    const blocked = await actual.execute!({ requestId: `capability-${action}`, project: f.project, batch: '同名批次', batchFile: f.file, stage: '@batch', action, branch: 'feat/test', commit: 'b'.repeat(40), source: 'user_via_pa', force: false, checkSecrets: true, protectedBranches: ['main'] });
    assert.equal(blocked.code, 'loop_capability_missing');
  }
  assert.deepEqual(await snapshot(f.project), before); assert.deepEqual(await snapshot(remote), remoteBefore); assert.equal(git('rev-parse', 'main'), main);
  assert.ok(!(await readJsonl<any>(f.calls)).some(row => ['推送', '合入'].includes(row.argv[0])));
});

for (const projectName of ['构造项目', 'My Project', 'My_Project']) test(`真机接通 A5/返修1-3：${projectName} 明确点派→安装版Loop开工/启动，显示名/身份不变`, async t => {
  const f = await fixture(t); f.config.dispatch!.projects[0]!.name = projectName;
  const git = (...args: string[]) => { const result = spawnSync('git', args, { cwd: f.project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  await rm(f.workspace, { recursive: true });
  await writeFile(join(f.project, '.autoreview.json'), JSON.stringify({ workspaces: { 'dev分支': f.workspace } }));
  git('init', '-qb', 'main'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'synthetic base'); const baseline = git('rev-parse', 'main');
  const host = join(f.root, 'host.mjs'), capture = join(f.root, 'host.json');
  await writeFile(host, `#!/usr/bin/env node\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2); const file=args.find(arg=>arg.startsWith('@')).slice(1);writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,prompt:readFileSync(file,'utf8'),branch:process.env.AUTOREVIEW_BATCH_FILE,stage:process.env.AUTOREVIEW_STAGE}));\n`); await chmod(host, 0o700);
  const keys = { PI_BIN: host, PERMISSION_EXTENSION: join(f.root, 'permission.ts'), PONYTAIL_EXTENSION: join(f.root, 'ponytail.ts') };
  const old = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]])); Object.assign(process.env, keys);
  t.after(() => { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  await writeFile(keys.PERMISSION_EXTENSION, 'export default function(){}'); await writeFile(keys.PONYTAIL_EXTENSION, 'export default function(){}');
  const permissions = join(process.env.PI_CODING_AGENT_DIR!, 'extensions', 'pi-permission-system'); await mkdir(permissions, { recursive: true }); await writeFile(join(permissions, 'config.json'), '{"yoloMode":true}');
  // 原项目配置/权限不被生产adapter改写。只在构造home准备已授权自动权限。
  await recordManagedText(f.config, { id: 'task-develop', actor: 'ou_test', at: f.now(), messageId: 'task-develop', text: `${projectName}修改 \`component.ts\` 并补测试，不修改配置文件，门禁过就算完` });
  await f.tick(); await f.click((await f.latest()).redline ? 'dispatch_confirm' : 'dispatch'); await f.tick();
  for (let i = 0; i < 100 && !await lstat(capture).then(() => true, () => false); i++) await delay(30);
  assert.ok(await lstat(capture).then(() => true, () => false), JSON.stringify({ writes: Object.values((await f.state()).tables.writes), calls: await readJsonl(f.calls) }));
  const captured = JSON.parse(await readFile(capture, 'utf8')); assert.match(captured.prompt, /不修改配置文件/); assert.match(captured.prompt, /prohibitedChanges/); assert.match(captured.prompt, /门禁过/); assert.match(captured.prompt, /"recipe": "develop"/);
  assert.ok(captured.args.includes(join(LOOP, 'autoreview.ts'))); assert.equal(captured.stage, '开发');
  assert.equal(git('rev-parse', 'main'), baseline); assert.equal(git('branch', '--show-current'), 'main');
  const branches = git('branch', '--list', 'feat/pa-*').split('\n').filter(Boolean); assert.equal(branches.length, 1);
  const calls = await readJsonl<any>(f.calls); assert.equal(calls.filter(row => row.argv[0] === '开工').length, 1); assert.equal(calls.filter(row => row.argv[0] === '启动').length, 1);
  await f.tick(); assert.equal((await readJsonl<any>(f.calls)).filter(row => row.argv[0] === '启动').length, 1);
  const original = Object.values((await f.state()).tables.writes).find(row => row.dispatch?.kind === 'loop')!.dispatch!;
  const plan = JSON.parse(await readFile(captured.branch, 'utf8')), saved = JSON.parse(await readFile(join(dirname(captured.branch), 'request.json'), 'utf8'));
  assert.ok(original.batch.startsWith(`${projectName}-`)); assert.equal(plan.name, original.batch); assert.equal(saved.batch, original.batch); assert.equal(saved.requestId, original.requestId);
  assert.match(basename(dirname(captured.branch)), /^pa-[a-f0-9]{64}$/);
  assert.equal((await commandWorker(f.config)!.start!(original)).status, 'failed');
  assert.equal((await readJsonl<any>(f.calls)).filter(row => row.argv[0] === '开工').length, 1);
});

test('真机接通 A6：安装版Pi参数边界禁工具/自由shell；事实附依据，写入企图不可执行', async t => {
  const f = await fixture(t), model = await pi(f), asked = request(f);
  const receipt = await dispatchTask(f.config, asked); assert.equal(receipt.status, 'consumed'); assert.match(receipt.facts![0]!.basis, /component.ts:1/);
  const calls = await readJsonl<any>(join(f.root, 'pi-calls.jsonl')); assert.equal(calls.length, 1); assert.equal(calls[0].parsedNoTools, true); assert.equal(calls[0].parsedNoMcp, true);
  assert.ok(!calls[0].prompt.includes('batch.json')); assert.ok(calls[0].prompt.includes('component.ts'));
  assert.equal(await lstat(join(f.root, 'MUST-NOT-WRITE')).then(() => true, () => false), false);
  await writeFile(model, JSON.stringify({ kind: 'tool', outside: join(f.root, 'MUST-NOT-WRITE') }));
  assert.notEqual((await dispatchTask(f.config, { ...asked, requestId: 'tool-call' })).status, 'consumed');
  assert.equal(await lstat(join(f.root, 'MUST-NOT-WRITE')).then(() => true, () => false), false);
});

test('真机接通 A7：指定收件箱选择摘要/wiki/转写→真实处理器；原件字节身份不变、缺能力失败', async t => {
  const f = await fixture(t); await pi(f, 'content'); const inbox = join(f.root, 'inbox'); await mkdir(inbox);
  f.config.workspace = { inboxDir: inbox, pollEveryMs: 1, settleMs: 0 };
  const chooseAndDispatch = async (source: string, kind: string) => {
    await f.tick(); let state = await f.state(); const material = Object.values(state.tables.materials).find(row => row.ref === source)!;
    const card = state.tables.cards[`material-card:${material.id}`]!;
    await f.click('material_option', card, card.materialOptions!.findIndex(option => option.kind === kind)); await f.tick();
    state = await f.state(); const proposal = Object.values(state.tables.proposals).find(row => row.materialId === material.id)!;
    assert.equal(proposal.kind, 'skill'); const taskCard = state.tables.cards[proposal.ticketId]!;
    await f.click(taskCard.redline ? 'dispatch_confirm' : 'dispatch', taskCard); await f.tick();
    return Object.values((await f.state()).tables.writes).find(row => row.dispatch?.materialId === material.id)!;
  };
  const bytes = '构造会议。决定使用独立开发空间。\n';
  for (const kind of ['summary', 'wiki']) {
    const source = join(inbox, `构造材料-${kind}.txt`); await writeFile(source, bytes); const identity = await lstat(source);
    const write = await chooseAndDispatch(source, kind); assert.equal(write.state, 'consumed', write.reason);
    const output = join(f.workspace, 'pa-results', write.id, `${kind}.md`); assert.match(await readFile(output, 'utf8'), /sha256=/);
    assert.equal(await readFile(source, 'utf8'), bytes); assert.equal((await lstat(source)).ino, identity.ino);
  }
  const unavailable = join(inbox, '缺能力音频.wav'); await writeFile(unavailable, 'synthetic-audio-bytes');
  assert.match((await chooseAndDispatch(unavailable, 'transcribe')).reason!, /转写未就绪/);
  const whisper = join(f.root, 'whisper.mjs'), ffmpeg = join(f.root, 'ffmpeg'), modelFile = join(f.root, 'local-model.pt');
  await writeFile(modelFile, 'isolated-model-not-a-real-model'); await writeFile(ffmpeg, 'fake');
  await writeFile(whisper, `#!/usr/bin/env node\nimport {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';const args=process.argv.slice(2);if(readFileSync(args[0],'utf8')!=='synthetic-audio-bytes')throw Error('快照错误');writeFileSync(join(args[args.indexOf('--output_dir')+1],'source.txt'),'隔离转写返回：明确标为构造。');\n`); await chmod(whisper, 0o700);
  f.config.piWorker!.transcriber = { executable: whisper, ffmpeg, modelFile };
  const audio = join(inbox, '本次明确转写音频.wav'); await writeFile(audio, 'synthetic-audio-bytes');
  const write = await chooseAndDispatch(audio, 'transcribe'); assert.equal(write.state, 'consumed', write.reason); assert.equal(await readFile(audio, 'utf8'), 'synthetic-audio-bytes');
  assert.match(await readFile(join(f.workspace, 'pa-results', write.id, 'transcript.txt'), 'utf8'), /隔离转写返回/);
});

test('真机接通 A8：部署预检零变更、显式应用/重复应用/回退，保留凭据引用/数据/旧入口', async t => {
  const f = await fixture(t), old = { ...f.config, feishu: { ...f.config.feishu!, envFile: join(f.root, 'credentials', '.env') }, worker: undefined, loopEvents: undefined, piWorker: undefined, ignoreProjectPrefixes: ['/synthetic-old-ignore'], inboxDir: join(f.root, 'old-inbox') };
  const configPath = join(f.root, 'pa.json'), settingsPath = join(f.root, 'deploy.json'), launchDir = join(f.root, 'launch'), service = join(launchDir, 'local.personal-agent.plist'), heartbeat = join(launchDir, 'local.personal-agent.heartbeat.plist');
  await mkdir(launchDir); await writeFile(configPath, JSON.stringify(old));
  await mkdir(f.config.dataDir, { recursive: true }); await writeFile(join(f.config.dataDir, 'old-prefix.jsonl'), 'unchanged old data');
  const entry = (command: string) => `<plist><string>${command}</string><string>${configPath}</string><string>original-start-mode</string></plist>`;
  await writeFile(service, entry('daemon')); await writeFile(heartbeat, entry('heartbeat-check'));
  const launchctl = join(f.root, 'launchctl.mjs'), capture = join(f.root, 'launch-calls.jsonl');
  await writeFile(launchctl, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(capture)},JSON.stringify(args)+'\\n');if(args[0]==='print')console.log('path = '+(args[1].endsWith('.heartbeat')?${JSON.stringify(heartbeat)}:${JSON.stringify(service)}));\n`); await chmod(launchctl, 0o700);
  await writeFile(settingsPath, JSON.stringify({ patch: { worker: f.config.worker, loopEvents: { dir: f.events } }, loopConfig: process.env.LOOP_PA_CONFIG, entries: [{ path: service, kind: 'service' }, { path: heartbeat, kind: 'heartbeat' }], launchctl }));
  const before = await snapshot(f.root), planned = await deploymentPlan(configPath, settingsPath); assert.ok(planned.missing.length); assert.deepEqual(await snapshot(f.root), before);
  const data = await snapshot(f.config.dataDir), originalConfig = await readFile(configPath, 'utf8'), originalLoop = await readFile(process.env.LOOP_PA_CONFIG!, 'utf8');
  const backup = join(f.root, 'deployment-snapshot'); await applyDeployment(configPath, settingsPath, backup, true);
  const applied = JSON.parse(await readFile(configPath, 'utf8')); assert.equal(applied.inboxDir, old.inboxDir); assert.deepEqual(applied.ignoreProjectPrefixes, old.ignoreProjectPrefixes); assert.equal(applied.feishu.envFile, old.feishu.envFile); assert.ok(applied.loopEvents.since);
  const again = await applyDeployment(configPath, settingsPath, join(f.root, 'unused-snapshot'), true); assert.equal(again.mode, 'unchanged'); assert.equal((await readJsonl(capture)).length, 4);
  assert.equal(await readFile(service, 'utf8'), entry('daemon')); assert.deepEqual(await snapshot(f.config.dataDir), data);
  await rollbackDeployment(backup, launchctl); assert.equal(await readFile(configPath, 'utf8'), originalConfig); assert.equal(await readFile(process.env.LOOP_PA_CONFIG!, 'utf8'), originalLoop); assert.deepEqual(await snapshot(f.config.dataDir), data);
  await rollbackDeployment(backup); // 幂等回退
  const next = join(f.root, 'second-snapshot'); await applyDeployment(configPath, settingsPath, next);
  await appendFile(configPath, '\n '); await assert.rejects(rollbackDeployment(next), /他人修改/);
});

test('真机接通：官方/旧inbox前缀并行保留，同项目同名不同文件也不合成一件', async t => {
  const f = await fixture(t); f.invoke('emit');
  const inbox = join(f.root, 'legacy-inbox'); await mkdir(join(inbox, 'loop'), { recursive: true }); f.config.inboxDir = inbox;
  await writeFile(join(inbox, 'loop', '旧格式.jsonl'), JSON.stringify({ schema: 1, id: 'legacy-event', seq: 1, at: f.now(), project: f.project, batch: '旧格式', stage: '旧段', state: 'started', reason: { category: 'test', text: '保留旧来源' }, evidence: [], detail: {} }) + '\n');
  const first = f.invoke('emit'), second = { ...first.paused, id: randomUUID(), batch: { ...first.paused.batch, file: join(f.project, 'other-batch.json') } };
  await appendFile(join(f.events, (await readdir(f.events))[0]!), JSON.stringify(second) + '\n');
  await intakeLoop(f.config, f.now()); assert.equal(Object.keys((await f.state()).tables.tickets).length, 3);
  assert.equal(await intakeLoop(f.config, f.now()), 0);
});

test('真机接通：只评审映射官方review-only且报告不是代码完成；只验收明确不支持', async t => {
  const f = await fixture(t), git = (...args: string[]) => { const res = spawnSync('git', args, { cwd: f.project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }); assert.equal(res.status, 0, res.stderr); return res.stdout.trim(); };
  git('init', '-qb', 'main'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feat/review'); await appendFile(join(f.project, 'component.ts'), 'export const second = 2;\n'); git('add', '.'); git('commit', '-qm', 'candidate'); const head = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main');
  f.config.dispatch!.projects[0]!.loop!.review = { base, head };
  const env = { AUTOREVIEW_REVIEWER_CMD: join(LOOP, 'test', 'fake-reviewer.mjs'), FAKE_MODE: 'report', FAKE_STATE_DIR: join(f.root, 'fake-reviewer') }, previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const asked = request(f, 'loop'); asked.batch = '只评审构造'; asked.recipe = 'review_only';
  const worker = commandWorker(f.config)!, started = await worker.start!(asked); assert.ok(['consumed', 'uncertain'].includes(started.status), started.reason);
  for (let i = 0; i < 80; i++) { await f.tick(); const state = await f.state(); if (Object.values(state.events).some(row => row.native?.batch.recipe === 'review-only' && row.state === 'completed')) break; await delay(50); }
  const state = await f.state(), ticket = Object.values(state.tables.tickets).find(row => row.batch === asked.batch)!;
  assert.equal(ticket.status, 'result_returned'); const card = state.tables.cards[ticket.id]!; assert.match(card.fact, /只评审报告已产出/); assert.deepEqual(card.executions ?? [], []);
  assert.equal(git('rev-parse', 'main'), base); assert.equal(git('rev-parse', 'feat/review'), head);
  assert.equal((await worker.start!({ ...asked, batch: '只验收构造', recipe: 'acceptance_only' })).status, 'failed');
});

test('真机接通 A10准备：只有应用凭据、没有用户token时明确未就绪（不接账号）', async t => {
  const f = await fixture(t); f.config.schedule = { mode: 'real', calendarIds: ['synthetic-calendar'], minuteTokens: [], pollEveryMs: 1, timeoutMs: 1000 };
  const source = resolve(import.meta.dirname, '../src/core/source-intake.ts');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const {intakeConfiguredSources}=await import(${JSON.stringify(source)}); await intakeConfiguredSources(${JSON.stringify(f.config)},new Date().toISOString());`],
    { cwd: f.project, encoding: 'utf8', env: { ...process.env, FEISHU_USER_ACCESS_TOKEN: '', FEISHU_APP_ID: 'cli_0123456789abcdef', FEISHU_APP_SECRET: 'synthetic-not-a-secret' } });
  assert.equal(result.status, 0, result.stderr); const state = await f.state(); assert.match(state.tables.health['source:schedule']!.reason, /未就绪.*缺少本人用户授权/);
  assert.equal(Object.keys(state.tables.calendars).length, 0); assert.equal(JSON.stringify(state).includes('synthetic-not-a-secret'), false);
});

test('真机接通 A8：材料产物路径注入不执行；能力探测不调用模型', async t => {
  const f = await fixture(t); await pi(f, 'path'); const asked = request(f, 'skill'); asked.skills = ['brief'];
  const receipt = await dispatchTask(f.config, asked); assert.notEqual(receipt.status, 'consumed'); assert.equal(await lstat(join(f.root, 'MUST-NOT-WRITE')).then(() => true, () => false), false);
  const result = await probeConnections(f.config); assert.equal(result.checks.find(row => row.capability === 'pi.protocol')!.ready, true); assert.equal(result.modelNotCalled, true);
  assert.equal(result.checks.find(row => row.capability === 'schedule.authorization')!.ready, false);
});
