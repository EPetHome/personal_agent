import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, link, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, instructionArgs, observationFixture, ownerInput, until } from './helpers.js';
import { Store } from '../src/store.js';
import { Files } from '../src/files.js';
import { Intake } from '../src/intake.js';
import { Workers, type WorkerOperation } from '../src/worker.js';
import { TaskContext } from '../src/task-context.js';
import { PiObservation, OBSERVATION_LEASE_MS } from '../src/pi-observation.js';
import { WorkTracking, executionKey, recordExecution } from '../src/work-tracking.js';
import { makeChannel } from '../src/channel.js';
import { hash } from '../src/util.js';
import { loadConfig } from '../src/config.js';
import { Router } from '../src/router.js';
import type { Script } from '../src/stubs/servers.js';
import type { TaskCard } from '../src/types.js';
import type { KernelFacts } from '../src/loop-kernel.js';

const card = (id: string): TaskCard => ({ id, title: '同名事项', goal: '原目标', completion: '原标准', boundary: '构造范围', status: 'running', waiting: '', conclusion: '', dispatches: [], subscriptions: [], updated: new Date().toISOString() });
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

test('A3: PA and independent Loop work keep task/source identities; second epoch keeps the first execution/result, no dispatch', async t => {
  const f = await fixture(); t.after(() => f.close()); const store = new Store(f.config); t.after(() => store.close());
  await writeFile(join(f.project, 'readme.txt'), 'synthetic'); git(f.project, 'init', '-b', 'dev'); git(f.project, 'add', '.'); git(f.project, 'commit', '-m', 'fixture');
  const common = git(f.project, 'rev-parse', '--path-format=absolute', '--git-common-dir'), project = f.config.projects[0]!;
  const files = new Files(f.config, store), workers = new Workers(f.config, store, await makeChannel(f.config), files);
  const facts = (runId: string, epoch = 0): KernelFacts => ({ binding: { protocol: 'kernel:1', repository: common, runId, cardFile: join(project.root, `${runId}.json`), ledger: join(project.loopRunDirs[0]!, `${runId}.json`), taskId: null }, project: project.root, revision: epoch + 1, name: '同名事项', state: '进行中', reason: '', node: '开发评审', tasks: [{ id: 'source-task', name: '同名事项', state: '进行中', node: '开发评审', reason: '', active: true, waiting: false, activityKind: 'developing', processIdentity: '存活', epoch, integrated: false, release: {}, counters: {} }], candidate: null, checks: [], missing: [], publication: null, acceptanceItems: [], results: [], release: null, evidence: {}, verifiedAt: new Date().toISOString(), flow: ['开发评审'], executionEnded: false });
  const first = facts('pa-run'), original = card('pa-original'); original.worker = { kind: 'loop', project: 'p', batchFile: first.binding.cardFile, loop: { ...first.binding, taskId: 'source-task' }, origin: 'pa' }; store.putTask(original);
  workers.adapters.set('loop', { kind: 'loop', async status(r) { const current = facts(r.loopBinding!.runId, r.loopBinding!.runId === 'pa-run' ? 1 : 0); return { state: current.state, fingerprint: 'fixture', loopBinding: r.loopBinding, data: { kernel: current } }; }, async dispatch() { assert.fail('must never redispatch independent work'); }, async stop() { assert.fail('must not stop'); }, async reply() { assert.fail('must not reply'); }, async progress(e) { return e; }, async ask(e) { return e; }, async result() { return false; } });
  await workers.status(original.id);
  const independent = workers.observeLoop(facts('owner-run'))[0]!;
  assert.notEqual(independent.id, original.id); assert.equal(independent.worker!.origin, 'owner-loop'); assert.equal(store.task(original.id)!.worker!.origin, 'pa');
  const old = store.task(original.id)!.work!.executions[0]!;
  recordExecution(store, original.id, { ...old, result: { summary: '第一次执行结果', refs: [], verified: true } });
  const next = { ...old, executionId: 'second-epoch', revision: 1, state: 'settled', result: { summary: '第二次执行结果', refs: [], verified: false } }; next.key = executionKey(next);
  recordExecution(store, original.id, next);
  const tasks = new TaskContext(f.config, store, files, workers), page = await tasks.executionPage(original.id);
  assert.equal(page.total, 2); assert.equal(page.currentExecution, next.key); assert.equal(page.rows[0]!.result!.summary, '第一次执行结果');
  assert.equal(store.taskTable().length, 2);
  await assert.rejects(async () => recordExecution(store, independent.id, next), /另一事项/);
  const input = ownerInput(store, 'organize', `将 ${original.id} 归到业务项目报告`);
  await tasks.work.organize(original.id, { kind: 'project', id: 'business-report', resources: ['p'] }, input, instructionArgs(input));
  assert.equal(store.task(original.id)!.worker!.project, 'p');
  await assert.rejects(tasks.work.organize(original.id, { kind: 'project', id: 'other', resources: ['new-permission'] }, input, instructionArgs(input)), /不产生权限/);
});

