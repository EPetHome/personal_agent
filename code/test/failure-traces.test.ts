// 丙段：全部使用临时构造库、SDK/通知/模型替身；不读取真实账号或运行数据。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { detect, overview, publishNotices, rebuild } from '../src/core/agent.ts';
import { validateConfig } from '../src/core/config.ts';
import { event, packProjection, project } from '../src/core/events.ts';
import { OperationFailure, safeDeliveryFailure } from '../src/core/failures.ts';
import { agentNotice } from '../src/core/learning.ts';
import { renderOverview } from '../src/core/judge.ts';
import { undeliveredNotices } from '../src/core/delivery.ts';
import { readEvents, readJsonl, readOutbox, withStoreLock } from '../src/core/store.ts';
import { prepareEventLog, restoreEventLog } from '../src/core/event-archive.ts';
import { acquireLock, recoverDeadLock } from '../src/core/locks.ts';
import { localChannel } from '../src/channels/local/index.ts';
import { hash } from '../src/core/utils.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import { realTransport } from '../src/channels/feishu/transport.ts';
import { runService } from '../src/service/daemon.ts';
import { processManagedLoop } from '../src/core/managed-loop.ts';
import type { AgentEvent, Channel, Notice } from '../src/core/types.ts';
import { ccCall, ccUser, put, putLoop, sandbox, start } from './fixtures.ts';

