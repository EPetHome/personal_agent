// 叫与不叫：只读构造来源，所有渠道/模型均为替身，数据只在独立临时目录。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { loadConfig, validateConfig } from '../src/core/config.ts';
import { event, packProjection, project } from '../src/core/events.ts';
import { decideWaiting } from '../src/core/interaction.ts';
import { localNoticeText } from '../src/core/notice-text.ts';
import { readEvents, readJsonl, readOutbox } from '../src/core/store.ts';
import { runService } from '../src/service/daemon.ts';
import { isHuman } from '../src/core/utils.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, piHeader, piMessage, put, pushed, sandbox } from './fixtures.ts';
import type { Channel, JudgmentRequest, Notice } from '../src/core/types.ts';

const at = (minute: number) => new Date(Date.parse('2026-10-20T10:00:00Z') + minute * 60000).toISOString();
async function fixture(t: TestContext, lastHuman = -1) {
  const f = await sandbox(null); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.learning = false;
  f.config.judge = { executable: '/test-only/no-real-model', model: 'fake', timeoutMs: 1000 };
  const file = join(f.config.sources.cc!, 'a.jsonl');
  const session = async (id = 'demo-cc', human = lastHuman, output = '缓存保留多久？') => {
    const answer = ccAnswer(at(0)); answer.message.content[0]!.text = output;
    const path = id === 'demo-cc' ? file : join(f.config.sources.cc!, `${id}.jsonl`);
    await put(path, [ccUser(`构造 ${id} 缓存任务`, at(human)), answer].map(row => ({ ...row, sessionId: id })));
    return path;
  };
  await session();
  const local: Notice[] = [], feishu: Notice[] = [], calls: JudgmentRequest[] = [];
  const channel = (name: string, sent: Notice[]): Channel => ({ name, levels: ['现在就要你', '有空看'],
    async send(notice) { sent.push(notice); }, async receive() { return '已记下'; } });
  const components = { channels: [channel('local', local), channel('feishu', feishu)], judge: { async judge(request: JudgmentRequest) {
    calls.push(request); return { answer: request.task === 'waiting' ? '是' as const : '否' as const, reason: '构造判断' };
  } } };
  const run = (minute: number) => detect(f.config, at(minute), components);
  const other = async (minute = 4) => {
    const path = join(f.config.sources.cc!, 'other.jsonl');
    await put(path, [{ ...ccUser('继续', at(minute)), sessionId: 'other' }]); return path;
  };
  return { ...f, file, session, run, other, local, feishu, calls, components };
}

test('叫与不叫 A1：一分钟前真人说话，停下15分钟后同会话接话，期间无提醒/无模型调用', async t => {
  const f = await fixture(t);
  for (const minute of [0, 5, 14.999]) await f.run(minute);
  assert.deepEqual(await readOutbox(f.config.dataDir), []); assert.equal(f.calls.length, 0);
  await appendFile(f.file, JSON.stringify(ccUser('保留十分钟', at(15))) + '\n');
  await f.run(15); await f.run(26);
  assert.deepEqual(await readOutbox(f.config.dataDir), []); assert.equal(f.local.length, 0); assert.equal(f.feishu.length, 0);
  const replied = (await readEvents(f.config.dataDir)).find(e => e.kind === 'notice_suppressed' && e.reason === 'user_replied');
  assert.ok(replied?.kind === 'notice_suppressed'); assert.equal(replied.reply!.at, at(15)); assert.equal(replied.intervalMs, 20 * 60000);
});

test('叫与不叫 A2：没有后续真人消息，严格满20分钟才双通道叫；查询/重建不调用或重发', async t => {
  const f = await fixture(t);
  for (const minute of [0, 5, 15, 19.999]) await f.run(minute);
  assert.equal(f.calls.length, 0); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  await f.run(20);
  assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1);
  const [notice] = await readOutbox(f.config.dataDir);
  assert.equal(notice!.kind, 'waiting'); assert.deepEqual(notice!.delivery!.channels, ['local', 'feishu']);
  assert.equal(notice!.evidenceAt, at(0)); assert.equal(notice!.waitingDecision!.activeConversation, true);
  const calls = f.calls.length;
  await overview(f.config, at(26)); await rebuild(f.config, at(26)); await f.run(30);
  assert.equal(f.calls.length, calls); assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1);
});

