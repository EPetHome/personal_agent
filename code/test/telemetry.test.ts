// 本批只使用临时目录、编造会话、模型可执行替身和假飞书；不读真实账号/会话/运行目录。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { detect, rebuild } from '../src/core/agent.ts';
import { event, packProjection, project, unpackProjection } from '../src/core/events.ts';
import { readEvents, readJsonl, readOutbox, withStoreLock } from '../src/core/store.ts';
import { prepareEventLog, restoreEventLog } from '../src/core/event-archive.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import { readFeedback, receiveFeedback } from '../src/core/feedback.ts';
import { protectReplay, restoreReplayInput } from '../src/core/replay.ts';
import { judgmentReplay } from '../src/core/model.ts';
import { hash } from '../src/core/utils.ts';
import { cc } from '../src/sources/cc/index.ts';
import { noticeCard } from '../src/channels/feishu/card.ts';
import { codeVersion } from '../src/core/runtime-version.ts';
import { ccAnswer, ccCall, ccUser, codexMeta, codexEvent, loopSummary, piHeader, piMessage, put, pushed, sandbox } from './fixtures.ts';
import type { AgentEvent, Feedback, ModelReplay } from '../src/core/types.ts';

const at = (minute: number) => new Date(Date.parse('2026-10-20T10:00:00Z') + minute * 60000).toISOString();
const cli = resolve(import.meta.dirname, '../src/cli/main.ts');
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.learning = false;
  const file = join(f.config.sources.cc!, 'sample.jsonl');
  const answer = ccAnswer(at(0)); answer.message.content[0]!.text = '缓存保留五分钟还是十分钟？';
  await put(file, [ccUser('给商品列表加缓存', at(-20)), answer]);
  const capture = join(f.root, 'model-inputs.jsonl'), executable = join(f.root, 'model-stub');
  await put(executable, `#!${process.execPath}\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({prompt:input,args:process.argv.slice(2)})+'\\n');const answer=input.includes('只读卡片起草器')?{situation:'构造任务暂时没有进展。',action:'请查看任务',actionType:'去看一眼'}:{answer:input.includes('最近的新步骤')?'否':'是',reason:'构造判断'};console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}]}}));});\n`);
  await chmod(executable, 0o700);
  f.config.judge = { executable, model: 'test/replay-stub', dailyLimit: 20, timeoutMs: 5000 };
  return { ...f, file, capture };
}
function checks(events: AgentEvent[]) { return events.filter(e => e.kind === 'model_checked'); }
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { const value = await read(); if (accept(value)) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('构造服务未在期限内产生预期记录');
}
function restoreFromEvents(replay: ModelReplay, events: AgentEvent[]) {
  return restoreReplayInput(replay, source => {
    const values: unknown[] = [];
    if (source.kind === 'session') for (let index = 0; index < events.length; index++) {
      values.push(project(events.slice(0, index + 1)).sessions.get(source.key));
    }
    else if (source.kind === 'push') for (const entry of events) {
      if (entry.kind === 'push_observed' && entry.id === source.key) values.push(entry.push);
    }
    else if (source.kind === 'model_check') for (const entry of events) {
      if (entry.kind === 'model_checked' && entry.check.key === source.key) values.push(entry.check);
    }
    else for (const entry of events) if (entry.kind === 'notice_snapshot_written' && entry.key === source.key) values.push(entry.snapshot);
    for (let value of values) {
      for (const part of source.path) value = (value as any)?.[part];
      if (typeof value === 'string' && hash(value) === source.valueSha256) return value;
    }
    throw new Error('未找到匹配的已记录引用');
  });
}