test('A8: no-Git local search is immediate; cross-turn local text delivery retains original task and exact material versions', async t => {
  const f = await fixture(); t.after(() => f.close()); f.config.projects[0]!.loopRunDirs = [];
  const a = join(f.config.projects[0]!.root, 'meeting-a.txt'), b = join(f.config.projects[0]!.root, 'meeting-b.txt');
  await writeFile(a, '会议甲：预算100，负责人甲。'); await writeFile(b, '会议乙：预算200，负责人乙。');
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ turns: [
    [{ tools: [{ name: 'search_files', arguments: { path: f.config.projects[0]!.root, query: '预算' } }] }, { tools: [{ name: 'reply', arguments: { text: '已查获准本地材料。' } }] }, { text: 'done' }],
    [{ tools: [{ name: 'read_file', arguments: { path: a } }] }, { tools: [{ name: 'record_local_work', arguments: { id: 'minutes', title: '会议比较', goal: '比较两次会议', completion: '文本结论及依据', boundary: '本地材料不对外发送', state: 'working', instructionInput: 'feishu:office-start', instruction: '整理这两份会议比较，先登记本次事项' } }] }, { tools: [{ name: 'reply', arguments: { text: '已登记本次本地事项。' } }] }, { text: 'done' }],
    [{ tools: [{ name: 'read_file', arguments: { path: a } }, { name: 'read_file', arguments: { path: b } }] }, { tools: [{ name: 'record_local_work', arguments: { id: 'minutes', title: '会议比较', goal: '比较两次会议', completion: '文本结论及依据', boundary: '本地材料不对外发送', state: 'delivered', summary: '预算由100变为200，负责人甲变为乙。', instructionInput: 'feishu:office-done', instruction: '完成 minutes 并保留会议依据' } }] }, { tools: [{ name: 'reply', arguments: { text: '已记录本轮文本结果与依据；未对外发送。' } }] }, { text: 'done' }],
    [{ tools: [{ name: 'get_task', arguments: { id: 'minutes' } }] }, { tools: [{ name: 'reply', arguments: { text: '原事项依据可追问。' } }] }, { text: 'done' }],
  ] }) });
  let app = await f.start(); await f.inject({ id: 'immediate', text: '查本地预算' }); await until(() => app.store.row('feishu:immediate')?.state === 'done'); assert.equal(app.store.taskTable().length, 0);
  await f.inject({ id: 'office-start', text: '整理这两份会议比较，先登记本次事项' }); await until(() => app.store.row('feishu:office-start')?.state === 'done');
  await f.stop(); app = await f.start();
  await f.inject({ id: 'office-done', text: '完成 minutes 并保留会议依据' }); await until(() => app.store.row('feishu:office-done')?.state === 'done');
  assert.equal(app.store.taskTable().length, 1); const result = app.store.task('minutes')!;
  assert.equal(result.status, 'delivered'); assert.match(result.conclusion, /100变为200/); assert.equal(result.work!.executions.length, 2); assert.equal(result.work!.materials!.length, 2);
  assert.equal(result.work!.materials![0]!.sha256, hash(await readFile(a)));
  await f.inject({ id: 'office-evidence', text: 'minutes 依据是什么' }); await until(() => app.store.row('feishu:office-evidence')?.state === 'done');
  const detail = await app.router.tasks.detail('minutes', []); assert.equal(detail.ok, true); assert.equal((detail as any).work.executions.total, 2);
  const refs = await app.router.tasks.evidence('minutes', '', []) as any; assert.equal(refs.rows.filter((ref: { key: string }) => ref.key.startsWith('material-')).length, 2);
  await writeFile(a, '材料后来修改'); await assert.rejects(app.router.tasks.evidence('minutes', 'material-0', []), /版本已变化/);
  assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key GLOB 'worker:op:*'").get()!.n), 0);
});

