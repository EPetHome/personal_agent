// 本批反馈回归：只用临时目录、构造事件和通知/飞书替身。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { detect } from '../src/core/agent.ts';
import { readFeedback, receiveFeedback } from '../src/core/feedback.ts';
import { safeProcessingFailure } from '../src/core/failures.ts';
import { acquireLock } from '../src/core/locks.ts';
import { appendJsonl, readJsonl, readOutbox } from '../src/core/store.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { runService } from '../src/service/daemon.ts';
import type { Channel, Feedback } from '../src/core/types.ts';
import { ccCall, ccUser, put, pushed, sandbox } from './fixtures.ts';

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.feishu = { mode: 'fake', receiverId: 'ou_synthetic', timeoutMs: 40000 };
  f.config.learning = false;
  const at = new Date(Date.now() - 12 * 60000).toISOString();
  const transcript = join(f.config.sources.cc!, 'sample.jsonl');
  await put(transcript, [ccUser('构造长检测', at), ccCall(at)]);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(transcript, 'waiting_permission', at)]);
  await detect(f.config); // 已过等待窗口且真人不在场，便于测飞书反馈链。
  const notice = (await readOutbox(f.config.dataDir))[0]!;
  const sent = () => readJsonl<SentMessage>(join(f.config.dataDir, 'feishu-sent.jsonl'));
  const message = (await sent()).find(m => m.noticeId === notice.id)!;
  return { ...f, transcript, notice, message, sent };
}
function click(id: string, messageId: string, noticeId: string) {
  return { header: { event_type: 'card.action.trigger', event_id: id, create_time: String(Date.now() * 1000) }, event: {
    operator: { open_id: 'ou_synthetic' }, context: { open_message_id: messageId },
    action: { value: { action: 'feedback', verdict: '正确', noticeId } },
  } };
}
function text(id: string) {
  return { header: { event_type: 'im.message.receive_v1', event_id: id }, event: {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_synthetic' } },
    message: { message_id: `om_${id}`, message_type: 'text', chat_type: 'p2p', content: JSON.stringify({ text: '漏了 测试' }) },
  } };
}
async function waitFor(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await check()) return; await delay(10); }
  throw new Error('构造结果未在期限内出现');
}

