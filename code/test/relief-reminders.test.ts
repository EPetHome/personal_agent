// 原聊天提醒合并和在场分流已删除，逐件卡片渲染由 card-content 保留检查。
import { test } from 'node:test';
import { ccAnswer, ccCall, ccUser, unmanaged } from './fixtures.ts';
for (const count of [1, 2, 10]) for (const text of ['请选择方案？', '已经完成，只汇报', '允许删除数据并合入吗？'])
  test(`不再合并聊天提醒：${count}个${text}不出卡、不调模型`, async t => {
    const rows = Array.from({ length: count }, (_, i) => { const answer = ccAnswer(); answer.message.content[0]!.text = text;
      return [ccUser('只修改构造文件'), ccCall(undefined, `call-${i}`), answer].map(row => ({ ...row, sessionId: `s-${i}` })); }).flat();
    await unmanaged(t, 'cc', rows);
  });
