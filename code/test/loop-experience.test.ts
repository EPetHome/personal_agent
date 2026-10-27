import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { event } from '../src/core/events.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { pi } from '../src/sources/pi/index.ts';
import { loopSummary, piHeader, piMessage, put, sandbox } from './fixtures.ts';
import { hash } from '../src/core/utils.ts';

const now = '2026-10-20T10:40:00.000Z', old = '2026-10-20T10:00:00.000Z', recent = '2026-10-20T10:35:00.000Z';
const id = '00000000-0000-4000-8000-000000000123';
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.sources.cc = null; f.config.sources.pi = join(f.root, 'pi'); f.config.sources.loop = join(f.root, '.pi-autoreview');
  f.config.learning = false;
  const summary = join(f.config.sources.loop, 'shop', `${id}.md`);
  await put(summary, loopSummary('进行中', '/demo/shop', '- A10. [人工] 操作：不要拿这条当成当前步骤', old)
    .replace('loop-demo', id).replace('- 状态：', '- 批次：商品缓存\n- 状态：'));
  await utimes(summary, new Date(old), new Date(old));
  return { ...f, summary };
}
function rows(sessionId: string, at: string, cwd = '/demo/shop') {
  return [{ ...piHeader(), id: sessionId, cwd, timestamp: old },
    piMessage('u', null, 'user', '提示词：商品缓存（闭环 1）', old),
    piMessage('a', 'u', 'assistant', [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: '构造验证' } }], at, { stopReason: 'toolUse' })];
}

for (const role of ['development', 'review', 'acceptance'] as const) test(`飞书 A7：loop 总结40分钟前，${role} 5分钟前写记录，不报停滞`, async t => {
  const f = await fixture(t);
  const sessionId = role === 'development' ? id : `autoreview-${role === 'review' ? 'rev' : 'acc'}-${id}`;
  await put(join(f.config.sources.pi!, 'session.jsonl'), rows(sessionId, recent));
  const view = await detect(f.config, now), run = view.records.find(r => r.tool === 'loop')!;
  assert.equal(run.status, '进行中'); assert.equal(run.lastActivityAt, recent);
  assert.equal(run.loop?.phase, role === 'development' ? '开发' : role === 'review' ? '评审第 4 轮' : '验收');
  assert.ok(!(await readOutbox(f.config.dataDir)).some(n => n.kind === 'stalled' && n.tool === 'loop'));
  if (role !== 'development') assert.ok(!view.records.some(r => r.tool === 'pi'));
  assert.equal((await rebuild(f.config, now)).records.find(r => r.tool === 'loop')?.lastActivityAt, recent);
});

test('飞书 A8：loop 所有关联会话40分钟前没动静，提醒当前评审步骤，不拿验收条款当进度', async t => {
  const f = await fixture(t);
  // 一轮开始以后评审写了一次，此后40分钟没有更新；总结中的完成轮数仍是3。
  await put(f.summary, (loopSummary('进行中', '/demo/shop', '- A10. [人工] 操作：不要拿这条当成当前步骤', '2026-10-20T09:59:00Z')).replace('loop-demo', id).replace('- 状态：', '- 批次：商品缓存\n- 状态：'));
  await utimes(f.summary, new Date('2026-10-20T09:59:30Z'), new Date('2026-10-20T09:59:30Z'));
  await put(join(f.config.sources.pi!, 'review.jsonl'), rows(`autoreview-rev-${id}`, old));
  const view = await detect(f.config, now);
  assert.equal(view.records.find(r => r.tool === 'loop')?.status, '停滞');
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.tool === 'loop' && n.kind === 'stalled')!;
  assert.ok(notice); assert.match(notice.content.summary, /最后在做.*评审第 4 轮/);
  assert.doesNotMatch(notice.content.summary, /A10|不要拿这条/);
});

test('评审结束写成总结后的旧记录不误当下一轮，返修中显示开发，已通过显示验收', async t => {
  for (const conclusion of ['需返修', '通过']) {
    const f = await fixture(t);
    await put(f.summary, loopSummary('进行中', '/demo/shop', '- 无', '2026-10-20T09:59:00Z').replace('loop-demo', id).replace(/\n- 无\n$/, `\n结论：${conclusion}\n- 无\n`));
    await utimes(f.summary, new Date('2026-10-20T10:00:30Z'), new Date('2026-10-20T10:00:30Z'));
    await put(join(f.config.sources.pi!, 'review.jsonl'), rows(`autoreview-rev-${id}`, old));
    const view = await detect(f.config, now), record = view.records.find(r => r.tool === 'loop')!;
    assert.equal(record.lastActivityAt, old);
    assert.equal(record.loop?.phase, conclusion === '需返修' ? '开发' : '验收');
    assert.doesNotMatch((await readOutbox(f.config.dataDir)).find(n => n.tool === 'loop')!.content.summary, /评审第 4 轮/);
  }
});

