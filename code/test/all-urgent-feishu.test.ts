// 提醒都发飞书：仅构造来源、独立临时数据、假飞书和本机替身。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { event, packProjection, project } from '../src/core/events.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import type { Channel, Judge, JudgmentRequest, Notice } from '../src/core/types.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, loopSummary, put, pushed, sandbox } from './fixtures.ts';

const at = (minute: number) => new Date(Date.parse('2026-10-20T10:00:00Z') + minute * 60000).toISOString();
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.learning = false;
  f.config.feishu = { mode: 'fake', receiverId: 'test-only-user', timeoutMs: 1000 };
  const file = join(f.config.sources.cc!, 'sample.jsonl'), local: Notice[] = [], calls: JudgmentRequest[] = [];
  const localChannel: Channel = { name: 'local', async send(notice) { local.push(notice); }, async receive() { return '已记下'; } };
  const judge: Judge = { async judge(request) {
    calls.push(request);
    return request.task === 'drift' ? { answer: '是', reason: 'B 超过 A 的范围', intentQuote: '只改 A 模块', stepQuote: '修改 B 模块' }
      : { answer: '是', reason: '构造问题尚未回复' };
  } };
  const components = { channels: [localChannel, feishuChannel(f.config)], judge };
  const run = (minute: number) => detect(f.config, at(minute), components);
  const sent = async () => {
    try { return (await readFile(join(f.config.dataDir, 'feishu-sent.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row)); }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const withJudge = () => { f.config.judge = { executable: '/test-only/no-real-model', model: 'fake', timeoutMs: 1000 }; };
  return { ...f, file, local, calls, components, run, sent, withJudge };
}
async function pause(f: Awaited<ReturnType<typeof fixture>>, explicit = false) {
  f.config.sources.loop = join(f.root, 'loop');
  const path = join(f.config.sources.loop, 'shop/00000000-0000-4000-8000-000000000001.md');
  // 评审轮次时间不是暂停时间，不能用它跳过等候。
  await put(path, loopSummary('暂停（开发方需要你决定）', '/sample/shop', '- 请决定下一步', at(-60))
    + (explicit ? `- 暂停时间：${at(0)}\n` : ''));
  return path;
}

test('提醒飞书 A1：另一会话两分钟前有真人输入，授权等候超过五分钟仍双发，重复检测不重发', async t => {
  const f = await fixture(t);
  await put(f.file, [ccUser('构造授权任务', at(-10)), ccCall(at(0))]);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.file, 'waiting_permission', at(0))]);
  await put(join(f.config.sources.cc!, 'other.jsonl'), [{ ...ccUser('继续', at(4)), sessionId: 'other' }]);
  await f.run(6);
  assert.deepEqual(f.local.map(n => n.kind), ['waiting']); assert.equal((await f.sent()).length, 1);
  assert.deepEqual(f.local[0]!.delivery!.channels, ['local', 'feishu']);
  await f.run(7); await rebuild(f.config, at(7)); await f.run(8);
  assert.equal(f.local.length, 1); assert.equal((await f.sent()).length, 1); assert.equal(f.calls.length, 0);
});

test('提醒飞书 A2：从核验步骤而非末步/判定时刻等五分钟，缓存重放且不多调模型', async t => {
  const f = await fixture(t); f.withJudge();
  await put(f.file, [ccUser('只改 A 模块', at(-10)), ccCall(at(0), 'b', '修改 B 模块'), ccCall(at(2), 'a', '检查 A 模块')]);
  const first = await f.run(3);
  assert.equal(first.records[0]!.status, '疑似跑偏'); assert.equal(f.calls.length, 1);
  assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 0);
  const check = [...first.projection.modelChecks.values()][0]!;
  assert.deepEqual(check.triggerStep, { at: at(0), sessionId: 'demo-cc' });
  await f.run(4.999); await overview(f.config, at(4.999)); await rebuild(f.config, at(4.999));
  assert.equal(f.calls.length, 1); assert.equal((await readOutbox(f.config.dataDir)).length, 0);
  await f.run(5);
  assert.deepEqual(f.local.map(n => n.kind), ['drift']); assert.equal((await f.sent()).length, 1);
  await f.run(6); assert.equal(f.calls.length, 1); assert.equal(f.local.length, 1); assert.equal((await f.sent()).length, 1);
});

