import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { detect, overview } from '../src/core/agent.ts';
import { renderOverview } from '../src/core/judge.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { readFeedback } from '../src/core/feedback.ts';
import { readJsonl, readOutbox } from '../src/core/store.ts';
import { ccCall, ccUser, put, pushed, sandbox } from './fixtures.ts';

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 2000 };
  const transcript = join(f.config.sources.cc!, 'session.jsonl');
  await put(transcript, [ccUser(), ccCall()]);
  return { ...f, transcript, sent: () => readJsonl<SentMessage>(join(f.config.dataDir, 'feishu-sent.jsonl')) };
}
function text(id: string, content: string, parent?: string, actor = 'ou_test', chat = 'p2p') {
  return { header: { event_id: id, event_type: 'im.message.receive_v1', create_time: String(Date.parse('2026-10-20T10:02:00Z')) }, event: { sender: { sender_type: 'user', sender_id: { open_id: actor } }, message: { message_id: `om_${id}`, message_type: 'text', chat_type: chat, content: JSON.stringify({ text: content }), ...(parent ? { parent_id: parent } : {}) } } };
}
function action(id: string, messageId: string, noticeId: string, actor = 'ou_test') {
  return { header: { event_id: id, event_type: 'card.action.trigger' }, event: { operator: { open_id: actor }, context: { open_message_id: messageId }, action: { value: { action: 'feedback', noticeId, verdict: '误报' } } } };
}
function visibleStrings(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(visibleStrings).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => key !== 'value').map(([, v]) => visibleStrings(v)).join('\n');
  return '';
}

