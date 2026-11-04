import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { hash } from '../src/core/utils.ts';
import { OperationFailure } from '../src/core/failures.ts';
import type { Notice } from '../src/core/types.ts';
import { ledgerPath, measureLedgerReads, readLedger, updateLedger } from '../src/core/ledger.ts';
import { processManagedLoop } from '../src/core/managed-loop.ts';
import { intakeConfiguredSources } from '../src/core/source-intake.ts';
import { validateConfig } from '../src/core/config.ts';
import { readRuntimeState, runtimeStatePath } from '../src/core/runtime-state.ts';
import { checkHeartbeat, recordHeartbeat } from '../src/service/heartbeat.ts';
import { acquireLock } from '../src/core/locks.ts';
import { readJsonl } from '../src/core/store.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { at, largeLedger } from './ledger-relief-fixture.ts';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pa-ledger-relief-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'), inboxDir = join(root, 'inbox'); await mkdir(inboxDir);
  const config = await validateConfig({ dataDir, sources: {}, inboxDir: null, workspace: { inboxDir, pollEveryMs: 1, settleMs: 0 },
    feishu: { mode: 'fake', receiverId: 'ou_test', timeoutMs: 2000 }, heartbeat: { everyMs: 100, timeoutMs: 1000 } });
  return { root, dataDir, inboxDir, config };
}
async function counted<T>(operation: () => Promise<T>) { const counts = { fullReads: 0 }; const result = await measureLedgerReads(operation, counts); return { result, reads: counts.fullReads }; }
async function waitFor<T>(get: () => Promise<T>, ready: (value: T) => boolean) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { const value = await get(); if (ready(value)) return value; await delay(20); }
  throw new Error('等待构造主流程超时');
}