const cli = resolve(import.meta.dirname, '../src/cli/main.ts');
const raw = 'SYNTHETIC_PRIVATE_RESPONSE_WITH_TOKEN_AND_CARD_BODY';
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.sources.cc = null;
  f.config.feishu = { mode: 'fake', receiverId: 'ou_synthetic', timeoutMs: 1000 };
  const alerts: Notice[] = [];
  const local: Channel = { name: 'local', async send(notice) { alerts.push(notice); }, async receive() { return ''; } };
  const notice = agentNotice('service_restart', 'synthetic-failed-card', start, '构造任务的提醒', '这件事：构造的任务\n\n要你做：查看构造总览', '构造回看');
  return { ...f, notice, alerts, local };
}
const at = (minute: number) => new Date(Date.parse(start) + minute * 60000).toISOString();
async function notifyStub(root: string) {
  const executable = join(root, 'notification-stub'), output = join(root, 'notifications.jsonl');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2))+'\\n');\n`);
  await chmod(executable, 0o700);
  return { executable, timeoutMs: 5000, output };
}
function faultOpen(t: TestContext, fault: (path: string, flags: string | number) => boolean) {
  const original = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof original>) => {
    if (fault(String(args[0]), args[1] ?? 'r')) throw Object.assign(new Error(raw), { code: 'ENOSPC' });
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

async function archivedDelivery(t: TestContext, prefixFailures = 654, tailFailures = 0, pieces = 1) {
  const f = await fixture(t), old = '2026-10-12T10:00:00.000Z'; f.notice.at = old;
  const prefix = [event({ kind: 'notice_planned', notice: f.notice }, old),
    ...Array.from({ length: prefixFailures + 1 }, () => event({ kind: 'channel_delivery', channel: 'feishu', noticeId: f.notice.id, ok: false }, old)),
    event({ kind: 'notices_delivered', ids: [f.notice.id] }, old)];
  const state = packProjection(project(prefix));
  // 按乙段已发布格式构造：计数和告警索引根本不存在，不是空新表冒充旧数据。
  delete (state as Partial<typeof state>).channelDeliveryStates; delete (state as Partial<typeof state>).deliveryAlerted;
  const names: string[] = [], compressed: Buffer[] = [];
  await mkdir(join(f.config.dataDir, 'archives'), { recursive: true });
  for (let i = 0; i < pieces; i++) {
    const part = prefix.slice(Math.floor(prefix.length * i / pieces), Math.floor(prefix.length * (i + 1) / pieces));
    const raw = part.map(row => JSON.stringify(row) + '\n').join('');
    const name = `events-${String(i + 1).padStart(12, '0')}-${hash(raw)}.jsonl.gz`, data = await promisify(gzip)(Buffer.from(raw));
    names.push(name); compressed.push(data); await writeFile(join(f.config.dataDir, 'archives', name), data);
  }
  const checkpoint = event({ kind: 'store_checkpoint', format: 2, sequence: pieces, archive: names.at(-1)!, archives: names, state }, start);
  const tail = Array.from({ length: tailFailures }, () => event({ kind: 'channel_delivery', channel: 'feishu', noticeId: f.notice.id, ok: false }, at(1)));
  await put(join(f.config.dataDir, 'events.jsonl'), [checkpoint, ...tail]); await put(join(f.config.dataDir, 'outbox.jsonl'), [f.notice]);
  const original = await readFile(join(f.config.dataDir, 'events.jsonl'));
  return { ...f, checkpoint, names, compressed, original };
}

test('丙 A1/A2：实际飞书适配替身连续失败只发5次，每次分类且停发只通知一次，文本/JSON/重建可查', async t => {
  const f = await fixture(t); let calls = 0;
  const channel = feishuChannel(f.config, { async send() { calls++; throw Object.assign(new Error(raw), { code: 'ECONNREFUSED' }); } });
  const channels = [f.local, channel];
  await publishNotices(f.config, [f.notice], start, channels);
  for (let i = 1; i < 9; i++) await detect(f.config, at(i), { channels });
  assert.equal(calls, 5); assert.equal(f.alerts.length, 1);
  const alert = f.alerts[0]!; assert.equal(alert.kind, 'delivery_failed');
  for (const text of [f.notice.content.title, '飞书', 'channel_connection']) assert.ok(JSON.stringify(alert).includes(text));
  assert.ok(!JSON.stringify(alert).includes(raw));
  const events = await readEvents(f.config.dataDir);
  const attempts = events.filter(e => e.kind === 'channel_delivery' && e.phase === 'attempted');
  assert.equal(attempts.length, 5); assert.ok(attempts.every(e => e.kind === 'channel_delivery' && e.failure?.category === 'channel_connection'));
  assert.equal(events.filter(e => e.kind === 'channel_delivery' && e.phase === 'queued').length, 1, '排队不算一次失败');
  const view = await overview(f.config), text = renderOverview(view.records, view.projection);
  assert.match(text, /没发出去：构造任务的提醒 → 飞书；连续失败 5 次，已停发；channel_connection/);
  assert.doesNotMatch(text, /下轮检测重试/);
  const state = await rebuild(f.config); assert.equal(undeliveredNotices(state.projection)[0]!.stopped, true);
  assert.equal(JSON.parse(await readFile(join(f.config.dataDir, 'state.json'), 'utf8')).undeliveredNotices[0].failures, 5);
  const path = join(f.root, 'config.json'); await put(path, JSON.stringify(f.config));
  const result = spawnSync(process.execPath, [cli, 'overview', '--config', path, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).deliveries, {}, '新CLI不恢复或补发旧队列；旧兼容查询在上面单独验证');
  const outbox = await readOutbox(f.config.dataDir); assert.deepEqual(outbox.map(n => n.id), [f.notice.id]);
  assert.ok(!(await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).includes(raw));
  // 检查点保留计数和通知去重，正常查询/重建也不需要已封存原件。
  const beforeOutbox = await readFile(join(f.config.dataDir, 'outbox.jsonl'));
  // 减法后不再自动封存；显式准备旧检查点以继续验证失败计数的兼容读取。
  await withStoreLock(f.config.dataDir, () => prepareEventLog(f.config.dataDir, '2026-10-29T10:00:00Z'));
  await detect(f.config, '2026-10-29T10:00:00Z', { channels });
  assert.equal((await readEvents(f.config.dataDir))[0]!.kind, 'store_checkpoint');
  await rename(join(f.config.dataDir, 'archives'), join(f.config.dataDir, 'archives-hidden'));
  await rebuild(f.config); await detect(f.config, '2026-10-29T10:01:00Z', { channels });
  assert.equal(calls, 5); assert.equal(f.alerts.length, 1);
  assert.deepEqual(await readFile(join(f.config.dataDir, 'outbox.jsonl')), beforeOutbox);
});

test('丙 A3：前两次失败第三次成功，只收一次，随后不重发、不弹停发通知', async t => {
  const f = await fixture(t); let calls = 0, received = 0;
  const channel = feishuChannel(f.config, { async send() { calls++; if (calls < 3) throw Object.assign(new Error(raw), { code: 'ETIMEDOUT' }); received++; return 'om_synthetic_success'; } });
  const channels = [f.local, channel];
  await publishNotices(f.config, [f.notice], start, channels);
  for (let i = 1; i < 8; i++) await detect(f.config, at(i), { channels });
  assert.equal(calls, 3); assert.equal(received, 1); assert.equal(f.alerts.length, 0);
  const projection = (await overview(f.config)).projection;
  assert.deepEqual(projection.channelDeliveryStates.get(`feishu:${f.notice.id}`), { failures: 0 });
  assert.deepEqual(undeliveredNotices(projection), []);
  const attempts = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'channel_delivery' && e.phase === 'attempted');
  assert.deepEqual(attempts.map(e => e.kind === 'channel_delivery' ? e.failure?.category ?? 'success' : ''), ['channel_timeout', 'channel_timeout', 'success']);
});

test('丙 A4：真正旧格式654次失败升级即停发，旧原因如实未知，实际通知替身跨CLI重启只弹一次', async t => {
  const f = await fixture(t), notify = await notifyStub(f.root); f.config.localChannel = notify;
  // 原版形状：第一条 false 为队列，其后654条才是失败；不含新字段或格式标记。
  const rows = [event({ kind: 'notice_planned', notice: f.notice }, start),
    ...Array.from({ length: 655 }, () => event({ kind: 'channel_delivery', channel: 'feishu', noticeId: f.notice.id, ok: false }, start)),
    event({ kind: 'notices_delivered', ids: [f.notice.id] }, start)];
  await put(join(f.config.dataDir, 'events.jsonl'), rows); await put(join(f.config.dataDir, 'outbox.jsonl'), [f.notice]);
  const original = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  await detect(f.config, at(1));
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(original));
  assert.deepEqual(await readJsonl(join(f.config.dataDir, 'feishu-sent.jsonl')), [], '不能先重发一次才发现超限');
  const item = undeliveredNotices((await overview(f.config)).projection)[0]!;
  assert.equal(item.failures, 654); assert.equal(item.stopped, true); assert.equal(item.failure.category, 'legacy_unknown');
  const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
  for (let i = 2; i < 4; i++) {
    const result = spawnSync(process.execPath, [cli, 'detect', '--config', configPath, '--now', at(i)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const notifications = await readJsonl<string[]>(notify.output); assert.equal(notifications.length, 1);
  for (const text of [f.notice.content.title, '飞书', 'legacy_unknown']) assert.ok(notifications[0]!.join('').includes(text));
  assert.equal((await readOutbox(f.config.dataDir)).length, 1);
});

test('丙 渠道相互独立且同卡仅一次告警，本机告警失败不递归或重试', async t => {
  const f = await fixture(t); f.notice.level = '现在就要你'; let localCalls = 0, feishuCalls = 0;
  const local: Channel = { ...f.local, async send() { localCalls++; throw new Error(raw); } };
  const feishu: Channel = { ...f.local, name: 'feishu', async send() { feishuCalls++; throw Object.assign(new Error(raw), { status: 400 }); } };
  for (let i = 0; i < 7; i++) await publishNotices(f.config, [f.notice], at(i), [local, feishu]);
  assert.equal(feishuCalls, 5); assert.equal(localCalls, 6, '5次原卡失败加一次停发告警尝试');
  const alerts = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'notice_delivery_alerted');
  assert.equal(alerts.length, 2); assert.equal(alerts[1]!.kind === 'notice_delivery_alerted' && alerts[1]!.ok, false);
  assert.equal(undeliveredNotices((await overview(f.config)).projection).filter(item => item.stopped).length, 2);
});

test('丙 成功后不受迟到失败/旧排队影响，另一渠道照常重试', async t => {
  const f = await fixture(t); f.notice.level = '现在就要你'; let sent = 0, failed = 0;
  const local: Channel = { ...f.local, async send() { sent++; } };
  const feishu: Channel = { ...f.local, name: 'feishu', async send() { failed++; throw new Error(raw); } };
  await publishNotices(f.config, [f.notice], start, [local, feishu]);
  const events = await readEvents(f.config.dataDir);
  await put(join(f.config.dataDir, 'events.jsonl'), [...events, event({ kind: 'channel_delivery', channel: 'local', noticeId: f.notice.id, ok: false }, start)]);
  await detect(f.config, at(1), { channels: [local, feishu] });
  assert.equal(sent, 1); assert.equal(failed, 2);
  assert.equal((await overview(f.config)).projection.channelDeliveries.get(`local:${f.notice.id}`), true);
});

test('丙 老检查点缺新索引仍可查询/检测，不伪造已经成功的渠道失败', async t => {
  const f = await fixture(t);
  const state = packProjection(project([event({ kind: 'notice_planned', notice: f.notice }, start),
    event({ kind: 'channel_delivery', channel: 'feishu', noticeId: f.notice.id, ok: true }, start)]));
  delete (state as Partial<typeof state>).channelDeliveryStates; delete (state as Partial<typeof state>).deliveryAlerted;
  const name = `events-000000000001-${'a'.repeat(64)}.jsonl.gz`;
  await put(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'store_checkpoint', format: 2, sequence: 1, archive: name, archives: [name], state }, start)]);
  let calls = 0; const channel: Channel = { ...f.local, name: 'feishu', levels: ['现在就要你', '有空看'], async send() { calls++; } };
  await overview(f.config); await rebuild(f.config); await detect(f.config, at(1), { channels: [channel, f.local] });
  assert.equal(calls, 0); assert.deepEqual(undeliveredNotices((await overview(f.config)).projection), []);
});

test('丙 返修1 A4：旧检查点的654次归档失败升级零重发，持久化后独立进程不读归档、不重复告警', async t => {
  const f = await archivedDelivery(t); let calls = 0;
  const channel: Channel = { ...f.local, name: 'feishu', levels: ['现在就要你', '有空看'], async send() { calls++; throw new Error(raw); } };
  await detect(f.config, at(2), { channels: [channel, f.local] });
  assert.equal(calls, 0, '归档超限失败不能先重发一次才补计数'); assert.equal(f.alerts.length, 1);
  const view = await overview(f.config), item = undeliveredNotices(view.projection)[0]!;
  assert.equal(item.failures, 654); assert.equal(item.stopped, true); assert.match(renderOverview(view.records, view.projection), /连续失败 654 次，已停发/);
  const rows = await readEvents(f.config.dataDir), restored = rows.filter(e => e.kind === 'channel_delivery_history_restored');
  assert.equal(restored.length, 1);
  const migration = restored[0]!; if (migration.kind !== 'channel_delivery_history_restored') throw new Error('缺历史恢复事件');
  assert.equal(migration.checkpointId, f.checkpoint.id);
  assert.deepEqual(await readFile(join(migration.backup, 'events.jsonl')), f.original, '恢复计数前先备份旧库');
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'))).subarray(0, f.original.length).equals(f.original));
  const complete = join(f.root, 'restored.jsonl');
  await withStoreLock(f.config.dataDir, () => restoreEventLog(f.config.dataDir, complete));
  const replay = project(await readJsonl<AgentEvent>(complete));
  assert.deepEqual(replay.channelDeliveryStates.get(`feishu:${f.notice.id}`), view.projection.channelDeliveryStates.get(`feishu:${f.notice.id}`), '还原全部原始事件不重复累计恢复计数');
  await rename(join(f.config.dataDir, 'archives'), join(f.config.dataDir, 'archives-hidden'));
  const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
  const child = spawnSync(process.execPath, [cli, 'detect', '--config', configPath, '--now', at(3), '--json'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout).deliveries, {}, '新账本不迁移旧渠道状态');
  await rebuild(f.config); await detect(f.config, at(4), { channels: [channel, f.local] });
  assert.equal(calls, 0); assert.equal(f.alerts.length, 1);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'channel_delivery_history_restored').length, 1);
  assert.deepEqual(await readJsonl(join(f.config.dataDir, 'feishu-sent.jsonl')), []);
  await detect(f.config, '2026-10-29T10:00:00Z', { channels: [channel, f.local] });
  const later = await readEvents(f.config.dataDir); assert.equal(later[0]!.kind, 'store_checkpoint');
  assert.equal(undeliveredNotices((await overview(f.config)).projection)[0]!.failures, 654);
  assert.equal(calls, 0); assert.equal(f.alerts.length, 1, '恢复事件再次封存后也不失去计数和告警去重');
});

test('丙 返修1 A4：旧归档只有排队时恢复为准确零次，允许一次成功而非误停发', async t => {
  const f = await archivedDelivery(t, 0); let calls = 0;
  const channel: Channel = { ...f.local, name: 'feishu', levels: ['现在就要你', '有空看'], async send() { calls++; } };
  await detect(f.config, at(2), { channels: [channel, f.local] });
  assert.equal(calls, 1); assert.equal(f.alerts.length, 0);
  assert.equal((await overview(f.config)).projection.channelDeliveries.get(`feishu:${f.notice.id}`), true);
  await rename(join(f.config.dataDir, 'archives'), join(f.config.dataDir, 'archives-hidden'));
  await detect(f.config, at(3), { channels: [channel, f.local] });
  assert.equal(calls, 1); assert.deepEqual(undeliveredNotices((await overview(f.config)).projection), []);
});

test('丙 返修1 A4：检查点后已经成功的渠道无需归档也不重发，不强制恢复已无用的失败历史', async t => {
  const f = await archivedDelivery(t);
  await appendFile(join(f.config.dataDir, 'events.jsonl'), JSON.stringify(event({ kind: 'channel_delivery', channel: 'feishu', noticeId: f.notice.id, ok: true }, at(1))) + '\n');
  await rename(join(f.config.dataDir, 'archives'), join(f.config.dataDir, 'archives-hidden'));
  let calls = 0; const channel: Channel = { ...f.local, name: 'feishu', levels: ['现在就要你', '有空看'], async send() { calls++; } };
  await detect(f.config, at(2), { channels: [channel, f.local] }); await rebuild(f.config);
  assert.equal(calls, 0); assert.equal(f.alerts.length, 0); assert.deepEqual(undeliveredNotices((await overview(f.config)).projection), []);
  assert.equal((await readEvents(f.config.dataDir)).some(row => row.kind === 'channel_delivery_history_restored'), false);
});

for (const prefix of [3, 2]) test(`丙 返修1 A4：两份归档${prefix}次加检查点后2次失败，按真实总数决定是否还可尝试`, async t => {
  const f = await archivedDelivery(t, prefix, 2, 2); let calls = 0;
  const channel: Channel = { ...f.local, name: 'feishu', levels: ['现在就要你', '有空看'], async send() { calls++; throw new Error(raw); } };
  await detect(f.config, at(2), { channels: [channel, f.local] });
  assert.equal(calls, prefix === 3 ? 0 : 1);
  assert.equal(undeliveredNotices((await overview(f.config)).projection)[0]!.failures, 5);
  assert.equal(f.alerts.length, 1);
  await detect(f.config, at(3), { channels: [channel, f.local] });
  assert.equal(calls, prefix === 3 ? 0 : 1); assert.equal(f.alerts.length, 1);
});

for (const failure of ['missing', 'checksum', 'no-history'] as const) test(`丙 返修1 A4：旧检查点历史${failure}时明确未知并暂停，不归零发送；修复归档后可恢复`, async t => {
  const f = await archivedDelivery(t); let calls = 0;
  const path = join(f.config.dataDir, 'archives', f.names[0]!);
  if (failure === 'missing') await rm(path);
  else if (failure === 'checksum') await writeFile(path, await promisify(gzip)(Buffer.from('合法gzip但哈希不符\n')));
  else {
    const content = JSON.stringify(event({ kind: 'scan_completed' }, start)) + '\n', name = `events-000000000001-${hash(content)}.jsonl.gz`;
    await writeFile(join(f.config.dataDir, 'archives', name), await promisify(gzip)(Buffer.from(content)));
    if (f.checkpoint.kind !== 'store_checkpoint') throw new Error('缺检查点');
    f.checkpoint.archive = name; f.checkpoint.archives = [name]; await put(join(f.config.dataDir, 'events.jsonl'), [f.checkpoint]);
  }
  const before = await readFile(join(f.config.dataDir, 'events.jsonl'));
  const view = await overview(f.config), item = undeliveredNotices(view.projection)[0]!;
  assert.equal(item.failures, null, '未知历史不能声称失败零次'); assert.equal(item.stopped, true);
  assert.match(renderOverview(view.records, view.projection), /历史失败次数待恢复，暂停发送/);
  const channel: Channel = { ...f.local, name: 'feishu', levels: ['现在就要你', '有空看'], async send() { calls++; } };
  await assert.rejects(detect(f.config, at(2), { channels: [channel, f.local] }));
  assert.equal(calls, 0); assert.equal(f.alerts.length, 0);
  assert.deepEqual(await readFile(join(f.config.dataDir, 'events.jsonl')), before);
  await writeFile(path, f.compressed[0]!);
  if (f.checkpoint.kind !== 'store_checkpoint') throw new Error('缺检查点');
  f.checkpoint.archive = f.names[0]!; f.checkpoint.archives = f.names; await put(join(f.config.dataDir, 'events.jsonl'), [f.checkpoint]);
  await detect(f.config, at(3), { channels: [channel, f.local] });
  assert.equal(calls, 0); assert.equal(f.alerts.length, 1);
  assert.equal(undeliveredNotices((await overview(f.config)).projection)[0]!.failures, 654);
});

for (const stage of ['delivery_history_synced', 'delivery_history_published']) test(`丙 返修1 A4：历史计数升级在${stage}实际SIGKILL，恢复仍零重发`, { timeout: 15000 }, async t => {
  const f = await archivedDelivery(t), ready = join(f.root, 'ready');
  const module = new URL('../src/core/event-archive.ts', import.meta.url).href, store = new URL('../src/core/store.ts', import.meta.url).href;
  const program = `import {prepareEventLog} from ${JSON.stringify(module)}; import {withStoreLock} from ${JSON.stringify(store)}; import {writeFile} from 'node:fs/promises';
    await withStoreLock(${JSON.stringify(f.config.dataDir)}, () => prepareEventLog(${JSON.stringify(f.config.dataDir)}, ${JSON.stringify(at(2))}, {onStage: async stage => {
      if(stage !== ${JSON.stringify(stage)}) return; await writeFile(${JSON.stringify(ready)}, 'ready'); setInterval(()=>{},1000); await new Promise(()=>{});
    }}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', chunk => output += chunk);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  let seen = false;
  for (let i = 0; i < 500; i++) {
    if (await readFile(ready, 'utf8').catch(() => '') === 'ready') { seen = true; break; }
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(seen, output || '未到历史恢复提交点');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await recoverDeadLock(f.config.dataDir, '.detect.lock');
  const bytes = await readFile(join(f.config.dataDir, 'events.jsonl'));
  if (stage === 'delivery_history_synced') assert.deepEqual(bytes, f.original);
  else {
    assert.ok(bytes.subarray(0, f.original.length).equals(f.original));
    await rename(join(f.config.dataDir, 'archives'), join(f.config.dataDir, 'archives-hidden'));
  }
  let calls = 0; const channel: Channel = { ...f.local, name: 'feishu', levels: ['现在就要你', '有空看'], async send() { calls++; } };
  await detect(f.config, at(3), { channels: [channel, f.local] });
  assert.equal(calls, 0); assert.equal(f.alerts.length, 1);
  assert.equal(undeliveredNotices((await overview(f.config)).projection)[0]!.failures, 654);
});

test('丙 飞书拒收/连接/超时分类：真实适配边界的SDK替身不泄漏响应', async t => {
  const f = await fixture(t);
  class Client { im = { message: { async create() { return { code: 230001, msg: raw }; } } }; }
  const transport = await realTransport(f.config.feishu!, { credentials: { appId: 'cli_0000000000000000', appSecret: 'SYNTHETIC_SECRET' },
    loadSdk: async () => ({ Client, AppType: { SelfBuild: 0 } }) as unknown as typeof import('@larksuiteoapi/node-sdk') });
  const channel = feishuChannel(f.config, transport);
  await publishNotices(f.config, [f.notice], start, [channel]);
  assert.equal(undeliveredNotices((await overview(f.config)).projection)[0]!.failure.category, 'channel_rejected');
  assert.ok(!(await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).includes(raw));
  // 永不应答的替身也在渠道时限结束后记录受控的超时，而非笼统失败。
  const other = { ...f.notice, id: `${f.notice.id}-timeout`, dedupeKey: 'timeout' }; f.config.feishu!.timeoutMs = 10;
  await publishNotices(f.config, [other], at(1), [feishuChannel(f.config, { send: async () => new Promise(() => {}) })]);
  assert.equal(undeliveredNotices((await overview(f.config)).projection).find(item => item.noticeId === other.id)!.failure.category, 'channel_timeout');
  for (const [error, category] of [[Object.assign(new Error(raw), { code: 'EDQUOT' }), 'storage_full'],
    [new OperationFailure('channel_permission', raw), 'channel_permission'], [new OperationFailure('__proto__', raw), 'channel_unknown'],
    [new Error(`request timed out ${raw}`), 'channel_timeout']] as const) {
    const failure = safeDeliveryFailure(error); assert.equal(failure.category, category); assert.ok(!JSON.stringify(failure).includes(raw));
  }
});

test('丙 A5：实际常驻检测坏JSONL时，服务日志带data_corrupt而无原件/异常原文', async t => {
  const f = await fixture(t); f.config.feishu = null;
  await put(join(f.config.dataDir, 'ledger.jsonl'), `{${raw}\n`);
  const control = new AbortController();
  const run = runService(f.config, control.signal, { channels: [f.local] });
  t.after(() => { control.abort(); return run.catch(() => {}); });
  for (let i = 0; i < 300; i++) {
    const rows = await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'));
    if (rows.some(row => row.kind === 'scan_failed')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  control.abort(); await run;
  const log = await readFile(join(f.config.dataDir, 'service.log.jsonl'), 'utf8');
  const failed = (await readJsonl<{ kind: string; category?: string }>(join(f.config.dataDir, 'service.log.jsonl'))).find(row => row.kind === 'scan_failed');
  assert.equal(failed?.category, 'data_corrupt'); assert.ok(!log.includes(raw));
  assert.equal(await readFile(join(f.config.dataDir, 'ledger.jsonl'), 'utf8'), `{${raw}\n`);
});

test('丙 A6：很久前的单次异常也留痕，已知原因重分类；正常停止后不误报', async t => {
  const f = await fixture(t); f.config.feishu = null;
  await put(join(f.config.dataDir, 'service-runs.jsonl'), [{ kind: 'start', at: start, runId: 'old-run' },
    { kind: 'failed', at: start, runId: 'old-run', failure: { category: 'storage_full', reason: raw } }]);
  const runOnce = async () => {
    const control = new AbortController(); control.abort();
    await runService(f.config, control.signal, { channels: [f.local] });
  };
  await runOnce(); await runOnce();
  const log = await readJsonl<{ kind: string; message?: string; category?: string }>(join(f.config.dataDir, 'service.log.jsonl'));
  const previous = log.filter(row => row.kind === 'previous_abnormal_exit');
  assert.equal(previous.length, 1); assert.equal(previous[0]!.message, '上次没有正常停止'); assert.equal(previous[0]!.category, 'storage_full');
  assert.equal(f.alerts.length, 0, '单次异常不改变已有短时反复重启告警');
  assert.ok(!JSON.stringify(log).includes(raw));
});

test('丙 A7：实际状态写入时磁盘写满，连续失败本机只告警一次；完整恢复后再次满盘可再告警', async t => {
  const f = await fixture(t); f.config.feishu = null; let full = true;
  faultOpen(t, path => full && path.startsWith(join(f.config.dataDir, '.state-')));
  for (let i = 0; i < 3; i++) await assert.rejects(detect(f.config, at(i), { channels: [f.local] }), { code: 'ENOSPC' });
  assert.equal(f.alerts.length, 1); assert.equal(f.alerts[0]!.kind, 'storage_full');
  assert.match(JSON.stringify(f.alerts[0]), /磁盘已满.*盯防可能停了/);
  full = false; await detect(f.config, at(3), { channels: [f.local] });
  full = true; await assert.rejects(detect(f.config, at(4), { channels: [f.local] }), { code: 'ENOSPC' });
  assert.equal(f.alerts.length, 2); assert.ok(!JSON.stringify(f.alerts).includes(raw));
});

test('丙 A7：常驻满盘检测日志带storage_full，连续失败不会被内部成功写入错误解除', async t => {
  const f = await fixture(t); f.config.feishu = null;
  f.config.inboxDir = null;
  f.config.managedLoop = { intakeEveryMs: 20, verifyAfterMs: 0, inspectEveryMs: 1, staleAfterMs: 1800000 };
  const control = new AbortController(); let writes = 0;
  faultOpen(t, (path, flags) => {
    if (!path.startsWith(join(f.config.dataDir, '.runtime-')) || typeof flags === 'number' && !(flags & fs.constants.O_WRONLY) || flags === 'r') return false;
    // 运行信号不再入账：启动信号先尝试一次，之后仍须完整记录三轮小状态写满失败。
    if (++writes === 4) control.abort(); return true;
  });
  await runService(f.config, control.signal, { channels: [f.local] });
  const failed = (await readJsonl<{ kind: string; category?: string }>(join(f.config.dataDir, 'service.log.jsonl'))).filter(row => row.kind === 'scan_failed');
  assert.equal(failed.length, 3); assert.ok(failed.every(row => row.category === 'storage_full'));
  assert.equal(f.alerts.length, 1); assert.equal(f.alerts[0]!.kind, 'storage_full');
});

test('丙 A7 验收返修：状态写满后夹有lock_busy轮次，不算恢复，实际通知命令只执行一次', { timeout: 10000 }, async t => {
  const f = await fixture(t), notify = await notifyStub(f.root); f.config.localChannel = notify;
  f.config.inboxDir = null;
  f.config.managedLoop = { intakeEveryMs: 20, verifyAfterMs: 0, inspectEveryMs: 10, staleAfterMs: 1800000 };
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  await put(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'store_format', format: 2 }, old), event({ kind: 'scan_completed' }, old)]);
  faultOpen(t, (path, flags) => path.startsWith(join(f.config.dataDir, '.runtime-')) && flags !== 'r' && (typeof flags !== 'number' || !!(flags & fs.constants.O_WRONLY)));
  const channel = feishuChannel(f.config), startChannel = channel.start;
  let release: (() => Promise<void>) | undefined;
  channel.start = async () => {
    // 状态写入先报ENOSPC，随后保持数据锁，复现满盘夹杂非满盘失败的轮次。
    await startChannel();
    await assert.rejects(processManagedLoop(f.config, new Date().toISOString(), { channels: [localChannel(f.config.dataDir, f.config.localChannel!)], inspect: true }), { code: 'ENOSPC' });
    release = await acquireLock(f.config.dataDir, '.managed-work.lock');
  };
  const control = new AbortController(), running = runService(f.config, control.signal, {
    channels: [localChannel(f.config.dataDir, f.config.localChannel), channel],
  });
  void running.catch(() => {});
  const waitForFailure = async (category: string, count: number) => {
    for (let i = 0; i < 500; i++) {
      const rows = await readJsonl<{ kind: string; category?: string }>(join(f.config.dataDir, 'service.log.jsonl')).catch(() => []);
      if (rows.filter(row => row.kind === 'scan_failed' && row.category === category).length >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`构造常驻未出现预期的 ${category} 轮次`);
  };
  try {
    await waitForFailure('lock_busy', 2);
    assert.equal((await readJsonl<string[]>(notify.output)).filter(args => args.at(-2) === '磁盘已满，盯防可能停了').length, 1, '同类满盘故障只通知一次；可写账本里的其他故障另计');
    await release!(); release = undefined;
    await waitForFailure('storage_full', 3);
    control.abort(); await running;
    const notifications = await readJsonl<string[]>(notify.output);
    assert.equal(notifications.filter(args => args.at(-2) === '磁盘已满，盯防可能停了').length, 1,
      'lock_busy被捕获且日志成功，不代表存储已经恢复，不能重新弹满盘告警');
    const log = await readJsonl<{ kind: string; category?: string }>(join(f.config.dataDir, 'service.log.jsonl'));
    assert.equal(log.some(row => row.kind === 'scan_completed'), false);
    assert.equal(log.at(-1)!.kind, 'stopped');
  } finally { if (release) await release(); control.abort(); await running; }
});

test('丙 A7：连服务日志也写不进时仍通知且不每轮重弹，恢复后补记原因', async t => {
  const f = await fixture(t); f.config.feishu = null;
  f.config.inboxDir = null;
  f.config.managedLoop = { intakeEveryMs: 20, verifyAfterMs: 0, inspectEveryMs: 1, staleAfterMs: 1800000 };
  const control = new AbortController(); let attempts = 0, full = false;
  faultOpen(t, (path, flags) => {
    if (path.startsWith(join(f.config.dataDir, '.runtime-')) && flags !== 'r' && (typeof flags !== 'number' || !!(flags & fs.constants.O_WRONLY))) full = true;
    if (!full || !path.startsWith(f.config.dataDir) || flags === 'r' || typeof flags === 'number' && !(flags & fs.constants.O_WRONLY)) return false;
    if (++attempts >= 9) full = false, control.abort();
    return true;
  });
  await runService(f.config, control.signal, { channels: [f.local] });
  assert.equal(f.alerts.length, 1);
  const log = await readJsonl<{ kind: string; category?: string }>(join(f.config.dataDir, 'service.log.jsonl'));
  assert.ok(log.some(row => row.kind === 'storage_full' && row.category === 'storage_full'), '恢复后补记此前写不进的原因');
});

test('丙 A7：启动建锁满盘与告警命令失败也不掩盖原错误、不递归弹窗', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.config.feishu = null; let alerts = 0;
  const original = fs.promises.writeFile;
  t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof original>) => {
    if (String(args[0]).includes('.service.lock.owned-')) throw Object.assign(new Error(raw), { code: 'ENOSPC' });
    return original(...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const local: Channel = { ...f.local, async send() { alerts++; throw new Error(raw); } };
  for (let i = 0; i < 2; i++) await assert.rejects(runService(f.config, new AbortController().signal, { channels: [local] }), { code: 'ENOSPC' });
  assert.equal(alerts, 1);
});

for (const limit of [undefined, 2, 0]) test(`丙 A8：配置每日上限${limit === undefined ? '省略，跨过240次仍继续' : limit}，检测仍遵循显式限制`, async t => {
  const f = await fixture(t); f.config.feishu = null; f.config.sources.cc = join(f.root, 'cc');
  f.config.judge = { executable: '/synthetic/no-model', model: 'fake', timeoutMs: 1000, ...(limit === undefined ? {} : { dailyLimit: limit }) };
  const validated = await validateConfig(f.config); assert.equal(validated.judge!.dailyLimit, limit);
  assert.equal(JSON.stringify(validated).includes('Infinity'), false);
  const rows: AgentEvent[] = [event({ kind: 'store_format', format: 2 }, start)];
  if (limit === undefined) for (let i = 0; i < 240; i++) rows.push(event({ kind: 'model_call_started', task: 'drift', key: `old-${i}` }, start));
  await put(join(f.config.dataDir, 'events.jsonl'), rows);
  let calls = 0;
  const judge = { async writeSnapshot() { calls++; return { situation: '构造loop已完成', action: '看人工项', actionType: '去看一眼' as const }; } };
  for (let i = 0; i < 3; i++) {
    await putLoop(f.config, f.root, '完成', at(i * 11), `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`);
    await detect(f.config, at(i * 11 + 1), { judge, channels: [] });
  }
  assert.equal(calls, limit ?? 3);
  const view = await overview(f.config);
  assert.equal(view.projection.modelCalls.get(start.slice(0, 10)) ?? 0, limit === undefined ? 243 : limit);
});
