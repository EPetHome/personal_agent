import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { validateConfig } from '../src/core/config.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { cc } from '../src/sources/cc/index.ts';
import { codex } from '../src/sources/codex/index.ts';
import { pi } from '../src/sources/pi/index.ts';
import { compact, truncateUtf8 } from '../src/core/utils.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, later, loopSummary, piHeader, piMessage, pushed, put, sandbox, start } from './fixtures.ts';

const original = { path: '/constructed/session.jsonl', fingerprint: 'constructed' };
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const uuid = '11111111-1111-4111-8111-111111111111';
const secondUuid = '22222222-2222-4222-8222-222222222222';
async function fixture(t: TestContext) {
  const f = await sandbox();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  return { ...f, transcript: join(f.config.sources.cc!, 'session.jsonl') };
}

test('兼容：未知 CC 元数据不检查时间/身份/消息字段，也不改变最后活动', () => {
  const record = cc.parse(jsonl([ccUser(), ccAnswer(),
    { type: 'future-metadata', sessionId: 'another-session', cwd: 3, timestamp: 'not-a-time', message: null },
  ]), original)!;
  assert.equal(record.intent.initial, ccUser().message.content);
  assert.equal(record.lastActivityAt, start);
  assert.equal(record.assistantFinished, true);
});

test('兼容：旧 CC 支持分块文本，排除尖括号记录、任务通知和纯工具结果', () => {
  const legacy = (content: unknown) => ({ ...ccUser(), origin: undefined, message: { role: 'user', content } });
  const record = cc.parse(jsonl([
    legacy('  <command-name>/clear</command-name>'),
    legacy([{ type: 'image', data: '不取图片' }, null, { type: 'text', text: '旧版本人任务' }]),
    legacy('<task-notification>系统通知'),
    legacy([{ type: 'tool_result', tool_use_id: 'other', content: '不当意图' }]),
    ccUser('任务通知', start, 'task-notification'), ccAnswer(),
  ]), original)!;
  assert.deepEqual(record.intent, { initial: '旧版本人任务', additions: [] });
});

test('兼容：Codex 未知顶层/事件/响应/完成项均忽略，包括无时间和无 payload', () => {
  const record = codex.parse(jsonl([codexMeta(), codexEvent({ type: 'user_message', message: '旧版任务' }),
    codexEvent({ type: 'task_complete', last_agent_message: '完成' }),
    { type: 'future', timestamp: 'bad' }, { type: 'world_state', payload: null },
    { type: 'event_msg', payload: { type: 'future', malformed: true } },
    { type: 'response_item', payload: { type: 'reasoning' } },
    { type: 'item_completed', payload: { item: { type: 'FutureItem' } } },
  ]), original)!;
  assert.deepEqual(record.intent, { initial: '旧版任务', additions: [] });
  assert.equal(record.assistantFinished, true);
  assert.equal(record.lastActivityAt, start);
});

test('兼容：Codex 新旧输入并存不重复，UserMessage 两种包裹都支持且排除所有 < 开头输入', () => {
  const record = codex.parse(jsonl([codexMeta(),
    codexEvent({ type: 'user_message', message: '旧重复副本' }),
    codexEvent({ type: 'item_completed', item: { type: 'UserMessage', content: '  <environment_context>环境' } }),
    codexEvent({ type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '新版开工任务' }] } }),
    { timestamp: start, type: 'item_completed', item: { type: 'UserMessage', content: '追加本人要求' } },
    codexEvent({ type: 'task_complete' }),
  ]), original)!;
  assert.deepEqual(record.intent, { initial: '新版开工任务', additions: ['追加本人要求'] });
});

for (const type of ['CommandExecution', 'FileChange', 'McpToolCall']) {
  test(`兼容：Codex item_completed ${type} 提取动作与结束状态，不保存输出/文件差异`, () => {
    const item = { type, id: 'item-1', command: ['npm', 'test'], changes: { 'src/demo.ts': { diff: '不保存差异' } },
      server: 'demo', tool: 'check', arguments: { path: 'src/demo.ts' }, status: 'in_progress', aggregated_output: '不保存输出' };
    const record = codex.parse(jsonl([codexMeta(), codexEvent({ type: 'item_completed', item })]), original)!;
    assert.equal(record.pendingTools.length, 1);
    assert.ok(!JSON.stringify(record).includes('不保存'));
    assert.match(record.recentSteps[0]!.text, type === 'CommandExecution' ? /npm test/ : /src\/demo.ts/);
    const done = codex.parse(jsonl([codexMeta(), codexEvent({ type: 'item_completed', item }),
      codexEvent({ type: 'item_completed', item: { ...item, status: 'completed' } }),
      codexEvent({ type: 'task_complete' }),
    ]), original)!;
    assert.equal(done.pendingTools.length, 0);
    assert.equal(done.assistantFinished, true);
  });
}

