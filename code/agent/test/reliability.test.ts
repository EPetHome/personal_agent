import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, until } from './helpers.js';
import { PNG, JPEG, DOCX, XLSX, zip, pdfFixture } from './reliability-fixtures.js';
import { Store } from '../src/store.js';
import { Files } from '../src/files.js';
import { ScopedFiles } from '../src/file-policy.js';
import { SafeError } from '../src/errors.js';
import { loadConfig, loadNotificationConfig } from '../src/config.js';
import { loopPlan } from '../src/loop.js';
import { prepareAttachments, makeChannel } from '../src/channel.js';
import { hash, canonical, sleep } from '../src/util.js';
import type { Input, TaskCard } from '../src/types.js';
import type { WorkerAdapter, WorkerRequest } from '../src/worker.js';
import type { Script } from '../src/stubs/servers.js';

const taskArgs = { taskId: 'material-read', project: 'p', worker: 'pi', title: '材料核对', goal: '读取授权项目中的构造文本', completion: '交回构造标识及来源，不修改文件', boundary: '只读已授权目录，不执行命令、不联网', prompt: '读取构造文本并报告来源', options: '{"type":"read"}', instructionInput: 'feishu:{{text}}', instruction: '{{text}}' };
const author = (id: string, text: string): Input => ({ id, source: 'feishu', who: 'owner', chatType: 'p2p', messageId: id, at: new Date().toISOString(), text, attachments: [] });
async function setScript(f: Awaited<ReturnType<typeof fixture>>, script: Script) { await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify(script) }); }
function piNoEffect(app: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['start']>>) {
  let calls = 0;
  const original = app.router.workers.pi;
  const adapter: WorkerAdapter = { kind: 'pi', status: original.status.bind(original), progress: original.progress.bind(original), ask: original.ask.bind(original), result: original.result.bind(original), reply: original.reply.bind(original), stop: original.stop.bind(original),
    async dispatch() { calls++; return { status: 'sent', reason: '构造 worker 收到派单；尚非业务完成' }; } };
  app.router.workers.adapters.set('pi', adapter);
  return { adapter, calls: () => calls };
}

for (const [format, bytes, mime, suffix] of [['PNG', PNG, 'image/png', '.png'], ['JPEG', JPEG, 'image/jpeg', '.jpg']]) test(`A1: ${format} post text/image deduplicates v1/v2, content type persists through restart`, async t => {
  const f = await fixture({ flow: [{ tools: [{ name: 'read_image', arguments: { path: '{{attachment0}}' } }] }, { text: '已查看构造图文' }] }); t.after(() => f.close());
  let app = await f.start(); f.feishu.assets['fixture-image'] = bytes!;
  const content = [[{ tag: 'img', image_key: 'fixture-image', width: 100, height: 100 }, { tag: 'text', text: '请查看样例图片', style: [] }]];
  await f.inject({ event_id: 'post', sender: { sender_id: { open_id: 'owner' } }, message: { message_id: 'post-message', chat_type: 'p2p', message_type: 'post', content: JSON.stringify({ title: '构造标题', content, content_v2: content }) } });
  await until(() => app.store.row('feishu:post')?.state === 'done');
  const input = app.store.row('feishu:post')!.input, attachment = input.attachments[0]!;
  assert.equal(input.text, '构造标题\n请查看样例图片'); assert.equal(input.attachments.length, 1); assert.equal(attachment.mime, mime); assert.ok(attachment.path!.endsWith(suffix!)); assert.equal((await readdir(f.config.attachmentDir)).length, 1);
  assert.deepEqual(await readFile(attachment.path!), Buffer.from(bytes!, 'base64'));
  assert.ok(f.model.requests[1].body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((v: any) => v.type === 'image_url' && v.image_url.url.startsWith(`data:${mime};base64,`))));
  const path = attachment.path!; await f.stop(); app = await f.start();
  const read = await app.router.files.read(path, [], false, 0, 1, true); assert.ok(read.ok && 'mime' in read); assert.equal(read.mime, mime);
  await f.inject({ id: 'standalone', attachment: { kind: 'image', key: 'standalone-asset', contentBase64: bytes } }); await until(() => app.store.row('feishu:standalone')?.state === 'done');
  assert.equal(app.store.row('feishu:standalone')!.input.attachments[0]!.mime, mime);
});

