import type { Store } from './store.js';
import type { LoopBinding } from './types.js';
import type { WorkerOperation, WorkerResolution } from './worker.js';
import { hash } from './util.js';

export const DISPATCH_MANUAL_ACK = '本人已在电脑核对：原开工/启动调用及所有相关进程已结束；终结此任务托管，核销原编号并释放其占用，不重发、不续跑、不代表业务通过。';
export interface DispatchReview { operation: string; token: string; identityHash: string; basisHash: string; description: string; by: string; at: string; state: 'pending' | 'consumed' | 'cancelled' | 'stale' }
export const operationIdentity = (op: WorkerOperation) => hash(JSON.stringify({ id: op.id, token: op.token, request: op.request, resources: op.resources }));
const reviewKey = (id: string) => `worker:dispatch-review:${id}`;

const operationKey = (id: string) => `worker:op:${id}`;
const unresolvedKey = (task: string) => `worker:unresolved:${task}`;
const leaseKey = (resource: string) => `worker:lease:${resource}`;
const unresolvedState = (op: WorkerOperation) => ['executing', 'uncertain'].includes(op.state);

/** Durable execution facts are independent of the task card's display status. */
export class WorkerJournal {
  constructor(readonly store: Store) {}
  operation(id: string) { return this.store.get<WorkerOperation | null>(operationKey(id), null); }
  private transaction<T>(run: () => T): T {
    const own = !this.store.db.isTransaction;
    if (own) this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); if (own) this.store.db.exec('COMMIT'); return result; }
    catch (error) { if (own) this.store.db.exec('ROLLBACK'); throw error; }
  }
  private executionKey(binding: LoopBinding) { return `worker:execution-unresolved:${hash(JSON.stringify([binding.repository, binding.runId, binding.cardFile]))}`; }
  unresolvedExecution(binding: LoopBinding) {
    return this.store.get<string[]>(this.executionKey(binding), []).filter(id => {
      const op = this.operation(id), target = op?.request.loopBinding;
      return !op || unresolvedState(op) && (!target || binding.taskId === null || target.taskId === null || target.taskId === binding.taskId);
    });
  }
  private index(op: WorkerOperation) {
    const keys = [unresolvedKey(op.request.taskId), ...(op.request.loopBinding ? [this.executionKey(op.request.loopBinding)] : [])];
    for (const key of keys) {
      const old = this.store.get<string[]>(key, []), ids = new Set(old);
      if (unresolvedState(op)) ids.add(op.id); else ids.delete(op.id);
      if (JSON.stringify([...ids]) !== JSON.stringify(old)) this.store.set(key, [...ids]);
    }
  }
  write(op: WorkerOperation) {
    this.transaction(() => {
      const old = this.operation(op.id);
      if (old?.state === 'uncertain' && op.state !== 'uncertain' && !op.resolution) throw new Error('原操作尚未按编号核销，不允许解除不确定状态');
      this.store.set(operationKey(op.id), op); this.index(op);
    });
  }
  unresolved(task: string) {
    return this.store.get<string[]>(unresolvedKey(task), []).filter(id => {
      const op = this.operation(id);
      return !op || unresolvedState(op); // A broken reference cannot grant permission.
    });
  }
  claim(op: WorkerOperation, expected: WorkerOperation['state']) {
    return this.transaction(() => {
      if (this.unresolved(op.request.taskId).some(id => id !== op.id)) return false;
      const execution = op.request.loopBinding;
      if (execution && this.unresolvedExecution(execution).some(id => id !== op.id)) return false;
      const controlKey = execution ? `worker:execution-use:${hash(JSON.stringify([op.thread, op.request.action, execution]))}` : undefined;
      if (controlKey && this.store.get<string>(controlKey, op.id) !== op.id) return false;
      const confirmationKey = op.confirmation ? `worker:instruction-use:${hash(JSON.stringify([op.confirmation.inputId, op.confirmation.sourceHash]))}` : undefined;
      if (confirmationKey && this.store.get<string>(confirmationKey, op.id) !== op.id) return false;
      const changed = this.store.db.prepare("UPDATE kv SET value=? WHERE key=? AND json_extract(value,'$.state')=?").run(JSON.stringify(op), operationKey(op.id), expected);
      if (changed.changes) { this.index(op); if (confirmationKey) this.store.set(confirmationKey, op.id); if (controlKey) this.store.set(controlKey, op.id); }
      return !!changed.changes;
    });
  }
  owners(resources: string[]) {
    return [...new Set(resources.flatMap(key => this.store.get<string[]>(leaseKey(key), [])))];
  }
  reserve(id: string, resources: string[], blockers: string[] = []) {
    return this.transaction(() => {
      const op = this.operation(id);
      if (!op || !['planned', 'approved'].includes(op.state) || this.owners([...resources, ...blockers]).some(owner => owner !== id)) return false;
      op.resources = resources; op.resourceState = 'held'; this.write(op);
      for (const key of resources) this.store.set(leaseKey(key), [id]);
      return true;
    });
  }
  retain(op: WorkerOperation, resources: string[]) {
    this.transaction(() => {
      op.resources = resources; op.resourceState = 'held'; this.write(op);
      for (const resource of resources) {
        const key = leaseKey(resource), owners = this.store.get<string[]>(key, []);
        // Recovery may find multiple legacy unresolved launches. Preserve ALL of
        // them; do not silently replace one hazard with the most recent owner.
        this.store.set(key, [...new Set([...owners, op.id])]);
      }
    });
  }
  review(id: string) { return this.store.get<DispatchReview | null>(reviewKey(id), null); }
  beginReview(review: DispatchReview) {
    return this.transaction(() => {
      const op = this.operation(review.operation);
      if (!op || op.state !== 'uncertain' || op.request.action !== 'dispatch' || operationIdentity(op) !== review.identityHash) return false;
      this.store.set(reviewKey(op.id), review); return true;
    });
  }
  endReview(id: string, token: string, state: 'cancelled' | 'stale') {
    const review = this.review(id);
    if (review?.token === token && review.state === 'pending') this.store.set(reviewKey(id), { ...review, state });
  }
  resolveDispatch(id: string, identityHash: string, resolution: WorkerResolution, terminal: boolean, update: (op: WorkerOperation) => void, reviewToken?: string) {
    return this.transaction(() => {
      const op = this.operation(id);
      if (!op || op.state !== 'uncertain' || op.request.action !== 'dispatch' || operationIdentity(op) !== identityHash) return;
      if (resolution.manual) {
        const review = this.review(id);
        if (!review || review.state !== 'pending' || review.token !== reviewToken || review.identityHash !== identityHash || review.basisHash !== resolution.basisHash) return;
        this.store.set(reviewKey(id), { ...review, state: 'consumed' });
      } else if (!op.request.launch || !resolution.evidence || resolution.bindingHash !== hash(JSON.stringify(op.request.launch)) || terminal && resolution.dispatchPhase !== 'exited') return;
      op.state = resolution.manual ? 'blocked' : 'sent'; op.reason = resolution.reason; op.resolution = resolution;
      this.write(op);
      if (terminal || resolution.manual) this.release(id, true, resolution);
      update(op); return op;
    });
  }
  release(id: string, confirmedTerminal = false, resolution?: WorkerResolution) {
    return this.transaction(() => {
      const op = this.operation(id);
      if (!op || op.resourceState !== 'held' || unresolvedState(op) || op.state === 'sent' && !confirmedTerminal) return false;
      if (op.state === 'sent' && op.request.launch && (!resolution?.evidence || resolution.dispatchPhase !== 'exited' || resolution.bindingHash !== hash(JSON.stringify(op.request.launch)))) return false;
      for (const resource of op.resources ?? []) {
        const key = leaseKey(resource);
        this.store.set(key, this.store.get<string[]>(key, []).filter(owner => owner !== id));
      }
      op.resourceState = 'released'; if (resolution) op.resourceResolution = resolution; this.write(op); return true;
    });
  }
}