test('埋点 A1/A2：完整系统指令、实际stdin、模型与提示词版本落盘；只凭事件复算一致，原件删除不影响', async t => {
  const f = await fixture(t);
  await detect(f.config, at(5));
  const events = await readEvents(f.config.dataDir), calls = await readJsonl<{ prompt: string; args: string[] }>(f.capture);
  assert.equal(checks(events).length, calls.length);
  for (const entry of checks(events)) {
    const replay = entry.check.replay!; assert.ok(replay);
    const input = restoreFromEvents(replay, events);
    const captured = calls.find(call => call.prompt === input.prompt)!; assert.ok(captured);
    assert.equal(replay.model, 'test/replay-stub'); assert.equal(replay.promptVersion, 'judgment-v1');
    assert.match(replay.templateSha256, /^[a-f0-9]{64}$/);
    assert.equal(input.systemPrompt, captured.args[captured.args.indexOf('--system-prompt') + 1]);
    assert.equal(replay.inputSha256, hash(JSON.stringify(input)));
    for (const flag of ['--no-tools', '--no-session', '--no-context-files']) assert.ok(captured.args.includes(flag));
  }
  await rm(f.file);
  assert.ok(restoreFromEvents(checks(events)[0]!.check.replay!, events).prompt.includes('商品列表'));
  t.diagnostic(`模型判断 replay 字段 UTF-8 字节数：${checks(events).map(e => Buffer.byteLength(JSON.stringify({ replay: e.check.replay }))).join(', ')}`);
});

test('埋点 A3：三分钟内已接话，候选消失也记录user_replied；本会话不调模型、不发卡', async t => {
  const f = await fixture(t);
  await detect(f.config, at(1));
  await appendFile(f.file, JSON.stringify(ccUser('保留十分钟', at(3))) + '\n');
  await detect(f.config, at(4)); await detect(f.config, at(6));
  const suppressed = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'notice_suppressed' && e.reason === 'user_replied');
  assert.equal(suppressed.length, 1);
  const decision = suppressed[0]!; assert.ok(decision.kind === 'notice_suppressed');
  assert.equal(decision.memberSessionId, 'demo-cc'); assert.equal(decision.evidenceAt, at(0));
  assert.equal(decision.reply?.at, at(3)); assert.equal(decision.intervalMs, 300000);
  assert.deepEqual(await readJsonl(f.capture), []); assert.deepEqual(await readOutbox(f.config.dataDir), []);
});

test('埋点 A4：重复、额度、首次接入历史三个固定原因不同；重复抑制只追加一次', async t => {
  const duplicate = await fixture(t);
  await detect(duplicate.config, at(5)); await detect(duplicate.config, at(6)); await detect(duplicate.config, at(7));
  const duplicated = (await readEvents(duplicate.config.dataDir)).filter(e => e.kind === 'notice_suppressed' && e.reason === 'duplicate_notice');
  assert.equal(duplicated.length, 1); assert.equal((await readOutbox(duplicate.config.dataDir)).length, 1);
  const limited = await fixture(t); limited.config.judge!.dailyLimit = 0;
  await put(limited.file, [ccUser('只改 A 模块', at(-20)), ccCall(at(0))]);
  await detect(limited.config, at(5));
  const quota = (await readEvents(limited.config.dataDir)).find(e => e.kind === 'notice_suppressed' && e.reason === 'model_daily_limit');
  assert.ok(quota?.kind === 'notice_suppressed'); assert.equal(quota.scope, 'model_check');
  assert.equal(checks(await readEvents(limited.config.dataDir))[0]!.check.replay, undefined, '未调用不伪造送模输入');
  const historical = await fixture(t); historical.config.judge = null;
  await put(historical.file, [ccUser('历史任务', at(-120)), ccCall(at(-120))]);
  await put(join(historical.config.inboxDir!, 'cc.jsonl'), [pushed(historical.file, 'waiting_permission', at(-119))]);
  await detect(historical.config, at(5));
  const history = (await readEvents(historical.config.dataDir)).find(e => e.kind === 'notice_suppressed' && e.reason === 'first_connection_history');
  assert.ok(history); assert.deepEqual(await readOutbox(historical.config.dataDir), []);
});

