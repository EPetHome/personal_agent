import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, instructionArgs, observationFixture, ownerInput, until } from './helpers.js';
import type { Input, TaskCard, Turn } from '../src/types.js';
import { hash } from '../src/util.js';
import { observationGrant } from '../src/pi-observation.js';
import type { WorkerAdapter } from '../src/worker.js';
import type { App } from '../src/app.js';
import { executionKey } from '../src/work-tracking.js';
import { FACT_FRESH_MS } from '../src/reply-facts.js';
import { retainObservationGrants, turns } from '../src/context.js';

const card = (): TaskCard => ({ id: 'original', title: '原事项', goal: '原目标', completion: '交付', boundary: '授权范围', status: 'working', waiting: '', conclusion: '', dispatches: [], subscriptions: [{ kind: 'message', value: 'old-message' }], updated: new Date().toISOString(), sourceHealth: { ok: true, checkedAt: new Date().toISOString() }, lastVerifiedAt: new Date().toISOString() });
const turn = (input: Input): Turn => ({ input, materials: [], replied: false, call: 0, signal: new AbortController().signal });
const fragments = (kind: string, text: string, factId?: string, extra = {}) => ({ fragments: JSON.stringify([{ kind, text, factId, ...extra }]) });
const queriedFact = async (app: App, id: string, t: Turn) => app.router.replies.issue('get_task', { id }, await app.router.tasks.detail(id, t.materials, t.signal), t) as any;

test('A10: declared task facts require current-turn evidence even without taskId; stale/changed/unauthorized basis is rejected, valid relevant reply works', async t => {
  const f = await fixture(); t.after(() => f.close()); const app = await f.start(), task = card(); app.store.putTask(task);
  const input = ownerInput(app.store, 'asked', 'original 现在怎样'), current = turn(input);
  const result = await queriedFact(app, task.id, current);
  await assert.rejects(app.router.replies.send(fragments('task', '没有依据的事项'), current), /缺少本轮/);
  await assert.rejects(app.router.replies.send({ text: '省略依据', taskId: task.id }, current), /缺少本轮/);
  const other = turn(ownerInput(app.store, 'another', 'original 再问一次'));
  await assert.rejects(app.router.replies.send(fragments('task', '旧轮引用', result.fact.id), other), /缺少本轮/);
  const factKey = `reply:fact:${input.id}:${result.fact.id}`, saved = app.store.get<Record<string, unknown>>(factKey, {});
  app.store.set(factKey, { ...saved, issuedAt: new Date(Date.now() - 300_001).toISOString() });
  await assert.rejects(app.router.replies.send(fragments('task', '已过期', result.fact.id), current), /已过期/); app.store.set(factKey, saved);
  task.waiting = '新问题'; app.store.putTask(task);
  await assert.rejects(app.router.replies.send(fragments('task', '旧版本', result.fact.id, { certainty: 'last-known' }), current), /查询后已变化/);
  const refreshed = await queriedFact(app, task.id, current);
  const sent = await app.router.replies.send(fragments('task', '原事项最后记录仍在处理；当前来源未核实。', refreshed.fact.id, { certainty: 'last-known' }), current);
  assert.equal(sent.status, 'sent'); assert.equal(f.feishu.messages.length, 1);
  f.config.readDeny.push(f.project);
  await assert.rejects(app.router.replies.send(fragments('task', '旧授权', refreshed.fact.id), current), /权限已过期/);
});

