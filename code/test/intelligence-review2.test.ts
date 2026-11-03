// 旧后台分析及其父子成员提醒不再执行，红线文字也不能重新开启聊天监控。
import { test } from 'node:test';
import { codexMeta, codexEvent, unmanaged } from './fixtures.ts';
for (const parent of ['在等你', '做完了', '仍在进行']) for (const child of ['缓存多久？', '删除并强推吗？', '已经完成'])
  test(`不再分析父子聊天：父${parent}、子${child}均无卡片或模型调用`, async t => {
    const rows = [codexMeta('parent'), codexEvent({ type: 'user_message', message: '父任务' }), codexEvent({ type: 'task_complete', last_agent_message: parent }),
      codexMeta('child', 'parent'), codexEvent({ type: 'user_message', message: '子任务' }), codexEvent({ type: 'task_complete', last_agent_message: child })];
    await unmanaged(t, 'codex', rows, { pushes: [{ tool: 'codex', event: 'waiting_permission', session_id: 'parent', cwd: '/sample/codex', transcript_path: '/constructed/parent.jsonl', at: '2026-10-20T10:00:00Z', detail: parent }] });
  });