test('A7: independent Pi V1 snapshots preserve sibling rounds, reject half/old/conflicting writes and retry a failed transaction', async t => {
  const f = await observationFixture(); t.after(() => f.close()); let app = await f.start();
  app.store.db.exec("CREATE TRIGGER fail_observed BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  const first = f.record({ subject: { title: '构造Pi工作', goal: '原目标' } }), path = await f.emit(first);
  await app.intake.scan(); assert.equal(app.store.taskTable().length, 0); assert.equal(Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key GLOB 'pi-observation:record:*'").get()!.n), 0);
  app.store.db.exec('DROP TRIGGER fail_observed'); await f.stop(); app = await f.start();
  assert.equal(app.store.taskTable().length, 1); const id = app.store.taskTable()[0]!.id, original = app.store.task(id)!;
  await app.intake.scan(); assert.equal(app.store.task(id)!.work!.executions.length, 1);
  await writeFile(path, '{"version":1,'); await app.intake.scan(); assert.equal(app.store.task(id)!.sourceRevision, 1); assert.equal(app.store.task(id)!.sourceHealth!.ok, false);
  await f.emit({ ...first, revision: 4, state: 'settled', outcome: 'completed', heartbeatAt: new Date().toISOString() }); await app.intake.scan();
  assert.equal(app.store.task(id)!.sourceRevision, 4); assert.equal(app.store.task(id)!.status, 'observing');
  await f.emit({ ...first, revision: 2, state: 'running' }); await app.intake.scan(); assert.equal(app.store.task(id)!.sourceRevision, 4);
  await f.emit({ ...first, revision: 4, state: 'closed' }); await app.intake.scan(); assert.equal(app.store.task(id)!.sourceCurrent!.state, 'settled');
  const sibling = f.record({ executionId: 'input-2', state: 'waiting' }); await f.emit(sibling); await app.intake.scan(); assert.equal(app.store.taskTable().length, 2);
  const session = f.record({ kind: 'session', executionId: null, state: 'idle' }); await f.emit(session); await app.intake.scan(); assert.equal(app.store.taskTable().length, 2);
  await assert.rejects(app.router.workers.prepare('no-control', 'worker_stop', { taskId: id }), /只有观察能力/);
  const rawCount = Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key GLOB 'pi-observation:record:*'").get()!.n); assert.equal(rawCount, 3);
  assert.equal(original.id, id); assert.equal(app.router.workers.pi.jobs().length, 0);
});

test('A7: lease loss marks unknown, not failed; result references require current grant and exact content version; revoke hides caches/window', async t => {
  const f = await observationFixture(); t.after(() => f.close()); const evidence = join(f.config.projects[0]!.root, 'result.txt'); await writeFile(evidence, '构造结果');
  await f.emit(f.record({ subject: { title: 'ALLOWED_TITLE_BEFORE_REVOKE', goal: '目标' }, state: 'settled', result: { summary: '来源自述，不等于交付', refs: [{ path: evidence, sha256: hash(await readFile(evidence)) }] } }));
  const app = await f.start(), id = app.store.taskTable()[0]!.id;
  const result = await app.router.tasks.evidence(id, '0', []) as any; assert.equal(result.content, '构造结果');
  await writeFile(evidence, '结果后来变化'); await assert.rejects(app.router.tasks.evidence(id, '0', []), /内容版本已变化/);
  const now = Date.now(), clock = t.mock.method(Date, 'now', () => now + OBSERVATION_LEASE_MS + 1); await app.intake.scan();
  const view = await app.router.tasks.observations.view(app.store.task(id)!); assert.equal(view.ok, false); assert.equal((view as any).state, 'unknown'); assert.equal(app.store.task(id)!.status, 'observing'); clock.mock.restore();
  // Associate the old raw window with the source, then revoke. Originals remain stored.
  app.store.addWindow('old-observed', 1, 'assistant', 'ALLOWED_TITLE_BEFORE_REVOKE'); app.store.set('window:observation:old-observed', { [f.source.id]: hash(JSON.stringify(f.source)) });
  f.source.enabled = false; await app.intake.scan();
  await assert.rejects(app.router.tasks.detail(id, []), /未获准或已撤销/);
  const context = await app.router.context({ id: 'new', source: 'feishu', who: 'owner', text: '你好', at: '', attachments: [] });
  assert.equal(JSON.stringify(context).includes('ALLOWED_TITLE_BEFORE_REVOKE'), false); assert.ok(app.store.window().some(row => row.text.includes('ALLOWED_TITLE_BEFORE_REVOKE')));
  assert.equal((await app.router.tasks.observations.page()).registered, 0); assert.equal((await app.router.tasks.context({ id: 'q', source: 'feishu', who: 'owner', at: '', text: '', attachments: [] })).total, 0);
});

for (const bad of ['unknown-source', 'foreign-cwd', 'extra-field', 'subject-denied', 'ref-outside', 'symlink', 'hardlink', 'owner', 'oversize']) test(`A7 boundary rejects ${bad} without source titles/counts`, async t => {
  const f = await observationFixture(); t.after(() => f.close());
  const r = f.record({ subject: { title: 'NOT_DISCLOSED', goal: 'private' } });
  if (bad === 'unknown-source') r.sourceId = 'unregistered';
  if (bad === 'foreign-cwd') r.cwd = f.root;
  if (bad === 'extra-field') (r as any).transcript = 'NOT_DISCLOSED';
  if (bad === 'subject-denied') f.source.allowSubject = false;
  if (bad === 'ref-outside') r.result = { summary: 'NOT_DISCLOSED', refs: [{ path: join(f.root, 'outside.txt'), sha256: hash('x') }] };
  const path = await f.emit(r);
  if (bad === 'symlink' || bad === 'hardlink') { const moved = `${path}.original`; await rename(path, moved); if (bad === 'symlink') await symlink(moved, path); else await link(moved, path); }
  if (bad === 'owner') f.source.ownerUid++;
  if (bad === 'oversize') await writeFile(path, 'x'.repeat(65537));
  const app = await f.start(); assert.equal(app.store.taskTable().length, 0); assert.equal((await app.router.tasks.observations.page()).registered, 0);
  assert.equal(JSON.stringify(await app.router.context({ id: 'x', source: 'feishu', who: 'owner', at: '', text: '', attachments: [] })).includes('NOT_DISCLOSED'), false);
});

test('A7 timing: native notification verifies within 10 seconds; default missed-notice fallback is 60 seconds and within 90-second bound', async t => {
  const f = await observationFixture(true); t.after(() => f.close()); const app = await f.start(), began = Date.now();
  await f.emit(); await until(() => app.store.taskTable().length === 1, 10_000); assert.ok(Date.now() - began < 10_000);
  await f.stop(); f.config.intake.watch = false;
  const store = new Store(f.config), intake = new Intake(f.config, store, new Files(f.config, store), () => {}); t.after(async () => { await intake.stop(); store.close(); });
  const original = globalThis.setInterval, timers: { ms: number; run: () => unknown }[] = [];
  const spy = t.mock.method(globalThis, 'setInterval', (run: () => unknown, ms: number) => { timers.push({ ms, run }); return original(run, ms); });
  await intake.start(); spy.mock.restore();
  await f.emit(f.record({ executionId: 'missed-notification' })); const before = Date.now(); await timers[0]!.run();
  assert.equal(timers[0]!.ms, 60_000); assert.equal(store.taskTable().length, 2); assert.ok(timers[0]!.ms + Date.now() - before < 90_000);
});

test('A7 config validates explicit source/field/owner/cwd scopes; metadata does not grant ordinary file reads', async t => {
  const f = await observationFixture(); t.after(() => f.close()); const configFile = join(f.root, 'observation-config.json');
  await writeFile(configFile, JSON.stringify({ ...f.raw, timeZone: 'America/New_York', piObservation: { sources: [f.source] } }));
  const c = await loadConfig(configFile); assert.equal(c.piObservation!.sources[0]!.id, f.source.id);
  const store = new Store(c); t.after(() => store.close()); const path = await f.emit(); assert.equal((await new Files(c, store).read(path, [])).ok, false);
  await writeFile(configFile, JSON.stringify({ ...f.raw, piObservation: { sources: [{ ...f.source, project: 'foreign' }] } })); await assert.rejects(loadConfig(configFile), /须明确/);
  await writeFile(configFile, JSON.stringify({ ...f.raw, timeZone: 'not-a-zone' })); await assert.rejects(loadConfig(configFile), /timeZone/);
});

test('A9: additive KV upgrade preserves old IDs, confirmations, messages, subscriptions and unresolved leases; whole-directory restore continues original identities', async t => {
  const f = await fixture({ flow: [{ tools: [{ name: 'reply', arguments: { text: '构造回复' } }] }, { text: 'done' }] }); t.after(() => f.close()); let app = await f.start();
  const old = card('old-task'); old.subscriptions = [{ kind: 'loop', value: 'old-source' }, { kind: 'message', value: 'old-message' }]; old.dispatches = [{ id: 'old-op', result: '原结果' }]; app.store.putTask(old);
  const input = ownerInput(app.store, 'old-confirmation', '原本人指令'); app.store.wait(input.id);
  const op: WorkerOperation = { id: 'old-op', token: 'old-token', thread: input.id, tool: 'worker_dispatch', args: { taskId: old.id }, request: { id: 'old-op', taskId: old.id, worker: 'constructed', action: 'dispatch', project: 'p', batchFile: 'old-batch', stage: null, title: old.title, goal: old.goal, completion: old.completion, boundary: old.boundary, prompt: '', text: '', mode: 'resume', redLine: false, options: {} }, state: 'uncertain', basis: { state: 'unknown', fingerprint: 'old-basis', data: {} }, definition: 'old-definition', needsApproval: true, reason: '原调用未知', resources: ['fixture-resource'], resourceState: 'held' };
  app.router.workers.journal.write(op); app.router.workers.journal.retain(op, op.resources!);
  app.store.set('worker:token:old-token', 'old-op');
  app.store.set('worker:pending:old-task', 'old-op');
  const pendingCard = { ...card('old-awaiting-task'), status: 'waiting-approval', subscriptions: [{ kind: 'message' as const, value: 'old-approval-message' }] }; app.store.putTask(pendingCard);
  const pendingInput = ownerInput(app.store, 'old-awaiting-input', '旧的待确认委托'); app.store.wait(pendingInput.id);
  const planned: WorkerOperation = { ...op, id: 'old-awaiting-op', token: 'old-awaiting-token', thread: pendingInput.id, state: 'planned', args: { taskId: pendingCard.id }, request: { ...op.request, id: 'old-awaiting-op', taskId: pendingCard.id, batchFile: '' }, resources: undefined, resourceState: undefined };
  app.router.workers.journal.write(planned); app.store.set(`worker:group:${pendingInput.id}`, { operations: [planned.id] }); app.store.set(`worker:token:${planned.token}`, planned.id); app.store.set(`worker:pending:${pendingCard.id}`, planned.id);
  app.store.db.prepare("INSERT INTO outbox(id,input_id,text,state,message_id) VALUES(?,?,?,?,?)").run('old-delivery', input.id, '原消息', 'sent', 'old-message');
  await f.stop(); const backup = join(f.root, 'restore-image'); await cp(f.config.dataDir, backup, { recursive: true });
  app = await f.start(); assert.equal(app.store.get('worker:token:old-token', 'absent'), 'old-op'); assert.equal(app.store.task(old.id)!.dispatches.length, 1); assert.equal(app.store.row(input.id)!.state, 'waiting');
  assert.equal(app.router.workers.journal.unresolved(old.id)[0], 'old-op');
  assert.deepEqual(app.router.workers.journal.owners(['fixture-resource']), ['old-op']);
  assert.equal(app.router.attention.rules().length, 0, 'legacy subscriptions never become permanent attention');
  assert.equal(app.router.workers.operation(planned.id)!.state, 'planned'); assert.equal(app.store.row(pendingInput.id)!.state, 'waiting');
  const work = new WorkTracking(f.config, app.store, app.router.files), correction = ownerInput(app.store, 'new-source', '将 old-task 归入个人事项');
  await work.organize(old.id, { kind: 'personal', resources: [] }, correction, instructionArgs(correction));
  await f.stop(); await rm(f.config.dataDir, { recursive: true }); await cp(backup, f.config.dataDir, { recursive: true }); app = await f.start();
  assert.equal(app.store.row(input.id)!.state, 'waiting');
  assert.equal(app.store.row(pendingInput.id)!.state, 'waiting'); assert.equal(app.router.workers.operation(planned.id)!.token, 'old-awaiting-token'); assert.equal(app.router.workers.operation(planned.id)!.state, 'planned');
  assert.equal(app.store.task(old.id)!.work, undefined); assert.equal(app.store.task(old.id)!.subscriptions.length, 2); assert.equal(app.store.replies(input.id)[0]!.message_id, 'old-message'); assert.equal(app.router.workers.operation('old-op')!.token, 'old-token'); assert.equal(app.router.workers.journal.unresolved(old.id)[0], 'old-op');
});

test('A7 recovery: empty export root is not connected; settled history is consumed quietly across repeated scans/restart; selected read gets current version', async t => {
  const f = await observationFixture(); t.after(() => f.close()); let app = await f.start();
  const empty = await app.router.tasks.observations.page(); assert.equal(empty.total, null); assert.equal(empty.partial, true);
  await f.stop(); await f.emit(f.record({ state: 'settled', subject: { title: '原停稳', goal: '目标' } })); app = await f.start();
  await app.intake.scan(); await app.intake.scan(); assert.equal(f.model.requests.length, 0, 'no historical reminder on the next fallback');
  const id = app.store.taskTable()[0]!.id;
  await f.emit(f.record({ state: 'waiting', revision: 2, subject: { title: '当前交互', goal: '新目标' } }));
  const detail = await app.router.tasks.detail(id, []) as any; assert.equal(detail.observation.state, 'waiting'); assert.equal(detail.sourceRevision, 2); assert.equal(detail.observation.revision, 2); assert.equal(detail.title, '当前交互');
  await f.stop(); app = await f.start(); await app.intake.scan(); assert.equal(f.model.requests.length, 0);
});

test('A7: narrowed field grants withhold old bodies until a valid new metadata record; source stop/resume intervals persist', async t => {
  const f = await observationFixture(); t.after(() => f.close());
  await f.emit(f.record({ subject: { title: 'OLD_PRIVATE_TITLE', goal: 'OLD_PRIVATE_GOAL' }, result: { summary: 'OLD_PRIVATE_RESULT', refs: [] } }));
  const app = await f.start(), id = app.store.taskTable()[0]!.id;
  f.source.allowSubject = false; f.source.allowResult = false;
  await assert.rejects(app.router.tasks.detail(id, []), /授权已变/);
  await f.emit(f.record({ revision: 2 })); await app.intake.scan();
  const metadata = await app.router.tasks.detail(id, []); assert.equal(JSON.stringify(metadata).includes('OLD_PRIVATE'), false);
  f.source.enabled = false; await app.intake.scan();
  f.source.enabled = true; await app.intake.scan();
  const intervals = app.store.get<Record<string, { intervals: { from: string; to: string | null }[] }>>('pi-observation:enabled', {})[f.source.id]!.intervals;
  assert.ok(intervals.length >= 3); assert.ok(intervals.at(-2)!.to); assert.equal(intervals.at(-1)!.to, null);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM inputs WHERE json_extract(body,'$.raw.observation')=1").get()!.n, 0);
});

test('A7 bounded scan: more than one page preserves every round, paginates demand reads and bounds lease-loss work', async t => {
  const f = await observationFixture(); t.after(() => f.close());
  for (let n = 0; n < 53; n++) await f.emit(f.record({ executionId: `round-${n}` }));
  const app = await f.start(); await until(() => app.store.taskTable().length === 53);
  const first = await app.router.tasks.observations.page(0, 10), second = await app.router.tasks.observations.page(10, 10);
  assert.equal(first.registered, 53); assert.equal(first.count, 10); assert.equal(first.hasMore, true); assert.ok(!second.rows.some(r => first.rows.some(old => old.key === r.key)));
  const id = app.store.taskTable()[0]!.id, verified = app.store.task(id)!.lastVerifiedAt, now = Date.now(); const clock = t.mock.method(Date, 'now', () => now + OBSERVATION_LEASE_MS + 10);
  await app.intake.scan(); await until(() => app.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE json_extract(body,'$.sourceHealth.ok')=0").get()!.n === 53);
  assert.equal(app.store.task(id)!.lastVerifiedAt, verified); assert.equal((await app.router.tasks.observations.page()).total, null); clock.mock.restore();
});

test('A3: explicit owner correction links a second independent execution, while old sibling heartbeats never replace the selected current execution or owner goal', async t => {
  const f = await observationFixture(); t.after(() => f.close());
  const first = f.record({ executionId: 'first', state: 'settled', subject: { title: '同名', goal: '原事项目标' } });
  const second = f.record({ executionId: 'second', subject: { title: '同名', goal: '来源的后续说明' } });
  await f.emit(first); await f.emit(second); const app = await f.start();
  const cards = app.store.taskTable().map(row => app.store.task(row.id)!);
  const original = cards.find(c => c.work!.executions[0]!.executionId === 'first')!, next = cards.find(c => c.id !== original.id)!;
  const source = ownerInput(app.store, 'correct-identity', `把 ${next.id} 关联到 ${original.id}，这是同一事项的新执行`);
  await app.router.tasks.work.link(next.id, original.id, source, instructionArgs(source));
  await f.emit({ ...first, revision: 2, state: 'running', heartbeatAt: new Date().toISOString() }); await app.intake.scan();
  const current = app.store.task(original.id)!;
  assert.equal(current.work!.executions.length, 2); assert.equal(current.work!.executions.find(e => e.key === current.work!.currentExecution)!.executionId, 'second');
  assert.equal(current.goal, '原事项目标'); assert.equal(current.sourceRevision, 1); assert.equal(app.store.taskTable().length, 1);
  assert.equal(app.store.task(next.id)!.status, 'closed'); assert.equal(app.router.workers.pi.jobs().length, 0);
});

test('assembly receiver probe consumes supplied sandbox V1 bytes without models, refuses existing state and non-sandbox config', async t => {
  const f = await observationFixture(); t.after(() => f.close()); await f.emit();
  const path = join(f.root, 'probe.json'); await writeFile(path, JSON.stringify({ ...f.raw, piObservation: { sources: [f.source] } }));
  const run = (...args: string[]) => execFileSync(process.execPath, [resolve('scripts/verify-work-tracking.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' });
  const result = JSON.parse(run('--config', path, '--expect-session', 'original-session'));
  assert.equal(result.ok, true); assert.equal(result.executions, 1); assert.equal(result.identities[0].sessionId, 'original-session');
  assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0);
  assert.throws(() => run('--config', path), /非空/);
  // A Loop checkout may itself be inside TMPDIR. Choose the child's permitted
  // temp root explicitly so this valid fixture config is unambiguously outside it.
  const restrictedTemp = join(f.root, 'probe-permitted-temp'); await mkdir(restrictedTemp);
  assert.throws(() => execFileSync(process.execPath, [resolve('scripts/verify-work-tracking.mjs'), '--config', path], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, TMPDIR: restrictedTemp } }), /只接受临时/);
  // Also exercise the isolated-checkout layout: being under TMPDIR must not
  // make the unconfigured example a connected/authorized observation source.
  assert.throws(() => execFileSync(process.execPath, [resolve('scripts/verify-work-tracking.mjs'), '--config', resolve('config.example.json')], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, TMPDIR: process.cwd() } }), /显式观察来源/);
});

