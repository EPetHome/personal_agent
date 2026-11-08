import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, until, settleLaunchers } from './helpers.js';
import { canonical, hash } from '../src/util.js';
import { Store } from '../src/store.js';
import { Files } from '../src/files.js';
import { Intake } from '../src/intake.js';
import { Workers, type WorkerOperation, type WorkerRequest } from '../src/worker.js';
import { makeChannel } from '../src/channel.js';
import { DISCOVERY_FALLBACK_MS } from '../src/loop-discovery.js';
import type { TaskCard } from '../src/types.js';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
async function sourceFixture(watch = false) {
  const f = await fixture({ flow: [{ text: '构造回答；状态以工具返回的覆盖范围为准' }] }, { intake: { watch, fallbackMs: 60_000 } });
  const root = await canonical(f.root), project = f.config.projects[0]!, repo = project.root;
  await writeFile(join(repo, 'README.md'), '# synthetic'); git(repo, 'init', '-b', 'dev'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'synthetic');
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const state = { v: 1, batches: [] as any[] }, snapshot = join(root, 'loop.json'), calls = join(root, 'queries.jsonl');
  f.config.loop.args = [resolve('scripts/loop-stub.mjs'), '--state', snapshot, '--calls', calls];
  const save = () => writeFile(snapshot, JSON.stringify(state)); await save();
  async function seed(count = 1, name: string = randomUUID(), historical = false, sourceRepo = repo) {
    const file = join(sourceRepo, 'cards', name, '开发卡.json'), dir = join(project.loopRunDirs[0]!, 'runs', hash(common), hash(file)), ledger = join(dir, 'ledger.json'), id = randomUUID();
    await mkdir(dirname(file), { recursive: true }); await mkdir(dir, { recursive: true });
    const definitions = Array.from({ length: count }, (_, i) => ({ name: `事项-${i}`, prompt: `./任务-${i}.md`, scope: { allow: ['code/'] } }));
    await writeFile(file, JSON.stringify({ version: 1, nature: '开发', name: '同名批次', flow: ['开发评审', '验收'], tasks: definitions }));
    const userFileVersions: Record<string, string> = {};
    for (const [i, definition] of definitions.entries()) {
      const prompt = join(dirname(file), definition.prompt), content = `# 冻结业务目标-${i}\n完成构造交付-${name}，仅改 code/，不发布。\n`;
      await writeFile(prompt, content); userFileVersions[prompt] = hash(content);
    }
    const taskRecords = definitions.map((t, i) => ({ id: count === 1 ? t.name : `stable-${i}`, name: t.name, dir: count === 1 ? dir : join(dir, 'tasks', `stable-${i}`), epoch: 0,
      userFileVersions, activity: historical ? undefined : { id: `attempt-${i}`, node: '开发评审', kind: 'developing' } }));
    const raw: any = { v: 1, revision: 1, repo: sourceRepo, common, file, dir, card: { version: 1, nature: '开发', flow: ['开发评审', '验收'], tasks: definitions }, userFileVersions,
      ...(count === 1 ? { ...taskRecords[0] } : { taskRecords }), id, publication: historical ? { local: 'merged', push: '未请求' } : undefined,
      userInputs: ['SYNTHETIC_PRIVATE_SOURCE_BODY'], results: [] };
    const row: any = { ok: true, kernel: 1, id, card: file, ledger, name: '同名批次', status: historical ? '已合入' : '进行中', node: '开发评审', reason: '构造当前事实', checks: ['评审：没验证'], missing: ['业务验收未做'], results: [], attempts: [], release: { status: '未释放', details: [] },
      tasks: taskRecords.map(t => ({ id: t.id, name: t.name, status: '进行中', node: '开发评审', reason: '构造执行', activity: t.activity, processIdentity: '存活', release: { status: '未释放', details: [] } })),
      summary: join(dir, 'summary.md'), publication: raw.publication };
    await writeFile(row.summary, `证据-${name}`); state.batches.push(row);
    const publish = async () => { await writeFile(ledger, JSON.stringify(raw)); await save(); };
    await publish(); return { file, dir, ledger, raw, row, publish, ids: taskRecords.map(t => t.id) };
  }
  const queryCalls = async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...f, root, project, repo, common, state, snapshot, seed, save, queryCalls };
}

test('A5: authorized single/multi records auto-adopt, distinct run/task IDs, restart and history do not dispatch or notify', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  const single = await f.seed(1), multiple = await f.seed(3), ended = await f.seed(1, 'historical', true);
  let app = await f.start();
  assert.equal(app.store.taskTable().length, 4);
  const identities = app.store.taskTable().map(row => app.store.task(row.id)!.worker!.loop!);
  assert.equal(new Set(identities.map(b => `${b.repository}/${b.runId}/${b.taskId}`)).size, 4);
  assert.equal(identities.some(b => b.runId === ended.raw.id), false);
  assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
  assert.ok(app.store.taskTable().every(row => app.store.task(row.id)!.sourceDefinition?.state === 'pending'));
  await app.intake.scan(); await f.stop(); app = await f.start(); await app.intake.scan();
  assert.equal(app.store.taskTable().length, 4); assert.equal(f.model.requests.length, 0);
  const tracked = await app.router.workers.trackLoop('p', multiple.file, multiple.ids[1]);
  assert.equal(app.store.taskTable().length, 4); assert.equal(tracked.worker!.loop!.runId, multiple.raw.id);
  assert.ok((await f.queryCalls()).every(call => call.args[0] === '查询' && call.args[1] !== '--all'));
  assert.ok(identities.some(b => b.runId === single.raw.id));
});

test('A5: native notification starts verification within 10 seconds without track_loop', async t => {
  const f = await sourceFixture(true); t.after(() => f.close()); const app = await f.start();
  const began = Date.now(), source = await f.seed(2);
  await until(() => app.store.taskTable().length === 2, 10_000);
  const queries = await f.queryCalls(); assert.ok(queries.some(call => call.args[1] === source.file && Date.parse(call.at) - began < 10_000));
  assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
});

test('A5: actual default 60-second fallback path discovers a missed notification within the 90-second budget', async t => {
  const f = await sourceFixture(false); t.after(() => f.close());
  const store = new Store(f.config), files = new Files(f.config, store), workers = new Workers(f.config, store, await makeChannel(f.config), files);
  const intake = new Intake(f.config, store, files, () => {}, facts => workers.observeLoop(facts));
  t.after(async () => { await intake.stop(); store.close(); });
  const original = globalThis.setInterval, timers: { ms: number; run: () => unknown }[] = [];
  const spy = t.mock.method(globalThis, 'setInterval', (run: () => unknown, ms: number) => { timers.push({ ms, run }); return original(run, ms); });
  await intake.start(); spy.mock.restore();
  assert.equal(timers.length, 1); assert.equal(timers[0]!.ms, DISCOVERY_FALLBACK_MS); assert.equal(DISCOVERY_FALLBACK_MS, 60_000);
  await f.seed(1); const began = Date.now(); await timers[0]!.run();
  assert.equal(store.taskTable().length, 1); assert.ok(DISCOVERY_FALLBACK_MS + Date.now() - began < 90_000);
  assert.equal(f.model.requests.length, 0);
});

test('A5: half writes, failed saves, duplicate/out-of-order updates retain verified facts and retry after restart', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); let app = await f.start();
  app.store.db.exec("CREATE TRIGGER constructed_save_failure BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'synthetic save failure'); END;");
  const source = await f.seed(1); await app.intake.scan(); assert.equal(app.store.taskTable().length, 0);
  assert.equal(app.store.get(`discovery:ledger:${hash(source.ledger)}`, null), null);
  app.store.db.exec('DROP TRIGGER constructed_save_failure'); await f.stop(); app = await f.start();
  assert.equal(app.store.taskTable().length, 1);
  const card = app.store.task(app.store.taskTable()[0]!.id)!, binding = card.worker!.loop!;
  const initial = card.lastVerifiedAt; await writeFile(source.ledger, '{"v":1,'); await app.intake.scan();
  assert.equal(app.store.task(card.id)!.sourceRevision, 1); assert.equal(app.store.task(card.id)!.lastVerifiedAt, initial);
  source.raw.revision = 8; source.row.checks = ['技术检查：通过（业务未验）']; await source.publish(); await app.intake.scan();
  await until(() => app.store.task(card.id)!.sourceRevision === 8);
  const history = app.store.task(card.id)!.dispatches.length;
  const old = { id: 'late', source: 'loop' as const, who: 'loop', at: '', text: '', attachments: [], workerId: card.id, batchFile: source.file, raw: { kernel: 1, revision: 2, runId: binding.runId, ledger: binding.ledger } };
  assert.equal(await app.router.workers.ingest(old), false); await app.intake.scan();
  assert.equal(app.store.task(card.id)!.dispatches.length, history); assert.equal(app.store.taskTable().length, 1);
  assert.equal((app.store.task(card.id)!.verified!.layers as any).businessAcceptance, '未验证');
});