test('兼容：Codex 原始调用项 completed 仍等对应 output，新工具项不能清掉其他调用', () => {
  const record = codex.parse(jsonl([codexMeta(),
    codexEvent({ type: 'custom_tool_call', call_id: 'raw-call', name: 'exec', input: '{"cmd":"npm test"}', status: 'completed' }, 'response_item'),
    codexEvent({ type: 'item_completed', item: { type: 'CommandExecution', id: 'other', command: ['pwd'], status: 'completed' } }),
    codexEvent({ type: 'custom_tool_call_output', call_id: 'unrelated', output: '不保存' }, 'response_item'),
  ]), original)!;
  assert.deepEqual(record.pendingTools.map(p => p.id), ['raw-call']);
});

test('兼容：Pi 未知元数据可作树连接点，但未知末尾记录不能劫持当前分支', () => {
  const record = pi.parse(jsonl([piHeader(), piMessage('a', null, 'user', '本人任务'),
    { type: 'future', id: 'connector', parentId: 'a', timestamp: '不应检查' },
    piMessage('b', 'connector', 'assistant', '完成'),
    { type: 'future', timestamp: '不应检查' },
    { type: 'future', id: 'noise', parentId: 'non-existent', timestamp: '不应检查' },
    { type: 'future', id: 'a', parentId: null },
    { type: 'message', id: 'unknown-role', parentId: 'non-existent', message: { role: 'future' } },
  ]), original)!;
  assert.deepEqual(record.intent, { initial: '本人任务', additions: [] });
  assert.equal(record.assistantFinished, true);
});

test('兼容：只有 Pi v1 的来源为空且健康，不迁移、不发失明提醒', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.pi = join(f.root, 'pi');
  await put(join(f.config.sources.pi, 'old.jsonl'), [{ type: 'header', version: 1, cwd: '/demo/old' }, { role: 'user', content: '旧内容' }]);
  const view = await detect(f.config, later);
  assert.equal(view.records.length, 0);
  assert.equal(view.noticesAdded, 0);
});

test('隔离：12 份坏文件按来源一条提醒、最多 3 例、正文 <=4KB，重复检测不重复事件快照', async t => {
  const f = await fixture(t);
  await put(f.transcript, [ccUser(), ccAnswer()]);
  for (let i = 0; i < 12; i++) await put(join(f.config.sources.cc!, `${String(i).padStart(2, '0')}-${'长路径😀'.repeat(12)}.jsonl`), 'broken\n');
  const view = await detect(f.config, later);
  assert.equal(view.records[0]?.status, '已完成');
  assert.equal(view.projection.health.get('cc')?.since, null);
  assert.equal(view.projection.health.get('cc')?.fileFailures?.count, 12);
  assert.equal(view.projection.health.get('cc')?.fileFailures?.examples.length, 3);
  const [notice] = await readOutbox(f.config.dataDir);
  assert.equal(notice?.kind, 'unreadable');
  assert.match(notice!.text, /Claude Code 有 12 份会话读不了/);
  assert.ok(Buffer.byteLength(notice!.text) <= 4096);
  const before = await readEvents(f.config.dataDir);
  assert.equal((await detect(f.config, '2026-10-20T10:36:00Z')).noticesAdded, 0);
  assert.equal((await readEvents(f.config.dataDir)).length - before.length, 1);
});

