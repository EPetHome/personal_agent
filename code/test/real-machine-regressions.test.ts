// 真机问题的构造回归：临时目录、假模型、假通知，不接触真实个人数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { readEvents, readJsonl, readOutbox } from '../src/core/store.ts';
import { receiveFeedback } from '../src/core/feedback.ts';
import { acquireLock } from '../src/core/locks.ts';
import { removeEntries } from '../src/hooks/config-edits.ts';
import { ComponentFailure } from '../src/core/process.ts';
import { boundedContext } from '../src/core/model.ts';
import { emitPush, pushReplyExcerpt } from '../src/hooks/protocol.ts';
import { installListener } from '../src/hooks/install.ts';
import type { ListenerAPI } from '../src/hooks/pi/index.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, loopSummary, piHeader, piMessage, pushed, put, sandbox } from './fixtures.ts';
import type { Judge, JudgmentContext, JudgmentResult } from '../src/core/types.ts';

const now = '2026-10-20T10:06:00Z'; // 模型/渠道回归在五分钟等待之后。
const no: JudgmentResult = { answer: '否', reason: '完成而非提问' };
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.judge = { executable: '/test-only/no-real-model', model: 'test/fake', dailyLimit: 100, timeoutMs: 5000, cycleTimeoutMs: 10000 };
  const transcript = join(f.config.sources.cc!, 'session.jsonl');
  const answer = ccAnswer(); answer.message.content[0]!.text = '你要选择 A 还是 B？';
  await put(transcript, [ccUser(), answer]);
  return { ...f, transcript };
}

test('真机 A1（本批兜底更新）：失败先按明确问题提醒，下一轮重试不重发；失败类别、每日上限保留', async t => {
  const { config } = await fixture(t);
  let waitingCalls = 0;
  const judge: Judge = { async judge(request) {
    if (request.task !== 'waiting') return no;
    if (++waitingCalls === 1) throw new ComponentFailure('exit', '命令退出码 17');
    return { answer: '是', reason: '需要选择才能继续' };
  } };
  const first = await detect(config, now, { judge });
  assert.equal(first.noticesAdded, 1);
  const failed = (await readEvents(config.dataDir)).find(e => e.kind === 'model_checked' && e.check.task === 'waiting');
  assert.ok(failed?.kind === 'model_checked');
  assert.deepEqual(failed.check.failure, { category: 'exit', detail: '命令退出码 17' });
  const prefix = await readFile(join(config.dataDir, 'events.jsonl'), 'utf8');
  const second = await detect(config, '2026-10-20T10:07:00Z', { judge });
  assert.equal(second.records[0]?.status, '在等我'); assert.equal(second.noticesAdded, 0);
  await detect(config, '2026-10-20T10:08:00Z', { judge });
  assert.equal(waitingCalls, 2); assert.equal((await readOutbox(config.dataDir)).length, 1);
  assert.ok((await readFile(join(config.dataDir, 'events.jsonl'), 'utf8')).startsWith(prefix));

  const capped = await fixture(t); capped.config.judge!.dailyLimit = 1;
  let calls = 0;
  const failing: Judge = { async judge() { calls++; throw new Error('不得记入日志的原始错误'); } };
  await detect(capped.config, now, { judge: failing });
  await detect(capped.config, '2026-10-20T10:02:00Z', { judge: failing });
  assert.equal(calls, 1);
  assert.ok(!(await readFile(join(capped.config.dataDir, 'events.jsonl'), 'utf8')).includes('不得记入日志'));
});

test('真机 A1：实际子进程替身的退出码、超时、解析和答案字段失败可区分，输出不泄露', async t => {
  for (const [category, body] of [
    ['exit', 'console.error("SYNTHETIC_SECRET");process.exit(17)'],
    ['timeout', 'setTimeout(()=>{},10000)'],
    ['parse', 'console.log("SYNTHETIC_SECRET")'],
    ['invalid_answer', 'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:JSON.stringify({answer:"maybe",reason:"SYNTHETIC_SECRET"})}]}}))'],
  ]) {
    const { root, config } = await fixture(t);
    const command = join(root, 'fake-pi');
    await writeFile(command, `#!${process.execPath}\n${body}\n`); await chmod(command, 0o700);
    config.judge!.executable = command; config.judge!.timeoutMs = category === 'timeout' ? 500 : 5000;
    await detect(config, now);
    const checks = (await readEvents(config.dataDir)).filter(e => e.kind === 'model_checked');
    assert.ok(checks.every(e => e.kind === 'model_checked' && e.check.failure?.category === category), `${category}: ${JSON.stringify(checks)}`);
    assert.ok(checks.length > 0);
    assert.ok(!(await readFile(join(config.dataDir, 'events.jsonl'), 'utf8')).includes('SYNTHETIC_SECRET'));
  }
});

