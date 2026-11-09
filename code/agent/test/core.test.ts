import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { fixture, replyScript, until } from './helpers.js';
import { Store } from '../src/store.js';
import { Files } from '../src/files.js';
import { toWire } from '../src/model.js';
import { sleep } from '../src/util.js';
import type { Input, TaskCard } from '../src/types.js';
import { makeChannel, deliver, normalizeFeishu } from '../src/channel.js';
import { loadConfig } from '../src/config.js';
import { plist } from '../src/launchd.js';
import { PNG } from './reliability-fixtures.js';

const card = (id: string): TaskCard => ({ id, title: id, goal: '构造目标', completion: '构造标准', boundary: '不接真实账号', status: 'running', waiting: '', dispatches: [], conclusion: '', updated: new Date().toISOString(), subscriptions: [] });
const input = (id: string, text = id): Input => ({ id, text, source: 'feishu', who: 'owner', at: new Date().toISOString(), attachments: [] });

test('A1: context order, read-only Loop query, call audit, no chat task', async t => {
  const f = await fixture({ requireReasoning: true, flow: [{ tools: [{ name: 'query_loop' }] }, { tools: [{ name: 'reply', arguments: { text: '现在有 {{loopCount}} 个 Loop 在工作' } }] }, { text: 'done' }] }); t.after(() => f.close());
  const app = await f.start(); await f.inject({ id: 'a1', text: '现在还有几个loop在工作' });
  await until(() => app.store.row('feishu:a1')?.state === 'done');
  assert.equal(f.feishu.messages.length, 1); assert.match(f.feishu.messages[0]!.text, /3/);
  const messages = f.model.requests[0].body.messages;
  assert.equal(messages[0].role, 'system'); assert.equal(JSON.parse(messages[1].content).type, '任务表');
  assert.equal(JSON.parse(messages[2].content).type, '新输入'); assert.equal(app.store.taskTable().length, 0);
  assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='model_call'").get()!.n), 3);
  const audit = app.store.events().find(e => e.event.includes('model_call'))!;
  assert.match(audit.event, /promptVersion/); assert.match(audit.event, /materials/); assert.match(audit.event, /script-model/);
});