test('A1 safety: unsupported image is explicit; corrected suffix never drops original-name blacklist or restart provenance', async t => {
  const f = await fixture({ flow: [{ text: '附件已登记' }] }); t.after(() => f.close()); let app = await f.start();
  f.feishu.assets['blocked'] = JPEG;
  await f.inject({ event_id: 'blocked', sender: { sender_id: { open_id: 'owner' } }, message: { message_id: 'blocked', chat_type: 'p2p', message_type: 'post', content: JSON.stringify({ title: '', content: [[{ tag: 'img', image_key: 'blocked', file_name: '.env' }]] }) } });
  await f.inject({ id: 'unknown-image', attachment: { kind: 'image', key: 'unknown', content: 'not an image' } });
  await until(() => app.store.row('feishu:unknown-image')?.state === 'done');
  const blocked = app.store.row('feishu:blocked')!.input.attachments[0]!, unknown = app.store.row('feishu:unknown-image')!.input.attachments[0]!;
  assert.equal(blocked.originalName, '.env'); assert.match(blocked.error!, /黑名单/); assert.equal(unknown.mime, undefined); assert.match(unknown.error!, /未识别/);
  await f.stop(); app = await f.start();
  const denied = await app.router.files.read(blocked.path!, [], false, 0, 1, true); assert.ok(!denied.ok); assert.equal(denied.category, 'blacklist');
  const invalid = await app.router.files.read(unknown.path!, [], false, 0, 1, true); assert.ok(!invalid.ok); assert.equal(invalid.category, 'unsupported_image');
  await f.inject({ id: 'malformed-image', attachment: { kind: 'image', key: 'broken-jpeg', contentBase64: Buffer.from([0xff, 0xd8, ...Array(20).fill(0xff), 0xd9]).toString('base64') } });
  await until(() => app.store.row('feishu:malformed-image')?.state === 'done'); assert.match(app.store.row('feishu:malformed-image')!.input.attachments[0]!.error!, /未识别/);
  // Changing an attachment root into a symlink cannot hot-load a different destination or lose source-name checks.
  const scoped = new ScopedFiles(await app.router.files.policy(f.config.projects[0]!.root));
  await rename(f.config.attachmentDir, `${f.config.attachmentDir}-original`); await symlink(f.config.inboxDirs[0]!, f.config.attachmentDir);
  const escaped = await app.router.files.read(join(f.config.attachmentDir, 'missing.txt'), []); assert.ok(!escaped.ok); assert.equal(escaped.category, 'outside_scope'); await assert.rejects(scoped.read(join(f.config.attachmentDir, 'missing.txt')), /授权范围/);
  let downloads = 0; const channel = await makeChannel(f.config);
  await assert.rejects(prepareAttachments({ ...author('new-image-after-symlink', ''), attachments: [{ kind: 'image', name: 'pixel.image', key: 'synthetic' }] }, f.config, { ...channel, async download() { downloads++; } }, app.store), /越出已加载/); assert.equal(downloads, 0);
});

test('A1 legacy references: MIME correction preserves an already persisted old path as a checked local alias', async t => {
  const f = await fixture(); t.after(() => f.close()); const store = new Store(f.config); t.after(() => store.close());
  await mkdir(f.config.attachmentDir); const old = join(f.config.attachmentDir, 'legacy.png'); await writeFile(old, Buffer.from(JPEG, 'base64'));
  const input = { ...author('old-image', '构造旧引用'), attachments: [{ kind: 'image' as const, key: 'legacy', name: 'old.png', path: old, mime: 'image/png' }] };
  await prepareAttachments(input, f.config, await makeChannel(f.config), store);
  assert.ok(input.attachments[0]!.path!.endsWith('.jpg')); const files = new Files(f.config, store);
  for (const path of [old, input.attachments[0]!.path!]) { const read = await files.read(path, [], false, 0, 1, true); assert.ok(read.ok && 'mime' in read); assert.equal(read.mime, 'image/jpeg'); }
  // Replaying an old checkpoint must not rename the alias on top of its target.
  input.attachments[0]!.path = old; await prepareAttachments(input, f.config, await makeChannel(f.config), store); assert.deepEqual(await readFile(old), Buffer.from(JPEG, 'base64'));
});

test('A2: actual Router lists inbox, classifies directory/missing/outside/blacklist before file probing', async t => {
  const f = await fixture(); t.after(() => f.close()); await writeFile(join(f.inbox, 'visible.txt'), 'VISIBLE'); await writeFile(join(f.inbox, '.env'), 'FORBIDDEN');
  const paths = [f.inbox, join(f.inbox, 'missing.txt'), join(f.root, 'outside.txt'), join(f.inbox, '.env')]; await writeFile(paths[2]!, 'OUTSIDE-NOT-LEAKED');
  await setScript(f, { flow: [{ tools: [{ name: 'list_directory', arguments: { path: f.inbox } }] }, ...paths.map(path => ({ tools: [{ name: 'read_file', arguments: { path } }] })), { text: '分类完毕' }] });
  const app = await f.start(); await f.inject({ id: 'file-tools', text: '看看收件箱的构造文件' }); await until(() => app.store.row('feishu:file-tools')?.state === 'done');
  const tools = f.model.requests.at(-1).body.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
  assert.equal(tools[0].entries.length, 1); assert.match(tools[0].entries[0].path, /visible.txt$/);
  assert.deepEqual(tools.slice(1).map((r: any) => r.category), ['is_directory', 'not_found', 'outside_scope', 'blacklist']);
  assert.equal(JSON.stringify(f.model.requests).includes('OUTSIDE-NOT-LEAKED'), false);
  assert.deepEqual(await app.router.files.read(join(f.root, 'not-created'), []), await app.router.files.read(paths[2]!, []));
});

