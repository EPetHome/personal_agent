import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, symlink, link, rename, stat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, until } from './helpers.js';
import { DOCX, PNG, XLSX, zip } from './reliability-fixtures.js';
import { scriptModel, type Script } from '../src/stubs/servers.js';
import { ScopedFiles } from '../src/file-policy.js';
import { planOutput, produceOutput, verifyOutput, type OutputOptions } from '../src/outputs.js';
import { extract } from '../src/documents.js';
import { loadConfig } from '../src/config.js';
import { canonical, hash, parseJson } from '../src/util.js';
import { capabilities } from '../src/capabilities.js';
import type { WorkerRequest } from '../src/worker.js';
import type { App } from '../src/app.js';

const exec = promisify(execFile);
const args = (source: string, taskId = 'save', project = 'p') => ({ worker: 'pi', taskId, project, title: '保存构造材料', goal: '保存材料文件', completion: '产物完整且有路径及摘要', boundary: '只新建到 PA产出，不覆盖、不合入、不推送、不联网', prompt: '按固定源生成完整产物', options: JSON.stringify({ type: 'write', output: { kind: 'image', source } }) });
const flow = (a: Record<string, unknown>) => [{ tools: [{ name: 'worker_dispatch', arguments: a }] }, { text: '请求已处理，保存结果以核实回执为准。' }];
const quiet = [{ text: '当前事项结果已收到，以核实记录为准。' }];
const request = (id: string): WorkerRequest => ({ id, taskId: id, worker: 'pi', project: 'p', action: 'dispatch', batchFile: '', stage: null, title: '构造产出', goal: '保存材料', completion: '完整产物', boundary: '只新建', prompt: '保存构造材料', text: '', mode: 'send', redLine: false, options: {} });
async function outputFixture(t: TestContext, script: Script = { flow: quiet }, childScript: Script = { flow: [{ tools: [{ name: 'pa_output' }] }, { text: '{"status":"done","summary":"模型宣称已保存","evidence":[]}' }] }) {
  const f = await fixture(script), model = await scriptModel(childScript);
  const output = join(f.config.projects[0]!.root, 'PA产出'); await mkdir(output);
  f.config.projects[0]!.pi = { writeDirs: [output], skills: {} }; f.config.outputs = { otherProject: 'p' };
  Object.assign(f.config.pi, { command: 'pi', args: [], model: { url: `${model.url}/v1`, name: 'script-model' }, pollMs: 50, startupMs: 1500, timeoutMs: 18000 });
  let app: App | undefined;
  const start = async () => app = await f.start();
  t.after(async () => {
    try {
      if (app) {
        for (const job of app.router.workers.pi.jobs().filter(j => ['queued', 'launching', 'running'].includes(j.state))) await app.router.workers.pi.stop({ ...job.request, batchFile: job.id, action: 'stop' });
        await until(async () => { await app!.router.workers.pi.tick(); return app!.router.workers.pi.jobs().every(j => !['queued', 'launching', 'running'].includes(j.state)); }, 10000);
      }
    } finally { await f.close(); await model.close(); }
  });
  const done = async (id: string, state = 'done') => {
    try { await until(() => app?.store.task(id)?.status === state, 18000); }
    catch { assert.fail(JSON.stringify({ task: app?.store.task(id), jobs: app?.router.workers.pi.jobs().map(j => ({ state: j.state, result: j.outcome })), messages: f.feishu.messages, tools: app?.store.events(0, 50).filter(e => /tool_result|input_failed/.test(e.event)) })); }
    const job = app!.router.workers.pi.jobs().find(j => j.task === id)!;
    await until(() => app!.store.row(`pi:${job.id}:result`)?.state === 'done', 10000); return app!.router.workers.pi.job(job.id)!;
  };
  return { ...f, output, childModel: model, start, done };
}

async function preparation(t: TestContext) {
  const f = await fixture(); t.after(() => f.close());
  const root = await realpath(f.root), pa = await realpath(f.project), roots = [pa, ...['loop', 'Promate', 'IDaaS'].map(p => join(root, p))];
  for (const p of roots) { await mkdir(p, { recursive: true }); await exec('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', p]); }
  const common = ['scripts/prepare-outputs.mjs', '--config', await realpath(f.configPath), '--pa', roots[0]!, '--loop', roots[1]!, '--promate', roots[2]!, '--idaas', roots[3]!, '--run-root', join(root, 'runs')];
  const run = async (...extra: string[]) => parseJson<any>((await exec(process.execPath, [...common, ...extra])).stdout);
  return { f, roots, root, run, common, backup: join(root, 'prepare-snapshot') };
}

