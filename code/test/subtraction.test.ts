// 全新 PA 甲：仅构造会话、临时数据与假飞书，不读真实账号/个人目录。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { validateConfig } from '../src/core/config.ts';
import { event } from '../src/core/events.ts';
import { readEvents, readJsonl, readOutbox } from '../src/core/store.ts';
import { runService } from '../src/service/daemon.ts';
import { sandbox, put, start, loopSummary, ccAnswer, ccCall, ccUser, codexMeta, codexEvent, piHeader, piMessage, pushed } from './fixtures.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import type { Judge } from '../src/core/types.ts';

async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 1000 };
  f.config.sources.codex = join(f.root, 'codex'); f.config.sources.pi = join(f.root, 'pi');
  const marker = join(f.root, 'model-called'), executable = join(f.root, 'model-stub');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called');process.exit(1);\n`);
  await chmod(executable, 0o700);
  f.config.judge = { executable, model: 'constructed', timeoutMs: 500 };
  const legacy = { ...f.config, waiting: { awayMinutes: 1 }, learning: true, intelligence: { enabled: true, timeoutMs: 1 } };
  return { ...f, legacy, marker, sent: () => readJsonl<SentMessage>(join(f.config.dataDir, 'feishu-sent.jsonl')) };
}
async function quiet(f: Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual(await readOutbox(f.config.dataDir), []);
  assert.deepEqual((await f.sent()).filter(row => row.type === 'interactive'), []);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'model_call_started' || e.kind.startsWith('analysis_') || e.kind.startsWith('shadow_')).length, 0);
  assert.equal(await readFile(f.marker, 'utf8').catch(() => ''), '');
}
test('甲 A1：CC 最后一句提问，不扫描、不出卡、不调模型（含旧智能配置）', async t => {
  const f = await fixture(t), answer = ccAnswer(); answer.message.content[0]!.text = '你选 A 还是 B？';
  const path = join(f.config.sources.cc!, 'question.jsonl'); await put(path, [ccUser(), answer]); const before = await readFile(path);
  const view = await detect(f.legacy, '2026-10-20T10:31:00Z');
  assert.deepEqual(view.records, []); assert.deepEqual([...view.projection.health.keys()], []); await quiet(f);
  assert.deepEqual(await readFile(path), before);
});
test('甲 A2：Codex 明显偏离目标，不出跑偏卡、不调模型', async t => {
  const f = await fixture(t);
  await put(join(f.config.sources.codex!, 'drift.jsonl'), [codexMeta(), codexEvent({ type: 'user_message', message: '只改 A 测试' }),
    codexEvent({ type: 'function_call', call_id: 'b', name: 'shell', arguments: '{"command":"修改无关 B 模块"}' }, 'response_item')]);
  await detect(f.legacy, '2026-10-20T10:31:00Z'); await quiet(f);
});
test('甲 A3：单独 Pi 超过三十分钟没动静，不出停滞卡', async t => {
  const f = await fixture(t);
  await put(join(f.config.sources.pi!, 'idle.jsonl'), [piHeader(), piMessage('u', null, 'user', '构造任务'),
    piMessage('a', 'u', 'assistant', [{ type: 'toolCall', id: 'pending', name: 'bash', arguments: { command: 'npm test' } }], start, { stopReason: 'toolUse' })]);
  await detect(f.legacy, '2026-10-20T10:31:00Z'); await quiet(f);
});
for (const status of ['暂停', '完成', '暂停：执行失败']) test(`甲 ${status === '暂停' ? 'A4' : status === '完成' ? 'A5' : '保留失败'}：loop ${status}仍出一张卡，重复/重建不重发`, async t => {
  const f = await fixture(t); f.config.sources.loop = join(f.root, 'loop'); f.config.judge = null;
  await put(join(f.config.sources.loop, 'project', '11111111-1111-4111-8111-111111111111.md'), loopSummary(status, '/sample/project', '- 决定下一步'));
  await detect(f.config, start); await detect(f.config, '2026-10-20T10:05:00Z');
  const out = await readOutbox(f.config.dataDir); assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, status === '完成' ? 'loop_completed' : 'loop_paused');
  await rebuild(f.config); await detect(f.config, '2026-10-20T10:06:00Z');
  assert.equal((await readOutbox(f.config.dataDir)).length, 1); assert.equal((await f.sent()).filter(row => row.type === 'interactive').length, 1);
});
test('甲 A6：常驻跨当地20点和周五18点，不发每日汇总/周报/复盘、不新建学习日志', { timeout: 10000 }, async t => {
  const f = await fixture(t), controller = new AbortController(); t.after(() => controller.abort());
  let clock = new Date(2026, 9, 22, 19, 59).toISOString();
  f.legacy.service = { intervalMs: 15, restartThreshold: 3, restartWindowMs: 300000 };
  const service = runService(f.legacy, controller.signal, { now: () => clock });
  async function scanned(at: string) {
    for (let i = 0; i < 400; i++) {
      if ((await readJsonl<{ kind: string; at: string }>(join(f.config.dataDir, 'service.log.jsonl'))).some(row => row.kind === 'scan_completed' && row.at === at)) return;
      await delay(10);
    }
    throw new Error(`服务未完成构造时钟 ${at}`);
  }
  try {
    await scanned(clock); clock = new Date(2026, 9, 22, 20, 0).toISOString(); await scanned(clock);
    clock = new Date(2026, 9, 23, 17, 59).toISOString(); await scanned(clock);
    clock = new Date(2026, 9, 23, 18, 0).toISOString(); await scanned(clock);
    clock = new Date(2026, 9, 23, 20, 0).toISOString(); await scanned(clock);
  } finally { controller.abort(); await service; }
  await quiet(f); const files = await readdir(f.config.dataDir);
  assert.equal(files.some(name => name.startsWith('learning') || name.includes('analysis') || name.includes('shadow')), false);
});
test('甲 A7：CC/Codex/Pi 来源不存在、非目录、无权限或链接均不报看不见', async t => {
  const f = await fixture(t), inaccessible = join(f.root, 'unreadable'); await mkdir(inaccessible); await chmod(inaccessible, 0);
  t.after(() => chmod(inaccessible, 0o700).catch(() => {}));
  const notDirectory = join(f.root, 'file'); await writeFile(notDirectory, 'not directory');
  const alias = join(f.root, 'alias'); await symlink(inaccessible, alias);
  for (const path of [join(f.root, 'missing'), notDirectory, inaccessible, alias]) {
    f.legacy.sources = { cc: path, codex: path, pi: path, loop: null }; f.legacy.inboxDir = path;
    const view = await detect(f.legacy, start); assert.equal(view.projection.health.size, 0);
  }
  await quiet(f);
});
test('甲 A8：loop 目录无权限，仍报看不见 loop，恢复后再坏开新告警', async t => {
  const f = await fixture(t); f.config.judge = null; f.config.sources.loop = join(f.root, 'loop'); await mkdir(f.config.sources.loop);
  await chmod(f.config.sources.loop, 0); t.after(() => chmod(f.config.sources.loop!, 0o700).catch(() => {}));
  await detect(f.config, start); let out = await readOutbox(f.config.dataDir); assert.equal(out.length, 1);
  assert.equal(out[0]!.tool, 'loop'); assert.equal(out[0]!.kind, 'blind'); assert.match(out[0]!.text, /看不见了/);
  await chmod(f.config.sources.loop, 0o700); await detect(f.config, '2026-10-20T10:01:00Z');
  await chmod(f.config.sources.loop, 0); await detect(f.config, '2026-10-20T10:02:00Z');
  out = await readOutbox(f.config.dataDir); assert.equal(out.length, 2);
});
test('甲 A9：CC 回合结束 hook 收到即忽略，不读 transcript_path、不记推送或调模型', async t => {
  const f = await fixture(t), path = join(f.config.inboxDir!, 'cc.jsonl');
  await put(path, [pushed(join(f.root, 'not-a-transcript'), 'turn_end')]); const before = await readFile(path);
  await detect(f.legacy, start); await detect(f.legacy, '2026-10-20T10:31:00Z'); await quiet(f);
  assert.equal((await readEvents(f.config.dataDir)).filter(row => row.kind.startsWith('push_')).length, 0); assert.deepEqual(await readFile(path), before);
});
test('旧配置项直接忽略：坏类型/无效时长也不阻止启动，不输出原开关', async t => {
  const f = await fixture(t), config = await validateConfig({ ...f.config, learning: {}, waiting: 'old', intelligence: { timeoutMs: -10, enabled: 'old' },
    sources: { cc: null, codex: 123, pi: false, loop: null } });
  for (const key of ['learning', 'waiting', 'intelligence']) assert.equal(key in config, false);
  const judge: Judge = { async judge() { throw new Error('不得分析聊天'); } }; await detect(config, start, { judge }); await quiet(f);
});
test('旧数据逐字保留：未送达聊天/报告不补发，旧请求不恢复后台分析，旧健康不报警', async t => {
  const f = await fixture(t), { cc } = await import('../src/sources/cc/index.ts');
  const record = cc.parse([ccUser(), ccCall()].map(row => JSON.stringify(row)).join('\n'), { path: '/constructed/old.jsonl', fingerprint: 'old' })!;
  const { agentNotice } = await import('../src/core/learning.ts');
  const old = agentNotice('daily', 'old-daily', start, '旧日报', '旧正文', 'old');
  const rows = [event({ kind: 'session_observed', record }, '2026-10-01T10:00:00Z'), event({ kind: 'notice_planned', notice: old }, start),
    event({ kind: 'source_health', report: { source: 'cc', paths: ['/constructed/cc'], errors: ['旧故障'] } }, start)];
  const raw = rows.map(row => `  ${JSON.stringify(row)}\r\n`).join(''); await put(join(f.config.dataDir, 'events.jsonl'), raw);
  const untouched = ['learning.jsonl', 'learning-baseline.jsonl', 'old-data.bin', '.state-retained.tmp'];
  for (const file of untouched) await put(join(f.config.dataDir, file), '旧数据原样\r\n');
  await detect(f.legacy, '2026-11-02T12:00:00Z'); await rebuild(f.legacy); const view = await overview(f.legacy);
  assert.deepEqual(view.records, []); assert.equal(view.projection.health.size, 0); await quiet(f);
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(raw));
  for (const file of untouched) assert.equal(await readFile(join(f.config.dataDir, file), 'utf8'), '旧数据原样\r\n');
  assert.equal((await readdir(f.config.dataDir)).includes('archives'), false);
});
