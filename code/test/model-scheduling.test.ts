// 构造时效/并发回归，不调用真实模型或通知，不读取真实工具配置。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { receiveFeedback } from '../src/core/feedback.ts';
import { event } from '../src/core/events.ts';
import { appendJsonl, readEvents, readJsonl, readOutbox, withStoreLock } from '../src/core/store.ts';
import { ccUser, ccCall, pushed, put, sandbox } from './fixtures.ts';
import type { Channel, Feedback, Judge, JudgmentResult, Notice } from '../src/core/types.ts';

const now = '2026-10-20T10:01:00Z';
const no: JudgmentResult = { answer: '否', reason: '未发现偏离' };
async function fixture(t: { after(fn: () => Promise<unknown>): void }, count = 11) {
  const f = await sandbox();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.judge = { executable: '/test-only/fake-judge', model: 'test/fake', dailyLimit: 100, timeoutMs: 150, cycleTimeoutMs: 500 };
  const waiting = join(f.config.sources.cc!, 'waiting.jsonl');
  await put(waiting, [ccUser(), ccCall()]);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(waiting)]);
  for (let i = 0; i < count; i++) {
    const sessionId = `busy-${String(i).padStart(2, '0')}`;
    await put(join(f.config.sources.cc!, `${sessionId}.jsonl`), [ccUser('只改 A 文件'), ccCall(undefined, 'b', '修改 B 模块')].map(row => ({ ...row, sessionId })));
  }
  const sent: Notice[] = [];
  const channel: Channel = { name: 'local', async send(notice) { sent.push(notice); }, receive: reply => receiveFeedback(f.config.dataDir, 'local', reply) };
  return { ...f, waiting, sent, channel };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('测试等待超时')), milliseconds); })]); }
  finally { clearTimeout(timer!); }
}

test('返修2-2 11个无关会话模型持续超时：规则先交付、反馈不等模型、单轮总时限及延期可续查', async t => {
  const { config, sent, channel } = await fixture(t);
  const firstCall = deferred<void>();
  let calls = 0; let aborted = 0; let notifiedAt = 0;
  const start = performance.now();
  const timedChannel: Channel = { ...channel, async send(notice) { notifiedAt ||= performance.now(); await channel.send(notice); } };
  const judge: Judge = { judge(_request, options) {
    calls++; firstCall.resolve();
    return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => { aborted++; reject(new Error('构造超时')); }, { once: true }));
  } };
  const running = detect(config, now, { judge, channels: [timedChannel] });
  await within(firstCall.promise);
  assert.equal(sent.length, 1, '第一笔模型调用之前必须已经通知授权等待');
  assert.equal(sent[0]!.kind, 'waiting');
  assert.ok(notifiedAt - start < 2000, '构造样本的规则通知应快速交付，而非等待11个模型超时');
  assert.equal((await readOutbox(config.dataDir)).length, 1);
  const feedbackStart = performance.now();
  assert.equal(await receiveFeedback(config.dataDir, 'local', { content: '误报 构造反馈', at: now }), '已记下');
  const feedbackMs = performance.now() - feedbackStart;
  assert.ok(feedbackMs < 500, '模型等待期间不能一直占着数据锁');
  const view = await within(running);
  assert.ok(calls > 0 && calls < 11, '单轮总时限应停止继续串行调用');
  assert.equal(aborted, calls);
  assert.ok(view.records.some(r => r.modelNotes?.includes('本轮模型时限用完，仅规则判断')));
  assert.equal((await readJsonl<Feedback>(join(config.dataDir, 'feedback.jsonl'))).length, 1);
  assert.equal((await readEvents(config.dataDir)).filter(e => e.kind === 'model_call_started').length, calls);
  assert.equal(view.noticesAdded, 1); assert.equal(sent.length, 1);
  t.diagnostic(`构造时效：规则通知 ${Math.round(notifiedAt - start)} ms，模型等待期间反馈 ${Math.round(feedbackMs)} ms；11个候选中调用 ${calls} 个后到达单轮总时限。`);
  const completedCalls = calls;
  let resumed = 0;
  config.judge!.cycleTimeoutMs = 5000;
  const healthy: Judge = { async judge(request) { resumed++; assert.ok(request.context.newSteps.length); return no; } };
  await detect(config, '2026-10-20T10:02:00Z', { judge: healthy, channels: [channel] });
  assert.equal(resumed, 11, '延期任务与失败调用均须下一轮续查，不能吞掉新步骤');
  assert.ok(completedCalls > 0);
  assert.equal(sent.length, 1, '规则通知与文件交付必须仍然幂等');
  assert.equal((await readOutbox(config.dataDir)).length, 1);
  const before = (await readEvents(config.dataDir)).filter(e => e.kind === 'model_call_started').length;
  await rebuild(config); await overview(config);
  assert.equal((await readEvents(config.dataDir)).filter(e => e.kind === 'model_call_started').length, before);
});

