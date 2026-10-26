import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, loopSummary, piHeader, piMessage, put, pushed, sandbox, start } from './fixtures.ts';

const uuid = '11111111-1111-4111-8111-111111111111';
async function fixture(t: TestContext) {
  const f = await sandbox();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  return { ...f, transcript: join(f.config.sources.cc!, 'session.jsonl') };
}

test('回放：有效的无身份/无消息文件只跳过计数，不作文件失败，也不凭其推送判来源失明', async t => {
  const f = await fixture(t);
  f.config.sources.codex = join(f.root, 'codex');
  f.config.sources.pi = join(f.root, 'pi');
  const { sessionId, cwd, ...noIdentity } = ccAnswer();
  await put(f.transcript, [noIdentity]);
  await put(join(f.config.sources.cc!, 'values.jsonl'), [null, 42, '非会话产物', [ccUser(), ccAnswer()]]);
  await put(join(f.config.sources.cc!, 'metadata.jsonl'), [{ type: 'ai-title', sessionId: 'empty-cc', cwd: '/sample/project', timestamp: start }]);
  await put(join(f.config.sources.codex, 'no-id.jsonl'), [codexEvent({ type: 'task_complete' })]);
  const emptyCodex = join(f.config.sources.codex, 'empty.jsonl');
  await put(emptyCodex, [codexMeta(), { type: 'world_state', payload: { ignored: true } }]);
  await put(join(f.config.sources.pi, 'no-id.jsonl'), [piMessage('a', null, 'user', '没有身份')]);
  await put(join(f.config.sources.pi, 'empty.jsonl'), [piHeader(), { type: 'model_change', id: 'a', parentId: null, timestamp: start }]);
  await put(join(f.config.sources.pi, 'v1.jsonl'), [{ type: 'header', version: 1, cwd: '/sample/pi' }]);
  await put(join(f.config.inboxDir!, 'codex.jsonl'), [{ tool: 'codex', event: 'session_end', session_id: 'demo-codex', cwd: '/sample/codex', transcript_path: emptyCodex, at: start }]);
  const view = await detect(f.config, '2026-10-20T10:31:00Z');
  assert.equal(view.records.length, 0);
  assert.equal(view.noticesAdded, 0);
  for (const [source, total] of [['cc', 3], ['codex', 2], ['pi', 3]] as const) {
    const health = view.projection.health.get(source)!;
    assert.equal(health.since, null);
    assert.equal(health.fileFailures, undefined);
    assert.deepEqual(health.fileStats, { total, skipped: total });
  }
  assert.equal(view.projection.pushes.length, 0);
  assert.equal((await detect(f.config, '2026-10-20T10:35:00Z')).noticesAdded, 0);
});

test('回放：截断 JSON 无法证明是非会话，仍保留真正坏文件提醒', async t => {
  const f = await fixture(t);
  await put(f.transcript, [ccUser(), ccAnswer()]);
  await put(join(f.config.sources.cc!, 'bad.jsonl'), '{"type":"user","sessionId":\n');
  await put(join(f.config.sources.cc!, 'not-session.jsonl'), [{ type: 'metadata' }]);
  const view = await detect(f.config, '2026-10-20T10:31:00Z');
  assert.equal(view.records[0]?.status, '已完成');
  assert.equal(view.projection.health.get('cc')?.fileFailures?.count, 1);
  assert.deepEqual(view.projection.health.get('cc')?.fileStats, { total: 3, skipped: 1 });
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
});

test('回放：曾有未完成子任务后来只剩元数据，跳过不等于子任务完成', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.codex = join(f.root, 'codex');
  await put(join(f.config.sources.codex, 'parent.jsonl'), [codexMeta(), codexEvent({ type: 'task_complete' })]);
  const child = join(f.config.sources.codex, 'child.jsonl');
  await put(child, [codexMeta('child', 'demo-codex'), codexEvent({ type: 'function_call', call_id: 'a', name: 'shell', arguments: '{"cmd":"npm test"}' }, 'response_item')]);
  assert.equal((await detect(f.config, '2026-10-20T10:01:00Z')).records[0]?.status, '进行中');
  await put(child, [codexMeta('child', 'demo-codex')]);
  const view = await detect(f.config, '2026-10-20T10:02:00Z');
  assert.equal(view.records[0]?.status, '进行中');
  assert.equal(view.records[0]?.members?.find(m => m.sessionId === 'child')?.unavailable, true);
  assert.equal(view.noticesAdded, 0);
  assert.equal(view.projection.health.get('codex')?.fileFailures, undefined);
  assert.deepEqual(view.projection.health.get('codex')?.fileStats, { total: 2, skipped: 1 });
  assert.deepEqual((await rebuild(f.config)).records, view.records);
});

