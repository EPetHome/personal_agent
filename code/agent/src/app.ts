import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Config, Input } from './types.js';
import { Store } from './store.js';
import { Router } from './router.js';
import { deliver, makeChannel, normalizeFeishu, prepareAttachments, type Channel } from './channel.js';
import { Intake } from './intake.js';
import { atomicJson } from './util.js';

export class App {
  readonly store: Store;
  readonly router: Router;
  readonly intake: Intake;
  readonly identity = { pid: process.pid, token: randomUUID(), started: Date.now() };
  private stopping = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private busyTimer?: NodeJS.Timeout;
  private piTimer?: NodeJS.Timeout;
  private piWork: Promise<void> = Promise.resolve();
  private heartbeatWork: Promise<void> = Promise.resolve();
  private busyWork: Promise<void> = Promise.resolve();
  private running?: Promise<void>;
  private controller?: AbortController;
  private fatal?: (error: unknown) => void;
  constructor(readonly c: Config, readonly channel: Channel, store?: Store) {
    this.store = store ?? new Store(c);
    this.acquire();
    try {
      this.router = new Router(c, this.store, channel);
      this.intake = new Intake(c, this.store, this.router.files, input => {
        // A scan already accepted before stop may finish persisting, but cannot start work.
        if (this.store.enqueue(input) || this.store.retryLoopSource(input)) this.pump();
      });
    } catch (error) { this.release(); this.store.close(); throw error; }
  }
  static async create(c: Config) { const store = new Store(c); try { return new App(c, await makeChannel(c, store), store); } catch (e) { if (store.db.isOpen) store.close(); throw e; } }
  private acquire() {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.store.get<{ pid: number; token: string } | null>('owner', null);
      if (old) { let alive = true; try { process.kill(old.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== 'ESRCH'; } if (alive) throw new Error('已有 PA 进程或进程身份不能确认；拒绝重复启动'); }
      this.store.set('owner', this.identity); this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
  }
  private release() { if (this.store.get<any>('owner', null)?.token === this.identity.token) this.store.set('owner', null); }
  async start(onFatal?: (error: unknown) => void) {
    this.fatal = onFatal;
    this.store.set('feishuDisconnectedAt', Date.now());
    await this.heartbeat();
    this.heartbeatTimer = setInterval(() => { this.heartbeatWork = this.heartbeatWork.then(() => this.heartbeat()).catch(e => this.fail(e)); }, this.c.watchdog.heartbeatMs);
    // Ambiguous worker effects are surfaced once, never replayed after restart.
    await this.router.workers.recover();
    // Resume durable in-flight checkpoints; waiting-for-human rows stay suspended.
    this.pump();
    this.busyTimer = setInterval(() => { this.busyWork = this.busyWork.then(() => this.busy()).catch(e => this.fail(e)); }, Math.min(1000, this.c.queue.busyMs));
    await this.channel.start(raw => {
      if (this.stopping) return;
      try { const input = normalizeFeishu(raw, this.c, this.store); if (input) this.receive(input); }
      catch { this.store.log('invalid_input', { reason: '飞书输入格式无效，没有交给模型' }); }
    }, connected => {
      if (this.stopping) return;
      const since = this.store.get<number | null>('feishuDisconnectedAt', null);
      if (connected && since !== null) this.store.set('feishuDisconnectedAt', null);
      if (!connected && since === null) this.store.set('feishuDisconnectedAt', Date.now());
    });
    await this.intake.start();
    const pollPi = () => this.router.workers.pi.poll(input => {
      // An observation already in flight during stop must still reach the durable
      // queue before the worker marks it emitted. Stopping only prevents pumping.
      if (this.store.enqueue(input) && !this.stopping) this.pump();
    });
    await pollPi();
    this.piTimer = setInterval(() => { this.piWork = this.piWork.then(pollPi).catch(error => this.fail(error)); }, this.c.pi.pollMs);
  }
  receive(input: Input) { if (!this.stopping && (this.store.enqueue(input) || this.store.retryLoopSource(input))) this.pump(); }
  private pump() {
    if (this.running || this.stopping) return;
    this.running = this.drain().catch(e => this.fail(e)).finally(() => { this.running = undefined; if (!this.stopping && this.store.pending()) this.pump(); });
  }
  private async drain() {
    while (!this.stopping) {
      let row = this.store.next(); if (!row) break;
      this.store.start(row.id); this.store.set('activeInput', row.id);
      this.controller = new AbortController();
      const timer = setTimeout(() => this.controller?.abort(new Error('input_timeout')), this.c.queue.inputTimeoutMs);
      try {
        row.input = await prepareAttachments(row.input, this.c, this.channel, this.store, this.controller.signal);
        if (!row.prepared) { this.store.prepared(row.id, row.input); row = this.store.row(row.id)!; }
        const state = await this.router.process(row, this.controller.signal);
        this.router.remember(row); if (state === 'done') this.store.finish(row.id);
      } catch {
        if (this.stopping && this.controller.signal.reason instanceof Error && this.controller.signal.reason.message === 'shutdown') break; // Preserve shutdown progress, not an already timed-out input.
        this.store.log('input_failed', { inputId: row.id, outcome: '处理失败或超时，未自动重试' });
        if (row.input.source === 'feishu') await deliver(this.store, this.channel, row.id, `${row.id}:failure`, '这条输入没处理完（请求失败或超时）。没有自动重试；请检查连接，恢复后可重新告诉我。');
        this.router.remember(row); this.store.finish(row.id, 'failed');
      } finally { clearTimeout(timer); this.store.set('activeInput', null); }
      await this.router.prune();
    }
  }
  private async busy() {
    if (this.stopping) return;
    const rows = this.store.db.prepare("SELECT id FROM inputs WHERE priority=0 AND state IN ('pending','processing') AND created<=?").all(Date.now() - this.c.queue.busyMs);
    for (const row of rows) {
      const id = String(row.id);
      if (!this.store.replies(id).some(r => !String(r.id).endsWith(':busy'))) await deliver(this.store, this.channel, id, `${id}:busy`, '在处理');
    }
  }
  private heartbeat() { return atomicJson(join(this.c.dataDir, 'heartbeat.json'), { ...this.identity, at: Date.now() }); }
  private fail(error: unknown) { this.fatal?.(error); }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.busyTimer); clearInterval(this.heartbeatTimer); clearInterval(this.piTimer);
    // Stop intake first; no newly acknowledged messages disappear during drain.
    const stoppingIntake = Promise.all([this.channel.stop(), this.intake.stop()]);
    const grace = setTimeout(() => this.controller?.abort(new Error('shutdown')), Math.max(1, this.c.queue.stopMs - 2000));
    try {
      await Promise.all([stoppingIntake, this.running, this.busyWork, this.heartbeatWork, this.piWork]);
      await this.router.workers.pi.idle(); // Detach monitoring only; never kill running Pi.
      this.release();
    } finally { clearTimeout(grace); this.router.close(); this.store.close(); }
  }
}