test('A3: per-turn capability facts use two loaded snapshots, actual tools, final Loop denies and no Pi write dependency', async t => {
  const all: unknown[] = [];
  for (let n = 0; n < 2; n++) {
    const f = await fixture(); t.after(() => f.close()); const workspace = join(await canonical(f.root), 'workspace');
    await mkdir(join(f.project, `sub-${n}`));
    const raw = { ...f.raw, projects: [{ id: `project-${n}`, root: f.project, loopRunDirs: [f.run], pi: { writeDirs: [], skills: {} }, loop: { batchDir: join(f.project, `sub-${n}`), workspace, workspaceName: 'dev', allow: ['code/'], deny: [`code/deny-${n}/`] } }] };
    await writeFile(f.configPath, JSON.stringify(raw)); const config = await loadConfig(f.configPath); Object.assign(f.config, config);
    const app = await f.start(); await f.inject({ id: 'capabilities', text: '我的范围是什么' }); await until(() => app.store.row('feishu:capabilities')?.state === 'done');
    const facts = JSON.parse(f.model.requests[0].body.messages.find((m: any) => { try { return JSON.parse(m.content).type === '任务表'; } catch { return false; } }).content).capabilities;
    assert.equal(facts.read.projects[0].id, `project-${n}`); assert.deepEqual(facts.read.inboxes, f.config.inboxDirs); assert.equal(facts.read.attachments, f.config.attachmentDir); assert.deepEqual(facts.read.evidence[0].registeredRunDirs, f.config.projects[0]!.loopRunDirs);
    assert.ok(facts.tools.includes('list_directory')); assert.ok(facts.documents.formats.includes('DOCX 正文/表格')); assert.equal(facts.loop.independentOfPiWriteDirs, true); assert.deepEqual(facts.write.projects[0].writeDirs, []); assert.deepEqual(facts.write.projects[0].skills, {});
    assert.ok(facts.loop.projects[0].scope.deny.includes('.autoreview.json')); assert.ok(facts.loop.projects[0].scope.deny.includes('wiki/')); assert.ok(facts.loop.projects[0].scope.deny.includes(`code/deny-${n}/`)); assert.match(facts.loop.sensing.join(), /不主动通知/); assert.match(facts.loop.sensing.join(), /尚无独立/);
    assert.equal(JSON.stringify(facts).includes(f.config.model.auth.path), false);
    await writeFile(f.configPath, JSON.stringify({ ...raw, inboxDirs: [] }));
    await f.inject({ id: 'no-hot-load', text: '再问一次范围' }); await until(() => app.store.row('feishu:no-hot-load')?.state === 'done'); assert.ok(JSON.stringify(f.model.requests.at(-1).body.messages).includes(f.config.inboxDirs[0]!));
    all.push(facts);
  }
  assert.notDeepEqual(all[0], all[1]);
});

for (const bad of ['readPaths', 'outside-write']) test(`A4: ${bad} stops main but watchdog independently reports safe cause once`, async t => {
  const f = await fixture(); t.after(() => f.close());
  const raw = bad === 'readPaths' ? { ...f.raw, pi: { readPaths: [f.project] } } : { ...f.raw, projects: [{ id: 'p', root: f.project, loopRunDirs: [f.run], pi: { writeDirs: [f.inbox], skills: {} } }] };
  await writeFile(f.configPath, JSON.stringify(raw)); await assert.rejects(loadConfig(f.configPath), bad === 'readPaths' ? /pi.readPaths/ : /授权项目内/); await loadNotificationConfig(f.configPath);
  const run = (name: string) => { const child = spawn(process.execPath, [resolve(`dist/src/${name}.js`), '--config', f.configPath], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b); const ended = new Promise<number | null>(resolve => child.once('close', resolve)); return { child, ended, output: () => output }; };
  const main = run('main'); assert.equal(await main.ended, 1); assert.match(main.output(), bad === 'readPaths' ? /pi.readPaths/ : /授权项目内/);
  const dog = run('watchdog-main'); t.after(async () => { if (dog.child.exitCode === null) dog.child.kill('SIGTERM'); await dog.ended; });
  // Fault classes are independent: a valid disk alert must not make this
  // configuration-specific check wait forever or look like a duplicate.
  const configurationMessages = () => f.feishu.messages.filter(m => m.key.startsWith('watchdog:configuration:fault:'));
  const configurationNotifications = () => f.feishu.notifications.filter(n => n.fault === 'configuration' && n.state === 'fault');
  await until(() => dog.output().includes('"ready":true') && configurationMessages().length === 1 && configurationNotifications().length === 1);
  await sleep(150); assert.equal(configurationMessages().length, 1); assert.match(configurationMessages()[0]!.text, bad === 'readPaths' ? /pi.readPaths/ : /授权项目内/); assert.equal(configurationNotifications().length, 1);
  assert.equal((await readdir(f.config.dataDir)).includes('state.sqlite'), false, 'dog did not open old business DB writable');
  dog.child.kill('SIGTERM'); await dog.ended;
});