test('隔离：曾读成功的文件后来损坏，不冒充本轮正常；修复后恢复，下一次故障新提醒', async t => {
  const f = await fixture(t);
  const other = join(f.config.sources.cc!, 'other.jsonl');
  await put(f.transcript, [ccUser(), ccAnswer()]);
  await put(other, [ccUser(), ccAnswer()].map(row => ({ ...row, sessionId: 'other', cwd: '/demo/other' })));
  assert.equal((await detect(f.config, later)).records.length, 2);
  await put(f.transcript, 'broken\n');
  let view = await detect(f.config, '2026-10-20T10:32:00Z');
  assert.deepEqual(view.records.map(r => [r.sessionId, r.status]), [['other', '已完成']]);
  assert.equal((await rebuild(f.config)).records.length, 1);
  await put(f.transcript, [ccUser(), ccAnswer()]);
  view = await detect(f.config, '2026-10-20T10:33:00Z');
  assert.equal(view.records.length, 2);
  assert.equal(view.noticesAdded, 0);
  await put(f.transcript, 'broken-again\n');
  assert.equal((await detect(f.config, '2026-10-20T10:34:00Z')).noticesAdded, 1);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable', 'unreadable']);
});

test('隔离：坏原件的推送只留原始事实，不能借旧成功记录对账，也不能拖好会话失明', async t => {
  const f = await fixture(t);
  await put(f.transcript, [ccUser(), ccCall()]);
  await put(join(f.config.sources.cc!, 'other.jsonl'), [ccUser(), ccAnswer()].map(row => ({ ...row, sessionId: 'other', cwd: '/demo/other' })));
  await detect(f.config, '2026-10-20T10:01:00Z');
  await put(f.transcript, 'broken\n');
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.transcript, 'session_end', '2026-10-20T10:02:00Z')]);
  const view = await detect(f.config, '2026-10-20T10:03:00Z');
  assert.deepEqual(view.records.map(r => [r.sessionId, r.status]), [['other', '已完成']]);
  assert.equal(view.projection.pushes.length, 0);
  assert.equal(view.projection.health.get('cc')?.since, null);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_observed').length, 1);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_validated').length, 0);
  assert.equal((await rebuild(f.config)).records[0]?.status, '已完成');
});

test('隔离：Codex 子原件损坏且同时有授权推送，正常父会话不被误判整个来源失明', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.codex = join(f.root, 'codex');
  await put(join(f.config.sources.codex, 'parent.jsonl'), [codexMeta(), codexEvent({ type: 'task_started' })]);
  const child = join(f.config.sources.codex, 'child.jsonl');
  await put(child, jsonl([codexMeta('child', 'demo-codex')]) + '{broken\n');
  await put(join(f.config.inboxDir!, 'codex.jsonl'), [{
    tool: 'codex', event: 'waiting_permission', session_id: 'child', cwd: '/sample/codex',
    transcript_path: child, at: '2026-10-20T10:00:01Z', detail: '请授权',
  }]);
  const view = await detect(f.config, '2026-10-20T10:01:00Z');
  assert.equal(view.records[0]?.status, '进行中');
  assert.equal(view.projection.pushes.length, 0);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
});

test('隔离：Codex 孤儿子会话只影响自己，正常根会话仍可完成', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.codex = join(f.root, 'codex');
  await put(join(f.config.sources.codex, 'normal.jsonl'), [codexMeta(), codexEvent({ type: 'task_complete' })]);
  await put(join(f.config.sources.codex, 'orphan.jsonl'), [codexMeta('orphan', 'missing'), codexEvent({ type: 'task_complete' })]);
  const view = await detect(f.config, later);
  assert.equal(view.records[0]?.status, '已完成');
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
});

test('loop：只列两层总结，不跟随合法文件名/项目目录的符号链接，不碰无权限的资料树', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.loop = join(f.root, 'loop');
  await put(join(f.config.sources.loop, 'project', `${uuid}.md`), loopSummary());
  const poison = join(f.root, 'poison.md');
  await put(poison, '如果跟随这个链接就会误报');
  await symlink(poison, join(f.config.sources.loop, 'project', `codex-${secondUuid}.md`));
  await symlink(join(f.config.sources.loop, 'project'), join(f.config.sources.loop, 'linked-project'));
  await put(join(f.config.sources.loop, 'project', 'review-input.md'), '不是总结');
  await put(join(f.config.sources.loop, `${secondUuid}.md`), '根目录不是总结');
  const resources = join(f.config.sources.loop, 'resources');
  await put(join(resources, 'deep', `${secondUuid}.md`), '不是总结');
  await chmod(resources, 0);
  try {
    const view = await detect(f.config, later);
    assert.equal(view.records.length, 1);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['loop_completed']);
  } finally { await chmod(resources, 0o700); }
});

