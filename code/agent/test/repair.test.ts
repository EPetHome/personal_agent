import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { fixture, until } from './helpers.js';
import { App } from '../src/app.js';
import { Store } from '../src/store.js';
import { Watchdog } from '../src/watchdog.js';
import { deliver, makeChannel } from '../src/channel.js';
import type { Config, Input } from '../src/types.js';
import { atomicJson, sleep } from '../src/util.js';
import { sdkStub, type StalledPhase } from './sdk-stub.js';
import { toWireMessages } from '../src/model.js';
import { PNG } from './reliability-fixtures.js';

const localSdkChannel = (c: Config, domain: string) => makeChannel({ ...c, feishu: { ...c.feishu, mode: 'real' } }, undefined,
  { domain, credentials: { appId: `cli_synthetic_${randomUUID()}`, appSecret: 'SYNTHETIC_APP_SECRET' } });
const downloadInput = (): Input => ({ id: 'download', source: 'feishu', who: 'owner', at: new Date().toISOString(), text: '', messageId: 'message', attachments: [] });

test('R1: attachment original-name blacklist survives renaming, aliases and restart; normal/example files remain readable', async t => {
  const f = await fixture({ flow: [{ tools: [{ name: 'read_file', arguments: { path: '{{attachment0}}' } }] }, { text: '文件检查完成' }] });
  t.after(() => f.close()); let app = await f.start();
  const names = ['.env', '.npmrc', '.netrc', 'note.txt', '.env.example'];
  for (const [n, name] of names.entries()) await f.inject({ id: `sensitive-${n}`, attachment: { kind: 'file', key: `asset-${n}`, name, content: n < 3 ? `SYNTHETIC_FORBIDDEN_BODY_${n}` : `allowed-example-${n}` } });
  await until(() => app.store.row('feishu:sensitive-4')?.state === 'done');
  for (const [n] of names.entries()) {
    const input = app.store.row(`feishu:sensitive-${n}`)!.input;
    const request = f.model.requests.find(r => r.round === 1 && r.body.messages.some((m: any) => typeof m.content === 'string' && m.content.includes(input.id)));
    assert.ok(request);
    const response = JSON.parse(request.body.messages.find((m: any) => m.role === 'tool').content);
    assert.equal(response.ok, n >= 3);
    if (n < 3) assert.equal(JSON.stringify(f.model.requests).includes(`SYNTHETIC_FORBIDDEN_BODY_${n}`), false);
  }
  const deniedPath = app.store.row('feishu:sensitive-0')!.input.attachments[0]!.path!;
  const alias = join(f.project, 'innocent-alias.txt'); await symlink(deniedPath, alias);
  await f.stop(); app = await f.start();
  assert.equal((await app.router.files.read(deniedPath, [])).ok, false);
  assert.equal((await app.router.files.read(alias, [])).ok, false);
  const unknownLegacy = join(f.config.attachmentDir, `${'a'.repeat(24)}-unknown.txt`); await writeFile(unknownLegacy, 'unindexed legacy fixture');
  assert.equal((await app.router.files.read(unknownLegacy, [])).ok, false);
  assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='file_read'").get()!.n), 2);
  for (const file of await readdir(join(f.config.dataDir, 'events'))) assert.equal((await readFile(join(f.config.dataDir, 'events', file), 'utf8')).includes('SYNTHETIC_FORBIDDEN_BODY_'), false);
});

for (const phase of ['auth', 'send', 'update', 'download-headers', 'download-body'] as StalledPhase[]) test(`R2: official SDK ${phase} has an absolute deadline and cancels its socket`, async t => {
  const f = await fixture(), server = await sdkStub(); f.config.feishu.timeoutMs = 150;
  const channel = await localSdkChannel(f.config, server.url); server.stall(phase);
  t.after(async () => { await channel.stop(); await server.close(); await f.close(); });
  const target = join(f.root, 'download.bin'), started = Date.now();
  const job = phase === 'auth' || phase === 'send' ? channel.send('synthetic reply', 'key') : phase === 'update' ? channel.update('message', 'updated') : channel.download(downloadInput(), { name: 'note.txt', key: 'file', kind: 'file' }, target);
  await assert.rejects(job); assert.ok(Date.now() - started < 1500);
  await until(() => server.closed === 1);
  const attempts = server.calls.length; await sleep(200); assert.equal(server.calls.length, attempts, 'no automatic network retry');
  if (phase?.startsWith('download')) {
    await until(async () => !(await readdir(f.root)).includes('download.bin.download'));
    await assert.rejects(readFile(target));
  }
  if (phase === 'auth') assert.equal(server.calls.length, 1, 'authentication cancellation must not continue into sending');
});