test('A7 current denies: a single record deny hides its cached identity/count, root deny disables the source without reading old bodies', async t => {
  const f = await observationFixture(); t.after(() => f.close()); const path = await f.emit(f.record({ subject: { title: 'DENIED_RECORD_TITLE', goal: '构造目标' } })); const app = await f.start(), id = app.store.taskTable()[0]!.id;
  f.config.readDeny.push(path);
  await assert.rejects(app.router.tasks.detail(id, []), /已被拒读/);
  assert.equal((await app.router.tasks.context({ id: 'q', source: 'feishu', who: 'owner', at: '', text: '', attachments: [] })).total, 0);
  const page = await app.router.tasks.observations.page(); assert.equal(page.registered, 0); assert.equal(page.total, null); assert.equal(page.partial, true);
  assert.equal(JSON.stringify(await app.router.context({ id: 'q', source: 'feishu', who: 'owner', at: '', text: '', attachments: [] })).includes('DENIED_RECORD_TITLE'), false);
  f.config.readDeny.length = 0; f.config.readDeny.push(f.source.exportRoot);
  await assert.rejects(app.router.tasks.detail(id, []), /已撤销/); assert.equal((await app.router.tasks.observations.page()).registered, 0);
});

test('A7 observation roots are protocol-only even inside an ordinary project, and remain denied after the source is removed', async t => {
  const f = await observationFixture(); t.after(() => f.close());
  f.source.exportRoot = join(f.config.projects[0]!.root, 'pi-export'); await mkdir(f.source.exportRoot);
  const path = await f.emit(f.record({ subject: { title: 'NO_GENERIC_BYPASS', goal: '来源限定内容' } })); const app = await f.start();
  assert.equal(app.store.taskTable().length, 1); assert.equal((await app.router.files.read(path, [])).ok, false);
  const listing = await app.router.files.list(f.config.projects[0]!.root); assert.ok(listing.ok); if ('entries' in listing) assert.ok(!listing.entries.some(e => e.path === f.source.exportRoot));
  f.config.piObservation!.sources = []; await app.intake.scan();
  assert.equal((await app.router.files.read(path, [])).ok, false); assert.equal((await app.router.tasks.observations.page()).registered, 0);
  assert.ok(app.store.get<string[]>('pi-observation:private-roots', []).includes(f.source.exportRoot));
});