test('loop：无读权限的唯一总结被跳过，不当整体失明，也不算坏文件', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.loop = join(f.root, 'loop');
  const file = join(f.config.sources.loop, 'project', `${uuid}.md`);
  await put(file, loopSummary());
  await chmod(file, 0);
  try {
    const view = await detect(f.config, later);
    assert.equal(view.records.length, 0);
    assert.equal(view.noticesAdded, 0);
    assert.equal(view.projection.health.get('loop')?.fileFailures, undefined);
  } finally { await chmod(file, 0o600); }
});

for (const missing of [true, false]) {
  test(`loop：需要你做的事${missing ? '缺段说「总结里没写」' : '明确无才说没有待办'}`, async t => {
    const f = await fixture(t);
    f.config.sources.cc = null;
    f.config.sources.loop = join(f.root, 'loop');
    const text = missing ? loopSummary().replace(/## 需要你做的事\n[^\n]*\n/, '') : loopSummary('完成', '/demo/project', '- 无');
    await put(join(f.config.sources.loop, 'project', `${uuid}.md`), text);
    await detect(f.config, later);
    const [notice] = await readOutbox(f.config.dataDir);
    assert.match(notice!.text, missing ? /总结里没写/ : /总结写明没有待办/);
    if (missing) assert.ok(!notice!.text.includes('没有待办'));
  });
}

test('忽略：目录边界匹配、默认不忽略，忽略会话的坏对账推送/停滞都不提醒', async t => {
  const f = await fixture(t);
  const ignored = '/private/tmp/test';
  await put(f.transcript, [ccUser(), ccCall()].map(row => ({ ...row, cwd: ignored })));
  await put(join(f.config.sources.cc!, 'other.jsonl'), [ccUser(), ccAnswer()].map(row => ({ ...row, sessionId: 'other', cwd: '/private/tmp-other' })));
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [{ ...pushed(join(f.root, 'wrong-path')), cwd: ignored }]);
  f.config.ignoreProjectPrefixes = ['/private/tmp/'];
  const view = await detect(f.config, later);
  assert.deepEqual(view.records.map(r => r.project), ['/private/tmp-other']);
  assert.equal(view.noticesAdded, 0);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_observed').length, 0);
});

test('忽略：父项目被忽略时不同 cwd 的子代理一并排除，不误报孤儿失明', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.codex = join(f.root, 'codex');
  const meta = codexMeta();
  meta.payload.cwd = '/private/tmp/worktree';
  await put(join(f.config.sources.codex, 'parent.jsonl'), [meta, codexEvent({ type: 'task_complete' })]);
  await put(join(f.config.sources.codex, 'child.jsonl'), [codexMeta('child', 'demo-codex'), codexEvent({ type: 'task_complete' })]);
  f.config.ignoreProjectPrefixes = ['/private/tmp'];
  const view = await detect(f.config, later);
  assert.equal(view.records.length, 0);
  assert.equal(view.noticesAdded, 0);
});

test('忽略：已有记录查询/重建也过滤；此前已计划未投递的提醒不能补发到忽略项目', async t => {
  const f = await fixture(t);
  await put(f.transcript, [ccUser(), ccCall()]);
  await detect(f.config, later);
  const events = await readEvents(f.config.dataDir);
  const config = { ...f.config, dataDir: join(f.root, 'interrupted'), ignoreProjectPrefixes: ['/sample'] };
  await put(join(config.dataDir, 'events.jsonl'), events.filter(e => e.kind !== 'notices_delivered'));
  assert.equal((await overview(config)).records.length, 0);
  assert.equal((await rebuild(config)).records.length, 0);
  assert.equal((await detect(config, '2026-10-20T10:36:00Z')).noticesAdded, 0);
  assert.equal((await readOutbox(config.dataDir)).length, 0);
});