test('A7 preparation: preflight is read-only, apply adds four precise outputs/read/observation grants, not code dispatch; restore preserves products', async t => {
  const p = await preparation(t), before = await readFile(p.f.configPath);
  const preview = await p.run(); assert.equal(preview.mode, 'preflight'); assert.deepEqual(await readFile(p.f.configPath), before);
  for (const root of p.roots) { await assert.rejects(stat(join(root, 'PA产出')), { code: 'ENOENT' }); await assert.rejects(stat(join(root, '.gitignore')), { code: 'ENOENT' }); }
  const applied = await p.run('--apply', '--backup', p.backup); assert.equal(applied.restarted, false);
  const config = await loadConfig(p.f.configPath); assert.equal(config.outputs?.otherProject, 'p'); assert.equal(config.projects.length, 4);
  const app = await p.f.start();
  for (const project of config.projects) {
    assert.deepEqual(project.pi?.writeDirs, [join(project.root, 'PA产出')]); assert.equal(project.loop, undefined);
    assert.equal((await exec('git', ['-C', project.root, 'ls-files', '--', 'PA产出'])).stdout, '');
    assert.match((await exec('git', ['-c', 'core.quotePath=false', '-C', project.root, 'check-ignore', 'PA产出/probe'])).stdout, /PA产出/);
    // Use the newly loaded config snapshot, never broaden the running fixture's grants.
    const { Files } = await import('../src/files.js'); const files = new Files(config, app.store);
    const source = join(project.root, 'source.txt'); await writeFile(source, 'CONSTRUCTED'); assert.equal((await files.read(source, [])).ok, true);
    const scoped = new ScopedFiles(await files.policy(project.root, [join(project.root, 'PA产出')]));
    const product = await scoped.write(join(project.root, 'PA产出', 'verified.txt'), 'CONSTRUCTED OUTPUT'); assert.equal(await readFile(product.path, 'utf8'), 'CONSTRUCTED OUTPUT');
    await assert.rejects(scoped.write(join(project.root, 'code.txt'), 'NO ROOT GRANT'));
    assert.equal(capabilities(config, []).loop.projects.find(p => p.id === project.id)?.dispatch, false);
  }
  const product = join(p.roots[0]!, 'PA产出', 'keep.txt'); await writeFile(product, 'KEEP PRODUCT');
  await exec(process.execPath, ['scripts/prepare-outputs.mjs', '--restore', p.backup]);
  assert.deepEqual(await readFile(p.f.configPath), before); assert.equal(await readFile(product, 'utf8'), 'KEEP PRODUCT');
  await exec(process.execPath, ['scripts/prepare-outputs.mjs', '--restore', p.backup]); // Idempotent recovery.
});

for (const conflict of ['tracked', 'symlink', 'file', 'narrow', 'watch'] as const) test(`A7 preparation fails closed before configuration changes: ${conflict}`, async t => {
  const p = await preparation(t), out = join(p.roots[1]!, 'PA产出');
  if (conflict === 'tracked') { await mkdir(out); await writeFile(join(out, 'already.txt'), 'KEEP'); await exec('git', ['-C', p.roots[1]!, 'add', 'PA产出']); }
  if (conflict === 'symlink') await symlink(p.roots[2]!, out);
  if (conflict === 'file') await writeFile(out, 'KEEP');
  if (conflict === 'narrow' || conflict === 'watch') {
    const raw = parseJson<any>(await readFile(p.f.configPath, 'utf8'));
    if (conflict === 'narrow') raw.readAllow = [p.roots[0]]; else raw.inboxDirs.push(out);
    await writeFile(p.f.configPath, JSON.stringify(raw));
  }
  const before = await readFile(p.f.configPath);
  const expected = { tracked: /已被 Git 跟踪/, symlink: /链接/, file: /类型/, narrow: /readAllow/, watch: /监听/ }[conflict];
  await assert.rejects(p.run('--apply', '--backup', p.backup), (error: any) => expected.test(error.stderr)); assert.deepEqual(await readFile(p.f.configPath), before);
  await assert.rejects(stat(p.backup), { code: 'ENOENT' });
});

test('A7 restore refuses later operator edits, leaves configuration and output data intact', async t => {
  const p = await preparation(t); await p.run('--apply', '--backup', p.backup);
  const ignore = join(p.roots[0]!, '.gitignore'); await writeFile(ignore, '/PA产出/\noperator-change\n'); const before = await readFile(p.f.configPath);
  await assert.rejects(exec(process.execPath, ['scripts/prepare-outputs.mjs', '--restore', p.backup]));
  assert.deepEqual(await readFile(p.f.configPath), before); assert.match(await readFile(ignore, 'utf8'), /operator-change/);
});