test('A4 negative: unusable notification configuration leaves explicit local failure, never claims a Feishu alert', async t => {
  const f = await fixture(); t.after(() => f.close()); await writeFile(f.configPath, JSON.stringify({ ...f.raw, feishu: { mode: 'fake', userId: '', url: f.feishu.url }, pi: { readPaths: [] } }));
  let output = ''; const child = spawn(process.execPath, [resolve('dist/src/watchdog-main.js'), '--config', f.configPath], { stdio: ['ignore', 'pipe', 'pipe'] }); child.stderr.on('data', b => output += b);
  await new Promise<void>(resolve => child.once('close', () => resolve())); assert.equal(child.exitCode, 1); assert.match(output, /未确认飞书告警/); assert.equal(f.feishu.messages.length, 0);
});

test('A5/A6: shared Router/Pi reader extracts DOCX paragraphs/table and ordered PDF pages; rejects binary/corrupt/scanned/resource-limit controls', async t => {
  const f = await fixture(); t.after(() => f.close()); const store = new Store(f.config); t.after(() => store.close()); const files = new Files(f.config, store);
  const source = { 'body.docx': DOCX, 'damaged.docx': DOCX.subarray(0, DOCX.length - 10), 'book.xlsx': XLSX, 'renamed.txt': XLSX, 'ordinary.zip': zip({ 'a.txt': 'NOT-A-DOCX' }), 'text.pdf': pdfFixture(), 'scan.pdf': pdfFixture(true, 1), 'plain.txt': Buffer.from('NORMAL-UTF8-构造文本') };
  for (const [name, bytes] of Object.entries(source)) await writeFile(join(f.inbox, name), bytes);
  const docx = await files.read(join(f.inbox, 'body.docx'), []); assert.ok(docx.ok); assert.match(docx.content, /BODY-构造段落[\s\S]*CELL-A[\s\S]*CELL-B[\s\S]*TAIL-顺序/);
  const pdf = await files.read(join(f.inbox, 'text.pdf'), []); assert.ok(pdf.ok && 'pages' in pdf); assert.equal(pdf.pages, 2); assert.match(pdf.content, /PAGE-1-FIRST[\s\S]*PAGE-1-SECOND[\s\S]*PAGE-2-FIRST/);
  const partial = await files.read(join(f.inbox, 'text.pdf'), [], false, 0, 40); assert.ok(partial.ok); assert.equal(partial.truncated, true);
  for (const [name, category] of [['damaged.docx', 'parse_failed'], ['book.xlsx', 'unsupported_format'], ['renamed.txt', 'unsupported_format'], ['ordinary.zip', 'unsupported_format'], ['scan.pdf', 'no_text']]) { const result = await files.read(join(f.inbox, name!), []); assert.ok(!result.ok, name); assert.equal(result.category, category, name); }
  const scoped = new ScopedFiles(await files.policy(f.project)); const piDoc = await scoped.read(join(f.inbox, 'body.docx')); assert.match(piDoc.content, /BODY-构造段落/); await assert.rejects(scoped.read(join(f.inbox, 'book.xlsx')), /不支持/);
  const plain = await files.read(join(f.inbox, 'plain.txt'), []); assert.ok(plain.ok); assert.equal(plain.content, 'NORMAL-UTF8-构造文本');
  await writeFile(join(f.inbox, 'too-large.pdf'), pdfFixture(false, 101)); const large = await files.read(join(f.inbox, 'too-large.pdf'), []); assert.ok(!large.ok); assert.equal(large.category, 'resource_limit');
  for (const [name, bytes] of Object.entries(source)) assert.equal(hash(await readFile(join(f.inbox, name))), hash(bytes));
  assert.equal((await readdir(f.inbox)).filter(name => name.endsWith('.txt')).length, 2, 'no extracted TXT artifact');
});