test('A2: non-owner and group ignored before Router, attachment download or parsing', async t => {
  const f = await fixture(); t.after(() => f.close()); const app = await f.start();
  await f.inject({ id: 'other', who: 'somebody', text: 'hello', attachment: { kind: 'file', key: 'unauthorized', content: 'fake' } });
  await f.inject({ id: 'group', who: 'owner', chatType: 'group', text: '@PA hello' });
  await until(() => Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='ignored_input'").get()!.n) === 2);
  assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
  assert.deepEqual(await readdir(f.config.attachmentDir).catch(() => []), []);
});

test('A3: attachments outside data, original quote/button and paths kept', async t => {
  const f = await fixture(); t.after(() => f.close()); const app = await f.start();
  await f.inject({ id: 'image', attachment: { kind: 'image', key: 'pixel', name: 'shot.png', contentBase64: PNG } });
  await f.inject({ id: 'file', quoteId: 'quoted', attachment: { kind: 'file', key: 'txt', name: '../note.txt', content: 'a synthetic note' } });
  await until(() => app.store.row('feishu:file')?.state === 'done');
  const attachments = await readdir(f.config.attachmentDir); assert.equal(attachments.length, 2);
  const file = app.store.row('feishu:file')!.input; assert.equal(file.quoteId, 'quoted');
  assert.ok(file.attachments[0]!.path!.startsWith(f.config.attachmentDir + '/'));
  assert.equal(await readFile(file.attachments[0]!.path!, 'utf8'), 'a synthetic note');
  assert.ok(f.model.requests.some(r => JSON.stringify(r.body).includes(file.attachments[0]!.path!)));
  const callback = normalizeFeishu({ header: { event_id: 'click', token: 'SYNTHETIC_TRANSPORT_SECRET' }, event_id: 'click', operator: { open_id: 'owner' }, context: { chat_type: 'p2p', open_message_id: 'quoted' }, action: { value: { action: 'hold', task: 'x' } } }, f.config, app.store)!;
  assert.equal(callback.quoteId, 'quoted'); assert.deepEqual(callback.button, { value: { action: 'hold', task: 'x' } });
  assert.equal(JSON.stringify(callback).includes('SYNTHETIC_TRANSPORT_SECRET'), false);
  assert.ok(app.store.window().filter(w => w.role === 'user').every(w => !w.text.includes('contentBase64')));
});

test('A4: default deny, canonical symlink/.., blacklist inside allowlist, no denied read audit', async t => {
  const f = await fixture(); t.after(() => f.close()); const store = new Store(f.config); t.after(() => store.close()); const files = new Files(f.config, store);
  const outside = join(f.root, 'outside.txt'), ssh = join(f.root, '.ssh'); await mkdir(ssh);
  await writeFile(outside, 'OUTSIDE FIXTURE'); await writeFile(join(ssh, 'id_rsa'), 'FAKE PRIVATE KEY');
  await symlink(join(ssh, 'id_rsa'), join(f.project, 'linked.txt')); await symlink(ssh, join(f.project, 'dir-link'));
  const ordinary = join(f.project, 'ordinary.txt'); await writeFile(ordinary, 'allowed fact');
  const denied = ['.env', '.env.local', 'id_ed25519', 'private.pem', 'cert.crt', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'auth.json', 'my-session.sqlite', 'cookies.db', 'backup/normal.txt', 'eval/cases/item.yaml', 'eval/runs/one.txt', 'eval/待标注/one.txt', '.git/config', '.aws/config'];
  for (const path of denied) { const full = join(f.project, path); await mkdir(join(full, '..'), { recursive: true }); await writeFile(full, 'SECRET FIXTURE'); assert.equal((await files.read(full, [])).ok, false, path); }
  for (const path of [outside, join(f.project, 'linked.txt'), join(f.project, 'dir-link', 'id_rsa'), join(f.project, '..', 'outside.txt'), join(f.config.dataDir, 'state.sqlite'), f.configPath]) assert.equal((await files.read(path, [])).ok, false, path);
  await symlink(ordinary, join(f.project, '.env.pointer')); assert.equal((await files.read(join(f.project, '.env.pointer'), [])).ok, false);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='file_read'").get()!.n), 0);
  const ordinaryRead = await files.read(ordinary, []); assert.ok(ordinaryRead.ok); assert.equal(ordinaryRead.content, 'allowed fact');
  await writeFile(join(f.project, '.env.example'), 'FAKE_CONFIG=example'); assert.equal((await files.read(join(f.project, '.env.example'), [])).ok, true);
});

test('A4 through actual Router tools: first two denied, last file content returned', async t => {
  const f = await fixture(); t.after(() => f.close()); const ssh = join(f.root, '.ssh'); await mkdir(ssh); await writeFile(join(ssh, 'id_rsa'), 'FAKE');
  await symlink(join(ssh, 'id_rsa'), join(f.project, 'link')); await writeFile(join(f.project, 'public.txt'), 'public fact'); await writeFile(join(f.root, 'private.txt'), 'outside fixture');
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [
    { tools: [{ name: 'read_file', arguments: { path: join(f.root, 'private.txt') } }] },
    { tools: [{ name: 'read_file', arguments: { path: join(f.project, 'link') } }] },
    { tools: [{ name: 'read_file', arguments: { path: join(f.project, 'public.txt') } }] }, { tools: [{ name: 'reply', arguments: { text: 'read done' } }] }, { text: 'done' }] }) });
  const app = await f.start(); await f.inject({ id: 'read', text: 'read fixtures' }); await until(() => app.store.row('feishu:read')?.state === 'done');
  const toolReplies = f.model.requests.at(-1).body.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
  assert.equal(toolReplies[0].ok, false); assert.equal(toolReplies[1].ok, false); assert.equal(toolReplies[2].content, 'public fact');
  assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='file_read'").get()!.n), 1);
});

for (const watch of [true, false]) test(`A5: inbox ${watch ? 'native watch' : 'fallback only'} delivers changed file once`, async t => {
  const f = await fixture({ flow: [{ text: 'no need to act' }] }, { intake: { watch, fallbackMs: watch ? 10000 : 100 } }); t.after(() => f.close());
  const app = await f.start(); await writeFile(join(f.inbox, 'note.txt'), 'invented note');
  await until(() => f.model.requests.length === 1, watch ? 8000 : 2000); await sleep(250);
  assert.equal(f.model.requests.length, 1); assert.equal(f.feishu.messages.length, 0); assert.equal(app.store.taskTable().length, 0);
});

