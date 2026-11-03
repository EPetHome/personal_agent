// 聊天模型队列已删除；数量、冷却、历史、新输出均不能触发调用。
import { test } from 'node:test';
import { ccUser, ccCall, ccAnswer, unmanaged } from './fixtures.ts';
for (const count of [1, 20, 200]) for (const mode of ['question', 'drift', 'finished'] as const)
  test(`无聊天模型队列：${count}个${mode}输入不调模型、不出卡`, async t => {
    const rows = Array.from({ length: count }, (_, i) => {
      const answer = ccAnswer(); answer.message.content[0]!.text = mode === 'question' ? '请确认下一步？' : '完成';
      return [ccUser('只改 A 文件'), mode === 'drift' ? ccCall(undefined, `tool-${i}`, '修改无关 B') : answer].map(row => ({ ...row, sessionId: `session-${i}` }));
    }).flat();
    await unmanaged(t, 'cc', rows);
  });