test('A7 real message -> original Pi worker -> full long DOCX TXT, collision rejected without overwriting source or first artifact', async t => {
  const f = await outputFixture(t), source = join(f.config.projects[0]!.root, 'long.docx');
  const text = Array.from({ length: 4200 }, (_, n) => `段落-${n}-完整正文-CHINESE`).join('\n');
  const doc = zip({ '[Content_Types].xml': 'wordprocessingml.document.main+xml', 'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split('\n').map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}<w:tbl><w:tr><w:tc><w:p><w:r><w:t>FINAL-CELL</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>` }, true);
  await writeFile(source, doc); const expected = (await extract(doc, source)).text; assert.ok(Buffer.byteLength(expected) > 64000);
  const a = { ...args(source, 'long'), options: JSON.stringify({ type: 'write', output: { kind: 'docx-txt', source, fileName: 'complete.txt' } }), instructionInput: 'feishu:long', instruction: '帮我把长 Word 保存为 TXT 到 p 项目' };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [flow(a), quiet, flow({ ...a, taskId: 'collision', instructionInput: 'feishu:collision', instruction: '帮我把长 Word 保存为 TXT 到 p 项目' }), quiet] }) });
  const app = await f.start(); await f.inject({ id: 'long', text: a.instruction }); const job = await f.done('long');
  const target = join(f.output, 'complete.txt'); assert.equal(await readFile(target, 'utf8'), expected); assert.deepEqual(await readFile(source), doc);
  assert.match(job.outcome!.answer.summary, /已核实保存/); assert.ok(job.outcome!.answer.summary.includes(hash(Buffer.from(expected)))); assert.deepEqual(job.outcome!.answer.evidence, [target]);
  assert.equal(app.store.db.prepare("SELECT 1 FROM inputs WHERE state='waiting'").get(), undefined);
  const tools = parseJson<{ tools: string[] }>(await readFile(join(app.router.workers.pi.dir(job.id), 'ready.json'), 'utf8')).tools;
  assert.ok(tools.includes('pa_output')); for (const tool of ['pa_write', 'pa_edit', 'pa_bash', 'pa_fetch', 'bash']) assert.equal(tools.includes(tool), false);
  await f.inject({ id: 'collision', text: a.instruction }); const failed = await f.done('collision', 'failed');
  assert.match(failed.outcome!.answer.summary, /已存在|不完整/); assert.equal(await readFile(target, 'utf8'), expected); assert.deepEqual(await readFile(source), doc);
  assert.equal(app.store.window().some(m => m.text.includes('FINAL-CELL')), false, 'window retains references, not full extracted body');
});

test('A8 message missing project -> one question/no writes across unrelated input and restart -> explicit no-project answer creates byte-identical other plus provenance', async t => {
  const text = '帮我保存这张图';
  const a = { ...args('{{attachment0}}', 'image', ''), instructionInput: 'feishu:image', instruction: text };
  const f = await outputFixture(t, { turns: [flow(a), quiet] }); let app = await f.start();
  f.feishu.assets.asset = PNG;
  await f.inject({ event_id: 'image', sender: { sender_id: { open_id: 'owner' } }, message: { message_id: 'image-message', chat_type: 'p2p', message_type: 'post', content: JSON.stringify({ title: '', content: [[{ tag: 'text', text }, { tag: 'img', image_key: 'asset', file_name: '原始图片.png' }]] }) } });
  await until(() => app.store.row('feishu:image')?.state === 'done');
  assert.equal(f.feishu.messages.filter(m => m.key === 'output-project:image').length, 1); assert.deepEqual(await readdir(f.output), []); assert.equal(app.router.workers.pi.jobs().length, 0);
  const original = app.store.row('feishu:image')!.input, source = original.attachments[0]!.path!;
  const repeated = { ...args(source, 'new-id-same-material', ''), instructionInput: 'feishu:unrelated', instruction: '现在先聊别的' };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [flow(a), flow(repeated)] }) });
  await f.inject({ id: 'unrelated', text: '现在先聊别的' }); await until(() => app.store.row('feishu:unrelated')?.state === 'done');
  assert.equal(app.store.task('new-id-same-material'), undefined); assert.equal(f.feishu.messages.filter(m => m.key.startsWith('output-project:')).length, 1);
  assert.equal(app.store.task('image')!.status, 'waiting-project'); assert.equal(app.store.task('image')!.outputDraft!.sourceInput, original.id);
  await f.stop(); app = await f.start(); assert.deepEqual(await readdir(f.output), []); assert.equal(f.feishu.messages.filter(m => m.key === 'output-project:image').length, 1);
  const answer = { ...args(source, 'image', 'p'), instructionInput: 'feishu:image', instruction: text, options: JSON.stringify({ type: 'write', output: { kind: 'image', source, placement: 'other' } }) };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [flow(a), quiet, [{ tools: [{ name: 'get_task', arguments: { id: 'image' } }] }, ...flow(answer)], quiet] }) });
  await f.inject({ id: 'other', text: '仍无项目归属' }); const job = await f.done('image');
  const names = await readdir(join(f.output, 'other')); assert.equal(names.length, 2);
  const image = names.find(n => n.endsWith('.png'))!; assert.match(image, /^\d{4}-\d{2}-\d{2}_feishu_/); assert.ok(image.includes('原始图片.png'));
  assert.deepEqual(await readFile(join(f.output, 'other', image)), Buffer.from(PNG, 'base64'));
  const explanation = parseJson<any>(await readFile(join(f.output, 'other', `${image}.说明.txt`), 'utf8'));
  assert.ok(explanation.来源.includes(original.messageId)); assert.equal(explanation.时间, original.at); assert.equal(explanation.原文件名, '原始图片.png'); assert.match(explanation.处理动作, /二进制/); assert.equal(explanation.归入other原因, '仍无项目归属');
  assert.ok(JSON.stringify(f.model.requests).includes('outputDraft'), 'new input can retrieve original output arguments through the task reference');
  assert.equal(job.outcome!.answer.evidence.length, 2); assert.equal(app.store.taskTable().length, 1); assert.equal(app.router.workers.pi.jobs().length, 1);
  const count = f.feishu.messages.length; await f.inject({ id: 'other', text: '仍无项目归属' }); await new Promise(r => setTimeout(r, 100)); assert.equal(f.feishu.messages.length, count);
});

