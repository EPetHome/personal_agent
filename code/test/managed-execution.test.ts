// 丙段：全部为新建临时仓库、本机裸远端、假飞书、loop/通知替身；不接项目origin。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { validateConfig } from '../src/core/config.ts';
import { readLedger, updateLedger } from '../src/core/ledger.ts';
import { processManagedLoop } from '../src/core/managed-loop.ts';
import { commandWorker } from '../src/core/worker-adapter.ts';
import { recordHeartbeat, checkHeartbeat } from '../src/service/heartbeat.ts';
import { readRuntimeState, runtimeStatePath } from '../src/core/runtime-state.ts';
import { readJsonl } from '../src/core/store.ts';
import type { ExecutionRequest, ManagedCard, LoopEvent } from '../src/core/managed-types.ts';
import { installService, uninstallService, heartbeatLabel, serviceLabel } from '../src/service/launchd.ts';
import { sandbox } from './fixtures.ts';

const cli = resolve(import.meta.dirname, '../src/cli/main.ts'), stub = resolve(import.meta.dirname, 'loop-stub.ts');
const at = '2026-11-02T10:00:00.000Z', after = '2026-11-02T10:03:00.000Z';
async function fixture(t: TestContext) {
  const base = await sandbox(), root = await realpath(base.root); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), workerDir = join(root, 'worker'), inboxDir = join(root, 'execution-inbox'), remote = join(root, 'remote.git');
  for (const path of [project, workerDir, inboxDir]) await mkdir(path);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Constructed Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(project, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'base');
  git('checkout', '-b', 'feat/demo'); await writeFile(join(project, 'code.txt'), 'constructed change\n'); git('add', '.'); git('commit', '-m', 'batch');
  const commit = git('rev-parse', 'HEAD'); git('init', '--bare', remote); git('remote', 'add', 'test', remote);
  const notifier = join(root, 'notify-stub'), notifications = join(root, 'notifications.jsonl');
  await writeFile(notifier, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(notifications)},JSON.stringify({args:process.argv.slice(2),parentPid:process.ppid})+'\\n');\n`); await chmod(notifier, 0o700);
  const config = await validateConfig({ sources: {}, inboxDir, dataDir: join(root, 'data'), feishu: { mode: 'fake', receiverId: 'ou_test' },
    worker: { executable: process.execPath, args: [stub, workerDir], timeoutMs: 5000 }, managedLoop: { intakeEveryMs: 25 },
    heartbeat: { everyMs: 100, timeoutMs: 5000, checkEveryMs: 100, executable: notifier } });
  const settings: Record<string, any> = { allowExecution: true, projects: [project], pushTarget: { remote: 'test', visibility: 'private' }, stopCommit: commit };
  await writeFile(join(workerDir, 'settings.json'), JSON.stringify(settings));
  const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  const channel = feishuChannel(config, undefined, { managed: true });
  return { root, project, workerDir, inboxDir, remote, git, config, configPath, channel, settings, commit, notifications, seq: 0,
    ledger: () => readLedger(config.dataDir), sent: () => readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl')) };
}
type F = Awaited<ReturnType<typeof fixture>>;
async function set(f: F, extra: Record<string, unknown>) { Object.assign(f.settings, extra); await writeFile(join(f.workerDir, 'settings.json'), JSON.stringify(f.settings)); }
async function emit(f: F, state: LoopEvent['state'], detail: Record<string, unknown> = {}) {
  const event: LoopEvent = { schema: 1, id: randomUUID(), seq: ++f.seq, at, project: f.project, batch: '构造执行批次', stage: '丙', state,
    reason: { category: 'unknown', text: state }, evidence: [], detail: { branch: 'feat/demo', commit: f.commit, ...detail } };
  const result = spawnSync(process.execPath, [stub, f.workerDir, 'emit', f.inboxDir], { encoding: 'utf8', input: JSON.stringify(event), timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); return event;
}
const tick = (f: F, time = at, inspect = false) => processManagedLoop(f.config, time, { channels: [f.channel], inspect });
async function card(f: F): Promise<ManagedCard> { return Object.values((await f.ledger()).tables.cards).find(row => !row.id.startsWith('health:'))!; }
async function click(f: F, action: string, old?: ManagedCard, actor = 'ou_test') {
  const current = old ?? await card(f), message = (await f.sent()).find(row => row.noticeId === current.id)!;
  await appendFile(join(f.config.dataDir, 'feishu-inbox.jsonl'), JSON.stringify({ id: randomUUID(), at: after, actor, type: 'action', messageId: message.messageId,
    value: { action: `managed_${action}`, noticeId: current.id, revision: String(current.revision) } }) + '\n');
  await f.channel.drain(after);
}
async function completed(f: F) { await emit(f, 'completed', { gate: 'passed', review: 'passed', acceptance: { result: 'passed', manual: [], failed: [], partial: [] } }); await tick(f); }
async function candidateCompletion(f: F, ref: string, branchMissing = false, statusMode: 'top' | 'queue' | 'unreported' = 'top') {
  const branchTip = f.commit;
  f.git('checkout', '--detach'); await writeFile(join(f.project, 'candidate.txt'), 'candidate-only change\n');
  f.git('add', '.'); f.git('commit', '-m', 'candidate only'); f.commit = f.git('rev-parse', 'HEAD');
  f.git('update-ref', ref, f.commit); if (branchMissing) f.git('branch', '-D', 'feat/demo');
  f.config.worker!.candidateRefs = [ref];
  await set(f, { candidateRef: ref, candidateRefs: [ref] });
  if (statusMode !== 'top') await set(f, { status: { schema: 1, batch: '构造执行批次', updatedAt: at, branch: 'feat/demo', commit: f.commit,
    stages: [{ name: '丙', state: 'completed' }], ...(statusMode === 'queue' ? { queue: { status: 'ready', returns: 0, candidateRef: ref } } : {}) } });
  await completed(f);
  return { ref, branchTip };
}
async function waitFor<T>(get: () => Promise<T>, accept: (value: T) => boolean) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = await get(); if (accept(value)) return value; await delay(25); }
  throw new Error('等待构造结果超时');
}

test('丙 A1：本人点推到仓库后，只有批次分支到本机裸远端；原卡已推送与完整提交号', async t => {
  const f = await fixture(t); await completed(f); const before = await card(f), original = (await f.sent())[0]!.messageId;
  assert.ok(before.executions?.some(row => row.action === 'push'));
  assert.equal(f.git('ls-remote', '--heads', 'test'), '');
  await tick(f); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 0, '无人点击不能自动执行');
  await click(f, 'push'); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 0, '回调只先记账');
  const write = Object.values((await f.ledger()).tables.writes)[0]!; assert.equal(write.state, 'pending'); assert.equal(write.actor, 'ou_test'); assert.equal(write.redline, true);
  await tick(f, after); assert.equal(f.git('ls-remote', '--heads', 'test'), `${f.commit}\trefs/heads/feat/demo`);
  assert.match((await card(f)).deliveryText!, /已推送/); assert.ok((await card(f)).deliveryText!.includes(f.commit));
  const updates = (await f.sent()).filter(row => row.type === 'interactive'); assert.equal(new Set(updates.map(row => row.messageId)).size, 1); assert.equal(updates.at(-1)!.messageId, original);
  const requests = await readJsonl<any>(join(f.workerDir, 'executions.jsonl')); assert.equal(requests.length, 1); assert.equal(requests[0].force, false); assert.equal(requests[0].checkSecrets, true);
  await click(f, 'push', before); await tick(f, after); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 1);
});
for (const location of ['worktree', 'staged', 'untracked', 'committed', 'removed_history', 'filename']) test(`丙 A2：假密钥 ${location} 不推、不泄漏，原卡说明原因`, async t => {
  const f = await fixture(t), fake = 'PA_FAKE_KEY_FOR_TEST_ONLY_0123456789';
  if (location === 'untracked' || location === 'filename') await writeFile(join(f.project, location === 'filename' ? '.env' : 'untracked.txt'), location === 'filename' ? 'sample' : `API_KEY=${fake}\n`);
  else {
    await writeFile(join(f.project, 'code.txt'), `API_KEY=${fake}\n`);
    if (location !== 'worktree') f.git('add', '.');
    if (location === 'committed' || location === 'removed_history') {
      f.git('commit', '-m', 'synthetic credential');
      if (location === 'removed_history') { await writeFile(join(f.project, 'code.txt'), 'removed\n'); f.git('add', '.'); f.git('commit', '-m', 'remove'); }
      f.commit = f.git('rev-parse', 'HEAD');
    }
  }
  await completed(f); await click(f, 'push'); await tick(f, after);
  assert.equal(f.git('ls-remote', '--heads', 'test'), ''); assert.equal((await card(f)).deliveryText, '发现疑似密钥，没推');
  const ledger = await readFile(join(f.config.dataDir, 'ledger.jsonl'), 'utf8'); assert.ok(!ledger.includes(fake));
  const write = Object.values((await f.ledger()).tables.writes)[0]!; assert.equal(write.state, 'blocked'); assert.equal(write.code, 'suspected_secret');
});
test('丙 A3：合入经worker-adapter，替身收到明确请求；原卡已合入和提交号，重放不再合', async t => {
  const f = await fixture(t); await completed(f); const original = await card(f); await click(f, 'merge'); await tick(f, after);
  const requests = await readJsonl<any>(join(f.workerDir, 'received.jsonl')); assert.equal(requests.length, 1); assert.equal(requests[0].action, 'merge'); assert.equal(requests[0].commit, f.commit);
  assert.match((await card(f)).deliveryText!, /已合入/); assert.ok((await card(f)).deliveryText!.includes(f.commit));
  assert.equal(Object.values((await f.ledger()).tables.tickets)[0]!.status, 'merged');
  await tick(f, after, true); await click(f, 'merge', original); await tick(f, after); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 1);
  assert.equal(f.git('ls-remote', '--heads', 'test'), '', '合入不隐含推送');
});
for (const scenario of [
  { name: '批次分支仍是旧提交', ref: 'refs/pa/candidate', branchMissing: false, statusMode: 'top' },
  { name: '批次分支尚不存在且status未给候选名', ref: 'refs/loop/candidate', branchMissing: true, statusMode: 'unreported' },
  { name: '显式配置的自定义候选且由queue给出身份', ref: 'refs/pa/review-ready', branchMissing: false, statusMode: 'queue' },
] as const) test(`丙 返修2-1：仅候选可证时合入全链路，${scenario.name}，候选不能推送`, async t => {
  const f = await fixture(t), proof = await candidateCompletion(f, scenario.ref, scenario.branchMissing, scenario.statusMode);
  const original = await card(f), messageId = (await f.sent()).find(row => row.noticeId === original.id)!.messageId;
  assert.match(original.fact, /还没提交到分支/); assert.deepEqual(original.executions, [{ action: 'merge', branch: 'feat/demo', commit: f.commit, candidateRef: proof.ref }]);
  assert.ok(JSON.stringify((await f.sent()).find(row => row.noticeId === original.id)!.content).includes(`核实候选：${proof.ref}`));
  await click(f, 'push'); await tick(f, after); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 0);
  await click(f, 'merge'); assert.equal(Object.values((await f.ledger()).tables.writes)[0]!.state, 'pending');
  await tick(f, after); const state = await f.ledger();
  assert.match((await card(f)).deliveryText!, /已合入/); assert.ok((await card(f)).deliveryText!.includes(f.commit));
  const requests = await readJsonl<any>(join(f.workerDir, 'received.jsonl')); assert.equal(requests.length, 1);
  assert.equal(requests[0].action, 'merge'); assert.equal(requests[0].candidateRef, proof.ref); assert.equal(requests[0].commit, f.commit);
  const write = Object.values(state.tables.writes)[0]!, ticket = state.tables.tickets[original.ticketId]!;
  assert.deepEqual(write.execution, { action: 'merge', branch: 'feat/demo', commit: f.commit, candidateRef: proof.ref });
  assert.deepEqual(ticket.intents.at(-1)!.executionApproval!.target, write.execution); assert.equal(write.state, 'consumed'); assert.ok(write.text.includes(proof.ref));
  assert.equal(ticket.closure?.kind, 'merged');
  assert.ok((await f.sent()).filter(row => row.type === 'interactive').every(row => row.messageId === messageId));
  await click(f, 'merge', original); await tick(f, after, true); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 1);
  assert.equal(f.git('ls-remote', '--heads', 'test'), '', '候选合入不能隐含推送');
  if (!scenario.branchMissing) assert.equal(f.git('rev-parse', 'refs/heads/feat/demo'), proof.branchTip, '替身不把旧批次分支偷偷改到候选');
});
for (const change of ['advance', 'delete'] as const) test(`丙 返修2-1：确认后候选${change}，执行端核对精确ref头，不合入旧提交`, async t => {
  const f = await fixture(t), { ref } = await candidateCompletion(f, 'refs/pa/candidate');
  const approved = f.commit; await click(f, 'merge');
  if (change === 'delete') f.git('update-ref', '-d', ref);
  else { f.git('commit', '--allow-empty', '-m', 'new candidate'); f.git('update-ref', ref, f.git('rev-parse', 'HEAD')); f.git('merge-base', '--is-ancestor', approved, ref); }
  await tick(f, after); const write = Object.values((await f.ledger()).tables.writes)[0]!;
  assert.equal(write.code, 'target_changed'); assert.equal(write.state, 'blocked'); assert.match((await card(f)).deliveryText!, /候选ref/);
  assert.equal((await readJsonl(join(f.workerDir, 'received.jsonl'))).length, 0); assert.equal(f.git('ls-remote', '--heads', 'test'), '');
});
for (const policy of ['adapter', 'worker'] as const) test(`丙 返修2-1：确认后${policy}撤销候选白名单，不借原卡授权执行`, async t => {
  const f = await fixture(t); await candidateCompletion(f, 'refs/pa/candidate'); await click(f, 'merge');
  if (policy === 'adapter') f.config.worker!.candidateRefs = []; else await set(f, { candidateRefs: [] });
  await tick(f, after); const write = Object.values((await f.ledger()).tables.writes)[0]!;
  assert.equal(write.code, 'candidate_not_allowed'); assert.equal(write.state, 'blocked'); assert.match((await card(f)).deliveryText!, /白名单/);
  assert.equal((await readJsonl(join(f.workerDir, 'executions.jsonl'))).length, policy === 'adapter' ? 0 : 1);
  assert.equal((await readJsonl(join(f.workerDir, 'received.jsonl'))).length, 0);
});
for (const forgedRef of [undefined, 'refs/loop/candidate']) test(`丙 返修2-1：卡片缺失/伪造候选身份 ${forgedRef ?? 'missing'}，围栏不借用核实结论`, async t => {
  const f = await fixture(t); await candidateCompletion(f, 'refs/pa/candidate');
  await updateLedger(f.config.dataDir, after, (state, add) => {
    const current = Object.values(state.tables.cards)[0]!;
    add({ kind: 'put', table: 'cards', value: { ...current, executions: [{ action: 'merge', branch: 'feat/demo', commit: f.commit, ...(forgedRef ? { candidateRef: forgedRef } : {}) }] } });
  });
  await click(f, 'merge'); await tick(f, after); const write = Object.values((await f.ledger()).tables.writes)[0]!;
  assert.equal(write.state, 'blocked'); assert.match(write.reason!, /候选身份/); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 0);
});
test('丙 返修2-1：status换候选身份而旧ref仍有效，adapter不替用户改指向', async t => {
  const f = await fixture(t), { ref } = await candidateCompletion(f, 'refs/pa/candidate'); await click(f, 'merge');
  const other = 'refs/loop/candidate'; f.git('update-ref', other, f.commit); f.config.worker!.candidateRefs.push(other); await set(f, { candidateRef: other, candidateRefs: [ref, other] });
  await tick(f, after); const write = Object.values((await f.ledger()).tables.writes)[0]!;
  assert.equal(write.code, 'target_changed'); assert.match(write.reason!, /候选ref/); assert.equal((await readJsonl(join(f.workerDir, 'executions.jsonl'))).length, 0);
  assert.equal(f.git('rev-parse', ref), f.commit);
});
test('丙 返修2-1：即使绕过卡片直接提交候选push，adapter和执行端也各自拒绝', async t => {
  const f = await fixture(t), { ref } = await candidateCompletion(f, 'refs/pa/candidate');
  const request: ExecutionRequest = { requestId: randomUUID(), project: f.project, batch: '构造执行批次', stage: '丙', action: 'push',
    branch: 'feat/demo', commit: f.commit, candidateRef: ref, remote: 'test', visibility: 'private', source: 'user_via_pa', force: false, checkSecrets: true, protectedBranches: ['main', 'master'] };
  assert.equal((await commandWorker(f.config)!.execute!(request)).code, 'candidate_not_pushable');
  assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 0);
  const result = spawnSync(process.execPath, [stub, f.workerDir, 'push'], { input: JSON.stringify(request), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).code, 'candidate_not_pushable');
  assert.equal((await readJsonl(join(f.workerDir, 'received.jsonl'))).length, 0); assert.equal(f.git('ls-remote', '--heads', 'test'), '');
});
test('丙 A4：停批次经替身回执，原卡已停/提交；五栏交接简报可从新CLI重放查到', async t => {
  const f = await fixture(t); await emit(f, 'paused', { question: '环境卡住' }); await tick(f); await tick(f, after);
  await click(f, 'stop'); await tick(f, after); assert.match((await card(f)).deliveryText!, /已停/); assert.ok((await card(f)).deliveryText!.includes(f.commit));
  const requests = await readJsonl<any>(join(f.workerDir, 'received.jsonl')); assert.equal(requests[0].action, 'stop');
  await tick(f, after, true); const result = spawnSync(process.execPath, [cli, 'overview', '--config', f.configPath, '--json'], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const view = JSON.parse(result.stdout), briefs = Object.values(view.handoffs) as any[]; assert.equal(briefs.length, 1);
  for (const key of ['goal', 'progress', 'decisions', 'unresolved', 'codeLocation']) assert.ok(briefs[0][key]?.length, key);
  assert.ok(briefs[0].codeLocation.includes(f.project)); assert.ok(briefs[0].decisions.some((line: string) => line.includes('停掉这批')));
  assert.equal((Object.values(view.tickets) as any[])[0]!.status, 'stopped');
});
test('丙：返修到上限自动存五栏简报，原必修清单不丢，重复巡检不再生成', async t => {
  const f = await fixture(t); await emit(f, 'repair_limit', { mustFix: ['构造必修甲', '构造必修乙'] }); await tick(f); await tick(f, after); await tick(f, after, true);
  const briefs = Object.values((await f.ledger()).tables.handoffs); assert.equal(briefs.length, 1); assert.deepEqual(briefs[0]!.unresolved, ['构造必修甲', '构造必修乙']);
});
for (const absent of ['explicit', 'missing_stage']) test(`丙 A5：会话消失 ${absent} 只进等你，不推卡；重新出现核销`, async t => {
  const f = await fixture(t); await emit(f, 'started'); await tick(f);
  await set(f, { status: { schema: 1, batch: '构造执行批次', updatedAt: after, stages: absent === 'explicit' ? [{ name: '丙', state: 'started', sessionPresent: false, sessionId: 'test-session' }] : [] } });
  await tick(f, after, true); let state = await f.ledger(); assert.ok(Object.values(state.tables.attentions).some(row => row.status === 'waiting' && row.reason.includes('这件事没人在做了')));
  assert.equal(Object.keys(state.tables.cards).length, 0); assert.equal((await f.sent()).length, 0);
  await set(f, { status: { schema: 1, batch: '构造执行批次', updatedAt: after, stages: [{ name: '丙', state: 'started', sessionPresent: true, sessionId: 'test-session' }] } });
  await tick(f, after, true); state = await f.ledger(); assert.ok(Object.values(state.tables.attentions).filter(row => row.id.startsWith('session:')).every(row => row.status === 'resolved'));
});
test('丙 A6：送话通道失败，当前轮马上发话没送到卡；不依赖巡检、不重新送话', async t => {
  const f = await fixture(t); await emit(f, 'paused'); await tick(f); await tick(f, after); await set(f, { receipt: 'failed', reason: '构造送话通道失败' });
  await click(f, 'suggest'); await tick(f, after); const state = await f.ledger(), health = state.tables.cards['health:write:message']!;
  assert.ok(health); assert.match(health.fact, /没能确认你的话已送到/); assert.ok((await f.sent()).some(row => row.noticeId === health.id));
  await tick(f, after); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 1);
  assert.equal((await f.sent()).filter(row => row.noticeId === health.id).length, 1);
});
test('丙：派工停滞不推，来源查询失败马上报故障，不把失败误判成会话消失', async t => {
  const f = await fixture(t); await emit(f, 'started'); await tick(f); await tick(f, '2026-11-02T10:31:00Z', true);
  assert.equal((await f.sent()).length, 0); assert.ok(Object.values((await f.ledger()).tables.attentions).some(row => row.id.startsWith('stale:')));
  await set(f, { statusError: true }); await tick(f, '2026-11-02T10:32:00Z', true);
  const state = await f.ledger(); assert.ok(Object.values(state.tables.cards).some(row => row.fact.includes('暂时读不到 Loop 的工作进展'))); assert.ok(!Object.values(state.tables.attentions).some(row => row.id.startsWith('session:')));
});
test('丙：公开远端在按钮上明说；确认后远端公开状态改变则不执行', async t => {
  const f = await fixture(t); await set(f, { pushTarget: { remote: 'test', visibility: 'public' } }); await completed(f);
  assert.match(JSON.stringify((await f.sent())[0]!.content), /推到仓库（公开）/);
  await click(f, 'push'); await set(f, { pushTarget: { remote: 'test', visibility: 'private' } }); await tick(f, after);
  assert.equal(f.git('ls-remote', '--heads', 'test'), ''); assert.match((await card(f)).deliveryText!, /已变化/); assert.equal((await readJsonl(join(f.workerDir, 'executions.jsonl'))).length, 0);
});
test('丙：main不显示推送/合入；伪造按钮、非本人、按建议都不能执行', async t => {
  const f = await fixture(t); await emit(f, 'completed', { branch: 'main', commit: f.git('rev-parse', 'main') }); await tick(f);
  assert.ok(!(await card(f)).executions?.length); await click(f, 'push'); await click(f, 'merge'); await click(f, 'suggest'); await tick(f, after);
  assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 0);
  await completed(f); await click(f, 'push', undefined, 'ou_other'); await tick(f, after); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 0);
});
test('丙：模型建议停批次/推到仓库也只能增加红线，不能借按建议绕过明确确认', async t => {
  for (const suggestion of ['停掉这批', '推到仓库', 'stop the batch']) {
    const f = await fixture(t), model = join(f.root, 'answer.json'); await writeFile(model, JSON.stringify({ answer: { suggestion, basis: '构造建议，不授予执行权', redline: false } }));
    f.config.judge = { executable: resolve(import.meta.dirname, 'pi-stub.ts'), model, timeoutMs: 3000 };
    await emit(f, 'paused'); await tick(f); await tick(f, after);
    assert.equal((await card(f)).redline, true); assert.doesNotMatch(JSON.stringify((await f.sent())[0]!.content), /"managed_suggest"/);
    await click(f, 'suggest'); await tick(f, after); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 0);
  }
});
test('丙：推送后丢回执则不确定，旧点击/重启重放/巡检没有第二次；远端仍只一条分支', async t => {
  const f = await fixture(t); await completed(f); const original = await card(f); await set(f, { dropReceipt: true }); await click(f, 'push'); await tick(f, after);
  assert.match((await card(f)).deliveryText!, /不确定/); assert.equal(f.git('ls-remote', '--heads', 'test'), `${f.commit}\trefs/heads/feat/demo`);
  await click(f, 'push', original); await processManagedLoop(f.config, after, { channels: [feishuChannel(f.config, undefined, { managed: true })], inspect: true });
  assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 1);
});
test('丙：合入缺少结果或提交号不冒充已合入，sending恢复也只标不确定', async t => {
  const f = await fixture(t); await set(f, { omitExecutionResult: true }); await completed(f); await click(f, 'merge'); await tick(f, after);
  assert.match((await card(f)).deliveryText!, /不确定/); assert.notEqual(Object.values((await f.ledger()).tables.tickets)[0]!.status, 'merged');
  const g = await fixture(t); await completed(g); await click(g, 'push'); const write = Object.values((await g.ledger()).tables.writes)[0]!;
  await updateLedger(g.config.dataDir, after, (_state, add) => add({ kind: 'put', table: 'writes', value: { ...write, state: 'sending' } }));
  await tick(g, after); assert.match((await card(g)).deliveryText!, /不确定/); assert.equal((await readJsonl(join(g.workerDir, 'attempts.jsonl'))).length, 0);
});
test('丙：待写之后意图收紧或卡片版本改变，发送前再次围栏阻止', async t => {
  const f = await fixture(t); await completed(f); await click(f, 'push');
  await updateLedger(f.config.dataDir, after, (state, add) => { const ticket = Object.values(state.tables.tickets)[0]!, intent = ticket.intents.at(-1)!;
    add({ kind: 'put', table: 'tickets', value: { ...ticket, intents: [...ticket.intents, { ...intent, version: intent.version + 1, boundaries: { ...intent.boundaries, execute: [] } }] } }); });
  await tick(f, after); assert.equal(f.git('ls-remote', '--heads', 'test'), ''); assert.equal((await readJsonl(join(f.workerDir, 'attempts.jsonl'))).length, 0);
});

test('丙：远端分支已分叉，不强推覆盖；用户批准后分支头再变也不推', async t => {
  const f = await fixture(t), foreign = f.git('commit-tree', f.git('rev-parse', 'main^{tree}'), '-p', f.git('rev-parse', 'main'), '-m', 'foreign remote');
  f.git('push', 'test', `${foreign}:refs/heads/feat/demo`); await completed(f); await click(f, 'push'); await tick(f, after);
  assert.equal(f.git('ls-remote', '--heads', 'test'), `${foreign}\trefs/heads/feat/demo`); assert.doesNotMatch((await card(f)).deliveryText!, /已推送/);
  const g = await fixture(t); await completed(g); await click(g, 'push'); await writeFile(join(g.project, 'late.txt'), 'late change'); g.git('add', '.'); g.git('commit', '-m', 'late');
  await tick(g, after); assert.equal(g.git('ls-remote', '--heads', 'test'), ''); assert.match((await card(g)).deliveryText!, /分支头已变化/);
});
async function startDaemon(f: F, t: TestContext) {
  const child = spawn(process.execPath, [cli, 'daemon', '--config', f.configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', value => stderr += value); child.stdout.resume();
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } });
  await waitFor(() => readRuntimeState(f.config.dataDir), state => !!state?.completedAt);
  return { child, stderr: () => stderr };
}
test('丙 A7：实际主进程SIGKILL后，独立CLI心跳超时由另一进程弹一次本机替身通知', async t => {
  const f = await fixture(t), run = await startDaemon(f, t), pulse = (await readRuntimeState(f.config.dataDir))!;
  const exit = once(run.child, 'exit'); run.child.kill('SIGKILL'); await exit;
  const time = new Date(Date.parse(pulse.completedAt!) + 5001).toISOString();
  const result = spawnSync(process.execPath, [cli, 'heartbeat-check', '--config', f.configPath, '--now', time, '--json'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'notified');
  const messages = await readJsonl<any>(f.notifications); assert.equal(messages.length, 1); assert.ok(messages[0].args.includes('personal agent 停了')); assert.equal(messages[0].parentPid, result.pid); assert.notEqual(result.pid, run.child.pid);
  const repeat = spawnSync(process.execPath, [cli, 'heartbeat-check', '--config', f.configPath, '--now', time, '--json'], { encoding: 'utf8' }); assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal((await readJsonl(f.notifications)).length, 1);
});
test('丙 A8：实际主进程持续更新心跳，独立进程多次检查不弹任何通知', async t => {
  const f = await fixture(t), run = await startDaemon(f, t), first = (await readRuntimeState(f.config.dataDir))!.completedAt;
  await waitFor(() => readRuntimeState(f.config.dataDir), state => !!state?.completedAt && state.completedAt !== first);
  for (let i = 0; i < 3; i++) {
    const checked = spawnSync(process.execPath, [cli, 'heartbeat-check', '--config', f.configPath, '--json'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(checked.status, 0, checked.stderr); assert.equal(JSON.parse(checked.stdout).status, 'healthy'); await delay(100);
  }
  assert.equal((await readJsonl(f.notifications)).length, 0); const exit = once(run.child, 'exit'); run.child.kill('SIGTERM'); await exit; assert.equal(run.child.exitCode, 0, run.stderr());
});
test('丙：心跳从未启动安静；通知未确认不重弹，恢复后第二次停摆可报新一条', async t => {
  const f = await fixture(t); assert.equal((await checkHeartbeat(f.config, after, async () => assert.fail('不应通知'))).status, 'not_started');
  await recordHeartbeat(f.config, at, 'run'); let calls = 0;
  assert.equal((await checkHeartbeat(f.config, after, async () => { calls++; throw new Error('构造失败'); })).status, 'uncertain');
  await checkHeartbeat(f.config, after, async () => { calls++; }); assert.equal(calls, 1);
  await recordHeartbeat(f.config, after, 'run'); await checkHeartbeat(f.config, '2026-11-02T10:04:00Z', async () => { calls++; }); assert.equal(calls, 2);
});
test('丙：并发独立检查只弹一次；坏心跳状态降级报无法核实而不改原文件', async t => {
  const f = await fixture(t); await recordHeartbeat(f.config, at, 'concurrent'); let calls = 0;
  const notify = async () => { calls++; await delay(100); };
  await Promise.all([checkHeartbeat(f.config, after, notify), checkHeartbeat(f.config, after, notify)]); assert.equal(calls, 1);
  const g = await fixture(t); await mkdir(g.config.dataDir); const path = runtimeStatePath(g.config.dataDir), corrupt = '{broken runtime state}\n'; await writeFile(path, corrupt);
  let title = ''; const result = await checkHeartbeat(g.config, after, async value => { title = value; });
  assert.equal(result.status, 'unavailable_notified'); assert.equal(title, 'personal agent 心跳无法核实'); assert.equal(await readFile(path, 'utf8'), corrupt);
});
test('丙：独立launchd plist和主进程分开；临时安装/语法/冲突/卸载保护，不调用真实launchctl', async t => {
  const f = await fixture(t), target = join(f.root, 'agents & demo');
  await installService(f.configPath, target); await installService(f.configPath, target, false, undefined, true);
  const path = join(target, `${heartbeatLabel}.plist`), content = await readFile(path, 'utf8');
  assert.match(content, /heartbeat-check/); assert.match(content, /<key>StartInterval<\/key><integer>1<\/integer>/); assert.doesNotMatch(content, /KeepAlive|FEISHU_APP_SECRET/);
  assert.ok(content.includes(heartbeatLabel)); assert.ok((await readFile(join(target, `${serviceLabel}.plist`), 'utf8')).includes('daemon'));
  if (process.platform === 'darwin') { const result = spawnSync('/usr/bin/plutil', ['-lint', '--', path], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr + result.stdout); }
  await assert.rejects(installService(f.configPath, target, false, undefined, true), /已有安装记录/);
  await appendFile(path, '\n<!-- changed -->\n'); await assert.rejects(uninstallService(f.configPath, target, undefined, true), /改动/); await writeFile(path, content);
  await uninstallService(f.configPath, target, undefined, true); await uninstallService(f.configPath, target);
});
