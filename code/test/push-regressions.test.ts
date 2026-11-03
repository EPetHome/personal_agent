import { test } from 'node:test';
import { codexMeta, codexEvent, unmanaged, start } from './fixtures.ts';
for (const event of ['waiting_permission', 'turn_end', 'session_end']) for (const identity of ['parent', 'child', 'unknown'])
  test(`旧推送对账已删除：${identity}/${event}不读路径、不出卡、不报错配`, async t => {
    await unmanaged(t, 'codex', [codexMeta('parent'), codexEvent({ type: 'user_message', message: '父任务' }), codexMeta('child', 'parent'), codexEvent({ type: 'user_message', message: '子任务' })],
      { pushes: [{ tool: 'codex', event, session_id: identity, cwd: '/sample/codex', transcript_path: '/constructed/mismatched.jsonl', at: start, detail: '需要你授权吗？' }] });
  });
for (const pushes of ['{broken', '[]\n', '{"tool":"alien"}\n']) test(`坏hook不再报盲：${pushes}`, async t => { await unmanaged(t, 'cc', '', { pushes }); });