test('埋点 A5：实际启动隔离daemon，模型判断/发卡/假飞书投递均对应启动提交', async t => {
  const f = await fixture(t), time = new Date(Date.now() - 6 * 60000).toISOString();
  const answer = ccAnswer(time); answer.message.content[0]!.text = '构造服务等待确认？';
  await put(f.file, [ccUser('构造服务任务', time), answer]);
  f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 1000 };
  f.config.service = { intervalMs: 200, restartWindowMs: 60000, restartThreshold: 3 };
  const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
  const child = spawn(process.execPath, [cli, 'daemon', '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: f.root } });
  let output = ''; child.stdout!.on('data', chunk => output += chunk); child.stderr!.on('data', chunk => output += chunk);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  const events = await until(() => readEvents(f.config.dataDir), rows => rows.some(e => e.kind === 'model_checked')
    && rows.some(e => e.kind === 'channel_delivery' && e.phase === 'attempted' && e.ok));
  const start = (await readJsonl<{ kind: string; codeVersion: typeof codeVersion }>(join(f.config.dataDir, 'service-runs.jsonl'))).find(r => r.kind === 'start')!;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' }).trim();
  assert.equal(start.codeVersion.commit, commit);
  for (const entry of events.filter(e => ['model_checked', 'notice_planned', 'channel_delivery'].includes(e.kind))) assert.deepEqual(entry.codeVersion, start.codeVersion);
  assert.equal((await readOutbox(f.config.dataDir))[0]!.codeVersion?.commit, commit);
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  assert.equal(child.exitCode, 0, output);
});

test('埋点 A6：规则停滞记录编号和事实/阈值，完成与loop暂停各有不同编号；稳定扫描不重复事实', async t => {
  const f = await fixture(t); f.config.judge = null;
  await put(f.file, [ccUser('规则任务', at(0)), ccCall(at(0))]);
  await detect(f.config, at(31)); await detect(f.config, at(32));
  let scans = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'scan_completed');
  const observation = scans[0]!.ruleDecisions![0]!;
  assert.equal(observation.status, '停滞'); assert.equal(observation.rule.id, 'unfinished_30m');
  assert.equal(observation.rule.facts.thresholdMs, 1800000); assert.equal(observation.rule.facts.members[0]!.pendingTools, 1);
  assert.equal(scans[1]!.ruleDecisions, undefined);
  await put(f.file, [ccUser('规则任务', at(0)), ccAnswer(at(33))]);
  f.config.sources.loop = join(f.root, 'loop');
  await put(join(f.config.sources.loop, 'project/00000000-0000-4000-8000-000000000001.md'), loopSummary('暂停，等你决定', '/sample/loop', '- 构造决定', at(33)));
  await detect(f.config, at(34));
  scans = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'scan_completed');
  assert.deepEqual(scans.at(-1)!.ruleDecisions!.map(o => o.rule.id).sort(), ['all_members_completed', 'loop_paused']);
  assert.equal((await rebuild(f.config)).records[0]!.rule?.id, 'all_members_completed');
});

test('埋点 A7：假飞书漏了保留原话/时间及全部状态引用；检测锁占用也能记录，后续状态不改旧反馈', async t => {
  const f = await fixture(t); f.config.judge = null; f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 1000 };
  await put(f.file, [ccUser('会话一', at(0)), ccCall(at(0))]);
  await put(join(f.config.sources.cc!, 'other.jsonl'), [{ ...ccUser('会话二', at(0)), sessionId: 'other' }]);
  await detect(f.config, at(31));
  const events = await readEvents(f.config.dataDir);
  await put(join(f.config.dataDir, 'feishu-inbox.jsonl'), [{ header: { event_id: 'miss-telemetry', event_type: 'im.message.receive_v1', create_time: String(Date.parse(at(32))) }, event: {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_test' } },
    message: { message_id: 'om_miss_telemetry', message_type: 'text', chat_type: 'p2p', content: JSON.stringify({ text: '漏了 构造任务还在等我' }) },
  } }]);
  await withStoreLock(f.config.dataDir, () => feishuChannel(f.config).drain(at(32)));
  const feedback = (await readFeedback(f.config.dataDir))[0]!;
  assert.equal(feedback.noticeId, null); assert.equal(feedback.originalText, '漏了 构造任务还在等我'); assert.equal(feedback.at, at(32));
  assert.equal(feedback.context!.asOf, at(31)); assert.equal(feedback.context!.sessions.length, 2);
  const index = events.findIndex(e => e.id === feedback.context!.eventId); assert.ok(index >= 0);
  const prefix = project(events.slice(0, index + 1));
  for (const ref of feedback.context!.sessions) assert.deepEqual(ref.originals, prefix.sessions.get(ref.key)!.originals);
  await put(f.file, [ccUser('会话一', at(0)), ccAnswer(at(33))]); await detect(f.config, at(34));
  assert.deepEqual((await readFeedback(f.config.dataDir))[0], feedback);
});