async function missingImage(t: TestContext) {
  const f = await outputFixture(t), source = join(f.config.projects[0]!.root, 'review.png'); await writeFile(source, Buffer.from(PNG, 'base64'));
  const initial = { ...args(source, 'review', ''), instructionInput: 'feishu:original', instruction: '帮我保存图片' };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [flow(initial)] }) });
  const app = await f.start(); await f.inject({ id: 'original', text: initial.instruction }); await until(() => app.store.row('feishu:original')?.state === 'done');
  assert.equal(app.router.workers.pi.jobs().length, 0); assert.deepEqual(await readdir(f.output), []);
  const other = { ...initial, project: 'p', options: JSON.stringify({ type: 'write', output: { kind: 'image', source, placement: 'other' } }) };
  const setTurns = (turns: Script['turns']) => fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns }) });
  const addPromate = async () => {
    const root = join(await realpath(f.root), 'Promate'), output = join(root, 'PA产出'); await mkdir(output, { recursive: true });
    f.config.projects.push({ id: 'Promate', root, loopRunDirs: [], pi: { writeDirs: [output], skills: {} } }); return output;
  };
  return { f, app, source, initial, other, setTurns, addPromate };
}

for (const text of ['仍无项目归属，暂时不保存', '仍无项目归属，先别存', '仍无项目归属，等我确认后再保存', '仍无项目归属，取消保存《取消申请.docx》', '仍无项目归属，以后再保存']) for (const dispatch of [true, false]) test(`R1 output clarification refuses new save deferral with dispatch=${dispatch}: ${text}`, async t => {
  const { f, app, initial, other, setTurns } = await missingImage(t); f.config.approval.dispatch = dispatch;
  await setTurns([flow(initial), flow(other)]); await f.inject({ id: 'defer', text }); await until(() => app.store.row('feishu:defer')?.state === 'done');
  const result = app.store.events(0, 50).map(e => parseJson<any>(e.event)).find(e => e.kind === 'tool_result' && e.data.inputId === 'feishu:defer' && e.data.tool === 'worker_dispatch').data.result;
  assert.equal(result.category, 'deferred'); assert.equal(app.store.get<any>('worker:clarify:review', {}).outputDraft.heldBy, 'feishu:defer');
  assert.equal(app.router.workers.pi.jobs().length, 0); assert.equal(f.childModel.requests.length, 0); assert.deepEqual(await readdir(f.output), []);
  assert.equal(app.store.db.prepare("SELECT 1 FROM kv WHERE key GLOB 'worker:op:*'").get(), undefined, 'deferral never prepares or approves an operation');
  assert.equal(f.feishu.messages.some(m => m.card?.buttons.some(b => b.value.choice === 'approve')), false, 'do not ask again after a refusal');
});

