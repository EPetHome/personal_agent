// 误报修复批：全部为临时目录中的构造会话/推送，不读取真实工具目录或调用真实模型。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { event, project } from '../src/core/events.ts';
import { perceive } from '../src/core/perception.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { pi } from '../src/sources/pi/index.ts';
import type { AgentEvent, HealthReport, Judge, JudgmentRequest, Notice, Tool } from '../src/core/types.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, loopSummary, piHeader, piMessage, put, sandbox, start } from './fixtures.ts';

type AiTool = Exclude<Tool, 'loop'>;
const now = '2026-10-20T10:01:00Z';
const question = '请确认选择蓝色还是绿色方案？';
function rows(tool: AiTool, id = `demo-${tool}`, cwd = '/demo/shop', active = false) {
  if (tool === 'cc') return [ccUser('只修改 A 文件'), active ? ccCall(undefined, 'call', '修改 B 模块') : ccAnswer()].map(row => ({
    ...row, sessionId: id, cwd,
    ...(row.type === 'assistant' && !active ? { message: { role: 'assistant', stop_reason: 'end_turn', content: question } } : {}),
  }));
  if (tool === 'codex') return [{ ...codexMeta(id), payload: { id, cwd, timestamp: start } },
    codexEvent({ type: 'user_message', message: '只修改 A 文件' }), active
      ? codexEvent({ type: 'function_call', name: 'shell', call_id: 'call', arguments: '{"command":"修改 B 模块"}' }, 'response_item')
      : codexEvent({ type: 'task_complete', last_agent_message: question })];
  return [{ ...piHeader(), id, cwd }, piMessage('u', null, 'user', '只修改 A 文件'), active
    ? piMessage('a', 'u', 'assistant', [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: '修改 B 模块' } }], undefined, { stopReason: 'toolUse' })
    : piMessage('a', 'u', 'assistant', question)];
}
function moved(tool: AiTool, cwd: string, id = `demo-${tool}`) {
  if (tool === 'cc') return { ...ccAnswer(), sessionId: id, cwd, message: { role: 'assistant', stop_reason: 'end_turn', content: question } };
  if (tool === 'codex') return { type: 'turn_context', timestamp: start, payload: { cwd } };
  return { type: 'session_info', id: 'cwd-change', parentId: 'a', timestamp: start, cwd };
}
async function fixture(t: TestContext, tool: AiTool = 'cc') {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.sources = { cc: null, codex: null, pi: null, loop: null };
  f.config.sources[tool] = join(f.root, tool); await mkdir(f.config.sources[tool]!, { recursive: true });
  f.config.learning = false;
  const transcript = join(f.config.sources[tool]!, 'session.jsonl'), inbox = join(f.config.inboxDir!, `${tool}.jsonl`);
  const push = (event = 'waiting_permission', cwd = '/demo/shop', id = `demo-${tool}`, path = transcript) => ({
    tool, event, session_id: id, cwd, transcript_path: path, at: '2026-10-20T10:00:01Z', detail: question,
  });
  return { ...f, tool, transcript, inbox, push };
}
async function threeRounds(config: Parameters<typeof detect>[0]) {
  const views = [];
  for (let round = 1; round <= 3; round++) views.push(await detect(config, `2026-10-20T10:0${round}:00Z`));
  return views;
}
const driftJudge: Judge = { async judge() { return { answer: '是', reason: '修改范围超出意图', intentQuote: '只修改 A 文件', stepQuote: '修改 B 模块' }; } };