test('A8: 30 messages bounded token window, verbatim evicted originals remain in append-only log', async t => {
  const f = await fixture(replyScript, { windowTokens: 2000, checkpointKeep: 3 }); t.after(() => f.close()); const app = await f.start();
  for (let n = 0; n < 30; n++) await f.inject({ id: `window-${n}`, text: `原话 ${n}  \n  空白保留，emoji🙂。` + '构造输入'.repeat(30) });
  await until(() => app.store.row('feishu:window-29')?.state === 'done', 20000);
  assert.ok(app.store.window().reduce((s, w) => s + w.tokens, 0) <= 2000); assert.ok(!app.store.window().some(w => w.text.includes('原话 0 ')));
  for (const request of f.model.requests.filter(r => r.round === 0)) {
    const messages = request.body.messages; const taskIndex = messages.findIndex((m: any) => m.role === 'user' && (() => { try { return JSON.parse(m.content).type === '任务表'; } catch { return false; } })());
    const tokens = messages.slice(1, taskIndex).reduce((s: number, m: any) => s + Buffer.byteLength(m.content) + 8, 0); assert.ok(tokens <= 2000);
  }
  const logfile = join(f.config.dataDir, 'events', (await readdir(join(f.config.dataDir, 'events')))[0]!);
  const log = await readFile(logfile, 'utf8'); assert.ok(log.includes('原话 0  \\n  空白保留')); assert.equal(f.feishu.messages.length, 30);
  const threads = app.router.saver.db.prepare('SELECT COUNT(DISTINCT thread_id) AS n FROM checkpoints').get() as any; assert.ok(threads.n <= 3);
});

test('A10: graceful stop preserves two queued messages, restart answers each once', async t => {
  const f = await fixture({ flow: [{ delayMs: 300, tools: [{ name: 'reply', arguments: { text: '收到：{{text}}' } }] }, { text: 'done' }] }); t.after(() => f.close());
  let app = await f.start(); for (let n = 0; n < 3; n++) await f.inject({ id: `restart-${n}`, text: `message-${n}` });
  await until(() => app.store.pending() === 3 && f.model.requests.length >= 1);
  await f.stop(); assert.equal(f.feishu.messages.length, 1);
  app = await f.start(); await until(() => app.store.row('feishu:restart-2')?.state === 'done');
  assert.equal(f.feishu.messages.length, 3); assert.equal(new Set(f.feishu.messages.map(m => m.text)).size, 3);
  await f.inject({ id: 'restart-2', text: 'message-2' }); await sleep(150); assert.equal(f.feishu.messages.length, 3);
});

test('user queue priority and busy response once after configured threshold', async t => {
  const f = await fixture({ flow: [{ delayMs: 200, tools: [{ name: 'reply', arguments: { text: '{{text}}' } }] }, { text: 'done' }] }, { queue: { busyMs: 40, inputTimeoutMs: 4000, stopMs: 3000 } }); t.after(() => f.close());
  const app = await f.start(); app.receive(input('first'));
  await until(() => f.model.requests.length === 1);
  app.receive({ ...input('worker'), source: 'loop' }); app.receive(input('user-second'));
  await until(() => app.store.row('worker')?.state === 'done');
  const starts = f.model.requests.filter(r => r.round === 0).map(r => JSON.parse(r.body.messages.at(-1).content).id);
  assert.deepEqual(starts, ['first', 'user-second', 'worker']);
  assert.equal(f.feishu.messages.filter(m => m.key === 'first:busy').length, 1);
  assert.equal(f.feishu.messages.filter(m => m.key === 'user-second:busy').length, 1);
});

test('subscriptions update mechanical fields before context; closed search only, chats create nothing', async t => {
  const f = await fixture(); t.after(() => f.close()); const store = new Store(f.config); t.after(() => store.close());
  const task = card('active'); task.subscriptions = [{ kind: 'loop', value: '/fixture/batch.json' }, { kind: 'message', value: 'message-1' }]; store.putTask(task);
  const closed = { ...card('closed-needle'), status: 'closed' }; store.putTask(closed);
  const event = { ...input('event'), source: 'loop' as const, status: 'paused', batchFile: '/fixture/batch.json' };
  assert.equal(store.match(event)[0]!.status, 'running', 'matching alone must not trust an unverified worker event');
  store.recordTaskEvent(task, event, 'paused');
  assert.equal(store.match(event)[0]!.status, 'paused'); assert.equal(store.match(event)[0]!.dispatches.length, 1);
  assert.equal(store.match({ ...input('quote'), quoteId: 'message-1' })[0]!.id, 'active');
  assert.equal(store.taskTable().length, 1); assert.equal(store.searchClosed('needle')[0]!.id, 'closed-needle');
});