test('A5/A6 controls: deflated DOCX, ZIP limits/encryption flags, renamed legacy/binary and UTF-8 continuation stay bounded and honest', async t => {
  const f = await fixture(); t.after(() => f.close()); const store = new Store(f.config); t.after(() => store.close()); const files = new Files(f.config, store);
  const doc = zip({ '[Content_Types].xml': '<Types>application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml</Types>', 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DEFLATED-构造</w:t></w:r></w:p></w:body></w:document>' }, true);
  await writeFile(join(f.inbox, 'deflated.docx'), doc); const result = await files.read(join(f.inbox, 'deflated.docx'), []); assert.ok(result.ok); assert.match(result.content, /DEFLATED-构造/);
  const central = DOCX.indexOf(Buffer.from('504b0102', 'hex')), oversized = Buffer.from(DOCX), encrypted = Buffer.from(DOCX);
  oversized.writeUInt32LE(64 * 1024 * 1024, central + 24); encrypted.writeUInt16LE(1, central + 8);
  for (const [name, bytes, category] of [['oversized.docx', oversized, 'resource_limit'], ['encrypted-flag.docx', encrypted, 'protected_document'], ['renamed.docx', Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]), 'unsupported_format']] as const) {
    await writeFile(join(f.inbox, name), bytes); const read = await files.read(join(f.inbox, name), []); assert.ok(!read.ok); assert.equal(read.category, category);
  }
  await writeFile(join(f.inbox, 'wide.txt'), '构造🙂材料'); let text = '', offset = 0;
  for (let n = 0; n < 10; n++) { const read = await files.read(join(f.inbox, 'wide.txt'), [], false, offset, 1); assert.ok(read.ok && 'nextOffset' in read); text += read.content; if (!read.truncated) break; assert.ok(read.nextOffset > offset); offset = read.nextOffset; }
  assert.equal(text, '构造🙂材料');
  await writeFile(join(f.inbox, 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65)); const huge = await files.read(join(f.inbox, 'huge.txt'), []); assert.ok(!huge.ok); assert.equal(huge.category, 'resource_limit');
});

test('A7: actual HITL route consumes one current owner instruction, records source/task/scope, deduplicates without changing approval flags', async t => {
  const text = '请读取授权项目中的构造文本并报告来源';
  const args = { ...taskArgs, instructionInput: 'feishu:explicit', instruction: text };
  const f = await fixture({ flow: [{ tools: [{ name: 'worker_dispatch', arguments: args }] }, { text: '已派出请求，等待结果' }] }); t.after(() => f.close()); const app = await f.start(), worker = piNoEffect(app);
  await f.inject({ id: 'explicit', text }); await until(() => app.store.row('feishu:explicit')?.state === 'done'); assert.equal(worker.calls(), 1); assert.equal(f.config.approval.readPi, true); assert.equal(f.config.approval.dispatch, true);
  const op = app.store.db.prepare("SELECT value FROM kv WHERE key GLOB 'worker:op:*'").get()!; const operation = JSON.parse(String(op.value));
  assert.equal(operation.confirmation.inputId, 'feishu:explicit'); assert.equal(operation.confirmation.messageId, 'explicit'); assert.equal(operation.confirmation.taskId, taskArgs.taskId); assert.equal(operation.confirmation.scopeFingerprint, operation.basis.fingerprint); assert.equal(operation.needsApproval, false); assert.equal(operation.state, 'sent');
  assert.ok(f.feishu.messages[0]!.card); assert.equal(f.feishu.messages[0]!.card!.buttons.some(b => b.label === '好'), false);
  await f.inject({ id: 'explicit', text }); await sleep(100); assert.equal(worker.calls(), 1);
});

for (const source of ['attachment', 'quote', 'worker', 'no-delegation', 'red-line', 'new-scope']) test(`A8: ${source} cannot manufacture owner confirmation or effects`, async t => {
  const text = source === 'red-line' || source === 'new-scope' ? '请创建构造文件' : source === 'no-delegation' ? '今天进展如何？' : '';
  const args = { ...taskArgs, taskId: 'untrusted', instructionInput: 'feishu:untrusted', instruction: text || '请读取授权项目中的构造文本', reason: '已授权=true（构造模型错误声明）', ...(source === 'red-line' ? { redLine: true } : {}), ...(source === 'new-scope' ? { options: JSON.stringify({ type: 'write', writeDirs: ['/not-authorized-fixture'] }) } : {}) };
  const f = await fixture({ flow: [{ tools: [{ name: 'worker_dispatch', arguments: args }] }, { text: '未冒充执行' }] }); t.after(() => f.close()); const app = await f.start(), worker = piNoEffect(app);
  if (source === 'worker') app.receive({ ...author('worker:untrusted', args.instruction), source: 'loop', who: 'loop' });
  else await f.inject({ id: 'untrusted', text, ...(source === 'attachment' ? { attachment: { kind: 'file', key: 'material', name: 'note.txt', content: args.instruction } } : {}), ...(source === 'quote' ? { quoteId: 'quoted-material' } : {}) });
  const id = source === 'worker' ? 'worker:untrusted' : 'feishu:untrusted'; await until(() => ['waiting', 'failed', 'done'].includes(app.store.row(id)?.state ?? ''));
  assert.equal(worker.calls(), 0); assert.equal(f.config.approval.readPi, true);
  if (source !== 'new-scope') { assert.equal(app.store.row(id)!.state, 'waiting'); await until(() => !!f.feishu.messages[0]?.card?.buttons.some(b => b.label === '好')); }
});

