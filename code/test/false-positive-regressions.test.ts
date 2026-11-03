// 原聊天对账/目录/内部会话误报，现统一验证为不再扫描或分析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect } from '../src/core/agent.ts';
import { readOutbox } from '../src/core/store.ts';
import { ccUser, ccAnswer, codexMeta, codexEvent, piHeader, piMessage, unmanaged, sandbox, putLoop, start } from './fixtures.ts';
for (const tool of ['cc', 'codex', 'pi'] as const) for (const id of ['ordinary', 'autoreview-rev', 'autoreview-acc', 'missing', 'wrong-project'])
  test(`不再发生聊天误报：${tool}/${id}钩子错配不报警、不调用模型`, async t => {
    const rows = tool === 'cc' ? [ccUser(), ccAnswer()] : tool === 'codex' ? [codexMeta(), codexEvent({ type: 'user_message', message: '构造任务' })]
      : [piHeader(), piMessage('u', null, 'user', '构造任务')];
    await unmanaged(t, tool, rows, { pushes: [{ tool, event: 'waiting_permission', session_id: id, cwd: '/constructed/wrong', transcript_path: '/constructed/outside', at: start, detail: '授权吗？' }] });
  });
test('减法不删loop总结：内部开发会话不入总览，但loop暂停仍提醒', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true })); await putLoop(f.config, f.root);
  const view = await detect(f.config, start); assert.deepEqual(view.records.map(record => record.tool), ['loop']); assert.equal((await readOutbox(f.config.dataDir))[0]!.kind, 'loop_paused');
});