for (const tool of ['cc', 'codex', 'pi', 'loop'] as const) test(`埋点 A8：${tool} 卡片保存读取范围的路径、行号和原始字节SHA-256；追加不改变旧指纹`, async t => {
  const f = await fixture(t); f.config.judge = null;
  f.config.sources = { cc: null, codex: null, pi: null, loop: null }; f.config.sources[tool] = join(f.root, tool);
  const file = join(f.config.sources[tool]!, tool === 'loop' ? 'project/00000000-0000-4000-8000-000000000001.md' : 'session.jsonl');
  const rows = tool === 'cc' ? [ccUser('构造指纹😀', at(0)), ccCall(at(0))]
    : tool === 'codex' ? [codexMeta(), codexEvent({ type: 'user_message', message: '构造指纹😀' }, 'event_msg', at(0)), codexEvent({ type: 'function_call', name: 'shell_command', call_id: 'pending', arguments: '{"command":"构造执行"}' }, 'response_item', at(0))]
      : tool === 'pi' ? [piHeader(), piMessage('u', null, 'user', '构造指纹😀', at(0)), piMessage('a', 'u', 'assistant', [{ type: 'toolCall', id: 'p', name: 'bash', arguments: { command: '构造执行' } }], at(0), { stopReason: 'toolUse' })] : [];
  const text = tool === 'loop' ? loopSummary('完成', '/sample/loop', '- 无', at(0)) : rows.map(row => JSON.stringify(row)).join('\r\n');
  await put(file, text);
  await detect(f.config, at(31));
  const notice = (await readOutbox(f.config.dataDir))[0]!; assert.ok(notice, tool);
  const original = notice.content.evidence.originals.find(original => original.path === file)!, span = original.span!;
  assert.equal(original.path, file); assert.equal(span.startLine, 1);
  const raw = await readFile(file); const lines = raw.toString('utf8').split(/(?<=\n)/);
  assert.equal(span.endLine, lines.filter(Boolean).length); assert.equal(span.byteLength, raw.length);
  assert.equal(hash(lines.slice(span.startLine - 1, span.endLine).join('')), original.fingerprint);
  const basis = notice.sourceEvidence ?? notice.content.evidence.originals;
  assert.ok(basis.some(item => item.path === file && item.fingerprint === original.fingerprint));
  assert.equal(notice.sourceEvidence, undefined, '最新所见已含完整依据时不重复复制原件');
  await appendFile(file, '\n');
  assert.equal(hash((await readFile(file)).subarray(0, span.byteLength).toString('utf8')), original.fingerprint);
  const stripped = structuredClone(notice); delete stripped.codeVersion;
  for (const original of stripped.content.evidence.originals) delete original.span;
  assert.deepEqual(noticeCard(notice), noticeCard(stripped), '埋点不改变卡片显示');
});