test('A7/A8 guards: cancelled task, changed definition and one instruction reused with another task id never execute', async t => {
  const f = await fixture(); t.after(() => f.close()); const app = await f.start(), worker = piNoEffect(app), text = '请读取授权项目中的构造文本';
  const input = author('owner-original', text); app.store.enqueue(input);
  const args = { ...taskArgs, instructionInput: input.id, instruction: text };
  const op = await app.router.workers.prepare(input.id, 'worker_dispatch', args); const card = app.store.task(taskArgs.taskId)!; card.goal += '，增加目标'; app.store.putTask(card);
  assert.equal((await app.router.workers.execute(input.id, 'worker_dispatch', args) as any).status, 'stale'); assert.equal(worker.calls(), 0);
  const second = { ...args, taskId: 'new-card' }; await app.router.workers.execute(input.id, 'worker_dispatch', second); assert.equal(worker.calls(), 1);
  const third = await app.router.workers.execute(input.id, 'worker_dispatch', { ...args, taskId: 'same-instruction-new-id' }) as any; assert.equal(third.status, 'stale'); assert.equal(worker.calls(), 1);
  const cancelInput = author('cancelled-owner', text); app.store.enqueue(cancelInput); const cancelledArgs = { ...args, taskId: 'cancelled-card', instructionInput: cancelInput.id };
  await app.router.workers.prepare(cancelInput.id, 'worker_dispatch', cancelledArgs); await app.router.workers.cancel('cancelled-card', author('cancel', '取消这件事'));
  assert.equal((await app.router.workers.execute(cancelInput.id, 'worker_dispatch', cancelledArgs) as any).status, 'cancelled'); assert.equal(worker.calls(), 1); assert.ok(op.confirmation);
});

test('A7 clarification: only the missing project can supplement a recorded owner directive, without another approval', async t => {
  const text = '请读取构造文本并报告来源';
  const original = { ...taskArgs, project: '', instructionInput: 'feishu:missing-project', instruction: text };
  const f = await fixture({ turns: [[{ tools: [{ name: 'worker_dispatch', arguments: original }] }, { text: '请只告诉我项目 ID' }], [{ tools: [{ name: 'worker_dispatch', arguments: { ...original, project: 'p' } }] }, { text: '已按原任务派出' }]] });
  t.after(() => f.close()); const app = await f.start(), worker = piNoEffect(app);
  await f.inject({ id: 'missing-project', text }); await until(() => app.store.row('feishu:missing-project')?.state === 'done'); assert.equal(worker.calls(), 0);
  await f.inject({ id: 'project-answer', text: 'p' }); await until(() => app.store.row('feishu:project-answer')?.state === 'done'); assert.equal(worker.calls(), 1);
  const row = app.store.db.prepare("SELECT value FROM kv WHERE key GLOB 'worker:op:*'").get()!; const op = JSON.parse(String(row.value)); assert.equal(op.confirmation.inputId, 'feishu:missing-project'); assert.equal(op.confirmation.clarifiedBy.inputId, 'feishu:project-answer'); assert.equal(op.needsApproval, false);
});

test('A9: real installed Loop pure parser/preflight accepts generated plan, discovers exact criteria/model source and permits only result/metadata in docs', async t => {
  const f = await fixture(); t.after(() => f.close()); const project = f.config.projects[0]!, workspace = join(await canonical(f.root), 'workspace');
  const git = (...args: string[]) => execFileSync('git', ['-C', f.project, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { stdio: 'pipe' });
  await writeFile(join(f.project, '.autoreview.json'), JSON.stringify({ workspaces: { dev: workspace }, gate: { cmd: 'true', timeoutMin: 1 }, acceptance: {} })); git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'synthetic only');
  project.loop = { batchDir: join(project.root, 'docs/batches'), workspace, workspaceName: 'dev', allow: ['code/'], deny: ['code/private/'] };
  const request: WorkerRequest = { id: 'a'.repeat(48), taskId: 'official-parse', worker: 'loop', action: 'dispatch', project: 'p', batchFile: '', stage: null, title: '构造任务', goal: '修改构造 README', completion: '构造 README 符合目标、门禁通过、评审无必修', boundary: '只改 code/，不合入不推送', prompt: '修改构造标题', text: '', mode: 'resume', redLine: false, options: {} };
  const generated = loopPlan(project, request); await mkdir(generated.dir, { recursive: true }); await writeFile(generated.prompt, generated.body); await writeFile(generated.file, JSON.stringify(generated.plan));
  const loop = '/Users/Admin/Desktop/loop';
  const script = `import {parsePlan,DEFAULT_PI} from ${JSON.stringify(`${loop}/pipeline.ts`)}; import {checkBatchConfiguration} from ${JSON.stringify(`${loop}/preflight.ts`)}; import {extractCriteria} from ${JSON.stringify(`${loop}/acceptance-core.ts`)}; import {inScope} from ${JSON.stringify(`${loop}/scope.ts`)}; import {readFileSync} from 'node:fs'; import {dirname} from 'node:path'; const file=process.argv[1],root=process.argv[2]; const plan=parsePlan(JSON.parse(readFileSync(file,'utf8')),dirname(file),process.env,{projectRoot:root,batchFile:file}); const stage=plan.stages.get('开发'); console.log(JSON.stringify({checks:checkBatchConfiguration(plan,root),criteria:extractCriteria(readFileSync(stage.prompt,'utf8')),start:stage.start,workflow:stage.workflow,defaultPi:DEFAULT_PI,allowed:stage.scope.allow.map(p=>[p,inScope(p,stage.scope)]),docsOther:inScope('docs/other.md',stage.scope),rules:inScope('AGENTS.md',stage.scope)}));`;
  const parsed = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, generated.file, f.project], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(f.root, 'isolated-home') }, maxBuffer: 1024 * 1024 }));
  assert.ok(parsed.checks.every((c: any) => c.ok), JSON.stringify(parsed.checks)); assert.equal(parsed.workflow, 'with-acceptance'); assert.equal(parsed.criteria.length, 1); assert.ok(parsed.criteria[0].text.includes(request.completion)); assert.ok(parsed.start.includes(parsed.defaultPi.model)); assert.equal(parsed.docsOther, false); assert.equal(parsed.rules, false); assert.ok(parsed.allowed.every((p: any[]) => p[1])); assert.equal(generated.plan.stages.开发.acceptance.guide, './提示词.md'); assert.match(generated.body, /DEFAULT_PI/);
  t.diagnostic(`official Loop pure parse: ${JSON.stringify({ model: parsed.defaultPi.model, thinking: parsed.defaultPi.thinking, workflow: parsed.workflow, criteria: parsed.criteria.length, resultAndMetadataAllowed: parsed.allowed.every((p: any[]) => p[1]), otherDocsAllowed: parsed.docsOther })}`);
  assert.equal(git('branch', '--list').toString().trim(), '* main', 'no development branch/session was opened');
  project.loop.deny.push('docs/'); assert.throws(() => loopPlan(project, request), /deny.*结果/);
});

