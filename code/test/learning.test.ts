// 复盘行为已删除；旧经验只读/显式修改与离线统计仍兼容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, publishNotices } from '../src/core/agent.ts';
import { agentNotice, changeExperience, experienceRevision, exportExperiences, readLearning } from '../src/core/learning.ts';
import type { Experience } from '../src/core/learning.ts';
import { receiveFeedback, readFeedback } from '../src/core/feedback.ts';
import { calculateStatistics } from '../src/core/statistics.ts';
import { readOutbox } from '../src/core/store.ts';
import { sandbox, put, start } from './fixtures.ts';
test('复盘/周报已删除：漏报和重复问题仅存反馈，不收集经验、不发报告', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const at of ['2026-10-19T10:00:00Z', '2026-10-20T10:00:00Z', '2026-10-23T18:00:00Z', '2026-10-23T20:00:00Z']) {
    const response = await receiveFeedback(f.config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at });
    assert.doesNotMatch(response, /周报|本周|复盘/); await detect(f.config, at);
  }
  assert.equal((await readFeedback(f.config.dataDir)).length, 4); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  assert.deepEqual((await readLearning(f.config.dataDir)).events, []);
});
test('旧报告即使显式交给发件入口，也不再新发或追加计划', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const kind of ['weekly', 'daily', 'recurrence'] as const) await publishNotices(f.config, [agentNotice(kind, kind, start, '旧报告', '旧正文', 'old')], start, []);
  assert.deepEqual(await readOutbox(f.config.dataDir), []);
});
test('旧经验显式修改保留四状态、版本校验和重投幂等，不自动复活过期经验', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const experience: Experience = { id: 'e', type: '误报', tool: 'loop', project: '/sample', layer: '盯防自身', reason: '构造', countermeasure: '先核对',
    status: '待确认', sources: ['constructed'], createdAt: start, updatedAt: start, lastUsedAt: start, note: '' };
  const path = join(f.config.dataDir, 'learning.jsonl'); await put(path, [{ version: 1, kind: 'experience', at: start, experience }]); const prefix = await readFile(path, 'utf8');
  const revision = experienceRevision(experience);
  assert.equal(await changeExperience(f.config.dataDir, 'e', '已确认', undefined, start, 'reply', revision), 'changed');
  assert.equal(await changeExperience(f.config.dataDir, 'e', '已确认', undefined, start, 'reply', revision), 'duplicate');
  assert.equal(await changeExperience(f.config.dataDir, 'e', '待确认', undefined, start, 'new-reply', revision), 'stale');
  await changeExperience(f.config.dataDir, 'e', '已过时'); await assert.rejects(changeExperience(f.config.dataDir, 'e', '已撤销'), /原因/);
  await changeExperience(f.config.dataDir, 'e', '已撤销', { note: '构造撤销依据' }); assert.equal(await changeExperience(f.config.dataDir, 'e', '已确认', undefined, start, 'old-button', revision), 'inactive');
  assert.ok((await readFile(path, 'utf8')).startsWith(prefix)); assert.match(await exportExperiences(f.config.dataDir), /构造撤销依据/);
});
test('离线统计仍可查旧记录，不回应不算正确，重复反馈只取最新', () => {
  const notice = { ...agentNotice('daily', 'old', start, '构造', '正文', 'cmd'), tool: 'loop' as const, kind: 'loop_paused' as const };
  const feedback = (verdict: '正确' | '误报', at: string) => ({ version: 1 as const, at, date: at.slice(0, 10), channel: 'test', noticeId: notice.id, verdict, comment: '' });
  assert.equal(calculateStatistics([notice], [], start).cells[0]!.accuracy, null);
  const cell = calculateStatistics([notice], [feedback('正确', start), feedback('误报', '2026-10-20T11:00:00Z')], '2026-10-20T12:00:00Z').cells[0]!;
  assert.equal(cell.correct, 0); assert.equal(cell.falsePositive, 1); assert.equal(cell.responded, 1);
});
