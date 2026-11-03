// 聊天在场/离场等待已删除：原来各等待窗口都应保持安静。
import { test } from 'node:test';
import { ccAnswer, ccUser, codexMeta, codexEvent, piHeader, piMessage, start, unmanaged } from './fixtures.ts';
for (const minutes of [0, 4, 5, 10, 20, 25, 31, 1441]) for (const other of [false, true]) {
  test(`聊天等待已删除：停下${minutes}分钟、${other ? '去别处' : '未去别处'}均不推送`, async t => {
    const reply = ccAnswer(); reply.message.content[0]!.text = '需要你选 A 还是 B？';
    await unmanaged(t, 'cc', [ccUser(), reply, ...(other ? [{ ...ccUser('另一会话', '2026-10-20T10:01:00Z'), sessionId: 'other' }] : [])],
      { now: new Date(Date.parse(start) + minutes * 60000).toISOString() });
  });
}
for (const text of ['请选择方案？', '是否允许合入并推送远端？', '只是完成汇报。']) for (const tool of ['codex', 'pi'] as const)
  test(`聊天等待已删除：${tool} 的${text}不再交由 PA 判断`, async t => {
    await unmanaged(t, tool, tool === 'codex' ? [codexMeta(), codexEvent({ type: 'user_message', message: '构造任务' }), codexEvent({ type: 'task_complete', last_agent_message: text })]
      : [piHeader(), piMessage('u', null, 'user', '构造任务'), piMessage('a', 'u', 'assistant', text)]);
  });