test('A5/A6: trusted common identity, readAllow/readDeny and link gates exclude unauthorized source bodies', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const good = await f.seed(1), bad = await f.seed(1, 'untrusted');
  bad.raw.common = join(f.root, 'foreign.git'); bad.raw.userInputs = ['SYNTHETIC_UNAUTHORIZED_BODY']; await bad.publish();
  const partial = await f.seed(1, 'half'); await writeFile(partial.ledger, '{');
  const alias = await f.seed(1, 'link'); const moved = `${alias.ledger}.original`; await rename(alias.ledger, moved); await symlink(moved, alias.ledger);
  const app = await f.start(); assert.equal(app.store.taskTable().length, 1);
  assert.equal(app.store.task(app.store.taskTable()[0]!.id)!.worker!.loop!.runId, good.raw.id);
  const calls = await f.queryCalls(); assert.equal(calls.some(c => [bad.file, partial.file, alias.file].includes(c.args[1])), false);
  const page = await app.router.tasks.loopPage([]); assert.equal(JSON.stringify(page).includes('SYNTHETIC_UNAUTHORIZED_BODY'), false);
  const task = app.store.taskTable()[0]!.id; f.config.readDeny.push(good.dir);
  await assert.rejects(app.router.tasks.detail(task, []), /拒绝读取/);
  const redacted = await app.router.tasks.context({ id: 'denied', source: 'feishu', who: 'owner', at: '', text: '', attachments: [] });
  assert.equal(redacted.count, 0); assert.equal(redacted.withheld, 1);
  f.config.readDeny.pop(); f.config.readAllow.push(f.repo);
  await assert.rejects(app.router.tasks.detail(task, []), /拒绝读取/);
  f.config.readAllow.length = 0; f.config.projects.length = 0;
  await assert.rejects(app.router.tasks.detail(task, []), /获准/); assert.equal((await app.router.tasks.context({ id: 'q', source: 'feishu', who: 'owner', at: '', text: '', attachments: [] })).total, 0);
});

test('A6: actual model input is bounded summary; stable pages, frozen definition and evidence are demand-only', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const source = await f.seed(13); const app = await f.start();
  await f.inject({ id: 'overview', text: '当前工作总览' }); await until(() => app.store.row('feishu:overview')?.state === 'done');
  const messages = f.model.requests[0].body.messages, context = JSON.parse(messages.at(-2).content), wire = JSON.stringify(messages);
  assert.equal(context.total, 13); assert.equal(context.count, 5); assert.equal(context.hasMore, true);
  for (const marker of ['SYNTHETIC_PRIVATE_SOURCE_BODY', '冻结业务目标', '"snapshot"', '"taskRecords"']) assert.equal(wire.includes(marker), false, marker);
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const page = await app.router.tasks.taskPage({ project: 'p', cursor, limit: 4 });
    assert.equal(page.total, 13); assert.ok(page.count <= 4); seen.push(...page.rows.map(r => (r as any).id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.length, 13); assert.equal(new Set(seen).size, 13);
  const detail = await app.router.tasks.detail(seen[0]!, []) as any;
  assert.equal(detail.definition.state, 'read'); assert.match(detail.definition.content, /冻结业务目标/);
  assert.equal(JSON.stringify(detail).includes('SYNTHETIC_PRIVATE_SOURCE_BODY'), false); assert.equal('snapshot' in detail, false);
  const refs = await app.router.tasks.evidence(seen[0]!, '', []) as any; assert.equal(refs.rows[0].key, 'summary');
  const evidence = await app.router.tasks.evidence(seen[0]!, 'summary', []) as any; assert.match(evidence.content, /证据/);
  f.config.readDeny.push(source.dir); await assert.rejects(app.router.tasks.evidence(seen[0]!, 'summary', []), /拒绝读取/);
  assert.equal(app.store.taskTable().length, 13); assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key GLOB 'worker:op:*'").get()!.n), 0);
});

test('A6: cursor freezes membership despite new discoveries, project indexes paginate and current permission changes invalidate old cursors', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); await f.seed(9); const app = await f.start();
  const first = await app.router.tasks.taskPage({ limit: 4 }), cursor = first.nextCursor!;
  await f.seed(1, 'later'); await app.intake.scan();
  const second = await app.router.tasks.taskPage({ cursor, limit: 4 }), third = await app.router.tasks.taskPage({ cursor: second.nextCursor!, limit: 4 });
  assert.equal(second.total, 9); assert.equal(third.total, 9); assert.equal(first.count + second.count + third.count, 9);
  assert.equal(new Set([...first.rows, ...second.rows, ...third.rows].map(r => (r as any).id)).size, 9);
  for (let i = 0; i < 12; i++) { const root = join(f.root, `office-${i}`); await mkdir(root); f.config.projects.push({ id: `office-${i}`, root, loopRunDirs: [] }); }
  const page = await app.router.tasks.projectPage('', 5), next = await app.router.tasks.projectPage(page.nextCursor!, 5);
  assert.equal(page.total, 13); assert.equal(next.total, 13); assert.equal(new Set([...page.rows, ...next.rows].map(p => p.id)).size, 10);
  f.config.projects.pop(); await assert.rejects(app.router.tasks.projectPage(page.nextCursor!, 5), /范围已变/);
  f.config.projects.length = 0; await assert.rejects(app.router.tasks.taskPage({ cursor }), /分页/);
});

test('A6: failed/partial queries keep last reliable facts/time; same-revision recovery refreshes original task only', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const source = await f.seed(2), app = await f.start();
  const id = app.store.taskTable()[0]!.id, before = app.store.task(id)!, original = JSON.stringify(f.state);
  await writeFile(f.snapshot, '{}'); const failed = await app.router.tasks.detail(id, []) as any;
  assert.equal(failed.ok, false); assert.equal(failed.lastVerifiedAt, before.lastVerifiedAt); assert.equal(failed.status, before.status); assert.equal(app.store.task(id)!.sourceRevision, 1);
  await writeFile(f.snapshot, original); source.row.tasks = source.row.tasks.slice(0, 1); await f.save();
  const partial = await app.router.tasks.detail(id, []) as any; assert.equal(partial.ok, false); assert.equal(partial.lastVerifiedAt, before.lastVerifiedAt);
  f.state.batches = JSON.parse(original).batches; await f.save();
  const recovered = await app.router.tasks.detail(id, []) as any; assert.equal(recovered.ok, true); assert.equal(recovered.sourceHealth.ok, true);
  assert.equal(app.store.taskTable().length, 2); assert.equal(f.feishu.messages.length, 0);
});

test('A5/A6: bounded initial discovery persists continuation and does not reread completed history on restart', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  for (let i = 0; i < 29; i++) await f.seed(1, `old-${i}`, true);
  await f.seed(1, 'active'); let app = await f.start(); await until(() => app.store.taskTable().length === 1);
  await until(() => app.store.get<any>('discovery:coverage:p', {}).ok === true);
  const calls = (await f.queryCalls()).length; assert.ok(calls <= 2, 'historical runs are classified from mechanical identity fields without public queries');
  const indexes = app.store.db.prepare("SELECT value FROM kv WHERE key GLOB 'discovery:index:*'").all().map(r => JSON.parse(String(r.value)));
  assert.ok(indexes.some(s => s.complete && s.position === 30));
  await f.stop(); app = await f.start(); await app.intake.scan();
  assert.equal((await f.queryCalls()).length, calls); assert.equal(f.model.requests.length, 0);
});

