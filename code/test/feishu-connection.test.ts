// 客户端/长连接为内存替身；只使用锁定 SDK 的纯 LoggerProxy 验证真实日志参数形状。
// 凭证仅测试哨兵，不建立真实连接、不联网、不读进程凭证。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { LoggerLevel, LoggerProxy } from '@larksuiteoapi/node-sdk';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import { realTransport, safeFeishuFailure } from '../src/channels/feishu/transport.ts';
import { overview, rebuild } from '../src/core/agent.ts';
import { renderOverview } from '../src/core/judge.ts';
import { readEvents, readJsonl, readOutbox } from '../src/core/store.ts';
import { runService } from '../src/service/daemon.ts';
import { put, sandbox } from './fixtures.ts';

type Sdk = typeof import('@larksuiteoapi/node-sdk');
type WsOptions = ConstructorParameters<Sdk['WSClient']>[0];
const credentials = { appId: 'cli_0000000000000000', appSecret: 'SYNTHETIC_SECRET_NEVER_LOG' };
const raw = `SYNTHETIC_UPSTREAM_BODY ${credentials.appId} ${credentials.appSecret}`;
function sdkStub(start: (options: WsOptions) => void | Promise<void>) {
  let options: WsOptions, stopped = false;
  class Client { im = { message: { async create() { return { code: 0, data: { message_id: 'om_stub' } }; } } }; }
  class WSClient {
    constructor(input: WsOptions) { options = input; }
    async start() { await start(options); }
    close() { stopped = true; }
  }
  class EventDispatcher { register() { return this; } }
  // SDK 的 I/O 边界替换为这三个构造器；LoggerProxy 使用已锁定依赖的实际实现。
  const sdk = { Client, WSClient, EventDispatcher, AppType: { SelfBuild: 0 } } as unknown as Sdk;
  return { loadSdk: async () => sdk, options: () => options!, stopped: () => stopped };
}
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.sources.cc = null; f.config.learning = false;
  f.config.feishu = { mode: 'fake', receiverId: 'ou_synthetic', timeoutMs: 1000 };
  f.config.service = { intervalMs: 10000, restartWindowMs: 60000, restartThreshold: 3 };
  return f;
}
async function waitFor(operation: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await operation()) return; await delay(10); }
  throw new Error('等待构造常驻结果超时');
}
async function assertNoSecrets(dir: string) {
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.jsonl') && !name.endsWith('.json')) continue;
    const content = await readFile(join(dir, name), 'utf8');
    for (const value of Object.values(credentials).concat('SYNTHETIC_UPSTREAM_BODY')) assert.ok(!content.includes(value), `${name} 不得保存凭证或原报文`);
  }
}

for (const mode of ['reject', 'callback', 'logger', 'logger-dns', 'logger-http-timeout'] as const) test(`误报 A8：SDK ${mode} 失败，常驻仍完成检测，日志脱敏且总览未连接`, async t => {
  const f = await fixture(t);
  const category = mode === 'logger-dns' || mode === 'logger-http-timeout' ? 'network' : 'credentials';
  const sdk = sdkStub(options => {
    if (mode === 'reject') throw Object.assign(new Error(`invalid app secret ${raw}`), { code: 514 });
    if (mode === 'callback') options.onError?.(new Error(`pullConnectConfig failed: code=514, msg=${raw}`));
    if (mode.startsWith('logger')) {
      const logger = new LoggerProxy(LoggerLevel.error, options.logger!);
      const message = mode === 'logger-dns' ? `getaddrinfo ENOTFOUND synthetic.invalid ${raw}`
        : mode === 'logger-http-timeout' ? `timeout of 15000ms exceeded ${raw}` : `code: 514, auth failed ${raw}`;
      // 真实 LoggerProxy 把变参包装成单个数组；不 reject、不触发 onError。
      logger.error('[ws]', message); logger.error('[ws]', message);
    }
  });
  const transport = await realTransport(f.config.feishu!, { credentials, loadSdk: sdk.loadSdk });
  const channel = feishuChannel(f.config, transport), controller = new AbortController();
  const running = runService(f.config, controller.signal, { channels: [channel] });
  // 先安装拒绝处理器，失败仍由后面的 await 报告。
  void running.catch(() => {});
  try {
    const logPath = join(f.config.dataDir, 'service.log.jsonl');
    await waitFor(async () => (await readJsonl<{ kind: string }>(logPath)).some(e => e.kind === 'scan_completed'));
    const log = await readJsonl<{ kind: string; category?: string; message?: string }>(logPath);
    const failures = log.filter(e => e.kind === 'feishu_connection_failed');
    assert.equal(failures.length, 1); assert.equal(failures[0]?.category, category); assert.match(failures[0]!.message!, category === 'network' ? /网络/ : /凭证/);
    const view = await overview(f.config);
    assert.equal(view.projection.feishuConnection?.state, 'failed');
    assert.match(renderOverview(view.records, view.projection), new RegExp(`飞书长连接：未连接.*${category}`));
    const rebuilt = await rebuild(f.config);
    assert.deepEqual(rebuilt.projection.feishuConnection, view.projection.feishuConnection);
    const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
    const cli = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), 'overview', '--config', configPath, '--json'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).feishuConnection.state, 'failed');
    assert.equal((await readOutbox(f.config.dataDir)).length, 0);
    controller.abort(); await running; assert.equal(sdk.stopped(), true);
    assert.equal((await overview(f.config)).projection.feishuConnection?.state, 'stopped');
    await assertNoSecrets(f.config.dataDir);
  } finally {
    // 必须先停常驻再执行 fixture 的临时目录清理，断言失败时也不能留下写入者。
    controller.abort(); await running;
  }
});