test('埋点 A9：纯旧事件/发件/反馈/状态启动隔离服务，总览和stats正常；旧检查点缺新索引可读', async t => {
  const f = await fixture(t); f.config.judge = null;
  const text = await readFile(f.file, 'utf8'), record = cc.parse(text, { path: f.file, fingerprint: hash(text) })!;
  const now = new Date().toISOString();
  const old = [event({ kind: 'session_observed', record }, now), event({ kind: 'scan_completed' }, now)].map(e => { const row = { ...e }; delete row.codeVersion; return row; });
  await put(join(f.config.dataDir, 'events.jsonl'), old);
  const oldFeedback: Feedback = { version: 1, at: at(1), date: at(1).slice(0, 10), channel: 'local', noticeId: null, verdict: '漏了', comment: '旧格式' };
  await put(join(f.config.dataDir, 'feedback.jsonl'), [oldFeedback]);
  await put(join(f.config.dataDir, 'outbox.jsonl'), []);
  await put(join(f.config.dataDir, 'state.json'), JSON.stringify({ version: 1, at: at(1), records: [{ ...record, status: '已完成' }] }) + '\n');
  const state = packProjection(project(old)); delete (state as any).telemetrySuppressions; delete (state as any).waitingWindows; delete (state as any).ruleDecisions;
  assert.equal(unpackProjection(state).sessions.size, 1);
  f.config.service = { intervalMs: 200, restartWindowMs: 60000, restartThreshold: 3 };
  const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
  const child = spawn(process.execPath, [cli, 'daemon', '--config', configPath], { stdio: 'ignore', env: { ...process.env, HOME: f.root } });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  await until(() => readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl')), rows => rows.some(r => r.kind === 'scan_completed'));
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; assert.equal(child.exitCode, 0);
  for (const command of ['overview', 'stats']) {
    const result = spawnSync(process.execPath, [cli, command, '--config', configPath], { encoding: 'utf8', env: { ...process.env, HOME: f.root } });
    assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.trim());
  }
  const mixed = await readEvents(f.config.dataDir); assert.ok(mixed.some(e => !e.codeVersion)); assert.ok(mixed.some(e => e.codeVersion));
  assert.deepEqual((await readFeedback(f.config.dataDir))[0], oldFeedback);
});

test('敏感输入只引用旧记录、不复制凭据、不改实际送模；恢复归档后仍能完整重建', async t => {
  const f = await fixture(t);
  // 明确编造的哨兵，不是任何账号的真实凭据。
  const sentinels = ['sk-constructed_not_a_real_key_012345', 'constructed-password-012345', 'constructed-client-secret-012345'];
  await put(f.file, [ccUser(`构造任务：API_KEY=${sentinels[0]} password="${sentinels[1]}" client_secret='${sentinels[2]}'`, at(-20)), ccAnswer(at(0))]);
  await detect(f.config, at(5));
  let events = await readEvents(f.config.dataDir);
  const replay = checks(events).find(e => e.check.task === 'waiting')!.check.replay!;
  for (const sentinel of sentinels) assert.ok(!JSON.stringify(replay).includes(sentinel), '新增回放字段不能复制凭据');
  assert.ok(replay.references?.length); assert.equal(replay.unavailable, undefined);
  const restored = restoreFromEvents(replay, events);
  const calls = await readJsonl<{ prompt: string }>(f.capture);
  assert.ok(calls.some(call => call.prompt === restored.prompt));
  for (const sentinel of sentinels) assert.ok(restored.prompt.includes(sentinel), '原调用内容未被埋点改写');
  const original = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  const restoredPath = join(f.root, 'restored-events.jsonl');
  await withStoreLock(f.config.dataDir, async () => { await prepareEventLog(f.config.dataDir, '2026-10-29T10:00:00Z'); await restoreEventLog(f.config.dataDir, restoredPath); });
  assert.equal(await readFile(restoredPath, 'utf8'), original);
  events = await readJsonl<AgentEvent>(restoredPath);
  assert.deepEqual(restoreFromEvents(replay, events), restored);
});

test('无检测/旧状态缺失时漏报仍落盘并明确未知；重投不改当时上下文', async t => {
  const f = await fixture(t);
  const reply = { noticeId: null, content: '漏了 构造空库', at: at(1), replyId: 'empty-miss' };
  await receiveFeedback(f.config.dataDir, 'test', reply);
  const first = (await readFeedback(f.config.dataDir))[0]!;
  assert.equal(first.context!.unavailable, 'no_completed_scan');
  await detect(f.config, at(5)); await receiveFeedback(f.config.dataDir, 'test', reply);
  assert.deepEqual(await readFeedback(f.config.dataDir), [first]);
});