test('回放：跳过率首轮只建基线，稳定不报；明显上升才报来源失明，恢复可解除', async t => {
  const f = await fixture(t);
  const rows = (i: number) => [ccUser(), ccAnswer()].map(row => ({ ...row, sessionId: `id-${i}` }));
  for (let i = 0; i < 20; i++) await put(join(f.config.sources.cc!, `${i}.jsonl`), rows(i));
  assert.equal((await detect(f.config, '2026-10-20T10:31:00Z')).noticesAdded, 0);
  for (let i = 0; i < 10; i++) await put(join(f.config.sources.cc!, `${i}.jsonl`), [{ type: 'metadata' }]);
  const spike = await detect(f.config, '2026-10-20T10:32:00Z');
  assert.ok(spike.projection.health.get('cc')?.since);
  assert.match(spike.projection.health.get('cc')!.errors.join('\n'), /跳过比例/);
  assert.deepEqual(spike.projection.health.get('cc')?.fileStats, { total: 20, skipped: 10 });
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
  assert.equal((await detect(f.config, '2026-10-20T10:33:00Z')).noticesAdded, 0);
  for (let i = 0; i < 10; i++) await put(join(f.config.sources.cc!, `${i}.jsonl`), rows(i));
  assert.equal((await detect(f.config, '2026-10-20T10:34:00Z')).projection.health.get('cc')?.since, null);
  const clean = { ...f.config, dataDir: join(f.root, 'new-baseline') };
  for (let i = 0; i < 10; i++) await put(join(f.config.sources.cc!, `${i}.jsonl`), [{ type: 'metadata' }]);
  assert.equal((await detect(clean, '2026-10-20T10:35:00Z')).noticesAdded, 0);
  assert.equal((await detect(clean, '2026-10-20T10:36:00Z')).noticesAdded, 0);
});

for (const [zone, local, expected] of [
  ['America/New_York', '2026-10-20 06:00:00', '2026-10-20T10:00:00.000Z'],
  ['America/New_York', '2026-01-20 06:00:00', '2026-01-20T11:00:00.000Z'],
  ['Asia/Tokyo', '2026-10-20 06:00:00', '2026-10-19T21:00:00.000Z'],
]) {
  test(`回放：loop ${zone} 当地轮次 ${local} 转成真实 UTC`, async t => {
    const f = await fixture(t);
    f.config.sources.cc = null;
    f.config.sources.loop = join(f.root, 'loop');
    await put(join(f.config.sources.loop, 'project', `${uuid}.md`), loopSummary().replace(/### 第 1 轮（[^，]+/, `### 第 1 轮（${local}`));
    const oldZone = process.env.TZ;
    process.env.TZ = zone;
    try { assert.equal((await detect(f.config, expected)).records[0]?.lastActivityAt, expected); }
    finally { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
  });
}

test('回放：loop 无轮次时间时使用原件 mtime，不报失明，重复检测不新增交代', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.loop = join(f.root, 'loop');
  const file = join(f.config.sources.loop, 'project', `${uuid}.md`);
  await put(file, loopSummary().replace(/^### 第 1 轮.*\n/m, ''));
  await utimes(file, new Date(start), new Date(start));
  const view = await detect(f.config, '2026-10-20T10:31:00Z');
  assert.equal(view.records[0]?.lastActivityAt, start);
  assert.equal(view.projection.health.get('loop')?.since, null);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['loop_completed']);
  assert.equal((await detect(f.config, '2026-10-20T10:32:00Z')).noticesAdded, 0);
});

test('回放：首次历史等待永久不补发，但有新等待证据仍能提醒，删除状态重建不改变抑制', async t => {
  const f = await fixture(t);
  const old = '2026-10-20T07:00:00Z';
  await put(f.transcript, [ccUser('旧任务', old), ccCall(old)]);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.transcript, 'waiting_permission', '2026-10-20T07:00:01Z')]);
  const first = await detect(f.config, '2026-10-20T10:00:00Z');
  assert.equal(first.records[0]?.status, '在等我');
  assert.equal(first.noticesAdded, 0);
  assert.match(first.records[0]?.notice ?? '', /不补发/);
  const count = (await readEvents(f.config.dataDir)).length;
  assert.equal((await detect(f.config, '2026-10-20T10:10:00Z')).noticesAdded, 0);
  assert.equal((await readEvents(f.config.dataDir)).length - count, 1);
  await rm(join(f.config.dataDir, 'state.json'));
  assert.equal((await rebuild(f.config)).records[0]?.status, '在等我');
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.transcript, 'waiting_permission', '2026-10-20T10:11:00Z')]);
  assert.equal((await detect(f.config, '2026-10-20T10:12:00Z')).noticesAdded, 1);
  assert.equal((await readOutbox(f.config.dataDir))[0]?.kind, 'waiting');
});

