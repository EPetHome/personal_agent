// 卡片内容只用构造会话和判断器替身；不连接个人工具或平台。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect } from '../src/core/agent.ts';
import { readJsonl, readOutbox } from '../src/core/store.ts';
import { humanText, noticeTimeAndReturn, requestedAction } from '../src/core/notice-text.ts';
import { intentText } from '../src/core/utils.ts';
import { agentNotice } from '../src/core/learning.ts';
import { noticeCard } from '../src/channels/feishu/card.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import type { ReviewItem } from '../src/core/types.ts';
import { ccAnswer, ccUser, codexEvent, codexMeta, piHeader, piMessage, put, sandbox } from './fixtures.ts';

// 版式测试在等候五分钟且离场后发卡。
const now = '2026-10-20T10:11:00.000Z';
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.feishu = { mode: 'fake', receiverId: 'ou_synthetic', timeoutMs: 1000 }; f.config.learning = false;
  f.config.judge = { executable: '/test-only/no-real-model', model: 'fake', timeoutMs: 1000, dailyLimit: 10 };
  return f;
}
function front(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(front).join('\n');
  if (!value || typeof value !== 'object' || ('tag' in value && value.tag === 'collapsible_panel')) return '';
  return Object.entries(value).filter(([key]) => key !== 'value').map(([, child]) => front(child)).join('\n');
}
for (const tool of ['cc', 'codex', 'pi'] as const) for (const onlyImages of [false, true]) test(`卡片 A4/A5：${tool} ${onlyImages ? '全部截图写意图不明' : '截图开头取后面的第一条文字'}，不露媒体占位`, async t => {
  const f = await fixture(t);
  const placeholder = '[Image: source: /synthetic/screenshot.png]';
  const users: unknown[] = [placeholder, onlyImages ? '[Attachment: source: /synthetic/file.pdf]' : '给商品列表加缓存', [{ type: 'image', source: { type: 'base64', data: 'SYNTHETIC_IMAGE' } }]];
  const reply = '请你选择缓存保留五分钟还是十分钟？';
  const path = join(f.root, tool, 'sample.jsonl');
  f.config.sources = { cc: null, codex: null, pi: null, loop: null }; f.config.sources[tool] = join(f.root, tool);
  if (tool === 'cc') {
    const answer = ccAnswer(); answer.cwd = '/demo/shop'; answer.message.content[0]!.text = reply;
    await put(path, [...users.map(content => ({ ...ccUser(), cwd: '/demo/shop', message: { role: 'user', content } })), answer]);
  } else if (tool === 'codex') {
    const meta = codexMeta(); meta.payload.cwd = '/demo/shop';
    await put(path, [meta, ...users.map(message => codexEvent({ type: 'user_message', message })), codexEvent({ type: 'task_complete', last_agent_message: reply })]);
  } else {
    const header = piHeader(); header.cwd = '/demo/shop';
    await put(path, [header, ...users.map((content, n) => piMessage(`u${n}`, n ? `u${n - 1}` : null, 'user', content)), piMessage('a', 'u2', 'assistant', reply)]);
  }
  const view = await detect(f.config, now, { judge: { async judge(request) { return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造的等回复' }; } } });
  assert.equal(view.records[0]!.intent.initial, onlyImages ? null : '给商品列表加缓存');
  assert.deepEqual(view.records[0]!.intent.additions, []);
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'waiting')!;
  const message = (await readJsonl<SentMessage>(join(f.config.dataDir, 'feishu-sent.jsonl'))).find(m => m.noticeId === notice.id)!;
  const body = front(message.content);
  assert.match(body, /shop 的 .*可能在等你回复/);
  assert.match(body, onlyImages ? /\*\*这件事\*\*：意图不明/ : /\*\*这件事\*\*：给商品列表加缓存/);
  assert.doesNotMatch(body, /\[Image|\[Attachment|SYNTHETIC_IMAGE|screenshot\.png/);
  assert.match(body, /\*\*时间 \/ 回去看\*\*：.*\d\d:\d\d/);
});

test('媒体和真人文字在同一消息时只除占位；Pi限长前先排除超长占位', async t => {
  const message = '[Image: source: /synthetic/' + 'x'.repeat(2000) + '.png]\n给商品列表加缓存\n![截图](/synthetic/second.png)\n[File: /synthetic/cache.pdf]';
  assert.equal(intentText(message), '给商品列表加缓存');
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.pi = join(f.root, 'pi');
  await put(join(f.config.sources.pi, 'sample.jsonl'), [piHeader(), piMessage('u', null, 'user', message), piMessage('a', 'u', 'assistant', '请你确认是否继续？')]);
  const view = await detect(f.config, now, { judge: { async judge() { return { answer: '是', reason: '构造提问' }; } } });
  assert.equal(view.records[0]!.intent.initial, '给商品列表加缓存');
});

test('卡片 A6/A7：实际检测保留冒号后三项列表，时间后有空格', async t => {
  const f = await fixture(t), answer = ccAnswer();
  answer.message.content[0]!.text = '已完成本轮修改。\n等你核销：\n- 在飞书点几张卡片的按钮\n- 看新卡片是不是一眼能懂\n- 确认这一周反馈都留得下来';
  await put(join(f.config.sources.cc!, 'sample.jsonl'), [ccUser('给商品列表加缓存'), answer]);
  await detect(f.config, now, { judge: { async judge(request) { return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造列表提问' }; } } });
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'waiting')!;
  const action = notice.content.summary;
  for (const item of ['在飞书点几张卡片的按钮', '看新卡片是不是一眼能懂', '确认这一周反馈都留得下来']) assert.ok(action.includes(item));
  assert.match(noticeTimeAndReturn(notice), /\d\d:\d\d/);
  assert.ok(!action.endsWith('：'));
});

for (const marker of ['-', '*', '+', '1.', '1)', '1、', '- [ ]']) test(`列表动作支持 ${marker}，不被列表内部的请/问题拆成最后一项`, () => {
  const action = requestedAction(`等你核销：\n\n${marker} 请点一下按钮\n${marker} 卡片是否清楚？\n\n${marker} 确认反馈还在`, '/demo/shop');
  for (const item of ['等你核销：', '请点一下按钮', '卡片是否清楚？', '确认反馈还在']) assert.ok(action.includes(item), action);
});
test('长列表可截断但不能只剩引子；代码和表格中的假问题仍跳过', () => {
  const action = requestedAction('等你' + '核销内容'.repeat(100) + '：\n- 真正的第一项\n- 第二项', '');
  assert.ok([...action].length <= 241); assert.match(action, /真正的第一项/);
  assert.equal(requestedAction('请确认继续？\n```txt\n假的问题？\n```\n| 假的表格问题？ | 内容 |', ''), '请确认继续？');
  assert.match(humanText('2026-10-20T10:00:00Z答完后', '', now), /\d\d:\d\d 答完后/);
});

test('卡片 A8：单独复盘、周报多项复盘标题均只出现一次，审阅按钮保留', () => {
  const item = (n: number): ReviewItem => ({ experienceId: `experience-${n}`, experienceRevision: `revision-${n}`, title: `构造复盘标题${n}：需要确认归因与对策`, count: 2, previousAt: now, previousCountermeasure: '', layer: '归因未定', countermeasure: '', status: '待确认' });
  const reviews = [item(1), item(2)];
  for (const kind of ['recurrence', 'weekly'] as const) {
    const notice = agentNotice(kind, kind, now, '复盘卡片', '这件事：本周发现两类提醒问题\n\n要你做：请打开证据确认归因和对策', 'open /synthetic/summary.md', reviews);
    const card = noticeCard(notice), body = front(card);
    for (const review of reviews) assert.ok(!body.includes(review.title), '长复盘只放证据');
    const json = JSON.stringify(card);
    for (const review of reviews) assert.equal(json.split(review.title).length - 1, 1);
    assert.equal((json.match(/"action":"agree"/g) ?? []).length, 2);
    assert.equal((json.match(/"action":"revise"/g) ?? []).length, 2);
  }
});

test('会话错配只影响该会话，文案与判断一致，同工具其他会话及其他工具不受影响', async t => {
  const f = await fixture(t); f.config.judge = null; f.config.sources.codex = join(f.root, 'codex');
  await put(join(f.config.sources.cc!, 'good.jsonl'), [ccUser(), ccAnswer()]);
  for (const id of ['codex-a', 'codex-b']) await put(join(f.config.sources.codex, `${id}.jsonl`), [codexMeta(id), codexEvent({ type: 'user_message', message: '构造缓存任务' })]);
  await put(join(f.config.inboxDir!, 'codex.jsonl'), [{ tool: 'codex', event: 'waiting_permission', session_id: 'codex-a', cwd: '/sample/codex', transcript_path: join(f.config.sources.codex, 'wrong.jsonl'), at: now, detail: '构造错配' }]);
  const view = await detect(f.config, now);
  assert.equal(view.records.find(r => r.sessionId === 'codex-a')?.status, '看不见了');
  assert.equal(view.records.find(r => r.sessionId === 'codex-b')?.status, '进行中');
  assert.equal(view.projection.health.get('codex')?.since, null);
  assert.equal(view.records.find(r => r.tool === 'cc')!.status, '已完成');
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'blind')!;
  assert.match(notice.content.summary, /只影响这一个会话，其他会话继续检测/);
  assert.doesNotMatch(notice.content.summary, /所有会话当前状态都暂时不能确认/);
});