test('真机 A2：推送先到、下一轮文件出现，两轮不报失明；超过两轮仍按紧急失明报', async t => {
  for (const appears of [true, false]) {
    const { config, transcript } = await fixture(t); config.judge = null;
    await rm(transcript);
    await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript, 'turn_end')]);
    const first = await detect(config, now);
    assert.equal(first.noticesAdded, 0); assert.equal(first.projection.pushes.length, 0);
    await rebuild(config); await overview(config); // 重建/查询不消耗检测轮数。
    if (appears) await put(transcript, [ccUser(), ccAnswer()]);
    const second = await detect(config, '2026-10-20T10:02:00Z');
    assert.equal(second.noticesAdded, 0); assert.equal(second.projection.pushes.length, appears ? 1 : 0);
    const third = await detect(config, '2026-10-20T10:03:00Z');
    assert.equal(third.noticesAdded, appears ? 0 : 1);
    if (!appears) {
      const [notice] = await readOutbox(config.dataDir);
      assert.equal(notice?.kind, 'blind'); assert.equal(notice?.level, '现在就要你');
      await put(transcript, [ccUser(), ccAnswer()]);
      assert.equal((await detect(config, '2026-10-20T10:04:00Z')).projection.health.get('cc')?.since, null);
    }
  }
});

test('真机 A2：空文件也只有两轮宽限；错误项目/路径不借宽限通过对账', async t => {
  const { config, transcript } = await fixture(t); config.judge = null;
  await put(transcript, ''); await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript)]);
  assert.equal((await detect(config, now)).noticesAdded, 0);
  assert.equal((await detect(config, '2026-10-20T10:02:00Z')).noticesAdded, 0);
  assert.equal((await detect(config, '2026-10-20T10:03:00Z')).noticesAdded, 1);
});

test('真机 A6：20个一小时内旧完成会话前面排队，新停下的问句在本轮先判断', async t => {
  const { config, transcript } = await fixture(t);
  const newest = ccAnswer('2026-10-20T10:00:59Z'); newest.message.content[0]!.text = '新问题：选择 A 还是 B？';
  await put(transcript, [ccUser(), newest]);
  for (let i = 0; i < 20; i++) await put(join(config.sources.cc!, `old-${i}.jsonl`),
    [ccUser('旧任务', '2026-10-20T09:30:00Z'), ccAnswer('2026-10-20T09:31:00Z')].map(r => ({ ...r, sessionId: `old-${i}`, cwd: '/sample/aaa-old' })));
  const latency = Number(process.env.PA_TEST_MODEL_DELAY_MS ?? 30);
  config.judge!.cycleTimeoutMs = latency >= 1000 ? 60000 : 100;
  config.judge!.timeoutMs = latency >= 1000 ? 30000 : 100;
  // 本条验模型排序，不把并发门禁中的真实磁盘耗时当模型耗时。
  // 预算仍是原值，只由替身推进时钟；真实超时/取消由 model-scheduling 回归覆盖。
  let modelElapsed = 0;
  const epoch = Date.now();
  t.mock.method(Date, 'now', () => epoch + modelElapsed);
  t.mock.method(performance, 'now', () => modelElapsed);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const order: string[] = [];
  const judge: Judge = { async judge(request) {
    order.push(`${request.task}:${request.context.assistantReply}`);
    modelElapsed += latency; t.mock.timers.tick(latency);
    return request.task === 'waiting' && request.context.assistantReply.startsWith('新问题') ? { answer: '是', reason: '需要选择' } : no;
  } };
  const view = await detect(config, now, { judge });
  assert.match(order[0]!, /^waiting:新问题/);
  const newestRecord = view.records.find(r => r.sessionId === 'demo-cc')!;
  assert.equal(newestRecord.status, '在等我');
  assert.equal(newestRecord.modelWaiting?.result.answer, '是', '必须实际先完成新问题的模型判断，不能靠规则兜底混过');
  if (latency < 1000) assert.ok(view.records.some(r => r.modelNotes?.includes('本轮模型时限用完，仅规则判断')), '其余候选仍受原预算限制');
  assert.ok(order.length <= Math.ceil(config.judge!.cycleTimeoutMs! / latency), '不扩大原模型预算');
  assert.equal(view.projection.modelCalls.get('2026-10-20'), order.length);
  assert.equal((await readOutbox(config.dataDir)).filter(n => n.kind === 'waiting').length, 1);
});