test('反馈 A1/A2：常驻检测实际持数据锁35秒，按钮、飞书文字、本机CLI在结束前均落盘并确认；重投不重复', { timeout: 50000 }, async t => {
  const f = await fixture(t);
  f.config.service = { intervalMs: 100, restartWindowMs: 1000, restartThreshold: 3 };
  // 新的等待证据产生另一条提醒；第一张旧卡片留给按钮反馈。
  const at = new Date(Date.now() - 6 * 60000).toISOString();
  await appendJsonl(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.transcript, 'waiting_permission', at)]);
  let release!: () => void, holding = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const local: Channel = { name: 'local', async send() { holding = true; await gate; }, receive: reply => receiveFeedback(f.config.dataDir, 'local', reply) };
  const channel = feishuChannel(f.config);
  const controller = new AbortController(), running = runService(f.config, controller.signal, { channels: [local, channel] });
  void running.catch(() => {});
  try {
    await waitFor(async () => holding);
    const began = performance.now();
    const newNotice = (await readOutbox(f.config.dataDir)).find(n => n.id !== f.notice.id)!;
    assert.ok(newNotice);
    const input = click('during-lock', f.message.messageId, f.notice.id);
    await channel.capture(input); await channel.capture(input);
    await channel.capture(text('text-during-lock'));
    const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
    const cli = await exec(process.execPath, [join(import.meta.dirname, '../src/cli/main.ts'), 'feedback', '误报', '--id', newNotice.id, '--config', configPath], { timeout: 5000, env: { ...process.env, HOME: f.root } });
    assert.match(cli.stdout.trim(), /^已记下：这个会话之后不会再/); assert.equal(cli.stderr, '');
    await waitFor(async () => (await f.sent()).filter(m => m.type === 'text').length === 2);
    const rows = await readFeedback(f.config.dataDir);
    assert.equal(rows.length, 3);
    assert.equal(rows.filter(r => r.replyId === 'during-lock').length, 1);
    assert.ok(rows.some(r => r.noticeId === f.notice.id && r.verdict === '正确'));
    assert.ok(rows.some(r => r.noticeId === null && r.verdict === '漏了' && r.comment === '测试'));
    assert.ok(rows.some(r => r.noticeId === newNotice.id && r.verdict === '误报' && r.channel === 'local'));
    assert.ok((await f.sent()).filter(m => m.type === 'text').every(m => JSON.stringify(m.content).includes('已记下')));
    const feedbackMs = Math.round(performance.now() - began);
    assert.ok(feedbackMs < 5000, '反馈确认不能排在35秒检测后面');
    assert.ok(await readFile(join(f.config.dataDir, '.detect.lock/owner.json'), 'utf8'));
    assert.equal((await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'))).filter(r => r.kind === 'scan_completed').length, 0);
    await delay(Math.max(0, 35000 - (performance.now() - began)));
    assert.ok(await readFile(join(f.config.dataDir, '.detect.lock/owner.json'), 'utf8'));
    release();
    await waitFor(async () => (await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'))).filter(r => r.kind === 'scan_completed').length >= 2);
    const scans = (await readJsonl<{ kind: string; durationMs: number; storeLockHeldMs: number }>(join(f.config.dataDir, 'service.log.jsonl'))).filter(r => r.kind === 'scan_completed');
    assert.ok(scans.every(r => Number.isFinite(r.durationMs) && Number.isFinite(r.storeLockHeldMs) && r.durationMs >= r.storeLockHeldMs && r.storeLockHeldMs >= 0));
    assert.ok(scans[0]!.storeLockHeldMs >= 35000, '检测主流程仍持有同一把数据锁35秒，只量不改');
    await feishuChannel(f.config).drain();
    assert.equal((await readFeedback(f.config.dataDir)).length, 3);
    t.diagnostic(`三路反馈在 ${feedbackMs} ms 内全部落盘并确认；长轮检测 ${scans[0]!.durationMs} ms、持数据锁 ${scans[0]!.storeLockHeldMs} ms；同事件只记一次。`);
  } finally { release(); controller.abort(); await running; }
});

test('反馈旧数据不迁移、不重复；多进程同时重投按渠道/事件原子去重', async t => {
  const f = await fixture(t), path = join(f.config.dataDir, 'feedback.jsonl');
  const at = new Date().toISOString();
  const old: Feedback = { version: 1, at, date: at.slice(0, 10), channel: 'feishu', noticeId: f.notice.id, verdict: '正确', comment: '旧反馈', replyId: 'old' };
  await appendJsonl(path, [old]); const before = await readFile(path, 'utf8');
  await receiveFeedback(f.config.dataDir, 'feishu', { content: '正确', noticeId: f.notice.id, at, replyId: 'old' });
  assert.equal(await readFile(path, 'utf8'), before);
  const program = `import { receiveFeedback } from ${JSON.stringify(new URL('../src/core/feedback.ts', import.meta.url).href)}; await receiveFeedback(process.argv[1], 'feishu', { content: '误报 同一事件', noticeId: process.argv[2], at: process.argv[3], replyId: 'parallel' }); console.log('已记下');`;
  const results = await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath, ['--input-type=module', '-e', program, f.config.dataDir, f.notice.id, at], { timeout: 10000, env: { ...process.env, HOME: f.root } })));
  assert.ok(results.every(r => r.stdout.trim() === '已记下' && !r.stderr));
  assert.equal((await readFeedback(f.config.dataDir)).length, 2);
  assert.ok((await readFile(path, 'utf8')).startsWith(before));
});