for (const seconds of [3599, 3600, 3601]) {
  test(`回放：首次提醒一小时边界 ${seconds} 秒，边界内照常、边界外只总览`, async t => {
    const f = await fixture(t);
    const now = '2026-10-20T10:00:00Z';
    const at = new Date(Date.parse(now) - seconds * 1000).toISOString();
    await put(f.transcript, [ccUser('边界任务', at), ccCall(at)]);
    await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.transcript, 'waiting_permission', at)]);
    assert.equal((await detect(f.config, now)).noticesAdded, seconds <= 3600 ? 1 : 0);
    assert.equal((await overview(f.config)).records[0]?.status, '在等我');
  });
}

test('回放：24小时以上未结束（含等待）只搁置；恰好24小时仍停滞；旧完成不降级', async t => {
  const f = await fixture(t);
  const now = '2026-10-21T10:00:00Z';
  for (const [id, at, done] of [['over', '2026-10-20T09:59:59Z', false], ['edge', '2026-10-20T10:00:00Z', false], ['done', '2026-10-19T10:00:00Z', true]]) {
    await put(join(f.config.sources.cc!, `${id}.jsonl`), [ccUser('构造任务', String(at)), done ? ccAnswer(String(at)) : ccCall(String(at))].map(row => ({ ...row, sessionId: id })));
  }
  const waiting = join(f.config.sources.cc!, 'waiting.jsonl');
  await put(waiting, [ccUser('旧等待', '2026-10-20T09:00:00Z'), ccCall('2026-10-20T09:00:00Z')].map(row => ({ ...row, sessionId: 'waiting' })));
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [{ ...pushed(waiting, 'waiting_permission', '2026-10-20T09:00:01Z'), session_id: 'waiting' }]);
  const view = await detect(f.config, now);
  assert.deepEqual(Object.fromEntries(view.records.map(r => [r.sessionId, r.status])), { done: '已完成', edge: '停滞', over: '已搁置', waiting: '已搁置' });
  assert.equal(view.noticesAdded, 0);
  assert.deepEqual((await rebuild(f.config)).records, view.records);
});

test('回放：流块边界上的 UTF-8 表情不被截断，CRLF 原件指纹仍精确', async t => {
  const f = await fixture(t);
  const row = { ...ccUser('😀跨块要求'), padding: '' };
  // 把 padding 放在 message 前，令表情首字节恰落在 64KB 块的最后一字节。
  const build = (padding: string) => JSON.stringify({ type: row.type, sessionId: row.sessionId, cwd: row.cwd, timestamp: row.timestamp, origin: row.origin, padding, message: row.message });
  const prefix = build('');
  const beforeEmoji = Buffer.byteLength(prefix.slice(0, prefix.indexOf('😀')));
  const line = build('x'.repeat(65535 - beforeEmoji));
  const text = `${line}\r\n${JSON.stringify(ccAnswer())}\r\n`;
  await put(f.transcript, text);
  const view = await detect(f.config, '2026-10-20T10:31:00Z');
  assert.equal(view.records[0]?.intent.initial, '😀跨块要求');
  assert.equal(view.records[0]?.originals[0]?.fingerprint, createHash('sha256').update(text).digest('hex'));
});

test('回放：首次未发送的旧 loop 交代，有新轮次时间后可以正常提醒', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.loop = join(f.root, 'loop');
  const file = join(f.config.sources.loop, 'project', `${uuid}.md`);
  await put(file, loopSummary('暂停（需要决定）'));
  assert.equal((await detect(f.config, '2026-10-20T13:00:00Z')).noticesAdded, 0);
  await put(file, loopSummary('暂停（需要决定）', '/sample/real-project', '- A2 需人工确认文案', '2026-10-20T12:55:00Z'));
  assert.equal((await detect(f.config, '2026-10-20T13:01:00Z')).noticesAdded, 1);
  assert.equal((await readOutbox(f.config.dataDir))[0]?.kind, 'loop_paused');
  assert.equal((await detect(f.config, '2026-10-20T13:02:00Z')).noticesAdded, 0);
});