test('R2: caller cancellation reaches an already-streaming official SDK download', async t => {
  const f = await fixture(), server = await sdkStub(); f.config.feishu.timeoutMs = 5000; server.stall('download-body');
  const channel = await localSdkChannel(f.config, server.url);
  t.after(async () => { await channel.stop(); await server.close(); await f.close(); });
  const controller = new AbortController(), target = join(f.root, 'cancel.bin');
  const pending = channel.download(downloadInput(), { name: 'note.txt', key: 'file', kind: 'file' }, target, controller.signal);
  await until(() => server.stalled === 1); const at = Date.now(); controller.abort(new Error('synthetic input cancellation'));
  await assert.rejects(pending); assert.ok(Date.now() - at < 500); await until(() => server.closed === 1);
  await until(async () => !(await readdir(f.root)).includes('cancel.bin.download')); await assert.rejects(readFile(target));
});

test('R2: a stuck attachment respects the input deadline and the next queued input still completes', async t => {
  const f = await fixture(), server = await sdkStub(); f.config.feishu.timeoutMs = 2000; f.config.queue.inputTimeoutMs = 200; server.stall('download-body');
  const store = new Store(f.config), real = await localSdkChannel(f.config, server.url), inbound = await makeChannel(f.config, store);
  const app = new App(f.config, { ...real, start: inbound.start, async stop() { await inbound.stop(); await real.stop(); } }, store);
  t.after(async () => { await app.stop(); await server.close(); await f.close(); }); await app.start();
  const at = Date.now();
  await f.inject({ id: 'stalled-file', attachment: { name: 'note.txt', key: 'file', kind: 'file', content: 'unused fixture' } });
  await f.inject({ id: 'next-input', text: 'after-hang' });
  await until(() => app.store.row('feishu:stalled-file')?.state === 'failed' && app.store.row('feishu:next-input')?.state === 'done', 3000);
  assert.ok(Date.now() - at < 1500, 'input cancellation is earlier than the 2s channel timeout');
  await until(() => server.closed === 1);
  assert.equal(server.messages.filter(text => text.includes('after-hang')).length, 1);
  assert.equal(f.model.requests.length, 2, 'the timed-out attachment never reaches Router');
  await until(async () => (await readdir(f.config.attachmentDir)).every(name => !name.endsWith('.download')));
});

test('R2: timed-out actual SDK delivery remains uncertain and is never sent again', async t => {
  const f = await fixture(), server = await sdkStub(); f.config.feishu.timeoutMs = 150; server.stall('send');
  const channel = await localSdkChannel(f.config, server.url), store = new Store(f.config);
  t.after(async () => { store.close(); await channel.stop(); await server.close(); await f.close(); });
  assert.equal((await deliver(store, channel, 'i', 'uncertain-send', 'fixture')).status, 'uncertain');
  await until(() => server.closed === 1);
  assert.equal((await deliver(store, channel, 'i', 'uncertain-send', 'fixture')).status, 'uncertain');
  assert.equal(server.calls.filter(c => c.method === 'POST' && !c.path.includes('/auth/')).length, 1);
});

