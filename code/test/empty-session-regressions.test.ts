// 空会话不致盲：只使用临时目录、构造会话和渠道/模型替身。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { event } from '../src/core/events.ts';
import { perceive } from '../src/core/perception.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import type { AgentEvent, Config, Judge, Notice, PushRecord } from '../src/core/types.ts';
import type { JsonObject } from '../src/core/utils.ts';
import { ccAnswer, ccUser, codexEvent, codexMeta, piHeader, piMessage, put, sandbox, start } from './fixtures.ts';

type AiTool = PushRecord['tool'];
const project = '/sample/empty-session';
const question = '请确认选择蓝色还是绿色方案？';
const at = (round: number) => `2026-10-20T10:0${round}:00.000Z`;
function metadata(tool: AiTool, id = `empty-${tool}`): JsonObject {
  if (tool === 'cc') return { type: 'queue-operation', operation: 'enqueue', sessionId: id, cwd: project, timestamp: start };
  if (tool === 'codex') return { ...codexMeta(id), payload: { id, cwd: project, timestamp: start } };
  return { ...piHeader(), id, cwd: project };
}
function conversation(tool: AiTool, id = `empty-${tool}`): JsonObject[] {
  if (tool === 'cc') return [ccUser('实现构造的配色方案'), ccAnswer()].map(row => ({ ...row, sessionId: id, cwd: project }));
  if (tool === 'codex') return [metadata(tool, id), codexEvent({ type: 'user_message', message: '实现构造的配色方案' }),
    codexEvent({ type: 'task_complete', last_agent_message: question })];
  return [metadata(tool, id), piMessage('u', null, 'user', '实现构造的配色方案'), piMessage('a', 'u', 'assistant', question)];
}
async function fixture(t: TestContext, tool: AiTool) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.sources = { cc: null, codex: null, pi: null, loop: null };
  f.config.sources[tool] = join(f.root, tool); await mkdir(f.config.sources[tool]!, { recursive: true });
  f.config.learning = false;
  const transcript = join(f.config.sources[tool]!, 'empty.jsonl');
  const inbox = join(f.config.inboxDir!, `${tool}.jsonl`);
  const push = (event: PushRecord['event'] = 'session_end', id = `empty-${tool}`, path = transcript) => ({
    tool, event, session_id: id, cwd: project, transcript_path: path, at: '2026-10-20T10:00:01Z', detail: question,
  });
  return { ...f, transcript, inbox, push };
}
async function threeRounds(config: Config) {
  const views = [];
  for (let round = 1; round <= 3; round++) views.push(await detect(config, at(round)));
  return views;
}

