// 甲段：仅构造会话/追加日志和替身渠道，不读取真实工具目录，不连接外部服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { event, project } from '../src/core/events.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { noticeCard } from '../src/channels/feishu/card.ts';
import { localNoticeText } from '../src/core/notice-text.ts';
import { modelSnapshot, ruleSnapshot } from '../src/core/task-snapshot.ts';
import { isRedline } from '../src/core/action-items.ts';
import { accepts } from '../src/channels/index.ts';
import { humanRequests } from '../src/core/interaction.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, loopSummary, piHeader, piMessage, put, pushed, sandbox } from './fixtures.ts';
import type { Channel, Judge, JudgmentRequest, Notice, TaskActionItem } from '../src/core/types.ts';

const at = (minute: number) => new Date(Date.parse('2026-10-20T10:00:00Z') + minute * 60000).toISOString();
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.learning = false;
  f.config.judge = { executable: '/test-only/no-real-model', model: 'fake', dailyLimit: 100, timeoutMs: 1000 };
  const file = join(f.config.sources.cc!, 'sample.jsonl');
  const answer = ccAnswer(at(0)); answer.message.content[0]!.text = '缓存保留多久？';
  await put(file, [ccUser('给商品列表加缓存', at(-20)), answer]);
  const calls: JudgmentRequest[] = [], local: Notice[] = [], feishu: Notice[] = [];
  const judge: Judge = { async judge(request) { calls.push(request); return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造问题尚未回复' }; } };
  const channel = (name: string, sent: Notice[]): Channel => ({ name, levels: name === 'feishu' ? ['现在就要你', '有空看'] : ['现在就要你'], async send(notice) { sent.push(notice); }, async receive() { return '已记下'; } });
  const components = { judge, channels: [channel('local', local), channel('feishu', feishu)] };
  return { ...f, file, calls, local, feishu, components };
}

test('甲 A1：三分钟内短回复，过五分钟不提醒、从未调用模型；重建也不调用', async t => {
  const f = await fixture(t);
  await detect(f.config, at(0), f.components); await detect(f.config, at(2), f.components);
  await appendFile(f.file, JSON.stringify(ccUser('继续', at(3))) + '\n');
  await detect(f.config, at(3), f.components); await detect(f.config, at(6), f.components);
  await overview(f.config); await rebuild(f.config);
  assert.equal(f.calls.length, 0); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  assert.equal(f.local.length, 0); assert.equal(f.feishu.length, 0);
});

test('甲 A2：五分钟边界才判断，离场双通道；重试/重建不重发不重调', async t => {
  const f = await fixture(t);
  await detect(f.config, at(0), f.components); await detect(f.config, at(4.999), f.components);
  assert.equal(f.calls.length, 0); assert.equal(f.local.length, 0);
  const result = await detect(f.config, at(5), f.components);
  assert.equal(result.noticesAdded, 1); assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1);
  assert.equal(f.local[0]!.delivery!.presence, '不在场');
  assert.deepEqual(f.local[0]!.delivery!.channels, ['local', 'feishu']);
  const calls = f.calls.length;
  await detect(f.config, at(6), f.components); await rebuild(f.config);
  assert.equal(f.calls.length, calls); assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1);
});

test('甲 A3：第四分钟另一会话发短句即在场，只本机；超十分钟不补发飞书', async t => {
  const f = await fixture(t);
  await detect(f.config, at(0), f.components);
  await put(join(f.config.sources.cc!, 'other.jsonl'), [{ ...ccUser('好的', at(4)), sessionId: 'other' }]);
  await detect(f.config, at(5), f.components);
  assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 0);
  const notice = (await readOutbox(f.config.dataDir))[0]!;
  assert.equal(notice.delivery!.presence, '在场'); assert.equal(notice.delivery!.lastHumanAt, at(4));
  assert.equal(accepts(f.components.channels[1]!, notice), false);
  assert.equal((await readEvents(f.config.dataDir)).some(e => e.kind === 'channel_delivery' && e.channel === 'feishu'), false);
  await detect(f.config, at(16), f.components);
  assert.equal(f.feishu.length, 0);
});

for (const minutes of [-5, -5.001]) test(`甲 在场十分钟边界：最后输入在 ${minutes} 分钟，按发卡时刻判断`, async t => {
  const f = await fixture(t);
  await put(join(f.config.sources.cc!, 'other.jsonl'), [{ ...ccUser('继续', at(minutes)), sessionId: 'other' }]);
  await detect(f.config, at(5), f.components);
  assert.equal(f.local.length, 1); assert.equal(f.feishu.length, minutes === -5 ? 0 : 1);
});