test('叫与不叫 A3：别的会话只说过一次，过20分钟仍按忙处理，满25分钟只叫本机一次', async t => {
  const f = await fixture(t); await f.run(0); const path = await f.other(4); await f.run(4);
  await rm(path); // 后续不再有动静，甚至不再列出该会话，也不能降回离场规则。
  const state = packProjection(project(await readEvents(f.config.dataDir)));
  const archive = `events-000000000001-${'b'.repeat(64)}.jsonl.gz`;
  await put(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'store_checkpoint', format: 2, sequence: 1, archive, archives: [archive], state }, at(4))]);
  await rebuild(f.config, at(19));
  await f.run(20); await f.run(24.999);
  assert.deepEqual(await readOutbox(f.config.dataDir), []);
  await f.run(25); await f.run(40);
  assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 0);
  assert.match(f.local[0]!.content.title, /还有会话在等你/);
  assert.match(localNoticeText(f.local[0]!), /demo-cc/);
  const [notice] = await readOutbox(f.config.dataDir);
  assert.deepEqual(notice!.delivery!.channels, ['local']); assert.equal(notice!.waitingDecision!.otherHumanAt, at(4));
});

test('叫与不叫 A4：甲丙同时到点，只发送一条本机通知列出两会话，逐事实确认且重建不重弹', async t => {
  const f = await fixture(t); await f.session('session-c');
  await f.run(0); await f.other(4); await f.run(4); await f.run(24.999); await f.run(25);
  assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 0);
  const text = localNoticeText(f.local[0]!);
  assert.match(text, /还有会话在等你/); assert.match(text, /demo-cc/); assert.match(text, /session-c/);
  const outbox = await readOutbox(f.config.dataDir);
  assert.equal(new Set(outbox.map(n => n.localBatch!.id)).size, 1);
  assert.deepEqual(outbox[0]!.localBatch!.entries.map(e => e.sessionId).sort(), ['demo-cc', 'session-c']);
  const deliveries = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'channel_delivery' && e.phase === 'attempted' && e.ok);
  assert.equal(deliveries.length, 2); assert.ok(deliveries.every(e => e.kind === 'channel_delivery' && e.channel === 'local'));
  await rebuild(f.config, at(26)); await f.run(26);
  assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 0);
});

for (const cached of [false, true]) test(`合并通知：离场双通道，${cached ? '一份已有判断、一份本轮才判断' : '两份本轮才判断'}仍只弹一次本机，卡片各自保留`, async t => {
  const f = await fixture(t); await f.session('session-c'); await f.run(0);
  if (cached) await appendFile(join(f.config.dataDir, 'events.jsonl'), JSON.stringify(event({ kind: 'model_checked', check: {
    key: 'waiting:cc:demo-cc:demo-cc', recordKey: 'cc:demo-cc', sessionId: 'demo-cc', task: 'waiting', at: at(0), evidenceAt: at(0),
    fingerprint: 'constructed-cached', stepIds: [], summary: '', result: { answer: '是', reason: '构造已缓存等待' },
  } }, at(0))) + '\n');
  await f.run(20);
  assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 2);
  assert.match(localNoticeText(f.local[0]!), /demo-cc/); assert.match(localNoticeText(f.local[0]!), /session-c/);
  assert.ok(f.feishu.every(n => !n.content.title.includes('还有会话') && !!n.sessionKey), '飞书沿用单会话卡片/按钮身份');
});

test('合并通知失败：下轮仍只重试一次本机批次，逐事实记录失败；成功后重启不再弹', async t => {
  const f = await fixture(t); await f.session('session-c'); await f.other(4);
  let attempts = 0;
  f.components.channels[0]!.send = async notice => { attempts++; if (attempts === 1) throw new Error('构造通知失败'); f.local.push(notice); };
  await f.run(0); await f.run(25);
  assert.equal(attempts, 1); assert.equal(f.local.length, 0);
  await rebuild(f.config, at(26)); await f.run(26);
  assert.equal(attempts, 2); assert.equal(f.local.length, 1);
  const view = await overview(f.config, at(26));
  assert.equal([...view.projection.channelDeliveries.values()].filter(Boolean).length, 2);
  await f.run(27); assert.equal(attempts, 2); assert.equal(f.feishu.length, 0);
});