test('compatibility: additive upgrade/failed persistence preserves old tasks, unresolved operations, messages and offline restore', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); let app = await f.start();
  const old: TaskCard = { id: 'old', title: '旧事项', goal: '原目标', completion: '原标准', boundary: '原边界', status: 'waiting-approval', waiting: '旧未决确认', dispatches: [{ id: 'old-op' }], conclusion: '', updated: '2026-01-01', subscriptions: [{ kind: 'message', value: 'old-message' }] };
  app.store.putTask(old); app.store.set('worker:group:old', { operations: ['old-op'] });
  app.store.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?)').run('old-outbox', 'old-input', '旧消息', 'sent', 'old-message');
  await f.stop(); const backup = join(f.root, 'offline-copy'); await cp(f.config.dataDir, backup, { recursive: true });
  await f.seed(1); app = await f.start(); assert.deepEqual(app.store.task('old'), old); assert.equal(app.store.replies('old-input')[0]!.message_id, 'old-message');
  assert.deepEqual(app.store.get('worker:group:old', null), { operations: ['old-op'] });
  await f.stop(); await rm(f.config.dataDir, { recursive: true }); await cp(backup, f.config.dataDir, { recursive: true }); app = await f.start();
  assert.deepEqual(app.store.task('old'), old); assert.equal(app.store.replies('old-input').length, 1);
});

test('A5: an exact run-directory grant discovers only that formal record, without granting its parent index', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const good = await f.seed(2), outside = await f.seed(1);
  f.project.loopRunDirs = [good.dir];
  const app = await f.start(); assert.equal(app.store.taskTable().length, 2);
  assert.equal((await f.queryCalls()).some(c => c.args[1] === outside.file), false);
  assert.equal((await app.router.tasks.detail(app.store.taskTable()[0]!.id, []) as any).ok, true);
  await assert.rejects(app.router.files.protocolPath(f.repo, dirname(good.dir)), /拒绝读取/);
});

test('A6: actual Router tool rounds progressively disclose definition/evidence, not raw snapshots or audit bodies', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); await f.seed(3); const app = await f.start(), id = app.store.taskTable()[0]!.id;
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [
    { tools: [{ name: 'list_tasks', arguments: { project: 'p', limit: 2 } }] },
    { tools: [{ name: 'get_task', arguments: { id } }] },
    { tools: [{ name: 'read_task_evidence', arguments: { id, key: 'summary' } }] },
    { tools: [{ name: 'read_events', arguments: { after: 0, limit: 50 } }] },
    { text: '已按原事项核对：技术状态与业务验收分列，仍有未读分页。' },
  ] }) });
  await f.inject({ id: 'progressive', text: '问这项现在怎样，再看原目标和证据' }); await until(() => app.store.row('feishu:progressive')?.state === 'done');
  const rounds = f.model.requests, first = JSON.stringify(rounds[0].body.messages), final = JSON.stringify(rounds.at(-1).body.messages);
  assert.equal(first.includes('冻结业务目标'), false); assert.equal(final.includes('冻结业务目标'), true); assert.equal(final.includes('证据-'), true);
  for (const marker of ['SYNTHETIC_PRIVATE_SOURCE_BODY', '\"snapshot\"', '\"taskRecords\"']) assert.equal(final.includes(marker), false, marker);
  const toolResults = rounds.at(-1).body.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
  assert.equal(toolResults[0].total, 3); assert.equal(toolResults[0].hasMore, true); assert.ok(toolResults[0].nextCursor);
  assert.equal(toolResults[1].layers.businessAcceptance, '未验证');
  assert.equal(app.store.taskTable().length, 3); assert.equal(f.feishu.messages.length, 1);
});