test('甲 被忽略会话和系统输入不能冒充在场；跨工具的真人输入可以', async t => {
  const f = await fixture(t);
  f.config.sources.codex = join(f.root, 'codex');
  f.config.ignoreProjectPrefixes = ['/ignored'];
  const meta = codexMeta('ignored'); meta.payload.cwd = '/ignored';
  await put(join(f.config.sources.codex, 'ignored.jsonl'), [meta, codexEvent({ type: 'user_message', message: '继续' }, 'event_msg', at(4))]);
  await put(join(f.config.sources.cc!, 'synthetic.jsonl'), [{ ...ccUser('自动输入', at(4)), sessionId: 'synthetic', isSynthetic: true }]);
  await detect(f.config, at(5), f.components);
  assert.equal(f.feishu.length, 1);
  const answer = ccAnswer(at(6)); answer.message.content[0]!.text = '新的缓存问题？';
  await appendFile(f.file, JSON.stringify(answer) + '\n');
  await put(join(f.config.sources.codex, 'visible.jsonl'), [codexMeta('visible'), codexEvent({ type: 'user_message', message: '继续' }, 'event_msg', at(10))]);
  await detect(f.config, at(11), f.components);
  assert.equal(f.local.length, 2); assert.equal(f.feishu.length, 1);
});

test('甲 A4：授权等待两分钟内推进不发；未处理的授权同样等五分钟且不调模型', async t => {
  const f = await fixture(t); f.config.judge = null;
  await put(f.file, [ccUser('构造授权任务', at(-20)), ccCall(at(0))]);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.file, 'waiting_permission', at(0))]);
  await detect(f.config, at(1), f.components);
  await appendFile(f.file, JSON.stringify(ccCall(at(2), 'next', '授权后继续执行')) + '\n');
  await detect(f.config, at(6), f.components);
  assert.equal(f.local.length, 0); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.file, 'waiting_permission', at(7))]);
  await detect(f.config, at(11), f.components); assert.equal(f.local.length, 0);
  await detect(f.config, at(12), f.components); assert.equal(f.local.length, 1); assert.equal(f.calls.length, 0);
});

const items: TaskActionItem[] = [
  { text: '缓存保留五分钟还是十分钟？', label: '回复会话', suggestion: '十分钟' },
  { text: '请去浏览器查看缓存效果', label: '你去做' },
  { text: '删除旧文件', label: '不用管' },
];
async function actionFixture(t: { after(fn: () => Promise<unknown>): void }) {
  const f = await fixture(t), answer = ccAnswer(at(0));
  answer.message.content[0]!.text = '要你做：\n1. 缓存保留五分钟还是十分钟？建议：五分钟\n2. 请去浏览器查看缓存效果\n3. 删除旧文件';
  await put(f.file, [ccUser('给商品列表加缓存', at(-20)), answer]);
  f.components.judge = { async judge(request) { f.calls.push(request); return { answer: request.task === 'waiting' ? '是' : '否', reason: '三项构造待办', situation: '缓存实现已完成，等你确认时长并验证效果。', actionItems: items }; } };
  await detect(f.config, at(5), f.components);
  return { ...f, notice: (await readOutbox(f.config.dataDir))[0]! };
}
test('甲 A5–A7：同次判断逐件标签、原输出建议优先、红线硬判、两区无输入框、快照留痕', async t => {
  const f = await actionFixture(t), notice = f.notice;
  assert.deepEqual(notice.snapshot!.actionItems!.map(i => i.label), ['回复会话', '你去做', '要你定·红线']);
  assert.equal(notice.snapshot!.actionItems![0]!.suggestion, '五分钟');
  assert.deepEqual(notice.content.actionItems, notice.snapshot!.actionItems);
  assert.equal(f.calls.filter(r => r.task === 'waiting').length, 1);
  const card = noticeCard(notice), json = JSON.stringify(card);
  for (const text of ['要你做', '回复会话', '你去做', '要你定·红线', '五分钟', '删除旧文件']) assert.ok(json.includes(text));
  const feedback = card.body.elements.find(e => (e as any).header?.title?.content === '给 personal agent 的反馈') as any;
  assert.equal(feedback.expanded, false);
  for (const text of ['正确', '误报', '看不懂']) assert.ok(JSON.stringify(feedback).includes(text));
  assert.doesNotMatch(json, /"tag":"(?:input|form|input_text)"/);
  const local = localNoticeText(notice);
  assert.match(local, /缓存保留五分钟还是十分钟.*共 3 件/); assert.doesNotMatch(local, /删除旧文件|浏览器查看/);
});