test('A10: unrelated old decisions are quiet, overview coverage cannot turn partial/failure into global zero; honest unknown and related decisions remain possible', async t => {
  const f = await fixture(); t.after(() => f.close()); const app = await f.start(), task = card(); task.waiting = '等原决定'; task.deferred = true; app.store.putTask(task);
  const greeting = turn(ownerInput(app.store, 'greeting', '你好'));
  const fact = await queriedFact(app, task.id, greeting);
  await assert.rejects(app.router.replies.send(fragments('decision', '旧决定请再选一次', fact.fact.id, { certainty: 'last-known' }), greeting), /无关旧事项/);
  const partial = app.router.replies.issue('query_loop', {}, { partial: true, total: null, hasMore: true, coverage: { ok: false, scope: '只查一页' } }, greeting) as any;
  await assert.rejects(app.router.replies.send(fragments('overview', '全局没有工作', partial.fact.id, { coverage: 'complete', certainty: 'unknown' }), greeting), /部分\/失败/);
  await app.router.replies.send(fragments('overview', '只查到这一页；其他来源当前未知。', partial.fact.id, { coverage: 'partial', certainty: 'unknown' }), greeting);
  const failed = app.router.replies.issue('get_task', { id: task.id }, { ok: false, id: task.id, reason: '来源失败' }, greeting) as any;
  await assert.rejects(app.router.replies.send(fragments('task', '仍然当实时事实', failed.fact.id), greeting), /当前依据未核实/);
  const asked = turn(ownerInput(app.store, 'related', 'original 原决定是什么'));
  const valid = await queriedFact(app, task.id, asked);
  await app.router.replies.send(fragments('decision', '原决定仍保留，下面仅答复你本次所问。', valid.fact.id, { certainty: 'last-known' }), asked);
  assert.equal(f.feishu.messages.length, 2); assert.equal(app.store.task(task.id)!.deferred, true, 'no deletion of old decisions to obtain quiet');
});

test('A10: genuine source notice respects cancellation/rule, and verified delivered one-shot ends only after sent receipt', async t => {
  const f = await fixture(); t.after(() => f.close());
  const batch = join(f.config.projects[0]!.root, 'batch-1.json'); await writeFile(join(f.root, 'loop.json'), JSON.stringify({ v: 1, batches: [{ project: f.config.projects[0]!.root, batch: { name: '原事项', file: batch }, state: 'paused', stages: [] }] }));
  const app = await f.start(), task = card(); task.worker = { kind: 'loop', project: 'p', batchFile: batch }; app.store.putTask(task);
  const input = ownerInput(app.store, 'track', '跟踪 original 直到交付'); await app.router.tasks.work.track(task.id, '已核实结果并回报', input, instructionArgs(input));
  const source: Input = { id: 'new-source-event', source: 'loop', who: 'loop', at: new Date().toISOString(), text: '', attachments: [], batchFile: 'source' };
  app.store.enqueue(source); app.store.db.prepare('INSERT INTO task_events VALUES(?,?)').run(task.id, source.id);
  const sourceTurn = turn(source), fact = await queriedFact(app, task.id, sourceTurn);
  await app.router.replies.send(fragments('notice', '本次有已核实的新结果。', fact.fact.id), sourceTurn);
  const current = app.store.task(task.id)!; current.status = 'cancelled'; app.store.putTask(current);
  const cancelled = await queriedFact(app, task.id, sourceTurn);
  await assert.rejects(app.router.replies.send(fragments('notice', '已取消仍通知', cancelled.fact.id), sourceTurn), /提醒约定/);
  const ownerTurn = turn(ownerInput(app.store, 'deliver', 'local-delivery 交付给我'));
  const file = join(f.config.projects[0]!.root, 'local-result.txt'); await writeFile(file, '本轮真实构造材料'); await app.router.files.read(file, ownerTurn.materials);
  const args = { ...instructionArgs(ownerTurn.input), id: 'local-delivery', title: '本地交付', goal: '本地文本', completion: '结果及依据', boundary: '不对外发送', state: 'delivered', summary: '真实本地文本' };
  const saved = await app.router.tasks.work.local(args, ownerTurn.input, ownerTurn.materials);
  await app.router.tasks.work.track('local-delivery', '已核实结果并回报', ownerTurn.input, instructionArgs(ownerTurn.input));
  const delivery = app.router.replies.issue('record_local_work', args, saved, ownerTurn) as any;
  await app.router.replies.send(fragments('delivery', '本地文本结果已交付；未对外发送，业务未验。', delivery.fact.id), ownerTurn);
  assert.equal(app.store.task('local-delivery')!.work!.tracking!.state, 'reported');
});

test('A10: independent Pi settled/source-completed cannot close a one-shot as delivery; revocation also blocks an in-flight fact', async t => {
  const f = await observationFixture(); t.after(() => f.close()); await f.emit(f.record({ state: 'settled', outcome: 'completed' })); const app = await f.start(), id = app.store.taskTable()[0]!.id;
  const input = ownerInput(app.store, 'once', `跟踪 ${id} 至本次交付`); await app.router.tasks.work.track(id, '交付核实后回报', input, instructionArgs(input));
  const current = turn(input), value = await queriedFact(app, id, current);
  await assert.rejects(app.router.replies.send(fragments('delivery', '已做完', value.fact.id), current), /不是已核实交付/);
  assert.equal(app.store.task(id)!.work!.tracking!.state, 'active'); f.source.enabled = false;
  await assert.rejects(app.router.replies.send(fragments('task', '撤销后仍披露', value.fact.id), current), /已撤销/);
});