test('忽略：深层子代理及其旧未交付授权提醒也一起过滤，父任务正常完成', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.codex = join(f.root, 'codex');
  const parentPath = join(f.config.sources.codex, 'parent.jsonl');
  const childMeta = codexMeta('child', 'demo-codex');
  childMeta.payload.cwd = '/private/tmp/child';
  const grandchild = join(f.config.sources.codex, 'grandchild.jsonl');
  await put(parentPath, [codexMeta(), codexEvent({ type: 'task_complete' })]);
  await put(join(f.config.sources.codex, 'child.jsonl'), [childMeta, codexEvent({ type: 'task_complete' })]);
  await put(grandchild, [codexMeta('grandchild', 'child'),
    codexEvent({ type: 'function_call', call_id: 'call-grandchild', name: 'shell', arguments: '{"command":"npm test"}' }, 'response_item')]);
  await put(join(f.config.inboxDir!, 'codex.jsonl'), [{
    tool: 'codex', event: 'waiting_permission', session_id: 'grandchild', cwd: '/sample/codex',
    transcript_path: grandchild, at: '2026-10-20T10:00:01Z', detail: '请授权',
  }]);
  assert.equal((await detect(f.config, '2026-10-20T10:01:00Z')).records[0]?.status, '在等我');
  const config = { ...f.config, dataDir: join(f.root, 'interrupted'), ignoreProjectPrefixes: ['/private/tmp'] };
  await put(join(config.dataDir, 'events.jsonl'), (await readEvents(f.config.dataDir)).filter(e => e.kind !== 'notices_delivered'));
  assert.equal((await overview(config)).records[0]?.status, '已完成');
  const view = await detect(config, later);
  assert.equal(view.records[0]?.status, '已完成');
  assert.equal(view.records[0]?.members, undefined);
  assert.equal(view.noticesAdded, 0);
  assert.equal((await readOutbox(config.dataDir)).length, 0);
});

test('隔离：只有一个 Codex 孤儿时核心整体不可用，仍只发一条高优先级失明', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.codex = join(f.root, 'codex');
  await put(join(f.config.sources.codex, 'orphan.jsonl'), [codexMeta('orphan', 'missing'), codexEvent({ type: 'task_complete' })]);
  const view = await detect(f.config, later);
  assert.equal(view.records.length, 0);
  const notices = await readOutbox(f.config.dataDir);
  assert.deepEqual(notices.map(n => [n.kind, n.level]), [['blind', '现在就要你']]);
  assert.match(notices[0]!.text, /核心信号整体取不到/);
});

test('空跑：200 个已完成会话重复检测只追加检测时间，不重复写清单/会话/健康快照', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 200; i++) {
    await put(join(f.config.sources.cc!, `${i}.jsonl`), [ccUser('构造的长意图'.repeat(200)), ccAnswer()].map(row => ({ ...row, sessionId: `session-${i}` })));
  }
  assert.equal((await detect(f.config, later)).records.length, 200);
  const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  assert.equal((await detect(f.config, '2026-10-20T10:36:00Z')).noticesAdded, 0);
  const after = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  assert.ok(after.startsWith(before));
  const added = after.slice(before.length);
  assert.ok(Buffer.byteLength(added) <= 1024);
  assert.equal(JSON.parse(added).kind, 'scan_completed');
});

for (const tool of ['cc', 'codex', 'pi', 'loop'] as const) {
  test(`忽略：${tool} 坏文件仍能识别项目时也不提醒，但身份线索绝不充当正常状态`, async t => {
    const f = await fixture(t);
    f.config.sources.cc = null;
    f.config.sources[tool] = join(f.root, tool);
    const project = '/private/tmp/ignored';
    const content = tool === 'cc' ? jsonl([{ ...ccUser(), cwd: project }]) + '{broken\n'
      : tool === 'codex' ? jsonl([{ ...codexMeta(), payload: { ...codexMeta().payload, cwd: project } }]) + '{broken\n'
      : tool === 'pi' ? jsonl([{ ...piHeader(), cwd: project }]) + '{broken\n'
      : `# 自动评审总结\n- 项目：${project}\n坏的核心内容`;
    await put(join(f.config.sources[tool]!, tool === 'loop' ? `project/${uuid}.md` : 'broken.jsonl'), content);
    f.config.ignoreProjectPrefixes = ['/private/tmp'];
    const view = await detect(f.config, later);
    assert.equal(view.records.length, 0);
    assert.equal(view.noticesAdded, 0);
    assert.equal(view.projection.health.get(tool)?.fileFailures, undefined);
    const unfiltered = { ...f.config, dataDir: join(f.root, 'unfiltered'), ignoreProjectPrefixes: [] };
    assert.equal((await detect(unfiltered, later)).records.length, 0);
    assert.deepEqual((await readOutbox(unfiltered.dataDir)).map(n => n.kind), ['blind']);
  });
}