test('回放：旧停滞未提醒不占终身一次额度，新活动后再次停滞可以提醒', async t => {
  const f = await fixture(t);
  await put(f.transcript, [ccUser(), ccCall()]);
  assert.equal((await detect(f.config, '2026-10-20T13:00:00Z')).noticesAdded, 0);
  await put(f.transcript, [ccUser(), ccCall(), ccUser('现在继续', '2026-10-20T13:01:00Z'), ccCall('2026-10-20T13:01:00Z', 'new-call')]);
  assert.equal((await detect(f.config, '2026-10-20T13:02:00Z')).noticesAdded, 0);
  assert.equal((await detect(f.config, '2026-10-20T13:32:00Z')).noticesAdded, 1);
  assert.equal((await readOutbox(f.config.dataDir))[0]?.kind, 'stalled');
});

test('回放：大 JSONL 在64MB堆内逐行读，禁止整份 readFile，SHA覆盖完整文件', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.codex = join(f.root, 'codex');
  await mkdir(f.config.sources.codex);
  const source = join(f.config.sources.codex, 'large.jsonl');
  const handle = await open(source, 'wx');
  const digest = createHash('sha256');
  const write = async (line: string) => { await handle.writeFile(line); digest.update(line); };
  try {
    await write(JSON.stringify(codexMeta('large')) + '\n');
    await write(JSON.stringify(codexEvent({ type: 'item_completed', item: { type: 'UserMessage', content: '构造的大文件任务' } })) + '\n');
    const noise = JSON.stringify({ type: 'world_state', payload: { ignored: 'x'.repeat(64 * 1024) } }) + '\n';
    for (let i = 0; i < 1536; i++) await write(noise);
    await write(JSON.stringify(codexEvent({ type: 'task_complete' })) + '\n');
  } finally { await handle.close(); }
  const script = join(f.root, 'stream-check.mjs');
  const validHeader = JSON.stringify(codexMeta('large')) + '\n';
  const invalidHeader = validHeader.replace('"cwd":', '"xxx":');
  assert.equal(Buffer.byteLength(invalidHeader), Buffer.byteLength(validHeader));
  await put(script, `import {open,appendFile} from 'node:fs/promises';
const h=await open(${JSON.stringify(source)},'r'); const proto=Object.getPrototypeOf(h); await h.close();
const readFile=proto.readFile; proto.readFile=async function(...args){if((await this.stat()).size>2*1024*1024)throw Error('测试禁止整份读取大文件');return readFile.apply(this,args)};
const {detect}=await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/core/agent.ts')).href)});
const v=await detect(${JSON.stringify(f.config)},'2026-10-20T10:31:00Z');
const changed=await open(${JSON.stringify(source)},'r+'); await changed.write(${JSON.stringify(invalidHeader)},0,'utf8'); await changed.close();
await appendFile(${JSON.stringify(source)},'{"truncated":\\n');
const bad=await detect(${JSON.stringify({ ...f.config, dataDir: `${f.config.dataDir}-bad` })},'2026-10-20T10:32:00Z');
console.log(JSON.stringify({records:v.records,health:[...v.projection.health.values()],badRecords:bad.records,badHealth:[...bad.projection.health.values()]}));`);
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', script], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: f.root } });
  assert.equal(result.status, 0, result.stderr);
  const view = JSON.parse(result.stdout);
  assert.equal(view.records[0]?.status, '已完成');
  assert.equal(view.records[0]?.intent.initial, '构造的大文件任务');
  assert.equal(view.records[0]?.originals[0]?.fingerprint, digest.digest('hex'));
  assert.ok(view.health.every((h: { errors: unknown[] }) => !h.errors.length));
  assert.deepEqual(view.badRecords, []);
  assert.deepEqual(view.badHealth.find((h: { source: string }) => h.source === 'codex')?.fileStats, { total: 1, skipped: 0 });
  assert.equal(view.badHealth.find((h: { source: string }) => h.source === 'codex')?.fileFailures?.count, 1);
});