test('A10 Router: direct final is corrected at most once; never original-text fallback; correction cannot dispatch a new task', async t => {
  const f = await fixture({ turns: [
    [{ text: 'UNVERIFIED_OLD_TASK_ASSERTION' }, { tools: [{ name: 'reply', arguments: { text: '只回复本轮普通问候。' } }] }, { text: 'done' }],
    [{ text: 'UNVERIFIED_FINAL_TWICE' }, { text: 'UNVERIFIED_FINAL_TWICE' }],
    [{ text: '不是合法 reply' }, { tools: [{ name: 'worker_dispatch', arguments: { taskId: 'should-not-dispatch', worker: 'pi', project: 'p', title: '新任务', goal: '不该执行', completion: '未知', boundary: '无权限', prompt: 'do not execute', options: '{"type":"read"}' } }] }, { text: 'UNVERIFIED_ACTION_FALLBACK' }],
  ] }); t.after(() => f.close()); f.config.approval.readPi = false; const app = await f.start();
  for (const [id, text] of [['corrected', '你好'], ['failed-correction', '另一个无关问题'], ['cannot-act', '只闲聊']] as const) { await f.inject({ id, text }); await until(() => app.store.row(`feishu:${id}`)?.state === 'done'); }
  assert.equal(f.feishu.messages[0]!.text, '只回复本轮普通问候。');
  assert.match(f.feishu.messages[1]!.text, /尚未完成核对/); assert.match(f.feishu.messages[2]!.text, /尚未完成核对/);
  assert.equal(f.feishu.messages.some(m => /UNVERIFIED|不是合法/.test(m.text)), false);
  assert.equal(f.model.requests.filter(r => r.session === hash('feishu:failed-correction').slice(0, 32)).length, 2);
  assert.equal(app.router.workers.pi.jobs().length, 0); assert.equal(app.store.taskTable().length, 0);
});

test('new-source grants are rechecked before every model call/checkpoint continuation, not merely at tool issue', async t => {
  const f = await observationFixture(); t.after(() => f.close()); await f.emit(f.record({ subject: { title: 'CACHED_TITLE', goal: '目标' } })); const app = await f.start();
  const input = ownerInput(app.store, 'inflight', '原观察状态'); const current = turn(input), id = app.store.taskTable()[0]!.id;
  app.router.replies.issue('get_task', { id }, { ok: true, id }, current);
  f.source.allowSubject = false;
  assert.throws(() => app.router.replies.disclosure(current), /撤销\/变更/);
  await assert.rejects(app.router.tasks.detail(id, []), /授权已变/);
});

test('observed delivery needs real versioned material reads plus a separately recorded assessment, and retains that proof across lease refreshes', async t => {
  const f = await observationFixture(); t.after(() => f.close()); const path = join(f.config.projects[0]!.root, 'delivered.txt'); await writeFile(path, '构造的完整结果');
  const record = f.record({ state: 'settled', outcome: 'completed', subject: { title: '本次报告', goal: '交一份构造报告' }, result: { summary: '来源自述', refs: [{ path, sha256: hash(await readFile(path)) }] } }); await f.emit(record);
  const app = await f.start(), id = app.store.taskTable()[0]!.id, input = ownerInput(app.store, 'verified-once', `跟踪 ${id} 结果核实并回报后结束`), current = turn(input);
  await app.router.tasks.work.track(id, '本次结果核实并回报', input, instructionArgs(input));
  await assert.rejects(app.router.tasks.observations.verifyResult(id, '对照目标的构造判断', [], input), /本轮实际读取/);
  await app.router.tasks.evidence(id, '0', current.materials);
  const proof = await app.router.tasks.observations.verifyResult(id, '已核对构造报告及版本；业务未验。', current.materials, input);
  const fact = app.router.replies.issue('verify_observed_result', { id }, proof, current) as any;
  await app.router.replies.send(fragments('delivery', '本次报告及依据已回收；业务未验，不对外发送。', fact.fact.id), current);
  assert.equal(app.store.task(id)!.work!.tracking!.state, 'reported');
  await f.emit({ ...record, revision: 2, heartbeatAt: new Date().toISOString() }); await app.intake.scan();
  const task = app.store.task(id)!; assert.equal(task.status, 'delivered'); assert.equal(task.work!.executions[0]!.result!.verified, true);
  const next = turn(ownerInput(app.store, 'verify-again', `${id} 的结果是否仍可核对`)), newFact = await queriedFact(app, id, next);
  await writeFile(path, '材料随后被修改'); await assert.rejects(app.router.replies.send(fragments('delivery', '不能用旧版本再交付', newFact.fact.id), next), /材料版本已变/);
});

