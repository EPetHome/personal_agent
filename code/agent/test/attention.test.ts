import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fixture, instructionArgs, observationFixture, ownerInput } from './helpers.js';
import { Store } from '../src/store.js';
import { Attention } from '../src/attention.js';
import { WorkTracking } from '../src/work-tracking.js';
import { Files } from '../src/files.js';
import type { TaskCard } from '../src/types.js';

const card = (id: string): TaskCard => ({ id, title: id, goal: '目标', completion: '结果', boundary: '已有授权', status: 'running', waiting: '', dispatches: [], conclusion: '', subscriptions: [], updated: new Date().toISOString() });

test('A6: persistent future-work attention survives task completion/restart; pause retains explicit one-shot and stops new admission', async t => {
  const f = await observationFixture(); t.after(() => f.close()); let app = await f.start();
  const firstInput = ownerInput(app.store, 'mixed', '盯本次交付并继续看这个来源以后的工作');
  const saved = await app.router.attention.save({ ...instructionArgs(firstInput), kind: 'pi-observation', sourceId: f.source.id, notify: 'important' }, firstInput);
  assert.equal(saved.ready, false); assert.match(saved.receipt, /尚未接通/); assert.match(saved.receipt, /直到本人取消/);
  const duplicate = await app.router.attention.save({ ...instructionArgs(firstInput), kind: 'pi-observation', sourceId: f.source.id, notify: 'important' }, firstInput);
  assert.equal(duplicate.rule.id, saved.rule.id); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.rule.revision, 1);
  await f.emit(); await app.intake.scan(); const firstId = app.store.taskTable()[0]!.id;
  await app.router.tasks.work.track(firstId, '核实本次结果后回报', firstInput, instructionArgs(firstInput));
  const closed = app.store.task(firstId)!; closed.status = 'closed'; app.store.putTask(closed);
  await f.emit(f.record({ executionId: 'second-work' })); await app.intake.scan(); assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 2);
  const secondId = app.store.taskTable()[0]!.id;
  const tracking = ownerInput(app.store, 'track-second', `跟踪 ${secondId} 本次结果`); await app.router.tasks.work.track(secondId, '结果核实并回报', tracking, instructionArgs(tracking));
  await f.stop(); app = await f.start(); assert.equal(app.router.attention.rules().length, 1); assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 2);
  const pauseInput = ownerInput(app.store, 'pause', '暂停以后新工作，本次委托保留');
  const pause = app.router.attention.pause(saved.rule.id, pauseInput, instructionArgs(pauseInput));
  assert.ok(pause.retainedOneShots.includes(secondId)); assert.match(pause.receipt, /未撤销的一次性委托仍回收/);
  await f.emit(f.record({ executionId: 'after-pause' })); await app.intake.scan(); assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 2);
  await f.emit(f.record({ executionId: 'second-work', revision: 2, state: 'settled' })); await app.intake.scan();
  assert.equal(app.store.task(secondId)!.sourceCurrent!.state, 'settled'); assert.equal(app.store.task(secondId)!.work!.tracking!.state, 'active', 'running settled is not a verified delivery');
  assert.equal(app.router.workers.pi.jobs().length, 0);
});

test('A6: expiry uses explicit owner timezone, records stopped interval, and does not grant reminders/execution', async t => {
  const f = await fixture(); t.after(() => f.close()); const store = new Store(f.config); t.after(() => store.close()); const attention = new Attention(f.config, store);
  const input = ownerInput(store, 'expiry', '继续看获准Loop的新工作，期限内不提醒');
  const args = { ...instructionArgs(input), kind: 'loop', project: 'p', notify: 'none', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await assert.rejects(attention.save(args, input), /本人 timeZone/);
  f.config.timeZone = 'America/New_York'; const saved = await attention.save(args, input); assert.match(saved.receipt, /America\/New_York/); assert.equal(saved.ready, false); assert.match(saved.receipt, /已保存/);
  const task = card('related'); attention.attach(task, [saved.rule.id]); assert.equal(attention.mayNotify(task, true), false);
  const clock = t.mock.method(Date, 'now', () => Date.parse(args.expiresAt) + 1);
  assert.equal(attention.rules()[0]!.state, 'expired'); assert.equal(attention.admission('loop', 'p', new Date().toISOString()).accept, false); assert.equal(attention.rules()[0]!.intervals.at(-1)!.to, args.expiresAt); clock.mock.restore();
  assert.equal(store.task('related')!.status, 'running'); assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key GLOB 'worker:op:*'").get()!.n), 0);
});

test('A5 program only: authenticated original source, duplicate/correction identity, mixed one-off/rule and denied expansion; no keyword classifier', async t => {
  const f = await fixture(); t.after(() => f.close()); const store = new Store(f.config); t.after(() => store.close()); const attention = new Attention(f.config, store), work = new WorkTracking(f.config, store, new Files(f.config, store));
  const input = ownerInput(store, 'explicit', '这个结果完成后还要看以后新开的工作'); const original = card('one-off'); store.putTask(original);
  await work.track(original.id, '这次结果回报后结束', input, instructionArgs(input));
  const rule = await attention.save({ ...instructionArgs(input), kind: 'loop', project: 'p', notify: 'important' }, input);
  assert.equal(store.task(original.id)!.work!.tracking!.inputId, rule.rule.instruction.inputId);
  assert.equal(store.taskTable().length, 1, 'the attention rule is not a parallel task card');
  const correction = ownerInput(store, 'correction', '更正为每次变化提醒');
  const changed = await attention.save({ ...instructionArgs(correction), id: rule.rule.id, kind: 'loop', project: 'p', notify: 'changes' }, correction);
  assert.equal(changed.rule.id, rule.rule.id); assert.equal(changed.rule.revision, 2); assert.equal(attention.rules().length, 1);
  assert.equal(changed.rule.intervals.length, 2); assert.ok(changed.rule.intervals[0]!.to);
  for (const fake of [{ ...input, source: 'inbox' as const }, { ...input, who: 'somebody' }]) await assert.rejects(attention.save({ ...instructionArgs(fake), kind: 'loop', project: 'p', notify: 'important' }, fake), /真实本人/);
  await assert.rejects(attention.save({ ...instructionArgs(input), kind: 'web', project: 'p', notify: 'important' }, input), /只支持/);
  await assert.rejects(attention.save({ ...instructionArgs(input), kind: 'loop', project: 'ungranted', notify: 'important' }, input), /新来源/);
  await assert.rejects(attention.save({ ...instructionArgs(input), kind: 'loop', project: 'p' }, input), /提醒约定/);
  await assert.rejects(attention.save({ ...instructionArgs(input), id: 'second-rule', kind: 'loop', project: 'p', notify: 'important' }, input), /原 ID/);
});