for (const busy of [false, true]) for (const format of ['plain', 'question', 'caution', 'table', 'code', 'tilde-code'] as const)
  test(`${['table', 'code', 'tilde-code'].includes(format) ? '返修2-1' : '返修1-1'}：只有最终文本跑偏/${format}，${busy ? '人在别处' : '无人后续发言'}仍按原5分钟检查/双发`, async t => {
  const f = await fixture(t), answer = ccAnswer(at(0));
  const analysis = 'B 的分析：成本下降，响应更稳定。', closing = '要继续分析吗？';
  const outputs = {
    plain: analysis, question: `${analysis}\n${closing}`, caution: `请注意：${analysis}`,
    table: `| B 的分析 | 结论 |\n| --- | --- |\n| 成本 | 下降 |\n\n${closing}`,
    code: `\x60\x60\x60text\n${analysis}\n\x60\x60\x60\n${closing}`,
    'tilde-code': `~~~text\n${analysis}\n~~~\n${closing}`,
  };
  answer.message.content[0]!.text = outputs[format];
  await put(f.file, [ccUser('只分析 A', at(-1)), answer]);
  f.components.judge.judge = async request => {
    f.calls.push(request);
    return request.task === 'drift' ? { answer: '是', reason: '输出分析了B而非A', intentQuote: '只分析 A', stepQuote: 'B 的分析' }
      : { answer: '否', reason: '无等待事项' };
  };
  await f.run(0);
  if (busy) { await f.other(1); await f.run(1); }
  await f.run(4.999); assert.equal(f.calls.length, 0); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  await f.run(5);
  assert.deepEqual(f.calls.map(request => request.task), ['drift']);
  assert.deepEqual(f.local.map(n => n.kind), ['drift']); assert.deepEqual(f.feishu.map(n => n.kind), ['drift']);
  const [notice] = await readOutbox(f.config.dataDir);
  assert.equal(notice!.evidenceAt, at(0)); assert.deepEqual(notice!.delivery!.channels, ['local', 'feishu']);
  await appendFile(f.file, JSON.stringify(ccUser('收到，我来处理', at(6))) + '\n');
  await f.run(6); await f.run(26);
  assert.equal(f.calls.length, 1); assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1);
});

for (const marker of ['**', '`']) test(`返修2-1：${marker}包装的真正独立问句，仍等25分钟且不绕到跑偏调用`, async t => {
  const f = await fixture(t); await f.session('demo-cc', -1, `${marker}缓存保留多久？${marker}`);
  await f.run(0); await f.other(1); await f.run(1); await f.run(5); await f.run(24.999);
  assert.equal(f.calls.length, 0); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  await f.run(25);
  assert.equal(f.calls.filter(request => request.task === 'waiting').length, 1);
  assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 0);
  assert.equal(f.local[0]!.kind, 'waiting');
});

test('返修1-2：回复与turn_end时间不同，乙会话消失且检查点恢复后，甲仍满25分钟只本机，事实去重身份不变', async t => {
  const f = await fixture(t), stoppedAt = at(0.25);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [{ ...pushed(f.file, 'turn_end', stoppedAt), detail: '缓存保留多久？' }]);
  await f.run(1); const path = await f.other(4); await f.run(4); await rm(path);
  const state = packProjection(project(await readEvents(f.config.dataDir)));
  const archive = `events-000000000001-${'c'.repeat(64)}.jsonl.gz`;
  await put(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'store_checkpoint', format: 2, sequence: 1, archive, archives: [archive], state }, at(4))]);
  await rebuild(f.config, at(5)); await f.run(20.25); await f.run(25.249);
  assert.deepEqual(await readOutbox(f.config.dataDir), []); assert.equal(f.local.length, 0); assert.equal(f.feishu.length, 0);
  await f.run(25.25);
  const [notice] = await readOutbox(f.config.dataDir);
  assert.equal(notice!.evidenceAt, stoppedAt); assert.equal(notice!.waitingDecision!.otherHumanAt, at(4));
  assert.deepEqual(notice!.delivery!.channels, ['local']); assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 0);
  assert.match(f.local[0]!.content.title, /还有会话在等你/);
  const before = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), calls = f.calls.length;
  f.config.judge!.model = 'changed-fake-model';
  await rebuild(f.config, at(30)); await f.run(30);
  assert.equal(f.calls.length, calls); assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 0);
  assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), before);
});

test('叫与不叫 A5：一小时前派活的会话保留5分钟，无其他真人消息时双发', async t => {
  const f = await fixture(t, -60);
  await f.run(0); await f.run(4.999); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  await f.run(5); assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1);
  assert.equal(f.local[0]!.waitingDecision!.activeConversation, false);
});

test('其余会话：5分钟不变，停下后在其他会话说过话只走本机，即使后来不动', async t => {
  const f = await fixture(t, -60); await f.run(0); await f.other(1); await f.run(5);
  assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 0);
  await f.run(20); assert.equal(f.feishu.length, 0);
});