test('actual Router middleware stops a revoked tool body before the next model request, including persisted checkpoint continuation', async t => {
  const f = await observationFixture(); t.after(() => f.close()); await f.emit(f.record({ subject: { title: 'PRIVATE_FIXTURE_TITLE', goal: '构造目标' } })); let app = await f.start(), id = app.store.taskTable()[0]!.id;
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'get_task', arguments: { id } }] }, { tools: [{ name: 'reply', arguments: { text: '这条本不应请求模型生成' } }] }, { text: 'done' }] }) });
  const issue = app.router.replies.issue.bind(app.router.replies);
  t.mock.method(app.router.replies, 'issue', (...args: Parameters<typeof issue>) => { const result = issue(...args); if (args[0] === 'get_task') f.source.enabled = false; return result; });
  await f.inject({ id: 'revoke-in-flight', text: `${id} 当前怎样` }); await until(() => app.store.row('feishu:revoke-in-flight')?.state === 'failed');
  assert.equal(f.model.requests.length, 1, 'no old tool body can be submitted after the grant changes');
  assert.equal(f.feishu.messages.some(m => m.text.includes('PRIVATE_FIXTURE_TITLE')), false);
  await f.stop(); app = await f.start();
  await assert.rejects(app.router.process(app.store.row('feishu:revoke-in-flight')!, new AbortController().signal), /观察来源|已撤销/);
  assert.equal(f.model.requests.length, 1, 'checkpoint recovery uses the saved grant, not a fresh permission-free cache');
});

test('R1.1: revoked observation bodies cannot escape through task_card, cancel_task or the queued card publisher', async t => {
  const f = await observationFixture(); t.after(() => f.close()); await f.emit(f.record({ subject: { title: 'PRIVATE_CARD_TITLE', goal: 'PRIVATE_CARD_GOAL' } })); const app = await f.start(), id = app.store.taskTable()[0]!.id;
  const stored = app.store.task(id)!; stored.conclusion = 'PRIVATE_CARD_CONCLUSION'; app.store.putTask(stored);
  await app.router.workers.show(id, { cause: '本人问起', assessment: '构造', suggestion: '仅查看' }, { ...ownerInput(app.store, 'initial-card', id), text: id });
  const original = f.feishu.messages[0]!, before = original.updates?.length ?? 0, history = JSON.stringify(app.store.task(id)!.dispatches);
  assert.equal(app.store.get<Record<string, string>>('reply:grants:initial-card', {})[f.source.id], observationGrant(f.source), 'program-published card bodies carry their source into later windows too');
  const anchor = { ...card(), id: 'linked-original', worker: { kind: 'pi', project: 'p', batchFile: 'synthetic-original-job' } }; app.store.putTask(anchor);
  const link = ownerInput(app.store, 'link-to-observation', `把 ${anchor.id} 关联到 ${id}`); await app.router.tasks.work.link(anchor.id, id, link, instructionArgs(link));
  f.source.enabled = false;
  for (const [name, inputId] of [['task_card', 'revoked-show'], ['cancel_task', 'revoked-cancel']] as const) {
    await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name, arguments: { id, ...(name === 'task_card' ? { cause: '问起', assessment: '构造', suggestion: '查看旧记录' } : {}) } }] }, { tools: [{ name: 'reply', arguments: { text: '当前来源不可披露，原记录保留。' } }] }, { text: 'done' }] }) });
    await f.inject({ id: inputId, text: `${id} ${name}` }); await until(() => app.store.row(`feishu:${inputId}`)?.state === 'done');
  }
  await assert.rejects(app.router.workers.messages.publish(id, 'direct-after-revoke'), /已撤销/);
  await assert.rejects(app.router.workers.messages.publish(anchor.id, 'linked-after-revoke'), /已撤销/);
  await assert.rejects(app.router.tasks.detail(anchor.id, []), /已撤销/);
  assert.equal(original.updates?.length ?? 0, before);
  assert.equal(f.feishu.messages.slice(1).some(m => /PRIVATE_CARD_/.test(m.text)), false);
  assert.equal(app.store.task(id)!.goal, 'PRIVATE_CARD_GOAL'); assert.equal(app.store.task(id)!.conclusion, 'PRIVATE_CARD_CONCLUSION');
  assert.equal(JSON.stringify(app.store.task(id)!.dispatches), history); assert.equal(app.store.task(id)!.work!.executions.length, 2);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('sending','uncertain')").get()!.n, 0);
});

