import { test } from 'node:test';
import { codexMeta, codexEvent, unmanaged, start } from './fixtures.ts';
for (const parent of [undefined, 'missing', 'child']) for (const event of ['waiting_permission', 'session_end'])
  test(`停止父子聊天对账：父${parent}/${event}不再报孤儿或错配`, async t => {
    await unmanaged(t, 'codex', [codexMeta('child', parent), codexEvent({ type: 'user_message', message: '构造子任务' })],
      { pushes: [{ tool: 'codex', event, session_id: 'child', cwd: '/sample/codex', transcript_path: '/wrong', at: start }] });
  });