for (const [kind, name, text, confirm] of [
  ['docx-txt', '取消申请.docx', '帮我把《取消申请.docx》转成 TXT，保存到 Promate', false],
  ['docx-txt', '取消申请.docx', '帮我把取消申请.docx转成 TXT，保存到 Promate', false],
  ['image', 'review.png', '帮我保存图片到 Promate，方便以后使用', true],
  ['image', 'review.png', '帮我保存图片到 Promate，用于取消申请', false],
  ['image', 'review.png', '帮我保存图片到 Promate，主题是暂停审批', false],
  ['image', 'review.png', '帮我保存图片到 Promate，说明文字是“暂时不保存”', false],
  ['docx-txt', '申请，暂时不保存，确认.docx', '帮我把申请，暂时不保存，确认.docx转成 TXT，保存到 Promate', false],
] as const) test(`R3 positive output distinguishes material/topic/purpose from a save decision: ${text}`, async t => {
  const f = await outputFixture(t), source = join(f.config.projects[0]!.root, name), root = join(await realpath(f.root), 'Promate'), output = join(root, 'PA产出');
  const bytes = kind === 'docx-txt' ? DOCX : Buffer.from(PNG, 'base64'); await writeFile(source, bytes); await mkdir(output, { recursive: true });
  f.config.projects.push({ id: 'Promate', root, loopRunDirs: [], pi: { writeDirs: [output], skills: {} } });
  const a = { ...args(source, 'positive', 'Promate'), options: JSON.stringify({ type: 'write', output: { kind, source } }), instructionInput: 'feishu:positive', instruction: text };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [flow(a), quiet] }) });
  const app = await f.start(); await f.inject({ id: 'positive', text });
  await until(() => ['waiting', 'done'].includes(app.store.row('feishu:positive')?.state ?? ''));
  const events = app.store.events(0, 50).map(e => parseJson<any>(e.event));
  assert.equal(events.some(e => e.kind === 'output_deferred'), false, 'material/topic words cannot create a deferral fact');
  assert.equal(events.some(e => e.kind === 'tool_result' && e.data.tool === 'worker_dispatch' && e.data.result.category === 'deferred'), false);
  if (confirm) {
    // The existing ordinary-instruction parser conservatively asks about 以后.
    // Keep that confirmation contract; the output guard must not reject it.
    assert.equal(app.store.row('feishu:positive')?.state, 'waiting');
    await until(() => f.feishu.messages.some(m => m.card?.buttons.some(b => b.value.choice === 'approve')));
    const message = f.feishu.messages.find(m => m.card?.buttons.some(b => b.value.choice === 'approve'))!, button = message.card!.buttons.find(b => b.value.choice === 'approve')!;
    assert.equal(app.router.workers.pi.jobs().length, 0); await f.inject({ id: 'confirm-positive', quoteId: message.id, button: { value: button.value } });
  } else assert.equal(app.store.db.prepare("SELECT 1 FROM inputs WHERE state='waiting'").get(), undefined, 'clear ordinary directive keeps its original one-off confirmation');
  const job = await f.done('positive'), target = job.plan.policy.output!.target;
  assert.equal(job.request.project, 'Promate'); assert.equal(target.startsWith(output + '/'), true);
  assert.deepEqual(await readFile(target), kind === 'docx-txt' ? Buffer.from((await extract(bytes, source)).text) : bytes);
  assert.deepEqual(await readFile(source), bytes); assert.deepEqual(await readdir(f.output), []); assert.equal(app.router.workers.pi.jobs().length, 1);
  assert.match(job.outcome!.answer.summary, /已核实保存/);
});

test('R1 save deferral survives restart and a later attribution-only answer cannot reuse the old execution consent', async t => {
  const context = await missingImage(t), { f, initial, other, setTurns } = context; let app = context.app;
  await setTurns([flow(initial), flow(other), flow(other), quiet]);
  await f.inject({ id: 'hold', text: '仍无项目归属，暂时不保存' }); await until(() => app.store.row('feishu:hold')?.state === 'done');
  await f.stop(); app = await f.start(); f.config.approval.dispatch = false;
  await f.inject({ id: 'only-attribution', text: '仍无项目归属' });
  await until(() => app.store.row('feishu:only-attribution')?.state === 'waiting' && f.feishu.messages.some(m => m.card?.buttons.some(b => b.value.choice === 'approve')));
  assert.equal(app.router.workers.pi.jobs().length, 0); assert.deepEqual(await readdir(f.output), []);
  const message = f.feishu.messages.find(m => m.card?.buttons.some(b => b.value.choice === 'approve'))!, button = message.card!.buttons.find(b => b.value.choice === 'approve')!;
  await f.inject({ id: 'fresh-decision', quoteId: message.id, button: { value: button.value } }); await f.done('review');
  assert.equal(app.router.workers.pi.jobs().length, 1, 'only a new explicit decision re-enables the held save');
});

test('R2 natural project-only reply inherits the original instruction without another approval', async t => {
  const { f, app, source, initial, setTurns, addPromate } = await missingImage(t), output = await addPromate();
  await setTurns([flow(initial), flow({ ...initial, project: 'Promate' }), quiet]);
  await f.inject({ id: 'natural-project', text: '属于 Promate 项目' }); const job = await f.done('review');
  assert.equal(job.request.project, 'Promate'); assert.deepEqual(await readFile(join(output, 'review.png')), Buffer.from(PNG, 'base64')); assert.deepEqual(await readFile(source), Buffer.from(PNG, 'base64'));
  assert.deepEqual(await readdir(f.output), []); assert.equal(app.router.workers.pi.jobs().length, 1); assert.equal(app.store.taskTable().length, 1);
  assert.equal(f.feishu.messages.some(m => m.card?.buttons.some(b => b.value.choice === 'approve')), false);
});

