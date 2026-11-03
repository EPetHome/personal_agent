// 旧库显式封存/恢复能力仍可用；常规启动和检测不再自动迁移或封存旧文件。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { event, packProjection, project } from '../src/core/events.ts';
import { prepareEventLog, restoreEventLog } from '../src/core/event-archive.ts';
import type { ArchiveStage } from '../src/core/event-archive.ts';
import { sessionDelta, applySessionDelta } from '../src/core/session-delta.ts';
import { withStoreLock, readEvents } from '../src/core/store.ts';
import { acquireLock } from '../src/core/locks.ts';
import { cc } from '../src/sources/cc/index.ts';
import { ccUser, ccCall, put, sandbox, start } from './fixtures.ts';
const now = '2026-11-02T12:00:00.000Z', oldAt = '2026-10-01T12:00:00.000Z';
const recordOf = () => cc.parse([ccUser(), ccCall()].map(row => JSON.stringify(row)).join('\n'), { path: '/constructed/old.jsonl', fingerprint: 'fp' })!;
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const rows = [event({ kind: 'session_observed', record: recordOf() }, oldAt), event({ kind: 'scan_completed' }, oldAt), event({ kind: 'scan_completed' }, now)];
  const raw = rows.map(row => `  ${JSON.stringify(row)}\r\n`).join(''); await put(join(f.config.dataDir, 'events.jsonl'), raw);
  await put(join(f.config.dataDir, 'outbox.jsonl'), ''); await put(join(f.config.dataDir, 'feedback.jsonl'), '');
  const prepare = (onStage?: (stage: ArchiveStage) => Promise<void>) => withStoreLock(f.config.dataDir, () => prepareEventLog(f.config.dataDir, now, { onStage }));
  return { ...f, rows, raw, prepare };
}
test('差量兼容：数组缩短、字段删除、成员变化可重放，坏基底/原型路径拒绝', () => {
  const initial = recordOf(), before = structuredClone(initial), expanded = { ...initial, intent: { ...initial.intent, additions: ['甲', '乙'] }, humanRequestRefs: [{ index: 0, at: start }] };
  const delta = sessionDelta(initial, expanded)!; assert.deepEqual(applySessionDelta(initial, delta), expanded); assert.deepEqual(initial, before);
  assert.deepEqual(applySessionDelta(expanded, sessionDelta(expanded, initial)!), initial); assert.equal(sessionDelta(initial, structuredClone(initial)), null);
  assert.throws(() => applySessionDelta(undefined, delta), /基底/); assert.throws(() => applySessionDelta(initial, { ...delta, changes: [{ path: ['__proto__', 'polluted'], value: true }] }), /损坏/);
});
test('旧差量格式：1000步和10步各追加一次，不重新复制完整会话', () => {
  const sizes = [];
  for (const n of [10, 1000]) { const record = recordOf(); record.intent.additions = Array.from({ length: n }, () => '构造要求');
    const next = structuredClone(record); next.intent.additions.push('追加要求'); const delta = sessionDelta(record, next)!;
    assert.deepEqual(applySessionDelta(record, delta), next); sizes.push(JSON.stringify(delta).length); }
  assert.ok(Math.max(...sizes) / Math.min(...sizes) <= 2);
});
test('显式旧库封存：逐字gzip、完整备份、检查点重放、恢复和重试不重复', async t => {
  const f = await fixture(t); await put(join(f.config.dataDir, 'nested/old.txt'), '构造原件\r\n');
  const rows = await f.prepare(), checkpoint = rows[0]!; assert.equal(checkpoint.kind, 'store_checkpoint'); if (checkpoint.kind !== 'store_checkpoint') throw new Error('无检查点');
  assert.deepEqual(packProjection(project(rows)), packProjection(project(f.rows)));
  const archived = gunzipSync(await readFile(join(f.config.dataDir, 'archives', checkpoint.archive))).toString('utf8'); assert.equal(archived, f.raw.split(/(?<=\n)/).slice(0, 2).join(''));
  const backup = rows.find(row => row.kind === 'store_format')!; assert.ok(backup.kind === 'store_format' && backup.backup);
  assert.equal(await readFile(join(backup.backup!, 'events.jsonl'), 'utf8'), f.raw); assert.equal(await readFile(join(backup.backup!, 'nested/old.txt'), 'utf8'), '构造原件\r\n');
  const restored = join(f.root, 'restored.jsonl'); await withStoreLock(f.config.dataDir, () => restoreEventLog(f.config.dataDir, restored)); assert.ok((await readFile(restored, 'utf8')).startsWith(f.raw));
  await f.prepare(); assert.equal((await readdir(f.config.dataDir + '/archives')).length, 1);
});
for (const stage of ['migration_synced', 'migration_published', 'archive_synced', 'archive_published', 'log_synced', 'log_replaced'] as const)
  test(`显式封存中断：${stage}保留事实，重试恢复完整原件`, async t => {
    const f = await fixture(t); await assert.rejects(f.prepare(async point => { if (point === stage) throw new Error('构造中断'); }), /构造中断/);
    assert.deepEqual(packProjection(project(await readEvents(f.config.dataDir))), packProjection(project(f.rows)));
    await f.prepare(); const output = join(f.root, 'recovered.jsonl'); await restoreEventLog(f.config.dataDir, output); assert.ok((await readFile(output, 'utf8')).startsWith(f.raw));
  });
test('显式迁移仍不绕过活跃反馈锁；拒绝时原日志不改', async t => {
  const f = await fixture(t), release = await acquireLock(f.config.dataDir, '.feedback.lock');
  try { await assert.rejects(f.prepare(), /锁|正在/); assert.equal(await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8'), f.raw); }
  finally { await release(); }
  await f.prepare();
});
test('显式恢复损坏归档拒绝，不保留半份输出、不改活动日志', async t => {
  const f = await fixture(t), rows = await f.prepare(), checkpoint = rows[0]!; assert.ok(checkpoint.kind === 'store_checkpoint');
  await writeFile(join(f.config.dataDir, 'archives', checkpoint.archive), 'broken'); const path = join(f.config.dataDir, 'events.jsonl'), before = await readFile(path);
  const output = join(f.root, 'invalid-output'); await assert.rejects(restoreEventLog(f.config.dataDir, output));
  await assert.rejects(readFile(output), /ENOENT/); assert.deepEqual(await readFile(path), before);
});