for (const tool of ['cc', 'codex', 'pi'] as const) {
  for (const shape of ['metadata', 'noise', 'noise-only', 'zero-bytes'] as const) {
    test(`空会话 A1/A3：${tool} ${shape} 文件存在，宽限后只记一次放过、不失明、不改原件`, async t => {
      const f = await fixture(t, tool);
      const noise = [{ type: 'future-metadata', payload: { ignored: true } },
        { type: 'model_change', id: 'm', parentId: null, timestamp: start }];
      await put(f.transcript, shape === 'zero-bytes' ? '' : shape === 'noise-only' ? noise
        : [metadata(tool), ...(shape === 'noise' ? noise : [])]);
      const original = await readFile(f.transcript, 'utf8');
      await put(f.inbox, [f.push()]);
      const views = await threeRounds(f.config);
      for (const view of views) {
        assert.deepEqual(view.projection.health.get(tool)?.errors, []);
        assert.equal(view.projection.health.get(tool)?.since, null);
        assert.equal(view.records.length, 0); assert.equal(view.projection.pushes.length, 0);
        assert.equal(view.noticesAdded, 0);
      }
      const events = await readEvents(f.config.dataDir);
      assert.deepEqual(events.filter(e => e.kind === 'push_deferred').map(e => e.rounds), [1, 2]);
      assert.equal(events.filter(e => e.kind === 'push_observed').length, 1);
      const empty = events.filter(e => e.kind === 'push_empty');
      assert.equal(empty.length, 1); assert.match(empty[0]!.reason, /空会话.*放过.*文件存在.*没有核心消息/);
      assert.deepEqual(views[2]!.projection.health.get(tool)?.fileStats, { total: 1, skipped: 1 });
      assert.deepEqual((await rebuild(f.config)).records, views[2]!.records);
      await detect(f.config, at(4));
      assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 1);
      assert.equal((await readOutbox(f.config.dataDir)).length, 0);
      assert.equal(await readFile(f.transcript, 'utf8'), original);
    });
  }

  for (const missing of ['id', 'cwd']) {
    test(`非空保护：${tool} 有核心对话但缺 ${missing}，虽被跳过也不能伪装成空会话`, async t => {
      const f = await fixture(t, tool), rows = conversation(tool);
      if (tool === 'cc') for (const row of rows) delete row[missing === 'id' ? 'sessionId' : 'cwd'];
      else delete (tool === 'codex' ? rows[0]!.payload : rows[0]!)[missing];
      await put(f.transcript, rows); await put(f.inbox, [f.push()]);
      const views = await threeRounds(f.config);
      assert.match(views[2]!.projection.health.get(tool)!.errors.join('\n'), /推送与已读取会话对不上/);
      assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
      assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 0);
    });
  }

  for (const mismatch of ['session', 'path']) {
    test(`空会话 A4：${tool} ${mismatch} 冲突不能借旁边的空文件放过，仍立即报警`, async t => {
      const f = await fixture(t, tool);
      const emptyPath = join(f.config.sources[tool]!, 'metadata.jsonl');
      await put(f.transcript, conversation(tool)); await put(emptyPath, [metadata(tool)]);
      await put(f.inbox, [mismatch === 'session' ? f.push('session_end', 'wrong-id') : f.push('session_end', `empty-${tool}`, emptyPath)]);
      const view = await detect(f.config, at(1));
      assert.match(view.projection.health.get(tool)!.errors.join('\n'), /推送与已读取会话对不上/);
      assert.equal(view.projection.pushes.length, 0);
      assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
      assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 0);
    });
  }

  test(`坏 JSON 保护：${tool} 元数据后有坏行，仍按读取失败处理、不记空会话`, async t => {
    const f = await fixture(t, tool);
    await put(f.transcript, [metadata(tool)]); await appendFile(f.transcript, '{"broken":\n');
    await put(f.inbox, [f.push()]);
    const views = await threeRounds(f.config);
    assert.equal(views[2]!.projection.health.get(tool)?.fileFailures?.count, 1);
    assert.ok(views[2]!.projection.health.get(tool)?.errors.length);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 0);
  });

  test(`历史保护：${tool} 读过真实对话后只剩元数据，不得当作从未开始的空会话`, async t => {
    const f = await fixture(t, tool);
    await put(f.transcript, conversation(tool)); await detect(f.config, '2026-10-20T10:00:30Z');
    await put(f.transcript, [metadata(tool)]); await put(f.inbox, [f.push()]);
    const views = await threeRounds(f.config);
    assert.match(views[2]!.projection.health.get(tool)!.errors.join('\n'), /推送与已读取会话对不上/);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 0);
  });

  for (const pushEvent of ['waiting_permission', 'turn_end'] as const) {
    test(`事件边界：${tool} 只有元数据的 ${pushEvent} 不属于空会话结束，第三轮仍报警`, async t => {
      const f = await fixture(t, tool);
      await put(f.transcript, [metadata(tool)]); await put(f.inbox, [f.push(pushEvent)]);
      const views = await threeRounds(f.config);
      assert.deepEqual(views.map(v => v.noticesAdded), [0, 0, 1]);
      assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
      assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 0);
    });
  }

  test(`迟落盘保护：${tool} 宽限期间出现核心对话，按真实会话对账而不是记空会话`, async t => {
    const f = await fixture(t, tool);
    await put(f.transcript, [metadata(tool)]); await put(f.inbox, [f.push()]);
    await detect(f.config, at(1));
    await put(f.transcript, conversation(tool));
    const second = await detect(f.config, at(2));
    assert.equal(second.records[0]?.status, '已完成'); assert.equal(second.projection.pushes.length, 1);
    assert.deepEqual(second.projection.health.get(tool)?.errors, []);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 0);
  });

  test(`重新核对：${tool} 已放过的空文件后来出现冲突对话，不能借旧空会话事件永久放过`, async t => {
    const f = await fixture(t, tool);
    await put(f.transcript, [metadata(tool)]); await put(f.inbox, [f.push()]);
    await threeRounds(f.config);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 1);
    await put(f.transcript, conversation(tool, 'different-session'));
    const view = await detect(f.config, at(4));
    assert.match(view.projection.health.get(tool)!.errors.join('\n'), /推送与已读取会话对不上/);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 1);
  });

  test(`旧数据恢复：${tool} 元数据身份已见、宽限已过且已发失明提醒，下一轮恢复且不重发`, async t => {
    const f = await fixture(t, tool);
    await put(f.transcript, [metadata(tool)]); await put(f.inbox, [f.push()]);
    const input = await perceive(f.config), push = input.pushes[0]!;
    const raw = event({ kind: 'push_observed', push }, start);
    const unhealthy = event({ kind: 'source_health', report: { ...input.health.find(h => h.source === tool)!,
      sessionKeys: [], errors: [`${push.original.path}：第 ${push.original.line} 行推送与已读取会话对不上；未跟随 transcript_path 读取其他文件`],
    } }, start);
    const notice: Notice = {
      version: 1, id: `old-blind-${tool}`, dedupeKey: `blind:${tool}:${unhealthy.id}`, at: start,
      kind: 'blind', tool, level: '现在就要你', text: '构造的旧失明提醒，必须原样保留',
      content: { title: '旧失明', summary: '报信和记录未对上', returnCommand: 'true', evidence: {
        project, intentOriginal: null, additionalRequirements: [], recentSteps: [], reason: '旧对账规则', originals: [],
      } },
    };
    const history: AgentEvent[] = [event({ kind: 'session_seen', tool, sessionId: push.sessionId }, start), raw,
      event({ kind: 'push_deferred', pushId: raw.id, rounds: 1 }, start), event({ kind: 'push_deferred', pushId: raw.id, rounds: 2 }, start),
      unhealthy, event({ kind: 'notice_planned', notice }, start), event({ kind: 'notices_delivered', ids: [notice.id] }, start),
      event({ kind: 'channel_delivery', channel: 'local', noticeId: notice.id, ok: false }, start), event({ kind: 'scan_completed' }, start)];
    await put(join(f.config.dataDir, 'events.jsonl'), history);
    await put(join(f.config.dataDir, 'outbox.jsonl'), [notice]);
    await put(join(f.config.dataDir, 'feedback.jsonl'), []);
    const files = ['events', 'outbox', 'feedback'];
    const before = await Promise.all(files.map(name => readFile(join(f.config.dataDir, `${name}.jsonl`), 'utf8')));
    assert.ok((await overview(f.config)).projection.health.get(tool)?.since);
    let sent = 0;
    const channels = [{ name: 'local', async send() { sent++; }, async receive() { return '已记下'; } }];
    const recovered = await detect(f.config, at(1), { channels });
    assert.deepEqual(recovered.projection.health.get(tool)?.errors, []);
    assert.equal(recovered.projection.health.get(tool)?.since, null);
    assert.equal(recovered.noticesAdded, 0); assert.equal(sent, 0);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 1);
    assert.equal((await rebuild(f.config)).projection.health.get(tool)?.since, null);
    await detect(f.config, at(2), { channels });
    assert.equal(sent, 0);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 1);
    for (const [index, name] of files.entries()) {
      const after = await readFile(join(f.config.dataDir, `${name}.jsonl`), 'utf8');
      assert.ok(after.startsWith(before[index]!));
      if (name !== 'events') assert.equal(after, before[index]);
    }
  });
}

