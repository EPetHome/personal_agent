import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { appendJsonl, readEvents, readJsonl, readOutbox } from '../src/core/store.ts';
import { event, project } from '../src/core/events.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import type { Channel, Notice } from '../src/core/types.ts';
import { loopSummary, put, putLoop, sandbox, piHeader, piMessage, start } from './fixtures.ts';
for (const status of ['暂停', '完成', '进行中']) test(`loop ${status}只读取自身总结，不再借Pi聊天目录取任务与阶段`, async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true })); await putLoop(f.config, f.root, status, start);
  f.config.sources.pi = join(f.root, 'pi'); await put(join(f.config.sources.pi, 'standalone.jsonl'), [piHeader(), piMessage('u', null, 'user', '不得混入loop的聊天内容')]);
  const view = await detect(f.config, start); assert.equal(view.records.length, 1); assert.equal(view.records[0]!.tool, 'loop'); assert.equal(view.records[0]!.loop!.status, status);
  assert.doesNotMatch(JSON.stringify(view.records), /不得混入loop/); assert.deepEqual((await rebuild(f.config)).records, view.records);
});
for (const role of ['development', 'review', 'acceptance'] as const) test(`飞书 A7 负向回归：总结10:00开始，${role}10:35仍输出，10:40不报停滞且不恢复扫描`, async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const id = '11111111-1111-4111-8111-111111111111', recent = '2026-10-20T10:35:00.000Z';
  const summary = await putLoop(f.config, f.root, '进行中', start, id);
  await utimes(summary, new Date(start), new Date(start));
  f.config.sources.pi = join(f.root, 'pi');
  const sessionId = role === 'development' ? id : `autoreview-${role === 'review' ? 'rev' : 'acc'}-${id}`;
  const transcript = join(f.config.sources.pi, `${role}.jsonl`);
  await put(transcript, [{ ...piHeader(), id: sessionId, cwd: '/sample/project' }, piMessage('u', null, 'user', '构造loop任务'),
    piMessage('a', 'u', 'assistant', [{ type: 'toolCall', id: 'live', name: 'bash', arguments: { command: '构造验证仍在进行' } }], recent, { stopReason: 'toolUse' })]);
  const before = await readFile(transcript);
  // 真实检测路径不得靠重新读取Pi目录/原件来通过此回归。
  const accesses: string[] = [];
  for (const method of ['open', 'readFile', 'readdir'] as const) {
    const original = fs.promises[method];
    t.mock.method(fs.promises, method, (...args: any[]) => {
      const path = String(args[0]);
      if (path === f.config.sources.pi || path.startsWith(f.config.sources.pi! + '/')) accesses.push(path);
      return (original as Function)(...args);
    });
  }
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 1000 };
  f.config.judge = { executable: '/constructed/must-not-run', model: 'fake', timeoutMs: 100 };
  const local: Notice[] = [], channel = feishuChannel(f.config);
  const localChannel: Channel = { name: 'local', levels: ['现在就要你', '有空看'], async send(notice) { local.push(notice); }, async receive() { return ''; } };
  let calls = 0;
  const components = { channels: [localChannel, channel], judge: { async writeSnapshot() { calls++; throw new Error('不应为推测的停滞起草'); } } };
  const view = await detect(f.config, '2026-10-20T10:40:00Z', components), run = view.records[0]!;
  assert.equal(run.status, '进行中'); assert.equal(run.lastActivityAt, start, '保留总结所见时间，不编造已采集到活动时间');
  assert.notEqual(run.rule!.id, 'unfinished_30m'); assert.match(run.reason, /总结时间不代表最后活动/);
  assert.deepEqual((await overview(f.config, '2026-10-20T10:41:00Z')).records, (await rebuild(f.config, '2026-10-20T10:41:00Z')).records);
  await detect(f.config, '2026-10-20T10:42:00Z', components);
  assert.deepEqual(await readOutbox(f.config.dataDir), []); assert.deepEqual(local, []);
  assert.deepEqual(await readJsonl<SentMessage>(join(f.config.dataDir, 'feishu-sent.jsonl')), []);
  assert.equal(calls, 0); assert.equal((await readEvents(f.config.dataDir)).some(e => e.kind === 'model_call_started'), false);
  assert.deepEqual(accesses, []); t.mock.restoreAll(); syncBuiltinESMExports();
  assert.deepEqual(await readFile(transcript), before);
});
for (const timing of ['old-round', 'old-mtime'] as const) test(`没有活动证据：${timing}超过30分钟或24小时均不推断loop停滞/搁置`, async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const summary = await putLoop(f.config, f.root, '进行中', start);
  if (timing === 'old-mtime') await put(summary, (await readFile(summary, 'utf8')).replace(/### 第 1 轮[^\n]*\n/, ''));
  await utimes(summary, new Date(start), new Date(start));
  for (const now of ['2026-10-20T10:40:00Z', '2026-10-21T12:00:00Z']) {
    const view = await detect(f.config, now); assert.equal(view.records[0]!.status, '进行中'); assert.equal(view.noticesAdded, 0);
  }
  assert.deepEqual(await readOutbox(f.config.dataDir), []);
});
test('旧总结年龄产生的待发停滞卡不恢复投递，原事件不改写', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await putLoop(f.config, f.root, '进行中', start); const view = await detect(f.config, start), record = view.records[0]!;
  const at = '2026-10-20T10:40:00.000Z', dedupeKey = `stalled:${record.key}`;
  const notice: Notice = { version: 1, id: 'legacy-summary-stalled', dedupeKey, at, tool: 'loop', kind: 'stalled', level: '有空看', sessionKey: record.key, evidenceAt: start,
    content: { title: '旧的loop停滞卡', summary: '40分钟没动静', returnCommand: '查看构造总结', evidence: { project: record.project, intentOriginal: null, additionalRequirements: [], recentSteps: [], originals: record.originals, reason: '只按轮次时间推断' } }, text: '旧正文' };
  await appendJsonl(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'notice_planned', notice }, at), event({ kind: 'channel_delivery', channel: 'feishu', noticeId: notice.id, ok: false, phase: 'queued' }, at)]);
  const prefix = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8'), sent: Notice[] = [];
  const channel: Channel = { name: 'feishu', levels: ['现在就要你', '有空看'], async send(value) { sent.push(value); }, async receive() { return ''; } };
  await detect(f.config, at, { channels: [channel] }); await rebuild(f.config, at);
  assert.deepEqual(sent, []); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  assert.equal((await overview(f.config, at)).projection.notices.some(n => n.id === notice.id), false);
  const events = await readEvents(f.config.dataDir); assert.ok(project(events).notices.some(n => n.id === notice.id));
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(prefix));
});
