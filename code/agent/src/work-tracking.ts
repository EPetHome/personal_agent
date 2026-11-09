import type { Config, ExecutionFacts, Input, Material, TaskCard, WorkExecution, WorkRecord } from './types.js';
import type { Store } from './store.js';
import type { Files } from './files.js';
import type { WorkerOperation } from './worker.js';
import { hash } from './util.js';
import { SafeError } from './errors.js';
import { readBytes } from './file-policy.js';

export const executionKey = (ref: Pick<WorkExecution, 'kind' | 'sourceId' | 'sessionId' | 'instanceId' | 'executionId'>) => hash(JSON.stringify([ref.kind, ref.sourceId, ref.sessionId, ref.instanceId, ref.executionId]));
export const workRecord = (card: TaskCard): WorkRecord => card.work ?? { ownership: { kind: card.worker?.project ? 'project' : 'personal', ...(card.worker?.project ? { id: card.worker.project } : {}), resources: card.worker?.project ? [card.worker.project] : [] }, executions: [] };
export function ownerSource(c: Config, store: Store, input: Input, args: Record<string, unknown>) {
  const saved = store.row(input.id)?.input;
  if (!saved || saved.source !== 'feishu' || saved.who !== c.feishu.userId || saved.chatType !== 'p2p' || saved.button || !saved.messageId
    || input.source !== saved.source || input.who !== saved.who || input.chatType !== saved.chatType || input.messageId !== saved.messageId || input.text !== saved.text || args.instructionInput !== saved.id || args.instruction !== saved.text || !saved.text.trim()) throw new SafeError('owner_required', '须绑定本轮真实本人完整来话；材料/自报授权不能建立委托或关注');
  return { inputId: saved.id, messageId: saved.messageId, sourceHash: hash(saved.text) };
}
/** A secondary index into TaskCard, not another task ledger. No title/cwd joins. */
export function recordExecution(store: Store, taskId: string, ref: WorkExecution, makeCurrent = true) {
  return store.transaction(() => {
    const originId = taskId; taskId = store.taskTarget(taskId);
    const card = store.task(taskId); if (!card) throw new SafeError('not_found', '原事项不存在');
    if (ref.key !== executionKey(ref)) throw new SafeError('identity_mismatch', '执行身份不符');
    const key = `work:execution:${ref.key}`, bound = store.get<string | null>(key, null);
    if (bound && store.taskTarget(bound) !== taskId) throw new SafeError('identity_mismatch', '执行已属于另一事项；不能按同名或目录并账');
    const work = workRecord(card), previous = work.executions.find(e => e.key === ref.key);
    if (previous && ref.revision < previous.revision) return card;
    ref = { ...ref, originTaskId: ref.originTaskId ?? previous?.originTaskId ?? originId };
    if (previous) work.executions[work.executions.indexOf(previous)] = ref; else work.executions.push(ref);
    if (makeCurrent && (!work.currentExecution || !previous)) work.currentExecution = ref.key;
    card.work = work; store.putTask(card); store.set(key, taskId);
    if (originId !== taskId) {
      const anchor = store.task(originId)!; const original = workRecord(anchor), at = original.executions.findIndex(e => e.key === ref.key);
      if (at < 0) original.executions.push(ref); else original.executions[at] = ref;
      if (!original.currentExecution || at < 0 && makeCurrent) original.currentExecution = ref.key;
      anchor.work = original; store.putTask(anchor);
    }
    return card;
  });
}
export const executionFields = ['status', 'waiting', 'conclusion', 'updated', 'lastVerifiedAt', 'sourceRevision', 'sourceFingerprint', 'sourceHealth', 'sourceCurrent', 'verified', 'sourceDefinition', 'control', 'notice', 'presentation'] as const;
export const executionFacts = (card: TaskCard) => Object.fromEntries(executionFields.map(key => [key, card[key] ?? null])) as ExecutionFacts;
export function ownExecution(card: TaskCard) {
  const worker = card.worker;
  return worker && [...(card.work?.executions ?? [])].reverse().find(e => (!e.originTaskId || e.originTaskId === card.id) && e.kind === worker.kind
    && (worker.kind === 'pi' ? e.executionId === worker.batchFile : worker.loop ? e.sessionId === worker.loop.runId && e.instanceId === (worker.loop.taskId ?? '') : e.sessionId === worker.batchFile));
}
export function executionOrigin(store: Store, card: TaskCard) {
  const ref = card.work?.executions.find(e => e.key === card.work?.currentExecution);
  return ref && ['pi', 'loop'].includes(ref.kind) && ref.originTaskId ? store.task(ref.originTaskId) ?? card : card;
}
/** Immutable runtime IDs/operations stay on their original anchor. Only the
 * selected execution's facts are projected onto the business task. */
