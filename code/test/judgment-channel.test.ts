import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { renderOverview } from '../src/core/judge.ts';
import { piJudge, boundedContext } from '../src/core/model.ts';
import { evaluate } from '../src/core/evaluate.ts';
import { readEvents, readJsonl, readOutbox } from '../src/core/store.ts';
import { receiveFeedback } from '../src/core/feedback.ts';
import { localChannel } from '../src/channels/local/index.ts';
import { ccUser, ccCall, ccAnswer, codexMeta, codexEvent, put, pushed, sandbox } from './fixtures.ts';
import type { Feedback, Judge, JudgmentRequest, JudgmentResult } from '../src/core/types.ts';

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.judge = { executable: '/test-only/no-real-model', model: 'test/fake', dailyLimit: 20, timeoutMs: 1000 };
  const transcript = join(f.config.sources.cc!, 'session.jsonl');
  return { ...f, transcript };
}
function stubJudge(answer: (r: JudgmentRequest) => JudgmentResult | Promise<JudgmentResult>) {
  const calls: JudgmentRequest[] = [];
  const judge: Judge = { async judge(request) { calls.push(request); return answer(request); } };
  return { calls, judge };
}
const no: JudgmentResult = { answer: '否', reason: '没有发现' };
async function executable(path: string, body: string) { await writeFile(path, `#!${process.execPath}\n${body}\n`); await chmod(path, 0o700); }

test('A5 推送→规则等待→发件→本机通知一次；模型不取代权限规则，有空看不弹', async t => {
  const { root, config, transcript } = await fixture(t);
  const log = join(root, 'notifications.jsonl');
  const command = join(root, 'notify-stub');
  await executable(command, `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');`);
  config.localChannel = { executable: command, timeoutMs: 5000 };
  const { judge, calls } = stubJudge(() => no);
  await put(transcript, [ccUser(), ccCall()]);
  await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript)]);
  const first = await detect(config, '2026-10-20T10:06:00Z', { judge });
  assert.equal(first.records[0]?.status, '在等我'); assert.equal(calls.length, 0);
  const notice = (await readOutbox(config.dataDir))[0]!;
  assert.equal(notice.level, '现在就要你');
  for (const text of ['Claude Code', '/sample/project', '意图', '做到哪了', '允许执行 npm test 吗']) assert.ok(notice.text.includes(text));
  const notifications = await readJsonl<string[]>(log);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.at(-2), notice.content.title);
  assert.ok(!notifications[0]!.join('').includes(notice.id));
  await detect(config, '2026-10-20T10:02:00Z', { judge });
  assert.equal((await readJsonl(log)).length, 1);
  await localChannel(config.dataDir, config.localChannel).send({ ...notice, level: '有空看' });
  assert.equal((await readJsonl(log)).length, 1);
});

test('A6 可核对的意图与新步骤才发可能跑偏；10分钟、新动静、查询不调用模型', async t => {
  const { config, transcript } = await fixture(t);
  await put(transcript, [ccUser('只改 A 文件'), ccCall(undefined, 'b', '修改不相关的 B 模块')]);
  const { judge, calls } = stubJudge(r => r.task === 'drift' ? { answer: '是', reason: 'A 的范围不包含 B', intentQuote: '只改 A 文件', stepQuote: '修改不相关的 B 模块' } : no);
  const first = await detect(config, '2026-10-20T10:01:00Z', { judge });
  assert.equal(first.records[0]?.status, '疑似跑偏');
  const notice = (await readOutbox(config.dataDir))[0]!;
  assert.equal(notice.kind, 'drift'); assert.equal(notice.level, '现在就要你');
  assert.match(notice.content.summary, /这件事：只改 A 文件.*实际.*B 模块.*可能偏离/);
  assert.match(notice.content.evidence.reason, /只改 A 文件.*修改不相关的 B 模块/);
  await detect(config, '2026-10-20T10:02:00Z', { judge });
  assert.equal(calls.length, 1);
  await appendFile(transcript, JSON.stringify(ccCall('2026-10-20T10:05:00Z', 'b2', '修改不相关的 B 模块的测试')) + '\n');
  const cooled = await detect(config, '2026-10-20T10:06:00Z', { judge });
  assert.equal(calls.length, 1); assert.match(cooled.records[0]?.modelNotes?.join('') ?? '', /间隔未到/);
  await detect(config, '2026-10-20T10:11:00Z', { judge });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.context.newSteps.length, 1);
  assert.ok(calls[1]!.context.previousSummary.includes('B 模块'));
  assert.equal((await overview(config)).records[0]?.status, '疑似跑偏');
  await rebuild(config); assert.equal(calls.length, 2);
});

