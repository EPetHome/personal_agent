import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdir, writeFile } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { Store } from '../src/store.js';
import { Watchdog } from '../src/watchdog.js';
import { makeChannel, type Channel } from '../src/channel.js';
import { atomicJson } from '../src/util.js';
import { loadConfig, loadNotificationConfig } from '../src/config.js';

const options = { watchdog: { heartbeatStaleMs: 100, inputStaleMs: 100, feishuStaleMs: 100, minDiskBytes: 100, pollMs: 100000, local: { mode: 'fake' } } };
// Merge a fake URL after fixture creation, never contact desktop or real Feishu.
async function setup() {
  const f = await fixture();
  Object.assign(f.config.watchdog, { ...options.watchdog, local: { mode: 'fake', url: f.feishu.url } });
  const store = new Store(f.config), channel = await makeChannel(f.config);
  const base = Date.now(); await atomicJson(join(f.config.dataDir, 'heartbeat.json'), { at: base });
  return { f, store, channel, base };
}

test('all five mechanical fault classes, independent recovery, no repeated alerts or model/log writes', async t => {
  const { f, store, channel, base } = await setup(); t.after(() => f.close()); t.after(() => store.close());
  let disk = 1000;
  const dog = new Watchdog(f.config, channel, async () => disk); t.after(() => dog.stop()); await dog.start();
  store.enqueue({ id: 'stuck', source: 'feishu', who: 'owner', at: new Date(base).toISOString(), text: 'synthetic stuck', attachments: [] });
  store.db.prepare('UPDATE inputs SET created=? WHERE id=?').run(base - 500, 'stuck');
  store.set('modelFailures', 3); store.set('feishuDisconnectedAt', base - 500); disk = 0;
  await dog.tick(base + 200);
  assert.equal(f.feishu.messages.length, 5); assert.equal(f.feishu.notifications.length, 5);
  for (let n = 1; n < 6; n++) await dog.tick(base + 200 + n);
  assert.equal(f.feishu.messages.length, 5); assert.equal(f.feishu.notifications.length, 5);
  store.set('modelFailures', 0); await dog.tick(base + 210);
  assert.equal(f.feishu.notifications.filter(n => n.state === 'recovery').length, 1);
  assert.equal(f.feishu.notifications.find(n => n.state === 'recovery').fault, 'model');
  await atomicJson(join(f.config.dataDir, 'heartbeat.json'), { at: base + 220 });
  await dog.tick(base + 225); assert.equal(f.feishu.notifications.filter(n => n.state === 'recovery').length, 2);
  // Other unresolved faults remain active when the main process is back.
  store.finish('stuck'); store.set('feishuDisconnectedAt', null); disk = 1000; await dog.tick(base + 226);
  assert.equal(f.feishu.notifications.filter(n => n.state === 'recovery').length, 5);
  await dog.tick(base + 227); assert.equal(f.feishu.messages.length, 10);
  assert.equal(f.model.requests.length, 0);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind<>'input'").get()!.n), 0);
  assert.equal(f.feishu.notifications.some(n => /heartbeat|router|langgraph|sqlite|api/i.test(n.title)), false);
});

test('fault recurs by updating the same Feishu message; persisted state suppresses restart repeats', async t => {
  const { f, store, channel, base } = await setup(); t.after(() => f.close()); t.after(() => store.close());
  await atomicJson(join(f.config.dataDir, 'heartbeat.json'), { at: base - 1000 });
  let dog = new Watchdog(f.config, channel, async () => 1000); await dog.start();
  const original = f.feishu.messages[0]!.id;
  await dog.stop(); dog = new Watchdog(f.config, channel, async () => 1000); t.after(() => dog.stop()); await dog.start();
  assert.equal(f.feishu.messages.length, 1); assert.equal(f.feishu.notifications.length, 1);
  await atomicJson(join(f.config.dataDir, 'heartbeat.json'), { at: base + 210 }); await dog.tick(base + 215);
  await dog.tick(base + 500);
  assert.equal(f.feishu.messages.find(m => m.id === original)?.updates?.length! >= 1, true);
  assert.equal(f.feishu.messages.filter(m => m.key.includes(':heartbeat:fault:')).length, 1);
});

test('failed remote send retries only remote destination, does not repeat successful local notice', async t => {
  const { f, store, channel, base } = await setup(); t.after(() => f.close()); t.after(() => store.close());
  let failed = false;
  const unreliable: Channel = { ...channel, async send(text, key) { if (!failed) { failed = true; throw new Error('synthetic connection failure'); } return channel.send(text, key); } };
  const dog = new Watchdog(f.config, unreliable, async () => 1000); t.after(() => dog.stop()); await dog.start();
  await dog.tick(base + 200); assert.equal(f.feishu.notifications.length, 1); assert.equal(f.feishu.messages.length, 0);
  await dog.tick(base + 201); assert.equal(f.feishu.notifications.length, 1); assert.equal(f.feishu.messages.length, 1);
});

test('R2 A4: configuration alert stays once alongside independent disk fault and recovery', async t => {
  const f = await fixture(); t.after(() => f.close());
  await writeFile(f.configPath, JSON.stringify({ ...f.raw, pi: { readPaths: [f.project] }, watchdog: { ...f.raw.watchdog, pollMs: 100000, minDiskBytes: 100 } }));
  let cause = '';
  await assert.rejects(loadConfig(f.configPath), error => { assert.ok(error instanceof Error); assert.match(error.message, /pi.readPaths/); cause = error.message; return true; });
  const config = await loadNotificationConfig(f.configPath); let disk = 0;
  const dog = new Watchdog(config, await makeChannel(config), async () => disk, cause); t.after(() => dog.stop()); await dog.start();
  const messages = (fault: string, state = 'fault') => f.feishu.messages.filter(m => m.key.startsWith(`watchdog:${fault}:${state}:`));
  const notifications = (fault: string, state = 'fault') => f.feishu.notifications.filter(n => n.fault === fault && n.state === state);
  assert.equal(messages('configuration').length, 1); assert.equal(notifications('configuration').length, 1); assert.match(messages('configuration')[0]!.text, /pi.readPaths/);
  assert.equal(messages('disk').length, 1); assert.equal(notifications('disk').length, 1);
  assert.equal(f.feishu.messages.length, 2, 'the other legitimate fault is not suppressed');
  const configurationId = messages('configuration')[0]!.id;
  await dog.tick(); await dog.tick();
  assert.equal(messages('configuration').length, 1); assert.equal(notifications('configuration').length, 1); assert.equal(messages('disk').length, 1); assert.equal(notifications('disk').length, 1);
  disk = 1000; await dog.tick(); await dog.tick();
  assert.equal(messages('disk', 'recovery').length, 1); assert.equal(notifications('disk', 'recovery').length, 1);
  assert.equal(messages('configuration').length, 1); assert.equal(messages('configuration')[0]!.id, configurationId); assert.equal(notifications('configuration').length, 1);
  assert.equal(messages('configuration', 'recovery').length, 0); assert.equal(notifications('configuration', 'recovery').length, 0);
  assert.equal(f.feishu.messages.length, 3); assert.equal(f.feishu.notifications.length, 3);
  assert.equal((await readdir(config.dataDir)).includes('state.sqlite'), false); assert.equal(f.model.requests.length, 0);
});
