import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, rebuild } from '../src/core/agent.ts';
import type { Channel, Notice } from '../src/core/types.ts';
import { ccAnswer, ccUser, ccCall, putLoop, put, sandbox, unmanaged, start } from './fixtures.ts';
for (const kind of ['waiting', 'drift', 'stalled', 'broken']) test(`聊天${kind}不再投本机或飞书`, async t => {
  const answer = ccAnswer(); answer.message.content[0]!.text = '需要你确认？'; await unmanaged(t, 'cc', kind === 'broken' ? '{broken\n' : [ccUser(), ccCall(undefined, 'b', '修改无关 B'), answer]);
});
for (const mode of ['pause', 'complete', 'blind'] as const) test(`loop ${mode}保留原渠道和去重`, async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  if (mode === 'blind') f.config.sources.loop = join(f.root, 'missing'); else await putLoop(f.config, f.root, mode === 'pause' ? '暂停' : '完成');
  const local: Notice[] = [], feishu: Notice[] = [];
  const channel = (name: string, out: Notice[]): Channel => ({ name, levels: ['现在就要你', '有空看'], async send(n) { out.push(n); }, async receive() { return ''; } });
  const components = { channels: [channel('local', local), channel('feishu', feishu)] };
  await detect(f.config, start, components); await rebuild(f.config); await detect(f.config, '2026-10-20T10:01:00Z', components);
  assert.equal(feishu.length, 1); assert.equal(local.length, mode === 'complete' ? 0 : 1);
});
test('loop暂停五分钟内恢复不叫，再暂停重新计时', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const { readOutbox } = await import('../src/core/store.ts');
  await putLoop(f.config, f.root, '暂停', start); await detect(f.config, start);
  await putLoop(f.config, f.root, '进行中', '2026-10-20T10:02:00Z'); await detect(f.config, '2026-10-20T10:02:00Z'); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  const path = await putLoop(f.config, f.root, '暂停', '2026-10-20T10:03:00Z'); assert.ok(path);
  await detect(f.config, '2026-10-20T10:07:59Z'); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  await detect(f.config, '2026-10-20T10:08:00Z'); assert.equal((await readOutbox(f.config.dataDir)).length, 1);
});