test('甲 A8：下轮多句真人输入时记第一句原文索引，追加不复制正文；重放后仍在快照旁', async t => {
  const f = await actionFixture(t), before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  const outbox = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8');
  await appendFile(f.file, [ccUser('好的', at(6)), ccUser('第二句实际回复', at(7))].map(r => JSON.stringify(r)).join('\n') + '\n');
  const view = await detect(f.config, at(8), f.components);
  const reply = view.projection.notices.find(n => n.id === f.notice.id)!.snapshot!.nextHumanReply!;
  assert.equal(reply.at, at(6));
  const record = view.projection.sessions.get(f.notice.sessionKey!)!;
  assert.equal([record.intent.initial, ...record.intent.additions][reply.index], '好的');
  const rows = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'notice_reply_observed');
  assert.equal(rows.length, 1); assert.doesNotMatch(JSON.stringify(rows), /好的|第二句/);
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(before));
  assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), outbox);
  await detect(f.config, at(9), f.components);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'notice_reply_observed').length, 1);
  assert.deepEqual((await rebuild(f.config)).projection.noticeReplies.get(f.notice.id), reply);
});

test('甲 A9：跑偏、loop 暂停和看不见了不等，在场仅本机；有空看仍只飞书', async t => {
  const f = await fixture(t);
  await put(f.file, [ccUser('只改 A 模块', at(0)), ccCall(at(0), 'b', '修改 B 模块')]);
  f.config.sources.loop = join(f.root, 'loop');
  await put(join(f.config.sources.loop, 'shop/00000000-0000-4000-8000-000000000001.md'), loopSummary('暂停，待决定下一步', '/sample/shop', '- 核销', at(0)));
  f.config.sources.pi = join(f.root, 'missing-pi');
  f.components.judge = { async judge() { return { answer: '是', reason: 'B 越过 A 范围', intentQuote: '只改 A 模块', stepQuote: '修改 B 模块' }; } };
  await detect(f.config, at(1), f.components);
  assert.deepEqual(f.local.map(n => n.kind).sort(), ['blind', 'drift', 'loop_paused']); assert.equal(f.feishu.length, 0);
  await put(join(f.config.sources.loop, 'shop/00000000-0000-4000-8000-000000000001.md'), loopSummary('完成', '/sample/shop', '- 无', at(2)));
  await detect(f.config, at(3), f.components);
  assert.deepEqual(f.feishu.map(n => n.kind), ['loop_completed']);
});

for (const tool of ['cc', 'codex', 'pi'] as const) test(`甲 真人时间 ${tool}：短词计在场，系统注入/工具结果不算真人`, async t => {
  const f = await fixture(t); f.config.sources = { cc: null, codex: null, pi: null, loop: null }; f.config.sources[tool] = join(f.root, tool);
  const rows = tool === 'cc' ? [ccUser('继续', at(4)), { ...ccUser('系统自动输入', at(5)), isSynthetic: true }]
    : tool === 'codex' ? [codexMeta(), codexEvent({ type: 'user_message', message: '继续' }, 'event_msg', at(4)), codexEvent({ type: 'user_message', message: '系统自动输入', isSynthetic: true }, 'event_msg', at(5))]
      : [piHeader(), piMessage('u', null, 'user', '继续', at(4)), piMessage('s', 'u', 'user', '系统自动输入', at(5), { isSynthetic: true })];
  await put(join(f.config.sources[tool]!, 'sample.jsonl'), rows);
  const view = await detect(f.config, at(5), f.components);
  assert.equal(view.records[0]!.humanRequestRefs!.length, 1); assert.equal(view.records[0]!.humanRequestRefs![0]!.at, at(4));
});

