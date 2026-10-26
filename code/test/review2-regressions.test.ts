import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { event, project } from '../src/core/events.ts';
import { findPushTarget } from '../src/core/sessions.ts';
import { codex } from '../src/sources/codex/index.ts';
import { codexEvent, codexMeta, put, sandbox, start } from './fixtures.ts';

const broken = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n{"broken":\n';
async function fixture(t: TestContext) {
  const f = await sandbox();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.sources.cc = null;
  f.config.sources.codex = join(f.root, 'codex');
  const child = join(f.config.sources.codex, 'child.jsonl');
  const inbox = join(f.config.inboxDir!, 'codex.jsonl');
  await put(join(f.config.sources.codex, 'parent.jsonl'), [codexMeta(),
    codexEvent({ type: 'user_message', message: '构造的父任务' }), codexEvent({ type: 'task_complete' })]);
  await put(join(f.config.sources.codex, 'other.jsonl'), [codexMeta('other'), codexEvent({ type: 'task_complete' })]);
  const call = codexEvent({ type: 'function_call', call_id: 'child-call', name: 'shell', arguments: '{"command":"npm test"}' }, 'response_item', '2026-10-20T10:15:00Z');
  const push = (event = 'session_end', at = '2026-10-20T10:16:00Z', sessionId = 'child', path = child) => ({
    tool: 'codex', event, session_id: sessionId, cwd: '/sample/codex', transcript_path: path, at, detail: '构造的推送',
  });
  return { ...f, child, inbox, call, push };
}

for (const prefix of ['metadata-only', 'pending-call', 'completed-prefix']) {
  test(`本批第2次返修：首次子文件 ${prefix} 后末行损坏，不借前缀判完成/等待，重复/重建/恢复正确`, async t => {
    const f = await fixture(t);
    const rows = [codexMeta('child', 'demo-codex'),
      ...(prefix === 'pending-call' ? [f.call] : prefix === 'completed-prefix' ? [codexEvent({ type: 'task_complete' })] : [])];
    await put(f.child, broken(rows));
    await put(f.inbox, [f.push(), f.push('waiting_permission')]);
    const first = await detect(f.config, '2026-10-20T10:20:00Z');
    const parent = first.records.find(r => r.sessionId === 'demo-codex')!;
    assert.equal(first.records.length, 2, '失败子成员不能单独占一行');
    assert.equal(parent.status, '进行中');
    assert.equal(first.records.find(r => r.sessionId === 'other')?.status, '已完成');
    assert.equal(first.projection.health.get('codex')?.since, null);
    assert.equal(first.projection.health.get('codex')?.fileFailures?.count, 1);
    const member = parent.members!.find(m => m.sessionId === 'child')!;
    assert.equal(member.unavailable, true);
    assert.equal(member.parentSessionId, 'demo-codex');
    assert.equal(member.project, '/sample/codex');
    assert.equal(member.lastActivityAt, null, '身份线索不能捏造活动时间');
    assert.deepEqual(member.pendingTools, [], '损坏正文的调用前缀不当作正常事实');
    assert.deepEqual(member.recentSteps, []);
    assert.equal(member.assistantFinished, false);
    assert.equal(parent.lastActivityAt, start);
    assert.match(parent.reason, /本轮读不了/);
    assert.equal(first.projection.pushes.length, 0);
    const events = await readEvents(f.config.dataDir);
    assert.equal(events.filter(e => e.kind === 'push_validated').length, 0);
    const raw = events.find(e => e.kind === 'push_observed')!;
    assert.equal(raw.kind, 'push_observed');
    if (raw.kind === 'push_observed') {
      assert.equal(findPushTarget([parent], raw.push, true), undefined);
      assert.equal(project([...events, event({ kind: 'push_validated', pushId: raw.id, recordKey: parent.key }, first.at)]).pushes.length, 0);
    }
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
    const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
    const eventCount = (await readEvents(f.config.dataDir)).length;
    assert.equal((await detect(f.config, '2026-10-20T10:40:00Z')).noticesAdded, 0);
    assert.equal((await readEvents(f.config.dataDir)).length - eventCount, 1);
    const second = await overview(f.config);
    assert.equal(second.records.find(r => r.sessionId === 'demo-codex')?.status, '进行中');
    await rm(join(f.config.dataDir, 'state.json'));
    assert.deepEqual((await rebuild(f.config)).records, second.records);
    assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(before));
    for (const file of ['events.jsonl', 'outbox.jsonl', 'feedback.jsonl', 'state.json']) {
      for (const line of (await readFile(join(f.config.dataDir, file), 'utf8')).split('\n').filter(Boolean)) JSON.parse(line);
    }
    await put(f.child, [codexMeta('child', 'demo-codex'), codexEvent({ type: 'task_complete' }, 'event_msg', '2026-10-20T10:50:00Z')]);
    const recovered = await detect(f.config, '2026-10-20T10:51:00Z');
    assert.equal(recovered.records.find(r => r.sessionId === 'demo-codex')?.status, '已完成');
    assert.ok(recovered.records.find(r => r.sessionId === 'demo-codex')!.members!.every(m => !m.unavailable));
    assert.equal(recovered.records.find(r => r.sessionId === 'other')?.status, '已完成');
    assert.equal(recovered.noticesAdded, 0);
    assert.deepEqual((await rebuild(f.config)).records, recovered.records);
  });
}

