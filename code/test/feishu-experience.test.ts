// 飞书体验批：全部构造在系统临时目录；不连平台/模型、不读个人运行数据、不弹通知。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO, setTimeout as delay } from 'node:timers/promises';
import { detect, overview } from '../src/core/agent.ts';
import { renderOverview } from '../src/core/judge.ts';
import { feishuChannel, normalizeIncoming } from '../src/channels/feishu/index.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { readFeedback } from '../src/core/feedback.ts';
import { appendJsonl, readEvents, readJsonl, readOutbox, withStoreLock } from '../src/core/store.ts';
import { runService } from '../src/service/daemon.ts';
import type { FeishuConnection } from '../src/core/types.ts';
import { ccCall, ccUser, put, pushed, sandbox } from './fixtures.ts';

async function fixture(t: TestContext) {
  const f = await sandbox();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.feishu = { mode: 'fake', receiverId: 'ou_synthetic', timeoutMs: 40000 };
  f.config.learning = false;
  return { ...f, sent: () => readJsonl<SentMessage>(join(f.config.dataDir, 'feishu-sent.jsonl')) };
}
function text(id: string, content = '漏了 测试') {
  return { header: { event_type: 'im.message.receive_v1', event_id: id }, event: {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_synthetic' } },
    message: { message_id: `om_${id}`, message_type: 'text', chat_type: 'p2p', content: JSON.stringify({ text: content }) },
  } };
}
function action(id: string, messageId: string, noticeId: string, timestamp?: string) {
  return { header: { event_type: 'card.action.trigger', event_id: id, create_time: timestamp }, event: {
    operator: { open_id: 'ou_synthetic' }, context: { open_message_id: messageId },
    action: { value: { action: 'feedback', verdict: '误报', noticeId } },
  } };
}
async function waitFor(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  throw new Error('构造结果未在期限内出现');
}

test('飞书 A1：16位微秒按钮记今天的误报并回话；秒/毫秒同义，异常时间留说明', async t => {
  const f = await fixture(t), now = new Date().toISOString();
  const transcript = join(f.config.sources.cc!, 'sample.jsonl');
  const stopped = new Date(Date.parse(now) - 12 * 60000).toISOString();
  await put(transcript, [ccUser('构造任务', stopped), ccCall(stopped)]);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(transcript, 'waiting_permission', stopped)]);
  await detect(f.config, now);
  const notice = (await readOutbox(f.config.dataDir))[0]!, message = (await f.sent())[0]!;
  const microseconds = String(Date.parse(now) * 1000);
  assert.equal(microseconds.length, 16);
  await put(join(f.config.dataDir, 'feishu-inbox.jsonl'), [action('micro', message.messageId, notice.id, microseconds)]);
  const channel = feishuChannel(f.config);
  assert.equal(await channel.drain(now), 1);
  const feedback = await readFeedback(f.config.dataDir);
  assert.equal(feedback.length, 1); assert.equal(feedback[0]!.noticeId, notice.id);
  assert.equal(feedback[0]!.verdict, '误报'); assert.equal(feedback[0]!.at, now);
  assert.match(JSON.stringify((await f.sent()).find(m => m.key === 'reply:micro')!.content), /已记下/);
  for (const timestamp of [String(Date.parse(now) / 1000), String(Date.parse(now)), microseconds])
    assert.equal(normalizeIncoming(action('unit', 'om_x', 'notice', timestamp), undefined, now)?.at, now);
  for (const timestamp of ['999999999999999999999999', '-123', 'invalid', '1000']) {
    const normalized = normalizeIncoming(action('bad-time', 'om_x', 'notice', timestamp), undefined, now)!;
    assert.equal(normalized.at, now); assert.match(normalized.timeNote!, /收到的时间/);
  }
  await appendJsonl(join(f.config.dataDir, 'feishu-inbox.jsonl'), [action('time-fallback', 'om_missing', 'unknown', 'invalid')]);
  await channel.drain(now);
  assert.match(await readFile(join(f.config.dataDir, 'feishu-receipts.jsonl'), 'utf8'), /事件时间缺失或明显不合理/);
});