test('A9 local identity contribution: PA dispatch, independent Loop and an office Pi stay separate through failure/recovery', async t => {
  const f = await fixture({ flow: [{ text: '构造来源处理完成；不混淆交付层次' }] }, { intake: { watch: false, fallbackMs: 60_000 } }); t.after(() => f.close());
  const root = await canonical(f.root), p = f.config.projects[0]!, repo = p.root;
  await mkdir(join(repo, 'code')); await writeFile(join(repo, 'code/README.md'), '# synthetic');
  await writeFile(join(repo, '.gitignore'), '.autoreview.json\n'); await writeFile(join(repo, '.autoreview.json'), '{"acceptance":{}}');
  git(repo, 'init', '-b', 'dev'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'synthetic mixed baseline');
  p.loop = { batchDir: join(repo, 'docs/batches'), allow: ['code/'], deny: [] };
  const snapshot = join(root, 'loop.json'), calls = join(root, 'loop-calls.jsonl');
  let state: any = { v: 1, batches: [], test: { root, project: repo, workspace: repo, run: p.loopRunDirs[0] } };
  const save = () => writeFile(snapshot, JSON.stringify(state)); await save();
  f.config.loop.args = [resolve('scripts/loop-worker-stub.mjs'), '--state', snapshot, '--calls', calls];
  const control = join(root, 'pi-control.json'), piCalls = join(root, 'pi-calls.jsonl'); await writeFile(control, JSON.stringify({ summary: '构造办公材料核对完成' }));
  Object.assign(f.config.pi, { command: process.execPath, args: [resolve('scripts/pi-worker-stub.mjs'), '--control', control, '--calls', piCalls], pollMs: 30, startupMs: 300 });
  f.config.approval.dispatch = false; f.config.approval.readPi = false; const app = await f.start();
  await app.router.workers.execute('pa-origin', 'worker_dispatch', { taskId: 'pa-original', worker: 'loop', project: 'p', title: '开发', goal: '构造 PA 原目标', completion: '检查分列', boundary: '仅 code/，不发布', prompt: '核对构造标题' });
  await settleLaunchers(f.config.dataDir); state = JSON.parse(await readFile(snapshot, 'utf8'));
  const file = join(repo, 'docs/batches/independent/开发卡.json'); await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, flow: ['开发评审', '验收'], tasks: [{ name: '开发' }, { name: '材料' }] }));
  state.batches.push({ kernel: true, runId: randomUUID(), project: repo, batch: { file, name: '本人独立批次' }, state: 'running', tasks: [{ id: 'owner-a', name: '开发', active: true }, { id: 'owner-b', name: '材料', active: true }], events: { lastSeq: 1 } }); await save();
  execFileSync(process.execPath, [...f.config.loop.args, '查询', '--all', '--json'], { stdio: 'pipe' }); await app.intake.scan();
  assert.equal(app.store.taskTable().length, 3); const pa = app.store.task('pa-original')!; assert.equal(pa.worker!.origin, 'pa'); assert.ok(pa.worker!.loop);
  const owner = app.store.taskTable().map(row => app.store.task(row.id)!).find(card => card.worker?.loop?.taskId === 'owner-a')!;
  assert.notEqual(owner.id, pa.id); assert.notEqual(owner.worker!.loop!.runId, pa.worker!.loop!.runId);
  await app.router.workers.execute('office-origin', 'worker_dispatch', { taskId: 'office-original', worker: 'pi', project: 'p', title: '材料', goal: '构造办公材料核对', completion: '给原材料结论', boundary: '只读', prompt: '只读核对构造材料', options: '{"type":"read"}' });
  await until(() => app.store.task('office-original')?.status === 'done');
  state.test.queryFailure = 'bad-receipt'; await save(); const failed = await app.router.tasks.detail(owner.id, []) as any;
  assert.equal(failed.ok, false); assert.equal(failed.source.runId, owner.worker!.loop!.runId);
  delete state.test.queryFailure; await save(); const restored = await app.router.tasks.detail(owner.id, []) as any;
  assert.equal(restored.ok, true); assert.equal(restored.layers.businessAcceptance, '未验证');
  const page = await app.router.tasks.taskPage({ project: 'p', limit: 10, includeClosed: true }); assert.equal(page.total, 4); assert.equal(page.count, 4);
  assert.equal(app.store.task('office-original')!.worker!.kind, 'pi'); assert.equal(app.store.task('office-original')!.worker!.loop, undefined);
  assert.equal(app.store.task('pa-original')!.goal, '构造 PA 原目标');
  assert.equal((await readFile(calls, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(c => c.verb === '启动').length, 1);
  assert.equal((await readFile(piCalls, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(c => c.event === 'start').length, 1);
});

test('A5: offline completion restores facts silently; offline reactivation keeps the original identity without replay', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const source = await f.seed(2); let app = await f.start();
  const ids = app.store.taskTable().map(row => row.id); await f.stop();
  source.raw.revision = 2; source.raw.publication = { local: 'merged', push: '未请求' }; source.row.publication = source.raw.publication; source.row.status = '已合入';
  source.raw.taskRecords.forEach((record: any) => { delete record.activity; }); source.row.tasks.forEach((record: any) => { record.activity = null; record.processIdentity = '无活动'; record.status = '等你决定'; }); await source.publish();
  app = await f.start(); await until(() => ids.every(id => app.store.task(id)!.sourceRevision === 2));
  assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
  assert.equal((await app.router.tasks.context({ id: 'q', source: 'feishu', who: 'owner', at: '', text: '', attachments: [] })).total, 0);
  await f.stop(); source.raw.revision = 3;
  const activity = { id: 'reopened-attempt', node: '测试', kind: 'testing' };
  source.raw.taskRecords[0].activity = activity; source.row.tasks[0].activity = activity; source.row.tasks[0].processIdentity = '存活'; source.row.tasks[0].status = '进行中'; await source.publish();
  app = await f.start(); assert.deepEqual(app.store.taskTable().map(row => row.id).sort(), ids.sort());
  assert.equal(ids.every(id => app.store.task(id)!.sourceRevision === 3), true); assert.equal(f.feishu.messages.length, 0);
  assert.ok((await f.queryCalls()).every(c => c.args[0] === '查询' && c.args[1] !== '--all'));
});

test('A5/A6: bound reads are paged and cannot retarget a sibling or overwrite a concurrent owner definition/message', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const source = await f.seed(27), app = await f.start();
  const first = app.store.boundLoopPage({ after: 0 }), next = app.store.boundLoopPage(first.cursor);
  assert.equal(first.cards.length, 24); assert.equal(first.hasMore, true); assert.equal(next.cards.length, 3);
  assert.equal(new Set([...first.cards, ...next.cards].map(c => c.id)).size, 27);
  const card = first.cards[0]!, sibling = first.cards[1]!;
  await assert.rejects(app.router.workers.prepare('wrong-sibling', 'worker_stop', { taskId: card.id, sourceTaskId: sibling.worker!.loop!.taskId }), /其他来源任务/);
  assert.equal(app.store.task(card.id)!.worker!.loop!.taskId, card.worker!.loop!.taskId);
  source.raw.revision = 2; await source.publish();
  const adapter = app.router.workers.adapters.get('loop')!, original = adapter.status.bind(adapter);
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { ready = resolve; });
  adapter.status = async (...args) => { const result = await original(...args); ready(); await gate; return result; };
  const pending = app.router.workers.status(card.id); await reached;
  const updated = app.store.task(card.id)!; updated.goal = '本人并发更新的业务目标'; updated.waiting = '保留未决确认'; updated.subscriptions.push({ kind: 'message', value: 'owner-new-message' }); app.store.putTask(updated);
  release(); await pending;
  const current = app.store.task(card.id)!; assert.equal(current.goal, updated.goal); assert.equal(current.waiting, updated.waiting);
  assert.ok(current.subscriptions.some(s => s.value === 'owner-new-message')); assert.equal(current.sourceRevision, 2);
  adapter.status = original;
  // The public query observes process death without modifying the ledger.
  const selected = source.row.tasks.find((record: any) => record.id === card.worker!.loop!.taskId);
  selected.activity = null; selected.processIdentity = '无活动'; selected.status = '等你决定'; selected.reason = '构造原执行已退出'; await f.save();
  await app.router.workers.status(card.id);
  const stopped = app.store.task(card.id)!;
  assert.equal(stopped.sourceRevision, 2); assert.equal(stopped.status, '等你决定'); assert.equal((stopped.verified!.layers as any).execution.active, false);
  const history = stopped.dispatches.length; await app.router.workers.status(card.id);
  assert.equal(app.store.task(card.id)!.dispatches.length, history, 'an identical same-revision recheck is not a new event');
});

test('A5 compatibility: a previously partial multi-task binding keeps its original card and discovers the missing siblings', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const source = await f.seed(3);
  const store = new Store(f.config);
  const old: TaskCard = { id: 'old-manual-card', title: '原事项', goal: '本人已确认的旧目标', completion: '原标准', boundary: '原边界', status: '进行中', waiting: '原未决说明', dispatches: [], conclusion: '', updated: '2026-01-01', sourceRevision: 1,
    subscriptions: [{ kind: 'loop', value: source.file }, { kind: 'message', value: 'old-message' }], worker: { kind: 'loop', project: f.repo, batchFile: source.file, origin: 'owner-loop',
      loop: { protocol: 'kernel:1', repository: f.common, runId: source.raw.id, cardFile: source.file, ledger: source.ledger, taskId: source.ids[0]! } } };
  store.putTask(old); store.close();
  const app = await f.start();
  assert.equal(app.store.taskTable().length, 3); assert.equal(app.store.task(old.id)!.goal, old.goal); assert.equal(app.store.task(old.id)!.waiting, old.waiting);
  const cards = app.store.taskTable().map(row => app.store.task(row.id)!);
  assert.equal(new Set(cards.map(card => card.worker!.loop!.taskId)).size, 3);
  assert.ok(app.store.task(old.id)!.subscriptions.some(s => s.value === 'old-message'));
  assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
});

test('repair 1: dispatch precheck completes past 24 histories, isolates the project and rejects later active/invalid records', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  f.project.loop = { batchDir: join(f.repo, 'docs/batches'), allow: ['code/'], deny: [] };
  await writeFile(join(f.repo, '.autoreview.json'), '{"acceptance":{}}');
  const history = []; for (let n = 0; n < 30; n++) history.push(await f.seed(1, `past-${n}`, true));
  const app = await f.start(); await until(() => app.store.get<any>('discovery:coverage:p', {}).ok === true);
  const foreign = join(f.root, 'foreign'), foreignRuns = join(f.root, 'foreign-runs'); await mkdir(foreign); await mkdir(foreignRuns);
  f.config.projects.push({ id: 'foreign', root: foreign, loopRunDirs: [foreignRuns] });
  const gate = app.router.files.protocolPath.bind(app.router.files); let foreignReads = 0;
  t.mock.method(app.router.files, 'protocolPath', async (...args: Parameters<Files['protocolPath']>) => { if (args[0] === foreign) foreignReads++; return gate(...args); });
  const args = { taskId: 'fresh', worker: 'loop', project: 'p', title: '新委托', goal: '构造目标', completion: '构造完成标准', boundary: '只改 code/，不发布', prompt: '构造修改' };
  const op = await app.router.workers.prepare('new-work', 'worker_dispatch', args);
  assert.equal(op.basis.state, 'idle'); assert.equal(foreignReads, 0);
  // Choose an actual later directory entry, not a name/order assumption.
  const index = dirname(history[0]!.dir), entries = await import('node:fs/promises').then(async fs => { const names = []; for await (const entry of await fs.opendir(index)) names.push(entry.name); return names; });
  const late = history.find(s => s.dir === join(index, entries[27]!))!;
  delete late.raw.publication; delete late.row.publication; late.row.status = '进行中';
  late.raw.activity = { id: 'late-active', node: '开发评审', kind: 'developing' }; late.row.tasks[0].activity = late.raw.activity; await late.publish();
  await assert.rejects(app.router.workers.prepare('active-on-later-page', 'worker_dispatch', { ...args, taskId: 'fresh-2' }), /已有运行/);
  late.raw.publication = { local: 'merged', push: '未请求' }; delete late.raw.activity; await late.publish();
  await writeFile(history[0]!.ledger, '{');
  await assert.rejects(app.router.workers.prepare('unverified-history', 'worker_dispatch', { ...args, taskId: 'fresh-3' }), /核对不完整/);
  assert.equal(foreignReads, 0); assert.equal((await f.queryCalls()).some(c => c.args[0] !== '查询'), false);
});