test('R2: a hanging watchdog send cannot suppress another fault or recovery, and uncertain sends do not repeat', async t => {
  const f = await fixture(), server = await sdkStub(); f.config.feishu.timeoutMs = 150;
  f.config.watchdog.heartbeatStaleMs = 1000; f.config.watchdog.pollMs = 100000; f.config.watchdog.minDiskBytes = 100;
  const store = new Store(f.config), channel = await localSdkChannel(f.config, server.url);
  await atomicJson(join(f.config.dataDir, 'heartbeat.json'), { at: Date.now() - 300000 }); store.set('modelFailures', 3); server.stall('send');
  const dog = new Watchdog(f.config, channel, async () => 1000);
  t.after(async () => { await dog.stop(); store.close(); await channel.stop(); await server.close(); await f.close(); });
  const at = Date.now(); await dog.start(); assert.ok(Date.now() - at < 2000);
  assert.equal(f.feishu.notifications.filter(n => n.state === 'fault').length, 2);
  await until(() => server.closed === 2);
  const attempts = server.calls.length; await dog.tick(); assert.equal(server.calls.length, attempts);
  server.stall(null); store.set('modelFailures', 0); await atomicJson(join(f.config.dataDir, 'heartbeat.json'), { at: Date.now() });
  await dog.tick(); await dog.tick();
  assert.equal(f.feishu.notifications.filter(n => n.state === 'recovery').length, 2);
  assert.equal(server.messages.filter(text => text.includes('已恢复')).length, 2);
});

test('R2: normal stop cancels a streaming attachment, preserves it for restart and then finishes once', async t => {
  const f = await fixture(), server = await sdkStub(); f.config.feishu.timeoutMs = 5000; f.config.queue.stopMs = 100;
  const create = async () => {
    const store = new Store(f.config), real = await localSdkChannel(f.config, server.url), inbound = await makeChannel(f.config, store);
    return new App(f.config, { ...real, start: inbound.start, async stop() { await inbound.stop(); await real.stop(); } }, store);
  };
  let app = await create(); t.after(async () => { await app.stop(); await server.close(); await f.close(); });
  server.stall('download-body'); await app.start(); await f.inject({ id: 'resume-file', attachment: { kind: 'file', name: 'note.txt', key: 'resume', content: 'unused fixture' } });
  await until(() => server.stalled === 1); const at = Date.now(); await app.stop(); assert.ok(Date.now() - at < 500);
  await until(() => server.closed === 1);
  await until(async () => (await readdir(f.config.attachmentDir)).every(name => !name.endsWith('.download')));
  server.stall(null); app = await create(); assert.equal(app.store.row('feishu:resume-file')?.state, 'processing');
  await app.start(); await until(() => app.store.row('feishu:resume-file')?.state === 'done'); assert.equal(server.messages.length, 1);
});

test('R2: stopping watchdog aborts an in-flight send instead of waiting for its long request timeout', async t => {
  const f = await fixture(), server = await sdkStub(); f.config.feishu.timeoutMs = 5000; f.config.watchdog.minDiskBytes = 100;
  const store = new Store(f.config), channel = await localSdkChannel(f.config, server.url);
  await atomicJson(join(f.config.dataDir, 'heartbeat.json'), { at: Date.now() - 300000 }); server.stall('send');
  const dog = new Watchdog(f.config, channel, async () => 1000);
  t.after(async () => { await dog.stop(); store.close(); await channel.stop(); await server.close(); await f.close(); });
  const starting = dog.start(); await until(() => server.stalled === 1); const at = Date.now();
  await dog.stop(); await starting; assert.ok(Date.now() - at < 500); await until(() => server.closed === 1);
});