test('R1.2: an off-page history-only observation dependency survives an unrelated HITL pause and rejects revocation on resume', async t => {
  const f = await observationFixture(); t.after(() => f.close()); let app = await f.start();
  for (let n = 0; n < 6; n++) app.store.putTask({ ...card(), id: `front-${n}`, title: `首页-${n}`, subscriptions: [] });
  await f.emit(f.record({ subject: { title: 'HISTORY_ONLY_TITLE', goal: '构造来源目标' } })); await app.intake.scan();
  const id = app.store.taskTable().find(row => row.id.startsWith('pi-observed-'))!.id;
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'get_task', arguments: { id } }] }, { tools: [{ name: 'reply', arguments: { text: 'HISTORY_ONLY_BODY' } }] }, { text: 'done' }] }) });
  await f.inject({ id: 'history-read', text: `${id} 原事项` }); await until(() => app.store.row('feishu:history-read')?.state === 'done');
  let effects = 0;
  const adapter: WorkerAdapter = { kind: 'constructed', async status() { return { state: 'idle', fingerprint: 'same-original-basis', data: {} }; }, async dispatch() { effects++; return { status: 'sent', reason: '不应执行' }; }, async reply() { assert.fail('not called'); }, async stop() { assert.fail('not called'); }, async progress(e) { return e; }, async ask(e) { return e; }, async result() { return false; } };
  app.router.workers.adapters.set(adapter.kind, adapter);
  const send = app.channel.sendCard!.bind(app.channel); let entered = false, release!: () => void;
  const channel = app.channel as typeof app.channel & { sendCard: typeof send };
  const receipt = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(channel, 'sendCard', async (...args: Parameters<typeof send>) => {
    if (args[1] === 'task-message:unrelated-proposal') { entered = true; await receipt; }
    return send(...args);
  });
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'worker_dispatch', arguments: { taskId: 'unrelated-proposal', worker: 'constructed', project: 'p', title: '另一个构造提案', goal: '构造目标', completion: '构造标准', boundary: '不执行真实任务', prompt: '仅测试暂停恢复' } }] }, { tools: [{ name: 'reply', arguments: { text: '恢复后原窗口不应泄露' } }] }, { text: 'done' }] }) });
  try {
    await f.inject({ id: 'history-pause', text: '给我另一个构造提案' });
    await until(() => app.store.row('feishu:history-pause')?.state === 'waiting' && entered);
    assert.equal(f.feishu.messages.find(m => m.key === 'task-message:unrelated-proposal'), undefined, 'waiting is durable before physical delivery; the test must not consume an absent card');
  } finally { release(); }
  await until(() => {
    const published = app.store.get<{ state: string; digest: string } | null>('task-message:unrelated-proposal', null);
    return published?.state === 'sent' && app.router.workers.messages.delivery('unrelated-proposal', published.digest).status === 'sent'
      && !!f.feishu.messages.find(m => m.key === 'task-message:unrelated-proposal')?.card?.buttons.some(b => b.label === '好');
  });
  const pauseRequest = f.model.requests.find(r => r.session === hash('feishu:history-pause').slice(0, 32))!;
  assert.ok(JSON.stringify(pauseRequest.body.messages).includes('HISTORY_ONLY_BODY'));
  const context = pauseRequest.body.messages.map((m: any) => { try { return JSON.parse(m.content); } catch { return {}; } }).find((v: any) => v.type === '任务表');
  assert.ok(!context.rows.some((row: any) => row.id === id)); assert.equal(context.matchedCards.length, 0);
  assert.equal(app.store.get<Record<string, string>>('reply:grants:feishu:history-pause', {})[f.source.id], observationGrant(f.source));
  const message = f.feishu.messages.find(m => m.key === 'task-message:unrelated-proposal')!, approval = message.card!.buttons.find(b => b.label === '好')!;
  const requests = f.model.requests.length; await f.stop(); f.source.enabled = false; app = await f.start(); app.router.workers.adapters.set(adapter.kind, adapter);
  await f.inject({ id: 'resume-revoked-history', quoteId: message.id, button: { value: approval.value } });
  await until(() => app.store.row('feishu:history-pause')?.state === 'failed');
  assert.equal(f.model.requests.length, requests); assert.equal(effects, 0); assert.ok(app.store.task(id));
  const op = app.router.workers.operation(String(approval.value.operation))!; assert.equal(op.state, 'approved', 'the original operation/decision is retained, never replayed');
});