test('补充抑制路径：loop自己恢复、已判跑偏后真人接话分别留痕，不新增提醒', async t => {
  const f = await fixture(t); f.config.judge = null; f.config.sources.cc = null; f.config.sources.loop = join(f.root, 'loop');
  const summary = join(f.config.sources.loop, 'project/00000000-0000-4000-8000-000000000001.md');
  await put(summary, loopSummary('暂停，等你决定', '/sample/loop', '- 构造决定', at(0))); await detect(f.config, at(1));
  await put(summary, loopSummary('进行中', '/sample/loop', '- 无', at(2))); await detect(f.config, at(3));
  assert.ok((await readEvents(f.config.dataDir)).some(e => e.kind === 'notice_suppressed' && e.reason === 'loop_resumed'));
  assert.deepEqual(await readOutbox(f.config.dataDir), []);
  const drift = await fixture(t);
  await put(drift.file, [ccUser('只改 A 模块', at(-20)), ccCall(at(0), 'b', '修改 B 模块')]);
  const judge = { async judge() { return { answer: '是' as const, reason: '构造越界', intentQuote: '只改 A 模块', stepQuote: '修改 B 模块' }; } };
  await detect(drift.config, at(1), { judge });
  await appendFile(drift.file, JSON.stringify(ccUser('现在允许修改 B 模块', at(3))) + '\n');
  await detect(drift.config, at(6), { judge });
  assert.ok((await readEvents(drift.config.dataDir)).some(e => e.kind === 'notice_suppressed' && e.reason === 'user_replied' && e.scope === 'notice'));
  assert.deepEqual(await readOutbox(drift.config.dataDir), []);
});

test('独立卡片起草也记录精确输入；延后发卡保留判断时的原件，不改变旧证据字段', async t => {
  const f = await fixture(t);
  await put(f.file, [ccUser('构造停滞任务', at(-20)), ccCall(at(0))]);
  await detect(f.config, at(31));
  const events = await readEvents(f.config.dataDir), snapshot = events.find(e => e.kind === 'notice_snapshot_written');
  assert.ok(snapshot?.kind === 'notice_snapshot_written' && snapshot.replay);
  const input = restoreFromEvents(snapshot.replay, events);
  assert.ok((await readJsonl<{ prompt: string }>(f.capture)).some(call => call.prompt === input.prompt));
  const drift = await fixture(t);
  await put(drift.file, [ccUser('只改 A 模块', at(-20)), ccCall(at(0), 'b', '修改 B 模块')]);
  const judge = { async judge() { return { answer: '是' as const, reason: '构造越界', intentQuote: '只改 A 模块', stepQuote: '修改 B 模块' }; } };
  await detect(drift.config, at(1), { judge });
  const before = hash(await readFile(drift.file, 'utf8'));
  await appendFile(drift.file, JSON.stringify(ccCall(at(2), 'later', '后续构造步骤')) + '\n');
  await detect(drift.config, at(5), { judge });
  const notice = (await readOutbox(drift.config.dataDir))[0]!;
  assert.equal(notice.sourceEvidence![0]!.fingerprint, before);
  assert.equal(notice.content.evidence.originals[0]!.fingerprint, hash(await readFile(drift.file, 'utf8')));
});

test('通知已经发出后的接话是响应，不误记为未发出的抑制', async t => {
  const f = await fixture(t); await detect(f.config, at(5));
  await appendFile(f.file, JSON.stringify(ccUser('构造已收到卡片后的回复', at(6))) + '\n');
  await detect(f.config, at(7));
  const events = await readEvents(f.config.dataDir);
  assert.ok(events.some(e => e.kind === 'notice_reply_observed'));
  assert.equal(events.filter(e => e.kind === 'notice_suppressed' && e.reason === 'user_replied').length, 0);
});