test('飞书 A9：流水线普通UUID会话及其报信/旧缓存都不入总览、不判断、不提醒', async t => {
  const f = await fixture(t); f.config.sources.loop = null;
  const sessionId = 'ordinary-uuid-not-autoreview', project = join(f.root, '.pi-autoreview/pipelines/某批/e2e/r1');
  const transcript = join(f.config.sources.pi!, 'pipeline.jsonl');
  const content = rows(sessionId, old, project); await put(transcript, content);
  const cached = pi.parse(content.map(row => JSON.stringify(row)).join('\n'), { path: transcript, fingerprint: 'old' })!;
  await put(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'session_observed', record: cached }, old)]);
  await put(join(f.config.inboxDir!, 'pi.jsonl'), [{ tool: 'pi', event: 'waiting_permission', session_id: sessionId, cwd: project, transcript_path: transcript, at: recent, detail: '构造内部授权' }]);
  f.config.judge = { executable: '/test-only/no-model', model: 'fake', timeoutMs: 100, dailyLimit: 10 };
  let calls = 0;
  const view = await detect(f.config, now, { judge: { async judge() { calls++; return { answer: '是', reason: '不应调用' }; } } });
  assert.equal(calls, 0); assert.deepEqual(view.records, []); assert.deepEqual((await overview(f.config, now)).records, []);
  assert.deepEqual(await readOutbox(f.config.dataDir), []);
  assert.equal(view.projection.health.get('pi')?.fileStats?.total, 0);
  assert.ok(!(await readEvents(f.config.dataDir)).some(e => e.kind === 'model_call_started' || e.kind === 'push_observed'));
});

test('loop 新增批名/步骤/关联会话不改变旧版去重键，不重复交代完成总结', async t => {
  const f = await fixture(t);
  const text = loopSummary('完成', '/demo/shop', '- 无', old).replace('loop-demo', id);
  await put(f.summary, text);
  const first = await detect(f.config, now), record = first.records[0]!;
  const legacyFacts = { status: '完成', conclusion: '完成', reviews: 3, repairs: 2, needs: [], needsProvided: true };
  const notice = (await readOutbox(f.config.dataDir))[0]!;
  assert.equal(notice.dedupeKey, `loop_completed:${record.key}:${hash(JSON.stringify(legacyFacts))}`);
  await put(f.summary, text.replace('- 状态：', '- 批次：补齐批名\n- 当前步骤：验收\n- 状态：'));
  assert.equal((await detect(f.config, '2026-10-20T10:41:00Z')).noticesAdded, 0);
});

test('排除流水线后的跳过统计换v2口径，不拿旧v1健康比例误报失明', async t => {
  const f = await fixture(t); f.config.sources.loop = null;
  await put(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'source_health', report: { source: 'pi', errors: [], paths: [f.config.sources.pi!], fileStats: { total: 30, skipped: 0 }, fileStatsProfile: 'exclude_internal_v1' } }, old)]);
  for (let i = 0; i < 5; i++) await put(join(f.config.sources.pi!, `normal-${i}.jsonl`), rows(`normal-${i}`, recent));
  for (let i = 0; i < 5; i++) await put(join(f.config.sources.pi!, `noise-${i}.jsonl`), [{ type: 'metadata' }]);
  for (let i = 0; i < 20; i++) await put(join(f.config.sources.pi!, `pipeline-${i}.jsonl`), rows(`pipeline-${i}`, recent, join(f.root, '.pi-autoreview/pipelines/batch/e2e/r1')));
  const view = await detect(f.config, now), health = view.projection.health.get('pi')!;
  assert.equal(health.fileStatsProfile, 'exclude_internal_v2'); assert.deepEqual(health.fileStats, { total: 10, skipped: 5 });
  assert.equal(health.skipBaseline, .5); assert.equal(health.since, null);
  assert.ok(!(await readOutbox(f.config.dataDir)).some(n => n.kind === 'blind'));
});