test('R1.5: actual execution-index reads retain old verification time and cannot turn a healthy cached row into current facts', async t => {
  const f = await fixture(); t.after(() => f.close()); const app = await f.start(), task = { ...card(), id: 'stale-index', lastVerifiedAt: '2001-01-01T00:00:00.000Z' };
  const identity = { kind: 'local' as const, sourceId: 'owner-local', sessionId: task.id, instanceId: 'pa', executionId: 'old-execution' }, key = executionKey(identity);
  app.store.putTask({ ...task, work: { ownership: { kind: 'personal', resources: [] }, executions: [{ ...identity, key, revision: 1, state: 'working', origin: 'pa', observedAt: task.lastVerifiedAt, receivedAt: task.lastVerifiedAt, verifiedAt: task.lastVerifiedAt }], currentExecution: key } });
  const current = turn(ownerInput(app.store, 'stale-query', `${task.id} 当前如何`)), page = await app.router.tasks.executionPage(task.id);
  const result = app.router.replies.issue('list_executions', { id: task.id }, page, current) as any;
  assert.equal(result.fact.basis, 'cache'); assert.equal(result.fact.checkedAt, task.lastVerifiedAt); assert.ok(result.fact.issuedAt > result.fact.checkedAt);
  assert.equal(result.fact.current, false); assert.equal(result.fact.indexComplete, true); assert.equal(result.fact.complete, false);
  await assert.rejects(app.router.replies.send(fragments('task', '旧缓存冒充当前', result.fact.id), current), /当前依据未核实/);
  await app.router.replies.send(fragments('task', '这里只是旧执行索引，核实时间为 2001 年；当前状态未知。', result.fact.id, { certainty: 'last-known' }), current);
  const actionInput = ownerInput(app.store, 'organize-old', `把 ${task.id} 归入个人事项`), actionTurn = turn(actionInput);
  const action = await app.router.tasks.work.organize(task.id, { kind: 'personal', resources: [] }, actionInput, instructionArgs(actionInput));
  const receipt = app.router.replies.issue('organize_work', { id: task.id }, action, actionTurn) as any;
  await assert.rejects(app.router.replies.send(fragments('task', '归组动作不能刷新运行状态', receipt.fact.id), actionTurn), /动作回执不证明/);
  await app.router.replies.send(fragments('action', '本轮归组已保存，不代表来源现状已核实。', receipt.fact.id), actionTurn);
  const file = join(f.config.projects[0]!.root, 'source-material.txt'); await writeFile(file, '当前本地材料内容');
  const stored = app.store.task(task.id)!; stored.work!.materials = [{ path: file, sha256: hash(await readFile(file)) }]; app.store.putTask(stored);
  const data = await app.router.tasks.evidence(task.id, 'material-0', []), material = app.router.replies.issue('read_task_evidence', { id: task.id }, data, actionTurn) as any;
  assert.equal(material.fact.scope, 'material'); assert.equal(material.fact.current, true);
  await assert.rejects(app.router.replies.send(fragments('task', '读文件不能刷新任务状态', material.fact.id), actionTurn), /材料票据只证明/);
  await app.router.replies.send(fragments('material', '本轮只核对了该材料版本，不证明任务状态。', material.fact.id), actionTurn);
});

