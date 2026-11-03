import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccUser, ccCall, ccAnswer, codexMeta, codexEvent, unmanaged } from './fixtures.ts';
import { event, packProjection, project, unpackProjection } from '../src/core/events.ts';
import { cc } from '../src/sources/cc/index.ts';
for (const text of ['', '{}\n', '{"type":"metadata"}\n', '{broken\n']) test(`不重放聊天来源：${JSON.stringify(text)}不会报看不见`, async t => { await unmanaged(t, 'cc', text); });
for (const rows of [[ccUser(), ccCall()], [ccUser(), ccAnswer()], [codexMeta(), codexEvent({ type: 'task_complete', last_agent_message: '选择方案？' })]])
  test('旧会话解析样例不再进入检测与模型队列', async t => { await unmanaged(t, 'cc', rows); });
test('历史事件仍可只读重放和检查点恢复，不删除旧会话或篡改原事件', () => {
  const record = cc.parse([ccUser(), ccCall()].map(row => JSON.stringify(row)).join('\n'), { path: '/constructed', fingerprint: 'fp' })!;
  const rows = [event({ kind: 'session_observed', record }, '2026-10-20T10:00:00Z')], raw = JSON.stringify(rows);
  const state = project(rows); assert.deepEqual(unpackProjection(packProjection(state)), state); assert.equal(JSON.stringify(rows), raw);
});
