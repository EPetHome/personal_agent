// 全新PA乙第1次返修：真实managed入口，所有数据/账号/渠道均为构造或替身。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { detect } from '../src/core/agent.ts';
import { validateConfig } from '../src/core/config.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import type { Incoming, SentMessage } from '../src/channels/feishu/index.ts';
import { readFeedback } from '../src/core/feedback.ts';
import { readLedger, updateLedger } from '../src/core/ledger.ts';
import { intakeLoop } from '../src/core/loop-intake.ts';
import { appendJsonl, readJsonl, readOutbox } from '../src/core/store.ts';
import { runService } from '../src/service/daemon.ts';
import { put, putLoop, putManagedLoop, sandbox } from './fixtures.ts';

const at = '2026-11-02T10:00:00.000Z', after = '2026-11-02T10:04:00.000Z';
const cli = resolve(import.meta.dirname, '../src/cli/main.ts');
async function fixture(t: TestContext) {
  const base = await sandbox(), root = await realpath(base.root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await validateConfig({ ...base.config, dataDir: join(root, 'data'), inboxDir: join(root, 'inbox'),
    sources: { cc: null, loop: null }, commands: { cc: '/synthetic/must-not-run' }, feishu: { mode: 'fake', receiverId: 'ou_test', timeoutMs: 5000 } });
  const configPath = join(root, 'config.json');
  const save = () => writeFile(configPath, JSON.stringify(config)); await save();
  return { root, config, configPath, save, ledger: () => readLedger(config.dataDir),
    sent: () => readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl')) };
}
function text(id: string): Incoming {
  return { id, at, actor: 'ou_test', type: 'text', messageId: `om_${id}`, chatType: 'p2p', text: `漏了 ${id}` };
}
async function waitFor<T>(operation: () => Promise<T>, accept: (value: T) => boolean, timeout = 10000): Promise<T> {
  const until = performance.now() + timeout;
  while (performance.now() < until) { const value = await operation(); if (accept(value)) return value; await delay(20); }
  throw new Error('构造回归未在时限内出现预期结果');
}
function poll(configPath: string): number {
  const result = spawnSync(process.execPath, [cli, 'feishu-poll', '--config', configPath, '--now', after, '--json'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout).processed;
}

test('返修1-1：managed CLI升级不重放旧收件/失败/人工核销/待处理历史，升级后新点击仍处理且重启不重发', async t => {
  const f = await fixture(t);
  await putLoop(f.config, f.root, '暂停', '2026-11-02T09:54:00Z'); await detect(f.config, at); await f.save();
  const notice = (await readOutbox(f.config.dataDir))[0]!, message = (await f.sent()).find(row => row.noticeId === notice.id)!;
  const click = (id: string): Incoming => ({ id, at, actor: 'ou_test', type: 'action', messageId: message.messageId,
    value: { action: 'feedback', verdict: '正确', noticeId: notice.id } });
  const oldInputs = [text('old-processed'), click('old-failed'), click('old-id-only'), click('old-sent-only'), click('old-unrecorded')];
  const inbox = join(f.config.dataDir, 'feishu-inbox.jsonl'), receipts = join(f.config.dataDir, 'feishu-receipts.jsonl'), sent = join(f.config.dataDir, 'feishu-sent.jsonl');
  await put(inbox, oldInputs);
  await put(receipts, [{ id: 'old-processed', at, status: 'processed', response: '旧确认', reply: 'sent' },
    { id: 'old-failed', at, status: 'failed', response: '旧失败确认', reply: 'pending' }, { id: 'old-id-only' }]);
  await appendJsonl(sent, [{ key: 'reply:old-sent-only', messageId: 'om_old_reply', at, type: 'text' } satisfies SentMessage]);
  const beforeInbox = await readFile(inbox), beforeReceipts = await readFile(receipts), beforeSent = await readFile(sent);
  assert.equal(poll(f.configPath), 0, '第一次managed收件不得把旧文件当新输入');
  assert.deepEqual(await readFeedback(f.config.dataDir), []);
  assert.equal((await f.ledger()).observations.filter(row => row.kind === 'feedback').length, 0);
  assert.deepEqual(await readFile(inbox), beforeInbox); assert.deepEqual(await readFile(receipts), beforeReceipts); assert.deepEqual(await readFile(sent), beforeSent);
  // 平台重投旧ID也必须忽略；新的点击同一张旧卡则是新的、明确的用户动作。
  await appendJsonl(inbox, [...oldInputs, click('new-after-upgrade')]);
  assert.equal(poll(f.configPath), 1);
  const feedback = await readFeedback(f.config.dataDir); assert.equal(feedback.length, 1); assert.equal(feedback[0]!.replyId, 'new-after-upgrade');
  assert.equal((await f.sent()).filter(row => row.key === 'reply:new-after-upgrade').length, 1);
  assert.equal(poll(f.configPath), 0); assert.equal((await f.sent()).filter(row => row.key === 'reply:new-after-upgrade').length, 1);
  assert.deepEqual(await readFile(receipts), beforeReceipts, '只读旧回执，不迁移、不重写');
  const ledger = await f.ledger();
  for (const input of oldInputs) assert.equal(ledger.tables.receipts[`feishu:${input.id}`], undefined, '不把旧处理状态搬成新账本事实');
});

test('返修1-1：只剩旧收件而没有任何旧回执时，首次前缀也不猜着重放，新输入仍可处理', async t => {
  const f = await fixture(t), inbox = join(f.config.dataDir, 'feishu-inbox.jsonl');
  await put(inbox, [text('old-without-receipt')]);
  assert.equal(poll(f.configPath), 0); assert.equal((await f.ledger()).observations.filter(row => row.kind === 'feedback').length, 0);
  await appendJsonl(inbox, [text('old-without-receipt'), text('new-after-boundary')]);
  assert.equal(poll(f.configPath), 1);
  assert.deepEqual((await f.ledger()).observations.filter(row => row.kind === 'feedback').map(row => row.detail), ['漏了 new-after-boundary']);
});

test('返修1-1：managed确认发送也尊重已有发送证据，回执缺口不造成第二次回话', async t => {
  const f = await fixture(t), channel = feishuChannel(f.config, undefined, { managed: true });
  await channel.start(); await channel.drain(after); await channel.stop();
  const input = text('reply-commit-gap'), sent = join(f.config.dataDir, 'feishu-sent.jsonl');
  await appendJsonl(sent, [{ key: `reply:${input.id}`, messageId: 'om_already_sent', at, type: 'text' } satisfies SentMessage]);
  await updateLedger(f.config.dataDir, at, (_state, add) => add({ kind: 'put', table: 'receipts', value: { id: `feishu:${input.id}`, at,
    response: JSON.stringify({ id: input.id, at, status: 'processed', response: '构造的已处理确认', reply: 'pending' }) } }));
  await put(join(f.config.dataDir, 'feishu-inbox.jsonl'), [input]);
  assert.equal(poll(f.configPath), 0); assert.equal((await f.sent()).filter(row => row.key === `reply:${input.id}`).length, 1);
  assert.equal(poll(f.configPath), 0); assert.equal((await f.sent()).filter(row => row.key === `reply:${input.id}`).length, 1);
});

for (const state of ['resumed', 'completed'] as const) test(`返修1-2：首发到达后SIGKILL、重启前${state}换版本，不得新建第二张卡`, { timeout: 15000 }, async t => {
  const f = await fixture(t); f.config.managedLoop!.verifyAfterMs = 0; await f.save();
  const eventPath = await putManagedLoop(f.config, f.root, 'paused', at), proof = join(f.root, 'synthetic-channel-creations.jsonl');
  const program = `
    import { appendFile } from 'node:fs/promises';
    import { loadConfig } from ${JSON.stringify(new URL('../src/core/config.ts', import.meta.url).href)};
    import { processManagedLoop } from ${JSON.stringify(new URL('../src/core/managed-loop.ts', import.meta.url).href)};
    import { feishuChannel } from ${JSON.stringify(new URL('../src/channels/feishu/index.ts', import.meta.url).href)};
    const config = await loadConfig(process.argv[1]);
    const channel = feishuChannel(config, { async send(type, content, key) {
      await appendFile(process.argv[2], JSON.stringify({type, key, messageId:'om_first', content})+'\\n');
      process.kill(process.pid, 'SIGKILL'); return 'om_first';
    } }, { managed:true });
    await processManagedLoop(config, ${JSON.stringify(after)}, {channels:[channel]});
  `;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', program, f.configPath, proof], { cwd: f.root, encoding: 'utf8', timeout: 10000 });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const before = await f.ledger(), card = Object.values(before.tables.cards)[0]!;
  assert.equal(Object.values(before.tables.deliveries)[0]!.state, 'sending'); assert.equal((await readJsonl(proof)).length, 1);
  await appendJsonl(eventPath, [{ schema: 1, id: `after-crash-${state}`, seq: 2, at: after, project: f.root, batch: '构造服务批次', stage: '甲', state,
    reason: { category: 'unknown', text: state }, evidence: [], detail: state === 'completed' ? { branch: 'feat/fake', commit: 'deadbeef' } : { trigger: 'user_message' } }]);
  await intakeLoop(f.config, after); // 确定性地先接新事件，再恢复发送；不靠调度竞态复现。
  const channel = feishuChannel(f.config, { async send(type, content, key) {
    await appendJsonl(proof, [{ type, key, content, messageId: 'om_second' }]); return 'om_second';
  }, async update(messageId) { await appendJsonl(join(f.root, 'synthetic-updates.jsonl'), [{ messageId }]); } }, { managed: true });
  const controller = new AbortController(), running = runService(f.config, controller.signal, { channels: [channel] }); void running.catch(() => {});
  try {
    await waitFor(() => readJsonl<{ kind: string }>(join(f.config.dataDir, 'service.log.jsonl')), rows => rows.some(row => row.kind === 'scan_completed'));
  } finally { controller.abort(); await running; }
  const restored = await f.ledger();
  assert.ok(restored.tables.cards[card.id]!.revision > card.revision);
  assert.equal((await readJsonl(proof)).length, 1, '旧版本没有messageId的首发未决事实不能被新版本绕过');
  assert.equal(Object.values(restored.tables.deliveries).filter(row => row.cardId === card.id && row.state === 'sending').length, 0);
  assert.ok(Object.values(restored.tables.deliveries).some(row => row.cardId === card.id && row.state === 'uncertain' && !row.messageId));
});

test('返修1-3：三个真实5秒文字确认超时期间，新loop开始仍在10秒内入账并唤醒处理', { timeout: 25000 }, async t => {
  const f = await fixture(t), inputs = [text('slow-reply-1'), text('slow-reply-2'), text('slow-reply-3')];
  let textCalls = 0;
  const channel = feishuChannel(f.config, { async send(type) {
    if (type === 'text') { textCalls++; return new Promise<string>(() => {}); }
    return 'om_synthetic_card';
  } }, { managed: true });
  await channel.start(); // 先切换收件边界，随后放的三条才是本次运行的新消息。
  await put(join(f.config.dataDir, 'feishu-inbox.jsonl'), inputs);
  const controller = new AbortController(), running = runService(f.config, controller.signal, { channels: [channel] }); void running.catch(() => {});
  try {
    await waitFor(async () => textCalls, count => count === 1);
    const began = performance.now(); await putManagedLoop(f.config, f.root, 'started', new Date().toISOString());
    const ledger = await waitFor(f.ledger, state => Object.keys(state.tables.assignments).length === 1, 10000);
    await waitFor(() => readJsonl<{ kind: string; ledgerSequence?: number }>(join(f.config.dataDir, 'service.log.jsonl')),
      rows => rows.some(row => row.kind === 'scan_completed' && (row.ledgerSequence ?? 0) >= ledger.seq), 10000);
    const elapsed = performance.now() - began; assert.ok(elapsed < 10000); assert.equal(textCalls, 1, 'loop处理不能等确认队列完成');
    await waitFor(f.ledger, state => inputs.every(input => {
      const receipt = state.tables.receipts[`feishu:${input.id}`]; return !!receipt && JSON.parse(receipt.response).reply === 'pending';
    }), 18000);
    assert.equal(textCalls, 3, '保留三条各5秒实际超时，未用缩短时限通过');
    t.diagnostic(`三条文字确认各保留5000ms超时；新loop入账并完成唤醒处理 ${Math.round(elapsed)}ms。`);
  } finally { controller.abort(); await running; }
});