for (const previous of ['toolResult', 'context_edit']) test(`真机 A5：助手单一缺父接前行 ${previous}，意图和完成状态可读；其他缺口仍失败`, async t => {
  const { root, config } = await fixture(t); config.judge = null; config.sources.cc = null; config.sources.pi = join(root, 'pi');
  const rows = [piHeader(), piMessage('u', null, 'user', '构造的开工意图'),
    piMessage('a', 'u', 'assistant', [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'echo test' } }], undefined, { stopReason: 'toolUse' }),
    piMessage('r', 'a', 'toolResult', 'done', undefined, { toolCallId: 'call' }),
    ...(previous === 'context_edit' ? [{ type: 'context_edit', id: 'c', parentId: 'r', timestamp: '2026-10-20T10:00:00Z' }] : []),
    piMessage('orphan', 'never-written', 'assistant', '已完成')];
  const path = join(config.sources.pi, 'session.jsonl');
  await put(path, rows);
  const view = await detect(config, now);
  assert.equal(view.records[0]?.intent.initial, '构造的开工意图'); assert.equal(view.records[0]?.status, '已完成');
  assert.equal(view.noticesAdded, 0); assert.equal(view.records[0]?.pendingTools.length, 0);
  for (const invalid of [
    [piHeader(), piMessage('u', null, 'user', '任务'), piMessage('a', 'missing', 'assistant', '完成')],
    [...rows, piMessage('second', 'another-missing', 'assistant', '完成')],
    [...rows.slice(0, -1), piMessage('bad-user', 'missing', 'user', '用户不能接前行')],
  ]) {
    await put(path, invalid);
    assert.equal((await detect(config, '2026-10-20T10:02:00Z')).records[0]?.status, '看不见了');
    assert.ok((await readOutbox(config.dataDir)).some(n => ['blind', 'unreadable'].includes(n.kind)));
  }
  await put(path, rows); await appendFile(path, '{"type":"message"');
  assert.equal((await detect(config, '2026-10-20T10:03:00Z')).records[0]?.status, '看不见了', '半行文件仍不能读，只保留最后事实');
});