test('A7 timing: a blocked Loop discovery lane cannot delay a healthy Pi file notification', async t => {
  const f = await observationFixture(true); t.after(() => f.close()); const app = await f.start();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(app.intake.discovery!, 'scan', async () => { entered(); await held; return false; });
  const pending = app.intake.scan();
  try {
    await began; const at = Date.now(); await f.emit();
    await until(() => app.store.taskTable().length === 1, 2000);
    assert.ok(Date.now() - at < 10_000); assert.equal(f.model.requests.length, 0); assert.equal(app.router.workers.pi.jobs().length, 0);
  } finally { release(); await pending; }
});

for (const targetHasWorker of [false, true]) test(`R1.3 Pi: running original receipts route to a ${targetHasWorker ? 'worker-backed' : 'plain'} business task without changing operations or original messages`, async t => {
  const f = await fixture({ flow: [{ text: '构造静默' }] }, { intake: { watch: false, fallbackMs: 60_000 } });
  let app: Awaited<ReturnType<typeof f.start>>;
  t.after(async () => {
    if (app) {
      for (const job of app.router.workers.pi.jobs()) if (['queued', 'launching', 'running'].includes(job.state)) await app.router.workers.pi.stop({ ...job.request, action: 'stop', batchFile: job.id });
      await until(() => app.router.workers.pi.jobs().every(job => !['queued', 'launching', 'running'].includes(job.state)), 10_000);
    }
    await f.close();
  });
  const control = join(f.root, 'pi-control.json'), calls = join(f.root, 'pi-calls.jsonl'), evidence = join(f.config.projects[0]!.root, 'linked-result.txt');
  await writeFile(evidence, '实际构造结果材料'); await writeFile(control, JSON.stringify({ delayMs: 1600, summary: 'LINKED_PI_RESULT', evidence: [evidence] }));
  Object.assign(f.config.pi, { command: process.execPath, args: [resolve('scripts/pi-worker-stub.mjs'), '--control', control, '--calls', calls], pollMs: 40, startupMs: 500 });
  app = await f.start(); const sourceId = 'running-pi-anchor', targetId = 'business-pi-target';
  const instruction = ownerInput(app.store, 'start-linked-pi', '请读取授权项目并给出构造结果');
  const args = { ...instructionArgs(instruction), taskId: sourceId, worker: 'pi', project: 'p', title: '原 Pi 委托', goal: '核对构造材料', completion: '给出结果及依据', boundary: '只读、不联网、不运行命令', prompt: '核对构造材料', options: '{"type":"read"}' };
  await app.router.workers.execute(instruction.id, 'worker_dispatch', args);
  await until(() => app.router.workers.pi.jobs()[0]?.state === 'running');
  const job = app.router.workers.pi.jobs()[0]!, originalMessage = f.feishu.messages.find(m => m.key === `task-message:${sourceId}`)!;
  const op = app.router.workers.operation(job.id)!, before = JSON.stringify(op), resources = op.resources;
  let targetJobId: string | undefined;
  if (targetHasWorker) {
    await until(async () => (await readFile(calls, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e; })).includes('"event":"start"'));
    await writeFile(control, JSON.stringify({ delayMs: 450, summary: 'EARLIER_TARGET_RESULT', evidence: [evidence] }));
    const targetInstruction = ownerInput(app.store, 'start-target-pi', '请读取授权项目并给出另一份构造结果');
    await app.router.workers.execute(targetInstruction.id, 'worker_dispatch', { ...args, ...instructionArgs(targetInstruction), taskId: targetId, title: '业务归属事项' });
    targetJobId = app.store.task(targetId)!.worker!.batchFile;
  } else app.store.putTask({ ...card(targetId), title: '业务归属事项', status: 'working' });
  const correction = ownerInput(app.store, 'link-running-pi', `把 ${sourceId} 关联到 ${targetId}，保留原执行`);
  await app.router.tasks.work.link(sourceId, targetId, correction, instructionArgs(correction));
  assert.equal(app.store.task(sourceId)!.status, 'running'); assert.equal(app.store.task(sourceId)!.work!.linkedTo, targetId);
  assert.equal(JSON.stringify(app.router.workers.operation(job.id)), before); assert.deepEqual(app.router.workers.operation(job.id)!.resources, resources);
  assert.equal(app.router.workers.pi.job(job.id)!.task, sourceId); assert.equal(app.router.workers.pi.jobs().length, targetHasWorker ? 2 : 1);
  if (targetJobId) {
    await until(() => app.store.row(`pi:${targetJobId}:result`)?.state === 'done');
    assert.equal(app.store.workTask(targetId)!.status, 'running', 'an older target runtime receipt must not replace the selected incoming execution');
    assert.equal(app.store.workTask(targetId)!.work!.executions.find(e => e.executionId === targetJobId)!.result!.summary, 'EARLIER_TARGET_RESULT');
  }
  await until(() => app.store.row(`pi:${job.id}:result`)?.state === 'done', 10_000);
  const target = app.store.workTask(targetId)!;
  assert.equal(target.conclusion, 'LINKED_PI_RESULT'); assert.equal(target.sourceCurrent!.state, 'done'); assert.equal(target.work!.executions.find(e => e.key === target.work!.currentExecution)!.originTaskId, sourceId);
  assert.equal(target.work!.executions.find(e => e.executionId === job.id)!.result!.refs[0]!.sha256, hash(await readFile(evidence)));
  assert.deepEqual(app.store.match({ id: 'quote-original', source: 'feishu', who: 'owner', text: '', at: '', attachments: [], quoteId: originalMessage.id }).map(c => c.id), [targetId]);
  const detail = await app.router.tasks.detail(targetId, []) as any; assert.equal(detail.worker.originTaskId, sourceId); assert.equal(detail.layers.execution.result.summary, 'LINKED_PI_RESULT');
  const message = f.feishu.messages.find(m => m.key === `task-message:${sourceId}`)!; assert.equal(message.id, originalMessage.id); assert.match(message.text, /LINKED_PI_RESULT/); assert.match(message.text, /business-pi-target/);
  assert.equal((await readFile(calls, 'utf8')).split('\n').filter(line => line && JSON.parse(line).event === 'start').length, targetHasWorker ? 2 : 1);
  assert.equal(app.store.taskTable().length, 1);
});