for (const [label, material, sentinel] of [
  ['Basic', 'Authorization: Basic ZmFrZS11c2VyOmZha2UtcGFzc3dvcmQ=', 'ZmFrZS11c2VyOmZha2UtcGFzc3dvcmQ='],
  ['token', 'token=constructed-ordinary-token-012345', 'constructed-ordinary-token-012345'],
  ['opaque', '不带凭据前缀的构造材料 opaque-unknown-012345', 'opaque-unknown-012345'],
  ['escaped', '构造引号 "opaque\\value"\n材料：\n😀 synthetic-escaped-012345', 'synthetic-escaped-012345'],
] as const) test(`返修1-1 ${label}：外部材料一律引用，不复制任何认证/普通正文，实际送模与恢复哈希不变`, async t => {
  const f = await fixture(t), answer = ccAnswer(at(0));
  answer.message.content[0]!.text = `请确认构造材料：${material}，是否继续？`;
  await put(f.file, [ccUser(`构造任务：${material}`, at(-20)), answer]);
  await detect(f.config, at(5));
  const events = await readEvents(f.config.dataDir), calls = await readJsonl<{ prompt: string }>(f.capture);
  for (const entry of checks(events)) {
    const replay = entry.check.replay!;
    assert.equal(replay.unavailable, undefined); assert.ok(replay.references!.length > 0);
    assert.ok(!JSON.stringify(replay).includes(sentinel));
    assert.ok(!replay.input.prompt.includes(material));
    const input = restoreFromEvents(replay, events);
    assert.ok(input.prompt.includes(sentinel));
    assert.ok(calls.some(call => call.prompt === input.prompt));
    assert.equal(hash(JSON.stringify(input)), replay.inputSha256);
  }
});

test('返修1-1：找不到材料引用不回退明文，旧原文记录仍可校验读取', async () => {
  const raw = judgmentReplay({ executable: '/test-only/unused', model: 'fake', timeoutMs: 1000 }, {
    task: 'waiting', format: 'binary', context: { intentOriginal: 'Authorization: Basic constructed-unknown-basic-012345',
      additionalRequirements: [], previousSummary: '', newSteps: [], assistantReply: 'token=constructed-unknown-token-012345' },
  });
  const protectedInput = protectReplay(raw, []);
  assert.equal(protectedInput.unavailable, 'input_reference_unavailable');
  for (const sentinel of ['constructed-unknown-basic-012345', 'constructed-unknown-token-012345']) assert.ok(!JSON.stringify(protectedInput).includes(sentinel));
  assert.throws(() => restoreReplayInput(protectedInput, () => ''), /引用不可用/);
  assert.deepEqual(restoreReplayInput(raw, () => { throw new Error('旧原文记录不应解析引用'); }), raw.input);
});