test('真机 A7：loop 小问题、额外发现和人工欠项合并列出；确无欠项写无', async t => {
  const { root, config } = await fixture(t); config.judge = null; config.sources.cc = null; config.sources.loop = join(root, 'loop');
  const path = join(config.sources.loop, 'project', '00000000-0000-4000-8000-000000000001.md');
  const base = loopSummary('完成').replace(/## 需要你做的事\n[^\n]*\n/, '');
  await put(path, base + '\n## 小问题汇总\n| # | 问题 |\n| --- | --- |\n| 1 | 构造的文案问题 |\n## 验收额外发现\n- 构造的额外发现\n- [x] 已完成的事项\n## 验收结果\n- A10. [人工] 看真机提醒\n');
  await detect(config, now);
  const [first] = await readOutbox(config.dataDir);
  assert.equal(first?.kind, 'loop_completed');
  for (const text of ['构造的文案问题', '构造的额外发现', '[人工] 看真机提醒']) assert.ok(first?.content.evidence.needs?.some(n => n.includes(text)));
  assert.ok(!first?.text.includes('总结里没写')); assert.ok(!first?.text.includes('已完成的事项'));
  await put(path, loopSummary('完成', '/sample/real-project', '- 无', '2026-10-20T10:02:00Z').replace(/## 需要你做的事\n[^\n]*\n/, ''));
  await detect(config, '2026-10-20T10:03:00Z');
  const last = (await readOutbox(config.dataDir)).at(-1)!;
  assert.deepEqual(last.content.evidence.needs, []); assert.match(last.text, /还欠什么：无/);
});

for (const tool of ['cc', 'codex', 'pi'] as const) test(`真机 A8：${tool} 长表格后提问，本机四段文案保留原问题，无内部路径/理由/表格/重复/叠标点`, async t => {
  const { root, config, transcript } = await fixture(t);
  const question = '请你确认要选择 A 还是 B？';
  const reply = '已整理好了。。\n| 方案 | 内容 |\n| --- | --- |\n' + '| A | 构造条目 |\n'.repeat(200)
    + '\n```ts\nconst hidden = "不是要问你的问题？";\n```\n' + question + '\n' + question;
  config.sources.cc = tool === 'cc' ? config.sources.cc : null;
  if (tool === 'cc') { const answer = ccAnswer(); answer.message.content[0]!.text = reply; await put(transcript, [ccUser(), answer]); }
  else if (tool === 'codex') {
    config.sources.codex = join(root, 'codex');
    await put(join(config.sources.codex, 'session.jsonl'), [codexMeta(), codexEvent({ type: 'user_message', message: '构造的任务' }), codexEvent({ type: 'task_complete', last_agent_message: reply })]);
  } else {
    config.sources.pi = join(root, 'pi');
    await put(join(config.sources.pi, 'session.jsonl'), [piHeader(), piMessage('u', null, 'user', '构造的任务'), piMessage('a', 'u', 'assistant', reply)]);
  }
  const log = join(root, 'notifications.jsonl'), command = join(root, 'fake-notification');
  await writeFile(command, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\n`); await chmod(command, 0o700);
  config.localChannel = { executable: command, timeoutMs: 5000 };
  await detect(config, now, { judge: { async judge(r) { return r.task === 'waiting' ? { answer: '是', reason: 'MODEL_REASON_EVIDENCE_ONLY' } : no; } } });
  const calls = await readJsonl<string[]>(log); assert.equal(calls.length, 1);
  const body = calls[0]!.at(-1)!;
  assert.match(body.split('\n')[0]!, /^这件事：/);
  assert.equal(body.split('\n')[2], `要你做：【回复会话】${question}（共 1 件）`);
  assert.equal(body.split(question).length - 1, 1);
  assert.match(body.split('\n')[4]!, /^时间 \/ 回去看：/);
  assert.ok(!/\/sample|\||MODEL_REASON|。。/.test(body.split('\n时间 / 回去看：')[0]!));
  assert.ok((await readOutbox(config.dataDir))[0]?.content.evidence.reason.includes('MODEL_REASON_EVIDENCE_ONLY'));
});

test('真机 A9（反馈与卡片批更新）：检测持锁时实际 feedback CLI 已记下，不再等检测结束', async t => {
  const { root, config, transcript } = await fixture(t); config.judge = null;
  await put(transcript, [ccUser(), ccCall()]); await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript)]);
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const running = detect(config, now, { channels: [{ name: 'local', async send() { started(); await release; }, receive: reply => receiveFeedback(config.dataDir, 'local', reply) }] });
  await entered;
  const configPath = join(root, 'config.json'); await put(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/cli/main.ts'), 'feedback', '误报', '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exited = false;
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => { exited = true; resolve(code); }); });
  t.after(() => { if (!exited) child.kill('SIGKILL'); finish(); });
  try {
    assert.equal(await Promise.race([done, delay(5000).then(() => 'timeout')]), 0, stderr);
    assert.match(stdout.trim(), /^已记下：这个会话之后不会再/); assert.equal(stderr, '');
    assert.equal((await readJsonl(join(config.dataDir, 'feedback.jsonl'))).length, 1);
    assert.ok(await readFile(join(config.dataDir, '.detect.lock/owner.json'), 'utf8'));
  } finally { finish(); await running; }
  assert.equal((await readJsonl(join(config.dataDir, 'feedback.jsonl'))).length, 1);
});

test('真机 A9（反馈与卡片批更新）：反馈专锁异常占用仍不清活锁/未知锁、不假称记下', async t => {
  const { config } = await fixture(t);
  const release = await acquireLock(config.dataDir, '.feedback.lock');
  try {
    await assert.rejects(receiveFeedback(config.dataDir, 'local', { content: '漏了 构造反馈', at: now }, 80), error => {
      assert.match((error as Error).message, /尚未记下.*检查本机服务/); assert.ok(!(error as Error).message.includes('人工恢复')); return true;
    });
    assert.equal((await readJsonl(join(config.dataDir, 'feedback.jsonl'))).length, 0);
    assert.ok(await readFile(join(config.dataDir, '.feedback.lock/owner.json'), 'utf8'));
  } finally { await release(); }
});

test('真机 A4：Codex 定点删表保留多行字符串里的同名表、注释和其他插件', () => {
  const text = 'model = "after"\nnotes = """\n[plugins."message-listener@personal-agent-local"]\ninside = "keep"\n"""\n'
    + "[marketplaces.'personal-agent-local'] # own\nsource_type = 'local'\n"
    + '[plugins."message-listener@personal-agent-local"]\nenabled = true\n'
    + '[plugins.other]\nenabled = true # keep\n';
  const result = removeEntries('codex', '.codex/config.toml', text, '', 'model = "before"\n')!;
  assert.ok(result.includes('inside = "keep"')); assert.ok(result.includes('[plugins.other]')); assert.ok(result.includes('# keep'));
  assert.ok(!result.includes('source_type')); assert.ok(!result.includes('[marketplaces.'));
});

for (const tool of ['cc', 'codex', 'pi'] as const) test(`返修1-1：${tool} 有效长回复推送→真实模型边界替身收到尾部问题→本机通知原问题`, async t => {
  const { root, config, transcript } = await fixture(t);
  const at = new Date(Date.now() - 1000).toISOString();
  const question = '请你确认最后采用蓝色方案还是绿色方案？';
  const reply = 'PUSH_HEAD：这是钩子收到的完整回复。\n| 方案 | 说明 |\n| --- | --- |\n'
    + '| 蓝色 | 构造条目😀 |\n'.repeat(500) + '\n' + question;
  assert.ok([...reply].length > 4000 && reply.indexOf(question) > 4000);
  // 文件已可对账，但尚未写到推送中的问题；不能靠文件正文绕过推送链路断言。
  const fileReply = '会话文件里当前只有普通的完成汇报。';
  let path = transcript, sessionId = 'demo-cc', project = '/sample/project';
  config.sources.cc = tool === 'cc' ? config.sources.cc : null;
  if (tool === 'cc') {
    const answer = ccAnswer(at); answer.message.content[0]!.text = fileReply;
    await put(path, [ccUser('构造的任务', at), answer]);
  } else if (tool === 'codex') {
    config.sources.codex = join(root, 'codex'); path = join(config.sources.codex, 'session.jsonl');
    sessionId = 'demo-codex'; project = '/sample/codex';
    const meta = codexMeta(); meta.timestamp = at; meta.payload.timestamp = at;
    await put(path, [meta, codexEvent({ type: 'user_message', message: '构造的任务' }, 'event_msg', at),
      codexEvent({ type: 'task_complete', last_agent_message: fileReply }, 'event_msg', at)]);
  } else {
    config.sources.pi = join(root, 'pi'); path = join(config.sources.pi, 'session.jsonl');
    sessionId = 'demo-pi'; project = '/sample/pi';
    const header = piHeader(); header.timestamp = at;
    await put(path, [header, piMessage('u', null, 'user', '构造的任务', at), piMessage('a', 'u', 'assistant', fileReply, at)]);
  }
  if (tool === 'pi') {
    // 安装到临时 HOME，再加载实际生成的独立扩展，防止漏测打包资源/提前截断。
    const home = join(root, 'temporary-pi-home');
    await installListener({ home, tool, inboxDir: config.inboxDir! });
    const register: (api: ListenerAPI) => void = (await import(pathToFileURL(join(home, '.message-listener/pi/message-listener.ts')).href)).default;
    const handlers = new Map<string, Parameters<ListenerAPI['on']>[1]>();
    register({ on(name, handler) { handlers.set(name, handler); }, events: { on() {} } });
    const ctx = { cwd: project, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => path } };
    handlers.get('session_start')!({}, ctx);
    handlers.get('message_end')!({ message: { role: 'assistant', stopReason: 'stop', content: [
      { type: 'text', text: reply.slice(0, 3000) }, { type: 'text', text: reply.slice(3000) },
    ] } }, ctx);
    handlers.get('agent_settled')!({}, ctx);
  } else emitPush(tool, { hook_event_name: 'Stop', session_id: sessionId, cwd: project, transcript_path: path,
    at: new Date().toISOString(), last_assistant_message: reply }, config.inboxDir!);
  const [push] = await readJsonl<{ event: string; at: string; detail: string }>(join(config.inboxDir!, `${tool}.jsonl`));
  assert.equal(push?.event, 'turn_end');
  assert.ok([...push!.detail].length <= 4000);
  assert.ok(push!.detail.startsWith('PUSH_HEAD') && push!.detail.endsWith(question), '实际落盘推送必须保留首尾');

  const modelLog = join(root, 'model-contexts.jsonl'), fakeModel = join(root, 'fake-pi-judge');
  await writeFile(fakeModel, `#!${process.execPath}\nlet prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{const context=JSON.parse(prompt.slice(prompt.indexOf('材料：\\n')+4));require('node:fs').appendFileSync(${JSON.stringify(modelLog)},JSON.stringify(context)+'\\n');const answer={answer:context.assistantReply.includes(${JSON.stringify(question)})?'是':'否',reason:'测试仅在实际收到末尾问题时答是'};console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}]}}));});\n`);
  await chmod(fakeModel, 0o700); config.judge!.executable = fakeModel;
  const notifications = join(root, 'notifications.jsonl'), notify = join(root, 'fake-notification');
  await writeFile(notify, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(notifications)},JSON.stringify(process.argv.slice(2))+'\\n');\n`);
  await chmod(notify, 0o700); config.localChannel = { executable: notify, timeoutMs: 5000 };
  const ready = new Date(Date.parse(push!.at) + 5 * 60000).toISOString();
  const view = await detect(config, ready);
  assert.equal(view.projection.pushes.length, 1, '必须是实际通过对账的推送');
  const contexts = await readJsonl<JudgmentContext>(modelLog);
  const waiting = contexts.filter(context => context.assistantReply);
  assert.equal(waiting.length, 1);
  assert.ok(waiting[0]!.assistantReply.startsWith('PUSH_HEAD') && waiting[0]!.assistantReply.endsWith(question), '模型真实 stdin 经过两次上下文限长仍保留问题');
  assert.ok([...waiting[0]!.assistantReply].length <= 1200);
  assert.equal(view.records[0]?.status, '在等我');
  assert.equal(view.records[0]?.modelWaiting?.evidenceAt, push!.at);
  assert.equal((await readJsonl<string[]>(notifications))[0]?.at(-1)?.split('\n')[2], `要你做：【回复会话】${question}（共 1 件）`, '通知不能退化为默认占位话');
  assert.equal((await readOutbox(config.dataDir))[0]?.content.summary.split('\n')[2], `要你做：1.【回复会话】${question}`);
  await detect(config, ready);
  assert.equal((await readJsonl(modelLog)).length, contexts.length, '成功判断空跑不重调');
  assert.equal((await readJsonl(notifications)).length, 1, '同一条提醒继续去重');
});

test('返修1-1：1200/4000 字边界、Unicode 和多次有界压缩均保留首尾', () => {
  for (const count of [0, 1100, 1199, 1200, 1201, 3999, 4000, 4001, 10000]) {
    const reply = 'HEAD：\n' + '😀'.repeat(count) + '\n请你选择蓝色还是绿色？';
    const pushed = pushReplyExcerpt(reply);
    const context: JudgmentContext = { intentOriginal: null, additionalRequirements: [], previousSummary: '', newSteps: [], assistantReply: pushed };
    const once = boundedContext(context), twice = boundedContext(once);
    assert.ok([...pushed].length <= 4000); assert.ok([...once.assistantReply].length <= 1200);
    assert.ok(pushed.startsWith('HEAD：') && once.assistantReply.startsWith('HEAD：'));
    assert.ok(pushed.endsWith('请你选择蓝色还是绿色？') && once.assistantReply.endsWith('请你选择蓝色还是绿色？'));
    assert.equal(twice.assistantReply, once.assistantReply);
    assert.equal(Buffer.from(once.assistantReply, 'utf8').toString('utf8'), once.assistantReply, '不留下半个代理对');
  }
});