test('A7 是但缺意图原句/步骤/伪造引文均按否；后来追加要求可改变方向', async t => {
  for (const result of [
    { answer: '是', reason: '看起来偏了', stepQuote: 'B 模块' },
    { answer: '是', reason: '偏了', intentQuote: '只改 A 文件' },
    { answer: '是', reason: '编造引文', intentQuote: '只改 C', stepQuote: 'B 模块' },
  ] as JudgmentResult[]) {
    const { config, transcript } = await fixture(t);
    await put(transcript, [ccUser('只改 A 文件'), ccCall(undefined, 'b', '修改 B 模块')]);
    await detect(config, '2026-10-20T10:01:00Z', { judge: stubJudge(() => result).judge });
    assert.equal((await readOutbox(config.dataDir)).filter(n => n.kind === 'drift').length, 0);
  }
  const { config, transcript } = await fixture(t);
  await put(transcript, [ccUser('只改 A 文件'), ccUser('顺便改 B'), ccCall(undefined, 'b', '修改 B 模块')]);
  const { judge, calls } = stubJudge(r => { assert.deepEqual(r.context.additionalRequirements, ['顺便改 B']); return no; });
  await detect(config, '2026-10-20T10:01:00Z', { judge });
  assert.equal(calls.length, 1); assert.deepEqual(await readOutbox(config.dataDir), []);
});

test('A8 助手答完的问句模型是→等待，否→完成；新用户要求清除旧模型等待', async t => {
  for (const waiting of [true, false]) {
    const { config, transcript } = await fixture(t);
    const answer = ccAnswer(); answer.message.content[0]!.text = '使用 A 方案还是 B 方案？';
    await put(transcript, [ccUser(), answer]);
    const { judge, calls } = stubJudge(r => r.task === 'waiting' && waiting ? { answer: '是', reason: '需要你选择方案才能继续' } : no);
    const view = await detect(config, '2026-10-20T10:06:00Z', { judge });
    assert.equal(view.records[0]?.status, waiting ? '在等我' : '已完成');
    const notices = await readOutbox(config.dataDir);
    assert.equal(notices.length, waiting ? 1 : 0);
    if (waiting) { assert.match(notices[0]!.content.title, /可能/); assert.equal(notices[0]!.content.summary.split('\n')[2], '要你做：1.【回复会话】使用 A 方案还是 B 方案？'); assert.ok(!notices[0]!.text.includes(notices[0]!.id)); }
    await detect(config, '2026-10-20T10:07:00Z', { judge }); assert.equal(calls.length, 2);
    await appendFile(transcript, JSON.stringify(ccUser('选 A，继续', '2026-10-20T10:08:00Z')) + '\n');
    assert.equal((await detect(config, '2026-10-20T10:09:00Z', { judge })).records[0]?.status, '进行中');
  }
});

test('模型子成员等待保留真实回看/回复；忽略子项目后不再恢复该等待', async t => {
  const { root, config } = await fixture(t);
  config.sources.cc = null; config.sources.codex = join(root, 'codex');
  await put(join(config.sources.codex, 'parent.jsonl'), [codexMeta(), codexEvent({ type: 'user_message', message: '父任务' }), codexEvent({ type: 'function_call', call_id: 'parent-tool', name: 'shell', arguments: '{"command":"父任务仍进行中"}' }, 'response_item')]);
  const child = codexMeta('child', 'demo-codex'); child.payload.cwd = '/sample/child-project';
  await put(join(config.sources.codex, 'child.jsonl'), [child, codexEvent({ type: 'user_message', message: '子任务' }), codexEvent({ type: 'task_complete', last_agent_message: '请你选择使用哪个方案？' })]);
  const { judge } = stubJudge(r => r.task === 'waiting' ? { answer: '是', reason: '需要你选择方案' } : no);
  const view = await detect(config, '2026-10-20T10:06:00Z', { judge });
  assert.equal(view.records[0]?.status, '在等我');
  const notice = (await readOutbox(config.dataDir))[0]!;
  assert.equal(notice.memberSessionId, 'child'); assert.match(notice.content.returnCommand, /resume child/);
  assert.match(notice.content.summary, /请你选择使用哪个方案/);
  config.ignoreProjectPrefixes = ['/sample/child-project'];
  assert.equal((await overview(config)).records[0]?.status, '进行中');
  assert.ok(!(await overview(config)).projection.notices.some(n => n.memberSessionId === 'child'));
});

