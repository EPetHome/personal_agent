// 构造回归：失败的 Pi 工具提案未执行；Codex 后台收尾不重开任务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect } from '../src/core/agent.ts';
import { pi } from '../src/sources/pi/index.ts';
import { codex } from '../src/sources/codex/index.ts';
import { readFile } from 'node:fs/promises';
import { readOutbox, readEvents } from '../src/core/store.ts';
import type { SessionRecord } from '../src/core/types.ts';
import { codexEvent, codexMeta, piHeader, piMessage, put, sandbox, start } from './fixtures.ts';

test('A10 Pi error/aborted 中的 toolCall 不计待返回，重试答完即完成', async t => {
  const { root, config } = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  config.sources.cc = null;
  config.sources.pi = join(root, 'pi');
  for (const stopReason of ['error', 'aborted']) {
    await put(join(config.sources.pi, `${stopReason}.jsonl`), [
      { ...piHeader(), id: stopReason }, piMessage('u', null, 'user', '只改 A'),
      piMessage('bad', 'u', 'assistant', [{ type: 'toolCall', id: 'never-executed', name: 'bash', arguments: { command: 'npm test' } }], start, { stopReason }),
      piMessage('retry', 'bad', 'assistant', [{ type: 'text', text: '已完成' }], '2026-10-20T10:01:00Z'),
    ]);
  }
  const view = await detect(config, '2026-10-20T10:02:00Z');
  assert.deepEqual(view.records, []);
  assert.deepEqual(await readOutbox(config.dataDir), []);
  for (const stopReason of ['error', 'aborted']) {
    const record: SessionRecord = pi.parse(await readFile(join(config.sources.pi!, `${stopReason}.jsonl`), 'utf8'), { path: '/constructed', fingerprint: 'fp' })!;
    assert.equal(record.assistantFinished, true); assert.equal(record.pendingTools.length, 0);
  }
  assert.equal((await readEvents(config.dataDir)).some(e => e.kind === 'model_call_started'), false);
});

test('A10 Codex task_complete 后的后台 item_completed 不重开；新 task_started 仍重开', async t => {
  const { root, config } = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  config.sources.cc = null;
  config.sources.codex = join(root, 'codex');
  const path = join(config.sources.codex, 'session.jsonl');
  const rows = [codexMeta(), codexEvent({ type: 'user_message', message: '只改 A' }),
    codexEvent({ type: 'task_complete', last_agent_message: '已完成' }),
    codexEvent({ item: { type: 'CommandExecution', id: 'background', command: 'npm test', status: 'completed' } }, 'item_completed', '2026-10-20T10:01:00Z')];
  await put(path, rows);
  assert.deepEqual((await detect(config, '2026-10-20T10:02:00Z')).records, []);
  assert.equal(codex.parse(await readFile(path, 'utf8'), { path, fingerprint: 'fp' })!.assistantFinished, true);
  await put(path, [...rows, codexEvent({ type: 'task_started' }, 'event_msg', '2026-10-20T10:03:00Z')]);
  assert.deepEqual((await detect(config, '2026-10-20T10:04:00Z')).records, []);
  assert.equal(codex.parse(await readFile(path, 'utf8'), { path, fingerprint: 'fp' })!.assistantFinished, false);
  assert.deepEqual(await readOutbox(config.dataDir), []);
});