test('Loop evidence exact registration and project run directory, blacklisted evidence still denied', async t => {
  const f = await fixture(); t.after(() => f.close()); const store = new Store(f.config); t.after(() => store.close()); const files = new Files(f.config, store);
  const evidence = join(f.run, 'report.txt'), forbidden = join(f.root, 'outside.txt'), secret = join(f.run, 'auth.json');
  await writeFile(evidence, 'synthetic report'); await writeFile(forbidden, 'outside'); await writeFile(secret, 'FAKE');
  assert.equal((await files.read(evidence, [], true)).ok, false);
  await files.registerEvidence(f.project, { report: evidence, malicious: forbidden, secret });
  const evidenceRead = await files.read(evidence, [], true); assert.ok(evidenceRead.ok); assert.equal(evidenceRead.content, 'synthetic report'); assert.equal((await files.read(evidence, [], false)).ok, false);
  assert.equal((await files.read(forbidden, [], true)).ok, false); assert.equal((await files.read(secret, [], true)).ok, false);
});

test('Loop event ingestion is incremental, deduplicated, and source subscription is attached', async t => {
  const f = await fixture({ flow: [{ text: 'quiet event' }] }); t.after(() => f.close()); const app = await f.start();
  const batchFile = join(f.project, 'batch.json'), c = card('sub'); c.subscriptions = [{ kind: 'loop', value: batchFile }]; app.store.putTask(c);
  await writeFile(join(f.root, 'loop.json'), JSON.stringify({ v: 1, at: new Date().toISOString(), batches: [{ project: f.project, batch: { file: batchFile, name: 'b', recipe: 'develop' }, state: 'paused', stages: [{ stage: '甲', state: 'paused' }], evidence: {} }] }));
  const event = { v: 1, id: 'evt1', seq: 1, at: new Date().toISOString(), project: f.project, batch: { file: batchFile, name: 'b', recipe: 'develop' }, stage: '甲', status: 'paused', evidence: {}, detail: {}, reason: { text: 'synthetic paused' } };
  const path = join(f.events, 'stream.jsonl'); await writeFile(path, JSON.stringify(event).slice(0, 20)); await sleep(180); assert.equal(f.model.requests.length, 0);
  await writeFile(path, JSON.stringify(event) + '\n'); await until(() => app.store.row('loop:evt1')?.state === 'done');
  const context = JSON.parse(f.model.requests[0].body.messages.at(-2).content); assert.equal(context.matchedCards[0].status, 'paused');
  await writeFile(path, JSON.stringify(event) + '\n' + JSON.stringify(event) + '\n'); await sleep(250); assert.equal(f.model.requests.length, 1);
});

test('reasoning_content retained on three actual tool rounds (local script only)', async t => {
  const f = await fixture({ requireReasoning: true, flow: [{ tools: [{ name: 'query_loop' }], reasoning_content: 'first' }, { tools: [{ name: 'search_closed_tasks', arguments: { query: 'x' } }], reasoning_content: '' }, { tools: [{ name: 'reply', arguments: { text: 'OK' } }], reasoning_content: 'third' }, { text: 'done' }] }); t.after(() => f.close());
  const app = await f.start(); await f.inject({ id: 'reasoning', text: 'synthetic three rounds' }); await until(() => app.store.row('feishu:reasoning')?.state === 'done');
  assert.equal(f.model.requests.length, 4); const ai = f.model.requests[3].body.messages.filter((m: any) => m.role === 'assistant'); assert.deepEqual(ai.map((m: any) => m.reasoning_content), ['first', '', 'third']);
  assert.equal(toWire(new AIMessage({ content: '', additional_kwargs: { reasoning_content: '' } })).reasoning_content, '');
});

test('uncertain delivery never resent; stable outbox guards replay', async t => {
  const f = await fixture(); t.after(() => f.close()); const store = new Store(f.config); t.after(() => store.close()); const channel = await makeChannel(f.config);
  store.db.prepare('INSERT INTO outbox(id,input_id,text,state) VALUES(?,?,?,?)').run('uncertain', 'i', 'fixture', 'sending');
  assert.equal((await deliver(store, channel, 'i', 'uncertain', 'fixture')).status, 'uncertain');
  await deliver(store, channel, 'i', 'one', 'exact once'); await deliver(store, channel, 'i', 'one', 'exact once'); assert.equal(f.feishu.messages.length, 1);
});