test('提醒飞书 A2 补充：判出来时触发步骤已满五分钟，当轮双发', async t => {
  const f = await fixture(t); f.withJudge();
  await put(f.file, [ccUser('只改 A 模块', at(-10)), ccCall(at(0), 'b', '修改 B 模块')]);
  await f.run(5);
  assert.deepEqual(f.local.map(n => n.kind), ['drift']); assert.equal((await f.sent()).length, 1); assert.equal(f.calls.length, 1);
});

for (const ending of ['session_end', 'push_session_end'] as const) for (const replied of [false, true])
  test(`返修1 结束会话：${ending}，${replied ? '真人已回复则取消' : '未回复的已核验跑偏满五分钟仍双发'}，不额外调用或重发`, async t => {
    const f = await fixture(t); f.withJudge();
    await put(f.file, [ccUser('只改 A 模块', at(-10)), ccCall(at(0), 'b', '修改 B 模块')]);
    const first = await f.run(1);
    const original = first.projection.modelChecks.get('drift:cc:demo-cc')!;
    assert.equal(original.result!.answer, '是'); assert.equal(f.calls.length, 1);
    assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 0);
    if (replied) await appendFile(f.file, JSON.stringify(ccUser('我来处理', at(2))) + '\n');
    if (ending === 'session_end') await appendFile(f.file, JSON.stringify({ type: 'session_end', sessionId: 'demo-cc', timestamp: at(3) }) + '\n');
    else await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.file, 'session_end', at(3))]);
    const ended = await f.run(3);
    if (ending === 'session_end') assert.equal(ended.projection.sessions.get('cc:demo-cc')!.sessionEnded, true);
    else assert.equal(ended.projection.pushes.at(-1)!.event, 'session_end');
    await f.run(4.999); await rebuild(f.config, at(4.999));
    assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 0);
    // 纯查询/重建也能恢复待发事实，但不调用模型、不发送。
    const ready = await overview(f.config, at(5)); await rebuild(f.config, at(5));
    assert.equal(!!ready.records[0]!.drift, !replied);
    if (!replied) assert.equal(ready.records[0]!.drift!.evidenceAt, original.evidenceAt);
    assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 0);
    await f.run(5); await f.run(6); await rebuild(f.config, at(7)); await f.run(8);
    const expected = replied ? 0 : 1;
    assert.equal(f.local.length, expected); assert.equal((await f.sent()).length, expected);
    assert.equal((await readOutbox(f.config.dataDir)).filter(n => n.kind === 'drift').length, expected);
    if (!replied) assert.equal(f.local[0]!.evidenceAt, original.evidenceAt);
    assert.equal(f.calls.length, 1);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'model_call_started').length, 1);
  });

test('提醒飞书 A3：触发步骤之后同一会话真人接话，五分钟后不发跑偏卡', async t => {
  const f = await fixture(t); f.withJudge();
  await put(f.file, [ccUser('只改 A 模块', at(-10)), ccCall(at(0), 'b', '修改 B 模块')]);
  await f.run(1); await appendFile(f.file, JSON.stringify(ccUser('我来处理', at(3))) + '\n');
  await f.run(3); await f.run(6);
  assert.equal(f.calls.length, 1); assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 0);
});

for (const explicit of [false, true]) test(`提醒飞书 A4：loop 暂停${explicit ? '取明确暂停时间' : '从首次看到算且重建不重置'}，五分钟后才起草并双发`, async t => {
  const f = await fixture(t); f.withJudge(); await pause(f, explicit);
  let drafts = 0;
  f.components.judge.writeSnapshot = async () => { drafts++; return { situation: '构造批次停下待决定', action: '请决定下一步', actionType: '做个决定' }; };
  await f.run(1); await rebuild(f.config, at(2));
  await f.run(explicit ? 4.999 : 5.999);
  assert.equal(drafts, 0); assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 0);
  const ready = explicit ? 5 : 6;
  await f.run(ready);
  assert.deepEqual(f.local.map(n => n.kind), ['loop_paused']); assert.equal((await f.sent()).length, 1); assert.equal(drafts, 1);
  assert.equal(f.local[0]!.evidenceAt, at(explicit ? 0 : 1));
  await f.run(ready + 1); assert.equal(f.local.length, 1); assert.equal((await f.sent()).length, 1); assert.equal(drafts, 1);
});