test('R1.3 Loop: linking an original running PA Loop retains the runtime anchor and consumes a real kernel revision into the target', async t => {
  const f = await fixture({ flow: [{ text: '构造静默' }] }, { intake: { watch: false, fallbackMs: 60_000 } }); t.after(() => f.close());
  const project = f.config.projects[0]!, root = f.root, stateFile = join(root, 'loop.json'), calls = join(root, 'loop-calls.jsonl');
  await mkdir(join(project.root, 'code')); await writeFile(join(project.root, 'code/README.md'), 'synthetic'); await writeFile(join(project.root, '.gitignore'), '.autoreview.json\n'); await writeFile(join(project.root, '.autoreview.json'), '{"acceptance":{}}');
  git(project.root, 'init', '-b', 'dev'); git(project.root, 'add', '.'); git(project.root, 'commit', '-m', 'synthetic only');
  project.loop = { batchDir: join(project.root, 'docs/batches'), allow: ['code/'], deny: ['code/private/'] };
  const state: any = { v: 1, batches: [], test: { root, project: project.root, workspace: project.root, run: project.loopRunDirs[0] } }; await writeFile(stateFile, JSON.stringify(state));
  f.config.loop.args = [resolve('scripts/loop-worker-stub.mjs'), '--state', stateFile, '--calls', calls];
  const app = await f.start(), sourceId = 'running-loop-anchor', targetId = 'business-loop-target';
  const instruction = ownerInput(app.store, 'start-linked-loop', '请在 p 项目修改构造 code 标题');
  await app.router.workers.execute(instruction.id, 'worker_dispatch', { ...instructionArgs(instruction), taskId: sourceId, worker: 'loop', project: 'p', title: '原 Loop 委托', goal: '修改构造标题', completion: '技术结果及依据', boundary: '只改 code/，不合入、不推送', prompt: '修改构造标题' });
  const originalOp = app.router.workers.operation(app.store.task(sourceId)!.worker!.operation!)!;
  await app.router.workers.status(sourceId);
  const binding = app.store.task(sourceId)!.worker!.loop!; assert.ok(binding);
  const before = JSON.stringify(app.router.workers.operation(originalOp.id)), message = f.feishu.messages.find(m => m.key === `task-message:${sourceId}`)!;
  app.store.putTask({ ...card(targetId), title: '业务归属事项', status: 'working' });
  const correction = ownerInput(app.store, 'link-running-loop', `把 ${sourceId} 关联到 ${targetId}，保留原执行`); await app.router.tasks.work.link(sourceId, targetId, correction, instructionArgs(correction));
  assert.notEqual(app.store.task(sourceId)!.status, 'closed'); assert.equal(JSON.stringify(app.router.workers.operation(originalOp.id)), before);
  const current = JSON.parse(await readFile(stateFile, 'utf8')), batch = current.batches[0];
  batch.events.lastSeq += 1; batch.state = 'done'; batch.tasks = [{ id: binding.taskId ?? '开发', name: binding.taskId ?? '开发', active: false, state: 'done' }];
  const evidence = join(project.root, 'loop-result.txt'); await writeFile(evidence, '构造 Loop 结果');
  batch.results = [{ id: 'linked-loop-result', task: binding.taskId ?? '开发', node: '验收', status: 'completed', started: new Date().toISOString(), ended: new Date().toISOString(), evidence: [evidence] }];
  await writeFile(stateFile, JSON.stringify(current));
  execFileSync(process.execPath, [...f.config.loop.args, '查询', '--all', '--json'], { env: { PATH: process.env.PATH }, stdio: 'pipe' });
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'task_card', arguments: { id: sourceId, cause: '原内核结果已核实', assessment: '技术状态非业务验收', suggestion: '查看原结果' } }] }, { text: 'done' }] }) });
  await app.intake.scan(); await until(() => app.store.workTask(targetId)?.sourceRevision === batch.events.lastSeq, 10_000);
  const target = app.store.workTask(targetId)!;
  assert.ok((target.verified!.layers as any).results.some((r: any) => r.id === 'linked-loop-result'));
  assert.ok(target.work!.executions.some(e => e.originTaskId === sourceId && e.sourceResults?.some(r => r.id === 'linked-loop-result')), JSON.stringify({ source: app.store.task(sourceId)!.worker, refs: target.work!.executions }));
  await until(() => f.feishu.messages.find(m => m.key === `task-message:${sourceId}`)?.text.includes('linked-loop-result') === true, 10_000);
  assert.equal(f.feishu.messages.find(m => m.key === `task-message:${sourceId}`)!.id, message.id);
  assert.equal(app.router.workers.operation(originalOp.id)!.token, originalOp.token); assert.equal(app.router.workers.operation(originalOp.id)!.request.taskId, sourceId);
  const recorded = (await readFile(calls, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); assert.equal(recorded.filter(r => r.verb === '启动').length, 1);
  assert.equal(app.store.taskTable().filter(row => !row.id.startsWith('loop-')).length, 1);
});