test('repair 4: legacy worker_status/get_task show fresh execution facts separately from the local task, without snapshots', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const app = await f.start(), file = join(f.repo, 'legacy.json');
  f.state.batches.push({ project: f.repo, batch: { file, name: '旧 v1' }, state: 'paused', next: 'resume', stages: [{ stage: '开发', state: 'paused' }] }); await f.save();
  const card: TaskCard = { id: 'legacy-current', title: '旧任务', goal: '原目标', completion: '原标准', boundary: '原边界', status: 'running', waiting: '', dispatches: [], conclusion: '', updated: '2026-01-01', subscriptions: [], worker: { kind: 'loop', project: 'p', batchFile: file } };
  app.store.putTask(card);
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [
    { tools: [{ name: 'worker_status', arguments: { id: card.id } }] }, { tools: [{ name: 'get_task', arguments: { id: card.id } }] }, { text: '原任务在等决定，执行与业务验收分列' },
  ] }) });
  await f.inject({ id: 'legacy-state', text: '这项现在怎样' }); await until(() => app.store.row('feishu:legacy-state')?.state === 'done');
  const results = f.model.requests.at(-1).body.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
  for (const result of results) {
    assert.equal(result.ok, true); assert.equal(result.localTaskState, 'running'); assert.equal(result.sourceState, 'paused');
    assert.equal(result.layers.execution.state, 'paused'); assert.equal(result.layers.businessAcceptance, '未验证'); assert.ok(result.lastVerifiedAt); assert.equal('snapshot' in result, false);
  }
  assert.equal(app.store.task(card.id)!.status, 'running'); assert.equal(app.store.task(card.id)!.goal, card.goal);
  const confirmedAt = app.store.task(card.id)!.lastVerifiedAt;
  delete f.state.batches[0].stages; await f.save();
  const unknown = await app.router.tasks.detail(card.id, []) as any;
  assert.equal(unknown.ok, false); assert.equal(unknown.sourceState, 'paused'); assert.equal(unknown.lastVerifiedAt, confirmedAt);
  f.config.readDeny.push(file); await assert.rejects(app.router.tasks.detail(card.id, []), /拒绝读取/);
});

test('repair 4: a Pi result before event ingestion is visible as current execution, not business completion', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const control = join(f.root, 'pi-control.json');
  await writeFile(control, JSON.stringify({ status: 'needs-decision', summary: '构造 Pi 新结果', question: '构造取舍？' }));
  Object.assign(f.config.pi, { command: process.execPath, args: [resolve('scripts/pi-worker-stub.mjs'), '--control', control, '--calls', join(f.root, 'pi-query-calls.jsonl')], pollMs: 60_000, startupMs: 300 });
  f.config.approval.readPi = false; const app = await f.start();
  await app.router.workers.execute('pi-new', 'worker_dispatch', { taskId: 'pi-current', worker: 'pi', project: 'p', title: '办公核对', goal: '原办公目标', completion: '交回原结果', boundary: '只读', prompt: '核对构造材料', options: '{"type":"read"}' });
  const before = app.store.task('pi-current')!;
  await until(async () => { await app.router.workers.pi.tick(); return app.router.workers.pi.jobs()[0]?.state === 'needs-decision'; });
  const result = await app.router.tasks.detail(before.id, []) as any;
  assert.equal(result.localTaskState, before.status); assert.equal(result.sourceState, 'needs-decision'); assert.equal(result.layers.execution.result.summary, '构造 Pi 新结果');
  assert.equal(result.layers.businessAcceptance, '未验证'); assert.equal('snapshot' in result, false);
  assert.equal(app.store.task(before.id)!.status, before.status); assert.equal(app.store.task(before.id)!.goal, before.goal);
});

for (const historical of [false, true]) test(`repair 5: mixed source paging reaches v1 and unregistered modern work despite ${historical ? 'historical-only' : 'active'} modern database entries`, async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const original = await f.seed(1, 'known', historical), app = await f.start();
  if (historical) await app.router.workers.trackLoop('p', original.file, original.ids[0]);
  const indexed = app.store.taskTable().length, fresh = await f.seed(1, 'not-yet-indexed');
  const legacyFile = join(f.repo, 'old-v1.json'); f.state.batches.push({ project: f.repo, batch: { file: legacyFile, name: '仍在运行的旧任务' }, state: 'running', stages: [] }); await f.save();
  const seen = []; let cursor = '', last: any;
  do {
    last = await app.router.tasks.loopPage([], undefined, 0, 1, cursor) as any;
    assert.equal(last.ok === false, false); seen.push(...last.batches); cursor = last.nextCursor ?? '';
    if (last.hasMore) assert.equal(last.total, null);
  } while (cursor);
  assert.ok(seen.some((b: any) => b.protocol === 'v1' && b.batch.file === legacyFile && b.state === 'running'));
  assert.ok(seen.some((b: any) => b.protocol === 'kernel:1' && b.runId === fresh.raw.id));
  assert.equal(new Set(seen.map((b: any) => b.batch.file)).size, seen.length);
  assert.equal(last.total, historical ? 2 : 3); assert.equal(last.registeredTasks, indexed);
  assert.equal(app.store.taskTable().length, indexed, 'transient source queries must not register permanent tasks/attention');
});

test('repair 2: exact-run grants and projects advance fairly across persisted pages without unchanged-prefix spinning', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const sources = [];
  for (let n = 0; n < 27; n++) sources.push(await f.seed(1, `direct-${n}`));
  const sibling = join(f.root, 'sibling'); git(f.repo, 'worktree', 'add', '--detach', sibling);
  const other = await f.seed(1, 'other-project', false, sibling);
  f.project.loopRunDirs = sources.map(s => s.dir); f.config.projects.push({ id: 'other', root: sibling, loopRunDirs: [other.dir] });
  const create = async () => {
    const store = new Store(f.config), files = new Files(f.config, store), workers = new Workers(f.config, store, await makeChannel(f.config), files);
    return { store, intake: new Intake(f.config, store, files, () => {}, facts => workers.observeLoop(facts)) };
  };
  let current = await create();
  assert.equal(await current.intake.discovery!.scan(), true);
  assert.ok(current.store.taskTable().some(row => current.store.task(row.id)!.worker!.project === sibling), 'the second project must get a slot before the first project exhausts its grants');
  assert.ok(current.store.get<any>('discovery:round', {}).pending.length > 0); const firstCount = current.store.taskTable().length;
  await current.intake.stop(); current.store.close(); current = await create();
  let more = true, rounds = 0;
  while (more && rounds++ < 12) more = await current.intake.discovery!.scan(rounds > 1);
  assert.equal(more, false); assert.equal(current.store.taskTable().length, 28); assert.ok(firstCount < 28);
  const calls = (await f.queryCalls()).length;
  more = true; rounds = 0;
  while (more && rounds++ < 12) more = await current.intake.discovery!.scan(rounds > 1);
  assert.equal(more, false); assert.equal((await f.queryCalls()).length, calls, 'unchanged direct/known prefixes must not trigger repeated source reads');
  await current.intake.stop(); current.store.close();
  const app = await f.start(); let scans = 0; const original = app.intake.scan.bind(app.intake);
  t.mock.method(app.intake, 'scan', (...args: Parameters<Intake['scan']>) => { scans++; return original(...args); });
  await until(() => app.store.get<any>('discovery:round', {}).pending.length === 0 && app.store.get<any>('kernel:scan-position', {}).after === 0);
  const settled = scans; await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(scans, settled, 'completed discovery/binding sweeps must not restart each other in an immediate loop');
  assert.equal(app.store.taskTable().length, 28); assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
});