test('R1.5: real empty task-index and failed-source tool results never certify complete current source coverage', async t => {
  const f = await fixture(); t.after(() => f.close()); const app = await f.start(), current = turn(ownerInput(app.store, 'empty-current', '当前工作全貌如何'));
  const empty = await app.router.tasks.taskPage(), first = app.router.replies.issue('list_tasks', {}, empty, current) as any;
  assert.equal(empty.total, 0); assert.equal((empty.coverage.projects[0] as any).ok, false);
  assert.equal(first.fact.current, false); assert.equal(first.fact.indexComplete, true); assert.equal(first.fact.complete, false); assert.equal(first.fact.checkedAt, null);
  await assert.rejects(app.router.replies.send(fragments('overview', '空表冒充当前全局无工作', first.fact.id, { coverage: 'complete' }), current), /未核实|覆盖/);
  await assert.rejects(app.router.replies.send(fragments('overview', '未知却声明完整', first.fact.id, { certainty: 'unknown', coverage: 'complete' }), current), /部分\/失败/);
  await app.router.replies.send(fragments('overview', '登记索引为空，来源未接通；当前全貌未知。', first.fact.id, { certainty: 'unknown', coverage: 'partial' }), current);
  const task = { ...card(), id: 'failed-source', lastVerifiedAt: '2002-01-01T00:00:00.000Z', worker: { kind: 'loop', project: 'p', batchFile: join(f.config.projects[0]!.root, 'batch-1.json') } }; app.store.putTask(task);
  await writeFile(join(f.root, 'loop.json'), '{}');
  const page = await app.router.tasks.taskPage(), failed = app.router.replies.issue('list_tasks', {}, page, current) as any;
  assert.equal(page.rows[0]!.ok, false); assert.equal(page.partial, true);
  assert.equal(failed.fact.current, false); assert.equal(failed.fact.complete, false); assert.equal(failed.fact.indexComplete, true); assert.equal(failed.fact.checkedAt, task.lastVerifiedAt);
  await assert.rejects(app.router.replies.send(fragments('overview', '查询失败也不能变成完整当前事实', failed.fact.id, { coverage: 'complete' }), current), /未核实|覆盖/);
  assert.equal(app.store.task(task.id)!.lastVerifiedAt, task.lastVerifiedAt);
});

test('R1.5: an actual source read signs its true read time; only current claims expire, while explicitly last-known answers remain available', async t => {
  const f = await observationFixture(); t.after(() => f.close()); await f.emit(f.record({ state: 'waiting', subject: { title: '真实构造来源', goal: '原目标' } })); const app = await f.start(), id = app.store.taskTable()[0]!.id;
  const current = turn(ownerInput(app.store, 'fresh-source', `${id} 现在怎样`)), detail = await app.router.tasks.detail(id, []), result = app.router.replies.issue('get_task', { id }, detail, current) as any;
  assert.equal(result.fact.basis, 'source'); assert.equal(result.fact.current, true); assert.equal(result.fact.checkedAt, (detail as any).verification.checkedAt);
  await app.router.replies.send(fragments('task', '本轮读到原来源等待交互；业务交付未核实。', result.fact.id), current);
  const now = Date.now(), clock = t.mock.method(Date, 'now', () => now + FACT_FRESH_MS + 1);
  await assert.rejects(app.router.replies.send(fragments('task', '过期读数不再称当前', result.fact.id), current), /当前依据未核实/);
  await app.router.replies.send(fragments('task', '该版本是上次核实的状态，不冒充现在。', result.fact.id, { certainty: 'last-known' }), current); clock.mock.restore();
});

