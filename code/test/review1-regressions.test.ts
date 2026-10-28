import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { codexEvent, codexMeta, put, sandbox } from './fixtures.ts';

async function family(t: TestContext) {
  const f = await sandbox();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.sources.cc = null;
  f.config.sources.codex = join(f.root, 'codex');
  const parent = join(f.config.sources.codex, 'parent.jsonl');
  const child = join(f.config.sources.codex, 'children', 'child.jsonl');
  const other = join(f.config.sources.codex, 'other.jsonl');
  const inbox = join(f.config.inboxDir!, 'codex.jsonl');
  const parentRows = [codexMeta(), codexEvent({ type: 'user_message', message: '构造的父任务' }), codexEvent({ type: 'task_complete' })];
  const childRows = [codexMeta('child', 'demo-codex'),
    codexEvent({ type: 'function_call', call_id: 'child-call', name: 'shell', arguments: '{"command":"npm test"}' }, 'response_item')];
  await put(parent, parentRows);
  await put(child, childRows);
  await put(other, [codexMeta('other'), codexEvent({ type: 'task_complete' })]);
  const push = (event = 'waiting_permission', at = '2026-10-20T10:00:01Z', sessionId = 'child', path = child) => ({
    tool: 'codex', event, session_id: sessionId, cwd: '/sample/codex', transcript_path: path, at, detail: '构造的授权请求',
  });
  return { ...f, parent, child, other, inbox, parentRows, childRows, push };
}

for (const problem of ['missing-parent', 'broken-parent', 'cycle']) {
  test(`本批返修第1条：正常根会话 + ${problem} 子会话 + 合法推送只报局部故障`, async t => {
    const f = await family(t);
    if (problem === 'broken-parent') await put(f.parent, 'broken\n');
    else {
      await rm(f.parent);
      await put(f.child, [codexMeta('child', problem === 'cycle' ? 'child' : 'missing'), ...f.childRows.slice(1)]);
    }
    await put(f.inbox, [f.push()]);
    const view = await detect(f.config, '2026-10-20T10:01:00Z');
    assert.equal(view.records.find(r => r.sessionId === 'other')?.status, '已完成');
    assert.equal(view.projection.health.get('codex')?.since, null);
    assert.deepEqual(view.projection.health.get('codex')?.errors, []);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
    assert.equal(view.projection.pushes.length, 0);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_validated').length, 0);
    assert.equal((await rebuild(f.config)).records.find(r => r.sessionId === 'other')?.status, '已完成');
    assert.equal((await detect(f.config, '2026-10-20T10:02:00Z')).noticesAdded, 0);
  });
}

test('本批返修第1条：父原件损坏后，孤儿推送不能借历史聚合成员通过对账', async t => {
  const f = await family(t);
  await detect(f.config, '2026-10-20T10:01:00Z');
  await put(f.parent, 'broken\n');
  await put(f.inbox, [f.push('session_end', '2026-10-20T10:02:00Z')]);
  const view = await detect(f.config, '2026-10-20T10:03:00Z');
  assert.equal(view.records.find(r => r.sessionId === 'other')?.status, '已完成');
  assert.equal(view.projection.health.get('codex')?.since, null);
  assert.equal(view.projection.pushes.length, 0);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_observed').length, 1);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_validated').length, 0);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
});

test('本批返修第1条：真正错误的推送路径仍报对账故障，不能借存在孤儿而获豁免', async t => {
  const f = await family(t);
  await put(f.child, [codexMeta('child', 'missing'), ...f.childRows.slice(1)]);
  await put(f.inbox, [f.push('session_end', '2026-10-20T10:00:01Z', 'other', join(f.root, 'unconfigured.jsonl'))]);
  const view = await detect(f.config, '2026-10-20T10:01:00Z');
  assert.equal(view.records.find(r => r.sessionId === 'other')?.status, '看不见了');
  assert.equal(view.projection.pushes.length, 0);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
  assert.match(view.projection.health.get('codex')!.errors.join('\n'), /推送与已读取会话对不上/);
});