test('忽略：损坏的 Codex 父文件仍能识别忽略项目时，正常子文件及推送不能误报孤儿', async t => {
  const f = await fixture(t);
  f.config.sources.cc = null;
  f.config.sources.codex = join(f.root, 'codex');
  await put(join(f.config.sources.codex, 'parent.jsonl'), jsonl([{ ...codexMeta(), payload: { ...codexMeta().payload, cwd: '/private/tmp/parent' } }]) + '{broken\n');
  const child = join(f.config.sources.codex, 'child.jsonl');
  await put(child, [codexMeta('child', 'demo-codex'), codexEvent({ type: 'task_complete' })]);
  await put(join(f.config.inboxDir!, 'codex.jsonl'), [{
    tool: 'codex', event: 'waiting_permission', session_id: 'child', cwd: '/sample/codex',
    transcript_path: child, at: '2026-10-20T10:00:01Z', detail: '请授权',
  }]);
  f.config.ignoreProjectPrefixes = ['/private/tmp'];
  const view = await detect(f.config, later);
  assert.equal(view.records.length, 0);
  assert.equal(view.noticesAdded, 0);
});

test('兼容：旧健康事件缺可见清单/文件故障字段仍能重放，升级只追加、状态可重建', async t => {
  const f = await fixture(t);
  await put(f.transcript, [ccUser(), ccAnswer()]);
  await detect(f.config, later);
  const events = (await readEvents(f.config.dataDir)).map(entry => {
    if (entry.kind !== 'source_health') return entry;
    const { sessionKeys, fileFailures, ...report } = entry.report;
    return { ...entry, report };
  });
  const old = { ...f.config, dataDir: join(f.root, 'old-format') };
  const path = join(old.dataDir, 'events.jsonl');
  await put(path, events);
  const before = await readFile(path, 'utf8');
  assert.equal((await overview(old)).records[0]?.status, '已完成');
  assert.equal((await rebuild(old)).records[0]?.status, '已完成');
  assert.equal((await detect(old, '2026-10-20T10:36:00Z')).noticesAdded, 0);
  assert.ok((await readFile(path, 'utf8')).startsWith(before));
  assert.ok((await readEvents(old.dataDir)).some(e => e.kind === 'source_health' && e.report.sessionKeys?.length));
});

test('配置：忽略前缀必须为绝对目录路径数组，不展开 ~', async t => {
  const f = await fixture(t);
  for (const ignoreProjectPrefixes of [null, '/tmp', [3], ['relative'], ['~/tmp']]) {
    await assert.rejects(validateConfig({ ...f.config, ignoreProjectPrefixes }), /ignoreProjectPrefixes/);
  }
  assert.deepEqual((await validateConfig(f.config)).ignoreProjectPrefixes, []);
});

test('输出：字符/UTF-8 两种截断都不切开表情，字节上限含省略号', () => {
  assert.equal(compact('a😀b', 2), 'a😀…');
  assert.equal(compact('a😀b', 3), 'a😀b');
  assert.equal(truncateUtf8('😀'.repeat(2000), 4096), `${'😀'.repeat(1023)}…`);
  assert.ok(Buffer.byteLength(truncateUtf8('😀'.repeat(2000), 4096)) <= 4096);
});

test('输出：含长表情的意图及提醒可重建，state.json 每行是完整 JSON', async t => {
  const f = await fixture(t);
  await put(f.transcript, [ccUser(`${'字'.repeat(999)}😀尾巴`), ccCall(start, 'tool', `${'字'.repeat(219)}😀尾巴`)]);
  const first = await detect(f.config, later);
  assert.equal(first.records[0]?.intent.initial, `${'字'.repeat(999)}😀…`);
  const state = await readFile(join(f.config.dataDir, 'state.json'), 'utf8');
  for (const line of state.split('\n').filter(Boolean)) JSON.parse(line);
  await rm(join(f.config.dataDir, 'state.json'));
  assert.deepEqual((await rebuild(f.config)).records, first.records);
  assert.equal(await readFile(join(f.config.dataDir, 'state.json'), 'utf8'), state);
});
