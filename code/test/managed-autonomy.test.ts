// 戊段：临时账本、构造事件/worker、假飞书；不读取真实账号或运行数据。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { validateConfig } from '../src/core/config.ts';
import { runService } from '../src/service/daemon.ts';
import { acquireLock } from '../src/core/locks.ts';
import { readLedger, updateLedger } from '../src/core/ledger.ts';
import { deliverManagedHealth, gateAssessments, processManagedLoop } from '../src/core/managed-loop.ts';
import type { ManagedChannel } from '../src/core/managed-loop.ts';
import { assessLoop } from '../src/core/loop-assessor.ts';
import { intakeLoop } from '../src/core/loop-intake.ts';
import { planAutonomy } from '../src/core/autonomy.ts';
import { dispatchWrites, recordManagedAction, recordWorkerReceipt } from '../src/core/managed-actions.ts';
import { dispatchTasks } from '../src/core/task-actions.ts';
import { OperationFailure } from '../src/core/failures.ts';
import { guardWrite } from '../src/core/guard.ts';
import { automaticApproval, automaticSafety, actionScope, modeStats } from '../src/core/autonomy-policy.ts';
import { commandWorker } from '../src/core/worker-adapter.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import type { LoopEvent, LoopWorker, ManagedCard } from '../src/core/managed-types.ts';
import { readJsonl } from '../src/core/store.ts';
import { sandbox } from './fixtures.ts';
const at = '2026-11-06T10:00:00.000Z';
async function fixture(t: TestContext, external = false) {
  const temp = await sandbox(), root = await realpath(temp.root), project = join(root, 'project'), loop = join(root, 'worker');
  await mkdir(join(project, 'src'), { recursive: true }); await mkdir(loop);
  await writeFile(join(project, 'src/widget.ts'), 'export const value = 1;\n');
  const config = await validateConfig({ sources: { loop: null, cc: null }, dataDir: join(root, 'data'), inboxDir: join(root, 'inbox'),
    feishu: { mode: 'fake', receiverId: 'ou_autonomy' }, managedLoop: { verifyAfterMs: 0 },
    worker: { executable: process.execPath, args: [resolve(import.meta.dirname, 'loop-stub.ts'), loop], timeoutMs: 30000 },
    dispatch: { projects: [{ name: '测试项目', path: project, workspace: project }] } });
  await mkdir(join(config.inboxDir!, 'loop'), { recursive: true });
  const channel = feishuChannel(config, undefined, { managed: true }); await channel.start();
  t.after(async () => { await channel.stop(); await rm(root, { recursive: true, force: true }); });
  const events: LoopEvent[] = [], sent: any[] = [], starts: any[] = [];
  const worker: LoopWorker = external ? commandWorker(config)! : {
    async status(batch, project) { const event = events.filter(row => row.batch === batch && row.project === project).at(-1)!; return { schema: 1, batch, updatedAt: event?.at ?? at,
      stages: event ? [{ name: event.stage, state: event.state }] : [] }; },
    async send(input) { sent.push(input); return { requestId: input.requestId, status: 'consumed' }; },
    async start(input) { starts.push(input); return { requestId: input.requestId, status: 'consumed' }; },
  };
  return { root, project, loop, config, channel, worker, events, sent, starts, seq: 0, now: at, channels: [channel] as ManagedChannel[],
    ledger: () => readLedger(config.dataDir), out: () => readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl')) };
}
type F = Awaited<ReturnType<typeof fixture>>;
const tick = (f: F) => processManagedLoop(f.config, f.now, { channels: f.channels, worker: f.worker });
async function emit(f: F, kind: LoopEvent['state'] = 'paused', detail: Record<string, unknown> = {}, category = kind === 'paused' ? 'environment' : 'decision', batch = '环境暂停') {
  const event: LoopEvent = { schema: 1, id: randomUUID(), seq: ++f.seq, at: f.now, project: f.project, batch, stage: '戊', state: kind,
    reason: { category, text: kind === 'paused' ? '构造环境暂停' : '需要决定' }, evidence: [], detail };
  f.events.push(event); await appendFile(join(f.loop, 'events.jsonl'), JSON.stringify(event) + '\n');
  await appendFile(join(f.config.inboxDir!, 'loop', `${batch}.jsonl`), JSON.stringify(event) + '\n'); await tick(f);
  return (await f.ledger()).tables.cards[Object.values((await f.ledger()).tables.tickets).find(row => row.batch === batch)!.id]!;
}
async function text(f: F, value: string, ref?: string) {
  const id = randomUUID();
  await appendFile(join(f.config.dataDir, 'feishu-inbox.jsonl'), JSON.stringify({ type: 'text', id, at: f.now, actor: 'ou_autonomy', messageId: id, text: value, chatType: 'p2p', ...(ref ? { ref } : {}) }) + '\n');
  await f.channel.drain(f.now); return ((await f.out()).find(row => row.key === `reply:${id}`)?.content as { text: string })?.text;
}
async function click(f: F, card: ManagedCard, action: string, extra: { option?: string; text?: string; id?: string } = {}) {
  const id = extra.id ?? randomUUID(), messageId = (await f.out()).find(row => row.noticeId === card.id)!.messageId;
  await appendFile(join(f.config.dataDir, 'feishu-inbox.jsonl'), JSON.stringify({ type: 'action', id, at: f.now, actor: 'ou_autonomy', messageId,
    value: { action: `managed_${action}`, noticeId: card.id, revision: String(card.revision), ...(extra.option ? { option: extra.option } : {}) }, relayText: extra.text }) + '\n');
  await f.channel.drain(f.now);
  // 常驻可能已有读取了旧快照的drain；它完成不代表刚追加的这次点击也已处理。
  const state = await until(f.ledger, state => !!state.tables.receipts[`action:${id}`], '本次点击的实际处理回执');
  return state.tables.receipts[`action:${id}`]!.response;
}
const current = async (f: F, id: string) => (await f.ledger()).tables.cards[id]!;
async function train(f: F, count = 20, agree = count) {
  let card!: ManagedCard;
  for (let i = 0; i < count; i++) { card = await emit(f); await click(f, card, i < agree ? 'suggest' : 'send_text', { text: '先等一下' }); await tick(f); }
  return current(f, card.id);
}
async function modeCard(f: F, card: ManagedCard) {
  const scope = actionScope(await f.ledger(), card)!;
  return Object.values((await f.ledger()).tables.cards).find(row => row.modeControl?.scopeId === scope.id)!;
}
async function auto(f: F, card: ManagedCard) { const control = await modeCard(f, card); assert.ok(control?.modeControl?.canAuto); assert.match(await click(f, control, 'mode_auto'), /改为 auto/); await tick(f); }
async function pendingAutomatic(f: F) {
  const prior = f.events.at(-1)!, event: LoopEvent = { ...prior, id: randomUUID(), seq: ++f.seq };
  f.events.push(event); await appendFile(join(f.loop, 'events.jsonl'), JSON.stringify(event) + '\n');
  await appendFile(join(f.config.inboxDir!, 'loop', `${event.batch}.jsonl`), JSON.stringify(event) + '\n'); await intakeLoop(f.config, at);
  const state = await f.ledger(), assignment = Object.values(state.tables.assignments).find(row => row.lastEventId === event.id)!;
  const assessment = await assessLoop(f.config, state, assignment, at, f.worker);
  await updateLedger(f.config.dataDir, at, (state, add) => { add({ kind: 'put', table: 'assessments', value: assessment }); gateAssessments(state, add, at); planAutonomy(state, add, at); });
  const card = await current(f, assignment.ticketId); return { card, write: (await f.ledger()).tables.writes[card.automaticRequestId!]! };
}

test('戊 A1–A3：20条18条一致才提示；本人确认后替身收到继续，原卡静默交代+撤回，撤回退建议', async t => {
  const f = await fixture(t, true); let card = await train(f, 20, 18), state = await f.ledger();
  const scope = actionScope(state, card)!; assert.equal(modeStats(state, state.tables.modes[scope.id]!).count, 20);
  const offer = await modeCard(f, card); assert.equal(offer.title, '这类可以改自动'); assert.equal(state.tables.modes[scope.id]!.mode, 'suggest');
  assert.equal((await readJsonl(join(f.loop, 'received.jsonl'))).length, 20);
  await auto(f, card); const before = (await f.out()).filter(row => row.noticeId === card.id), messageId = before[0]!.messageId;
  card = await emit(f); state = await f.ledger(); const write = state.tables.writes[card.automaticRequestId!]!;
  assert.equal(write.state, 'consumed'); assert.equal(write.actor, 'pa:auto'); assert.equal(write.text, '继续');
  assert.match(card.deliveryText!, /已按建议处理/); assert.equal(card.interrupt, false);
  const out = (await f.out()).filter(row => row.noticeId === card.id); assert.ok(out.every(row => row.messageId === messageId));
  assert.equal(out.at(-1)!.operation, 'update'); assert.match(JSON.stringify(out.at(-1)!.content), /"content":"撤回"/);
  assert.equal(state.observations.filter(row => row.kind === 'called' && row.eventId === card.eventId).length, 0);
  assert.equal(Object.keys(state.tables.choices).length, 20, '自动结果不能自喂升级证据');
  assert.match(await click(f, card, 'withdraw'), /退回建议/); await tick(f);
  assert.equal((await f.ledger()).tables.modes[scope.id]!.mode, 'suggest');
  card = await emit(f); assert.equal(card.automaticRequestId, undefined); assert.equal(card.actionMode, 'reply');
  assert.equal((await readJsonl(join(f.loop, 'received.jsonl'))).length, 21); assert.match(JSON.stringify((await f.out()).at(-1)!.content), /managed_suggest/);
  await tick(f); assert.equal((await readJsonl(join(f.loop, 'received.jsonl'))).length, 21);
});

test('戊：19条、低于九成、失败回执、重复输入都不能凑提示线；来源/动作分别计算', async t => {
  const f = await fixture(t); let card = await train(f, 19, 17); assert.equal(await modeCard(f, card), undefined);
  card = await emit(f); await click(f, card, 'send_text', { text: '先等等' }); await tick(f); assert.equal(await modeCard(f, card), undefined);
  const firstScope = actionScope(await f.ledger(), card)!.id;
  const other = await emit(f, 'paused', {}, 'timeout', '超时暂停'); await click(f, other, 'suggest', { id: 'same-input' }); await tick(f);
  await click(f, other, 'suggest', { id: 'same-input' }); await tick(f);
  assert.equal(Object.values((await f.ledger()).tables.choices).filter(row => row.scopeId === firstScope).length, 20);
  assert.equal(Object.values((await f.ledger()).tables.choices).filter(row => row.scopeId !== firstScope).length, 1);
  f.worker.send = async input => ({ requestId: input.requestId, status: 'failed' });
  card = await emit(f); await click(f, card, 'suggest'); await tick(f); assert.equal(Object.keys((await f.ledger()).tables.choices).length, 21);
});

test('戊 A4：相同needs_decision类已自动，红线仍出明确确认卡；伪造自动/普通按钮也不能发', async t => {
  const f = await fixture(t); let card!: ManagedCard;
  for (let i = 0; i < 20; i++) { card = await emit(f, 'needs_decision', { question: '选哪个？', options: ['A', 'B'] }, 'decision', '决定类'); await click(f, card, 'suggest'); await tick(f); }
  await auto(f, card);
  for (const question of ['删除旧数据吗？', '合入并推送远端吗？', '修改验收标准吗？', '修改红线清单吗？']) {
    card = await emit(f, 'needs_decision', { question, options: ['做', '不做'] }, 'decision', '决定类');
    assert.equal(card.redline, true); const count = f.sent.length;
    assert.doesNotMatch(JSON.stringify((await f.out()).filter(row => row.noticeId === card.id).at(-1)!.content), /"managed_suggest"/);
    await click(f, card, 'suggest'); await tick(f); assert.equal(f.sent.length, count);
    const state = await f.ledger(), scope = actionScope(state, card)!, mode = state.tables.modes[scope.id]!;
    const write = { id: 'forged', ticketId: card.ticketId, assignmentId: card.assignmentId, cardId: card.id, cardRevision: card.revision, eventId: card.eventId,
      intentVersion: state.tables.tickets[card.ticketId]!.intents.at(-1)!.version, actor: 'pa:auto', inputId: mode.inputId!, at, text: card.suggestion, action: 'auto_reply',
      state: 'pending' as const, redline: false, explicitConfirmation: false, basis: '', automation: { scopeId: scope.id, version: mode.version!, inputId: mode.inputId! } };
    assert.equal(guardWrite(state, write).allowed, false);
  }
});

test('戊 A5：派工20次确认后可自动；新任务直接派，已自动派原卡带撤回；其他配方/项目不借权限', async t => {
  const f = await fixture(t); let card!: ManagedCard;
  for (let i = 0; i < 20; i++) { await text(f, `给测试项目的 src/widget.ts 补测试，第${i}件`); await tick(f);
    card = Object.values((await f.ledger()).tables.cards).filter(row => row.proposalId).at(-1)!; await click(f, card, 'dispatch'); await tick(f); }
  assert.equal(f.starts.length, 20); await auto(f, card);
  await text(f, '给测试项目的 src/widget.ts 补测试，新一件'); await tick(f);
  card = Object.values((await f.ledger()).tables.cards).filter(row => row.proposalId).at(-1)!;
  assert.equal(f.starts.length, 21); assert.equal(f.starts.at(-1)!.mode, 'auto'); assert.equal(f.starts.at(-1)!.source, 'pa_auto');
  assert.match(card.deliveryText!, /已自动派/); assert.ok(card.automaticRequestId); assert.equal(card.interrupt, false);
  assert.match(JSON.stringify((await f.out()).filter(row => row.noticeId === card.id).at(-1)!.content), /"content":"撤回"/);
  await text(f, '给测试项目只评审 src/widget.ts'); await tick(f); assert.equal(f.starts.length, 21);
  await text(f, '给测试项目的 src/widget.ts 补测试并删除旧文件'); await tick(f); assert.equal(f.starts.length, 21);
  await click(f, await current(f, card.id), 'withdraw'); await tick(f);
  await text(f, '给测试项目的 src/widget.ts 补测试，再一件'); await tick(f); assert.equal(f.starts.length, 21);
});

test('戊 A6/A7：连续5次选B只起草规则，未确认不引用；确认后建议B并引用确切版本', async t => {
  const f = await fixture(t); let card!: ManagedCard;
  for (let i = 0; i < 5; i++) { card = await emit(f, 'needs_decision', { question: '先做A还是B？', options: ['A', 'B'] }); await click(f, card, 'option', { option: '1' }); await tick(f); }
  let state = await f.ledger(); const candidate = Object.values(state.tables.memoryCandidates)[0]!;
  assert.equal(candidate.kind, 'rule'); assert.equal(candidate.status, 'pending'); assert.equal(Object.keys(state.tables.memories).length, 0);
  card = await emit(f, 'needs_decision', { question: '先做A还是B？', options: ['A', 'B'] }); assert.equal(card.suggestion, 'A'); assert.doesNotMatch(card.basis, /规则参照 memory:/);
  const ruleCard = state.tables.cards[candidate.id]!; assert.match(await click(f, ruleCard, 'memory_confirm'), /已确认规则/); await tick(f);
  card = await emit(f, 'needs_decision', { question: '先做A还是B？', options: ['A', 'B'] });
  assert.equal(card.suggestion, 'B'); assert.match(card.basis, new RegExp(`规则参照 ${candidate.memoryId} v1`));
  assert.equal(card.actionMode, 'reply'); assert.equal(f.sent.length, 5, '确认规则不等于确认送话');
  const different = await emit(f, 'needs_decision', { question: '另一个取舍？', options: ['A', 'B'] }, 'decision', '另一个问题'); assert.equal(different.suggestion, 'A');
});

test('戊 A8/A9：人物候选不作关系推断；本人确认后飞书问答扩展Promate关联，未确认偏好/忙碌不用', async t => {
  const f = await fixture(t); await emit(f, 'needs_decision', { question: 'Promate 产品排期？', options: ['A', 'B'] }, 'decision', 'Promate跟进');
  await text(f, '张三：Promate 的产品负责人'); await tick(f);
  let state = await f.ledger(); const candidate = Object.values(state.tables.memoryCandidates)[0]!;
  assert.deepEqual(candidate.terms, ['Promate']); assert.equal(Object.keys(state.tables.memories).length, 0);
  let answer = (await text(f, '张三相关的事'))!; assert.doesNotMatch(answer, /Promate|产品负责人/);
  await click(f, state.tables.cards[candidate.id]!, 'memory_confirm'); await tick(f);
  answer = (await text(f, '张三相关的事'))!; assert.match(answer, /Promate跟进/); assert.match(answer, /产品负责人/); assert.match(answer, /已确认 memory:/);
  await text(f, '我偏好先处理短任务'); await text(f, '我最近在忙秋季发布'); await tick(f);
  assert.doesNotMatch((await text(f, '我的偏好'))!, /短任务/); assert.doesNotMatch((await text(f, '我在忙什么'))!, /秋季/);
  state = await f.ledger(); for (const c of Object.values(state.tables.memoryCandidates).filter(row => row.status === 'pending')) await click(f, state.tables.cards[c.id]!, 'memory_confirm');
  await tick(f); assert.match((await text(f, '我的偏好'))!, /短任务/); assert.match((await text(f, '我在忙什么'))!, /秋季发布/);
  const card = await emit(f, 'needs_decision', { question: '张三的排期？', options: ['A', 'B'] }); assert.match(card.basis, /Promate 的产品负责人/); assert.match(card.basis, /先处理短任务/); assert.match(card.basis, /秋季发布/);
});

test('戊：记忆版本保留、旧候选不能覆盖新确认；重复/非本人/错误消息确认无效，重放不丢', async t => {
  const f = await fixture(t); await text(f, '人物：张三：Promate 的产品负责人'); await tick(f);
  let state = await f.ledger(), first = Object.values(state.tables.memoryCandidates)[0]!; const c1 = state.tables.cards[first.id]!;
  const message = (await f.out()).find(row => row.noticeId === c1.id)!.messageId;
  const input = { id: 'not-me', at, actor: 'other', messageId: message, cardId: c1.id, revision: c1.revision, action: 'memory_confirm' };
  await recordManagedAction(f.config, input); await recordManagedAction(f.config, { ...input, id: 'bad-msg', actor: 'ou_autonomy', messageId: 'not-the-card' });
  assert.equal(Object.keys((await f.ledger()).tables.memories).length, 0);
  await click(f, c1, 'memory_confirm', { id: 'confirm-once' }); await click(f, c1, 'memory_confirm', { id: 'confirm-once' }); await tick(f);
  await text(f, '人物：张三：Promate 的技术负责人'); await text(f, '人物：张三：Promate 的业务负责人'); await tick(f);
  state = await f.ledger(); const pending = Object.values(state.tables.memoryCandidates).filter(row => row.status === 'pending'); assert.equal(pending.length, 2);
  await click(f, state.tables.cards[pending[0]!.id]!, 'memory_confirm');
  assert.match(await click(f, state.tables.cards[pending[1]!.id]!, 'memory_confirm'), /旧候选失效/);
  const memory = (await f.ledger()).tables.memories[first.memoryId]!; assert.equal(memory.versions.length, 2); assert.equal(memory.versions[0]!.content, 'Promate 的产品负责人');
  const restored = feishuChannel(f.config, undefined, { managed: true }); await restored.drain(at); await tick(f);
  assert.deepEqual((await f.ledger()).tables.memories[first.memoryId], memory);
});

test('戊：影子只入账不发不送；相同类红线仍叫本人；严重错误立刻退档，不能由新样本清零', async t => {
  const f = await fixture(t); let card = await emit(f); await click(f, card, 'mode_settings'); await tick(f);
  let control = await modeCard(f, card); assert.match(await click(f, control, 'mode_auto'), /没有够线/);
  await click(f, control, 'mode_shadow'); await tick(f); const before = (await f.out()).filter(row => row.type === 'interactive').length;
  card = await emit(f); assert.equal((await f.out()).filter(row => row.type === 'interactive').length, before); assert.equal(f.sent.length, 0);
  card = await emit(f, 'paused', { question: '删除文件吗？', options: ['删除', '保留'] }); assert.equal(card.redline, true);
  assert.equal((await f.out()).filter(row => row.type === 'interactive').length, before + 1);
  control = await modeCard(f, card); await click(f, control, 'mode_suggest'); await tick(f);
  card = await emit(f); await click(f, card, 'feedback_严重错误', { id: 'serious-1', text: '这是严重错误' }); await tick(f);
  const state = await f.ledger(), scope = actionScope(state, card)!; assert.equal(state.tables.modes[scope.id]!.mode, 'shadow');
  assert.equal(modeStats(state, state.tables.modes[scope.id]!).serious, 1);
});

test('戊：未知回执退档且不重发、不自算成功样本，迟到成功不自动升档', async t => {
  const f = await fixture(t); let card = await train(f); await auto(f, card);
  // 接入后把自动结果留在sending，再模拟崩溃恢复；不再调用worker第二次。
  f.worker.send = async input => ({ requestId: input.requestId, status: 'uncertain' });
  card = await emit(f); const state = await f.ledger(), write = state.tables.writes[card.automaticRequestId!]!;
  assert.equal(write.state, 'uncertain'); assert.equal(state.tables.modes[write.automation!.scopeId]!.mode, 'suggest');
  assert.equal(Object.keys(state.tables.choices).length, 20); await tick(f); assert.equal(f.sent.length, 20);
  assert.equal(automaticApproval(state, card), undefined);
  const count = state.observations.filter(row => row.kind === 'mode').length;
  await recordWorkerReceipt(f.config, { requestId: write.id, status: 'consumed' }, at); await tick(f);
  assert.equal((await f.ledger()).observations.filter(row => row.kind === 'mode').length, count);
});

test('戊：发出前复核红线/当前授权/类别/通道/原建议；收紧目标取消旧自动待写', async t => {
  const f = await fixture(t); await auto(f, await train(f)); const { card, write } = await pendingAutomatic(f);
  assert.equal(write.state, 'pending'); assert.equal(f.sent.length, 20);
  const original = await f.ledger(); assert.equal(guardWrite(original, write).allowed, true);
  for (const kind of ['redline', 'intent', 'mode', 'channel', 'payload', 'scope'] as const) {
    const state = structuredClone(original), changed = structuredClone(write);
    if (kind === 'redline') state.tables.cards[card.id]!.redline = true;
    if (kind === 'intent') state.tables.tickets[card.ticketId]!.intents.at(-1)!.version++;
    if (kind === 'mode') state.tables.modes[write.automation!.scopeId]!.mode = 'suggest';
    if (kind === 'channel') state.tables.connections.feishu!.state = 'failed';
    if (kind === 'payload') changed.text = '不在原建议中的另一句话';
    if (kind === 'scope') changed.automation!.scopeId = 'another-class';
    assert.equal(guardWrite(state, changed).allowed, false, kind);
  }
  await text(f, '环境暂停 目标改为：先给方案，不再继续开发'); await tick(f);
  assert.equal(f.sent.length, 20); assert.equal((await f.ledger()).tables.writes[write.id]!.state, 'blocked');
});

test('戊：撤回自动待写即取消，同类其他未发也取消；重复撤回不重复降档', async t => {
  const f = await fixture(t); await auto(f, await train(f)); const first = await pendingAutomatic(f), { card, write } = await pendingAutomatic(f);
  assert.match(await click(f, card, 'withdraw'), /未发送/); await tick(f);
  let state = await f.ledger(); assert.equal(state.tables.writes[first.write.id]!.state, 'revoked'); assert.equal(state.tables.writes[write.id]!.state, 'revoked'); assert.equal(f.sent.length, 20);
  await click(f, await current(f, card.id), 'withdraw'); await tick(f); state = await f.ledger();
  assert.equal(state.tables.modes[write.automation!.scopeId]!.mode, 'suggest');
});

test('戊：自动发生严重错误一次就退建议；重复反馈不再降档', async t => {
  const f = await fixture(t); await auto(f, await train(f)); const card = await emit(f);
  await text(f, '严重错误 错误继续了', (await f.out()).find(row => row.noticeId === card.id)!.messageId); await tick(f);
  let state = await f.ledger(), scope = actionScope(state, card)!; assert.equal(state.tables.modes[scope.id]!.mode, 'suggest');
  await click(f, await current(f, card.id), 'feedback_严重错误'); await tick(f); state = await f.ledger();
  assert.equal(state.tables.modes[scope.id]!.mode, 'suggest'); assert.equal(modeStats(state, state.tables.modes[scope.id]!).serious, 1);
});

test('戊：发送途中本人撤回，随后失败不再从建议降影子；已送结果不能冒充收回', async t => {
  const f = await fixture(t); await auto(f, await train(f));
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  f.worker.send = async input => { await hold; return { requestId: input.requestId, status: 'uncertain' }; };
  const processing = emit(f); t.after(() => release());
  const until = Date.now() + 10000; let card!: ManagedCard;
  while (Date.now() < until) {
    const state = await f.ledger(), write = Object.values(state.tables.writes).find(row => row.automation && row.state === 'sending');
    if (write) { card = state.tables.cards[write.cardId]!; break; } await delay(10);
  }
  assert.ok(card?.automaticRequestId); assert.match(await click(f, card, 'withdraw'), /不能收回/);
  release(); await processing; const state = await f.ledger(), scope = state.tables.writes[card.automaticRequestId!]!.automation!.scopeId;
  assert.equal(state.tables.modes[scope]!.mode, 'suggest'); assert.match(state.tables.cards[card.id]!.deliveryText!, /不表示已收回/);
  assert.equal(state.observations.filter(row => row.kind === 'serious_error' && row.scopeId === scope).length, 1);
});

test('戊：独立CLI重放恢复档位与记忆，fake-poll不启动长连接也可继续自动且不重发', async t => {
  const f = await fixture(t, true); await auto(f, await train(f));
  await text(f, '张三：Promate 的产品负责人'); await tick(f);
  const candidate = Object.values((await f.ledger()).tables.memoryCandidates)[0]!;
  await click(f, (await f.ledger()).tables.cards[candidate.id]!, 'memory_confirm'); await tick(f);
  const configPath = join(f.root, 'config.json'); await writeFile(configPath, JSON.stringify(f.config));
  const cli = resolve(import.meta.dirname, '../src/cli/main.ts'), run = (command: string) => {
    const result = spawnSync(process.execPath, [cli, command, '--config', configPath, '--now', at, '--json'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const before = await f.ledger(), snapshot = run('overview');
  assert.deepEqual(snapshot.modes, JSON.parse(JSON.stringify(before.tables.modes))); assert.deepEqual(snapshot.memories, JSON.parse(JSON.stringify(before.tables.memories)));
  assert.equal((await f.ledger()).seq, before.seq, 'overview只重放');
  await f.channel.stop(); const { card, write } = await pendingAutomatic(f); // stopped使本次不产生自动待写。
  assert.equal(write, undefined);
  run('feishu-poll'); let state = await f.ledger(); assert.match(state.tables.cards[card.id]!.deliveryText!, /已按建议处理/);
  assert.equal((await readJsonl(join(f.loop, 'received.jsonl'))).length, 21);
  run('feishu-poll'); assert.equal((await readJsonl(join(f.loop, 'received.jsonl'))).length, 21);
});

test('戊：模型起草的人物仍需确认；未确认候选/意图/观测不进入研判记忆上下文', async t => {
  const f = await fixture(t), model = join(f.root, 'model.json'), capture = join(f.root, 'model-calls.jsonl');
  await writeFile(model, JSON.stringify({ capture, answer: { suggestion: 'A', basis: '依据原问题', redline: false, memoryCandidates: [
    { kind: 'person', subject: '李四', content: 'Example 的负责人', terms: ['Example'] },
    { kind: 'rule', subject: '伪规则', content: '自动执行', terms: [] },
  ] } }));
  f.config.judge = { executable: resolve(import.meta.dirname, 'pi-stub.ts'), model, timeoutMs: 30000 };
  await emit(f, 'needs_decision', { question: '李四的事？', options: ['A', 'B'] });
  let state = await f.ledger(); assert.equal(Object.keys(state.tables.memoryCandidates).length, 1); assert.equal(Object.keys(state.tables.memories).length, 0);
  await emit(f, 'needs_decision', { question: '李四的事？', options: ['A', 'B'] });
  const calls = await readJsonl<{ prompt: string }>(capture); assert.equal(calls.length, 2);
  assert.match(calls[1]!.prompt, /"confirmedMemories":\[\]/); assert.doesNotMatch(calls[1]!.prompt, /Example 的负责人/);
  const c = Object.values(state.tables.memoryCandidates)[0]!; await click(f, state.tables.cards[c.id]!, 'memory_confirm');
  await emit(f, 'needs_decision', { question: '李四的事？', options: ['A', 'B'] });
  const last = (await readJsonl<{ prompt: string }>(capture)).at(-1)!; assert.match(last.prompt, /Example 的负责人/); assert.match(last.prompt, /"version":1/);
});

const taskCard = async (f: F) => Object.values((await f.ledger()).tables.cards).filter(row => row.proposalId).at(-1)!;
async function trainDispatch(f: F) {
  for (let i = 0; i < 20; i++) {
    await text(f, `给测试项目的 src/widget.ts 补测试，构造派工${i}`); await tick(f);
    await click(f, await taskCard(f), 'dispatch'); await tick(f);
  }
  return taskCard(f);
}
function brokenFeishu(category: string): ManagedChannel {
  return { name: 'feishu', levels: ['现在就要你', '有空看'],
    async send() { throw new OperationFailure(category, '构造拒收'); },
    async receive() { throw new Error('故障替身不处理入站；使用独立假飞书收件'); },
    async deliverManaged() { throw new OperationFailure(category, '构造卡片失败；不是真实网络'); } };
}

for (const category of ['channel_permission', 'channel_timeout']) test(`戊返修1-1：连接正常但卡片更新${category}，准入和发送前均停自动，只有实际更新成功才恢复`, async t => {
  const f = await fixture(t); await auto(f, await train(f)); const { card, write } = await pendingAutomatic(f);
  await updateLedger(f.config.dataDir, f.now, (_state, add) => add({ kind: 'put', table: 'connections', value: { id: 'feishu', state: 'connected', at: f.now } }));
  f.channels = [brokenFeishu(category)]; await deliverManagedHealth(f.config, f.now, f.channels);
  let state = await f.ledger(); const failed = Object.values(state.tables.deliveries).find(row => row.cardId === card.id && row.revision === card.revision)!;
  assert.equal(failed.state, category === 'channel_timeout' ? 'uncertain' : 'failed'); assert.equal(state.tables.connections.feishu!.state, 'connected');
  assert.equal(automaticSafety(state, state.tables.cards[card.id]!), false, 'connected不是卡片可达证据');
  assert.equal(guardWrite(state, write).allowed, false, '已排队自动待写在发送前也须拦下');
  await dispatchWrites(f.config, f.now, f.worker); assert.equal(f.sent.length, 20);
  assert.equal((await f.ledger()).tables.writes[write.id]!.state, 'blocked');
  await emit(f); await emit(f); assert.equal(f.sent.length, 20, '持续拒收期间新同类事件不再自动送话');
  // 重连/文字回话不等于卡片可用；必须一次真实卡片成功，且不能重投旧worker请求。
  await updateLedger(f.config.dataDir, f.now, (_state, add) => add({ kind: 'put', table: 'connections', value: { id: 'feishu', state: 'connected', at: f.now } }));
  assert.equal(automaticSafety(await f.ledger(), await current(f, card.id)), false);
  f.channels = [f.channel]; await emit(f); assert.equal(f.sent.length, 20, '恢复卡片之前不得先执行');
  state = await f.ledger(); assert.equal(automaticSafety(state, state.tables.cards[card.id]!), true);
  assert.equal(state.tables.deliveries[failed.id]!.state, failed.state, '保留旧失败/不确定记录，不把它改成成功');
  await emit(f); assert.equal(f.sent.length, 21); await tick(f); assert.equal(f.sent.length, 21);
  assert.equal((await f.ledger()).tables.writes[write.id]!.state, 'blocked', '恢复只允许新事件，不重送旧请求');
});

test('戊返修1-1：卡片首发不确定时自动派工发出前被拦，其他卡可证恢复不解禁原卡、不重建首发', async t => {
  const f = await fixture(t); await auto(f, await trainDispatch(f));
  await text(f, '给测试项目的 src/widget.ts 补测试，待自动派工');
  await updateLedger(f.config.dataDir, f.now, (state, add) => planAutonomy(state, add, f.now));
  const card = await taskCard(f), write = (await f.ledger()).tables.writes[card.automaticRequestId!]!;
  assert.equal(write.state, 'pending'); f.channels = [brokenFeishu('channel_timeout')];
  await deliverManagedHealth(f.config, f.now, f.channels);
  assert.equal(guardWrite(await f.ledger(), write).allowed, false);
  await dispatchTasks(f.config, f.now, f.worker); assert.equal(f.starts.length, 20);
  const failed = Object.values((await f.ledger()).tables.deliveries).find(row => row.cardId === card.id)!; assert.equal(failed.state, 'uncertain'); assert.equal(failed.messageId, undefined);
  f.channels = [f.channel]; await text(f, '张三：Promate 的产品负责人'); await tick(f);
  let state = await f.ledger(); assert.equal(automaticSafety(state, state.tables.cards[card.id]!), false, '原卡未核实的首发不会借其他卡成功放行');
  assert.equal(state.tables.deliveries[failed.id]!.state, 'uncertain'); assert.equal((await f.out()).filter(row => row.noticeId === card.id).length, 0);
  await text(f, '给测试项目的 src/widget.ts 补测试，恢复后的新派工'); await tick(f); assert.equal(f.starts.length, 21);
  await tick(f); state = await f.ledger(); assert.equal(state.tables.writes[write.id]!.state, 'blocked'); assert.equal(f.starts.length, 21);
});

test('戊返修1-1：既有账本只含卡片失败也不能放行自动，新的成功送达才证明通道恢复', async t => {
  const f = await fixture(t); await auto(f, await train(f));
  await updateLedger(f.config.dataDir, f.now, (_state, add) => add({ kind: 'put', table: 'deliveries', value: {
    id: 'feishu:legacy-failure:1', channel: 'feishu', cardId: 'legacy-failure', revision: 1, state: 'failed', failures: 5, reason: '构造旧卡片失败',
  } }));
  const { card, write } = await pendingAutomatic(f); assert.equal(write, undefined);
  assert.equal(automaticSafety(await f.ledger(), card), false);
  await tick(f); assert.equal(f.sent.length, 20); await emit(f); assert.equal(f.sent.length, 21);
  assert.equal((await f.ledger()).tables.deliveries['feishu:legacy-failure:1']!.state, 'failed');
});

test('戊返修1-2：历史人工worker失败不污染当前通道，正常送话及其他派工继续积累有效样本，失败和严重错误留痕不变', async t => {
  const f = await fixture(t); let attempts = 0;
  f.worker.send = async input => { attempts++; return { requestId: input.requestId, status: 'failed', reason: '一次构造人工请求失败' }; };
  const failedCard = await emit(f, 'paused', {}, 'timeout', '失败旧批次'); await click(f, failedCard, 'suggest'); await tick(f);
  let state = await f.ledger(); const failedWrite = Object.values(state.tables.writes)[0]!, failedHealth = state.tables.health[`write:${failedWrite.id}`]!;
  assert.equal(failedWrite.state, 'failed'); assert.equal(failedHealth.ok, false); assert.equal(attempts, 1);
  await click(f, await current(f, failedCard.id), 'feedback_严重错误'); await tick(f);
  const serious = (await f.ledger()).observations.filter(row => row.kind === 'serious_error'); assert.equal(serious.length, 1);
  f.worker.send = async input => { attempts++; f.sent.push(input); return { requestId: input.requestId, status: 'consumed' }; };
  const card = await train(f); state = await f.ledger(); const scope = actionScope(state, card)!;
  assert.equal(modeStats(state, state.tables.modes[scope.id]!).count, 20, '不能把一次旧worker失败当全局当前通道故障');
  await auto(f, card); await emit(f); assert.equal(f.sent.length, 21); assert.equal(attempts, 22);
  await text(f, '给测试项目的 src/widget.ts 补测试，失败后的人工派工'); await tick(f); await click(f, await taskCard(f), 'dispatch'); await tick(f);
  state = await f.ledger(); const task = await taskCard(f), dispatchScope = actionScope(state, task)!;
  assert.equal(modeStats(state, state.tables.modes[dispatchScope.id]!).count, 1); assert.equal(f.starts.length, 1);
  assert.deepEqual(state.tables.health[failedHealth.id], failedHealth); assert.equal(state.tables.writes[failedWrite.id]!.state, 'failed');
  assert.deepEqual(state.observations.filter(row => row.kind === 'serious_error'), serious); assert.equal(modeStats(state, state.tables.modes[scope.id]!).serious, 0);
  await tick(f); assert.equal(attempts, 22, '不重试历史失败请求');
});

test('戊返修1-3：补查跨日20次成功人工选择可改自动；自动只查一次、不派开发，5次/天和每事1次不放宽', async t => {
  const f = await fixture(t), pi = join(f.root, 'pi-worker');
  f.config.piWorker = { executable: process.execPath, args: [resolve(import.meta.dirname, 'pi-worker-stub.ts'), pi], timeoutMs: 30000 };
  await writeFile(join(f.project, 'modules.md'), 'alpha、beta、gamma（构造模块索引）\n');
  let card!: ManagedCard;
  for (let i = 0; i < 20; i++) {
    f.now = `2026-11-${String(6 + Math.floor(i / 5)).padStart(2, '0')}T10:00:00.000Z`;
    await text(f, `把三个模块的测试补完，第${i}件`); await tick(f); card = await taskCard(f);
    assert.equal((await f.ledger()).tables.proposals[card.proposalId!]!.kind, 'supplement');
    await click(f, card, 'query'); await tick(f);
  }
  card = await current(f, card.id); let state = await f.ledger(), scope = actionScope(state, card)!;
  assert.equal((await readJsonl(join(pi, 'received.jsonl'))).length, 20);
  assert.equal(modeStats(state, state.tables.modes[scope.id]!).count, 20); await auto(f, card);
  await text(f, '把三个模块的测试补完，当天第六件'); await tick(f);
  assert.equal((await taskCard(f)).taskAction, undefined); assert.equal((await readJsonl(join(pi, 'received.jsonl'))).length, 20);
  f.now = '2026-11-10T10:00:00.000Z'; await text(f, '把三个模块的测试补完，新的自动查询'); await tick(f);
  card = await taskCard(f); state = await f.ledger(); const write = state.tables.writes[card.automaticRequestId!]!;
  assert.equal(write.dispatch!.kind, 'supplement'); assert.equal(write.dispatch!.mode, 'auto'); assert.equal(write.dispatch!.source, 'pa_auto');
  assert.equal(write.state, 'consumed'); assert.deepEqual(write.dispatch!.sheet!.boundary.write, []); assert.equal(write.dispatch!.sheet!.budget.maxRounds, 1);
  assert.match(card.deliveryText!, /已自动派/); assert.equal((await readJsonl(join(pi, 'received.jsonl'))).length, 21); assert.equal(f.starts.length, 0);
  await tick(f); assert.equal((await readJsonl(join(pi, 'received.jsonl'))).length, 21);
  const message = (await f.out()).find(row => row.noticeId === card.id)!.messageId;
  await text(f, '那就按这三个补测试', message); await tick(f);
  const development = (await f.ledger()).tables.proposals[(await taskCard(f)).proposalId!]!;
  assert.equal(development.kind, 'loop'); assert.equal(f.starts.length, 0, '补查授权不能变成后续开发授权');
});

test('戊返修1-3：补查准入看完整只读提问单，不以原任务missing否定；缺栏、写权、超预算和开发缺对象仍不自动', async t => {
  const f = await fixture(t); await text(f, '把三个模块的测试补完'); await tick(f);
  const original = await f.ledger(), card = await taskCard(f), p = original.tables.proposals[card.proposalId!]!;
  assert.ok(p.missing.length); assert.equal(p.queryOffered, true); assert.equal(automaticSafety(original, card), true);
  for (const mutation of ['goal', 'questions', 'read', 'write', 'tools', 'arrival', 'rounds', 'timeout', 'scope', 'development'] as const) {
    const state = structuredClone(original), p = state.tables.proposals[card.proposalId!]!;
    if (mutation === 'goal') p.sheet!.goal = '';
    if (mutation === 'questions') p.sheet!.questions = [];
    if (mutation === 'read') p.sheet!.boundary.read = [];
    if (mutation === 'write') p.sheet!.boundary.write = [f.project];
    if (mutation === 'tools') p.sheet!.boundary.tools = ['bash'];
    if (mutation === 'arrival') p.sheet!.arrival = '';
    if (mutation === 'rounds') (p.sheet!.budget as { maxRounds: number }).maxRounds = 2;
    if (mutation === 'timeout') p.sheet!.budget.timeoutMs = 1200001;
    if (mutation === 'scope') p.definition.boundaries.write = [f.project];
    if (mutation === 'development') { p.kind = 'loop'; p.recipe = 'develop'; }
    assert.equal(automaticSafety(state, card), false, mutation);
  }
});

test('戊返修1-1：失败前已开始的慢卡片成功不能核销后来的通道故障，新尝试成功才可恢复', async t => {
  const f = await fixture(t), card = await emit(f);
  await updateLedger(f.config.dataDir, f.now, (_state, add) => add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1 } }));
  let release!: () => void, began!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { began = resolve; });
  const slow: ManagedChannel = { ...f.channel, async deliverManaged(card, key, messageId) { began(); await hold; return f.channel.deliverManaged(card, key, messageId); } };
  const oldDelivery = deliverManagedHealth(f.config, f.now, [slow]);
  try {
    await started; await text(f, '张三：Promate 的产品负责人');
    await deliverManagedHealth(f.config, f.now, [brokenFeishu('channel_permission')]);
    const failure = (await f.ledger()).tables.health['card-channel:feishu']!; assert.equal(failure.ok, false);
    release(); await oldDelivery;
    let state = await f.ledger(); assert.equal(state.tables.health[failure.id]!.ok, false, '迟到成功不是故障之后的恢复证据');
    assert.equal(automaticSafety(state, state.tables.cards[card.id]!), false);
    await deliverManagedHealth(f.config, f.now, [f.channel]);
    state = await f.ledger(); assert.equal(state.tables.health[failure.id]!.ok, true);
    assert.equal(automaticSafety(state, state.tables.cards[card.id]!), true);
  } finally { release(); await oldDelivery; }
});

