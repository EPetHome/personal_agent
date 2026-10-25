import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { ccCall, ccUser, codexEvent, codexMeta, later, pushed, put, sandbox } from './fixtures.ts';

async function family(t: TestContext) {
  const fixture = await sandbox();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  fixture.config.sources.cc = null;
  fixture.config.sources.codex = join(fixture.root, 'codex');
  const parent = join(fixture.config.sources.codex, 'parent.jsonl');
  const child = join(fixture.config.sources.codex, 'child.jsonl');
  const other = join(fixture.config.sources.codex, 'other.jsonl');
  await put(parent, [codexMeta(), codexEvent({ type: 'user_message', message: '父任务：检查接口' })]);
  await put(child, [codexMeta('child', 'demo-codex'), codexEvent({ type: 'user_message', message: '子代理系统任务' }),
    codexEvent({ type: 'function_call', name: 'shell', call_id: 'child-call', arguments: '{"command":"npm test"}' }, 'response_item')]);
  await put(other, [codexMeta('other'), codexEvent({ type: 'user_message', message: '另一个独立任务' })]);
  const push = (sessionId: string, path: string, event = 'waiting_permission', at = '2026-10-20T10:00:01Z') => ({
    tool: 'codex', event, session_id: sessionId, cwd: '/sample/codex', transcript_path: path, at, detail: '授权运行 npm test',
  });
  return { ...fixture, parent, child, other, push, inbox: join(fixture.config.inboxDir!, 'codex.jsonl') };
}

test('返修1：合法子会话授权推送归入父记录，其他 Codex 会话正常，重建和重复检测不误报/重复发', async t => {
  const f = await family(t);
  await put(f.inbox, [f.push('child', f.child)]);
  const view = await detect(f.config, '2026-10-20T10:01:00Z');
  assert.equal(view.records.length, 2);
  const parent = view.records.find(r => r.sessionId === 'demo-codex')!;
  assert.equal(parent.status, '在等我');
  assert.equal(parent.waiting?.sessionId, 'child');
  assert.deepEqual(parent.intent, { initial: '父任务：检查接口', additions: [] });
  assert.equal(view.records.find(r => r.sessionId === 'other')?.status, '进行中');
  assert.ok([...view.projection.health.values()].every(h => !h.since));
  const [notice] = await readOutbox(f.config.dataDir);
  assert.equal(notice?.kind, 'waiting');
  assert.equal(notice?.level, '现在就要你');
  assert.match(notice!.text, /子会话[\s\S]*npm test/);
  assert.equal(notice?.content.returnCommand, "'/sample tools/codex' resume child");
  await rm(join(f.config.dataDir, 'state.json'));
  const replay = await rebuild(f.config);
  assert.equal(replay.records.find(r => r.sessionId === 'demo-codex')?.status, '在等我');
  assert.equal((await detect(f.config, '2026-10-20T10:02:00Z')).noticesAdded, 0);
  assert.equal((await readOutbox(f.config.dataDir)).length, 1);
});

test('返修1：父会话和其他子会话继续活动/结束，不会掩盖仍停住等授权的那个子会话', async t => {
  const f = await family(t);
  const sibling = join(f.config.sources.codex!, 'sibling.jsonl');
  await put(sibling, [codexMeta('sibling', 'demo-codex'), codexEvent({ type: 'task_started' })]);
  await appendFile(f.parent, JSON.stringify(codexEvent({ type: 'agent_message', message: '父会话还在检查', phase: 'commentary' }, 'event_msg', '2026-10-20T10:02:00Z')) + '\n');
  await put(f.inbox, [f.push('child', f.child), f.push('sibling', sibling, 'session_end', '2026-10-20T10:03:00Z')]);
  const view = await detect(f.config, '2026-10-20T10:04:00Z');
  assert.equal(view.records.find(r => r.sessionId === 'demo-codex')?.status, '在等我');
  assert.equal(view.records.find(r => r.sessionId === 'other')?.status, '进行中');
  assert.equal((await readOutbox(f.config.dataDir))[0]?.kind, 'waiting');
  // 等授权的是 child；只有它自己后来有新动静，才解除这次等待。
  await appendFile(f.child, JSON.stringify(codexEvent({ type: 'function_call_output', call_id: 'child-call', output: 'ok' }, 'response_item', '2026-10-20T10:05:00Z')) + '\n');
  assert.equal((await detect(f.config, '2026-10-20T10:06:00Z')).records.find(r => r.sessionId === 'demo-codex')?.status, '进行中');
});