for (const tool of ['cc', 'codex', 'pi'] as const) {
  test(`误报 A1/A9：${tool} 中途 cd 后授权推送生效；项目不变且不拆行，重建/重复检测不重发`, async t => {
    const f = await fixture(t, tool);
    await put(f.transcript, [...rows(tool), moved(tool, '/demo/shop/api')]);
    await put(f.inbox, [f.push('waiting_permission', '/demo/shop/api')]);
    const view = await detect(f.config, now);
    assert.equal(view.noticesAdded, 1); assert.equal(view.records.length, 1);
    assert.equal(view.records[0]?.status, '在等我'); assert.equal(view.records[0]?.project, '/demo/shop');
    assert.equal(view.projection.pushes.length, 1); assert.equal(view.projection.health.get(tool)?.since, null);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['waiting']);
    assert.deepEqual((await rebuild(f.config)).records, view.records);
    assert.equal((await detect(f.config, '2026-10-20T10:02:00Z')).noticesAdded, 0);
  });

  test(`误报 A1 模型链路：${tool} 换目录的 turn_end 推送继续参与是否在等用户判断`, async t => {
    const f = await fixture(t, tool); f.config.judge = { executable: '/test-only/no-model', model: 'test/fake', dailyLimit: 10, timeoutMs: 2000 };
    await put(f.transcript, [...rows(tool), moved(tool, '/demo/shop/api')]);
    const detail = '推送独有的问题：现在是否继续部署？';
    await put(f.inbox, [{ ...f.push('turn_end', '/demo/shop/api'), detail }]);
    const calls: JudgmentRequest[] = [];
    const view = await detect(f.config, now, { judge: { async judge(request) {
      calls.push(request); return request.task === 'waiting' ? { answer: '是', reason: '需要用户回复' } : { answer: '否', reason: '未偏离' };
    } } });
    assert.equal(calls.find(call => call.task === 'waiting')?.context.assistantReply, detail);
    assert.equal(view.records[0]?.status, '在等我');
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['waiting']);
  });

  test(`误报 A2：${tool} 目录晚落盘，先宽限，追加目录后第二轮对上`, async t => {
    const f = await fixture(t, tool); await put(f.transcript, rows(tool));
    await put(f.inbox, [f.push('waiting_permission', '/demo/shop/api')]);
    const first = await detect(f.config, now);
    assert.equal(first.noticesAdded, 0); assert.equal(first.projection.pushes.length, 0);
    await overview(f.config); await rebuild(f.config); // 查询不消耗检测宽限。
    await appendFile(f.transcript, JSON.stringify(moved(tool, '/demo/shop/api')) + '\n');
    const second = await detect(f.config, '2026-10-20T10:02:00Z');
    assert.equal(second.projection.pushes.length, 1); assert.equal(second.records[0]?.status, '在等我');
    assert.ok((await readOutbox(f.config.dataDir)).every(n => n.kind !== 'blind'));
  });

  test(`误报 A3：${tool} 目录始终不在同一原件，第三轮仍报看不见了`, async t => {
    const f = await fixture(t, tool); await put(f.transcript, rows(tool));
    await put(f.inbox, [f.push('waiting_permission', '/demo/other')]);
    const views = await threeRounds(f.config);
    assert.deepEqual(views.map(v => v.noticesAdded), [0, 0, 1]);
    assert.equal(views[2]?.projection.pushes.length, 0);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
  });

  test(`误报 A4/A9：${tool} 从未落盘的 session_end 三轮无提醒、无会话；留一条空会话说明`, async t => {
    const f = await fixture(t, tool); await put(f.inbox, [f.push('session_end')]);
    const views = await threeRounds(f.config);
    assert.ok(views.every(v => !v.noticesAdded && !v.records.length && !v.projection.health.get(tool)?.since));
    const empty = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty');
    assert.equal(empty.length, 1); assert.ok(empty[0]?.kind === 'push_empty'); assert.match(empty[0].reason, /空会话.*两轮宽限/);
    await rebuild(f.config); await detect(f.config, '2026-10-20T10:04:00Z');
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 1);
    assert.equal((await readOutbox(f.config.dataDir)).length, 0);
  });

  test(`误报 A5：${tool} 已读过的会话文件消失，session_end 不得借缓存对账或当空会话`, async t => {
    const f = await fixture(t, tool); await put(f.transcript, rows(tool));
    await detect(f.config, '2026-10-20T10:00:30Z'); await rm(f.transcript);
    await put(f.inbox, [f.push('session_end')]);
    const views = await threeRounds(f.config);
    assert.deepEqual(views.map(v => v.noticesAdded), [0, 0, 1]);
    assert.equal(views[2]?.projection.pushes.length, 0);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 0);
  });

  test(`空会话严认：${tool} 只读到身份、尚无可解析会话内容，删文件后也不能误认空会话`, async t => {
    const f = await fixture(t, tool);
    const header = tool === 'cc' ? { ...ccUser(), message: { role: 'future', content: '非会话正文' } } : rows(tool)[0]!;
    await put(f.transcript, [header]); const first = await detect(f.config, '2026-10-20T10:00:30Z');
    assert.equal(first.records.length, 0); await rm(f.transcript); await put(f.inbox, [f.push('session_end')]);
    await threeRounds(f.config);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
    assert.ok(project(await readEvents(f.config.dataDir)).seenSessions.has(`${tool}:demo-${tool}`));
  });

  test(`空会话严认：${tool} 文件只有会话号、目录无效，删文件后仍不能判空`, async t => {
    const f = await fixture(t, tool);
    const header = tool === 'cc' ? { ...ccUser(), cwd: null, isSidechain: true }
      : tool === 'codex' ? { ...codexMeta(), payload: { id: 'demo-codex', cwd: null } } : { ...piHeader(), cwd: null };
    await put(f.transcript, [header]); await detect(f.config, '2026-10-20T10:00:30Z');
    await rm(f.transcript); await put(f.inbox, [f.push('session_end')]); await threeRounds(f.config);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 0);
  });

  test(`空会话：${tool} 文件存在但无核心消息，session_end 宽限后放过`, async t => {
    const f = await fixture(t, tool); await put(f.transcript, ''); await put(f.inbox, [f.push('session_end')]);
    const views = await threeRounds(f.config);
    assert.ok(views.every(view => !view.projection.health.get(tool)?.since));
    assert.equal((await readOutbox(f.config.dataDir)).length, 0);
    const empty = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty');
    assert.equal(empty.length, 1); assert.match(empty[0]!.reason, /文件存在.*没有核心消息/);
  });

  for (const event of ['waiting_permission', 'turn_end']) test(`空会话严认：${tool} 无文件的 ${event} 仍于第三轮报警`, async t => {
    const f = await fixture(t, tool); await put(f.inbox, [f.push(event)]); await threeRounds(f.config);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
  });

  for (const mismatch of ['session', 'path', 'outside']) test(`错项目保护：${tool} ${mismatch} 冲突第一轮就报警`, async t => {
    const f = await fixture(t, tool); await put(f.transcript, rows(tool));
    await put(f.inbox, [f.push('session_end', '/demo/shop', mismatch === 'session' ? 'wrong-session' : `demo-${tool}`,
      mismatch === 'path' ? join(f.config.sources[tool]!, 'wrong.jsonl') : mismatch === 'outside' ? join(f.root, 'outside.jsonl') : f.transcript)]);
    const view = await detect(f.config, now);
    assert.equal(view.projection.pushes.length, 0); assert.equal(view.noticesAdded, 1);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
  });

  test(`原件边界：${tool} 同号的另一份文件出现的目录，不能借给当前文件对账`, async t => {
    const f = await fixture(t, tool); await put(f.transcript, rows(tool));
    await put(join(f.config.sources[tool]!, 'second.jsonl'), rows(tool, `demo-${tool}`, '/demo/other'));
    await put(f.inbox, [f.push('waiting_permission', '/demo/other')]); await threeRounds(f.config);
    assert.equal((await overview(f.config)).projection.pushes.length, 0);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
  });

  test(`误报 A6：${tool} 四种 autoreview 前缀、损坏/无文件推送均不盯；普通会话照常判断`, async t => {
    const f = await fixture(t, tool);
    f.config.judge = { executable: '/test-only/no-model', model: 'test/fake', dailyLimit: 10, timeoutMs: 2000 };
    await put(f.transcript, rows(tool, `demo-${tool}`, '/demo/shop', true));
    for (const prefix of ['rev', 'acc', 'acc-strong', 'crit']) {
      const id = `autoreview-${prefix}-synthetic`;
      const path = join(f.config.sources[tool]!, `${id}.jsonl`);
      await put(path, rows(tool, id, '/demo/r3', true));
      if (prefix === 'acc') await appendFile(path, '{"broken":');
    }
    const missingProject = tool === 'cc' ? { ...ccUser(), sessionId: 'autoreview-acc-no-project', cwd: null }
      : tool === 'codex' ? { ...codexMeta(), payload: { id: 'autoreview-acc-no-project', cwd: null } }
        : { ...piHeader(), id: 'autoreview-acc-no-project', cwd: null };
    await put(join(f.config.sources[tool]!, 'unknown-name.jsonl'), [missingProject]);
    await appendFile(join(f.config.sources[tool]!, 'unknown-name.jsonl'), '{broken\n');
    // 连身份都读不到时，固定会话文件名仍可识别；正常文件不能被此规则掩盖。
    await put(join(f.config.sources[tool]!, 'autoreview-crit-unreadable.jsonl'), '{broken\n');
    await put(f.inbox, [f.push('waiting_permission', '/demo/r3', 'autoreview-acc-no-file')]);
    const calls: JudgmentRequest[] = [];
    const view = await detect(f.config, now, { judge: { async judge(request) { calls.push(request); return driftJudge.judge(request); } } });
    assert.equal(view.records.length, 1); assert.equal(view.records[0]?.sessionId, `demo-${tool}`);
    assert.equal(view.records[0]?.status, '疑似跑偏'); assert.equal(calls.length, 1);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['drift']);
    assert.equal(view.projection.health.get(tool)?.since, null); assert.equal(view.projection.health.get(tool)?.fileFailures, undefined);
  });

  for (const internalFiles of [0, 90]) test(`返修1-1：${tool} 排除 ${internalFiles} 份内部会话后不混用旧基线，真实格式异常仍报警`, async t => {
    const f = await fixture(t, tool);
    f.config.judge = { executable: '/test-only/no-model', model: 'test/fake', dailyLimit: 20, timeoutMs: 2000 };
    for (let i = 0; i < internalFiles; i++) {
      const id = `autoreview-acc-profile-${i}`;
      await put(join(f.config.sources[tool]!, `${id}.jsonl`), rows(tool, id, '/demo/r3', true));
    }
    for (let i = 0; i < 5; i++) {
      await put(join(f.config.sources[tool]!, `normal-${i}.jsonl`), rows(tool, `normal-${i}`, '/demo/shop', true));
      await put(join(f.config.sources[tool]!, `skip-${i}.jsonl`), [{ type: 'future-metadata' }]);
    }
    const oldAt = '2026-10-20T10:00:30Z';
    const legacy: HealthReport = { source: tool, paths: [f.config.sources[tool]!], errors: [], fileStats: { total: internalFiles + 10, skipped: 5 },
      sessionKeys: Array.from({ length: 5 }, (_, i) => `${tool}:normal-${i}`) };
    const history = [event({ kind: 'source_health', report: legacy }, oldAt)];
    if (internalFiles) history.push(event({ kind: 'source_health', report: { ...legacy, fileStats: { total: 10, skipped: 5 },
      errors: ['跳过比例明显升高：本轮 5/10（50.0%），健康基线 5.0%；请检查来源格式'] } }, oldAt));
    history.push(event({ kind: 'scan_completed' }, oldAt));
    await put(join(f.config.dataDir, 'events.jsonl'), history);
    const prefix = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
    assert.equal(project(history).health.get(tool)?.skipBaseline, 5 / (internalFiles + 10));
    let calls = 0;
    const judge: Judge = { async judge(request) { calls++; assert.equal(request.task, 'drift'); return { answer: '否', reason: '构造的正常判断' }; } };
    const first = await detect(f.config, now, { judge });
    const health = first.projection.health.get(tool)!;
    assert.deepEqual(health.fileStats, { total: 10, skipped: 5 });
    assert.equal(health.since, null); assert.deepEqual(health.errors, []);
    assert.equal(health.fileStatsProfile, 'exclude_internal_v2'); assert.equal(health.skipBaseline, 0.5);
    assert.equal(first.records.length, 5); assert.equal(calls, 5); assert.equal(first.noticesAdded, 0);
    assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(prefix));
    const added = (await readEvents(f.config.dataDir)).slice(history.length);
    assert.ok(added.some(e => e.kind === 'source_health' && e.report.fileStatsProfile === 'exclude_internal_v2'), '统计数量相同时也须追加口径变更');
    assert.equal((await rebuild(f.config)).projection.health.get(tool)?.skipBaseline, 0.5);
    assert.equal((await detect(f.config, '2026-10-20T10:02:00Z', { judge })).noticesAdded, 0);

    // 同一新口径下，正常文件被新格式噪音替代，不能把真实异常学成健康。
    for (let i = 0; i < 5; i++) await put(join(f.config.sources[tool]!, `normal-${i}.jsonl`), [{ type: 'future-metadata' }]);
    for (const minute of [3, 4]) {
      const spike = await detect(f.config, `2026-10-20T10:0${minute}:00Z`, { judge });
      assert.match(spike.projection.health.get(tool)!.errors.join('\n'), /跳过比例明显升高/);
      assert.equal(spike.projection.health.get(tool)?.skipBaseline, 0.5);
      assert.equal(calls, 5, '真实失明时不再判断旧会话');
    }
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
    for (let i = 0; i < 5; i++) await put(join(f.config.sources[tool]!, `normal-${i}.jsonl`), rows(tool, `normal-${i}`, '/demo/shop', true));
    const recovered = await detect(f.config, '2026-10-20T10:05:00Z', { judge });
    assert.equal(recovered.projection.health.get(tool)?.since, null); assert.equal(recovered.noticesAdded, 0);
  });
}