test('repair 3: actual 60s fallback signature sweep restores a reactivated ended run after missed notifications without restart/replay', async t => {
  const f = await sourceFixture(false); t.after(() => f.close());
  for (let n = 0; n < 29; n++) await f.seed(1, `quiet-history-${n}`, true);
  const source = await f.seed(1, 'follow-original'), timers: { run: () => unknown; ms: number }[] = [], originalTimer = globalThis.setInterval;
  const spy = t.mock.method(globalThis, 'setInterval', (run: () => unknown, ms: number) => { timers.push({ run, ms }); return originalTimer(run, ms); });
  const app = await f.start(); spy.mock.restore(); await until(() => app.store.taskTable().length === 1);
  const tick = timers.find(timer => timer.ms === 60_000 && timer.run.toString().includes('this.scan'))!; assert.ok(tick);
  const id = app.store.taskTable()[0]!.id;
  source.raw.revision = 2; source.raw.publication = { local: 'merged', push: '未请求' }; delete source.raw.activity;
  source.row.status = '已合入'; source.row.publication = source.raw.publication; source.row.tasks[0].activity = null; source.row.tasks[0].processIdentity = '无活动'; await source.publish();
  await app.router.workers.status(id); await app.intake.scan(); await until(() => app.store.get<any>('discovery:round', {}).pending.length === 0);
  assert.equal(app.store.task(id)!.status, '已合入'); assert.equal(app.store.boundLoopPage({ after: 0 }).cards.some(card => card.id === id), false);
  const activity = { id: 'reactivated', node: '开发评审', kind: 'developing' };
  source.raw.revision = 3; source.raw.activity = activity; source.row.tasks[0].activity = activity; source.row.tasks[0].processIdentity = '存活'; source.row.tasks[0].status = '进行中'; await source.publish();
  const began = Date.now(); await tick.run(); await until(() => app.store.task(id)!.sourceRevision === 3);
  assert.ok(60_000 + Date.now() - began < 90_000); assert.equal(app.store.task(id)!.status, '进行中');
  assert.equal(app.store.taskTable().length, 1); assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
  assert.equal((await f.queryCalls()).some(c => c.args[0] !== '查询'), false);
});

for (const mode of ['deny-root', 'deny-exact', 'allow-project-only', 'not-connected'] as const) test(`review2 item 1: ${mode} is unknown coverage, never complete empty or dispatch idle`, async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const source = await f.seed(1);
  f.project.loop = { batchDir: join(f.repo, 'docs/batches'), allow: ['code/'], deny: [] }; await writeFile(join(f.repo, '.autoreview.json'), '{"acceptance":{}}');
  const app = await f.start(), cached = app.store.task(app.store.taskTable()[0]!.id)!;
  cached.title = 'DENIED_SOURCE_TITLE'; cached.goal = 'DENIED_SOURCE_GOAL'; app.store.putTask(cached);
  if (mode === 'deny-root') f.config.readDeny.push(f.project.loopRunDirs[0]!);
  if (mode === 'deny-exact') { f.project.loopRunDirs = [source.dir]; f.config.readDeny.push(source.dir); }
  if (mode === 'allow-project-only') f.config.readAllow = [f.repo];
  if (mode === 'not-connected') f.project.loopRunDirs = [];
  assert.equal(await app.router.files.protocolPath(f.repo, f.repo), f.repo, 'project root remains authorized');
  const page = await app.router.tasks.loopPage([]) as any;
  assert.equal(page.total, null); assert.equal(page.partial, true); assert.equal(page.coverage.partial, true);
  assert.equal(page.registeredTasks, null); assert.equal(page.batches.length, 0); assert.ok(page.coverage.errors.length);
  const wire = JSON.stringify(page);
  for (const hidden of ['DENIED_SOURCE_TITLE', 'DENIED_SOURCE_GOAL', source.raw.id, source.ledger, source.file]) assert.equal(wire.includes(hidden), false);
  await assert.rejects(app.router.workers.prepare(`blocked-${mode}`, 'worker_dispatch', { taskId: 'blocked-new', worker: 'loop', project: 'p', title: '新委托', goal: '构造目标', completion: '构造标准', boundary: '仅 code/，不发布', prompt: '构造修改' }), /核对不完整/);
  assert.equal(app.store.task('blocked-new'), undefined); assert.equal(f.model.requests.length, 0);
});

test('review2 item 1: a positively authorized empty index is complete and may pass dispatch precheck', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  await mkdir(join(f.project.loopRunDirs[0]!, 'runs', hash(f.common)), { recursive: true });
  f.project.loop = { batchDir: join(f.repo, 'docs/batches'), allow: ['code/'], deny: [] }; await writeFile(join(f.repo, '.autoreview.json'), '{"acceptance":{}}');
  const app = await f.start(), page = await app.router.tasks.loopPage([]) as any;
  assert.equal(page.total, 0); assert.equal(page.partial, false); assert.equal(page.registeredTasks, 0);
  const op = await app.router.workers.prepare('empty-is-verified', 'worker_dispatch', { taskId: 'first-work', worker: 'loop', project: 'p', title: '首项工作', goal: '构造目标', completion: '构造标准', boundary: '仅 code/，不发布', prompt: '构造修改' });
  assert.equal(op.basis.state, 'idle');
});

test('review2 item 1: a denied child is omitted without counts/body while other readable sources remain reachable', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const visible = await f.seed(1, 'visible'), hidden = await f.seed(1, 'denied-child');
  const app = await f.start(); f.config.readDeny.push(hidden.dir);
  const page = await app.router.tasks.loopPage([]) as any;
  assert.equal(page.partial, true); assert.equal(page.total, null); assert.equal(page.registeredTasks, null);
  assert.equal(page.indexedSources, 1); assert.equal(page.batches.length, 1); assert.equal(page.batches[0].runId, visible.raw.id);
  assert.equal(JSON.stringify(page).includes(hidden.raw.id), false); assert.equal(JSON.stringify(page).includes(hidden.ledger), false);
});

test('review2 item 2: failed unregistered sources never borrow empty/project/other-run tasks; exact last facts still work', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const app = await f.start(), source = await f.seed(1, 'unregistered-failure');
  source.row.tasks = []; await f.save(); // Valid source header, inconsistent current-query response.
  const other = join(f.root, 'other-project'); await mkdir(other); f.config.projects.push({ id: 'other', root: other, loopRunDirs: [] });
  const pending = (id: string, project: string): TaskCard => ({ id, title: `PRIVATE_${id}`, goal: `GOAL_${id}`, completion: '原标准', boundary: '原边界', status: 'waiting-approval', waiting: '待确认', dispatches: [], conclusion: '', updated: '2026-01-01', subscriptions: [], worker: { kind: 'loop', project, batchFile: '' } });
  app.store.putTask(pending('other-pending', 'other')); app.store.putTask(pending('same-pending', 'p'));
  const binding = { protocol: 'kernel:1' as const, repository: f.common, runId: source.raw.id, cardFile: source.file, ledger: source.ledger, taskId: source.ids[0]! };
  const wrongProject = pending('wrong-project', 'other'); wrongProject.worker!.batchFile = source.file; wrongProject.worker!.loop = binding; app.store.putTask(wrongProject);
  const wrongRun = pending('wrong-run', 'p'); wrongRun.worker!.batchFile = source.file; wrongRun.worker!.loop = { ...binding, runId: randomUUID() }; app.store.putTask(wrongRun);
  let page = await app.router.tasks.loopPage([]) as any, failed = page.batches.find((row: any) => row.ok === false);
  assert.ok(failed); assert.equal(failed.lastConfirmed, null); assert.match(failed.lastConfirmedScope, /没有可核对/);
  for (const id of ['other-pending', 'same-pending', 'wrong-project', 'wrong-run']) assert.equal(JSON.stringify(page).includes(`PRIVATE_${id}`), false);
  const matching = pending('matching-source', 'p'); matching.worker!.batchFile = source.file; matching.worker!.loop = binding;
  matching.status = 'paused'; matching.goal = '原执行的可靠目标'; matching.lastVerifiedAt = '2026-01-01T00:00:00.000Z'; app.store.putTask(matching);
  page = await app.router.tasks.loopPage([], undefined, 0, 10, page.retryCursor) as any; failed = page.batches.find((row: any) => row.ok === false);
  assert.equal(failed.lastConfirmed.id, matching.id); assert.equal(failed.lastConfirmed.lastVerifiedAt, matching.lastVerifiedAt); assert.equal(failed.lastConfirmed.goal, matching.goal);
  source.raw.id = randomUUID(); await source.publish(); // Same ledger path, different run identity.
  page = await app.router.tasks.loopPage([], undefined, 0, 10, page.retryCursor) as any;
  assert.equal(page.batches.find((row: any) => row.ok === false).lastConfirmed, null);
  await writeFile(source.ledger, '{');
  page = await app.router.tasks.loopPage([], undefined, 0, 10, page.retryCursor) as any;
  assert.equal(page.batches.find((row: any) => row.ok === false).lastConfirmed, null);
  const original = await app.router.tasks.detail(matching.id, []) as any;
  assert.equal(original.ok, false); assert.equal(original.goal, matching.goal); assert.equal(original.lastVerifiedAt, matching.lastVerifiedAt);
  assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
});

