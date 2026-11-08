import { randomUUID } from 'node:crypto';
import type { Config, TaskCard } from './types.js';
import type { Store } from './store.js';
import type { Files } from './files.js';
import { Workers, type WorkerRequest, type WorkerSnapshot } from './worker.js';
import { LoopAdapter, command, type LoopBatch } from './loop.js';
import { kernelFacts, kernelFingerprint, sameBinding, selectKernel } from './loop-kernel.js';
import { observeLaunch } from './loop-launch.js';
import { canonical, hash, inside, parseJson } from './util.js';
import { SafeError, failure } from './errors.js';
import type { ApprovalView } from './cards.js';

export const LOOP_MONITOR_MS = 60_000;
export const LOOP_MONITOR_QUIET_MS = 5 * LOOP_MONITOR_MS;
const closed = (card: TaskCard) => ['cancelled', 'closed', 'reconciled'].includes(card.status);
const ended = (card: TaskCard) => ['done', 'failed', 'stopped', '已合入', '已放弃', '可合入'].includes(card.status)
  || ['已合入', '已放弃', '可合入'].includes((card.verified?.snapshot as LoopBatch['kernel'] | undefined)?.state ?? '');
const identity = (card: TaskCard) => {
  const w = card.worker!, b = w.loop;
  return hash(JSON.stringify(b ? [b.protocol, b.repository, b.runId, b.cardFile, b.ledger, b.taskId] : [w.kind, w.project, w.batchFile, w.operation ?? null]));
};
const key = (id: string) => `loop-monitor:${id}`;
interface Reliable { at: string; state: string; basis: string }
interface Issue { kind: 'unverified' | 'exit'; since: string }
const endVersion = (card: TaskCard) => hash(JSON.stringify([card.status, card.sourceRevision, card.verified?.event]));
interface Observation {
  identity: string; next: number; failures: number; revision?: number; reliable?: Reliable; issue?: Issue; notice?: string; ended?: string;
}

/** A private read-only adapter for Workers.status. Its ordinary adapter uses
 * query --all; a fallback must instead address ONLY an already managed card.
 * No dispatchProof is produced: observation cannot reconcile an unknown action
 * or release its leases. Control adapters on the Router are never replaced. */