for (const prefix of ['自动评审', '门禁', '自动验收']) test(`叫与不叫 A6：${prefix}返修消息不重置等候、不冒充正在聊或跨会话忙`, async t => {
  const f = await fixture(t, -60); f.config.sources.cc = null; f.config.sources.pi = join(f.root, 'pi');
  const path = join(f.config.sources.pi, 'sample.jsonl'), auto = `【${prefix} · 第 1 次返修】\n构造返修内容`;
  assert.equal(isHuman(auto), false); assert.equal(isHuman(auto, { origin: { kind: 'human' } }), false);
  assert.equal(isHuman(`我看到${auto}`), true, '只排除开头，正文提及不误伤真人');
  await put(path, [piHeader(), piMessage('u', null, 'user', '构造任务', at(-60)),
    piMessage('a', 'u', 'assistant', '缓存保留多久？', at(0))]);
  await f.run(0);
  await appendFile(path, JSON.stringify(piMessage('auto', 'a', 'user', auto, at(3))) + '\n');
  await put(join(f.config.sources.pi, 'other.jsonl'), [{ ...piHeader(), id: 'other-pi' }, piMessage('auto2', null, 'user', auto, at(4))]);
  const view = await f.run(5);
  const record = view.records.find(r => r.sessionId === 'demo-pi')!;
  assert.deepEqual(record.humanRequestRefs!.map(ref => ref.at), [at(-60)]);
  assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1);
  assert.equal(f.local[0]!.evidenceAt, at(0)); assert.equal(f.local[0]!.waitingDecision!.activeConversation, false);
});

test('叫与不叫 A7：从配置文件重新加载后，离场改10分钟生效，其余起步值保留', async t => {
  const f = await fixture(t), configPath = join(f.root, 'config.json');
  await put(configPath, JSON.stringify(f.config)); await detect(await loadConfig(configPath), at(9), f.components);
  assert.equal(f.local.length, 0);
  await put(configPath, JSON.stringify({ ...f.config, waiting: { awayMinutes: 10 } }));
  const reloaded = await loadConfig(configPath);
  assert.deepEqual(reloaded.waiting, { awayMinutes: 10, otherSessionMinutes: 25, inactiveMinutes: 5, activeConversationMinutes: 10 });
  await detect(reloaded, at(9.999), f.components); assert.equal(f.local.length, 0);
  await detect(reloaded, at(10), f.components); assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1);
});

test('叫与不叫 A7 重启：同一构造数据，20分钟配置下不叫，服务正常退出后改10分钟，再启动即叫', async t => {
  const f = await fixture(t), stopped = Date.now() - 12 * 60000;
  const answer = ccAnswer(new Date(stopped).toISOString()); answer.message.content[0]!.text = '缓存保留多久？';
  await put(f.file, [ccUser('构造重启任务', new Date(stopped - 60000).toISOString()), answer]);
  f.config.judge!.dailyLimit = 0; // 规则兜底，不启动真实模型。
  f.config.service = { intervalMs: 50, restartWindowMs: 60000, restartThreshold: 3 };
  const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
  const scan = async () => {
    const before = (await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'))).filter(r => r.kind === 'scan_completed').length;
    const controller = new AbortController(), service = runService(await loadConfig(configPath), controller.signal, { channels: f.components.channels });
    try {
      const end = Date.now() + 10000;
      while ((await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'))).filter(r => r.kind === 'scan_completed').length <= before) {
        if (Date.now() > end) assert.fail('隔离重启服务未完成检测');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { controller.abort(); await service; }
  };
  await scan(); assert.equal(f.local.length, 0); assert.equal(f.feishu.length, 0);
  await put(configPath, JSON.stringify({ ...f.config, waiting: { awayMinutes: 10 } }));
  await scan(); assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1);
});

test('四个配置项分别生效，10分钟严格小于边界，未来/同会话输入不算去别处', async t => {
  const f = await fixture(t, -10); await f.run(0);
  let view = await overview(f.config, at(0)), record = view.records[0]!;
  assert.equal(decideWaiting(record, record, at(0), view.projection, f.config, at(0)).activeConversation, false);
  f.config.waiting = { activeConversationMinutes: 11, otherSessionMinutes: 7, inactiveMinutes: 3 };
  assert.equal(decideWaiting(record, record, at(0), view.projection, f.config, at(0)).activeConversation, true);
  await f.other(4); await f.run(4); await f.run(6.999); assert.equal(f.local.length, 0);
  await f.run(7); assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 0);
  const fresh = await fixture(t, -60); fresh.config.waiting = { inactiveMinutes: 3 };
  await fresh.run(2.999); assert.equal(fresh.local.length, 0); await fresh.run(3); assert.equal(fresh.local.length, 1);
  view = await overview(fresh.config, at(3)); record = view.records[0]!;
  await fresh.other(50); // 尚未发生的输入不能作为活动。
  const future = await fresh.run(4);
  assert.equal(decideWaiting(record, record, at(0), future.projection, fresh.config, at(4)).otherHumanAt, undefined);
  for (const value of [0, -1, 1.5, '10', Infinity]) await assert.rejects(validateConfig({ ...f.config, waiting: { awayMinutes: value } }), /waiting.awayMinutes/);
});

test('叫与不叫 A8：停下后来源读不了，当轮双发「现在就要你」，不等20/25分钟', async t => {
  const f = await fixture(t); await f.run(0); await f.other(0.5);
  f.config.sources.pi = join(f.root, 'missing-pi'); await f.run(1);
  assert.deepEqual(f.local.map(n => n.kind), ['blind']); assert.equal(f.feishu.length, 1);
  assert.equal(f.local[0]!.level, '现在就要你'); assert.deepEqual(f.local[0]!.delivery!.channels, ['local', 'feishu']);
});

test('红线：授权推送和回复中的红线都当轮双发，不被正在聊/跨会话活动延迟', async t => {
  for (const permission of [false, true]) {
    const f = await fixture(t); await f.session('demo-cc', -1, permission ? '缓存保留多久？' : '请确认是否删除旧文件？');
    if (permission) {
      await put(f.file, [ccUser('构造授权任务', at(-1)), ccCall(at(0))]);
      await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(f.file, 'waiting_permission', at(0))]);
    }
    await f.other(0.5); await f.run(1);
    assert.equal(f.local.length, 1); assert.equal(f.feishu.length, 1);
    assert.equal(f.local[0]!.waitingDecision!.redline, true); assert.equal(f.local[0]!.localBatch, undefined);
  }
});