export function syncExecutionFacts(store: Store, source: TaskCard, key = ownExecution(source)?.key, event?: string) {
  if (!key) return;
  store.transaction(() => {
    const facts = executionFacts(source); store.set(`work:fact:${key}`, facts);
    const id = store.taskTarget(source.id), target = store.task(id); if (!target) return;
    const work = workRecord(target);
    if (work.currentExecution === key) {
      if (id === source.id) delete work.current; else work.current = facts;
      target.work = work;
      if (id !== source.id && !target.worker && !['cancelled', 'closed', 'reconciled'].includes(target.status)) Object.assign(target, facts);
      store.putTask(target);
    }
    if (event) store.db.prepare('INSERT OR IGNORE INTO task_events VALUES(?,?)').run(id, event);
  });
}
function ensureWorkerExecution(store: Store, card: TaskCard) {
  if (ownExecution(card) || !card.worker?.batchFile || !['pi', 'loop'].includes(card.worker.kind)) return;
  const w = card.worker, b = w.loop, identity = { kind: w.kind as 'pi' | 'loop', sourceId: b?.repository ?? w.project, sessionId: b?.runId ?? (w.kind === 'pi' ? card.id : w.batchFile), instanceId: b?.taskId ?? (b ? '' : 'pa'), executionId: w.kind === 'pi' ? w.batchFile : b ? '0' : w.operation ?? w.batchFile };
  const at = card.lastVerifiedAt ?? card.updated;
  recordExecution(store, card.id, { ...identity, key: executionKey(identity), originTaskId: card.id, revision: card.sourceRevision ?? 0, origin: w.origin === 'owner-loop' ? 'owner' : 'pa', state: card.status, observedAt: at, receivedAt: at, verifiedAt: at });
}
export function loopExecution(store: Store, card: TaskCard, epoch: number, state: string, at: string) {
  const b = card.worker?.loop; if (!b) return;
  const identity = { kind: 'loop' as const, sourceId: b.repository, sessionId: b.runId, instanceId: b.taskId ?? '', executionId: String(epoch) }, key = executionKey(identity);
  const results = (card.verified?.layers as { results?: unknown[] } | undefined)?.results ?? [];
  const sourceResults = results.flatMap(value => { const r = value as { id?: string; task?: string; node?: string; status?: string; epoch?: number };
    return r.task === b.taskId && r.id ? [{ id: r.id, node: r.node ?? '', state: r.status ?? '', association: r.epoch === epoch ? 'execution' as const : 'task-only' as const }] : []; });
  return store.transaction(() => {
    const ownerId = store.get<string | null>(`work:execution:${key}`, null), owner = ownerId ? store.task(ownerId) : undefined;
    if (owner && owner.id !== store.taskTarget(card.id)) {
      const old = owner.worker?.loop;
      // Discovery may win the race before a verified managed receipt arrives.
      // This join is the exact repository/run/card/ledger/task identity, never cwd/title.
      if (card.worker?.origin !== 'pa' || !card.worker.operation || owner.worker?.origin !== 'owner-loop' || ['cancelled', 'reconciled'].includes(owner.status)
        || !old || old.repository !== b.repository || old.runId !== b.runId || old.cardFile !== b.cardFile || old.ledger !== b.ledger || old.taskId !== b.taskId) {
        card.sourceHealth = { ok: false, checkedAt: at, reason: '同一原执行已有其他事项绑定，归属待核对；不按名称并账' }; store.putTask(card); return card;
      }
      const work = workRecord(card);
      for (const execution of workRecord(owner).executions) {
        if (!work.executions.some(e => e.key === execution.key)) work.executions.push(execution);
        store.set(`work:execution:${execution.key}`, card.id);
      }
      card.work = work; store.putTask(card);
      owner.status = 'closed'; owner.notice = `可靠原执行已由 PA 原回执关联至 ${card.id}；原 ID/历史/消息保留，没有重派`;
      store.putTask(owner); store.set(`work:alias:${owner.id}`, card.id);
    }
    recordExecution(store, card.id, { ...identity, key, originTaskId: card.id, revision: card.sourceRevision ?? 0, origin: card.worker?.origin === 'pa' ? 'pa' : 'owner', state, observedAt: at, receivedAt: at, verifiedAt: at, sourceResults });
    syncExecutionFacts(store, store.task(card.id)!, key);
    return store.task(card.id)!;
  });
}
export function operationExecution(store: Store, op: WorkerOperation) {
  if (op.request.worker !== 'pi' || op.request.action === 'stop' || op.request.batchFile !== op.id || !['executing', 'sent', 'uncertain'].includes(op.state) || !store.task(op.request.taskId)) return;
  const identity = { kind: 'pi' as const, sourceId: op.request.project, sessionId: op.request.taskId, instanceId: 'pa', executionId: op.request.batchFile };
  const key = executionKey(identity), card = store.task(op.request.taskId)!;
  const old = card.work?.executions.find(e => e.key === key), at = new Date().toISOString();
  const job = store.get<{ state: string } | null>(`pi:job:${op.request.batchFile}`, null);
  recordExecution(store, card.id, { ...identity, key, revision: (old?.revision ?? 0) + 1, origin: 'pa', state: job?.state ?? op.state, observedAt: at, receivedAt: old?.receivedAt ?? at, verifiedAt: at, ...(old?.result ? { result: old.result } : {}) });
}
export class WorkTracking {
  constructor(readonly c: Config, readonly store: Store, readonly files: Files) {}
  async authorize(card: TaskCard) {
    for (const material of [...(card.work?.materials ?? []), ...(card.work?.executions.flatMap(e => e.result?.refs ?? []) ?? [])]) if (!material.path.startsWith('task://')) await this.files.check(material.path, true);
  }
  async organize(id: string, ownership: WorkRecord['ownership'], input: Input, args: Record<string, unknown>) {
    ownerSource(this.c, this.store, input, args);
    const card = this.store.task(id); if (!card) throw new SafeError('not_found', '未找到原事项');
    await this.authorize(card);
    if (!['personal', 'project', 'unassigned'].includes(ownership.kind) || !Array.isArray(ownership.resources) || ownership.resources.some(r => !this.c.projects.some(p => p.id === r))) throw new SafeError('outside_scope', '业务归组只能引用已有授权资源，不产生权限');
    if (ownership.kind === 'project' && (!ownership.id || ownership.id.length > 160)) throw new SafeError('invalid_arguments', '业务项目须有稳定 ID');
    card.work = { ...workRecord(card), ownership }; this.store.putTask(card); return { ok: true, card };
  }
  async track(id: string, endpoint: string, input: Input, args: Record<string, unknown>) {
    const source = ownerSource(this.c, this.store, input, args), card = this.store.task(id);
    if (!card || ['closed', 'cancelled', 'reconciled'].includes(card.status)) throw new SafeError('not_found', '原事项不存在或已取消');
    await this.authorize(card);
    if (!endpoint.trim() || endpoint.length > 2000) throw new SafeError('invalid_arguments', '只补缺少的一次性责任终点');
    const work = workRecord(card);
    if (work.tracking?.state === 'active' && work.tracking.endpoint === endpoint) return { ok: true, card, duplicate: true };
    work.tracking = { endpoint, state: 'active', inputId: source.inputId }; card.work = work; this.store.putTask(card);
    return { ok: true, card, receipt: `已跟踪本次事项；终点：${endpoint}。核实并回报后结束，不包含未来新工作。` };
  }
  /** Explicit linkage only: the owner correction refers to both original IDs. */
  async link(fromId: string, targetId: string, input: Input, args: Record<string, unknown>) {
    ownerSource(this.c, this.store, input, args);
    if (fromId === targetId || ![fromId, targetId].every(id => input.text.includes(id))) throw new SafeError('identity_mismatch', '关联须由本人明确引用两个原事项 ID，不按标题猜');
    let from = this.store.task(fromId), target = this.store.task(targetId);
    if (!from || !target || ['cancelled', 'closed', 'reconciled'].includes(target.status)) throw new SafeError('not_found', '原事项不存在或已关闭');
    await this.authorize(from); await this.authorize(target);
    const alias = this.store.get<string | null>(`work:alias:${fromId}`, null);
    if (alias === targetId) return { ok: true, card: target, originalId: fromId, duplicate: true };
    if (alias || this.store.taskTarget(targetId) !== targetId) throw new SafeError('identity_mismatch', '原记录已有关联，请引用当前原事项再纠正，不转移旧执行');
    return this.store.transaction(() => {
      ensureWorkerExecution(this.store, from!); ensureWorkerExecution(this.store, target!);
      from = this.store.task(fromId)!; target = this.store.task(targetId)!;
      if (ownExecution(from)) this.store.set(`work:fact:${ownExecution(from)!.key}`, executionFacts(from));
      if (ownExecution(target)) this.store.set(`work:fact:${ownExecution(target)!.key}`, executionFacts(target));
      for (const ref of workRecord(from).executions) {
        this.store.set(`work:execution:${ref.key}`, targetId);
        recordExecution(this.store, targetId, { ...ref, originTaskId: ref.originTaskId ?? fromId }, false);
      }
      const current = this.store.task(targetId)!;
      current.work = { ...workRecord(current), materials: [...(current.work?.materials ?? []), ...(from.work?.materials ?? [])], attentionIds: [...new Set([...(current.work?.attentionIds ?? []), ...(from.work?.attentionIds ?? [])])], tracking: current.work?.tracking ?? from.work?.tracking };
      if (from.work?.currentExecution && !['closed', 'cancelled', 'reconciled'].includes(from.status)) {
        current.work.currentExecution = from.work.currentExecution;
        if (from.observation) { current.observation = { ...from.observation, definition: 'owner' }; current.sourceRevision = from.sourceRevision; current.sourceFingerprint = from.sourceFingerprint; current.sourceCurrent = from.sourceCurrent; current.sourceHealth = from.sourceHealth; current.lastVerifiedAt = from.lastVerifiedAt; }
        else if (from.worker) delete current.observation;
      }
      if (current.work.currentExecution) current.work.current = this.store.get<ExecutionFacts | undefined>(`work:fact:${current.work.currentExecution}`, undefined);
      this.store.putTask(current); this.store.set(`work:alias:${fromId}`, targetId);
      // An active PA job/Loop must keep its original runtime anchor. Closing it
      // would cancel its scheduler/receipt path and invalidate old operations.
      from.work = { ...workRecord(from), linkedTo: targetId };
      if (!from.worker) from.status = 'closed';
      from.notice = `本人明确关联至 ${targetId}；原 ID、执行、操作和历史保留，没有重派`; this.store.putTask(from);
      return { ok: true, card: current, originalId: fromId };
    });
  }
  async local(args: Record<string, unknown>, input: Input, materials: Material[]) {
    const instruction = ownerSource(this.c, this.store, input, args), id = String(args.id ?? '');
    if (!/^[\w\p{L}.:@-]{1,160}$/u.test(id)) throw new SafeError('invalid_arguments', '事项 ID 无效');
    const previous = this.store.task(id);
    if (previous && (previous.worker || previous.observation || ['cancelled', 'closed', 'reconciled'].includes(previous.status))) throw new SafeError('identity_mismatch', '不能覆盖已执行/关闭的原事项');
    if (previous) await this.authorize(previous);
    const refs = materials.filter(m => m.path.startsWith('/') && /^[a-f0-9]{64}$/.test(m.sha256));
    for (const ref of refs) {
      const { data } = await readBytes(ref.path, () => this.files.check(ref.path, true), this.c.intake.maxFileBytes);
      if (hash(data) !== ref.sha256) throw new SafeError('file_changed', '材料版本已变；请重新读取再形成交付');
    }
    if (!['working', 'delivered'].includes(String(args.state))) throw new SafeError('invalid_arguments', '本地事项状态只能是 working 或 delivered');
    const done = args.state === 'delivered', summary = String(args.summary ?? '');
    if (done && (!summary.trim() || !refs.length)) throw new SafeError('missing_evidence', '本地交付须有本轮实际读取的材料及文本结论，不能用提交号/模型自称冒充依据');
    if (![args.title, args.goal, args.completion, args.boundary].every(v => typeof v === 'string' && v.trim())) throw new SafeError('invalid_arguments', '缺少目标、完成标准或边界');
    const now = new Date().toISOString();
    const card: TaskCard = { ...(previous ?? { id, dispatches: [], subscriptions: [], waiting: '', conclusion: '' }), title: String(args.title), goal: String(args.goal), completion: String(args.completion), boundary: String(args.boundary), status: done ? 'delivered' : 'working', updated: now };
    const work = workRecord(card);
    card.work = { ...work, instruction: work.instruction ?? instruction, materials: [...(work.materials ?? []), ...refs].filter((m, i, all) => all.findIndex(v => v.path === m.path && v.sha256 === m.sha256) === i) };
    if (done) card.conclusion = summary;
    card.lastVerifiedAt = now; card.sourceHealth = { ok: true, checkedAt: now };
    const identity = { kind: 'local' as const, sourceId: 'owner-local', sessionId: id, instanceId: 'pa', executionId: input.id };
    return this.store.transaction(() => {
      this.store.putTask(card);
      return { ok: true, card: recordExecution(this.store, id, { ...identity, key: executionKey(identity), origin: 'pa', revision: 1, state: done ? 'delivered' : 'working', observedAt: now, receivedAt: now, verifiedAt: now, ...(done ? { result: { summary, refs, verified: true } } : {}) }), receipt: done ? '本地文本交付已记录；依据可追问。未对外发送，业务未验。' : '已登记本次本地事项；不要求 Git 或代码评审。' };
    });
  }
}