for (const kind of ['known', 'unknown']) test(`A10: ${kind} causes survive Router tool wrapper and execute-before-check; unsafe exception never leaks`, async t => {
  const f = await fixture({ flow: [{ tools: [{ name: 'worker_status', arguments: { id: 'missing' } }] }, { tools: [{ name: 'worker_dispatch', arguments: { ...taskArgs, instructionInput: '', instruction: '' } }] }, { text: '按工具结果交代' }] }); t.after(() => f.close()); f.config.approval.readPi = false;
  const app = await f.start(); const error = kind === 'known' ? new SafeError('scope_conflict', '构造范围冲突，未执行。') : new Error('SYNTHETIC_CREDENTIAL=DO_NOT_LEAK\nSTACK-BODY');
  app.router.workers.status = async () => { throw error; };
  let checks = 0, effects = 0;
  app.router.workers.adapters.set('pi', { kind: 'pi', async status() { if (++checks > 1) throw error; return { state: 'idle', fingerprint: 'frozen', data: {} }; }, async dispatch() { effects++; return { status: 'sent', reason: 'unexpected' }; } } as unknown as WorkerAdapter);
  await f.inject({ id: 'errors', text: '构造工具错误检查' }); await until(() => app.store.row('feishu:errors')?.state === 'done');
  const results = f.model.requests.at(-1).body.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content)); assert.deepEqual(results.map((r: any) => r.category), [kind === 'known' ? 'scope_conflict' : 'unknown', kind === 'known' ? 'scope_conflict' : 'unknown']); assert.equal(effects, 0);
  const events = app.store.events(0, 50).map(e => e.event).join(); assert.ok(events.includes(kind === 'known' ? 'scope_conflict' : 'unknown')); assert.equal(JSON.stringify(f.model.requests).includes('DO_NOT_LEAK'), false); assert.equal(events.includes('DO_NOT_LEAK'), false);
});

test('A11: very first resumed publish updates original card without stale pause advice/verification, preserves unresolved safety fact', async t => {
  const f = await fixture(); t.after(() => f.close()); const app = await f.start(), project = f.config.projects[0]!.root, batch = join(project, 'batch.json');
  const state = { v: 1, batches: [{ project, batch: { file: batch, name: '恢复构造' }, state: 'paused', next: 'resume', stages: [], events: { lastSeq: 1 } }] }; await writeFile(join(f.root, 'loop.json'), JSON.stringify(state));
  const card: TaskCard = { id: 'resume-card', title: '恢复构造', goal: '构造目标', completion: '构造标准', boundary: '只读验证', status: 'paused', waiting: 'OLD-WAIT', conclusion: 'OLD-CONCLUSION', dispatches: [], updated: new Date().toISOString(), subscriptions: [{ kind: 'loop', value: batch }], worker: { kind: 'loop', project, batchFile: batch }, presentation: { cause: 'OLD-CAUSE', assessment: 'OLD-ASSESSMENT', suggestion: 'OLD-SUGGESTION' }, verified: { event: 'OLD-EVENT', state: 'paused', stage: null, layers: { gate: 'OLD-GATE' }, manual: [], evidence: {}, snapshot: {} } };
  app.store.putTask(card);
  const op = await app.router.workers.prepare('uncertain-pause', 'worker_reply', { taskId: card.id, mode: 'resume', text: '继续' }); op.state = 'uncertain'; app.router.workers.journal.write(op);
  await app.router.workers.messages.publish(card.id, 'seed'); const original = f.feishu.messages[0]!.id;
  state.batches[0]!.state = 'running'; state.batches[0]!.next = ''; state.batches[0]!.events.lastSeq = 2; await writeFile(join(f.root, 'loop.json'), JSON.stringify(state));
  const input: Input = { id: 'loop:resumed-consistent', source: 'loop', who: 'loop', at: new Date().toISOString(), text: '恢复构造事件', attachments: [], project, batchFile: batch, status: 'resumed', raw: { stage: null, seq: 2, detail: {} } };
  assert.equal(await app.router.workers.ingest(input), true); assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 1); assert.equal(f.feishu.messages[0]!.id, original);
  const first = f.feishu.messages[0]!.updates!.at(-1)!; assert.equal(/OLD-/.test(first), false); assert.match(first, /状态 running 已核对/); assert.match(first, /未重新核实/); assert.match(first, /结果仍不确定/); assert.equal(app.router.workers.operation(op.id)!.state, 'uncertain');
});