test('段2 A1/A2：两级飞书卡片；本机只收紧急级；同证据与重建后均不重复', async t => {
  for (const urgent of [true, false]) {
    const { root, config, transcript, sent } = await fixture(t);
    const calls = join(root, 'local-calls'); const executable = join(root, 'notify-stub');
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},'called\\n');\n`); await chmod(executable, 0o700);
    config.localChannel = { executable, timeoutMs: 5000 };
    if (urgent) await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript)]);
    await detect(config, urgent ? '2026-10-20T10:01:00Z' : '2026-10-20T10:31:00Z');
    const notice = (await readOutbox(config.dataDir))[0]!;
    const messages = await sent(); assert.equal(messages.length, 1);
    const card: any = messages[0]!.content;
    assert.equal(card.header.title.content, notice.content.title);
    const display = visibleStrings(card);
    assert.ok(display.includes(notice.content.situation!)); assert.ok(display.includes(notice.content.action!)); assert.ok(display.includes(notice.content.returnCommand));
    assert.ok(display.includes('正确')); assert.ok(display.includes('误报')); assert.ok(display.includes('collapsible_panel'));
    assert.ok(!display.includes(notice.id));
    assert.equal(await readFile(calls, 'utf8').catch(() => ''), urgent ? 'called\n' : '');
    await rm(join(config.dataDir, 'state.json')); await detect(config, '2026-10-20T10:32:00Z');
    assert.equal((await sent()).length, 1);
  }
});

test('段2 A3/A4：按钮和引用准确关联，直接漏了不关联；重投事件只记一次、只确认一次', async t => {
  const { config, transcript, sent } = await fixture(t);
  await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript)]); await detect(config, '2026-10-20T10:01:00Z');
  const notice = (await readOutbox(config.dataDir))[0]!, message = (await sent())[0]!;
  await put(join(config.dataDir, 'feishu-inbox.jsonl'), [action('click-1', message.messageId, notice.id), text('miss-1', '漏了 loop 暂停没叫我')]);
  await detect(config, '2026-10-20T10:03:00Z');
  let feedback = await readFeedback(config.dataDir);
  assert.equal(feedback.length, 2); assert.equal(feedback[0]!.verdict, '误报'); assert.equal(feedback[0]!.noticeId, notice.id);
  assert.equal(feedback[1]!.verdict, '漏了'); assert.equal(feedback[1]!.noticeId, null); assert.equal(feedback[1]!.comment, 'loop 暂停没叫我');
  const channel = feishuChannel(config);
  await appendFile(join(config.dataDir, 'feishu-inbox.jsonl'), [action('click-1', message.messageId, notice.id), text('quote-1', '正确 这次要处理', message.messageId)].map(r => JSON.stringify(r) + '\n').join(''));
  await channel.drain(); await channel.drain();
  feedback = await readFeedback(config.dataDir); assert.equal(feedback.length, 3); assert.equal(feedback[2]!.noticeId, notice.id);
  const replies = (await sent()).filter(m => m.type === 'text'); assert.equal(replies.length, 3);
  assert.match(JSON.stringify(replies.find(m => m.key === 'reply:click-1')!.content), /这个会话之后不会再因为等你回复或授权叫你/);
  assert.match(JSON.stringify(replies.find(m => m.key === 'reply:miss-1')!.content), /这条进了本周的问题汇总/);
  assert.match(JSON.stringify(replies.find(m => m.key === 'reply:quote-1')!.content), /提醒对你有用，不会记成问题/);
});

test('飞书私聊授权：陌生人、群聊、伪造按钮、未知引用不落反馈；不退回最近提醒', async t => {
  const { config, transcript, sent } = await fixture(t);
  await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript)]); await detect(config, '2026-10-20T10:01:00Z');
  const message = (await sent())[0]!, notice = (await readOutbox(config.dataDir))[0]!;
  await put(join(config.dataDir, 'feishu-inbox.jsonl'), [action('alien', message.messageId, notice.id, 'ou_alien'), action('forged', message.messageId, 'not-the-notice'), text('group', '漏了 群消息', undefined, 'ou_test', 'group'), text('unknown', '误报', 'not-a-bot-message'), text('unquoted', '正确')]);
  await feishuChannel(config).drain(); assert.equal((await readFeedback(config.dataDir)).length, 0);
});

test('官方 SDK 适配替身：两个长连接处理器3秒内只确认持久化，慢投递不阻塞回调', async t => {
  const { config } = await fixture(t); config.sources.cc = null;
  let handlers: Record<string, (raw: unknown) => unknown> = {};
  let stopped = false;
  const channel = feishuChannel(config, { async send() { await new Promise(r => setTimeout(r, 100)); return 'om_ack'; }, start(h) { handlers = h; }, stop() { stopped = true; } });
  await channel.start();
  assert.deepEqual(Object.keys(handlers).sort(), ['card.action.trigger', 'im.message.receive_v1']);
  const began = Date.now();
  assert.deepEqual(await handlers['im.message.receive_v1']!(text('slow', '漏了 loop 暂停没叫我')), {});
  assert.ok(Date.now() - began < 2500);
  assert.equal((await readJsonl(join(config.dataDir, 'feishu-inbox.jsonl'))).length, 1);
  await channel.drain(); await channel.stop(); assert.equal((await readFeedback(config.dataDir)).length, 1); assert.equal(stopped, true);
});

test('低优先级飞书失败保留文件发件、总览明示、下一轮重试且成功后去重', async t => {
  const { config } = await fixture(t); config.learning = false;
  let fails = true, calls = 0;
  const channel = feishuChannel(config, { async send() { calls++; if (fails) throw new Error('private upstream error'); return 'om_ok'; } });
  const first = await detect(config, '2026-10-20T10:31:00Z', { channels: [channel] });
  assert.match(renderOverview(first.records, first.projection), /飞书尚未成功/); assert.equal((await readOutbox(config.dataDir)).length, 1);
  fails = false; await detect(config, '2026-10-20T10:32:00Z', { channels: [channel] }); await detect(config, '2026-10-20T10:33:00Z', { channels: [channel] });
  assert.equal(calls, 2); assert.doesNotMatch(renderOverview((await overview(config)).records, (await overview(config)).projection), /飞书尚未成功/);
});

test('段2 A10：.env 构造凭证只留原文件，假飞书检测后的数据、CLI日志、跟踪文件均无凭证', async t => {
  const { root, config, transcript } = await fixture(t);
  const id = `cli_${randomUUID()}`, secret = randomUUID() + randomUUID();
  config.feishu!.envFile = join(root, '.env');
  await writeFile(config.feishu!.envFile, `FEISHU_APP_ID=${id}\nFEISHU_APP_SECRET=${secret}\n`, { mode: 0o600 });
  await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript)]);
  const path = join(root, 'config.json'); await put(path, JSON.stringify(config));
  const cli = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), 'detect', '--config', path, '--now', '2026-10-20T10:01:00Z'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const outputs = [cli.stdout, cli.stderr];
  for (const name of await readdir(config.dataDir)) outputs.push(await readFile(join(config.dataDir, name), 'utf8'));
  for (const credential of [id, secret]) {
    assert.ok(outputs.every(output => !output.includes(credential)));
    const tracked = spawnSync('git', ['grep', '-I', '-l', '-F', credential, '--'], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' });
    assert.equal(tracked.status, 1, tracked.stdout + tracked.stderr);
  }
});

test('整链：构造推送→本机与假飞书→按钮误报→周五统计，始终不连接真实平台', async t => {
  const { root, config, transcript, sent } = await fixture(t);
  const log = join(root, 'local-calls'), executable = join(root, 'local-stub');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},'called\\n');\n`); await chmod(executable, 0o700); config.localChannel = { executable, timeoutMs: 5000 };
  await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript)]); await detect(config, '2026-10-20T10:01:00Z');
  const reminder = (await readOutbox(config.dataDir))[0]!, message = (await sent())[0]!;
  await put(join(config.dataDir, 'feishu-inbox.jsonl'), [action('e2e-feedback', message.messageId, reminder.id)]);
  const path = join(root, 'config.json'); await put(path, JSON.stringify(config));
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), 'detect', '--config', path, '--now', '2026-10-23T18:00:00Z'], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(log, 'utf8'), 'called\n');
  const summary = (await readOutbox(config.dataDir)).find(n => n.kind === 'weekly')!; assert.ok(summary);
  assert.match(summary.text, /Claude Code × 在等你 \| 1 \| 0 \/ 1 \| 0\.0%/);
  assert.equal((await readFeedback(config.dataDir))[0]!.noticeId, reminder.id);
  assert.equal((await sent()).filter(m => m.noticeId === summary.id).length, 1);
});