test('本批第2次返修：失败正文仍有身份且有历史授权等待时，不丢历史事实，也不信新结束推送', async t => {
  const f = await fixture(t);
  await put(f.child, [codexMeta('child', 'demo-codex'), f.call]);
  await put(f.inbox, [f.push('waiting_permission')]);
  const first = await detect(f.config, '2026-10-20T10:20:00Z');
  const oldMember = first.records.find(r => r.sessionId === 'demo-codex')!.members!.find(m => m.sessionId === 'child')!;
  assert.equal(first.records.find(r => r.sessionId === 'demo-codex')?.status, '在等我');
  await put(f.child, broken([codexMeta('child', 'demo-codex'), f.call]));
  await put(f.inbox, [f.push('waiting_permission'), f.push('session_end', '2026-10-20T10:21:00Z')]);
  const second = await detect(f.config, '2026-10-20T10:22:00Z');
  const parent = second.records.find(r => r.sessionId === 'demo-codex')!;
  const member = parent.members!.find(m => m.sessionId === 'child')!;
  assert.equal(parent.status, '在等我');
  assert.equal(member.unavailable, true);
  assert.equal(member.lastActivityAt, oldMember.lastActivityAt);
  assert.deepEqual(member.pendingTools, oldMember.pendingTools);
  assert.deepEqual(member.originals, oldMember.originals);
  assert.equal(second.projection.pushes.length, 1);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_validated').length, 1);
  assert.equal(second.records.find(r => r.sessionId === 'other')?.status, '已完成');
  assert.deepEqual((await rebuild(f.config)).records, second.records);
});

test('本批第2次返修：首次读取失败的中间子文件仍能关联孙成员，但不据此给新推送对账', async t => {
  const f = await fixture(t);
  await put(f.child, broken([codexMeta('child', 'demo-codex'), f.call]));
  const grandchild = join(f.config.sources.codex!, 'grandchild.jsonl');
  await put(grandchild, [codexMeta('grandchild', 'child'), codexEvent({ type: 'task_complete' })]);
  await put(f.inbox, [f.push('session_end', '2026-10-20T10:16:00Z', 'grandchild', grandchild)]);
  const first = await detect(f.config, '2026-10-20T10:20:00Z');
  const parent = first.records.find(r => r.sessionId === 'demo-codex')!;
  assert.equal(parent.status, '进行中');
  assert.deepEqual(parent.members!.map(m => m.sessionId).sort(), ['child', 'demo-codex', 'grandchild']);
  assert.ok(parent.members!.filter(m => m.sessionId !== 'demo-codex').every(m => m.unavailable));
  assert.equal(first.records.find(r => r.sessionId === 'other')?.status, '已完成');
  assert.equal(first.projection.health.get('codex')?.since, null);
  assert.equal(first.projection.pushes.length, 0);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
  assert.deepEqual((await rebuild(f.config)).records, first.records);
  await put(f.child, [codexMeta('child', 'demo-codex'), codexEvent({ type: 'task_complete' })]);
  assert.equal((await detect(f.config, '2026-10-20T10:21:00Z')).records.find(r => r.sessionId === 'demo-codex')?.status, '已完成');
});

for (const parentId of ['', 'missing', 'child']) {
  test(`本批第2次返修：失败身份的父标识 ${JSON.stringify(parentId)} 不能编造父任务或拖累无关根`, async t => {
    const f = await fixture(t);
    await put(f.child, broken([codexMeta('child', parentId), f.call]));
    await put(f.inbox, [f.push()]);
    const view = await detect(f.config, '2026-10-20T10:20:00Z');
    assert.deepEqual(view.records.map(r => r.status), ['已完成', '已完成']);
    assert.ok(view.records.every(r => !r.members));
    assert.equal(view.projection.pushes.length, 0);
    assert.equal(view.projection.health.get('codex')?.since, null);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
  });
}

test('本批第2次返修：可靠父子身份需非空标识和项目；非字符串父标识不能进入关联', () => {
  const invalidId = codexMeta('', 'demo-codex');
  const invalidCwd = codexMeta('child', 'demo-codex');
  invalidCwd.payload.cwd = '   ';
  assert.equal(codex.identify!(broken([invalidId])), null);
  assert.equal(codex.identify!(broken([invalidCwd])), null);
  const badParent = { ...codexMeta('child'), payload: { ...codexMeta('child').payload, parent_session_id: { bad: true } } };
  assert.equal(codex.identify!(broken([badParent]))?.parentSessionId, undefined);
});