test('提醒飞书 A5：loop 五分钟内恢复就不叫，再暂停从新一轮首次看到算', async t => {
  const f = await fixture(t), path = await pause(f);
  await f.run(0);
  await put(path, loopSummary('进行中', '/sample/shop', '- 请决定下一步', at(3)));
  await f.run(3); await f.run(6);
  assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 0);
  assert.equal((await overview(f.config)).records.find(r => r.tool === 'loop')!.loopPausedAt, undefined);
  await put(path, loopSummary('暂停（开发方需要你决定）', '/sample/shop', '- 请决定下一步', at(7)));
  await f.run(7); await f.run(11.999); assert.equal(f.local.length, 0);
  await f.run(12); assert.deepEqual(f.local.map(n => n.kind), ['loop_paused']); assert.equal((await f.sent()).length, 1);
});

test('提醒飞书 A6：同一会话三分钟内回话，五分钟后不发等待卡也不调用模型', async t => {
  const f = await fixture(t); f.withJudge(); const answer = ccAnswer(at(0)); answer.message.content[0]!.text = '请确认保留多久？';
  await put(f.file, [ccUser('构造缓存任务', at(-10)), answer]);
  await f.run(0); await appendFile(f.file, JSON.stringify(ccUser('五分钟', at(3))) + '\n');
  await f.run(3); await f.run(6);
  assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 0); assert.equal(f.calls.length, 0);
});

test('提醒飞书 A7：刚有真人输入，来源变得读不了仍当轮双发，不等五分钟', async t => {
  const f = await fixture(t);
  await put(f.file, [ccUser('继续', at(0))]); await f.run(0);
  await rm(f.config.sources.cc!, { recursive: true });
  await f.run(1);
  assert.deepEqual(f.local.map(n => n.kind), ['blind']); assert.equal((await f.sent()).length, 1);
});

for (const checkpoint of [false, true]) test(`提醒飞书 A8：旧在场只本机卡${checkpoint ? '存于旧检查点' : '存于日志'}升级不补发、不重弹，旧文件不改`, async t => {
  const f = await fixture(t);
  await put(f.file, [ccUser('构造授权任务', at(-10)), ccCall(at(0))]);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.file, 'waiting_permission', at(0))]);
  await f.run(5);
  const events = (await readEvents(f.config.dataDir)).filter(e => e.kind !== 'channel_delivery' || e.channel !== 'feishu');
  const old = (await readOutbox(f.config.dataDir))[0]!;
  old.delivery = { presence: '在场', channels: ['local'], decidedAt: at(5), lastHumanAt: at(4) };
  for (const row of events) if (row.kind === 'notice_planned') row.notice = old;
  const archive = `events-000000000001-${'a'.repeat(64)}.jsonl.gz`;
  await put(join(f.config.dataDir, 'events.jsonl'), checkpoint ? [event({ kind: 'store_checkpoint', format: 2, sequence: 1,
    archive, archives: [archive], state: packProjection(project(events)) }, at(5))] : events);
  await put(join(f.config.dataDir, 'outbox.jsonl'), [old]); await put(join(f.config.dataDir, 'feishu-sent.jsonl'), []);
  f.local.length = 0;
  const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8'), outbox = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8');
  await rebuild(f.config, at(6)); await f.run(6); await f.run(16);
  assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 0);
  assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), outbox);
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(before));
  assert.equal((await readEvents(f.config.dataDir)).some(e => e.kind === 'channel_delivery' && e.channel === 'feishu'), false);
});

test('提醒飞书 A9：停滞和 loop 完成仍只发飞书', async t => {
  const f = await fixture(t); await put(f.file, [ccUser('构造任务', at(-40)), ccCall(at(-35))]);
  await f.run(0);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['stalled']);
  assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 1);
  const path = await pause(f); await put(path, loopSummary('完成', '/sample/shop', '- 无', at(1)));
  await f.run(1); assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 2);
});