for (const ending of ['turn_end', 'session_end']) {
  test(`返修1：子会话 ${ending} 只结束自己的工作，不把仍在工作的父会话或其他 Codex 会话结束`, async t => {
    const f = await family(t);
    await put(f.inbox, [f.push('child', f.child), f.push('child', f.child, ending, '2026-10-20T10:01:00Z')]);
    const first = await detect(f.config, '2026-10-20T10:02:00Z');
    assert.equal(first.noticesAdded, 0);
    assert.equal(first.records.find(r => r.sessionId === 'demo-codex')?.status, '进行中');
    assert.equal(first.records.find(r => r.sessionId === 'other')?.status, '进行中');
    const stale = await detect(f.config, '2026-10-20T10:32:00Z');
    assert.equal(stale.records.find(r => r.sessionId === 'demo-codex')?.status, '停滞');
    assert.equal(stale.records.find(r => r.sessionId === 'other')?.status, '停滞');
    assert.ok((await readOutbox(f.config.dataDir)).every(n => n.kind === 'stalled'));
    await appendFile(f.parent, JSON.stringify(codexEvent({ type: 'task_complete' }, 'event_msg', '2026-10-20T10:33:00Z')) + '\n');
    assert.equal((await detect(f.config, '2026-10-20T10:34:00Z')).records.find(r => r.sessionId === 'demo-codex')?.status, '已完成');
    await rm(join(f.config.dataDir, 'state.json'));
    assert.equal((await rebuild(f.config)).records.find(r => r.sessionId === 'demo-codex')?.status, '已完成');
  });
}

test('返修1：多层子会话按自己的项目/原件对账并归到根会话，回看定位实际等待的成员', async t => {
  const f = await family(t);
  const grandchild = join(f.config.sources.codex!, 'grandchild.jsonl');
  const meta = codexMeta('grandchild', 'child');
  meta.payload.cwd = '/sample/child-worktree';
  await put(grandchild, [meta, codexEvent({ type: 'user_message', message: '更深一层的系统派活' }),
    codexEvent({ type: 'function_call', name: 'shell', call_id: 'grandchild-call', arguments: '{"command":"npm run build"}' }, 'response_item')]);
  await put(f.inbox, [f.push('demo-codex', f.parent, 'turn_end', '2026-10-20T10:02:00Z'),
    { ...f.push('grandchild', grandchild), cwd: '/sample/child-worktree' }]);
  const view = await detect(f.config, '2026-10-20T10:03:00Z');
  assert.equal(view.records.length, 2);
  const parent = view.records.find(r => r.sessionId === 'demo-codex')!;
  assert.equal(parent.status, '在等我');
  assert.equal(parent.waiting?.sessionId, 'grandchild');
  assert.equal(view.records.find(r => r.sessionId === 'other')?.status, '进行中');
  const [notice] = await readOutbox(f.config.dataDir);
  assert.match(notice!.text, /子会话（\/sample\/child-worktree）[\s\S]*npm run build/);
  assert.equal(notice?.content.returnCommand, "'/sample tools/codex' resume grandchild");
  assert.deepEqual(notice?.content.evidence.additionalRequirements, []);
});

test('返修1：子会话不能借用父记录聚合原件中的另一个文件通过对账', async t => {
  const f = await family(t);
  await put(f.inbox, [f.push('child', f.parent)]);
  const view = await detect(f.config, '2026-10-20T10:01:00Z');
  assert.equal((await readOutbox(f.config.dataDir))[0]?.kind, 'blind');
  assert.equal(view.projection.pushes.length, 0);
});