test('飞书状态：握手成功才算已连接，断开/重连/停止可见；同状态去重，停止后的回调无效', async t => {
  const f = await fixture(t), sdk = sdkStub(options => { options.onReady?.(); });
  const transport = await realTransport(f.config.feishu!, { credentials, loadSdk: sdk.loadSdk });
  const channel = feishuChannel(f.config, transport); await channel.start(); await channel.drain();
  let view = await overview(f.config); assert.equal(view.projection.feishuConnection?.state, 'connected');
  assert.match(renderOverview(view.records, view.projection), /飞书长连接：已连接/);
  sdk.options().onReconnecting?.(); await channel.drain();
  view = await overview(f.config); assert.match(renderOverview(view.records, view.projection), /未连接（重连中）/);
  sdk.options().onReconnected?.(); sdk.options().onReconnected?.(); await channel.drain();
  assert.equal((await overview(f.config)).projection.feishuConnection?.state, 'connected');
  const connected = (await readEvents(f.config.dataDir)).filter(e => e.kind === 'feishu_connection' && e.connection.state === 'connected');
  assert.equal(connected.length, 2);
  await channel.stop(); const count = (await readEvents(f.config.dataDir)).length;
  sdk.options().onError?.(new Error(raw)); sdk.options().onReady?.(); await channel.drain();
  assert.equal((await readEvents(f.config.dataDir)).length, count);
  assert.equal((await overview(f.config)).projection.feishuConnection?.state, 'stopped'); await assertNoSecrets(f.config.dataDir);
});

test('飞书分类：只在证据支持时区分凭证/权限/网络/配置，否则记未知，不保存上游原文', () => {
  for (const [error, category] of [
    [{ response: { status: 401, data: { msg: raw } } }, 'credentials'],
    [new Error(`pullConnectConfig failed: code=514, msg=${raw}`), 'credentials'],
    [{ response: { status: 403, data: { msg: raw } } }, 'permission'],
    [Object.assign(new Error(raw), { code: 'ENOTFOUND' }), 'network'],
    [new Error(`handshake timeout after 1000ms ${raw}`), 'network'],
    [Object.assign(new Error(raw), { name: 'ConnectionConfigError' }), 'configuration'],
    [new Error(raw), 'unknown'],
  ] as const) {
    const failure = safeFeishuFailure(error); assert.equal(failure.category, category);
    assert.ok(!JSON.stringify(failure).includes('SYNTHETIC_')); assert.ok(!JSON.stringify(failure).includes(credentials.appId));
  }
});

for (const [error, category] of [
  [{ response: { status: 403, data: { msg: raw } } }, 'permission'],
  [Object.assign(new Error(raw), { code: 'ECONNREFUSED' }), 'network'],
  [new Error(raw), 'unknown'],
] as const) test(`飞书 ${category}：启动替身拒绝也有脱敏常驻日志`, async t => {
  const f = await fixture(t);
  const channel = feishuChannel(f.config, { async send() { return 'om_stub'; }, async start() { throw error; } });
  await channel.start(); const view = await overview(f.config);
  assert.equal(view.projection.feishuConnection?.failure?.category, category);
  const log = await readJsonl<{ kind: string; category?: string }>(join(f.config.dataDir, 'service.log.jsonl'));
  assert.equal(log.find(e => e.kind === 'feishu_connection_failed')?.category, category);
  await channel.stop(); await assertNoSecrets(f.config.dataDir);
});

test('飞书初始化：无效构造凭证不加载 SDK；假渠道不把文件投递成功冒充真实连接', async t => {
  const f = await fixture(t); let loaded = false;
  await assert.rejects(realTransport(f.config.feishu!, { credentials: { appId: 'invalid', appSecret: credentials.appSecret }, loadSdk: async () => { loaded = true; throw new Error(raw); } }), /凭证/);
  assert.equal(loaded, false);
  const channel = feishuChannel(f.config); await channel.start();
  const view = await overview(f.config); assert.equal(view.projection.feishuConnection?.state, 'fake');
  assert.match(renderOverview(view.records, view.projection), /假渠道（未连接真实飞书）/);
  await channel.stop(); await assertNoSecrets(f.config.dataDir);
});