test('R2.1: an off-page task_card followed by ordinary reply keeps card-body provenance across revocation and restart', async t => {
  const f = await observationFixture(); t.after(() => f.close()); let app = await f.start();
  for (let n = 0; n < 6; n++) app.store.putTask({ ...card(), id: `r2-front-${n}`, title: `首页事项-${n}`, subscriptions: [] });
  await f.emit(f.record({ subject: { title: 'R2_PRIVATE_TITLE', goal: 'R2_PRIVATE_GOAL' } })); await app.intake.scan();
  const id = app.store.taskTable().find(row => row.id.startsWith('pi-observed-'))!.id;
  const source = app.store.task(id)!; source.conclusion = 'R2_PRIVATE_CONCLUSION'; app.store.putTask(source);
  const issue = app.router.replies.issue.bind(app.router.replies);
  t.mock.method(app.router.replies, 'issue', (...args: Parameters<typeof issue>) => {
    if (args[3].input.id === 'feishu:r2-card-and-reply' && ['task_card', 'reply'].includes(args[0])) assert.equal(args[3].observationGrants?.[f.source.id], observationGrant(f.source), 'program publication and later reply share the same live dependency set');
    return issue(...args);
  });
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [
    { tools: [{ name: 'task_card', arguments: { id, cause: '本人问起原卡', assessment: '读取原登记信息', suggestion: '查看原卡，业务未验' } }] },
    { tools: [{ name: 'reply', arguments: { text: '已按请求显示原卡。' } }] }, { text: 'done' },
  ] }) });
  await f.inject({ id: 'r2-card-and-reply', text: `${id} 显示原卡` }); await until(() => app.store.row('feishu:r2-card-and-reply')?.state === 'done');
  const requests = f.model.requests.filter(r => r.session === hash('feishu:r2-card-and-reply').slice(0, 32));
  const context = requests[0].body.messages.map((m: any) => { try { return JSON.parse(m.content); } catch { return {}; } }).find((v: any) => v.type === '任务表');
  assert.ok(!context.rows.some((row: any) => row.id === id)); assert.equal(context.matchedCards.length, 0);
  assert.match(f.feishu.messages.find(m => m.key === `task-message:${id}`)!.text, /R2_PRIVATE_CONCLUSION/);
  const cardWindow = app.store.window().find(row => row.role === 'assistant' && row.text.includes('R2_PRIVATE_TITLE'))!;
  assert.ok(cardWindow, 'the actual sent card, not a fabricated summary, is retained verbatim');
  assert.equal(app.store.get<Record<string, string>>('reply:grants:feishu:r2-card-and-reply', {})[f.source.id], observationGrant(f.source));
  assert.equal(app.store.get<Record<string, string>>(`window:observation:${cardWindow.id}`, {})[f.source.id], observationGrant(f.source));
  await f.stop(); f.source.enabled = false; app = await f.start();
  await fetch(`${f.model.url}/script`, { method: 'POST', body: JSON.stringify({ flow: [{ tools: [{ name: 'reply', arguments: { text: '只回答新回合的普通问题。' } }] }, { text: 'done' }] }) });
  await f.inject({ id: 'r2-after-revocation', text: '你好' }); await until(() => app.store.row('feishu:r2-after-revocation')?.state === 'done');
  const next = f.model.requests.filter(r => r.session === hash('feishu:r2-after-revocation').slice(0, 32));
  assert.ok(next.length > 0); assert.ok(next.every(r => !/R2_PRIVATE_(?:TITLE|GOAL|CONCLUSION)/.test(JSON.stringify(r.body.messages))));
  assert.ok(app.store.window().some(row => row.text === cardWindow.text), 'permission gating does not delete or rewrite the original window');
  assert.equal(app.store.task(id)!.conclusion, 'R2_PRIVATE_CONCLUSION');
});

test('R2.1: dependency retention unions stale Turn/store snapshots, rejects replacement and never tags another active input', async t => {
  const f = await fixture(); t.after(() => f.close()); const app = await f.start(), input = ownerInput(app.store, 'r2-retain', '构造依赖合并');
  const active = turn(input), stale = turn(input), access = app.router.replies.disclosureScope();
  app.router.replies.saveDisclosure(active);
  turns.run(active, () => retainObservationGrants(app.store, input.id, { alpha: 'version-a' }, access));
  assert.deepEqual(active.observationGrants, { alpha: 'version-a' });
  app.router.replies.saveDisclosure(stale); assert.deepEqual(stale.observationGrants, active.observationGrants);
  active.observationGrants = { beta: 'version-b' }; app.router.replies.saveDisclosure(active);
  const expected = { alpha: 'version-a', beta: 'version-b' };
  assert.deepEqual(active.observationGrants, expected); assert.deepEqual(app.store.get(`reply:grants:${input.id}`, {}), expected);
  turns.run(active, () => retainObservationGrants(app.store, 'other-callback', { gamma: 'version-c' }, access));
  assert.deepEqual(active.observationGrants, expected); assert.deepEqual(app.store.get('reply:grants:other-callback', {}), { gamma: 'version-c' });
  assert.throws(() => retainObservationGrants(app.store, input.id, { alpha: 'replacement-version' }, access, active), /授权版本冲突/);
  assert.throws(() => retainObservationGrants(app.store, input.id, {}, 'changed-scope', active), /授权已变/);
  assert.deepEqual(active.observationGrants, expected); assert.deepEqual(app.store.get(`reply:grants:${input.id}`, {}), expected); assert.equal(app.store.get(`reply:access:${input.id}`, ''), access);
  assert.equal(f.model.requests.length, 0);
});