test('返修2：未通过对账的 session_end 只留原始事实；停用/恢复推送与重建都不能使它生效', async t => {
  const f = await sandbox();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const transcript = join(f.config.sources.cc!, 'session.jsonl');
  await put(transcript, [ccUser(), ccCall()]);
  const inbox = f.config.inboxDir!;
  await put(join(inbox, 'cc.jsonl'), [pushed(join(f.root, 'wrong-transcript.jsonl'), 'session_end')]);
  const first = await detect(f.config, '2026-10-20T10:01:00Z');
  assert.equal(first.records[0]?.status, '看不见了');
  assert.equal(first.projection.pushes.length, 0);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_observed').length, 1);
  const originalEvents = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  f.config.inboxDir = null;
  assert.equal((await detect(f.config, '2026-10-20T10:02:00Z')).records[0]?.status, '进行中');
  assert.equal((await overview(f.config)).records[0]?.status, '进行中');
  assert.equal((await detect(f.config, later)).records[0]?.status, '停滞');
  await rm(join(f.config.dataDir, 'state.json'));
  assert.equal((await rebuild(f.config)).records[0]?.status, '停滞');
  f.config.inboxDir = inbox;
  await put(join(inbox, 'cc.jsonl'), []);
  assert.equal((await detect(f.config, '2026-10-20T10:32:00Z')).records[0]?.status, '停滞');
  assert.equal((await overview(f.config)).projection.pushes.length, 0);
  const notices = await readOutbox(f.config.dataDir);
  assert.deepEqual(notices.map(n => n.kind), ['blind', 'stalled']);
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(originalEvents));
});

for (const mismatch of ['transcript', 'project']) {
  test(`返修2：修正 ${mismatch} 后的推送能独立通过对账，不与原坏事件去重冲突`, async t => {
    const f = await sandbox();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const transcript = join(f.config.sources.cc!, 'session.jsonl');
    await put(transcript, [ccUser(), ccCall()]);
    const good = pushed(transcript, 'session_end');
    const bad = { ...good, ...(mismatch === 'transcript' ? { transcript_path: join(f.root, 'wrong.jsonl') } : { cwd: '/sample/wrong-project' }) };
    const path = join(f.config.inboxDir!, 'cc.jsonl');
    await put(path, [bad]);
    await detect(f.config, '2026-10-20T10:01:00Z');
    const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
    await put(path, [good]); // 时间、会话、事件、detail 不变，只修正对账字段。
    const recovered = await detect(f.config, later);
    assert.equal(recovered.records[0]?.status, '已完成');
    assert.equal(recovered.projection.pushes.length, 1);
    assert.equal(recovered.projection.pushes[0]?.transcriptPath, transcript);
    assert.equal(recovered.projection.pushes[0]?.project, '/sample/project');
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_observed').length, 2);
    await rm(join(f.config.dataDir, 'state.json'));
    assert.equal((await rebuild(f.config)).records[0]?.status, '已完成');
    assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(before));
  });
}

test('返修2：旧格式未校验推送日志重放也不能污染状态，不需要删除或改写历史事件', async t => {
  const f = await sandbox();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const transcript = join(f.config.sources.cc!, 'session.jsonl');
  await put(transcript, [ccUser(), ccCall()]);
  const first = await detect(f.config, '2026-10-20T10:01:00Z');
  const oldPush = {
    tool: 'cc', event: 'session_end', sessionId: 'demo-cc', project: '/sample/project',
    transcriptPath: join(f.root, 'wrong.jsonl'), at: '2026-10-20T10:00:01.000Z', detail: '',
    original: { path: join(f.config.inboxDir!, 'cc.jsonl'), line: 1, fingerprint: 'synthetic-old-push' },
  };
  const oldEvent = { version: 1, id: 'push:legacy-unchecked', at: first.at, kind: 'push_observed', push: oldPush };
  await appendFile(join(f.config.dataDir, 'events.jsonl'), JSON.stringify(oldEvent) + '\n');
  const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  f.config.inboxDir = null;
  assert.equal((await overview(f.config)).records[0]?.status, '进行中');
  assert.equal((await rebuild(f.config, later)).records[0]?.status, '停滞');
  assert.equal((await detect(f.config, later)).records[0]?.status, '停滞');
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_observed').length, 1);
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(before));
});
