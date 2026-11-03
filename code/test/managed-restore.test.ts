// 全新PA乙第3次返修：只复制临时构造数据，不接真实账号/数据。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateConfig } from '../src/core/config.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import type { Incoming, SentMessage } from '../src/channels/feishu/index.ts';
import { readLedger, updateLedger } from '../src/core/ledger.ts';
import { processManagedLoop } from '../src/core/managed-loop.ts';
import { appendJsonl, readJsonl } from '../src/core/store.ts';
import { put, sandbox } from './fixtures.ts';

const at = '2026-11-02T10:00:00.000Z', after = '2026-11-02T10:04:00.000Z';
const cli = resolve(import.meta.dirname, '../src/cli/main.ts'), stub = resolve(import.meta.dirname, 'loop-stub.ts');
const boundaryId = 'upgrade:feishu-inbox';
function text(id: string, content = `漏了 ${id}`): Incoming {
  return { id, at, actor: 'ou_test', type: 'text', messageId: `om_${id}`, chatType: 'p2p', text: content };
}
function invoke(configPath: string, command = 'feishu-poll') {
  return spawnSync(process.execPath, [cli, command, '--config', configPath, '--now', after, '--json'], { encoding: 'utf8', timeout: 10000 });
}
function poll(configPath: string): number {
  const result = invoke(configPath); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout).processed;
}
async function fixture(t: TestContext, legacyBoundary = false) {
  const base = await sandbox(), root = await realpath(base.root); t.after(() => rm(root, { recursive: true, force: true }));
  const config = await validateConfig({ ...base.config, dataDir: join(root, 'data'), inboxDir: join(root, 'inbox'), sources: { cc: null, loop: null },
    commands: { cc: '/synthetic/must-not-run' }, feishu: { mode: 'fake', receiverId: 'ou_test', timeoutMs: 1000 }, managedLoop: { verifyAfterMs: 0 },
    worker: { executable: process.execPath, args: [stub, join(root, 'worker')], timeoutMs: 5000 } });
  const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  const inbox = join(config.dataDir, 'feishu-inbox.jsonl'), oldInputs = [text('old-unrecorded', '漏了 旧消息甲'), text('old-id-only', '漏了 旧消息乙')];
  // 保留非规范空白/CRLF与多字节字符，校验必须认原字节，不能只认解析后JSON。
  await put(inbox, oldInputs.map(input => `  ${JSON.stringify(input)}\r\n`).join(''));
  await put(join(config.dataDir, 'feishu-receipts.jsonl'), [{ id: 'old-id-only' }]);
  if (legacyBoundary) {
    const stat = await lstat(inbox), bytes = (await readFile(inbox)).length;
    await updateLedger(config.dataDir, at, (_state, add) => add({ kind: 'put', table: 'receipts', value: { id: boundaryId, at,
      response: JSON.stringify({ rows: oldInputs.length, bytes, dev: stat.dev, ino: stat.ino, sentRows: 0 }) } }));
  } else assert.equal(poll(configPath), 0);
  return { root, config, configPath, inbox, oldInputs };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function copyData(f: Fixture, label = 'restored') {
  const dataDir = join(f.root, label); await cp(f.config.dataDir, dataDir, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  const config = await validateConfig({ ...f.config, dataDir }), configPath = join(f.root, `${label}-config.json`);
  await writeFile(configPath, JSON.stringify(config));
  assert.notEqual((await lstat(join(dataDir, 'feishu-inbox.jsonl'))).ino, (await lstat(f.inbox)).ino, '真正复制到独立新文件，不保留源inode');
  return { dataDir, config, configPath, inbox: join(dataDir, 'feishu-inbox.jsonl') };
}

test('返修3-1：非空旧收件建界→完整复制恢复→新按钮送话及反馈各处理一次，历史不重放', async t => {
  const f = await fixture(t);
  const event = { schema: 1, id: 'restore-batch-paused', seq: 1, at, project: f.root, batch: '恢复构造批次', stage: '乙', state: 'paused',
    reason: { category: 'unknown', text: '暂停' }, evidence: [], detail: {} };
  const emitted = spawnSync(process.execPath, [stub, join(f.root, 'worker'), 'emit', f.config.inboxDir!], { encoding: 'utf8', input: JSON.stringify(event), timeout: 10000 });
  assert.equal(emitted.status, 0, emitted.stderr);
  await processManagedLoop(f.config, after, { channels: [feishuChannel(f.config, undefined, { managed: true })] });
  const initial = await readLedger(f.config.dataDir), card = Object.values(initial.tables.cards)[0]!;
  const originalMessage = (await readJsonl<SentMessage>(join(f.config.dataDir, 'feishu-sent.jsonl'))).find(row => row.noticeId === card.id)!;
  const originalLedger = await readFile(join(f.config.dataDir, 'ledger.jsonl')), originalInbox = await readFile(f.inbox);
  const restored = await copyData(f);
  assert.deepEqual(await readFile(join(restored.dataDir, 'ledger.jsonl')), originalLedger);
  assert.deepEqual(await readFile(restored.inbox), originalInbox);
  const overview = invoke(restored.configPath, 'overview'); assert.equal(overview.status, 0, overview.stderr);
  // 旧未处理ID重新到达也不是新授权；只有新点击才送原派工。
  const click: Incoming = { id: 'new-after-restore', at: after, actor: 'ou_test', type: 'action', messageId: originalMessage.messageId,
    value: { action: 'managed_suggest', noticeId: card.id, revision: String(card.revision) } };
  await appendJsonl(restored.inbox, [...f.oldInputs, click, click]);
  assert.equal(poll(restored.configPath), 1);
  const received = await readJsonl<{ text: string; stage: string }>(join(f.root, 'worker', 'received.jsonl'));
  assert.equal(received.length, 1); assert.equal(received[0]!.text, card.suggestion); assert.equal(received[0]!.stage, '乙');
  const current = (await readLedger(restored.dataDir)).tables.cards[card.id]!;
  assert.match(current.deliveryText!, /已读/);
  const feedback: Incoming = { ...click, id: 'feedback-after-restore', value: { action: 'managed_feedback_正确', noticeId: card.id, revision: String(current.revision) } };
  await appendJsonl(restored.inbox, [feedback, feedback]); assert.equal(poll(restored.configPath), 1); assert.equal(poll(restored.configPath), 0);
  const ledger = await readLedger(restored.dataDir);
  assert.equal(ledger.observations.filter(row => row.kind === 'feedback').length, 1);
  for (const input of f.oldInputs) assert.equal(ledger.tables.receipts[`feishu:${input.id}`], undefined);
  assert.equal((await readJsonl(join(f.root, 'worker', 'attempts.jsonl'))).length, 1);
  const sent = await readJsonl<SentMessage>(join(restored.dataDir, 'feishu-sent.jsonl'));
  assert.ok(sent.filter(row => row.type === 'interactive').every(row => row.messageId === originalMessage.messageId));
  for (const id of [click.id, feedback.id]) assert.equal(sent.filter(row => row.key === `reply:${id}`).length, 1);
  assert.deepEqual(await readFile(f.inbox), originalInbox, '恢复副本不改源目录');
  assert.deepEqual(await readFile(join(f.config.dataDir, 'ledger.jsonl')), originalLedger);
});

for (const variant of ['same-inode-edit', 'copied-prefix-edit', 'truncate-and-pad'] as const) test(`返修3-1：${variant}不能借长度或inode变化放行损坏前缀`, async t => {
  const f = await fixture(t), target = variant === 'same-inode-edit' ? { ...f, dataDir: f.config.dataDir } : await copyData(f);
  const before = await readFile(target.inbox), identity = await lstat(target.inbox);
  if (variant === 'truncate-and-pad') {
    await writeFile(target.inbox, before.toString('utf8').split('\n')[0] + '\n');
    await appendJsonl(target.inbox, [text('padding-new-message', `漏了 ${'新'.repeat(800)}`)]);
    assert.ok((await lstat(target.inbox)).size >= before.length, '新行补足文件体积，不能仅用总长度通过');
  } else {
    const damaged = Buffer.from(before.toString('utf8').replace('旧消息甲', '改消息甲'));
    assert.equal(damaged.length, before.length); await writeFile(target.inbox, damaged);
    assert.equal((await lstat(target.inbox)).ino, identity.ino, '原地等长改写，覆盖单靠inode不能发现的损坏');
    await appendJsonl(target.inbox, [text('blocked-new-message')]);
  }
  const ledgerBefore = await readFile(join(target.dataDir, 'ledger.jsonl')), result = invoke(target.configPath);
  assert.equal(result.status, 1, '校验失败必须拒绝，不能重置边界接纳文件');
  assert.deepEqual(await readFile(join(target.dataDir, 'ledger.jsonl')), ledgerBefore);
  assert.equal((await readLedger(target.dataDir)).observations.filter(row => row.kind === 'feedback').length, 0);
  assert.equal((await readJsonl<SentMessage>(join(target.dataDir, 'feishu-sent.jsonl'))).length, 0);
});

test('返修3-1：无摘要旧边界先在原文件补记校验后，完整副本可恢复且不改原收件', async t => {
  const f = await fixture(t, true), before = await readFile(f.inbox);
  assert.equal(poll(f.configPath), 0);
  const anchored = JSON.parse((await readLedger(f.config.dataDir)).tables.receipts[boundaryId]!.response);
  assert.match(anchored.prefixSha256, /^[a-f0-9]{64}$/); assert.deepEqual(await readFile(f.inbox), before);
  const restored = await copyData(f); await appendJsonl(restored.inbox, [text('new-after-legacy-anchor')]);
  assert.equal(poll(restored.configPath), 1); assert.equal(poll(restored.configPath), 0);
});

test('返修3-1：仅有不同inode且缺摘要的旧副本，证据不足时拒绝自动重新建界', async t => {
  const f = await fixture(t, true), restored = await copyData(f);
  await appendJsonl(restored.inbox, [text('must-not-run')]);
  const before = await readFile(join(restored.dataDir, 'ledger.jsonl'));
  assert.equal(invoke(restored.configPath).status, 1);
  assert.deepEqual(await readFile(join(restored.dataDir, 'ledger.jsonl')), before);
  assert.equal((await readLedger(restored.dataDir)).observations.filter(row => row.kind === 'feedback').length, 0);
});