test('空会话 A2：同一 Codex 来源有元数据空会话及正常等待回复的会话，后者照常提醒且不重发', async t => {
  const f = await fixture(t, 'codex');
  const healthy = join(f.config.sources.codex!, 'healthy.jsonl');
  await put(f.transcript, [metadata('codex')]); await put(healthy, conversation('codex', 'healthy'));
  await put(f.inbox, [f.push(), f.push('turn_end', 'healthy', healthy)]);
  f.config.judge = { executable: '/test-only/no-model', model: 'test/fake', dailyLimit: 20, timeoutMs: 2000 };
  const requests: string[] = [];
  const judge: Judge = { async judge(request) {
    requests.push(request.task);
    return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造的等待回复判断' };
  } };
  for (let round = 1; round <= 4; round++) {
    const view = await detect(f.config, at(round), { judge });
    assert.deepEqual(view.projection.health.get('codex')?.errors, []);
    assert.deepEqual(view.records.map(r => [r.sessionId, r.status]), [['healthy', '在等我']]);
  }
  assert.ok(requests.includes('waiting'));
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => [n.kind, n.sessionKey]), [['waiting', 'codex:healthy']]);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 1);
});

test('旧格式保护：Pi v1 有顶层对话而非只有元数据，不能因读取组件跳过就当作空会话', async t => {
  const f = await fixture(t, 'pi');
  await put(f.transcript, [{ type: 'header', version: 1, cwd: project }, { role: 'user', content: '旧格式里的真实对话' }]);
  await put(f.inbox, [f.push()]);
  const views = await threeRounds(f.config);
  assert.match(views[2]!.projection.health.get('pi')!.errors.join('\n'), /推送与已读取会话对不上/);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 0);
});

test('子成员历史保护：Codex 读过的未完成子会话只剩元数据，不能以空会话结束解除其不可用状态', async t => {
  const f = await fixture(t, 'codex');
  const parent = join(f.config.sources.codex!, 'parent.jsonl');
  await put(parent, [codexMeta('parent'), codexEvent({ type: 'task_complete' })]);
  const header = codexMeta('empty-codex', 'parent'); header.payload.cwd = project;
  await put(f.transcript, [header, codexEvent({ type: 'task_started' })]);
  await detect(f.config, '2026-10-20T10:00:30Z');
  await put(f.transcript, [header]); await put(f.inbox, [f.push()]);
  const views = await threeRounds(f.config);
  assert.ok(views[2]!.records[0]?.members?.find(m => m.sessionId === 'empty-codex')?.unavailable);
  assert.equal(views[2]!.projection.pushes.length, 0);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'push_empty').length, 0);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
});