test('返修2-2 两个交付阶段仍每轮只重试一次失败渠道，下轮恢复且不重复发件', async t => {
  const { config, channel } = await fixture(t, 1);
  let sends = 0;
  const sometimesFails: Channel = { ...channel, async send() { if (++sends === 1) throw new Error('构造失败'); } };
  const judge: Judge = { async judge() { return no; } };
  const first = await detect(config, now, { channels: [sometimesFails], judge });
  assert.equal(first.noticesAdded, 1); assert.equal(sends, 1);
  await detect(config, '2026-10-20T10:02:00Z', { channels: [sometimesFails], judge });
  await detect(config, '2026-10-20T10:03:00Z', { channels: [sometimesFails], judge });
  assert.equal(sends, 2); assert.equal((await readOutbox(config.dataDir)).length, 1);
});

test('返修2-2 数据锁内按最新日志预留每日额度，不使用模型阶段开始时的旧计数', async t => {
  const { config, channel } = await fixture(t, 3);
  config.judge!.dailyLimit = 2; config.judge!.timeoutMs = 5000; config.judge!.cycleTimeoutMs = 10000;
  const started = deferred<void>(); const answer = deferred<JudgmentResult>();
  let calls = 0;
  const running = detect(config, now, { channels: [channel], judge: { judge() { calls++; started.resolve(); return answer.promise; } } });
  await within(started.promise);
  try {
    await withStoreLock(config.dataDir, () => appendJsonl(join(config.dataDir, 'events.jsonl'), [event({ kind: 'model_call_started', task: 'drift', key: 'constructed-other-consumer' }, now)]));
  } finally { answer.resolve(no); }
  const view = await within(running);
  assert.equal(calls, 1);
  assert.equal(view.projection.modelCalls.get('2026-10-20'), 2);
  assert.ok(view.records.some(r => r.modelNotes?.includes('每日额度用完，仅规则判断')));
});

test('返修2-2 模型等待时另一轮仍可感知/交付，迟到答案不覆盖新会话和新时间', async t => {
  const { config, sent, channel } = await fixture(t, 1);
  config.judge!.timeoutMs = 5000; config.judge!.cycleTimeoutMs = 10000;
  const started = deferred<void>(); const answer = deferred<JudgmentResult>();
  let calls = 0;
  const first = detect(config, now, { channels: [channel], judge: { judge(request) {
    calls++; started.resolve();
    return answer.promise.then(() => ({ answer: '是', reason: '旧上下文里只允许A', intentQuote: request.context.intentOriginal!, stepQuote: request.context.newSteps[0]!.text }));
  } } });
  await within(started.promise);
  try {
    const file = join(config.sources.cc!, 'busy-00.jsonl');
    await appendFile(file, JSON.stringify({ ...ccUser('顺便改 B 模块', '2026-10-20T10:02:00Z'), sessionId: 'busy-00' }) + '\n');
    const second = await detect(config, '2026-10-20T10:03:00Z', { channels: [channel], judge: { async judge() { calls++; return no; } } });
    assert.equal(second.records.find(r => r.sessionId === 'busy-00')?.status, '进行中');
    assert.equal(calls, 1, '已有模型批次时不能重复预留/调用');
  } finally { answer.resolve(no); }
  const latest = await within(first);
  assert.equal(latest.at, '2026-10-20T10:03:00.000Z');
  assert.deepEqual(latest.records.find(r => r.sessionId === 'busy-00')?.intent.additions, ['顺便改 B 模块']);
  assert.equal(latest.records.find(r => r.sessionId === 'busy-00')?.status, '进行中');
  assert.equal((await readOutbox(config.dataDir)).filter(n => n.kind === 'drift').length, 0);
  assert.equal(sent.length, 1);
});

test('返修2-2 判断器即使忽略取消信号、永不返回，单轮总时限仍能结束等待', async t => {
  const { config, channel } = await fixture(t, 3);
  config.judge!.timeoutMs = 30000; config.judge!.cycleTimeoutMs = 80;
  let calls = 0;
  const view = await within(detect(config, now, { channels: [channel], judge: { judge() { calls++; return new Promise(() => {}); } } }));
  assert.equal(calls, 1);
  assert.ok(view.records.some(r => r.modelNotes?.includes('调用失败，仅规则判断')));
  assert.ok(view.records.some(r => r.modelNotes?.includes('本轮模型时限用完，仅规则判断')));
});

test('返修2-2 总时限取消真实子进程替身，30秒单次超时不会突破2秒模型预算', async t => {
  const { root, config, channel } = await fixture(t, 1);
  const command = join(root, 'fake-hanging-pi'); const pidFile = join(root, 'fake-pi.pid');
  await writeFile(command, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},10000);\n`);
  await chmod(command, 0o700);
  config.judge!.executable = command; config.judge!.timeoutMs = 30000; config.judge!.cycleTimeoutMs = 2000;
  const running = detect(config, now, { channels: [channel] });
  let pid: number | undefined;
  try {
    await within((async () => { while (pid === undefined) { try { const value = Number(await readFile(pidFile, 'utf8')); if (Number.isInteger(value) && value > 1 && value !== process.pid) pid = value; } catch {} if (pid === undefined) await delay(10); } })());
    const view = await within(running, 5000);
    assert.ok(view.records.some(r => r.modelNotes?.includes('调用失败，仅规则判断')));
    await within((async () => { while (true) { try { process.kill(pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; } await delay(10); } })());
  } finally { if (pid !== undefined) { try { process.kill(pid, 'SIGKILL'); } catch {} } await running.catch(() => {}); }
});