test('甲 红线规则和模型不可用：六类硬判含英文命令、建议中的红线；规则至少一件', () => {
  for (const text of ['删除旧文件', '合入分支', 'git push origin main', '给客户发消息', '购买套餐', '允许执行命令', 'rm -rf /synthetic', '发送消息到群']) {
    assert.equal(isRedline(text), true, text);
    const input = { goal: '构造目标', currentTask: null, lastOutput: text, factualStatus: '在等你' as const };
    const snapshot = modelSnapshot(input, { situation: '等你确认', actionItems: [{ text, label: '不用管' }] }, '', at(5))!;
    assert.equal(snapshot.actionItems![0]!.label, '要你定·红线');
    assert.ok(ruleSnapshot(input, '', at(5)).actionItems!.length >= 1);
  }
});

test('甲 模型不可用时逐件规则兜底仍有建议与红线，不等额外起草调用', async t => {
  const f = await fixture(t), answer = ccAnswer(at(0));
  answer.message.content[0]!.text = '请确认以下事项：\n1. 缓存保留多久？\n建议五分钟\n2. 请去浏览器验证效果\n3. 删除旧文件';
  await put(f.file, [ccUser('缓存任务', at(-20)), answer]);
  f.components.judge = { async judge(request) { f.calls.push(request); throw new Error('构造失败'); } };
  await detect(f.config, at(5), f.components);
  const snapshot = (await readOutbox(f.config.dataDir))[0]!.snapshot!;
  assert.equal(snapshot.source, '规则'); assert.equal(snapshot.actionItems!.length, 3);
  assert.deepEqual(snapshot.actionItems!.map(i => i.label), ['回复会话', '你去做', '要你定·红线']);
  assert.equal(snapshot.actionItems![0]!.suggestion, '五分钟');
  assert.equal(f.calls.filter(c => c.task === 'waiting').length, 1);
});

test('甲 等待模型迟到时已经接话，不发过期卡片、不覆盖新事实', async t => {
  const f = await fixture(t);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.components.judge = { async judge(request) {
    if (request.task === 'waiting') { enter(); await pending; return { answer: '是', reason: '旧问题等待' }; }
    return { answer: '否', reason: '无跑偏' };
  } };
  const first = detect(f.config, at(5), f.components);
  await entered;
  try {
    await appendFile(f.file, JSON.stringify(ccUser('实际回答', at(6))) + '\n');
    await detect(f.config, at(6), f.components);
  } finally { release(); }
  const view = await first;
  assert.equal(view.records[0]!.status, '进行中'); assert.equal(view.at, at(6));
  assert.deepEqual(await readOutbox(f.config.dataDir), []);
});

test('甲 已答完但有真实越界执行步骤，跑偏也不等回复间隔', async t => {
  const f = await fixture(t);
  await put(f.file, [ccUser('只改 A 模块', at(0)), ccCall(at(0), 'b', '修改 B 模块'), ccAnswer(at(1))]);
  f.components.judge = { async judge(request) {
    assert.equal(request.task, 'drift');
    return { answer: '是', reason: '真实越界步骤', intentQuote: '只改 A 模块', stepQuote: '修改 B 模块' };
  } };
  await detect(f.config, at(2), f.components);
  assert.deepEqual(f.local.map(n => n.kind), ['drift']); assert.equal(f.feishu.length, 0);
});

