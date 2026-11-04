import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { Store } from '../src/store.js';
import { Watchdog } from '../src/watchdog.js';
import { makeChannel, type Channel } from '../src/channel.js';
import { atomicJson } from '../src/util.js';

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