for (const decision of ['complete', 'cancel', 'change-definition', 'defer'] as const) test(`R2 natural reply fallback preserves HITL recovery, identity/scope and dedup: ${decision}`, async t => {
  const context = await missingImage(t), { f, initial, setTurns, addPromate } = context; let app = context.app;
  const output = await addPromate(); f.config.approval.dispatch = false;
  const proposed = { ...initial, project: 'Promate' };
  const followup = decision === 'cancel' ? [{ tools: [{ name: 'cancel_task', arguments: { id: 'review' } }] }, { text: '已取消' }]
    : decision === 'defer' ? flow(proposed) : [{ tools: [{ name: 'update_task', arguments: { id: 'review', goal: '更改后的目标', completion: initial.completion, boundary: initial.boundary } }] }, { text: '定义已更新' }];
  await setTurns([flow(initial), flow(proposed), decision === 'complete' ? quiet : followup, quiet]);
  await f.inject({ id: 'natural-fallback', text: '这份材料应该算 Promate 那边的项目' });
  await until(() => app.store.row('feishu:natural-fallback')?.state === 'waiting' && f.feishu.messages.some(m => m.card?.buttons.some(b => b.value.choice === 'approve')));
  const message = f.feishu.messages.find(m => m.card?.buttons.some(b => b.value.choice === 'approve'))!, button = message.card!.buttons.find(b => b.value.choice === 'approve')!, operation = button.value.operation!;
  assert.equal(app.router.workers.pi.jobs().length, 0, 'ambiguous wording cannot inherit the automatic dispatch switch');
  await f.inject({ id: 'wrong-message', quoteId: 'not-the-original-card', button: { value: button.value } }); await until(() => app.store.row('feishu:wrong-message')?.state === 'done'); assert.equal(app.router.workers.pi.jobs().length, 0);
  await f.stop(); app = await f.start();
  if (decision !== 'complete') { await f.inject({ id: 'revision', text: decision === 'cancel' ? '取消这项保存' : decision === 'defer' ? '属于 Promate 项目，暂时不保存' : '更改这项保存的目标' }); await until(() => app.store.row('feishu:revision')?.state === 'done'); }
  await f.inject({ id: 'confirm-original', quoteId: message.id, button: { value: button.value } });
  await f.inject({ id: 'duplicate-confirmation', quoteId: message.id, button: { value: button.value } });
  if (decision === 'complete') { const job = await f.done('review'); assert.equal(job.id, operation); assert.deepEqual(await readFile(join(output, 'review.png')), Buffer.from(PNG, 'base64')); assert.equal(app.router.workers.pi.jobs().length, 1); }
  else { await until(() => app.store.row('feishu:confirm-original')?.state === 'done'); assert.equal(app.router.workers.pi.jobs().length, 0); assert.deepEqual(await readdir(output), []); assert.equal(app.router.workers.operation(operation)!.state, decision === 'cancel' ? 'cancelled' : decision === 'defer' ? 'rejected' : 'stale'); }
  assert.deepEqual(await readdir(f.output), []); assert.equal(app.store.taskTable().length, 1);
});

test('A8 ordinary proactive output still waits for original confirmation; material is not consent', async t => {
  const f = await outputFixture(t), source = join(f.config.projects[0]!.root, 'picture.png'); await writeFile(source, Buffer.from(PNG, 'base64'));
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [flow(args(source, 'proposal')), quiet] }) });
  const app = await f.start(); await f.inject({ id: 'material', text: '这是材料，不是委托' });
  await until(() => app.store.row('feishu:material')?.state === 'waiting' && f.feishu.messages.some(m => m.card?.buttons.some(b => b.value.choice === 'approve'))); assert.equal(app.router.workers.pi.jobs().length, 0); assert.deepEqual(await readdir(f.output), []);
  const message = f.feishu.messages.find(m => m.card?.buttons.some(b => b.value.choice === 'approve'))!;
  const button = message.card!.buttons.find(b => b.value.choice === 'approve')!; await f.inject({ id: 'yes', quoteId: message.id, button: { value: button.value } }); await f.done('proposal');
});

test('A8 uncertain project-question delivery is not called sent and is never retried under a new task id', async t => {
  const f = await outputFixture(t), source = join(f.config.projects[0]!.root, 'uncertain.png'); await writeFile(source, Buffer.from(PNG, 'base64'));
  const a = { ...args(source, 'uncertain-question', ''), instructionInput: 'feishu:question', instruction: '帮我保存图片' };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [flow(a), flow({ ...a, taskId: 'duplicate-question' })] }) });
  const app = await f.start(); let questions = 0;
  t.mock.method(app.router.workers.channel, 'send', async (_text: string, key: string) => { if (key.startsWith('output-project:')) questions++; throw new Error('synthetic channel uncertainty'); });
  await f.inject({ id: 'question', text: a.instruction }); await until(() => app.store.row('feishu:question')?.state === 'done');
  const result = app.store.events(0, 50).map(e => parseJson<any>(e.event)).find(e => e.kind === 'tool_result' && e.data.tool === 'worker_dispatch').data.result;
  assert.equal(result.questionSent, false); assert.equal(result.delivery, 'uncertain');
  await f.inject({ id: 'unrelated', text: '现在聊别的' }); await until(() => app.store.row('feishu:unrelated')?.state === 'done');
  assert.equal(questions, 1); assert.equal(app.store.task('duplicate-question'), undefined); assert.equal(app.router.workers.pi.jobs().length, 0); assert.deepEqual(await readdir(f.output), []);
});