for (const waiting of [false, true]) {
  for (const failure of ['json', 'symlink', 'directory-permission']) {
    test(`本批返修第2条：子成员${waiting ? '等待授权' : '进行中'}后 ${failure} 故障，两轮/重建不假完成且恢复可完成`, async t => {
      if (failure === 'directory-permission' && process.getuid?.() === 0) { t.skip('root 会绕过目录权限位'); return; }
      const f = await family(t);
      if (waiting) await put(f.inbox, [f.push()]);
      const first = await detect(f.config, '2026-10-20T10:06:00Z');
      const expected = waiting ? '在等我' : '进行中';
      assert.equal(first.records.find(r => r.sessionId === 'demo-codex')?.status, expected);
      const cachedChild = first.records.find(r => r.sessionId === 'demo-codex')!.members!.find(m => m.sessionId === 'child')!;
      const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
      if (failure === 'json') await put(f.child, 'broken\n');
      else if (failure === 'symlink') {
        await rm(f.child);
        const target = join(f.root, 'do-not-follow.jsonl');
        await put(target, [codexMeta('child', 'demo-codex'), codexEvent({ type: 'task_complete' })]);
        await symlink(target, f.child);
      } else await chmod(dirname(f.child), 0);
      try {
        // 文件不可读期间的新结束推送不可信，不能借缓存成员校验或解除先前等待。
        await put(f.inbox, [...(waiting ? [f.push()] : []), f.push('session_end', '2026-10-20T10:02:00Z')]);
        const second = await detect(f.config, '2026-10-20T10:08:00Z');
        const parent = second.records.find(r => r.sessionId === 'demo-codex')!;
        assert.equal(parent.status, expected);
        assert.equal(second.records.find(r => r.sessionId === 'other')?.status, '已完成');
        assert.equal(second.projection.health.get('codex')?.since, null);
        const child = parent.members!.find(m => m.sessionId === 'child')!;
        assert.equal(child.unavailable, true);
        assert.deepEqual(child.pendingTools, cachedChild.pendingTools);
        assert.deepEqual(child.originals, cachedChild.originals);
        assert.match(parent.reason, /本轮读不了/);
        assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_validated').length, waiting ? 1 : 0);
        assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), [...(waiting ? ['waiting'] : []), 'unreadable']);
        await rm(join(f.config.dataDir, 'state.json'));
        assert.deepEqual((await overview(f.config)).records, second.records);
        assert.deepEqual((await rebuild(f.config)).records, second.records);
        const eventCount = (await readEvents(f.config.dataDir)).length;
        assert.equal((await detect(f.config, '2026-10-20T10:35:00Z')).noticesAdded, 0);
        assert.equal((await readEvents(f.config.dataDir)).length - eventCount, 1, '同样的局部故障空跑只追加检测时间');
        assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(before));
      } finally {
        if (failure === 'directory-permission') await chmod(dirname(f.child), 0o700);
      }
      if (failure === 'symlink') await rm(f.child);
      await put(f.child, [codexMeta('child', 'demo-codex'), codexEvent({ type: 'task_complete' }, 'event_msg', '2026-10-20T10:36:00Z')]);
      const recovered = await detect(f.config, '2026-10-20T10:37:00Z');
      assert.equal(recovered.records.find(r => r.sessionId === 'demo-codex')?.status, '已完成');
      assert.equal(recovered.records.find(r => r.sessionId === 'other')?.status, '已完成');
      assert.ok(recovered.records.find(r => r.sessionId === 'demo-codex')!.members!.every(m => !m.unavailable));
      assert.equal(recovered.noticesAdded, 0);
      assert.deepEqual((await rebuild(f.config)).records, recovered.records);
    });
  }
}

test('本批返修两条整合：中间子文件损坏使可读孙成员归并失败，仍保留原任务关联且不信新结束推送', async t => {
  const f = await family(t);
  await put(f.child, [codexMeta('child', 'demo-codex'), codexEvent({ type: 'task_complete' })]);
  const grandchild = join(f.config.sources.codex!, 'grandchild.jsonl');
  await put(grandchild, [codexMeta('grandchild', 'child'),
    codexEvent({ type: 'function_call', call_id: 'deep-call', name: 'shell', arguments: '{"command":"npm test"}' }, 'response_item')]);
  assert.equal((await detect(f.config, '2026-10-20T10:01:00Z')).records.find(r => r.sessionId === 'demo-codex')?.status, '进行中');
  await put(f.child, 'broken\n');
  await put(f.inbox, [f.push('session_end', '2026-10-20T10:02:00Z', 'grandchild', grandchild)]);
  const view = await detect(f.config, '2026-10-20T10:03:00Z');
  const parent = view.records.find(r => r.sessionId === 'demo-codex')!;
  assert.equal(parent.status, '进行中');
  assert.deepEqual(parent.members!.map(m => m.sessionId).sort(), ['child', 'demo-codex', 'grandchild']);
  assert.equal(view.records.find(r => r.sessionId === 'other')?.status, '已完成');
  assert.equal(view.projection.health.get('codex')?.since, null);
  assert.equal(view.projection.pushes.length, 0);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
  assert.deepEqual((await rebuild(f.config)).records, view.records);
});