for (const format of ['legacy', 'event-item', 'top-item'] as const) for (const parentField of ['source', 'parent_session_id'] as const)
  test(`返修1-1：Codex 子任务 ${format}/${parentField} 不算在场，明确真人回复仍可跨会话分流`, async t => {
    const f = await fixture(t);
    f.config.sources.codex = join(f.root, 'codex');
    await put(join(f.config.sources.codex, 'parent.jsonl'), [codexMeta(), codexEvent({ type: 'user_message', message: '父任务' }, 'event_msg', at(-20))]);
    const base = codexMeta('child', 'demo-codex');
    const header = parentField === 'source' ? base : { ...base, payload: { id: 'child', cwd: '/sample/codex', timestamp: at(0), parent_session_id: 'demo-codex' } };
    const input = (text: string, minute: number, human = false) => {
      const origin = human ? { origin: { kind: 'human' } } : {};
      if (format === 'legacy') return codexEvent({ type: 'user_message', message: text, ...origin }, 'event_msg', at(minute));
      const item = { type: 'UserMessage', content: text, ...origin };
      return format === 'event-item' ? codexEvent({ type: 'item_completed', item }, 'event_msg', at(minute))
        : { timestamp: at(minute), type: 'item_completed', item };
    };
    const childFile = join(f.config.sources.codex, 'child.jsonl');
    await put(childFile, [header, input('子代理自动接任务', 4), { ...input('系统输入即使带 human 也不能算真人', 4.5, true), isSynthetic: true }]);
    const first = await detect(f.config, at(5), f.components);
    assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1, '用户离场时不能被子任务压住飞书告警');
    assert.equal(f.local[0]!.delivery!.presence, '不在场');
    const child = first.records.find(r => r.tool === 'codex')!.members!.find(m => m.sessionId === 'child')!;
    assert.equal(child.requestRefs!.latest!.at, at(4), '子任务意图和步骤要求索引仍保留');
    assert.deepEqual(humanRequests(child), []);
    const legacyChild: typeof child = { ...child, humanRequestRefs: [{ index: 0, at: at(4), sessionId: 'child' }] };
    assert.deepEqual(humanRequests(legacyChild), [], '旧缓存中无明确真人依据的子任务也不能算在场');
    delete legacyChild.humanRequestRefs;
    assert.deepEqual(humanRequests(legacyChild), [], '子任务不能从旧 requestRefs 兜底冒充真人');
    const answer = ccAnswer(at(6)); answer.message.content[0]!.text = '另一轮缓存问题？';
    await appendFile(f.file, JSON.stringify(answer) + '\n');
    await appendFile(childFile, JSON.stringify(input('实际真人的回复', 10, true)) + '\n');
    const second = await detect(f.config, at(11), f.components);
    assert.equal(f.local.length, 2); assert.equal(f.feishu.length, 1, '明确真人回复仍应使另一会话只弹本机');
    assert.equal(f.local[1]!.delivery!.lastHumanAt, at(10));
    const updated = second.records.find(r => r.tool === 'codex')!.members!.find(m => m.sessionId === 'child')!;
    assert.equal(humanRequests(updated).length, 1); assert.equal(humanRequests(updated)[0]!.at, at(10));
  });

for (const state of ['tool_use', 'end_turn-with-tool', 'completed'] as const)
  test(`返修1-2：CC 同时刻说明与越界工具 ${state} 即时跑偏，不套收尾问句窗口`, async t => {
    const f = await fixture(t), call = ccCall(at(1), 'b', '修改 B 模块');
    const mixed = { ...call, message: { ...call.message,
      stop_reason: state === 'end_turn-with-tool' ? 'end_turn' : 'tool_use',
      content: [{ type: 'text', text: '我正在处理模块修改。' }, ...call.message.content] } };
    const rows: unknown[] = [ccUser('只改 A 模块', at(0)), mixed];
    if (state === 'completed') rows.push({ ...ccUser('', at(1)), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '构造执行结果' }] } }, ccAnswer(at(1)));
    await put(f.file, rows);
    f.components.judge = { async judge(request) {
      f.calls.push(request); assert.equal(request.task, 'drift');
      return { answer: '是', reason: '真实执行越界', intentQuote: '只改 A 模块', stepQuote: 'Bash：修改 B 模块' };
    } };
    const view = await detect(f.config, at(2), f.components);
    assert.equal(f.calls.length, 1); assert.equal(view.records[0]!.status, '疑似跑偏');
    assert.deepEqual(f.local.map(n => n.kind), ['drift']); assert.equal(f.feishu.length, 0);
    assert.equal(view.records[0]!.pendingTools.length, state === 'completed' ? 0 : 1);
  });

test('甲 升级：已发旧卡缺新字段，未重发/重调/重写旧日志', async t => {
  const f = await actionFixture(t);
  const oldEvents = (await readEvents(f.config.dataDir)).map(e => {
    if (e.kind === 'notice_planned') { delete e.notice.snapshot; delete e.notice.delivery; delete e.notice.content.actionItems; }
    if (e.kind === 'model_checked') { delete e.check.snapshot; delete e.check.snapshotVersion; }
    return e;
  });
  const old = { ...f.notice }; delete old.snapshot; delete old.delivery; delete old.content.actionItems;
  await put(join(f.config.dataDir, 'events.jsonl'), oldEvents); await put(join(f.config.dataDir, 'outbox.jsonl'), [old]);
  const before = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8');
  const result = await detect(f.config, at(6), { channels: f.components.channels, judge: { async judge() { assert.fail('旧事实不得重调'); } } });
  assert.equal(result.noticesAdded, 0); assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), before);
  assert.ok(noticeCard(old));
  assert.ok(project([event({ kind: 'notice_planned', notice: old }, at(5))]).notices.length);
});