test('A8 cancellation of missing-project output invalidates later other answer and cannot resurrect draft', async t => {
  const f = await outputFixture(t), source = join(f.config.projects[0]!.root, 'cancel.png'); await writeFile(source, Buffer.from(PNG, 'base64'));
  const a = { ...args(source, 'cancelled', ''), instructionInput: 'feishu:begin', instruction: '帮我保存图片' };
  const b = { ...a, project: 'p', options: JSON.stringify({ type: 'write', output: { kind: 'image', source, placement: 'other' } }) };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [flow(a), [{ tools: [{ name: 'cancel_task', arguments: { id: 'cancelled' } }] }, { text: '取消已记录' }], flow(b)] }) });
  const app = await f.start(); await f.inject({ id: 'begin', text: a.instruction }); await until(() => app.store.row('feishu:begin')?.state === 'done');
  await f.inject({ id: 'cancel', text: '取消这项产出' }); await until(() => app.store.row('feishu:cancel')?.state === 'done');
  await f.inject({ id: 'late', text: '仍无项目归属' }); await until(() => ['done', 'failed'].includes(app.store.row('feishu:late')?.state ?? ''));
  assert.equal(app.router.workers.pi.jobs().length, 0); assert.deepEqual(await readdir(f.output), []);
});

test('A7/A8 real worker final text alone cannot claim saved: no tool => failed verified receipt', async t => {
  const f = await outputFixture(t, {}, { flow: [{ text: '{"status":"done","summary":"存好了","evidence":[]}' }] }), source = join(f.config.projects[0]!.root, 'none.png'); await writeFile(source, Buffer.from(PNG, 'base64'));
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [flow({ ...args(source, 'fake'), instructionInput: 'feishu:fake', instruction: '帮我保存图片到 p 项目' }), quiet] }) });
  const app = await f.start(); await f.inject({ id: 'fake', text: '帮我保存图片到 p 项目' }); const job = await f.done('fake', 'failed');
  assert.match(job.outcome!.answer.summary, /不完整|未核实/); assert.equal(job.outcome!.answer.summary.includes('存好了'), false); assert.deepEqual(await readdir(f.output), []); assert.equal(app.store.task('fake')!.verified?.state, 'failed');
});

test('A7/A8 shared output primitive rejects outside/blacklist origins/links/hardlinks/type/size, preserves originals and existing files', async t => {
  const f = await outputFixture(t), app = await f.start(), source = join(f.inbox, 'safe.png'); await writeFile(source, Buffer.from(PNG, 'base64'));
  const scoped = () => app.router.files.policy(f.config.projects[0]!.root, [f.output]).then(p => new ScopedFiles(p));
  const plan = (o: OutputOptions, id = 'unit') => scoped().then(files => planOutput(f.config, app.store, request(id), files, o));
  const safe = await plan({ kind: 'image', source }); const files = await scoped();
  const saved = await produceOutput(files, safe); assert.equal(saved.ok, true); await verifyOutput(files, safe, saved);
  assert.equal((await produceOutput(files, safe)).ok, false); assert.deepEqual(await readFile(safe.target), Buffer.from(PNG, 'base64'));
  const outside = join(await realpath(f.root), 'outside.png'); await writeFile(outside, Buffer.from(PNG, 'base64'));
  await assert.rejects(plan({ kind: 'image', source: outside }));
  const black = join(f.config.attachmentDir, 'renamed.png'); await mkdir(f.config.attachmentDir, { recursive: true }); await writeFile(black, Buffer.from(PNG, 'base64')); app.store.set(`attachment-origin:${black}`, { name: '.env' }); await assert.rejects(plan({ kind: 'image', source: black }), /黑名单|不许读/);
  const hard = join(f.inbox, 'hard.png'); await link(source, hard); await assert.rejects(plan({ kind: 'image', source: hard }));
  const encrypted = Buffer.from(DOCX); encrypted.writeUInt16LE(1, encrypted.indexOf(Buffer.from('504b0102', 'hex')) + 8);
  const protectedPath = join(f.inbox, 'encrypted.docx'); await writeFile(protectedPath, encrypted); await assert.rejects(plan({ kind: 'docx-txt', source: protectedPath }, 'encrypted'), /加密|保护/); assert.deepEqual(await readFile(protectedPath), encrypted);
  const docs = join(f.inbox, 'source.docx'); await writeFile(docs, DOCX);
  const docPlan = await plan({ kind: 'docx-txt', source: docs, fileName: '../../escape\\clean.txt' }, 'doc-unit'); assert.equal(docPlan.target, join(f.output, 'clean.txt'));
  const linked = join(f.output, 'alias'); await symlink(f.inbox, linked); const escape = { ...docPlan, target: join(linked, 'escape.txt') }; assert.equal((await produceOutput(await scoped(), escape)).ok, false); await assert.rejects(stat(join(f.inbox, 'escape.txt')), { code: 'ENOENT' });
  const insideAlias = join(f.output, 'same-target.txt'); await symlink(join(f.output, 'new.txt'), insideAlias); assert.equal((await produceOutput(await scoped(), { ...docPlan, target: insideAlias })).ok, false);
  for (const [name, bytes] of [['broken.docx', Buffer.from('bad')], ['old.doc', Buffer.from('old doc')], ['wrong.docx', XLSX], ['unknown.png', Buffer.from('not image')]] as const) { const p = join(f.inbox, name); await writeFile(p, bytes); await assert.rejects(plan({ kind: name.endsWith('.png') ? 'image' : 'docx-txt', source: p }, name)); }
  f.config.intake.maxFileBytes = 10; await assert.rejects(plan({ kind: 'docx-txt', source: docs }, 'large')); assert.deepEqual(await readFile(docs), DOCX);
});

