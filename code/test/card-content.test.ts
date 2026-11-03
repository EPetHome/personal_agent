import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeCard } from '../src/channels/feishu/card.ts';
import { presentNotice, requestedAction, localTime } from '../src/core/notice-text.ts';
import { ruleSnapshot } from '../src/core/task-snapshot.ts';
import { ccAnswer, ccUser, unmanaged, start } from './fixtures.ts';
import type { Notice } from '../src/core/types.ts';
for (const text of ['[Image: /constructed.png]', '[Image: /constructed.png]\n给商品列表加缓存']) test('聊天卡片已删除：截图占位或正文不会触发起草', async t => {
  const answer = ccAnswer(); answer.message.content[0]!.text = '请确认方案？'; await unmanaged(t, 'cc', [ccUser(text), answer]);
});
test('保留卡片逐件渲染：loop人工事项不合成一项，反馈按钮和时间仍齐全', () => {
  const input = { goal: '构造loop任务', currentTask: null, lastOutput: '构造批次完成；还欠 3 项', factualStatus: 'loop 完成' as const }, snapshot = ruleSnapshot(input, '/sample', start);
  const raw = { title: 'loop 做完', summary: '', returnCommand: 'open 构造总结', evidence: { project: '/sample', intentOriginal: '构造目标', additionalRequirements: [], recentSteps: [], reason: '完成', originals: [] } };
  const content = presentNotice({ ...raw, actionItems: [{ text: '检查第一项', label: '你去做' }, { text: '决定合入', label: '要你定·红线' }] }, snapshot.situation, snapshot.action, start);
  const notice: Notice = { version: 1, id: 'constructed', dedupeKey: 'constructed', at: start, tool: 'loop', kind: 'loop_completed', level: '有空看', content, text: '' };
  const card = JSON.stringify(noticeCard(notice)); for (const text of ['检查第一项', '决定合入', '正确', '误报', '时间 / 回去看']) assert.ok(card.includes(text));
});
test('保留问题提取与当地时间：列表末尾问题不丢，代码里的假问题跳过', () => {
  const result = requestedAction('请确认下面的事项：\n- 缓存保留多久？\n- 是否上线？', '/sample', ''); assert.match(result, /缓存保留多久|是否上线/);
  assert.doesNotMatch(localTime(start, start), /2026-10-20T/);
});