test('integration seam: single-run queries preserve an exact source task and the private snapshot retains only ID/epoch index', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const source = await f.seed(1), app = await f.start(), card = app.store.task(app.store.taskTable()[0]!.id)!;
  const request: WorkerRequest = { id: 'sole-query', taskId: card.id, worker: 'loop', action: 'reply', lookupKernel: true, project: 'p', batchFile: source.file,
    loopBinding: { ...card.worker!.loop!, taskId: null }, stage: null, title: '', goal: '', completion: '', boundary: '', prompt: '', text: '', mode: 'resume', redLine: false, options: {} };
  const current = await app.router.workers.adapters.get('loop')!.status(request);
  assert.equal(current.loopBinding!.taskId, source.ids[0]);
  const index = card.verified!.snapshot as { tasks: unknown[] };
  assert.deepEqual(index.tasks, [{ id: source.ids[0], epoch: 0 }]);
  assert.equal(JSON.stringify(index).includes('SYNTHETIC_PRIVATE_SOURCE_BODY'), false);
  assert.equal(JSON.stringify(index).includes('processIdentity'), false);
});

test('integration seam: pending definition arguments are demand-only, tied to owner input and current material permission', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const app = await f.start(), source = join(f.repo, 'material.txt'); await writeFile(source, 'synthetic material');
  const origin = { id: 'owner-draft', source: 'feishu' as const, who: 'owner', chatType: 'p2p', messageId: 'owner-draft', at: new Date().toISOString(), text: '请保存构造材料，稍后补归属', attachments: [] };
  app.store.enqueue(origin); app.store.finish(origin.id);
  const args = { taskId: 'pending-definition', worker: 'pi', project: '', title: '保存构造材料', goal: '仅保存构造材料', completion: '核对产物', boundary: '不覆盖', prompt: 'DRAFT_ARGUMENTS_DEMAND_ONLY', options: JSON.stringify({ type: 'write', output: { kind: 'image', source } }) };
  const card = { id: args.taskId, title: args.title, goal: args.goal, completion: args.completion, boundary: args.boundary, status: 'waiting-project', waiting: '只缺项目', dispatches: [], conclusion: '', updated: origin.at, subscriptions: [], outputDraft: { sourceInput: origin.id, arguments: args } };
  app.store.putTask(card);
  const context = await app.router.tasks.context({ ...origin, id: 'unrelated', text: '查看当前摘要' });
  assert.equal(JSON.stringify(context).includes('DRAFT_ARGUMENTS_DEMAND_ONLY'), false);
  const detail = await app.router.tasks.detail(card.id, []) as any;
  assert.deepEqual(detail.outputDraft.arguments, args); assert.equal(detail.outputDraft.sourceInput, origin.id);
  f.config.readDeny.push(source);
  const denied = await app.router.tasks.detail(card.id, []) as any;
  assert.equal(denied.outputDraft.unavailable, true); assert.equal(JSON.stringify(denied).includes('DRAFT_ARGUMENTS_DEMAND_ONLY'), false);
  assert.equal(app.store.task(card.id)!.status, 'waiting-project'); assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
});

test('A9 exact protocol: an unseen precise kernel receipt is verified as kernel, not parsed as a legacy list', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const file = join(f.repo, 'lazy-card.json');
  await writeFile(file, JSON.stringify({ version: 1, flow: ['开发评审', '验收'], tasks: [{ name: '甲' }, { name: '乙' }] }));
  const snapshot = join(f.root, 'lazy-state.json');
  await writeFile(snapshot, JSON.stringify({ v: 1, batches: [{ kernel: true, runId: randomUUID(), project: f.repo, batch: { file, name: '精确查询来源' }, state: 'running', tasks: [{ id: 'a', name: '甲', active: false }, { id: 'b', name: '乙', active: true }], events: { lastSeq: 1 } }], test: { root: f.root, project: f.repo, workspace: f.repo, run: f.project.loopRunDirs[0] } }));
  f.config.loop.args = [resolve('scripts/loop-worker-stub.mjs'), '--state', snapshot, '--calls', join(f.root, 'lazy-calls.jsonl')];
  const app = await f.start(); assert.equal(app.store.taskTable().length, 0);
  const request: WorkerRequest = { id: 'precise-source', taskId: 'lookup-only', worker: 'loop', action: 'stop', lookupKernel: true, project: 'p', batchFile: file, sourceTaskId: 'a', stage: null, title: '', goal: '', completion: '', boundary: '', prompt: '', text: '', mode: 'resume', redLine: false, options: {} };
  const result = await app.router.workers.adapters.get('loop')!.status(request);
  assert.equal(result.loopBinding!.taskId, 'a'); assert.equal((result.data as any).kernel.tasks.find((task: any) => task.id === 'b').active, true);
  assert.equal(app.store.taskTable().length, 0, 'precise lookup is not automatic dispatch/attention');
  assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
});

for (const phase of ['decision', 'completion']) for (const order of ['before-read', 'after-read']) test(`A9 exactly once: one ${phase} source revision ${order}, separate original task facts and one Router turn`, async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const source = await f.seed(2), app = await f.start(), received: any[] = [];
  const before = app.store.taskTable().map(row => app.store.task(row.id)!);
  const intake = new Intake(f.config, app.store, app.router.files, input => { received.push(input); app.store.enqueue(input); }); t.after(() => intake.stop());
  source.raw.revision = 2; source.raw.taskRecords.forEach((record: any) => { delete record.activity; });
  source.row.status = phase === 'completion' ? '可合入' : '等你决定';
  source.row.tasks.forEach((record: any) => { record.activity = null; record.processIdentity = '无活动'; record.status = '等你决定'; record.reason = `构造 ${phase}`; }); await source.publish();
  if (order === 'before-read') await intake.scan();
  const selected = before[0]!, request: WorkerRequest = { id: 'observation-only', taskId: selected.id, worker: 'loop', action: 'reply', project: 'p', batchFile: source.file, loopBinding: selected.worker!.loop, stage: null, title: '', goal: '', completion: '', boundary: '', prompt: '', text: '', mode: 'resume', redLine: false, options: {} };
  await app.router.workers.adapters.get('loop')!.status(request); // A mechanical observer must not consume the normal cursor.
  for (const card of before) assert.equal(app.store.task(card.id)!.sourceRevision, 1);
  if (order === 'after-read') await intake.scan();
  assert.equal(received.length, 1); const event = received[0]!;
  app.store.start(event.id); assert.equal(await app.router.process(app.store.row(event.id)!, new AbortController().signal), 'done'); app.store.finish(event.id);
  const linked = app.store.match(event);
  assert.equal(linked.length, 2); assert.deepEqual(new Set(linked.map(card => card.id)), new Set(before.map(card => card.id)));
  for (const card of before) {
    const current = app.store.task(card.id)!; assert.equal(current.sourceRevision, 2); assert.equal(current.worker!.loop!.taskId, card.worker!.loop!.taskId);
    assert.equal(current.verified!.event, event.id); assert.equal((current.verified!.layers as any).businessAcceptance, '未验证');
  }
  const turns = f.model.requests.length; assert.equal(turns, 1);
  const context = JSON.parse(f.model.requests[0].body.messages.at(-2).content); assert.equal(context.matchedCards.length, 2);
  await intake.scan(); await app.router.process(app.store.row(event.id)!, new AbortController().signal);
  assert.equal(received.length, 1); assert.equal(f.model.requests.length, turns); assert.equal(f.feishu.messages.length, 0);
});