test('跨工具真人短句算忙；后来回到原会话则取消未发提醒', async t => {
  const f = await fixture(t); f.config.sources.codex = join(f.root, 'codex');
  await put(join(f.config.sources.codex, 'other.jsonl'), [codexMeta('demo-cc')]); await f.run(0);
  await put(join(f.config.sources.codex, 'other.jsonl'), [codexMeta('demo-cc'), codexEvent({ type: 'user_message', message: '好' }, 'event_msg', at(4))]);
  await f.run(20); assert.equal(f.local.length, 0);
  await appendFile(f.file, JSON.stringify(ccUser('十分钟', at(24))) + '\n');
  await f.run(25); assert.equal(f.local.length, 0); assert.equal(f.feishu.length, 0);
});

for (const checkpoint of [false, true]) test(`叫与不叫 A9：旧${checkpoint ? '检查点' : '事件/发件'}启动隔离服务，总览与stats正常，旧卡不改/不重发`, async t => {
  const f = await fixture(t, -60); await f.run(5);
  const old = (await readOutbox(f.config.dataDir))[0]!; delete old.waitingDecision; delete old.localBatch;
  const rows = (await readEvents(f.config.dataDir)).map(row => {
    if (row.kind === 'notice_planned') row.notice = old;
    if (row.kind === 'notice_suppressed') delete row.waitingDecision;
    return row;
  });
  const state = packProjection(project(rows)); delete (state as Partial<typeof state>).waitingActivity;
  const archive = `events-000000000001-${'a'.repeat(64)}.jsonl.gz`;
  await put(join(f.config.dataDir, 'events.jsonl'), checkpoint ? [event({ kind: 'store_checkpoint', format: 2, sequence: 1, archive, archives: [archive], state }, at(5))] : rows);
  await put(join(f.config.dataDir, 'outbox.jsonl'), [old]); const before = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8');
  f.config.judge = null; f.config.service = { intervalMs: 50, restartWindowMs: 60000, restartThreshold: 3 };
  const controller = new AbortController(), service = runService(f.config, controller.signal, { channels: [] });
  try {
    const end = Date.now() + 10000;
    while (!(await readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl'))).some(row => row.kind === 'scan_completed')) {
      if (Date.now() > end) assert.fail('隔离旧数据服务未完成检测');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { controller.abort(); await service; }
  const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
  for (const command of ['overview', 'stats']) {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), command, '--config', configPath, '--json'],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: f.root } });
    assert.equal(result.status, 0, result.stderr); assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
  assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), before);
});