for (const held of [false, true]) test(`A12: ${held ? 'deferred' : 'unanswered'} pending stays queryable; unrelated questions cannot repeat task cards/requests`, async t => {
  const f = await fixture({ flow: [{ tools: [{ name: 'worker_dispatch', arguments: { ...taskArgs, instructionInput: '', instruction: '' } }] }, { text: '保留待办' }] }); t.after(() => f.close()); const app = await f.start(), worker = piNoEffect(app);
  await f.inject({ id: 'suggestion', text: '有什么可处理的材料？' }); await until(() => app.store.row('feishu:suggestion')?.state === 'waiting' && !!f.feishu.messages[0]?.card?.buttons.some(b => b.label === '好'));
  if (held) { const message = f.feishu.messages[0]!; const button = message.card!.buttons.find(b => b.label === '回电脑再说')!; await f.inject({ id: 'hold', quoteId: message.id, button: { value: button.value } }); await until(() => app.store.row('feishu:hold')?.state === 'done'); }
  const messages = f.feishu.messages.filter(m => m.card).length, updates = f.feishu.messages[0]!.updates?.length ?? 0;
  await setScript(f, { flow: [{ tools: [{ name: 'task_card', arguments: { id: taskArgs.taskId, cause: '旧材料仍待定', assessment: '重复催办对照', suggestion: '请再点一次好' } }] }, { tools: [{ name: 'reply', arguments: { taskId: taskArgs.taskId, text: '旧事项请再决定' } }] }, { tools: [{ name: 'reply', arguments: { text: '只回答当前问题' } }] }, { text: 'done' }] });
  for (let n = 0; n < 2; n++) { await f.inject({ id: `unrelated-${n}`, text: '今天聊什么话题' }); await until(() => app.store.row(`feishu:unrelated-${n}`)?.state === 'done'); }
  assert.equal(f.feishu.messages.filter(m => m.card).length, messages); assert.equal(f.feishu.messages[0]!.updates?.length ?? 0, updates); assert.ok(app.store.task(taskArgs.taskId)); assert.equal(app.store.task(taskArgs.taskId)!.deferred ?? false, held); assert.equal(f.feishu.messages.some(m => m.text === '旧事项请再决定'), false);
  const instruction = '请读取授权项目中的另一份构造文本'; await setScript(f, { flow: [{ tools: [{ name: 'worker_dispatch', arguments: { ...taskArgs, taskId: 'new-explicit', instructionInput: 'feishu:new-explicit', instruction } }] }, { text: '已派出，无需多选' }] });
  await f.inject({ id: 'new-explicit', text: instruction }); await until(() => app.store.row('feishu:new-explicit')?.state === 'done'); assert.equal(worker.calls(), 1); assert.ok(app.store.task(taskArgs.taskId)); assert.ok(!f.feishu.messages.find(m => m.key === 'task-message:new-explicit')!.card!.buttons.some(b => b.label === '好'));
  const result = await app.router.workers.show(taskArgs.taskId, { cause: '本人重新问起', assessment: '待办仍在', suggestion: '可继续原决定' }, author('ask-again', `再看一下 ${taskArgs.taskId}`)); assert.equal(result.ok, true);
  const renewed = '请读取授权项目中的构造文本并报告来源';
  await setScript(f, { flow: [{ tools: [{ name: 'worker_dispatch', arguments: { ...taskArgs, instructionInput: 'feishu:renewed', instruction: renewed } }] }, { text: '按本次明确委托执行，不重问' }] });
  await f.inject({ id: 'renewed', text: renewed }); await until(() => app.store.row('feishu:renewed')?.state === 'done'); assert.equal(worker.calls(), 2);
  assert.equal(app.store.task(taskArgs.taskId)!.deferred ?? false, false); assert.equal(f.feishu.messages.filter(m => m.key === `task-message:${taskArgs.taskId}`).length, 1, 'renewed delegation updates the same card');
});