for (const state of ['settled', 'waiting'] as const) for (const restart of [false, true]) test(`R1.4: queued ${state} notification survives a pure heartbeat${restart ? ' and restart' : ''}, then consumes latest facts exactly once`, async t => {
  const args: Record<string, unknown> = { fragments: '' }, read: Record<string, unknown> = { id: '' };
  const script: Script = { flow: [{ tools: [{ name: 'get_task', arguments: read }] }, { delayMs: 250, tools: [{ name: 'reply', arguments: args }] }, { text: 'done' }] };
  const f = await observationFixture(false, script); let store = new Store(f.config), observer = new PiObservation(f.config, store, new Files(f.config, store)), router = new Router(f.config, store, await makeChannel(f.config));
  t.after(async () => { await observer.stop(); router.close(); store.close(); await f.close(); });
  await observer.scan();
  const ruleOwner = ownerInput(store, 'future-rule', '继续看该来源未来工作，重要变化提醒');
  const rule = await router.attention.save({ ...instructionArgs(ruleOwner), kind: 'pi-observation', sourceId: f.source.id, notify: 'important' }, ruleOwner);
  await f.emit(); await observer.scan(); const id = store.taskTable()[0]!.id; read.id = id;
  const owner = ownerInput(store, 'once-before-queue', `跟踪 ${id} 本次结果，交付未知保持待核实`); await router.tasks.work.track(id, '核实原结果并回报', owner, instructionArgs(owner));
  const record = f.record({ revision: 2, state }); await f.emit(record); await observer.scan();
  const row = store.db.prepare("SELECT id FROM inputs WHERE json_extract(body,'$.raw.observation')=1").get()!;
  await f.emit({ ...record, revision: 3, heartbeatAt: new Date().toISOString() }); await observer.scan();
  if (restart) {
    const pause = ownerInput(store, 'pause-keep-once', '暂停未来关注，本次委托保留');
    assert.ok(router.attention.pause(rule.rule.id, pause, instructionArgs(pause)).retainedOneShots.includes(id));
    await observer.stop(); router.close(); store.close(); store = new Store(f.config); observer = new PiObservation(f.config, store, new Files(f.config, store)); router = new Router(f.config, store, await makeChannel(f.config)); await observer.scan();
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM inputs WHERE json_extract(body,'$.raw.observation')=1").get()!.n, 1);
  store.start(String(row.id)); const processing = router.process(store.row(String(row.id))!, new AbortController().signal);
  await until(() => f.model.requests.length >= 2);
  const tool = JSON.parse(f.model.requests[1].body.messages.filter((m: any) => m.role === 'tool').at(-1).content);
  assert.equal(tool.sourceRevision, 3); assert.equal(tool.sourceState, state);
  args.fragments = JSON.stringify([{ kind: 'notice', factId: tool.fact.id, certainty: 'current', text: '已核对最新构造运行事实，业务交付仍待核实。' }]);
  assert.equal(await processing, 'done'); store.finish(String(row.id));
  assert.equal(f.feishu.messages.length, 1); assert.ok(store.task(id)); assert.equal(store.task(id)!.work!.tracking!.state, 'active');
  await f.emit({ ...record, revision: 4, heartbeatAt: new Date().toISOString() }); await observer.scan();
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM inputs WHERE json_extract(body,'$.raw.observation')=1").get()!.n, 1); assert.equal(f.feishu.messages.length, 1);
});

for (const change of ['pause', 'revoke'] as const) test(`R1.4: queued notices recheck ${change} instead of reviving an obsolete reminder`, async t => {
  const f = await observationFixture(); const store = new Store(f.config), files = new Files(f.config, store), observer = new PiObservation(f.config, store, files), router = new Router(f.config, store, await makeChannel(f.config));
  t.after(async () => { await observer.stop(); router.close(); store.close(); await f.close(); });
  await observer.scan();
  const owner = ownerInput(store, 'watch-rule', '关注此来源未来工作，重要变化提醒');
  const rule = await router.attention.save({ ...instructionArgs(owner), kind: 'pi-observation', sourceId: f.source.id, notify: 'important' }, owner);
  await f.emit(); await observer.scan();
  const record = f.record({ revision: 2, state: 'waiting' }); await f.emit(record); await observer.scan();
  const row = store.db.prepare("SELECT id FROM inputs WHERE json_extract(body,'$.raw.observation')=1").get()!;
  await f.emit({ ...record, revision: 3, heartbeatAt: new Date().toISOString() }); await observer.scan();
  if (change === 'revoke') f.source.enabled = false;
  else { const pause = ownerInput(store, 'pause-before-consume', '暂停未来工作关注'); router.attention.pause(rule.rule.id, pause, instructionArgs(pause)); }
  store.start(String(row.id)); assert.equal(await router.process(store.row(String(row.id))!, new AbortController().signal), 'done'); store.finish(String(row.id));
  assert.equal(f.model.requests.length, 0); assert.equal(f.feishu.messages.length, 0); assert.equal(store.taskTable().length, 1);
});