async function until<T>(get: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await get(); if (accept(value)) return value; await delay(20); }
  throw new Error(`等待构造常驻结果超时：${label}`);
}
async function trainSupplements(f: F) {
  const pi = join(f.root, 'pi-worker');
  f.config.piWorker = { executable: process.execPath, args: [resolve(import.meta.dirname, 'pi-worker-stub.ts'), pi], timeoutMs: 30000 };
  await writeFile(join(f.project, 'modules.md'), 'alpha、beta、gamma（构造模块索引）\n');
  for (let i = 0; i < 20; i++) {
    f.now = `2026-11-${String(6 + Math.floor(i / 5)).padStart(2, '0')}T10:00:00.000Z`;
    await text(f, `把三个模块的测试补完，慢卡片前的查询${i}`); await tick(f);
    await click(f, await taskCard(f), 'query'); await tick(f);
  }
  await auto(f, await taskCard(f)); f.now = '2026-11-10T10:00:00.000Z'; return pi;
}

for (const scenario of ['loop_success', 'supplement_success', 'card_failed', 'card_uncertain', 'withdraw'] as const) test(`戊返修2-1：真实常驻慢卡片跨过派工轮询仍保持未发，${scenario}按回执复核且最多派一次`, async t => {
  const f = await fixture(t), supplement = scenario === 'supplement_success';
  const pi = supplement ? await trainSupplements(f) : undefined;
  if (!supplement) await auto(f, await trainDispatch(f));
  const before = supplement ? 20 : f.starts.length;
  let release!: () => void, held = false, captured: ManagedCard | undefined, targetAttempts = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  // 只固定调度顺序：先让渠道进入sending，再放开真实派工循环，避免它在发卡前先完成派工。
  let unlockTasks = await acquireLock(f.config.dataDir, '.task-work.lock');
  const channel: ManagedChannel = { ...f.channel, async deliverManaged(card, key, messageId) {
    if (card.automaticRequestId && !held) { held = true; captured = card; targetAttempts++; await hold; }
    else if (card.id === captured?.id) targetAttempts++;
    if (card.id === captured?.id && (scenario === 'card_failed' || scenario === 'card_uncertain'))
      throw new OperationFailure(scenario === 'card_failed' ? 'channel_permission' : 'channel_timeout', '构造慢卡片回执');
    return f.channel.deliverManaged(card, key, messageId);
  } };
  // 本回归从已入账的本人任务开始，确保首轮先plan再发卡；收件落在发卡阶段是另一种合法调度。
  await text(f, supplement ? '把三个模块的测试补完，慢卡片中的补查' : '给测试项目的 src/widget.ts 补测试，慢卡片中的派工');
  const inputId = (await taskCard(f)).eventId;
  const stop = new AbortController(); let runFailure: unknown;
  const running = runService(f.config, stop.signal, { channels: [channel], worker: f.worker, now: () => f.now }).catch(error => { runFailure = error; });
  const received = async () => supplement ? (await readJsonl<{ requestId: string }>(join(pi!, 'received.jsonl'))).length : f.starts.length;
  try {
    await until(() => readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl')), rows => rows.some(row => row.kind === 'started'), '服务实际启动');
    await until(async () => captured, card => !!card, '渠道实际进入慢卡片');
    const card = captured!, requestId = card.automaticRequestId!;
    await unlockTasks(); unlockTasks = async () => {};
    let state = await until(f.ledger, state => state.observations.some(row => row.kind === 'guard' && row.requestId === requestId && row.detail.startsWith('派出前复核')), '独立派工循环已复核该请求');
    assert.equal(card.eventId, inputId); assert.equal(state.tables.writes[requestId]!.state, 'pending', '正常在途不能终结为blocked');
    assert.equal(state.tables.writes[requestId]!.dispatchedAt, undefined); assert.equal(state.tables.proposals[card.proposalId!]!.status, 'pending');
    assert.equal(state.tables.cards[card.id]!.taskAction, supplement ? 'query' : 'dispatch');
    assert.ok(Object.values(state.tables.deliveries).some(row => row.cardId === card.id && row.state === 'sending'));
    await delay((f.config.managedLoop?.intakeEveryMs ?? 500) * 2 + 50);
    state = await f.ledger(); assert.equal(state.tables.writes[requestId]!.state, 'pending'); assert.equal(await received(), before, '多次轮询仍不得提前派出');
    assert.equal(guardWrite(state, state.tables.writes[requestId]!).waitFor, 'card_delivery');
    for (const mutation of ['intent', 'mode', 'redline', 'definition', ...(supplement ? ['sheet'] : [])]) {
      const invalid = structuredClone(state), write = invalid.tables.writes[requestId]!;
      if (mutation === 'intent') invalid.tables.tickets[card.ticketId]!.intents.at(-1)!.version++;
      if (mutation === 'mode') invalid.tables.modes[write.automation!.scopeId]!.version!++;
      if (mutation === 'redline') invalid.tables.cards[card.id]!.redline = true;
      if (mutation === 'definition') write.dispatch!.definition = { ...write.dispatch!.definition, done: '被换掉的完成标准' };
      if (mutation === 'sheet') invalid.tables.proposals[card.proposalId!]!.sheet!.goal = '';
      const denied = guardWrite(invalid, write); assert.equal(denied.allowed, false, mutation); assert.equal(denied.waitFor, undefined, mutation);
    }
    if (scenario === 'withdraw') {
      // 确定性固定正常收件并发：旧drain已读完快照、只等旧文字确认，新点击归下一轮。
      let unlockReply = await acquireLock(f.config.dataDir, '.feishu-reply-send.lock');
      let previousDrain: Promise<number> | undefined, clicked: Promise<string> | undefined;
      try {
        const previousId = 'prior-inbox-snapshot', clickId = 'withdraw-after-prior-snapshot';
        await appendFile(join(f.config.dataDir, 'feishu-inbox.jsonl'), JSON.stringify({ type: 'text', id: previousId, at: f.now, actor: 'ou_autonomy', messageId: previousId, text: '漏了 构造旧收件快照', chatType: 'p2p' }) + '\n');
        previousDrain = f.channel.drain(f.now); void previousDrain.catch(() => {});
        await until(f.ledger, state => !!state.tables.receipts[`feedback:${previousId}`], '旧输入已处理且收件快照已经固定');
        clicked = click(f, await modeCard(f, card), 'mode_suggest', { id: clickId }); void clicked.catch(() => {});
        await until(() => readJsonl<{ id: string }>(join(f.config.dataDir, 'feishu-inbox.jsonl')), rows => rows.some(row => row.id === clickId), '新点击已追加且归下一轮收件');
        await unlockReply(); unlockReply = async () => {};
        await clicked;
      } finally { await unlockReply(); await previousDrain; if (clicked) await clicked.catch(() => {}); }
      state = await f.ledger(); assert.equal(state.tables.writes[requestId]!.state, 'revoked'); assert.ok(state.tables.writes[requestId]!.withdrawnAt);
    }
    release();
    if (scenario === 'loop_success' || scenario === 'supplement_success') {
      state = await until(f.ledger, state => state.tables.writes[requestId]?.state === 'consumed', '卡片成功后正常派出并记回执');
      assert.equal(await received(), before + 1); assert.equal(state.tables.writes[requestId]!.dispatch!.source, 'pa_auto');
      await until(f.ledger, state => Object.values(state.tables.deliveries).some(row => row.cardId === card.id && row.revision === state.tables.cards[card.id]!.revision && row.state === 'sent'), '事后原卡送达');
      assert.match((await current(f, card.id)).deliveryText!, /已自动派/);
    } else if (scenario === 'card_failed' || scenario === 'card_uncertain') {
      state = await until(f.ledger, state => state.tables.writes[requestId]?.state === 'blocked', '真实卡片失败后拦下');
      assert.equal(state.tables.health['card-channel:feishu']!.ok, false); assert.equal(state.tables.writes[requestId]!.dispatchedAt, undefined);
      assert.equal(await received(), before);
      if (scenario === 'card_uncertain') { assert.equal(targetAttempts, 1); assert.ok(Object.values(state.tables.deliveries).some(row => row.cardId === card.id && row.state === 'uncertain' && !row.messageId)); }
    } else await until(f.ledger, state => Object.values(state.tables.deliveries).some(row => row.cardId === card.id && row.state === 'sent'), '撤回后卡片回执收束');
    await delay((f.config.managedLoop?.intakeEveryMs ?? 500) * 2 + 50);
    assert.equal(await received(), before + (scenario.endsWith('success') ? 1 : 0), '旧请求不能在后续轮询中重派');
  } finally { release(); stop.abort(); await unlockTasks(); await running; assert.equal(runFailure, undefined); }
});

test('戊返修2-1：常驻恢复遗留卡片sending时只核销为未知，未尝试的自动派工不能借等待状态派出', async t => {
  const f = await fixture(t); await auto(f, await trainDispatch(f));
  await text(f, '给测试项目的 src/widget.ts 补测试，遗留sending');
  await updateLedger(f.config.dataDir, f.now, (state, add) => {
    planAutonomy(state, add, f.now);
    const card = Object.values(state.tables.cards).find(row => row.automaticRequestId)!;
    add({ kind: 'put', table: 'deliveries', value: { id: `feishu:${card.id}:${card.revision}`, channel: 'feishu', cardId: card.id,
      revision: card.revision, eventId: card.eventId, state: 'sending', failures: 0, attemptSeq: state.seq + 1 } });
  });
  const card = await taskCard(f), requestId = card.automaticRequestId!, count = f.starts.length;
  for (let restart = 0; restart < 2; restart++) {
    const stop = new AbortController(); let failure: unknown;
    const running = runService(f.config, stop.signal, { channels: [f.channel], worker: f.worker, now: () => f.now }).catch(error => { failure = error; });
    try {
      const state = await until(f.ledger, state => state.tables.writes[requestId]?.state === 'blocked'
        && Object.values(state.tables.deliveries).some(row => row.cardId === card.id && row.state === 'uncertain'), '遗留发送核销');
      assert.equal(state.tables.writes[requestId]!.dispatchedAt, undefined); assert.equal(f.starts.length, count);
      assert.equal((await f.out()).filter(row => row.noticeId === card.id).length, 0, '未知首发不重建另一张卡');
    } finally { stop.abort(); await running; assert.equal(failure, undefined); }
  }
});