for (const failure of ['file', 'push'] as const) test(`提醒飞书 A7 补充：${failure} 局部读不了/推送冲突不等候，刚在场也双发`, async t => {
  const f = await fixture(t);
  await put(f.file, [ccUser('继续', at(0))]); await f.run(0);
  if (failure === 'file') {
    await put(join(f.config.sources.cc!, 'healthy.jsonl'), [{ ...ccUser('构造健康会话', at(0)), sessionId: 'healthy' }]);
    await appendFile(f.file, '{broken\n');
  } else await put(join(f.config.inboxDir!, 'cc.jsonl'), [{ ...pushed(f.file, 'waiting_permission', at(1)), session_id: 'conflicting-session' }]);
  await f.run(1);
  assert.equal(f.local.length, 1); assert.equal((await f.sent()).length, 1);
  assert.equal(f.local[0]!.kind, failure === 'file' ? 'unreadable' : 'blind');
  assert.deepEqual(f.local[0]!.delivery!.channels, ['local', 'feishu']);
});

test('提醒飞书 A8 补充：旧 loop 卡和旧会话没有暂停计时字段，新增计时不改变旧去重键或补发', async t => {
  const f = await fixture(t); await pause(f);
  await f.run(0); const view = await f.run(5);
  const record = structuredClone(view.projection.sessions.get('loop:loop-demo')!); delete record.loopPausedAt;
  const old = (await readOutbox(f.config.dataDir))[0]!;
  old.delivery = { presence: '在场', channels: ['local'], decidedAt: at(5) }; old.evidenceAt = record.lastActivityAt;
  const rows = (await readEvents(f.config.dataDir)).filter(row => row.kind !== 'session_delta' && (row.kind !== 'channel_delivery' || row.channel !== 'feishu'));
  for (const row of rows) if (row.kind === 'notice_planned') row.notice = old;
  await put(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'session_observed', record }, at(0)), ...rows]);
  await put(join(f.config.dataDir, 'outbox.jsonl'), [old]); await put(join(f.config.dataDir, 'feishu-sent.jsonl'), []);
  f.local.length = 0;
  const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8'), outbox = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8');
  await f.run(6); await rebuild(f.config, at(7)); await f.run(11);
  assert.equal(f.local.length, 0); assert.equal((await f.sent()).length, 0);
  assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), outbox);
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(before));
});

for (const replyTo of ['child', 'parent', 'other'] as const) test(`提醒飞书 成员边界：子会话跑偏后 ${replyTo} 回话，只能由该子会话解除`, async t => {
  const f = await fixture(t); f.withJudge(); f.config.sources.cc = null; f.config.sources.codex = join(f.root, 'codex');
  const parent = join(f.config.sources.codex, 'parent.jsonl'), child = join(f.config.sources.codex, 'child.jsonl');
  await put(parent, [codexMeta('parent'), codexEvent({ type: 'user_message', message: '只改 A 模块' }, 'event_msg', at(-10))]);
  await put(child, [codexMeta('child', 'parent'), codexEvent({ type: 'user_message', message: '只改 A 模块' }, 'event_msg', at(-10)),
    codexEvent({ type: 'function_call', name: 'shell', call_id: 'b', arguments: JSON.stringify({ command: '修改 B 模块' }) }, 'response_item', at(0))]);
  await f.run(1);
  const row = codexEvent({ type: 'user_message', message: '我来处理', origin: { kind: 'human' } }, 'event_msg', at(3));
  if (replyTo === 'other') await put(join(f.config.sources.codex, 'other.jsonl'), [codexMeta('other'), row]);
  else await appendFile(replyTo === 'child' ? child : parent, JSON.stringify(row) + '\n');
  await f.run(3); await f.run(5);
  assert.equal(f.calls.length, 1);
  assert.equal(f.local.length, replyTo === 'child' ? 0 : 1); assert.equal((await f.sent()).length, replyTo === 'child' ? 0 : 1);
});