test('首次历史完成不耗模型额度；有新动静才调，模型等待超过24小时也已搁置', async t => {
  const { config, transcript } = await fixture(t);
  const { judge, calls } = stubJudge(r => r.task === 'waiting' ? { answer: '是', reason: '请用户选择' } : no);
  await put(transcript, [ccUser('旧的构造任务', '2026-10-20T08:00:00Z'), ccAnswer('2026-10-20T08:01:00Z')]);
  assert.equal((await detect(config, '2026-10-20T10:01:00Z', { judge })).records[0]?.status, '已完成');
  assert.equal(calls.length, 0);
  const answer = ccAnswer('2026-10-20T10:02:00Z'); answer.message.content[0]!.text = '请你选择方案？';
  await appendFile(transcript, [ccUser('现在继续只改 A', '2026-10-20T10:02:00Z'), answer].map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal((await detect(config, '2026-10-20T10:07:00Z', { judge })).records[0]?.status, '在等我');
  assert.equal(calls.length, 2);
  assert.equal((await detect(config, '2026-10-21T10:04:00Z', { judge })).records[0]?.status, '已搁置');
  assert.equal(calls.length, 2);
});

test('模型失败下一轮重试、每日上限仍保留规则；用量预留可重放', async t => {
  for (const fail of [true, false]) {
    const { config, transcript } = await fixture(t);
    config.judge!.dailyLimit = fail ? 10 : 0;
    const { judge, calls } = stubJudge(() => { throw new Error('test-only'); });
    await put(transcript, [ccUser(), ccAnswer()]);
    const view = await detect(config, '2026-10-20T10:06:00Z', { judge });
    assert.equal(view.records[0]?.status, '已完成');
    assert.match(renderOverview(view.records, view.projection), fail ? /调用失败，仅规则判断/ : /每日额度用完，仅规则判断/);
    const count = calls.length;
    await detect(config, '2026-10-20T10:07:00Z', { judge }); await rebuild(config);
    assert.equal(calls.length, fail ? count * 2 : count);
    assert.equal((await readEvents(config.dataDir)).filter(e => e.kind === 'model_call_started').length, calls.length);
  }
});

test('本机通知失败不丢发件，明示失败，下轮重试，成功后去重；脚本文字不执行', async t => {
  const { root, config, transcript } = await fixture(t);
  config.judge = null;
  const command = join(root, 'notification-stub');
  await executable(command, 'process.exit(1)');
  config.localChannel = { executable: command, timeoutMs: 5000 };
  await put(transcript, [ccUser(), ccCall()]); await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript)]);
  const first = await detect(config, '2026-10-20T10:06:00Z');
  assert.equal(first.noticesAdded, 1); assert.match(renderOverview(first.records, first.projection), /本机通知尚未成功/);
  const log = join(root, 'called');
  await executable(command, `require('node:fs').appendFileSync(${JSON.stringify(log)},'called\\n')`);
  await detect(config, '2026-10-20T10:02:00Z'); await detect(config, '2026-10-20T10:03:00Z');
  assert.equal(await readFile(log, 'utf8'), 'called\n');
});

test('A9 反馈 CLI 默认最近提醒，日期与编号落盘，回话写明误报的效果；漏了可无提醒', async t => {
  const { root, config, transcript } = await fixture(t);
  config.judge = null;
  await put(transcript, [ccUser(), ccCall()]); await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript)]);
  await detect(config, '2026-10-20T10:06:00Z');
  const path = join(root, 'config.json'); await put(path, JSON.stringify(config));
  const cli = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), 'feedback', '误报', '我不需要处理', '--config', path, '--now', '2026-10-20T10:02:00Z'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout.trim(), /^已记下：这个会话之后不会再因为等你回复或授权叫你/);
  const row = (await readJsonl<Feedback>(join(config.dataDir, 'feedback.jsonl')))[0]!;
  assert.equal(row.date, '2026-10-20'); assert.equal(row.verdict, '误报'); assert.equal(row.comment, '我不需要处理');
  assert.equal(row.noticeId, (await readOutbox(config.dataDir))[0]!.id);
  await receiveFeedback(config.dataDir, 'test-channel', { content: '正确', noticeId: row.noticeId!, at: '2026-10-20T10:03:00Z' });
  await assert.rejects(receiveFeedback(config.dataDir, 'local', { content: '误报', noticeId: 'unknown', at: '2026-10-20T10:03:00Z' }), /未找到/);
  await receiveFeedback(config.dataDir, 'local', { content: '漏了 这是另一件事', noticeId: null, at: '2026-10-20T10:03:00Z' });
  assert.equal((await readJsonl<Feedback>(join(config.dataDir, 'feedback.jsonl'))).at(-1)!.noticeId, null);
  const empty = join(root, 'empty-data');
  await receiveFeedback(empty, 'local', { content: '漏了 刚才有会话等我', at: '2026-10-20T10:03:00Z' });
  assert.equal((await readJsonl<Feedback>(join(empty, 'feedback.jsonl')))[0]!.noticeId, null);
});

