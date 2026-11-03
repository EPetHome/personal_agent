import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codex } from '../src/sources/codex/index.ts';
import { codexMeta, codexEvent, unmanaged } from './fixtures.ts';
for (const prefix of ['metadata', 'pending', 'completed']) test(`停止扫描坏子文件：${prefix}前缀后截断，不出卡也不调模型`, async t => {
  const rows = [codexMeta('child', 'missing'), ...(prefix === 'metadata' ? [] : [codexEvent({ type: prefix === 'completed' ? 'task_complete' : 'user_message', message: '构造', last_agent_message: '请确认？' })])];
  await unmanaged(t, 'codex', rows.map(row => JSON.stringify(row)).join('\n') + '\n{broken\n');
});
test('旧身份解析兼容：可靠父子身份需非空标识和项目', () => {
  for (const parent of [123, false, '']) { const row: any = codexMeta('child'); row.payload.source = { subagent: { thread_spawn: { parent_thread_id: parent } } };
    const identity = codex.identifyRow!(row); assert.ok(!identity?.parentSessionId); }
});