test('A9 source group failure: original task updates roll back together and retry only the same verification input', async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const source = await f.seed(2), app = await f.start(), received: any[] = [];
  const cards = app.store.taskTable().map(row => app.store.task(row.id)!);
  const intake = new Intake(f.config, app.store, app.router.files, input => { received.push(input); if (!app.store.enqueue(input)) app.store.retryLoopSource(input); }); t.after(() => intake.stop());
  source.raw.revision = 2; await source.publish(); await intake.scan(); assert.equal(received.length, 1); const event = received[0]!;
  app.store.db.exec(`CREATE TRIGGER group_save_failure BEFORE UPDATE ON tasks WHEN OLD.id='${cards[1]!.id}' BEGIN SELECT RAISE(ABORT,'constructed group save failure'); END;`);
  app.store.start(event.id); assert.equal(await app.router.workers.ingest(event), false); app.store.finish(event.id);
  assert.ok(cards.every(card => app.store.task(card.id)!.sourceRevision === 1)); assert.equal(app.store.get(`kernel:verification:${event.id}`, false), true);
  assert.equal(app.store.match(event).length, 1); assert.equal(f.model.requests.length, 0);
  app.store.db.exec('DROP TRIGGER group_save_failure'); await intake.scan(); assert.equal(received.length, 2); assert.equal(received[1]!.id, event.id);
  app.store.start(event.id); assert.equal(await app.router.process(app.store.row(event.id)!, new AbortController().signal), 'done'); app.store.finish(event.id);
  assert.ok(cards.every(card => app.store.task(card.id)!.sourceRevision === 2)); assert.equal(app.store.get(`kernel:verification:${event.id}`, true), false);
  assert.equal(f.model.requests.length, 1); await intake.scan(); assert.equal(received.length, 2);
});

for (const failure of ['none', 'query-restart', 'save-restart']) test(`review3 item 1: removed first task cannot block its siblings (${failure})`, async t => {
  const f = await sourceFixture(); t.after(() => f.close()); const source = await f.seed(3); let app = await f.start();
  const original = app.store.taskTable().map(row => app.store.task(row.id)!), first = original[0]!, siblings = original.slice(1), binding = first.worker!.loop!;
  first.goal = '保留原 A 业务目标'; first.subscriptions.push({ kind: 'message', value: 'original-A-message' }); app.store.putTask(first);
  const unresolved: WorkerOperation = { id: 'original-A-unresolved', thread: 'original-thread', tool: 'worker_reply', args: {}, token: 'original-token', state: 'uncertain', basis: { state: '进行中', fingerprint: 'original-basis', data: {} }, definition: '', needsApproval: true, reason: '原答复尚未核实',
    request: { id: 'original-A-unresolved', taskId: first.id, worker: 'loop', action: 'reply', project: 'p', batchFile: source.file, loopBinding: binding, stage: null, title: '', goal: '', completion: '', boundary: '', prompt: '', text: '继续', mode: 'resume', redLine: false, options: {} } };
  app.router.workers.journal.write(unresolved); app.router.workers.journal.retain(unresolved, ['original-A-resource']);
  const received: any[] = [], intake = new Intake(f.config, app.store, app.router.files, input => { received.push(input); if (!app.store.enqueue(input)) app.store.retryLoopSource(input); }); t.after(() => intake.stop());
  source.raw.revision = 2; source.raw.taskRecords[0].removed = true; source.raw.taskRecords[0].definition = source.raw.card.tasks[0]; source.raw.card.tasks = source.raw.card.tasks.slice(1);
  source.row.tasks = source.row.tasks.slice(1); await source.publish();
  const validRows = source.row.tasks;
  if (failure === 'query-restart') { source.row.tasks = []; await f.save(); }
  if (failure === 'save-restart') app.store.db.exec(`CREATE TRIGGER removal_save_failure BEFORE UPDATE ON tasks WHEN OLD.id='${siblings[0]!.id}' BEGIN SELECT RAISE(ABORT,'constructed removal save failure'); END;`);
  await intake.scan(); assert.equal(received.length, 1); const event = received[0]!;
  assert.equal(event.workerId, first.id, 'the queued representative really is the removed task');
  app.store.start(event.id);
  if (failure !== 'none') {
    assert.equal(await app.router.workers.ingest(event), false); app.store.finish(event.id);
    assert.ok(original.every(card => app.store.task(card.id)!.sourceRevision === 1));
    assert.notEqual(app.store.task(first.id)!.verified!.state, 'source-removed'); assert.equal(app.store.get(`kernel:verification:${event.id}`, false), true);
    if (failure === 'save-restart') app.store.db.exec('DROP TRIGGER removal_save_failure');
    await intake.stop(); await f.stop(); source.row.tasks = validRows; await f.save(); app = await f.start();
    await until(() => app.store.row(event.id)?.state === 'done' && siblings.every(card => app.store.task(card.id)!.sourceRevision === 2));
  } else {
    assert.equal(await app.router.process(app.store.row(event.id)!, new AbortController().signal), 'done'); app.store.finish(event.id);
  }
  const removed = app.store.task(first.id)!;
  assert.equal(removed.verified!.state, 'source-removed'); assert.equal(removed.status, 'incomplete'); assert.equal(removed.goal, first.goal);
  assert.deepEqual(removed.worker!.loop, binding); assert.ok(removed.subscriptions.some(s => s.value === 'original-A-message'));
  assert.equal((removed.verified!.layers as any).businessAcceptance, '未验证'); assert.equal((removed.verified!.layers as any).execution.stopped, '未核实');
  assert.ok(removed.dispatches.some((item: any) => item.state === 'source-removed'));
  assert.equal(app.store.boundLoopPage({ after: 0 }).cards.some(card => card.id === first.id), false);
  for (const card of siblings) { assert.equal(app.store.task(card.id)!.sourceRevision, 2); assert.deepEqual(app.store.task(card.id)!.worker!.loop, card.worker!.loop); }
  assert.equal(app.router.workers.operation(unresolved.id)!.state, 'uncertain'); assert.equal(app.router.workers.operation(unresolved.id)!.resourceState, 'held');
  assert.equal(app.store.get(`kernel:verification:${event.id}`, true), false); assert.equal(f.model.requests.length, 1);
  const removedHistory = JSON.stringify(removed.dispatches), removedAt = removed.lastVerifiedAt;
  const next: any[] = [], nextIntake = new Intake(f.config, app.store, app.router.files, input => { next.push(input); if (!app.store.enqueue(input)) app.store.retryLoopSource(input); }); t.after(() => nextIntake.stop());
  source.raw.revision = 3; await source.publish(); await nextIntake.scan(); assert.equal(next.length, 1);
  assert.notEqual(next[0].workerId, first.id, 'future wakeups must not repeatedly choose the removed task');
  app.store.start(next[0].id); assert.equal(await app.router.process(app.store.row(next[0].id)!, new AbortController().signal), 'done'); app.store.finish(next[0].id);
  assert.ok(siblings.every(card => app.store.task(card.id)!.sourceRevision === 3));
  assert.equal(JSON.stringify(app.store.task(first.id)!.dispatches), removedHistory); assert.equal(app.store.task(first.id)!.lastVerifiedAt, removedAt);
  assert.equal(f.model.requests.length, 2); await nextIntake.scan(); assert.equal(next.length, 1);
  const anchor = app.store.task(first.id)!;
  await assert.rejects(app.router.workers.adapters.get('loop')!.status({ ...unresolved.request, action: 'stop', sourceTaskId: siblings[0]!.worker!.loop!.taskId! }), /其他来源任务/);
  assert.deepEqual(app.store.task(first.id)!.worker!.loop, anchor.worker!.loop); assert.ok((await f.queryCalls()).every(call => call.args[0] === '查询'));
});
