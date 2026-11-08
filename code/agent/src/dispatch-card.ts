import { randomUUID } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Store } from './store.js';
import type { Config, LoopBinding, TaskCard } from './types.js';
import type { Files } from './files.js';
import { readBytes } from './file-policy.js';
import { processes } from './pi-process.js';
import type { WorkerOperation, WorkerSnapshot } from './worker.js';
import type { LoopBatch } from './loop.js';
import { sameBinding, type KernelFacts } from './loop-kernel.js';
import { hash, inside, parseJson } from './util.js';

export interface DispatchTarget {
  worker: string; project: string; batchFile: string; loop?: LoopBinding; epoch?: number;
  legacy?: { stage: string; host: string; sessionId: string; branch: string };
}
export interface DispatchCard {
  operation: string; task: string; token: string; owner: string; target: DispatchTarget;
  acceptedAt: string; messageId?: string; stopOperation?: string;
}
const key = (task: string) => `worker:dispatch-card:${task}`;
const owner = (card: TaskCard) => {
  const w = card.worker, b = w?.loop;
  return hash(JSON.stringify([card.id, card.goal, card.completion, card.boundary, w?.kind, w?.project, w?.batchFile, w?.operation,
    b ? [b.repository, b.runId, b.cardFile, b.ledger, b.taskId] : null]));
};
const ended = (card: TaskCard) => ['cancelled', 'closed', 'reconciled', 'done', 'incomplete', 'failed', 'stopped', 'interrupted', 'timed-out', '可合入', '已合入', '已放弃'].includes(card.status);

/** Stop confirmation is narrower than the batch execution lease. The existing
 * kernel executionEnded proof suffices when the whole run ended. Otherwise a
 * multi-task stop must inspect THIS task and shared consumers, not demand that
 * unrelated sibling task processes end. Raw protocol data never leaves here. */
export async function selectedLoopStopped(c: Config, files: Files, record: DispatchCard, snapshot: WorkerSnapshot) {
  const binding = record.target.loop, facts = (snapshot.data as LoopBatch | undefined)?.kernel;
  const task = facts?.tasks.find(t => t.id === binding?.taskId);
  if (!binding?.taskId || !facts || !snapshot.loopBinding || !sameBinding(binding, snapshot.loopBinding)
    || !task || task.active || task.waiting || task.processIdentity !== '无活动') return false;
  if (facts.executionEnded) return true;
  if (facts.tasks.length === 1) return false; // Do not bypass the existing whole-run consumer proof.
  const read = (path: string) => readBytes(path, () => files.protocolPath(facts.project, path), c.intake.maxFileBytes);
  try {
    const before = await read(binding.ledger), raw = parseJson<any>(before.data.toString('utf8'));
    if (raw.v !== 1 || raw.id !== binding.runId || raw.common !== binding.repository || raw.file !== binding.cardFile
      || raw.revision !== facts.revision || raw.dir !== dirname(binding.ledger) || raw.activity || !Array.isArray(raw.taskRecords)) return false;
    const selected = raw.taskRecords.filter((r: any) => r.id === binding.taskId && !r.removed);
    if (selected.length !== 1 || selected[0].name !== task.name) return false;
    const own = selected[0];
    if (own.activity || own.workerRequest && (!own.stopped || !own.worker) || own.session && !own.launch
      || typeof own.dir !== 'string' || own.dir === raw.dir || !inside(raw.dir, own.dir)
      || raw.taskRecords.some((r: any) => r !== own && r.dir === own.dir)) return false;
    const groups = [own.launch, own.supervisor, own.worker].filter(Boolean);
    if (groups.some(g => !Number.isSafeInteger(g.pid) || g.pid < 2 || typeof g.processStarted !== 'string' || !g.processStarted || typeof g.token !== 'string' || !g.token)) return false;
    const current = groups.length || own.session ? await processes() : [];
    if (groups.some(g => current.some(p => !p.state.includes('Z') && (p.pid === g.pid || p.pgid === g.pid)))) return false;
    if (own.session && (!Number.isSafeInteger(own.session.pid) || !own.session.started
      || current.some(p => !p.state.includes('Z') && p.pid === own.session.pid && p.started === own.session.started))) return false;
    const results = (Array.isArray(raw.results) ? raw.results : []).filter((r: any) => [raw.id, own.id].includes(r.task));
    const candidate = (v: any) => v && [v.commit, v.tree].every(s => typeof s === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(s)) ? [v.commit, v.tree] : null;
    // epoch belongs to attempt.json and is validated below. Formal NodeResult
    // omits it; compare only the identity fields shared by request and result.
    const identity = (a: any) => JSON.stringify([a.id, a.task, a.node, candidate(a.candidate), a.inputs, a.started]);
    const covered = new Set<unknown>(), checks = new Map<string, boolean>(); let visited = 0;
    // Parent review/test consumers are shared work; sibling task directories are not.
    for (const r of [raw, own]) {
      checks.set(join(r.dir, 'review.procs.json'), true);
      const root = join(r.dir, 'attempts'); await files.protocolPath(facts.project, root);
      const stat = await lstat(root).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return; throw e; });
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      for await (const entry of await opendir(root)) {
        if (++visited > 1000 || !entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) return false;
        const path = join(root, entry.name, 'attempt.json'), attempt = parseJson<any>((await read(path)).data.toString('utf8'));
        if (attempt.id !== entry.name || attempt.task !== r.id || !['开发评审', '测试', '验收', '提交'].includes(attempt.node)
          || !candidate(attempt.candidate) || typeof attempt.inputs !== 'string' || !attempt.inputs || !Number.isFinite(Date.parse(attempt.started))
          || !Number.isSafeInteger(attempt.epoch) || attempt.epoch < 0) return false;
        const matching = results.filter((v: any) => v.id === attempt.id);
        if (matching.length > 1) return false;
        const result = matching[0];
        if (result && (identity(result) !== identity(attempt) || result.released === true && !Number.isFinite(Date.parse(result.ended)))) return false;
        if (result) covered.add(result);
        checks.set(join(root, entry.name, 'test.procs.json'), result?.released === true);
      }
      const after = await lstat(root);
      if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || await files.protocolPath(facts.project, root) !== root) return false;
    }
    if (covered.size !== results.length) return false;
    for (const [base, allowMissing] of checks) for (const path of [base, `${base}.cleanup`]) {
      try {
        const consumers = parseJson<unknown>((await read(path)).data.toString('utf8'));
        if (!Array.isArray(consumers) || consumers.length) return false;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) return false; }
    }
    return before.data.equals((await read(binding.ledger)).data);
  } catch { return false; }
}