test('反馈读取和提醒核对都只看完整追加，真正的坏行仍保留并报错', async t => {
  const f = await fixture(t), at = new Date().toISOString();
  const row: Feedback = { version: 1, at, date: at.slice(0, 10), channel: 'test', noticeId: f.notice.id, verdict: '正确', comment: '完整反馈' };
  const path = join(f.config.dataDir, 'feedback.jsonl'), text = JSON.stringify(row) + '\n';
  const release = await acquireLock(f.config.dataDir, '.feedback.lock');
  await appendFile(path, text.slice(0, 40));
  let finished = false;
  const reading = readFeedback(f.config.dataDir).then(rows => { finished = true; return rows; });
  try { await delay(80); assert.equal(finished, false); await appendFile(path, text.slice(40)); }
  finally { await release(); }
  assert.deepEqual(await reading, [row]);

  const outbox = join(f.config.dataDir, 'outbox.jsonl'), notice = { ...f.notice, id: 'concurrent-complete-notice' };
  const noticeText = JSON.stringify(notice) + '\n';
  const releaseOutbox = await acquireLock(f.config.dataDir, '.outbox.lock');
  await appendFile(outbox, noticeText.slice(0, 40));
  let received = false;
  const receiving = receiveFeedback(f.config.dataDir, 'test', { content: '误报', at, noticeId: notice.id }).then(result => { received = true; return result; });
  try { await delay(80); assert.equal(received, false); await appendFile(outbox, noticeText.slice(40)); }
  finally { await releaseOutbox(); }
  assert.match(await receiving, /^已记下：这个会话之后不会再/);
  assert.equal((await readFeedback(f.config.dataDir)).at(-1)!.noticeId, notice.id);
  await appendFile(path, '{"broken":'); const before = await readFile(path, 'utf8');
  await assert.rejects(receiveFeedback(f.config.dataDir, 'test', { content: '漏了', at }), /损坏|未完整提交/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('反馈 A3：不存在提醒分原因回话；损坏/不安全文件有受控类别，不记录原始错误或重放旧失败', async t => {
  for (const problem of ['notice_not_found', 'data_corrupt', 'unsafe_file'] as const) {
    const f = await fixture(t), channel = feishuChannel(f.config);
    const input = problem === 'notice_not_found' ? click('failed', 'om_missing', 'unknown') : text('failed');
    if (problem === 'data_corrupt') await appendFile(join(f.config.dataDir, 'feedback.jsonl'), 'PRIVATE_UPSTREAM_RAW');
    if (problem === 'unsafe_file') {
      await rm(join(f.config.dataDir, 'feedback.jsonl'));
      await symlink(join(f.root, 'never-read'), join(f.config.dataDir, 'feedback.jsonl'));
    }
    await put(join(f.config.dataDir, 'feishu-inbox.jsonl'), [input]);
    await channel.drain();
    const receiptsPath = join(f.config.dataDir, 'feishu-receipts.jsonl');
    const rows = await readJsonl<{ status?: string; category?: string; response?: string }>(receiptsPath);
    assert.ok(rows.some(r => r.status === 'failed' && r.category === problem));
    assert.match(rows.find(r => r.response)!.response!, problem === 'notice_not_found' ? /找不到/ : problem === 'data_corrupt' ? /损坏|不完整/ : /普通文件/);
    assert.doesNotMatch(await readFile(receiptsPath, 'utf8'), /PRIVATE_UPSTREAM_RAW|记录暂时写不进去|processing/);
    const before = await readFile(receiptsPath, 'utf8');
    await feishuChannel(f.config).drain();
    assert.equal(await readFile(receiptsPath, 'utf8'), before, '已有失败/回话记录绝不重新处理');
  }
  for (const [code, category] of [['ENOSPC', 'storage_full'], ['EACCES', 'storage_permission'], ['EROFS', 'storage_readonly'], ['EIO', 'storage_io'], ['OTHER', 'unexpected']]) {
    const result = safeProcessingFailure(Object.assign(new Error('PRIVATE_UPSTREAM_RAW'), { code }));
    assert.equal(result.category, category); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UPSTREAM_RAW/);
  }
});

test('已有失败处理记录和仅含id的旧记录，即使现在能处理也不补记', async t => {
  const f = await fixture(t);
  await put(join(f.config.dataDir, 'feishu-inbox.jsonl'), [click('old-failed', f.message.messageId, f.notice.id), click('old-id-only', f.message.messageId, f.notice.id)]);
  const receiptsPath = join(f.config.dataDir, 'feishu-receipts.jsonl');
  await appendJsonl(receiptsPath, [{ id: 'old-failed', status: 'failed', category: 'processing', response: '旧失败回话', reply: 'sent' }, { id: 'old-id-only' }]);
  const before = await readFile(receiptsPath, 'utf8');
  await feishuChannel(f.config).drain();
  assert.deepEqual(await readFeedback(f.config.dataDir), []);
  assert.equal(await readFile(receiptsPath, 'utf8'), before);
});

test('计时 A9：失败的检测轮次也记录总耗时和实际持数据锁时长，不带原始错误', async t => {
  const f = await fixture(t); f.config.service = { intervalMs: 50, restartWindowMs: 1000, restartThreshold: 3 };
  await appendFile(join(f.config.dataDir, 'events.jsonl'), 'PRIVATE_UPSTREAM_RAW');
  const channel = feishuChannel(f.config), controller = new AbortController();
  const running = runService(f.config, controller.signal, { channels: [channel] }); void running.catch(() => {});
  try {
    await waitFor(async () => (await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'))).filter(r => r.kind === 'scan_failed').length >= 2);
  } finally { controller.abort(); await running; }
  const path = join(f.config.dataDir, 'service.log.jsonl');
  const rows = (await readJsonl<{ kind: string; durationMs: number; storeLockHeldMs: number }>(path)).filter(r => r.kind === 'scan_failed');
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(r => Number.isFinite(r.durationMs) && Number.isFinite(r.storeLockHeldMs) && r.durationMs >= r.storeLockHeldMs && r.storeLockHeldMs >= 0));
  assert.doesNotMatch(await readFile(path, 'utf8'), /PRIVATE_UPSTREAM_RAW/);
});

test('检测发送新卡片API卡住时，已有卡片的反馈确认也不排队等卡片API', async t => {
  const f = await fixture(t);
  let release!: () => void, holding = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const channel = feishuChannel(f.config, { async send(type) { if (type === 'interactive') { holding = true; await gate; } return `om_${type}`; } });
  const sending = channel.send({ ...f.notice, id: 'another-notice' });
  try {
    await waitFor(async () => holding);
    await channel.capture(click('while-card-api-slow', f.message.messageId, f.notice.id));
    await waitFor(async () => (await f.sent()).some(m => m.key === 'reply:while-card-api-slow'));
    assert.equal((await readFeedback(f.config.dataDir)).length, 1);
  } finally { release(); await sending; await channel.stop(); }
});