for (const scenario of ['cc', 'codex', 'pi', 'checkpoint', 'permission_push'] as const)
  test(`返修1-2 ${scenario}：两次扫描间接话并有新回复，仍结算原等待；新回合独立计时`, async t => {
    const f = await fixture(t), tool = scenario === 'codex' || scenario === 'pi' ? scenario : 'cc';
    const newAt = at(3 + 1 / 6);
    const answer = (time: string, text: string) => { const row = ccAnswer(time); row.message.content[0]!.text = text; return row; };
    const question = '缓存保留多久？', nextQuestion = '新一轮超时设置多少？';
    f.config.sources = { cc: null, codex: null, pi: null, loop: null }; f.config.sources[tool] = join(f.root, tool);
    const file = join(f.config.sources[tool]!, 'sample.jsonl');
    const initial = tool === 'cc' ? [ccUser('给商品列表加缓存', at(-20)), scenario === 'permission_push' ? ccCall(at(0)) : answer(at(0), question)]
      : tool === 'codex' ? [codexMeta(), codexEvent({ type: 'user_message', message: '给商品列表加缓存' }, 'event_msg', at(-20)),
        codexEvent({ type: 'task_complete', last_agent_message: question }, 'event_msg', at(0))]
        : [piHeader(), piMessage('u0', null, 'user', '给商品列表加缓存', at(-20)), piMessage('a0', 'u0', 'assistant', question, at(0))];
    const later = tool === 'cc' ? [ccUser('保留十分钟', at(3)), answer(newAt, nextQuestion)]
      : tool === 'codex' ? [codexEvent({ type: 'user_message', message: '保留十分钟' }, 'event_msg', at(3)),
        codexEvent({ type: 'task_complete', last_agent_message: nextQuestion }, 'event_msg', newAt)]
        : [piMessage('u1', 'a0', 'user', '保留十分钟', at(3)), piMessage('a1', 'u1', 'assistant', nextQuestion, newAt)];
    await put(file, initial);
    if (scenario === 'permission_push') {
      f.config.judge = null;
      await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(file, 'waiting_permission', at(0))]);
    }
    await detect(f.config, at(1));
    const scope = scenario === 'permission_push' ? 'notice' : 'model_check';
    assert.ok((await readEvents(f.config.dataDir)).some(e => e.kind === 'notice_suppressed' && e.reason === 'waiting_interval' && e.evidenceAt === at(0) && e.scope === scope));
    if (scenario === 'checkpoint') {
      const state = packProjection(project(await readEvents(f.config.dataDir)));
      const archive = `events-000000000001-${hash('constructed-checkpoint')}.jsonl.gz`;
      await put(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'store_checkpoint', format: 2, sequence: 1, archive, archives: [archive], state }, at(1))]);
      await rm(join(f.config.dataDir, 'state.json')); await rebuild(f.config, at(1));
    }
    await appendFile(file, later.map(row => JSON.stringify(row)).join('\n') + '\n');
    if (scenario === 'permission_push') await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(file, 'waiting_permission', at(0)),
      { ...pushed(file, 'turn_end', newAt), detail: nextQuestion }]);
    await detect(f.config, at(4));
    const events = await readEvents(f.config.dataDir);
    const cancelled = events.filter(e => e.kind === 'notice_suppressed' && e.reason === 'user_replied' && e.evidenceAt === at(0) && e.scope === scope);
    assert.equal(cancelled.length, 1);
    const decision = cancelled[0]!; assert.ok(decision.kind === 'notice_suppressed');
    assert.equal(decision.reply?.at, at(3));
    assert.deepEqual(await readJsonl(f.capture), []); assert.deepEqual(await readOutbox(f.config.dataDir), []);
    if (scenario !== 'permission_push') {
      assert.ok(events.some(e => e.kind === 'notice_suppressed' && e.reason === 'waiting_interval' && e.evidenceAt === newAt));
      await detect(f.config, at(8 + 1 / 6));
      const notices = await readOutbox(f.config.dataDir);
      assert.equal(notices.length, 1); assert.equal(notices[0]!.evidenceAt, newAt);
      assert.ok(checks(await readEvents(f.config.dataDir)).every(e => e.check.evidenceAt === newAt));
    }
    await detect(f.config, at(9));
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'notice_suppressed' && e.reason === 'user_replied' && e.evidenceAt === at(0) && e.scope === scope).length, 1);
  });

test('返修1-2：没有接话的新输出结清旧窗口，后续接话不串到更早一轮', async t => {
  const f = await fixture(t), nextAt = at(3 + 1 / 6), latestAt = at(6 + 1 / 6);
  await detect(f.config, at(1));
  await appendFile(f.file, JSON.stringify(ccAnswer(nextAt)) + '\n');
  await detect(f.config, at(4));
  const waiting = (await rebuild(f.config, at(4))).projection.waitingWindows;
  assert.ok([...waiting.values()].every(window => window.evidenceAt !== at(0)));
  await appendFile(f.file, [ccUser('保留十分钟', at(6)), ccAnswer(latestAt)].map(row => JSON.stringify(row)).join('\n') + '\n');
  await detect(f.config, at(7));
  const replied = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'notice_suppressed' && e.reason === 'user_replied');
  assert.ok(replied.some(e => e.kind === 'notice_suppressed' && e.evidenceAt === nextAt));
  assert.ok(!replied.some(e => e.kind === 'notice_suppressed' && e.evidenceAt === at(0)));
  // 无真人接话的新执行材料仍按原规则即时查跑偏，不能为埋点改成禁止所有模型调用。
  assert.deepEqual(checks(await readEvents(f.config.dataDir)).map(e => e.check.task), ['drift']);
  assert.equal((await readJsonl(f.capture)).length, 1); assert.deepEqual(await readOutbox(f.config.dataDir), []);
});