test('loop 交代保留：忽略的是 AI 内部会话，而不是 loop 总结', async t => {
  const f = await fixture(t, 'pi'); f.config.sources.loop = join(f.root, 'loop');
  await put(f.transcript, rows('pi', 'autoreview-acc-test', '/demo/r3', true));
  const path = join(f.config.sources.loop, 'project', '11111111-1111-4111-8111-111111111111.md');
  await put(path, loopSummary().replace('loop-demo', 'autoreview-acc-test'));
  const view = await detect(f.config, now);
  assert.deepEqual(view.records.map(r => r.tool), ['loop']);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['loop_completed']);
});

for (const pushEvent of ['waiting_permission', 'turn_end']) test(`误报 A7 ${pushEvent}：旧失明恢复、内部跑偏消失；不补发、不删改事件/发件/反馈`, async t => {
  const f = await fixture(t); f.config.sources.pi = join(f.root, 'pi');
  if (pushEvent === 'turn_end') f.config.judge = { executable: '/test-only/no-model', model: 'test/fake', dailyLimit: 10, timeoutMs: 2000 };
  const judge: Judge = { async judge(request) { return request.task === 'waiting' ? { answer: '是', reason: '需要用户选择' } : { answer: '否', reason: '未偏离' }; } };
  await put(f.transcript, [...rows('cc'), moved('cc', '/demo/shop/api')]);
  const internalId = 'autoreview-acc-old', internalPath = join(f.config.sources.pi, 'internal.jsonl');
  await put(internalPath, rows('pi', internalId, '/demo/r3', true));
  await put(f.inbox, [f.push(pushEvent, '/demo/shop/api'), f.push('session_end', '/demo/shop', 'never-seen', join(f.config.sources.cc!, 'absent.jsonl'))]);
  const input = await perceive(f.config), record = structuredClone(input.records[0]!); delete record.cwdHistory;
  const internal = pi.parse(rows('pi', internalId, '/demo/r3', true).map(r => JSON.stringify(r)).join('\n'), { path: internalPath, fingerprint: 'old' })!;
  const oldAt = '2026-10-20T10:00:30Z', raw = input.pushes.map(push => event({ kind: 'push_observed', push }, oldAt));
  const makeNotice = (id: string, kind: Notice['kind'], sessionKey?: string): Notice => ({
    version: 1, id, dedupeKey: id, at: oldAt, kind, tool: sessionKey ? 'pi' : 'cc', level: '现在就要你', ...(sessionKey ? { sessionKey } : {}),
    text: '旧误报原文必须保留', content: { title: '旧误报', summary: '原记录', returnCommand: 'true', evidence: {
      project: sessionKey ? '/demo/r3' : null, intentOriginal: null, additionalRequirements: [], recentSteps: [], reason: '旧判断', originals: [],
    } },
  });
  const notices = [makeNotice('old-blind', 'blind'), makeNotice('old-internal-drift', 'drift', internal.key)];
  const events: AgentEvent[] = [event({ kind: 'session_observed', record }, oldAt), event({ kind: 'session_observed', record: internal }, oldAt), ...raw,
    event({ kind: 'push_deferred', pushId: raw[1]!.id, rounds: 2 }, oldAt),
    event({ kind: 'source_health', report: { source: 'cc', paths: [f.config.sources.cc!], errors: input.pushes.map(push => `${push.original.path}：第 ${push.original.line} 行推送与已读取会话对不上；未跟随 transcript_path 读取其他文件`) } }, oldAt),
    ...notices.map(notice => event({ kind: 'notice_planned', notice }, oldAt)),
    ...notices.map(notice => event({ kind: 'channel_delivery', channel: 'local', noticeId: notice.id, ok: false }, oldAt)),
    event({ kind: 'notices_delivered', ids: notices.map(n => n.id) }, oldAt), event({ kind: 'scan_completed' }, oldAt)];
  await put(join(f.config.dataDir, 'events.jsonl'), events); await put(join(f.config.dataDir, 'outbox.jsonl'), notices);
  await put(join(f.config.dataDir, 'feedback.jsonl'), [{ version: 1, at: oldAt, date: '2026-10-20', channel: 'local', noticeId: 'old-blind', verdict: '误报', comment: '构造的旧反馈' }]);
  const before = await Promise.all(['events', 'outbox', 'feedback'].map(name => readFile(join(f.config.dataDir, `${name}.jsonl`), 'utf8')));
  assert.equal((await overview(f.config)).records.some(r => r.sessionId === internalId), false);
  let deliveries = 0;
  const view = await detect(f.config, now, { judge, channels: [{ name: 'local', async send() { deliveries++; }, async receive() { return '已记下'; } }] });
  assert.equal(deliveries, 0, '已恢复的失明及内部跑偏即使原渠道投递失败，也不能补发');
  assert.equal(view.projection.health.get('cc')?.since, null); assert.equal(view.noticesAdded, 0);
  assert.equal(view.records.length, 1); assert.equal(view.records[0]?.status, '在等我'); assert.equal(view.records[0]?.project, '/demo/shop');
  assert.equal((await readOutbox(f.config.dataDir)).length, 2);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 1);
  assert.deepEqual((await rebuild(f.config)).records, view.records);
  assert.equal((await detect(f.config, '2026-10-20T10:02:00Z', { judge })).noticesAdded, 0);
  for (const [index, name] of ['events', 'outbox', 'feedback'].entries()) {
    const after = await readFile(join(f.config.dataDir, `${name}.jsonl`), 'utf8');
    assert.ok(after.startsWith(before[index]!));
    if (name !== 'events') assert.equal(after, before[index]);
  }
  // 后来发生真正的新故障，也不能复活旧误报的失败渠道队列。
  await appendFile(f.inbox, JSON.stringify(f.push('session_end', '/demo/shop', 'wrong-new-id')) + '\n');
  const sent: string[] = [];
  const next = await detect(f.config, '2026-10-20T10:03:00Z', { judge, channels: [{ name: 'local', async send(notice) { sent.push(notice.id); }, async receive() { return '已记下'; } }] });
  assert.equal(next.noticesAdded, 1); assert.equal(sent.length, 1);
  assert.ok(sent.every(id => !notices.some(old => old.id === id)));
});

test('同轮隔离：一个真实冲突不能让另一条空会话跳过宽限或被误记失明原因', async t => {
  const f = await fixture(t); await put(f.transcript, rows('cc'));
  await put(f.inbox, [f.push('session_end', '/demo/shop', 'wrong-id'), f.push('session_end', '/demo/shop', 'empty-id', join(f.config.sources.cc!, 'empty.jsonl'))]);
  await threeRounds(f.config);
  const events = await readEvents(f.config.dataDir);
  assert.equal(events.filter(e => e.kind === 'push_empty').length, 1);
  const health = (await overview(f.config)).projection.health.get('cc')!;
  assert.equal(health.errors.length, 1); assert.match(health.errors[0]!, /第 1 行/);
});
