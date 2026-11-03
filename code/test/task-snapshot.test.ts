import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, rebuild } from '../src/core/agent.ts';
import { modelSnapshot, snapshotInput, ruleSnapshot } from '../src/core/task-snapshot.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { cc } from '../src/sources/cc/index.ts';
import { codex } from '../src/sources/codex/index.ts';
import { pi } from '../src/sources/pi/index.ts';
import { ccAnswer, ccUser, codexMeta, codexEvent, piHeader, piMessage, loopSummary, sandbox, put, unmanaged, start } from './fixtures.ts';
import type { TaskSnapshotDraft } from '../src/core/types.ts';
const goal = '给商店做库存管理', current = '给商品列表加缓存', reply = '缓存多久？';
for (const source of [cc, codex, pi]) test(`保留旧快照输入读取：${source.tool}跳过标签占位，只取回复之前的要求`, () => {
  const texts = ['[Image: /constructed.png]', '<file>注入</file>', '继续', goal, current];
  const rows = source.tool === 'cc' ? [...texts.map(text => ccUser(text)), { ...ccAnswer(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } }]
    : source.tool === 'codex' ? [codexMeta(), ...texts.map(message => codexEvent({ type: 'user_message', message })), codexEvent({ type: 'task_complete', last_agent_message: reply })]
      : [piHeader(), ...texts.map((text, i) => piMessage(`u${i}`, i ? `u${i-1}` : null, 'user', text)), piMessage('a', 'u4', 'assistant', reply)];
  const record = source.parse(rows.map(row => JSON.stringify(row)).join('\n'), { path: '/constructed', fingerprint: 'fp' })!;
  assert.deepEqual(snapshotInput(record, reply, '在等你', start, 'reply'), { goal, currentTask: current, lastOutput: reply, factualStatus: '在等你' });
});
test('聊天快照已删除：不再将问句交给独立起草器', async t => { const answer = ccAnswer(); answer.message.content[0]!.text = reply; await unmanaged(t, 'cc', [ccUser(goal), answer]); });
const draft: TaskSnapshotDraft = { situation: '构造批次已完成，人工项等待核销', action: '请查看人工项', actionType: '去看一眼' };
for (const mode of ['success', 'failure', 'timeout', 'zero-budget'] as const) test(`loop快照保留：${mode}都交付且重建不重发`, async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true })); f.config.sources.loop = join(f.root, 'loop');
  f.config.judge = { executable: '/constructed', model: 'fake', timeoutMs: 10, dailyLimit: mode === 'zero-budget' ? 0 : 10 };
  await put(join(f.config.sources.loop, 'project', '11111111-1111-4111-8111-111111111111.md'), loopSummary()); let calls = 0;
  const components = { judge: { async writeSnapshot() { calls++; if (mode === 'failure') throw new Error('constructed'); if (mode === 'timeout') return new Promise<TaskSnapshotDraft>(() => {}); return draft; } } };
  await detect(f.config, start, components); const out = await readOutbox(f.config.dataDir); assert.equal(out.length, 1);
  assert.equal(out[0]!.snapshot!.source, mode === 'success' ? '模型' : '规则'); assert.equal(calls, mode === 'zero-budget' ? 0 : 1);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'model_call_started').length, calls);
  await rebuild(f.config); await detect(f.config, '2026-10-20T10:01:00Z', components); assert.equal(calls, mode === 'zero-budget' ? 0 : 1); assert.deepEqual(await readOutbox(f.config.dataDir), out);
});
test('快照字段不完整整份规则兜底；红线分件仍由程序升级', () => {
  const input = { goal, currentTask: current, lastOutput: '删除并合入吗？', factualStatus: 'loop 暂停' as const };
  assert.equal(modelSnapshot(input, { situation: '有进展' }, '/sample', start), null);
  assert.equal(ruleSnapshot(input, '/sample', start).source, '规则');
  const snapshot = modelSnapshot(input, { situation: '构造任务', action: '删除并合入', actionType: '做个决定', actionItems: [{ text: '删除并合入', label: '回复会话' }] }, '/sample', start)!;
  assert.equal(snapshot.actionItems![0]!.label, '要你定·红线');
});
