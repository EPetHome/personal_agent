import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localTime } from '../src/core/notice-text.ts';
import { ccAnswer, ccUser, codexMeta, codexEvent, unmanaged } from './fixtures.ts';
test('CC 等回复卡片已删除，不再起草四段式和回看命令', async t => {
  const reply = ccAnswer(); reply.message.content[0]!.text = '需要你确认接口？'; await unmanaged(t, 'cc', [ccUser(), reply]);
});
test('Codex 报信错配不再触发故障提醒或归因', async t => {
  await unmanaged(t, 'codex', [codexMeta(), codexEvent({ type: 'user_message', message: '构造' })], { pushes: [{ tool: 'codex', event: 'turn_end', session_id: 'wrong', cwd: '/sample', transcript_path: '/wrong', at: '2026-10-20T10:00:00Z' }] });
});
test('卡片时间仍按本机当地日历，不显示UTC原串', () => {
  const now = '2026-10-20T12:00:00Z'; assert.doesNotMatch(localTime(now, now), /2026-10-20T/); assert.match(localTime(now, now), /今天/);
});
