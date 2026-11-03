import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect } from '../src/core/agent.ts';
import { receiveFeedback, readFeedback } from '../src/core/feedback.ts';
import { readLearning } from '../src/core/learning.ts';
import { appendOutbox, readOutbox } from '../src/core/store.ts';
import { cc } from '../src/sources/cc/index.ts';
import { codex } from '../src/sources/codex/index.ts';
import { pi } from '../src/sources/pi/index.ts';
import { ccUser, ccAnswer, codexMeta, codexEvent, piHeader, piMessage, loopSummary, sandbox, put, unmanaged, start } from './fixtures.ts';
import type { Notice } from '../src/core/types.ts';
for (const source of [cc, codex, pi]) for (const trailing of ['', '\n构造任务']) test(`旧原件解析兼容：${source.tool}的注入标签${trailing ? '和正文' : '单独'}仍正确区分`, () => {
  const text = '<ide_opened_file>自动文件</ide_opened_file>\n<system-reminder>注入</system-reminder>' + trailing;
  const rows = source.tool === 'cc' ? [ccUser(text), ccAnswer()] : source.tool === 'codex' ? [codexMeta(), codexEvent({ type: 'user_message', message: text }), codexEvent({ type: 'task_complete', last_agent_message: '完成' })]
    : [piHeader(), piMessage('u', null, 'user', text), piMessage('a', 'u', 'assistant', '完成')];
  const record = source.parse(rows.map(row => JSON.stringify(row)).join('\n'), { path: '/constructed', fingerprint: 'fp' })!;
  assert.equal(record.intent.initial, trailing.trim() || null);
});
for (const verdict of ['正确', '误报', '看不懂'] as const) test(`旧聊天卡片仍能收${verdict}反馈，保留原卡和原话，但不收集复盘`, async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const notice: Notice = { version: 1, id: 'old', dedupeKey: 'old', at: start, tool: 'cc', kind: 'waiting', level: '现在就要你', sessionKey: 'cc:old',
    content: { title: '旧卡片', summary: '旧正文', returnCommand: 'claude --resume old', evidence: { project: '/sample', intentOriginal: '旧任务', additionalRequirements: [], recentSteps: [], originals: [], reason: '旧原因' } }, text: '旧文本' };
  await appendOutbox(f.config.dataDir, notice); const prefix = await readFile(join(f.config.dataDir, 'outbox.jsonl'));
  const content = `${verdict} 构造的原话\n第二行`; await receiveFeedback(f.config.dataDir, 'test', { noticeId: 'old', content, at: start, replyId: 'one' });
  await receiveFeedback(f.config.dataDir, 'test', { noticeId: 'old', content, at: start, replyId: 'one' }); await detect(f.config, '2026-10-23T20:00:00Z');
  const rows = await readFeedback(f.config.dataDir); assert.equal(rows.length, 1); assert.equal(rows[0]!.originalText, content); assert.equal(rows[0]!.card!.title, '旧卡片');
  assert.deepEqual(await readFile(join(f.config.dataDir, 'outbox.jsonl')), prefix); assert.deepEqual((await readLearning(f.config.dataDir)).events, []);
});
test('loop误报反馈仍按批次压制同类卡，不压其他批次', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true })); f.config.sources.loop = join(f.root, 'loop');
  const path = join(f.config.sources.loop, 'p', '11111111-1111-4111-8111-111111111111.md'); await put(path, loopSummary('暂停'));
  await detect(f.config, start); await detect(f.config, '2026-10-20T10:05:00Z'); const [notice] = await readOutbox(f.config.dataDir);
  await receiveFeedback(f.config.dataDir, 'test', { noticeId: notice!.id, content: '误报', at: '2026-10-20T10:06:00Z' });
  await put(path, loopSummary('暂停：新原因')); await detect(f.config, '2026-10-20T10:07:00Z'); assert.equal((await readOutbox(f.config.dataDir)).length, 1);
});
test('聊天图片/追加要求不再重开盯防或触发停滞', async t => {
  await unmanaged(t, 'cc', [ccUser(), ccAnswer(), { ...ccUser(''), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'SYNTHETIC' } }] } }]);
});