/** A receipt view on the existing task/operation journal, not another task ledger.
 * Tokens and targets are program-owned; no Router/model argument can mint them. */
export class DispatchCards {
  constructor(readonly store: Store) {}
  get(task: string) { return this.store.get<DispatchCard | null>(key(task), null); }
  current(card: TaskCard | undefined) {
    if (!card) return;
    const record = this.get(card.id);
    return record && record.owner === owner(card) ? record : undefined;
  }
  accept(op: WorkerOperation, snapshot?: WorkerSnapshot) {
    const card = this.store.task(op.request.taskId), r = op.request;
    if (op.state !== 'sent' || !(r.action === 'dispatch' || r.worker === 'pi' && r.action === 'reply')
      || !card?.worker?.batchFile || card.worker.kind !== r.worker || card.worker.batchFile !== r.batchFile
      || card.worker.operation && card.worker.operation !== op.id
      || snapshot?.loopBinding && card.worker.loop && !sameBinding(snapshot.loopBinding, card.worker.loop)
      || r.loopBinding && card.worker.loop && !sameBinding(r.loopBinding, card.worker.loop)
      || r.action === 'dispatch' && [r.goal, r.completion, r.boundary].join('\0') !== [card.goal, card.completion, card.boundary].join('\0')) return;
    const old = this.current(card);
    if (old?.operation === op.id) return old;
    if (r.worker !== 'loop' && !op.dispatchReceipt) return; // Do not replay pre-upgrade historical receipts.
    // An exited invocation can reconcile resource ownership without proving host
    // acceptance (e.g. a rejected startup). Never turn that into “已派出”.
    if (r.worker === 'loop') {
      const proof = snapshot?.dispatchProof, receipt = snapshot?.launchObservation?.kernelReceipt;
      const verified = r.launch && proof?.operation === op.id && proof.bindingHash === hash(JSON.stringify(r.launch))
        && (proof.phase === 'accepted' || !!proof.acceptance || receipt?.dispatched === true && receipt.id === snapshot?.loopBinding?.runId && receipt.card === r.batchFile);
      if (!verified && !(r.launch && op.resolution?.dispatchPhase === 'accepted' && op.resolution.evidence && op.resolution.bindingHash === hash(JSON.stringify(r.launch)))) return;
    }
    let binding = snapshot?.loopBinding ?? card.worker.loop;
    const facts = (snapshot?.data as LoopBatch | undefined)?.kernel ?? (card.verified?.snapshot as KernelFacts | undefined);
    // A PA single-task dispatch still uses --task. A multi-task source without a
    // selected stable ID must never acquire a batch-wide stop button.
    if (binding && binding.taskId === null && facts?.tasks?.length === 1) binding = { ...binding, taskId: facts.tasks[0]!.id };
    const epoch = binding?.taskId ? facts?.tasks?.find(t => t.id === binding.taskId)?.epoch : undefined;
    const acceptance = snapshot?.dispatchProof?.acceptance ?? op.resolution?.acceptance;
    const legacy = r.worker === 'loop' && !binding && r.launch?.protocol !== 'kernel:1' && acceptance
      ? { stage: acceptance.stage, host: acceptance.host, sessionId: acceptance.sessionId, branch: r.launch!.branch } : undefined;
    const record: DispatchCard = { operation: op.id, task: card.id, token: randomUUID(), owner: owner(card),
      target: { worker: r.worker, project: card.worker.project, batchFile: r.batchFile, ...(binding ? { loop: binding } : {}), ...(epoch !== undefined ? { epoch } : {}), ...(legacy ? { legacy } : {}) },
      acceptedAt: op.dispatchReceipt?.at ?? op.resolution?.at ?? new Date().toISOString() };
    this.store.set(key(card.id), record); return record;
  }
  stoppable(card: TaskCard, record = this.current(card)) {
    return record && !record.stopOperation && !ended(card) && !(record.target.loop && record.target.loop.taskId === null)
      && !(record.target.worker === 'loop' && !record.target.loop && !record.target.legacy) ? record : undefined;
  }
  published(task: string, token: string, messageId: string) {
    const record = this.get(task), card = this.store.task(task);
    if (record?.token === token && card && record.owner === owner(card)) this.store.set(key(task), { ...record, messageId });
  }
  valid(task: string, operation: unknown, token: unknown, messageId: string | undefined) {
    const card = this.store.task(task), record = card && this.stoppable(card);
    const message = this.store.get<{ state: string; id?: string } | null>(`task-message:${task}`, null);
    if (!record || record.operation !== operation || record.token !== token || !messageId || record.messageId !== messageId
      || message?.id !== messageId || !card!.subscriptions.some(s => s.kind === 'message' && s.value === messageId)) return;
    return record;
  }
  matches(record: DispatchCard, snapshot: WorkerSnapshot, checkEpoch = true) {
    const binding = record.target.loop;
    if (binding) {
      const task = (snapshot.data as LoopBatch | undefined)?.kernel?.tasks.find(t => t.id === binding.taskId);
      return !!snapshot.loopBinding && sameBinding(binding, snapshot.loopBinding) && (!checkEpoch || record.target.epoch === undefined || task?.epoch === record.target.epoch);
    }
    if (snapshot.loopBinding) return false;
    if (record.target.legacy) {
      const batch = snapshot.data as LoopBatch, target = record.target.legacy, session = batch.stages.find(t => t.stage === target.stage)?.session;
      return batch.branch === target.branch && session?.id === target.sessionId && session.host === target.host && (!checkEpoch || session.alive === true);
    }
    return record.target.worker !== 'loop';
  }
  /** Commit token consumption AND its approved operation before any worker effect.
   * A restart or competing callback can only observe a consumed token. */
  consume(record: DispatchCard, op: WorkerOperation, write: () => void) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.valid(record.task, record.operation, record.token, record.messageId)) { this.store.db.exec('COMMIT'); return false; }
      write(); this.store.set(key(record.task), { ...record, stopOperation: op.id });
      this.store.db.exec('COMMIT'); return true;
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  /** Only a durable, explicit no-effect outcome can issue a NEW click token.
   * Old callbacks stay consumed; executing/uncertain outcomes never rearm. */
  rearm(op: WorkerOperation) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const durable = this.store.get<WorkerOperation | null>(`worker:op:${op.id}`, null);
      if (!durable?.stopNotCalled || !['stale', 'blocked'].includes(durable.state) || !this.ownsStop(durable)) { this.store.db.exec('COMMIT'); return false; }
      const record = this.get(op.request.taskId)!;
      this.store.set(key(record.task), { ...record, token: randomUUID(), messageId: undefined, stopOperation: undefined });
      this.store.db.exec('COMMIT'); return true;
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  ownsStop(op: WorkerOperation) {
    const card = this.store.task(op.request.taskId), record = card && this.current(card), source = op.cardStop;
    return !!record && !!source && record.stopOperation === op.id && record.operation === source.dispatch
      && record.token === source.token && record.messageId === source.messageId
      && hash(JSON.stringify(record.target)) === source.targetHash;
  }
  describe(record: DispatchCard) {
    const t = record.target;
    return `原执行对象：${t.worker} · ${t.project}\n原派工编号：${record.operation}\n原执行：${t.batchFile}${t.loop ? `\n原运行：${t.loop.runId}\n原来源任务：${t.loop.taskId ?? '未唯一选定，不能整批停止'}` : t.legacy ? `\n原段：${t.legacy.stage}\n原会话：${t.legacy.host}/${t.legacy.sessionId}\n原分支：${t.legacy.branch}` : ''}\n接收核实时间：${record.acceptedAt}`;
  }
}