test('Pi 判断器真实子进程边界仅用替身：固定无工具参数、JSON最终答案、超时/坏输出降级', async t => {
  const { root, config } = await fixture(t);
  const command = join(root, 'fake-pi');
  const capture = join(root, 'arguments.json');
  await executable(command, `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),input})); const a={answer:'否',reason:'完成而非提问'}; console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(a)}]}})); console.log(JSON.stringify({type:'agent_settled',aborted:false}));});`);
  config.judge!.executable = command;
  config.judge!.timeoutMs = 5000;
  const request: JudgmentRequest = { task: 'waiting', format: 'binary', context: { intentOriginal: '只改 A', additionalRequirements: [], previousSummary: '', newSteps: [], assistantReply: '已完成' } };
  assert.equal((await piJudge(config.judge!).judge(request)).answer, '否');
  const captured = JSON.parse(await readFile(capture, 'utf8'));
  for (const flag of ['-p', '--no-tools', '--no-session', '--no-extensions', '--no-context-files', '--mode']) assert.ok(captured.args.includes(flag));
  assert.ok(captured.args.includes('test/fake')); assert.match(captured.input, /只改 A/);
  await executable(command, 'console.log("not JSON")');
  await assert.rejects(piJudge(config.judge!).judge(request));
  await executable(command, 'setTimeout(()=>{},10000)'); config.judge!.timeoutMs = 30;
  await assert.rejects(piJudge(config.judge!).judge(request), /超时/);
});

test('评测 CLI 用当前可执行替身完成两种问法，判错也只记分不设通过线', async t => {
  const { root, config } = await fixture(t);
  const command = join(root, 'fake-pi-evaluation');
  await executable(command, `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const answer=input.includes('answer 只能为「高」')?'低':'否'; console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({answer,reason:'构造的无偏离'})}]}}));});`);
  config.judge!.executable = command; config.judge!.timeoutMs = 5000;
  const samples = join(root, 'cli-samples'); await mkdir(samples);
  await put(join(samples, 'one.json'), JSON.stringify({ task: 'waiting', intentOriginal: '只改 A', newSteps: [], assistantReply: '选择哪个方案？', expected: '是' }));
  const configPath = join(root, 'config.json'); await put(configPath, JSON.stringify(config));
  const cli = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), 'evaluate', '--config', configPath, '--samples', samples, '--json'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.total, 1); assert.equal(result.binary.correct, 0); assert.equal(result.confidence.correct, 0);
  assert.equal(result.binary.failed + result.confidence.failed, 0);
});

test('评测命令两种问法逐份记分，无通过线，额度统一计算；上下文固定上限', async t => {
  const { root, config } = await fixture(t);
  const samples = join(root, 'evaluation'); await mkdir(samples);
  await put(join(samples, 'one.json'), JSON.stringify({ task: 'drift', intentOriginal: '只改 A', additionalRequirements: [], newSteps: ['改 A'], expected: '否' }));
  const { judge, calls } = stubJudge(r => ({ ...no, ...(r.format === 'confidence' ? { confidence: '低' } : {}) }));
  const result = await evaluate(config, samples, '2026-10-20T10:01:00Z', judge);
  assert.equal(result.binary.correct, 1); assert.equal(result.confidence.correct, 1); assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(r => r.format), ['binary', 'confidence']);
  assert.equal((await readEvents(config.dataDir)).filter(e => e.kind === 'model_call_started').length, 2);
  const context = boundedContext({ intentOriginal: 'A'.repeat(10000), additionalRequirements: Array(1000).fill('B'.repeat(1000)), previousSummary: 'C'.repeat(10000), newSteps: Array(100).fill({ at: '2026-10-20T10:00:00Z', text: 'D'.repeat(10000) }), assistantReply: 'E'.repeat(10000) });
  assert.ok(JSON.stringify(context).length < 8000);
});