test('R3: strict model rejects image tool content, interrupted acknowledgements and mismatched IDs; converted vision input is accepted', async t => {
  const f = await fixture(); t.after(() => f.close());
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
  const call = (id: string) => ({ id, type: 'function', function: { name: 'read_image', arguments: '{}' } });
  const assistant = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [call('img')] };
  const submit = (messages: unknown) => fetch(`${f.model.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'script-model', messages }) });
  const badImage = await submit([{ role: 'user', content: '看图片' }, assistant, { role: 'tool', tool_call_id: 'img', content: [image] }]);
  assert.equal(badImage.status, 400); assert.match(JSON.stringify(await badImage.json()), /text-only/);
  const interrupted = await submit([{ role: 'user', content: '看图片' }, { ...assistant, tool_calls: [call('img'), call('other')] }, { role: 'tool', tool_call_id: 'img', content: 'ok' }, { role: 'user', content: [image] }, { role: 'tool', tool_call_id: 'other', content: 'ok' }]);
  assert.equal(interrupted.status, 400); assert.match(JSON.stringify(await interrupted.json()), /all tool responses/);
  const mismatch = await submit([{ role: 'user', content: '看图片' }, assistant, { role: 'tool', tool_call_id: 'wrong', content: 'ok' }]);
  assert.equal(mismatch.status, 400); assert.match(JSON.stringify(await mismatch.json()), /unmatched/);
  const converted = toWireMessages([new HumanMessage('看图片'), new AIMessage({ content: '', tool_calls: [{ id: 'img', name: 'read_image', args: {} }] }), new ToolMessage({ tool_call_id: 'img', content: [{ type: 'text', text: 'path and fingerprint' }, image] })]);
  assert.deepEqual(converted.map(m => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(converted[2]!.tool_call_id, 'img'); assert.equal(typeof converted[2]!.content, 'string');
  assert.equal((await submit(converted)).status, 200);
});

test('R3: parallel image/text tools and repeated image rounds retain call IDs with vision only after all tool receipts', async t => {
  const f = await fixture({ requireReasoning: true, flow: [
    { tools: [{ name: 'read_image', arguments: { path: '{{attachment0}}' } }, { name: 'get_task', arguments: { id: 'missing' } }, { name: 'read_image', arguments: { path: '{{attachment0}}' } }] },
    { tools: [{ name: 'read_image', arguments: { path: '{{attachment0}}' } }] },
    { tools: [{ name: 'reply', arguments: { text: '已查看图片材料' } }] }, { text: 'done' },
  ] }); t.after(() => f.close()); const app = await f.start();
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  await f.inject({ id: 'parallel-images', attachment: { kind: 'image', key: 'pixel', contentBase64: image } });
  await until(() => app.store.row('feishu:parallel-images')?.state === 'done'); assert.equal(f.model.requests.length, 4);
  const second = f.model.requests[1].body.messages, third = f.model.requests[2].body.messages;
  const firstCalls = second.find((m: any) => m.role === 'assistant').tool_calls;
  const receipts = second.filter((m: any) => m.role === 'tool');
  assert.deepEqual(new Set(receipts.map((m: any) => m.tool_call_id)), new Set(firstCalls.map((c: any) => c.id)));
  const visualIndex = second.findIndex((m: any) => m.role === 'user' && Array.isArray(m.content));
  assert.ok(second.lastIndexOf(receipts.at(-1)) < visualIndex);
  assert.equal(second[visualIndex].content.filter((b: any) => b.type === 'image_url').length, 2);
  assert.equal(third.filter((m: any) => m.role === 'user' && Array.isArray(m.content)).flatMap((m: any) => m.content).filter((b: any) => b.type === 'image_url').length, 3);
  assert.ok(third.filter((m: any) => m.role === 'tool').every((m: any) => typeof m.content === 'string' && !m.content.includes('base64,')));
  assert.equal(app.store.window().some(w => w.text.includes(image)), false); assert.equal(f.feishu.messages.length, 1);
});

test('R3: checkpoint recovery re-encodes persisted image tools without replaying the read or losing acknowledgement IDs', async t => {
  const f = await fixture({ requireReasoning: true, flow: [
    { tools: [{ name: 'read_image', arguments: { path: '{{attachment0}}' } }] }, { hang: true },
    { tools: [{ name: 'reply', arguments: { text: '恢复后已查看图片' } }] }, { text: 'done' },
  ] }, { queue: { busyMs: 10000, inputTimeoutMs: 5000, stopMs: 100 } }); t.after(() => f.close());
  let app = await f.start(); await f.inject({ id: 'resume-image', attachment: { kind: 'image', key: 'pixel', contentBase64: PNG } });
  await until(() => f.model.requests.length === 2); const before = f.model.requests[1].body.messages;
  await f.stop(); app = await f.start(); await until(() => app.store.row('feishu:resume-image')?.state === 'done');
  const after = f.model.requests[2].body.messages;
  assert.equal(after.find((m: any) => m.role === 'tool').tool_call_id, before.find((m: any) => m.role === 'tool').tool_call_id);
  assert.ok(after.some((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'image_url')));
  assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='file_read'").get()!.n), 1);
  assert.equal(f.feishu.messages.length, 1);
});