test('账本减负：万行首次全读一次、后续只接新增；快照和失败事务不污染缓存', async t => {
  const f = await fixture(t), generated = await largeLedger(f.dataDir);
  const first = await counted(() => readLedger(f.dataDir)); assert.equal(first.reads, 1); assert.equal(first.result.seq, generated.seq);
  for (let i = 0; i < 3; i++) assert.equal((await counted(() => readLedger(f.dataDir))).reads, 0);
  assert.throws(() => { first.result.tables.cards['health:history:0']!.title = '污染'; }, TypeError);
  assert.throws(() => first.result.transactionIds.add('污染'), TypeError);
  await assert.rejects(updateLedger(f.dataDir, at, (_state, add) => { add({ kind: 'put', table: 'receipts', value: { id: 'rolled-back', at, response: '不得入账' } }); throw new Error('rollback'); }), /rollback/);
  assert.equal((await readLedger(f.dataDir)).tables.receipts['rolled-back'], undefined);
  await updateLedger(f.dataDir, at, (_state, add) => add({ kind: 'put', table: 'receipts', value: { id: 'new', at, response: '新增' } }));
  const next = await counted(() => readLedger(f.dataDir)); assert.equal(next.reads, 0); assert.equal(next.result.seq, generated.seq + 1); assert.equal(first.result.seq, generated.seq);
  assert.equal(first.result.tables.receipts.new, undefined);
  await updateLedger(f.dataDir, at, (state, add) => {
    const card = state.tables.cards['health:history:0']!;
    add({ kind: 'put', table: 'cards', value: { ...card, revision: 2, input: undefined, deliveryText: undefined } });
    add({ kind: 'observation', observation: { kind: 'guard', actor: undefined, detail: '构造JSON省略字段' } });
  });
  const cached = await readLedger(f.dataDir), freshDir = join(f.root, 'fresh'); await mkdir(freshDir);
  await writeFile(ledgerPath(freshDir), await readFile(ledgerPath(f.dataDir)));
  assert.deepEqual(cached, await readLedger(freshDir), '本进程缓存与逐字重放的对象/表原型/省略字段也必须相同');
});
test('账本减负：已送达50张卡的空轮不追加；轮询/巡检不写回执，心跳只覆盖小文件', async t => {
  const f = await fixture(t), generated = await largeLedger(f.dataDir); await readLedger(f.dataDir);
  const channels = [feishuChannel(f.config, undefined, { managed: true }), { name: 'local', async send() { assert.fail('历史卡不能再发'); }, async receive() { return ''; } }];
  for (let i = 0; i < 3; i++) {
    const time = new Date(Date.parse(at) + i * 2000).toISOString();
    const scan = await counted(() => processManagedLoop(f.config, time, { channels, inspect: true })); assert.equal(scan.reads, 0);
    await recordHeartbeat(f.config, time, 'constructed-run');
    assert.equal((await readRuntimeState(f.dataDir))?.completedAt, time);
  }
  assert.ok(await readFile(ledgerPath(f.dataDir), 'utf8') === generated.content, '空轮不能追加账本');
  assert.ok((await readRuntimeState(f.dataDir))?.inspectedAt);
});
test('账本减负：同一日程空轮不追加；重建配置立即检查，不沿用旧轮询时间', async t => {
  const f = await fixture(t); f.config.schedule = { mode: 'fake', calendarIds: ['constructed'], minuteTokens: [], pollEveryMs: 1000, timeoutMs: 1000 };
  let polls = 0;
  const reader = { async calendar() { polls++; return []; }, async minute() { throw new Error('不应查询'); } };
  await intakeConfiguredSources(f.config, at, reader); const seq = (await readLedger(f.dataDir)).seq;
  await intakeConfiguredSources(f.config, '2026-11-03T10:00:02Z', reader); assert.equal((await readLedger(f.dataDir)).seq, seq);
  await intakeConfiguredSources({ ...f.config }, '2026-11-03T10:00:02Z', reader); assert.equal(polls, 3); assert.equal((await readLedger(f.dataDir)).seq, seq);
});
test('账本减负：完整末行截短也拒绝，坏新增/改写/断链不沿用缓存，原文件保留', async t => {
  for (const damage of ['truncate', 'bad-line', 'bad-checksum', 'rewrite', 'broken-chain', 'middle-and-append']) {
    const f = await fixture(t), generated = await largeLedger(f.dataDir, 3, 0); await readLedger(f.dataDir);
    const path = ledgerPath(f.dataDir), rows = generated.content.trimEnd().split('\n');
    if (damage === 'truncate') await truncate(path, Buffer.byteLength(rows.slice(0, -1).join('\n') + '\n'));
    if (damage === 'bad-line') await appendFile(path, '{broken}\n');
    if (damage === 'bad-checksum') await appendFile(path, JSON.stringify({ ...JSON.parse(rows[2]!), seq: 4, previous: generated.checksum, id: 'new' }) + '\n');
    if (damage === 'rewrite') await writeFile(path, generated.content.replace('构造的旧版例行回执', '改变的旧版例行回执'));
    if (damage === 'broken-chain') await appendFile(path, rows[0]! + '\n');
    if (damage === 'middle-and-append') {
      await writeFile(path, generated.content.replace('构造的旧版例行回执', '改变的旧版例行回执'));
      const body = { schema: 1, id: 'valid-new-row', seq: 4, at, previous: generated.checksum, changes: [] };
      await appendFile(path, JSON.stringify({ ...body, checksum: hash(JSON.stringify(body)) }) + '\n');
    }
    const bytes = await readFile(path), counts = { fullReads: 0 };
    await assert.rejects(measureLedgerReads(() => readLedger(f.dataDir), counts), /损坏|截短|校验|顺序/); assert.equal(counts.fullReads, 1);
    await assert.rejects(updateLedger(f.dataDir, at, (_state, add) => add({ kind: 'put', table: 'receipts', value: { id: 'must-not-append', at, response: '' } })));
    assert.deepEqual(await readFile(path), bytes);
  }
});
test('账本减负：替换为有效账本整本重读；链接仍拒读', async t => {
  const f = await fixture(t); await largeLedger(f.dataDir, 3, 1); await readLedger(f.dataDir);
  const replacement = join(f.root, 'replacement'); const newFile = await largeLedger(replacement, 5, 2);
  await rename(ledgerPath(replacement), ledgerPath(f.dataDir));
  const next = await counted(() => readLedger(f.dataDir)); assert.equal(next.reads, 1); assert.equal(next.result.seq, newFile.seq); assert.equal(Object.keys(next.result.tables.cards).length, 2);
  await rm(ledgerPath(f.dataDir)); await symlink(join(f.root, 'elsewhere'), ledgerPath(f.dataDir)); await assert.rejects(readLedger(f.dataDir), /链接|非普通/);
});
test('账本减负：另一个进程追加后只接新增，序号/各表与独立整本读取一致；旧版读者可回退', async t => {
  const f = await fixture(t), generated = await largeLedger(f.dataDir); await readLedger(f.dataDir);
  const module = new URL('../src/core/ledger.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {updateLedger} from ${JSON.stringify(module)};await updateLedger(process.argv[1],${JSON.stringify(at)},(_s,add)=>add({kind:'put',table:'receipts',value:{id:'external',at:${JSON.stringify(at)},response:'另一个进程'}}));`, f.dataDir], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const incremental = await counted(() => readLedger(f.dataDir)); assert.equal(incremental.reads, 0); assert.equal(incremental.result.seq, generated.seq + 1);
  const full = spawnSync(process.execPath, ['--input-type=module', '-e', `import {readLedger} from ${JSON.stringify(module)};const s=await readLedger(process.argv[1]);console.log(JSON.stringify({seq:s.seq,tables:s.tables,events:s.events,observations:s.observations}));`, f.dataDir], { encoding: 'utf8', timeout: 10000 });
  assert.equal(full.status, 0, full.stderr); assert.deepEqual(JSON.parse(full.stdout), JSON.parse(JSON.stringify({ seq: incremental.result.seq, tables: incremental.result.tables, events: incremental.result.events, observations: incremental.result.observations })));
  // 新版先实际跑几轮，再取合入前的旧 reader，不手写一个“兼容读者”冒充旧程序。
  for (let i = 0; i < 3; i++) await processManagedLoop(f.config, at, { channels: [], intake: false, inspect: true, dispatch: false });
  const old = spawnSync('git', ['show', 'HEAD:code/src/core/ledger.ts'], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' }); assert.equal(old.status, 0, old.stderr);
  const oldPath = join(f.root, 'old-ledger.mts');
  const source = old.stdout.replace(/from '(\.\/[^']+)'/g, (_match, ref: string) => `from '${new URL(ref, module).href}'`);
  await writeFile(oldPath, source);
  const legacy = spawnSync(process.execPath, ['--input-type=module', '-e', `import {readLedger} from ${JSON.stringify(new URL(`file://${oldPath}`).href)};const s=await readLedger(process.argv[1]);console.log(JSON.stringify({seq:s.seq,tables:s.tables}));`, f.dataDir], { encoding: 'utf8', timeout: 10000 });
  assert.equal(legacy.status, 0, legacy.stderr); assert.deepEqual(JSON.parse(legacy.stdout), JSON.parse(JSON.stringify({ seq: incremental.result.seq, tables: incremental.result.tables })));
  assert.equal((await readFile(ledgerPath(f.dataDir))).subarray(0, Buffer.byteLength(generated.content)).toString(), generated.content);
});
test('账本减负：持续跨进程写入时缓存逐次等于同序号完整重放，独立CLI心跳不受影响', async t => {
  const f = await fixture(t), generated = await largeLedger(f.dataDir); await readLedger(f.dataDir);
  f.config.heartbeat!.timeoutMs = 5000;
  await recordHeartbeat(f.config, new Date().toISOString(), 'concurrent-run');
  const module = new URL('../src/core/ledger.ts', import.meta.url).href;
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `import {updateLedger} from ${JSON.stringify(module)};import {setTimeout as wait} from 'node:timers/promises';for(let i=0;i<30;i++){await updateLedger(process.argv[1],${JSON.stringify(at)},(_s,add)=>{add({kind:'put',table:'receipts',value:{id:'concurrent',at:${JSON.stringify(at)},response:String(i)}});add({kind:'observation',observation:{kind:'guard',detail:'并发构造回执 '+i,actor:undefined}});});await wait(40);}`, f.dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(writer, 'exit'); let stderr = ''; writer.stdout.resume(); writer.stderr.on('data', value => stderr += value);
  try {
    const sequences: number[] = [];
    for (let i = 0; i < 4; i++) {
      const state = await readLedger(f.dataDir); sequences.push(state.seq);
      const raw = (await readFile(ledgerPath(f.dataDir), 'utf8')).split('\n').slice(0, state.seq).join('\n') + '\n';
      const fresh = join(f.root, `compare-${i}`); await mkdir(fresh); await writeFile(ledgerPath(fresh), raw);
      assert.deepEqual(state, await readLedger(fresh), '同一已提交序号的完整重放须逐字段一致');
      await delay(40);
    }
    assert.ok(sequences.some(seq => seq > generated.seq));
    await recordHeartbeat(f.config, new Date().toISOString(), 'concurrent-run');
    const cli = resolve(import.meta.dirname, '../src/cli/main.ts'), configPath = join(f.root, 'config.json');
    await writeFile(configPath, JSON.stringify(f.config));
    const checked = spawnSync(process.execPath, [cli, 'heartbeat-check', '--config', configPath, '--json'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(checked.status, 0, checked.stderr); assert.equal(JSON.parse(checked.stdout).status, 'healthy');
    await exit; assert.equal(writer.exitCode, 0, stderr); assert.equal((await readLedger(f.dataDir)).seq, generated.seq + 30);
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) { writer.kill('SIGTERM'); await exit; }
  }
});
test('账本减负：来源五次坏→好复发仍一张假飞书卡，恢复一次，标题/事实不泄露内部词', async t => {
  const f = await fixture(t), channel = feishuChannel(f.config, undefined, { managed: true });
  const scan = () => processManagedLoop(f.config, at, { channels: [channel], intake: false });
  for (let i = 0; i < 5; i++) {
    await updateLedger(f.dataDir, at, (_state, add) => add({ kind: 'put', table: 'health', value: { id: 'processing', kind: 'service', at, ok: false, episode: `failure-${i}`, reason: 'PA 事件处理失败：lock_timeout' } }));
    await scan(); await scan();
    await updateLedger(f.dataDir, at, (_state, add) => add({ kind: 'put', table: 'health', value: { id: 'processing', kind: 'service', at, ok: true, episode: '', reason: '' } }));
    await scan(); await scan();
  }
  const state = await readLedger(f.dataDir), cards = Object.values(state.tables.cards); assert.equal(cards.length, 1);
  assert.doesNotMatch(cards[0]!.title + cards[0]!.fact, /lock_timeout/); assert.match(cards[0]!.title, /已恢复/); assert.match(cards[0]!.fact, /不用/);
  const sent = await readJsonl<SentMessage>(join(f.dataDir, 'feishu-sent.jsonl')); assert.equal(sent.filter(row => row.operation !== 'update').length, 1); assert.equal(sent.length, 10);
  assert.equal(new Set(sent.map(row => row.messageId)).size, 1);
  assert.equal(sent.filter(row => JSON.stringify(row.content).includes('已恢复')).length, 5);
});
test('账本减负：独立心跳不等账本锁；主流程停顿只弹一次，恢复健康且不往账本写', async t => {
  const f = await fixture(t); await largeLedger(f.dataDir, 3, 0); const original = await readFile(ledgerPath(f.dataDir));
  assert.equal((await checkHeartbeat(f.config, at, async () => assert.fail())).status, 'not_started');
  await recordHeartbeat(f.config, at, 'run');
  const unlock = await acquireLock(f.dataDir, '.ledger.lock'); let calls = 0;
  try {
    assert.equal((await checkHeartbeat(f.config, at, async () => { calls++; })).status, 'healthy');
    for (let i = 0; i < 3; i++) await checkHeartbeat(f.config, '2026-11-03T10:00:02Z', async () => { calls++; });
    assert.equal(calls, 1);
    await recordHeartbeat(f.config, '2026-11-03T10:00:02Z', 'run');
    assert.equal((await checkHeartbeat(f.config, '2026-11-03T10:00:02Z', async () => { calls++; })).status, 'healthy');
    assert.equal(calls, 1);
  } finally { await unlock(); }
  assert.deepEqual(await readFile(ledgerPath(f.dataDir)), original);
  await writeFile(runtimeStatePath(f.dataDir), '{broken}\n');
  assert.equal((await checkHeartbeat(f.config, at, async () => { calls++; })).status, 'unavailable_notified');
});
test('账本减负：旧版多episode沿用已送达卡，不补发旧未送卡，不迁移历史行', async t => {
  const f = await fixture(t), channel = feishuChannel(f.config, undefined, { managed: true });
  await updateLedger(f.dataDir, at, (_state, add) => {
    add({ kind: 'put', table: 'health', value: { id: 'processing', at, ok: false, kind: 'service', episode: 'new-episode', reason: 'lock_timeout' } });
    for (const [id, time] of [['health:processing:old-sent', '2026-11-03T09:00:00Z'], ['health:processing:old-pending', '2026-11-03T09:30:00Z']])
      add({ kind: 'put', table: 'cards', value: { id: id!, ticketId: '', assignmentId: '', eventId: id!, at: time!, revision: 1, title: '旧故障卡', fact: '旧的故障事实', question: '', suggestion: '检查', basis: '构造旧数据', options: [], redline: false, actionMode: 'none' } });
    add({ kind: 'put', table: 'deliveries', value: { id: 'feishu:health:processing:old-sent:1', cardId: 'health:processing:old-sent', eventId: 'health:processing:old-sent', channel: 'feishu', revision: 1, state: 'sent', failures: 0, messageId: 'om_existing' } });
  });
  const prefix = await readFile(ledgerPath(f.dataDir));
  await processManagedLoop(f.config, at, { channels: [channel], intake: false });
  const sent = await readJsonl<SentMessage>(join(f.dataDir, 'feishu-sent.jsonl'));
  assert.equal(sent.length, 1); assert.equal(sent[0]!.operation, 'update'); assert.equal(sent[0]!.messageId, 'om_existing');
  assert.equal(sent[0]!.noticeId, 'health:processing:old-sent');
  assert.equal(Object.keys((await readLedger(f.dataDir)).tables.cards).length, 2);
  assert.ok((await readFile(ledgerPath(f.dataDir))).subarray(0, prefix.length).equals(prefix));
});
for (const category of ['channel_timeout', 'channel_rejected'] as const) for (const localOutcome of ['sent', 'uncertain'] as const)
  test(`账本减负返修1-1：同轮多卡${category}更新故障卡仍有首次本机尝试，${localOutcome}后不重弹`, async t => {
    const f = await fixture(t); await largeLedger(f.dataDir, 0, 2);
    await updateLedger(f.dataDir, at, (state, add) => {
      for (const card of Object.values(state.tables.cards)) add({ kind: 'put', table: 'cards', value: { ...card, revision: 2 } });
    });
    const faultId = 'health:card-channel:feishu', notices: Notice[] = [];
    let clock = Date.parse(at), attempts = 0;
    const failing = { name: 'feishu', async send() { assert.fail('应走托管发卡接口'); }, async receive() { return ''; }, async deliverManaged() {
      attempts++; clock += 1000; throw new OperationFailure(category, '构造渠道失败');
    } };
    const local = { name: 'local', async receive() { return ''; }, async send(notice: Notice) {
      if (!notice.id.startsWith(`${faultId}:`)) return;
      notices.push(notice);
      if (localOutcome === 'uncertain') throw new OperationFailure('channel_timeout', '构造本机通知结果未确认');
    } };
    const scan = () => processManagedLoop(f.config, new Date(clock).toISOString(), { channels: [failing, local], intake: false, now: () => new Date(clock).toISOString() });
    const limit = category === 'channel_timeout' ? 1 : 5;
    for (let i = 0; i < limit; i++) await scan();
    const pending = (await readLedger(f.dataDir)).tables.cards[faultId]!;
    assert.ok(pending.revision >= 2, '两张卡的不同回执时间确实已更新尚未首发的故障卡');
    assert.equal(notices.length, 0, '新故障卡不在最初的候选快照中，应在下轮首次通知');
    for (let i = 0; i < 3; i++) await scan();
    assert.equal(notices.length, 1, '同类故障必须有且只有一次本机首次尝试');
    assert.equal(attempts, 2 * limit, '超时不重发；明确失败的每张原卡最多五次');
    const delivery = Object.values((await readLedger(f.dataDir)).tables.deliveries).find(row => row.cardId === faultId && row.channel === 'local')!;
    assert.equal(delivery.state, localOutcome);
    clock += 1000;
    await updateLedger(f.dataDir, new Date(clock).toISOString(), (state, add) => add({ kind: 'put', table: 'health', value: {
      ...state.tables.health['card-channel:feishu']!, at: new Date(clock).toISOString(), reason: '同类渠道故障又有一条实际失败回执',
    } }));
    for (let i = 0; i < 3; i++) await scan();
    assert.equal(notices.length, 1, '后续更新不重复弹，首次通知结果不确定也不能重发');
    assert.equal(attempts, 2 * limit);
  });
test('账本减负：实际收件箱五次失明/恢复，同一张飞书卡更新，健康空轮无额外恢复', async t => {
  const f = await fixture(t), channel = feishuChannel(f.config, undefined, { managed: true }), moved = join(f.root, 'offline');
  for (let i = 0; i < 5; i++) {
    await rename(f.inboxDir, moved);
    await processManagedLoop(f.config, new Date(Date.parse(at) + i * 4000).toISOString(), { channels: [channel] });
    await rename(moved, f.inboxDir);
    const time = new Date(Date.parse(at) + i * 4000 + 2000).toISOString();
    await processManagedLoop(f.config, time, { channels: [channel] });
    await processManagedLoop(f.config, time, { channels: [channel] });
  }
  const state = await readLedger(f.dataDir); assert.equal(state.tables.health['source:workspace']!.ok, true);
  assert.equal(Object.keys(state.tables.cards).length, 1);
  const sent = await readJsonl<SentMessage>(join(f.dataDir, 'feishu-sent.jsonl')); assert.equal(sent.length, 10);
  assert.equal(sent.filter(row => !row.operation).length, 1); assert.equal(new Set(sent.map(row => row.messageId)).size, 1);
});
test('账本减负：首轮尚未完成就卡住也会报停；放开后恢复健康，服务故障原卡恢复一次', async t => {
  const f = await fixture(t); await largeLedger(f.dataDir, 3, 0);
  await updateLedger(f.dataDir, at, (_state, add) => add({ kind: 'put', table: 'health', value: { id: 'service', kind: 'service', at, ok: false, episode: 'old-exit', reason: 'PA 自身故障：lock_timeout；服务已退出' } }));
  f.config.workspace!.pollEveryMs = 1000; f.config.managedLoop!.intakeEveryMs = 25;
  const path = join(f.root, 'config.json'); await writeFile(path, JSON.stringify(f.config));
  const cli = resolve(import.meta.dirname, '../src/cli/main.ts');
  const unlock = await acquireLock(f.dataDir, '.ledger.lock'); let released = false;
  const child = spawn(process.execPath, [cli, 'daemon', '--config', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); let stderr = ''; child.stderr.on('data', value => stderr += value);
  try {
    const started = (await waitFor(() => readRuntimeState(f.dataDir), state => !!state?.startedAt))!;
    assert.equal(started.completedAt, undefined); let calls = 0;
    const later = new Date(Date.parse(started.startedAt!) + 2000).toISOString();
    assert.equal((await checkHeartbeat(f.config, later, async () => { calls++; })).status, 'notified');
    await checkHeartbeat(f.config, later, async () => { calls++; }); assert.equal(calls, 1);
    await unlock(); released = true;
    const resumed = (await waitFor(() => readRuntimeState(f.dataDir), state => !!state?.completedAt))!;
    assert.equal((await checkHeartbeat(f.config, resumed.completedAt!, async () => { calls++; })).status, 'healthy');
    await waitFor(() => readLedger(f.dataDir), state => !!state.tables.cards['health:service']?.title.includes('已恢复'));
    const sent = await waitFor(() => readJsonl<SentMessage>(join(f.dataDir, 'feishu-sent.jsonl')), rows => rows.filter(row => row.noticeId === 'health:service').length >= 2);
    assert.equal(sent.filter(row => row.noticeId === 'health:service').length, 2);
    assert.equal(new Set(sent.filter(row => row.noticeId === 'health:service').map(row => row.messageId)).size, 1);
  } finally {
    if (!released) await unlock();
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
    assert.equal(child.exitCode, 0, stderr);
  }
});