class OriginalLoopStatus extends LoopAdapter {
  constructor(c: Config, files: Files, readonly store: Store) { super(c, files); }
  override async status(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerSnapshot> {
    const before = this.store.task(request.taskId), p = this.config.projects.find(p => p.id === request.project || p.root === request.project);
    if (!before || !p || request.action === 'dispatch' || before.worker?.kind !== 'loop' || closed(before)) throw new SafeError('outside_scope', '没有仍受托管的原 Loop 执行');
    const version = JSON.stringify(before);
    if (await canonical(p.root) !== p.root || await canonical(request.batchFile) !== request.batchFile) throw new SafeError('identity_mismatch', '原项目或原卡路径身份变化');
    if (!request.loopBinding && ![p.root, ...(p.loop?.workspace ? [p.loop.workspace] : [])].some(root => inside(root, request.batchFile))) throw new SafeError('outside_scope', '原卡不在获准项目/原开发空间');
    const query = async (file: string, project: string) => parseJson<any>(await command(this.config.loop.command, [...this.config.loop.args, '查询', file, '--json'], this.config.loop.timeoutMs, project, undefined, signal));
    if (!this.config.loop.command) throw new SafeError('unavailable', '尚未配置 Loop 查询命令');
    const row = await query(request.batchFile, p.root);
    const launchObservation = request.launch ? await observeLaunch(this.config, request.launch) : undefined;
    let snapshot: WorkerSnapshot;
    if (row?.kernel === 1) {
      if (!request.loopBinding && (!request.launch || launchObservation?.kernelReceipt?.id !== row.id || launchObservation?.kernelReceipt?.card !== row.card)) throw new SafeError('unverified', '没有原运行绑定或原启动身份回执，不猜新版运行');
      const facts = await kernelFacts(this.config, this.files, row, query, signal);
      if (facts.project !== p.root || facts.binding.cardFile !== request.batchFile) throw new SafeError('identity_mismatch', '查询不是原项目/原卡');
      const { binding, task } = selectKernel(facts, request.loopBinding);
      if ((task ? [task] : facts.tasks).some(t => t.processIdentity === '未确认' || !t.active && !t.waiting && t.reason === '登记节点已不执行或身份无法确认')) throw new SafeError('unverified', '进展待核实：登记活动消失或原进程身份未确认；不能判断执行失败');
      if (request.loopBinding && !sameBinding(binding, request.loopBinding)) throw new SafeError('identity_mismatch', '查询不是原运行/原任务');
      const batch: LoopBatch = { project: facts.project, batch: { name: facts.name, file: binding.cardFile }, state: facts.state, stages: [], evidence: facts.evidence, kernel: facts };
      snapshot = { state: task?.state ?? facts.state, fingerprint: kernelFingerprint(facts, binding.taskId), loopBinding: binding, active: task ? task.active && !task.waiting : facts.tasks.some(t => t.active && !t.waiting), executable: false, data: batch };
    } else {
      // Legacy single-card receipts remain supported, but no global fallback or
      // guessing from a missing/empty/ambiguous response is allowed.
      const b = row?.v === 1 && Array.isArray(row.batches) && row.batches.length === 1 ? row.batches[0] : row;
      if (request.loopBinding || row?.v !== 1 || b?.project !== p.root || b?.batch?.file !== request.batchFile || !Array.isArray(b.stages)
        || !['running', 'started', 'resumed', 'queued', 'waiting', 'paused', 'needs-decision', 'repair-limit', 'done', 'failed', 'stopped'].includes(b.state)) throw new SafeError('invalid_receipt', '原卡查询身份/状态不完整，不能当成无任务');
      const branch = request.launch?.branch || before.verified?.branch;
      if (branch && b.branch !== branch) throw new SafeError('identity_mismatch', '原分支身份变化，不猜旧执行');
      const batch: LoopBatch = { project: p.root, batch: { file: request.batchFile, name: typeof b.batch.name === 'string' ? b.batch.name.slice(0, 200) : before.title }, state: b.state,
        stages: b.stages.slice(0, 200).map((s: any) => ({ stage: typeof s.stage === 'string' ? s.stage.slice(0, 200) : '', state: typeof s.state === 'string' ? s.state.slice(0, 40) : '', session: s.session ? { alive: s.session.alive === true } : null })), evidence: {} };
      snapshot = { state: batch.state, fingerprint: hash(JSON.stringify(batch)), active: batch.stages.some(s => s.session?.alive) || ['running', 'started', 'resumed'].includes(batch.state), executable: false, data: batch };
    }
    signal?.throwIfAborted();
    // A human/event may have changed or cancelled the task while I/O was in
    // flight. Workers.status must not commit a snapshot over that newer card.
    if (JSON.stringify(this.store.task(request.taskId)) !== version) throw new SafeError('observation_superseded', '原任务已变化，本轮观察让路');
    return { ...snapshot, ...(launchObservation ? { launchObservation } : {}) };
  }
}

/** Same status interface, but observations must not consume sourceRevision or
 * reconcile operations. Intake/Router still own normal event processing. */
class ObservationWorkers extends Workers {
  override async status(id: string, signal?: AbortSignal): Promise<Awaited<ReturnType<Workers['status']>>> {
    const card = this.store.task(id), worker = card?.worker;
    if (!card || !worker?.batchFile || worker.kind !== 'loop') return { ok: false, reason: '没有原 Loop 派工' };
    const pending = this.journal.unresolved(id).map(op => this.operation(op)).find(op => op?.state === 'uncertain' && op.request.action === 'dispatch');
    const original = pending?.request ?? (worker.operation ? this.operation(worker.operation)?.request : undefined);
    const request: WorkerRequest = { id: original?.id ?? `observation:${id}`, taskId: id, worker: 'loop', action: 'reply', project: worker.project, batchFile: worker.batchFile,
      stage: null, title: '', goal: '', completion: '', boundary: '', prompt: '', text: '', mode: 'send', redLine: false, options: {},
      loopBinding: worker.loop ?? original?.loopBinding, launch: original?.launch };
    const snapshot = await this.adapters.get('loop')!.status(request, signal);
    if (snapshot.loopBinding && ((snapshot.data as LoopBatch).kernel?.revision ?? -1) < (card.sourceRevision ?? -1)) return { ok: false, reason: '来源返回旧修订，保留最后核实事实；未作当前状态使用', card };
    return { ok: true, snapshot, card: this.store.task(id) };
  }
}

type PublicationResult = Awaited<ReturnType<Workers['messages']['publish']>>;
interface PublicationAttempt { attempted: boolean; result: PublicationResult }
interface Publication { version: string; inputId: string; approval?: ApprovalView }
interface Publishing { work: Promise<void>; signal?: AbortSignal; approval?: ApprovalView }
const publicationKey = (id: string) => `loop-monitor:publication:${id}`;
const publications = new WeakMap<Store, TaskPublications>();

/** Decorate the two existing TaskMessages publishers at the monitor seam.
 * Only one physical request per task is in flight. Busy callers persist the
 * latest intent and return immediately, so an owner turn never waits behind a
 * background send. The original TaskMessages keeps all delivery/ID safeguards. */
class TaskPublications {
  private readonly active = new Map<string, Publishing>();
  private readonly send: Workers['messages']['publish'];
  private recovery: Promise<void> = Promise.resolve();
  private onError?: (error: unknown) => void;
  constructor(readonly store: Store, readonly workers: Workers) { this.send = workers.messages.publish.bind(workers.messages); }
  readonly publish = (taskId: string, inputId: string, approval?: ApprovalView, signal?: AbortSignal): Promise<PublicationResult> => {
    if (!this.store.task(taskId)) return Promise.resolve(undefined);
    const previous = this.store.get<Publication | null>(publicationKey(taskId), null), active = this.active.get(taskId);
    const intent: Publication = { version: randomUUID(), inputId, approval: approval ?? previous?.approval ?? active?.approval };
    this.store.set(publicationKey(taskId), intent);
    if (active) { active.signal = signal; active.approval = intent.approval; return Promise.resolve(undefined); }
    const first = this.deliver(taskId, intent, signal);
    const slot: Publishing = { work: Promise.resolve(), signal, approval: intent.approval };
    slot.work = first.then(() => this.drain(taskId, slot)).catch(error => { this.active.delete(taskId); throw error; });
    this.active.set(taskId, slot);
    void slot.work.catch(error => this.onError?.(error));
    return this.waitForCaller(first, signal); // A cancelled caller does not cancel admitted channel I/O.
  };
  private waitForCaller(work: Promise<PublicationAttempt>, signal?: AbortSignal): Promise<PublicationResult> {
    if (!signal) return work.then(attempt => attempt.result);
    return new Promise<PublicationResult>((resolve, reject) => {
      const aborted = () => { signal.removeEventListener('abort', aborted); resolve(undefined); };
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      work.then(attempt => { signal.removeEventListener('abort', aborted); resolve(attempt.result); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
    });
  }
  private async deliver(taskId: string, intent: Publication, signal?: AbortSignal): Promise<PublicationAttempt> {
    // No TaskMessages/outbox claim before admission. A cancelled queued intent
    // remains durable for restart and cannot poison the last known message ID.
    if (signal?.aborted) return { attempted: false, result: undefined };
    // Revalidate queued confirmation projections at the actual send, never
    // restore consumed/stale buttons from the time the request was queued.
    const pending = this.store.get<string | null>(`worker:pending:${taskId}`, null);
    const op = intent.approval ? this.workers.operation(intent.approval.id) : null;
    const approval = op?.state === 'planned' && op.id === pending && op.request.taskId === taskId && op.token === intent.approval?.token ? intent.approval : undefined;
    // Once admitted, delivery belongs to the outbox, not the caller/monitor.
    // TaskMessages still bounds actual I/O by the channel deadline. This also
    // closes the cancellation gap before withDeadline's channel microtask;
    // shutdown waits idle() for admitted work, while callers may stop waiting.
    const result = await this.send(taskId, intent.inputId, approval);
    if (this.store.get<Publication | null>(publicationKey(taskId), null)?.version === intent.version) this.store.set(publicationKey(taskId), null);
    return { attempted: true, result }; // Preserve the underlying receipt; admission alone is never a sent result.
  }
  private async drain(taskId: string, slot: Publishing) {
    for (;;) {
      const next = this.store.get<Publication | null>(publicationKey(taskId), null);
      // Remove the live slot in the SAME turn as the empty check. A later
      // publisher must start a new drain, not enqueue behind a retiring one.
      if (!next) { this.active.delete(taskId); return; }
      const signal = slot.signal, attempt = await this.deliver(taskId, next, signal);
      if (!attempt.attempted && this.store.get<Publication | null>(publicationKey(taskId), null)?.version === next.version && slot.signal === signal) {
        this.active.delete(taskId); return; // Paused before I/O; keep the intent and the known delivery state.
      }
    }
  }
  start(onError: (error: unknown) => void) {
    this.onError = onError;
    // A queued confirmation may survive a crash AFTER the previous send was
    // recorded successful. Update that known original ID, never create a retry
    // of an interrupted/uncertain physical delivery.
    this.recovery = this.recover();
    void this.recovery.catch(onError);
  }
  private async recover() {
    for (const row of this.store.db.prepare("SELECT key FROM kv WHERE key GLOB 'loop-monitor:publication:*' AND value<>'null'").all()) {
      const taskId = String(row.key).slice('loop-monitor:publication:'.length), intent = this.store.get<Publication | null>(publicationKey(taskId), null);
      if (!intent || this.active.has(taskId)) continue;
      const messageKey = `task-message:${taskId}`, old = this.store.get<{ state: string; id?: string; digest: string } | null>(messageKey, null);
      if (old?.state === 'sending') {
        this.store.set(messageKey, { ...old, state: 'uncertain' });
        this.store.log('delivery_uncertain', { task: taskId, inputId: intent.inputId, outcome: '上次物理发卡未定案，不重发' });
      }
      await this.publish(taskId, intent.inputId, intent.approval);
    }
  }
  async idle() {
    // Startup recovery can itself admit more publications between requests.
    await this.recovery;
    while (this.active.size) await Promise.all([...this.active.values()].map(slot => slot.work));
  }
}

/** No model turns, intake discovery, worker controls, or watchdog side effects. */
export class LoopMonitor {
  readonly workers: Workers;
  private readonly publications: TaskPublications;
  private timer?: NodeJS.Timeout;
  private work?: Promise<void>;
  private readonly controller = new AbortController();
  constructor(readonly c: Config, readonly store: Store, workers: Workers, readonly now: () => number = Date.now) {
    this.workers = new ObservationWorkers(c, store, workers.channel, workers.files);
    this.workers.adapters.set('loop', new OriginalLoopStatus(c, workers.files, store));
    this.publications = publications.get(store) ?? new TaskPublications(store, workers);
    publications.set(store, this.publications);
    workers.messages.publish = this.publications.publish;
    this.workers.messages.publish = this.publications.publish;
  }
  start(onError: (error: unknown) => void) {
    if (this.timer || this.controller.signal.aborted) return;
    this.publications.start(onError);
    // Keep the default cadence independent of intake/watchdog/test clocks.
    this.timer = setInterval(() => { void this.tick().catch(onError); }, LOOP_MONITOR_MS);
  }
  tick(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.work) return this.work; // Coalesce; never queue missed polling rounds.
    this.work = this.scan().finally(() => { this.work = undefined; });
    return this.work;
  }
  async stop() {
    clearInterval(this.timer); this.timer = undefined;
    this.controller.abort(new SafeError('cancelled', 'PA 已停止观察，未停止原 Loop'));
    try { await this.work; } finally { await this.idle(); }
  }
  // App must join every remaining publisher (notably Router) before this final barrier.
  async idle() { await this.publications.idle(); }
  private async scan() {
    const tasks = this.store.db.prepare("SELECT id FROM tasks WHERE json_extract(body,'$.worker.kind')='loop' AND json_extract(body,'$.worker.batchFile')<>'' AND status NOT IN ('closed','cancelled','reconciled')").all();
    for (const row of tasks) {
      if (this.controller.signal.aborted) return;
      const card = this.store.task(String(row.id)); if (!card?.worker || closed(card)) continue;
      const saved = this.store.get<Observation | null>(key(card.id), null);
      const state: Observation = saved?.identity === identity(card) ? saved : { identity: identity(card), next: 0, failures: 0,
        ...(card.lastVerifiedAt ? { reliable: { at: card.lastVerifiedAt, state: card.verified?.state ?? card.status, basis: '原任务最后可靠核实记录' } } : {}) };
      if (card.worker.loop) state.revision = Math.max(state.revision ?? -1, card.sourceRevision ?? -1);
      // Event ingestion or an owner status lookup may have verified this same
      // execution more recently than our last poll. Do not report an older
      // timestamp/fact as the last successful verification.
      if (card.lastVerifiedAt && (!state.reliable || Date.parse(card.lastVerifiedAt) > Date.parse(state.reliable.at))) {
        state.reliable = { at: card.lastVerifiedAt, state: card.verified?.state ?? card.status, basis: '原任务最近的已核实记录（事件或状态查询）' };
      }
      if ((ended(card) || state.ended === endVersion(card)) && state.issue?.kind !== 'unverified' || this.now() < state.next) continue;
      await this.check(card, state);
    }
  }
  private async check(card: TaskCard, state: Observation) {
    const started = this.now();
    // Align due times to polling slots. Scheduling from query completion would
    // miss the next interval by its I/O duration and silently poll every 120s.
    const due = (period: number) => Math.floor(started / LOOP_MONITOR_MS) * LOOP_MONITOR_MS + period;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new SafeError('timeout', '原执行只读查询超过查询时限')), this.c.loop.timeoutMs);
    const signal = AbortSignal.any([this.controller.signal, timeout.signal]);
    let snapshot: WorkerSnapshot | undefined, reason = '';
    try {
      const result = await this.workers.status(card.id, signal);
      if (result.ok && result.snapshot) snapshot = result.snapshot;
      else reason = result.reason || '原执行状态不能核实';
    } catch (error) {
      if (error instanceof SafeError && error.category === 'observation_superseded') return;
      const safe = failure(timeout.signal.aborted ? timeout.signal.reason : error); reason = `${safe.category}：${safe.error}`;
    } finally { clearTimeout(timer); }
    if (this.controller.signal.aborted) return;
    const current = this.store.task(card.id);
    if (!current || closed(current) || identity(current) !== state.identity) return;
    const at = new Date(this.now()).toISOString();
    const batch = snapshot?.data as LoopBatch | undefined, facts = batch?.kernel;
    const selected = facts ? selectKernel(facts, current.worker?.loop).task : undefined;
    const targets = facts ? selected ? [selected] : facts.tasks : [];
    if (facts && facts.revision < Math.max(state.revision ?? -1, current.sourceRevision ?? -1)) {
      snapshot = undefined; reason = '来源返回旧观察修订，保留最后可靠事实；不据旧修订报告恢复';
    } else if (targets.some(t => t.processIdentity === '未确认' || !t.active && !t.waiting && t.reason === '登记节点已不执行或身份无法确认')) {
      snapshot = undefined; reason = '进展待核实：登记活动已消失或进程身份未确认；不能判断原执行失败';
    }
    const quiet = !!current.waiting || current.deferred || ['queued', 'waiting', 'paused', 'needs-decision', 'repair-limit', 'incomplete', '等你决定'].includes(snapshot?.state ?? current.status) || targets.some(t => t.waiting);
    state.next = due(quiet && state.issue?.kind !== 'unverified' && !state.failures ? LOOP_MONITOR_QUIET_MS : LOOP_MONITOR_MS);
    if (!snapshot) {
      state.next = due(LOOP_MONITOR_MS);
      state.failures++;
      this.store.log('loop_monitor_unverified', { task: card.id, identity: state.identity, at, failures: state.failures, reason });
      if (state.failures >= 2 && state.issue?.kind !== 'unverified') {
        state.issue = { kind: 'unverified', since: at };
        await this.publish(current, state, `状态待核实\n原执行：${this.target(current)}\n最后成功核实：${state.reliable?.at ?? '尚无成功核实记录'}\n最后可靠事实：${state.reliable ? `${state.reliable.state}；${state.reliable.basis}` : '未知；没有改成无任务/已完成'}\n失败原因：${reason}\n建议：检查 Loop 查询连接/权限，在原卡核对原执行；没有自动重启、续跑、停止或重派，未核实操作占用保留。`, at);
      } else this.store.set(key(card.id), state);
      return;
    }
    const basis = facts ? `原 ledger ${facts.binding.ledger}；修订 ${facts.revision}；${targets.map(t => `任务 ${t.id}：${t.reason}`).join('；')}` : `原卡只读查询 ${current.worker!.batchFile}：${snapshot.state}`;
    state.reliable = { at, state: snapshot.state, basis }; state.failures = 0;
    if (facts) state.revision = facts.revision;
    // A missing activity or reused PID is NOT an exit receipt. Only the formal
    // query's explicit exit-code report (or legacy failed state) is an alert.
    const exits = targets.filter(t => !t.active && !t.waiting && t.processIdentity === '无活动' && /^(?:开发会话已退出|启动失败)（退出码 [^）]+）/.test(t.reason));
    const explicitExit = exits.length > 0 || !facts && ['failed', 'stopped'].includes(snapshot.state);
    if (!facts) current.lastVerifiedAt = at; // Kernel observations live in KV, not the event-owned snapshot/cursor.
    if (!facts && ['failed', 'stopped'].includes(snapshot.state)) current.status = snapshot.state;
    if (!facts && snapshot.state === 'done') current.status = 'incomplete'; // Execution end is not completion qualification.
    state.ended = (facts ? ['可合入', '已合入', '已放弃'].includes(facts.state) : ['done', 'failed', 'stopped'].includes(snapshot.state)) ? endVersion(current) : undefined;
    if (explicitExit) {
      if (state.issue?.kind !== 'exit') {
        state.issue = { kind: 'exit', since: at };
        await this.publish(current, state, `原执行${facts ? '已退出' : snapshot.state === 'stopped' ? '已停止' : '失败已核实'}（不是业务完成）\n原执行：${this.target(current)}\n依据：${basis}\n最后成功核实：${at}\n建议：在原执行核对退出原因和已有成果，再决定下一步；没有自动重启、续跑、停止或重派，不据本次观察解除操作占用。`, at);
        return;
      }
    } else if (state.issue) {
      state.issue = undefined;
      await this.publish(current, state, `状态核实已恢复\n原执行：${this.target(current)}\n最后成功核实：${at}\n当前可靠事实：${snapshot.state}；${basis}\n执行、技术检查、发布与业务验收仍分列；没有自动重派或解除未核实操作占用。`, at);
      return;
    }
    this.store.putTask(current); this.store.set(key(card.id), state);
    this.store.log('loop_monitor_verified', { task: card.id, identity: state.identity, ...state.reliable });
  }
  private target(card: TaskCard) {
    const w = card.worker!;
    return `${card.id}；项目 ${w.project}；原卡 ${w.batchFile}${w.loop ? `；运行 ${w.loop.runId}；${w.loop.taskId ? `任务 ${w.loop.taskId}` : '原整批'}` : ''}`;
  }
  private async publish(card: TaskCard, state: Observation, notice: string, at: string) {
    const previous = state.notice;
    const base = previous && card.notice?.endsWith(previous) ? card.notice.slice(0, -previous.length).replace(/\n\n$/, '') : card.notice ?? '';
    card.notice = [base, notice].filter(Boolean).join('\n\n'); state.notice = notice;
    // Persist the episode together with its card BEFORE delivery. Restart or
    // delivery uncertainty must never create another notification for it.
    this.store.db.exec('BEGIN IMMEDIATE');
    try { this.store.putTask(card); this.store.set(key(card.id), state); this.store.db.exec('COMMIT'); }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.store.log('loop_monitor_notice', { task: card.id, identity: state.identity, at, kind: state.issue?.kind ?? 'recovery' });
    const pending = this.store.get<string | null>(`worker:pending:${card.id}`, null), op = pending ? this.workers.operation(pending) : null;
    await this.workers.messages.publish(card.id, `loop-monitor:${card.id}`, op?.state === 'planned' ? this.workers.view(op) : undefined, this.controller.signal);
  }
}