test('model failures accumulate across inputs, no automatic retry, reset only on success', async t => {
  const f = await fixture({ flow: [{ status: 503 }] }); t.after(() => f.close()); const app = await f.start();
  for (let n = 0; n < 3; n++) { await f.inject({ id: `fail-${n}`, text: 'test' }); await until(() => app.store.row(`feishu:fail-${n}`)?.state === 'failed'); }
  assert.equal(app.store.get('modelFailures', 0), 3); assert.equal(f.model.requests.length, 3);
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify(replyScript) }); await f.inject({ id: 'recover', text: 'test' }); await until(() => app.store.row('feishu:recover')?.state === 'done'); assert.equal(app.store.get('modelFailures', 0), 0);
});

test('plain model-authored final text gets one correction into the same reply tool, without keyword routing or raw fallback', async t => {
  const f = await fixture({ flow: [{ text: '未经 reply 的最终文字不会原文发送' }, { tools: [{ name: 'reply', arguments: { text: '今天想随口聊聊也可以。' } }] }, { text: 'done' }] }); t.after(() => f.close());
  const app = await f.start(); await f.inject({ id: 'plain', text: '随口说句话' }); await until(() => app.store.row('feishu:plain')?.state === 'done');
  assert.equal(f.feishu.messages.length, 1); assert.equal(f.feishu.messages[0]!.text, '今天想随口聊聊也可以。'); assert.equal(app.store.taskTable().length, 0);
});

test('image tool delivers visual content to the model, window keeps only attachment path', async t => {
  const f = await fixture({ flow: [{ tools: [{ name: 'read_image', arguments: { path: '{{attachment0}}' } }] }, { tools: [{ name: 'reply', arguments: { text: '已查看构造图片' } }] }, { text: 'done' }] }); t.after(() => f.close());
  const app = await f.start(); const image = PNG;
  await f.inject({ id: 'visual', attachment: { kind: 'image', key: 'pixel', contentBase64: image } }); await until(() => app.store.row('feishu:visual')?.state === 'done');
  const messages = f.model.requests[1].body.messages;
  const result = messages.find((m: any) => m.role === 'tool');
  assert.equal(typeof result.content, 'string'); assert.equal(result.content.includes('base64'), false);
  assert.ok(messages.some((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'image_url' && b.image_url.url === `data:image/png;base64,${image}`)));
  assert.equal(app.store.window().some(w => w.text.includes(image)), false);
});

test('runtime credential loading uses isolated Pi-shaped fixture and never enters logs or tool reads', async t => {
  const f = await fixture(); t.after(() => f.close()); const fakeKey = 'SYNTHETIC_KEY_NOT_A_REAL_SECRET'; const path = join(f.root, 'fake-auth.json');
  await writeFile(path, JSON.stringify({ 'opencode-go': { type: 'api_key', key: fakeKey } }));
  f.config.model.auth = { type: 'pi', path, provider: 'opencode-go', variable: 'UNUSED' };
  const app = await f.start(); await f.inject({ id: 'auth-test', text: 'synthetic credential test' }); await until(() => app.store.row('feishu:auth-test')?.state === 'done');
  assert.equal((await app.router.files.read(path, [])).ok, false);
  const logfile = join(f.config.dataDir, 'events', (await readdir(join(f.config.dataDir, 'events')))[0]!);
  assert.equal((await readFile(logfile, 'utf8')).includes(fakeKey), false);
});

test('configuration safety and generation-only launchd', async t => {
  const f = await fixture(); t.after(() => f.close()); const p = join(f.root, 'invalid.json');
  await writeFile(p, JSON.stringify({ ...f.raw, attachmentDir: join(f.config.dataDir, 'attachments') })); await assert.rejects(loadConfig(p), /附件/);
  await writeFile(p, JSON.stringify({ ...f.raw, model: { url: 'https://external.invalid', auth: { type: 'none' } } })); await assert.rejects(loadConfig(p), /无凭证/);
  assert.match(plist(f.config), /KeepAlive/); assert.match(plist(f.config, true), /watchdog-main.js/); assert.ok(!plist(f.config).includes('launchctl'));
});