test('飞书 A2：单条失败记类别并回原因，后续漏报与常驻两轮检测均完成', async t => {
  const f = await fixture(t); f.config.sources.cc = null;
  f.config.service = { intervalMs: 50, restartWindowMs: 1000, restartThreshold: 3 };
  await put(join(f.config.dataDir, 'feishu-inbox.jsonl'), [action('missing', 'om_missing', 'unknown'), text('valid')]);
  const channel = feishuChannel(f.config), controller = new AbortController();
  const running = runService(f.config, controller.signal, { channels: [channel] }); void running.catch(() => {});
  try {
    await waitFor(async () => (await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'))).filter(r => r.kind === 'scan_completed').length >= 2);
    const feedback = await readFeedback(f.config.dataDir);
    assert.equal(feedback.length, 1); assert.equal(feedback[0]!.comment, '测试');
    const replies = (await f.sent()).filter(m => m.type === 'text');
    assert.match(JSON.stringify(replies.find(m => m.key === 'reply:missing')!.content), /这条没处理成.*找不到/);
    assert.match(JSON.stringify(replies.find(m => m.key === 'reply:valid')!.content), /已记下/);
    const receipts = await readJsonl<{ id: string; status?: string; category?: string }>(join(f.config.dataDir, 'feishu-receipts.jsonl'));
    assert.ok(receipts.some(r => r.id === 'missing' && r.status === 'failed' && r.category === 'notice_not_found'));
    await channel.drain(); assert.equal((await readFeedback(f.config.dataDir)).length, 1);
    assert.ok(!(await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'))).some(r => r.kind === 'scan_failed'));
  } finally { controller.abort(); await running; }
});

test('确认发送失败只重试回话；已核销旧点击和原始收件/反馈始终不改写', async t => {
  const f = await fixture(t); f.config.sources.cc = null;
  const inbox = join(f.config.dataDir, 'feishu-inbox.jsonl'), receipts = join(f.config.dataDir, 'feishu-receipts.jsonl');
  await put(inbox, [text('new'), { id: 'old-fixed', actor: 'ou_synthetic', messageId: 'om_old', at: '+058790-01-30T23:56:10Z', type: 'action' }]);
  await appendJsonl(receipts, [{ id: 'old-fixed', at: new Date().toISOString() }]);
  const beforeInbox = await readFile(inbox, 'utf8'), beforeReceipts = await readFile(receipts, 'utf8');
  let fails = true;
  const channel = feishuChannel(f.config, { async send() { if (fails) throw new Error('SYNTHETIC_PRIVATE_UPSTREAM'); return 'om_reply'; } });
  await channel.drain(); const beforeFeedback = await readFile(join(f.config.dataDir, 'feedback.jsonl'), 'utf8');
  assert.equal((await readFeedback(f.config.dataDir)).length, 1);
  fails = false; await channel.drain(); await channel.drain();
  assert.equal(await readFile(inbox, 'utf8'), beforeInbox);
  assert.ok((await readFile(receipts, 'utf8')).startsWith(beforeReceipts));
  assert.equal(await readFile(join(f.config.dataDir, 'feedback.jsonl'), 'utf8'), beforeFeedback);
  assert.equal((await f.sent()).filter(m => m.key === 'reply:new').length, 1);
  assert.ok(!(await f.sent()).some(m => m.key === 'reply:old-fixed'));
  assert.doesNotMatch(await readFile(receipts, 'utf8'), /SYNTHETIC_PRIVATE_UPSTREAM/);
});

test('门禁返修1：固定重试钟未到时，检测释放锁后的 drain 独立唤醒连接状态写回，收件不等检测锁', async t => {
  const f = await fixture(t); f.config.sources.cc = null;
  const channel = feishuChannel(f.config, { async send() { return 'om_stub'; }, start(_handlers, report) { report?.({ state: 'connected' }); } });
  // 冻结定时重试，不改真实 I/O；用确定性场景暴露只能等整秒抢锁的饥饿。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withStoreLock(f.config.dataDir, async () => {
      await channel.start(); // 握手回调已到，但数据锁仍被检测占用。
      const began = performance.now();
      await channel.drain();
      assert.ok(performance.now() - began < 500, '收件不能等待状态写入或检测锁');
      assert.ok(!(await readEvents(f.config.dataDir)).some(e => e.kind === 'feishu_connection' && e.connection.state === 'connected'));
    });
    await channel.drain(); // 与 detect.finish 相同，在检测释放数据锁后调用。
    const deadline = performance.now() + 2000;
    let connected = false;
    while (performance.now() < deadline) {
      connected = (await readEvents(f.config.dataDir)).some(e => e.kind === 'feishu_connection' && e.connection.state === 'connected');
      if (connected) break;
      await yieldIO();
    }
    assert.ok(connected, '没有推进固定重试钟；检测后的收件调用也应唤醒待写的已连接状态');
    assert.equal((await overview(f.config)).projection.feishuConnection?.state, 'connected');
  } finally { await channel.stop(); t.mock.timers.reset(); }
});

test('飞书 A3：检测持锁超过30秒时连接状态独立重试，收件/后续检测继续且总览已连上', { timeout: 50000 }, async t => {
  const f = await fixture(t), now = new Date().toISOString();
  f.config.service = { intervalMs: 100, restartWindowMs: 1000, restartThreshold: 3 };
  const transcript = join(f.config.sources.cc!, 'sample.jsonl');
  const stopped = new Date(Date.parse(now) - 12 * 60000).toISOString();
  await put(transcript, [ccUser('构造长检测', stopped), ccCall(stopped)]);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(transcript, 'waiting_permission', stopped)]);
  let connected: ((state: FeishuConnection) => void) | undefined, holding = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const channel = feishuChannel(f.config, {
    start(_handlers, report) { connected = report; },
    async send(type) { if (type === 'interactive') { holding = true; await gate; } return `om_${type}`; },
  });
  const controller = new AbortController(), running = runService(f.config, controller.signal, { channels: [channel] }); void running.catch(() => {});
  try {
    await waitFor(async () => holding);
    connected!({ state: 'connected' });
    const began = Date.now(); await channel.drain();
    assert.ok(Date.now() - began < 500, '展示写入不能挡住空收件');
    await delay(31000); release();
    await waitFor(async () => (await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'))).some(r => r.kind === 'scan_completed'));
    await channel.capture(text('after-lock'));
    await waitFor(async () => (await readFeedback(f.config.dataDir)).length === 1);
    try {
      await waitFor(async () => (await overview(f.config)).projection.feishuConnection?.state === 'connected');
    } catch (error) {
      t.diagnostic(`连接状态未恢复时的构造服务日志：${JSON.stringify(await readJsonl(join(f.config.dataDir, 'service.log.jsonl')))}`);
      throw error;
    }
    await waitFor(async () => (await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'))).filter(r => r.kind === 'scan_completed').length >= 2);
    const view = await overview(f.config);
    assert.match(renderOverview(view.records, view.projection), /飞书长连接：已连接/);
    assert.equal((await readFeedback(f.config.dataDir))[0]!.comment, '测试');
    assert.match(JSON.stringify((await f.sent()).find(m => m.key === 'reply:after-lock')!.content), /已记下/);
  } finally { release(); controller.abort(); await running; }
});