for (const attempt of ['outside-write', 'linked-target', 'black-origin'] as const) test(`A8 same message save entry rejects ${attempt} before any output worker/file`, async t => {
  const f = await outputFixture(t), source = join(f.config.projects[0]!.root, 'source.png'); await writeFile(source, Buffer.from(PNG, 'base64'));
  let options: object = { type: 'write', output: { kind: 'image', source } };
  if (attempt === 'outside-write') options = { ...options, writeDirs: [f.config.projects[0]!.root] };
  if (attempt === 'linked-target') await symlink(source, join(f.output, 'source.png'));
  if (attempt === 'black-origin') { await mkdir(f.config.attachmentDir, { recursive: true }); const renamed = join(f.config.attachmentDir, 'renamed.png'); await writeFile(renamed, Buffer.from(PNG, 'base64')); options = { type: 'write', output: { kind: 'image', source: renamed } }; }
  const a = { ...args(source, 'denied'), options: JSON.stringify(options), instructionInput: 'feishu:denied', instruction: '帮我保存图片到 p 项目' };
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [flow(a)] }) });
  const app = await f.start(); if (attempt === 'black-origin') app.store.set(`attachment-origin:${join(f.config.attachmentDir, 'renamed.png')}`, { name: '.env' });
  await f.inject({ id: 'denied', text: a.instruction }); await until(() => app.store.row('feishu:denied')?.state === 'done');
  const results = app.store.events(0, 50).map(e => parseJson<any>(e.event)).filter(e => e.kind === 'tool_result' && e.data.tool === 'worker_dispatch');
  assert.equal(results.length, 1); assert.equal(results[0].data.result.ok, false); assert.match(results[0].data.result.category, /outside_scope|blacklist/);
  assert.equal(app.router.workers.pi.jobs().length, 0); assert.equal(f.childModel.requests.length, 0); assert.deepEqual(await readFile(source), Buffer.from(PNG, 'base64'));
  assert.equal((await readdir(f.output)).length, attempt === 'linked-target' ? 1 : 0);
});

test('A8 partial companion race is incomplete with original/main retained; no digest-only or partial success accepted', async t => {
  const f = await outputFixture(t), app = await f.start(), source = join(f.inbox, 'partial.docx'); await writeFile(source, DOCX);
  const files = new ScopedFiles(await app.router.files.policy(f.config.projects[0]!.root, [f.output]));
  const base = await planOutput(f.config, app.store, request('partial'), files, { kind: 'docx-txt', source });
  const plan = { ...base, companion: `${base.target}.说明.txt`, otherReason: '构造失败测试' };
  const create = files.create.bind(files);
  t.mock.method(files, 'create', async (path: string, data: Buffer) => { const result = await create(path, data); if (path === plan.target) await mkdir(plan.companion); return result; });
  const result = await produceOutput(files, plan); assert.equal(result.ok, false); assert.equal(result.status, 'incomplete'); assert.equal(result.files.length, 1); assert.match(result.error!, /不完整/);
  assert.equal(await readFile(plan.target, 'utf8'), (await extract(DOCX, source)).text); assert.deepEqual(await readFile(source), DOCX); await assert.rejects(verifyOutput(files, plan, result));
  await writeFile(plan.target, 'ONLY FIRST BLOCK');
  await assert.rejects(verifyOutput(files, base, { ok: true, status: 'saved', expected: [base.target], files: [{ path: base.target, bytes: 16, sha256: hash('ONLY FIRST BLOCK') }] }));
});

test('A7 compatibility: old config retains no output grants; fixed roots/readAllow cannot be widened through output options', async t => {
  const f = await fixture(); t.after(() => f.close()); const app = await f.start(), source = join(f.inbox, 'source.docx'); await writeFile(source, DOCX);
  assert.equal(f.config.outputs, undefined);
  await assert.rejects(app.router.workers.pi.status({ ...request('old'), options: { type: 'write', output: { kind: 'docx-txt', source } } }), /授权目录|启用/);
  const output = join(f.config.projects[0]!.root, 'PA产出'); await mkdir(output); f.config.projects[0]!.pi = { writeDirs: [output], skills: {} }; f.config.readAllow = [f.config.projects[0]!.root];
  await assert.rejects(app.router.workers.pi.status({ ...request('narrow'), options: { type: 'write', output: { kind: 'docx-txt', source } } }));
  f.config.readAllow = []; await rename(output, `${output}-original`); await symlink(f.inbox, output);
  await assert.rejects(app.router.workers.pi.status({ ...request('changed-root'), options: { type: 'write', output: { kind: 'docx-txt', source } } }));
  for (const capabilities of [{ commands: true }, { network: true }, { editFiles: [source] }]) await assert.rejects(app.router.workers.pi.status({ ...request('capability'), options: { type: 'write', output: { kind: 'docx-txt', source }, ...capabilities } }), /受限新建/);
});
