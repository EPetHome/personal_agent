import { sameBinding as sameSourceBinding } from './loop-kernel.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Config, Input, Material, TaskCard, LoopBinding } from './types.js';
import type { Store } from './store.js';
import type { Channel } from './channel.js';
import type { Files } from './files.js';
import { LoopAdapter, LoopLookupError, currentLoopEvent, loopResources, LOOP_UNVERIFIED_RESOURCE, type LoopBatch } from './loop.js';
import { WorkerJournal, operationIdentity, DISPATCH_MANUAL_ACK, type DispatchReview } from './worker-journal.js';
import { observeLaunch, type DispatchLaunch, type LaunchObservation, type OwnedLauncher } from './loop-launch.js';
import { TaskMessages, type ApprovalView } from './cards.js';
import { canonical, hash, parseJson } from './util.js';
import { PiAdapter, piOptions } from './pi.js';
import { SafeError, failure } from './errors.js';
import { turns } from './context.js';
import { kernelFingerprint, repository, selectKernel, sameBinding, type KernelFacts } from './loop-kernel.js';
import { ownerInstruction, redLineText, requestHash, type InstructionConfirmation, type CardStopConfirmation } from './confirmation.js';
import { DispatchCards, selectedLoopStopped } from './dispatch-card.js';
import { Attention } from './attention.js';
import { readBytes } from './file-policy.js';
import { observationGrant, PiObservation } from './pi-observation.js';
import { executionKey, executionOrigin, loopExecution, ownExecution, recordExecution, syncExecutionFacts, workRecord } from './work-tracking.js';

export type WorkerAction = 'dispatch' | 'reply' | 'stop';
export interface WorkerRequest {
  id: string; taskId: string; worker: string; action: WorkerAction; project: string; batchFile: string; stage: string | null;
  title: string; goal: string; completion: string; boundary: string; prompt: string; text: string; mode: 'send' | 'resume'; redLine: boolean; options: Record<string, unknown>;
  launch?: DispatchLaunch; loopBinding?: LoopBinding; sourceTaskId?: string; lookupKernel?: boolean;
  /** Program-only approval binding; never accepted from Router/model arguments. */
  expectedFingerprint?: string;
}
export interface DispatchAcceptance { stage: string; host: string; sessionId: string; source: 'spawn-event' | 'legacy-running'; wrapper: OwnedLauncher; child?: OwnedLauncher }
export interface DispatchProof { operation: string; bindingHash: string; evidence: { path: string; sha256: string }; state: string; phase: 'accepted' | 'exited'; acceptance?: DispatchAcceptance; terminal: boolean }
export interface WorkerSnapshot { loopBinding?: LoopBinding; unavailableReason?: string; state: string; fingerprint: string; next?: string; executable?: boolean; resources?: string[]; resourceReleased?: boolean; active?: boolean; dispatchProof?: DispatchProof; launchObservation?: LaunchObservation; data: unknown }
export interface WorkerEvent { project: string; batchFile: string; stage: string | null; status: string; detail: Record<string, unknown> }
export interface WorkerReceipt { status: 'sent' | 'blocked' | 'uncertain'; reason: string; workerId?: string; snapshot?: WorkerSnapshot }
/** Every adapter implements exactly these seven actions; Router never invokes CLI details. */
export interface WorkerAdapter {
  readonly kind: string;
  dispatch(request: WorkerRequest, checkpoint: (batchFile: string, launch?: DispatchLaunch) => void, signal?: AbortSignal): Promise<WorkerReceipt>;
  status(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerSnapshot>;
  progress(event: WorkerEvent): Promise<WorkerEvent>;
  ask(event: WorkerEvent): Promise<WorkerEvent>;
  reply(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerReceipt>;
  result(event: WorkerEvent, snapshot: WorkerSnapshot, signal?: AbortSignal): Promise<boolean>;
  stop(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerReceipt>;
}
export interface WorkerResolution { event: string; reason: string; by?: string; at?: string; manual?: boolean; bindingHash?: string; basisHash?: string; dispatchPhase?: 'accepted' | 'exited'; acceptance?: DispatchAcceptance; evidence?: { path: string; sha256: string } }
export interface WorkerOperation {
  id: string; thread: string; tool: string; args: Record<string, unknown>; request: WorkerRequest; token: string;
  state: 'planned' | 'approved' | 'rejected' | 'executing' | 'sent' | 'blocked' | 'uncertain' | 'stale' | 'cancelled';
  basis: WorkerSnapshot; definition: string; needsApproval: boolean; by?: string; reason: string; confirmation?: InstructionConfirmation; failure?: ReturnType<typeof failure>;
  resources?: string[]; resourceState?: 'held' | 'released'; resolution?: WorkerResolution; resourceResolution?: WorkerResolution;
  dispatchReceipt?: { at: string; snapshot?: WorkerSnapshot }; cardStop?: CardStopConfirmation;
  /** Program-owned proof of a definite pre-effect rejection; never inferred from an unknown result. */
  stopNotCalled?: boolean;
}
export interface PendingAction { name: string; args: Record<string, unknown> }
export interface ApprovalGroup { operations: string[] }
const groupKey = (thread: string) => `worker:group:${thread}`;
const terminal = (card: TaskCard) => ['cancelled', 'closed', 'reconciled'].includes(card.status);
const definition = (card: TaskCard) => hash(JSON.stringify([card.goal, card.completion, card.boundary, card.worker, terminal(card)]));
const actionFor = (name: string): WorkerAction => {
  if (name === 'worker_dispatch') return 'dispatch';
  if (name === 'worker_reply') return 'reply';
  if (name === 'worker_stop') return 'stop';
  throw new SafeError('unavailable', '当前不可用，请回电脑操作');
};
const str = (a: Record<string, unknown>, k: string) => typeof a[k] === 'string' ? a[k] as string : '';
const activeStates = ['running', 'started', 'resumed'];
function layers(detail: Record<string, unknown>) {
  const gate = detail.gate, review = detail.review, acceptance = detail.acceptance;
  const passed = (v: unknown) => typeof v === 'string' && ['通过', 'pass', 'passed', '全部通过', '沿用原完成资格'].includes(v);
  const reviewStages = (review as { stages?: unknown[] } | undefined)?.stages;
  const reviews = Array.isArray(review) ? review : Array.isArray(reviewStages) ? reviewStages : [review];
  const reviewOk = reviews.length > 0 && reviews.every(r => r && typeof r === 'object' && passed(r.verdict) && r.mustFix === 0);
  const a = acceptance as { verdict?: unknown; failed?: unknown[]; partial?: unknown[]; manual?: unknown[] } | undefined;
  const acceptanceOk = !!a && passed(a.verdict) && Array.isArray(a.failed) && !a.failed.length && Array.isArray(a.partial) && !a.partial.length;
  const gatesOk = Array.isArray(gate) ? gate.length > 0 && gate.every(g => g && typeof g === 'object' && passed(g.result)) : passed(gate);
  return { complete: gatesOk && reviewOk && acceptanceOk, value: { gate: gate ?? '未验证', review: review ?? '未验证', acceptance: acceptance ?? '未验证' }, manual: a?.manual ?? [] };
}
export class Workers {
  readonly adapters = new Map<string, WorkerAdapter>();
  readonly messages: TaskMessages;
  readonly journal: WorkerJournal;
  readonly dispatchCards: DispatchCards;
  readonly pi: PiAdapter;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  constructor(readonly config: Config, readonly store: Store, readonly channel: Channel, readonly files: Files) {
    this.adapters.set('loop', new LoopAdapter(config, files));
    this.pi = new PiAdapter(config, store, files); this.adapters.set('pi', this.pi);
    const observations = new PiObservation(config, store, files);
    this.messages = new TaskMessages(store, channel, async (card, inherited) => {
      await observations.authorize(card);
      const sources = { ...inherited };
      for (const [id, grant] of Object.entries(inherited)) if (observationGrant(observations.source(id)) !== grant) throw new SafeError('outside_scope', '卡片依赖的观察来源已撤销或变更');
      for (const id of new Set([...(card.observation ? [card.observation.sourceId] : []), ...(card.work?.executions.filter(e => e.kind === 'pi-observation').map(e => e.sourceId) ?? [])])) sources[id] = observationGrant(observations.source(id));
      for (const [id, grant] of Object.entries(sources)) if (observationGrant(observations.source(id)) !== grant) throw new SafeError('outside_scope', '卡片依赖的观察来源已撤销或变更');
      return { sources, access: hash(JSON.stringify([config.projects, config.readAllow, config.readDeny])) };
    });
    this.journal = new WorkerJournal(store);
    this.dispatchCards = new DispatchCards(store);
  }
  private adapter(kind: string) { const a = this.adapters.get(kind); if (!a) throw new SafeError('unavailable', 'worker 尚未接入'); return a; }
  operation(id: string) { return this.journal.operation(id); }
  private save(op: WorkerOperation) { this.journal.write(op); }
  private id(thread: string, name: string, args: Record<string, unknown>) { return hash(JSON.stringify([thread, name, args])).slice(0, 48); }
  private requiresExplicitApproval(request: WorkerRequest) {
    if (request.redLine || redLineText(`${request.goal}\n${request.prompt}`)) return true;
    if (request.worker !== 'pi' || request.action === 'stop') return false;
    const options = request.action === 'dispatch' ? piOptions(request.options) : this.pi.job(request.batchFile)?.plan.options;
    return !options || options.commands || options.network || options.editFiles.length > 0;
  }
  private draftHash(request: WorkerRequest) {
    return hash(JSON.stringify([request.taskId, request.worker, request.title, request.goal, request.completion, request.boundary, request.prompt, request.options]));
  }
  private instruction(thread: string | undefined, request: WorkerRequest, args: Record<string, unknown>): (NonNullable<ReturnType<typeof ownerInstruction>> & { clarifiedBy?: InstructionConfirmation['clarifiedBy'] }) | undefined {
    // Eligibility and execution use the SAME resolved identity/options, not raw
    // model arguments with a different default worker. Mandatory consent wins.
    if (request.action !== 'dispatch' || this.requiresExplicitApproval(request) || !['loop', 'pi'].includes(request.worker)) return;
    const input = turns.getStore()?.input ?? (thread ? this.store.row(thread)?.input : undefined);
    if (!input || this.store.row(input.id)?.input.text !== input.text) return;
    const direct = ownerInstruction(this.config, input, args);
    if (direct) return direct;
    // Only a previously recorded missing-PROJECT fact can be supplemented. No
    // new goal/options/actions may piggyback on an unrelated later owner input.
    const draft = this.store.get<{ argsHash: string; source: NonNullable<ReturnType<typeof ownerInstruction>>; cancelled?: boolean } | null>(`worker:clarify:${str(args, 'taskId')}`, null);
    const project = this.config.projects.find(p => p.id === request.project || p.root === request.project);
    if (!draft || draft.cancelled || !project || draft.argsHash !== this.draftHash(request) || draft.source.inputId !== args.instructionInput || draft.source.quote !== args.instruction
      || input.source !== 'feishu' || input.who !== this.config.feishu.userId || input.chatType !== 'p2p' || input.button || !input.messageId) return;
    const answer = input.text.trim().replace(/^项目\s*[:：是]\s*/, '');
    if (![project.id, project.root].includes(answer)) return;
    const original = this.store.row(draft.source.inputId)?.input;
    if (!ownerInstruction(this.config, original, args) || hash(original!.text.trim()) !== draft.source.sourceHash) return;
    return { ...draft.source, clarifiedBy: { inputId: input.id, messageId: input.messageId, quote: input.text.trim(), sourceHash: hash(input.text.trim()) } };
  }
  private approvalRequired(request: WorkerRequest, args: Record<string, unknown>, thread?: string) {
    if (this.requiresExplicitApproval(request)) return true;
    if (this.instruction(thread, request, args)) return false;
    if (request.worker === 'pi' && request.action === 'dispatch' && piOptions(request.options).type === 'read') return this.config.approval.readPi;
    return this.config.approval[request.action === 'reply' ? 'send' : request.action];
  }
  needsApproval(name: string, args: Record<string, unknown>, thread?: string) {
    try {
      const request = this.request(thread ?? turns.getStore()?.input.id ?? '', name, args);
      return this.approvalRequired(request, args, thread);
    } catch { return true; } // Invalid/conflicting requests cannot bypass HITL; prepare reports the safe cause.
  }
  async status(id: string, signal?: AbortSignal, original = false): Promise<{ ok: boolean; reason?: string; snapshot?: WorkerSnapshot; card?: TaskCard; executionTaskId?: string }> {
    const card = this.store.task(id);
    const origin = card && executionOrigin(this.store, card);
    if (!original && origin && origin.id !== id) return { ...await this.status(origin.id, signal, true), card: this.store.workTask(id), executionTaskId: origin.id };
    if (!card?.worker?.batchFile) return { ok: false, reason: '没有原派工' };
    const pending = this.journal.unresolved(id).map(op => this.operation(op)).find(op => op?.state === 'uncertain' && op.request.action === 'dispatch');
    if (pending) {
      const probe = await this.probeDispatch(pending, signal);
      if (probe.snapshot) {
        if (probe.snapshot.loopBinding) this.refreshKernelCard(card, probe.snapshot, `status:${id}`);
        await this.reconcileDispatch(pending, probe.snapshot, `status:${id}`, signal);
      }
      return { ok: !!probe.snapshot, snapshot: probe.snapshot, reason: probe.description, card: this.store.task(id) };
    }
    const request = this.request(`status:${id}`, 'worker_reply', { taskId: id, mode: 'send' });
    const snapshot = await this.adapter(request.worker).status(request, signal);
    if (snapshot.loopBinding) {
      if (((snapshot.data as LoopBatch).kernel?.revision ?? -1) < (card.sourceRevision ?? -1)) return { ok: false, reason: '来源返回旧修订，保留最后核实事实；未作当前状态使用', card };
      this.refreshKernelCard(card, snapshot, `status:${id}`);
    }
    return { ok: true, snapshot, card: this.store.task(id) };
  }
  private request(thread: string, name: string, args: Record<string, unknown>): WorkerRequest {
    const action = actionFor(name), taskId = str(args, 'taskId');
    if (action === 'reply' && !['send', 'resume'].includes(str(args, 'mode'))) throw new SafeError('unavailable', '此操作当前不可用，请回电脑操作');
    if (!taskId || taskId.length > 160 || !/^[\w\p{L}.:@-]+$/u.test(taskId)) throw new SafeError('invalid_arguments', '任务编号无效');
    const card = this.store.task(taskId), specifiedWorker = str(args, 'worker');
    if (card?.observation || card?.work?.executions.some(e => e.kind === 'pi-observation')) throw new SafeError('capability_denied', '独立 Pi 首版只有观察能力，不能派工、停止、送话或续跑');
    if (card?.worker && specifiedWorker && specifiedWorker !== card.worker.kind) throw new SafeError('worker_mismatch', 'worker 身份与原任务卡冲突；不能通过改名切换执行者或确认规则。');
    const worker = card?.worker?.kind ?? (specifiedWorker || 'loop');
    let options: Record<string, unknown>;
    try { options = str(args, 'options') ? parseJson<Record<string, unknown>>(str(args, 'options')) : {}; }
    catch { throw new SafeError('invalid_arguments', 'worker options 不是有效 JSON。'); }
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new SafeError('invalid_arguments', 'worker options 必须是 JSON 对象');
    const request: WorkerRequest = { id: this.id(thread, name, args), taskId, worker, action,
      project: card?.worker?.project ?? str(args, 'project'), batchFile: card?.worker?.batchFile ?? '', stage: str(args, 'stage') || null,
      title: str(args, 'title'), goal: str(args, 'goal'), completion: str(args, 'completion'), boundary: str(args, 'boundary'), prompt: str(args, 'prompt'), text: str(args, 'text'),
      mode: str(args, 'mode') === 'send' ? 'send' : 'resume', redLine: args.redLine === true, options: worker === 'pi' && action === 'dispatch' ? { ...piOptions(options) } : options,
      ...(card?.worker?.loop ? { loopBinding: card.worker.loop } : {}),
      ...(card?.worker?.operation && this.operation(card.worker.operation)?.request.launch ? { launch: this.operation(card.worker.operation)!.request.launch } : {}), ...(str(args, 'sourceTaskId') ? { sourceTaskId: str(args, 'sourceTaskId') } : {}) };
    request.redLine = this.requiresExplicitApproval(request);
    return request;
  }
  async prepare(thread: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const request = this.request(thread, name, args), old = this.operation(request.id);
    if (old) return old;
    let card = this.store.task(request.taskId);
    if (card && terminal(card)) throw new SafeError('cancelled', '这件活已取消、关闭或人工核销，旧点头作废');
    await this.reconcileTaskDispatches(request.taskId, `before-new-operation:${thread}`, signal);
    if (this.journal.unresolved(request.taskId).length) throw new SafeError('uncertain', '原操作结果不确定、尚未按编号核销，不重发；请先在原卡核对派工');
    card = this.store.task(request.taskId);
    if (card && this.store.get<string | null>(`worker:pending:${card.id}`, null)) {
      const pending = this.operation(this.store.get<string>(`worker:pending:${card.id}`, ''));
      if (pending?.state === 'planned' && pending.thread !== thread) {
        if (!this.instruction(thread, request, args) || pending.request.redLine || requestHash(pending.request) !== requestHash(request)) throw new SafeError('awaiting_decision', '同一件活已有待点头操作，保留原卡，不重复提请');
        pending.state = 'stale'; pending.reason = '本人已用新的明确指令重新交代同一任务及范围，旧提请作废；不重复执行'; this.save(pending); this.resumeReadyGroup(pending.thread);
      }
    }
    if (card?.deferred) {
      const row = this.store.row(thread), pendingId = this.store.get<string | null>(`worker:pending:${card.id}`, null), pending = pendingId ? this.operation(pendingId) : null;
      if (!row || !(this.relevant(card, row.input) || this.instruction(thread, request, args) && [card.goal, card.completion, card.boundary].join('\0') === [request.goal, request.completion, request.boundary].join('\0')) || pending?.thread === thread) throw new SafeError('deferred', '本人已选回电脑再说，不催第二遍；等相关新指示');
      card.deferred = false; this.store.putTask(card);
    }
    if (request.action === 'dispatch') {
      if (card?.worker?.batchFile) throw new SafeError('already_dispatched', '这件活已经派过，不重复开工');
      if (card && [card.goal, card.completion, card.boundary].join('\0') !== [request.goal, request.completion, request.boundary].join('\0')) throw new SafeError('task_changed', '已有任务定义与新派单不同；先核对本人补充并更新任务定义，不能借旧任务增加动作。');
      if (![request.title, request.goal, request.completion, request.boundary, request.prompt].every(Boolean)) throw new SafeError('invalid_arguments', '派工缺少目标、完成标准或边界');
    } else if (!card?.worker?.batchFile) throw new SafeError('not_found', '没有可唯一核对的原派工');
    if (request.action === 'dispatch' && !request.project && ['loop', 'pi'].includes(request.worker)) {
      const source = this.instruction(thread, request, args);
      if (source) this.store.set(`worker:clarify:${request.taskId}`, { argsHash: this.draftHash(request), source });
      throw new SafeError('missing_project', '缺少任务所属项目；只需补充项目，目标与边界不变时沿用原本人指令，不重新确认整件事。');
    }
    const basis = await this.adapter(request.worker).status(request, signal);
    if (request.action === 'dispatch' && basis.state !== 'idle') throw new SafeError('resource_busy', '项目已有运行的批次，未并行开工');
    if (basis.executable === false) throw new SafeError('not_executable', basis.unavailableReason ?? 'worker 当前不能接受这项操作；授权或手工事项请回电脑处理');
    if (basis.loopBinding) {
      if (((basis.data as LoopBatch).kernel?.revision ?? -1) < (card?.sourceRevision ?? -1)) throw new SafeError('stale_source', '来源修订倒退，控制不可用；保留最后核实事实');
      request.loopBinding = basis.loopBinding;
      if (this.journal.unresolvedExecution(basis.loopBinding).length) throw new SafeError('uncertain', '同一原执行有未核实操作，不重复控制');
      if (card && !card.worker!.loop) { card.worker!.loop = basis.loopBinding; this.store.putTask(card); }
    }
    if (!card) {
      card = { id: request.taskId, title: request.title, goal: request.goal, completion: request.completion, boundary: request.boundary, status: 'waiting-approval', waiting: '', dispatches: [], conclusion: '', updated: new Date().toISOString(), subscriptions: [], worker: { kind: request.worker, project: request.project, batchFile: '' } };
      this.store.putTask(card);
    }
    const source = this.instruction(thread, request, args);
    const confirmation: InstructionConfirmation | undefined = source ? { kind: 'owner-instruction', ...source, taskId: request.taskId, requestHash: requestHash(request), scopeFingerprint: basis.fingerprint } : undefined;
    const op: WorkerOperation = { id: request.id, thread, tool: name, args, request, token: randomUUID(), state: 'planned', basis, definition: definition(card), needsApproval: this.approvalRequired(request, args, thread), reason: '',
      ...(confirmation ? { confirmation, by: confirmation.inputId } : {}) };
    this.save(op); this.store.set(`worker:token:${op.token}`, op.id);
    card.waiting = op.needsApproval ? '本次操作等你点头' : '';
    card.presentation = { cause: str(args, 'reason'), assessment: str(args, 'assessment') || '以已核实状态为准，未把模型判断当事实', suggestion: str(args, 'plan') };
    this.store.putTask(card);
    return op;
  }
  view(op: WorkerOperation): ApprovalView {
    const r = op.request;
    if (r.worker === 'pi') {
      const options = r.action === 'dispatch' ? r.options : this.pi.job(r.batchFile)?.plan.options;
      // SAFETY: this worker's basis data is produced by PiAdapter.status; missing
      // proposal on old approvals is conservative (the new fingerprint expires it).
      const proposal = (op.basis.data as { proposal?: { editVersions?: Record<string, string> } }).proposal;
      const versions = proposal?.editVersions ? `；待确认文件版本：${JSON.stringify(proposal.editVersions)}` : '';
      return { id: op.id, token: op.token, description: `${r.action === 'reply' ? '带本人答案新派一次 Pi（同一件活）' : r.action === 'stop' ? '按原身份停止 Pi' : `派给 Pi：${r.title}；${r.goal}；完成：${r.completion}；边界：${r.boundary}`}；权限：${JSON.stringify(options)}${versions}${r.redLine ? '；本次红线权限须明确点头；命令内部读写无法逐条保证，不携带宿主账号；改已有文件仅限所列文件及已核对版本' : ''}`,
        redLine: r.redLine, again: false };
    }
    const target = r.loopBinding?.taskId ? `任务 ${r.loopBinding.taskId}` : '整批';
    return { id: op.id, token: op.token, description: r.action === 'dispatch' ? `派给 ${r.worker === 'loop' ? 'Loop' : r.worker}：${r.title}；${r.goal}；完成：${r.completion}；边界：${r.boundary}` : r.action === 'stop' ? `停止原${target} ${r.batchFile}，保留成果` : `${r.mode === 'resume' ? '续跑' : `送话到原段 ${r.stage}`}：${r.text || '再给它一轮'}；原状态 ${op.basis.state}`,
      redLine: r.redLine, again: r.action === 'reply' && r.mode === 'resume' };
  }
  private currentApproval(taskId: string) {
    const id = this.store.get<string | null>(`worker:pending:${taskId}`, null), op = id ? this.operation(id) : null;
    return op && op.state === 'planned' ? this.view(op) : undefined;
  }
  async suspend(thread: string, requests: PendingAction[], signal?: AbortSignal) {
    const ids: string[] = [], tasks = requests.map(a => str(a.args, 'taskId'));
    if (new Set(tasks).size !== tasks.length) throw new SafeError('invalid_arguments', '同一轮不能对同一件活安排多个动作');
    try {
      for (const a of requests) {
        const op = await this.prepare(thread, a.name, a.args, signal);
        ids.push(op.id); this.store.set(`worker:pending:${op.request.taskId}`, op.id);
      }
    } catch (error) {
      for (const id of ids) {
        const op = this.operation(id)!;
        if (op.state !== 'planned') continue;
        op.state = 'blocked'; op.reason = '本组操作未全部核实，整组未执行'; this.save(op);
        const card = this.store.task(op.request.taskId)!; card.waiting = ''; card.notice = op.reason; this.store.putTask(card);
      }
      throw error;
    }
    this.store.set(groupKey(thread), { operations: ids } satisfies ApprovalGroup);
    this.store.wait(thread);
    for (const id of ids) {
      const op = this.operation(id)!;
      await this.messages.publish(op.request.taskId, thread, op.state === 'planned' ? this.view(op) : undefined, signal);
    }
  }
  decisions(thread: string) {
    const group = this.store.get<ApprovalGroup | null>(groupKey(thread), null);
    if (!group) return;
    const ops = group.operations.map(id => this.operation(id));
    if (ops.some(o => !o || o.state === 'planned')) return;
    return { decisions: ops.map(o => o!.state === 'rejected' || o!.state === 'cancelled' ? { type: 'reject' as const, message: o!.reason || '本人取消或暂缓；不要自动另提同一动作' } : { type: 'approve' as const }) };
  }
  private resumeReadyGroup(thread: string) {
    // Individual decisions never finish a graph. Queue its saved interrupt so
    // every approved peer still runs, and every rejected/stale peer is consumed.
    if (this.store.row(thread)?.state === 'waiting' && this.decisions(thread)) this.store.ready(thread);
  }
  private async dispatchReviewCallback(input: Input, value: Record<string, unknown>, signal?: AbortSignal) {
    const op = typeof value.operation === 'string' ? this.operation(value.operation) : null;
    if (!op || op.state !== 'uncertain' || op.request.action !== 'dispatch' || op.request.worker !== 'loop') return;
    const card = this.store.task(op.request.taskId);
    if (!card?.subscriptions.some(s => s.kind === 'message' && s.value === input.quoteId)) return;
    if (value.choice === 'prepare') {
      if (value.token !== op.token) return;
      const probe = await this.probeDispatch(op, signal);
      if (probe.snapshot && await this.reconcileDispatch(op, probe.snapshot, input.id, signal)) return;
      if (probe.active) { card.notice = `原调用或批次仍在活动，不能核销；${probe.description}`; this.store.putTask(card); await this.messages.publish(card.id, input.id, undefined, signal); return; }
      const review: DispatchReview = { operation: op.id, token: randomUUID(), identityHash: operationIdentity(op), basisHash: probe.basisHash, description: probe.description, by: input.who, at: new Date().toISOString(), state: 'pending' };
      if (!this.journal.beginReview(review)) return;
      card.waiting = '先在电脑核对原调用及相关进程均已结束，再明确确认人工核销；不会重发'; this.store.putTask(card);
      this.store.log('worker_manual_review', { operation: op.id, inputId: input.id, by: input.who, identityHash: review.identityHash, basisHash: review.basisHash, observation: review.description });
      await this.messages.publish(card.id, input.id, undefined, signal); return;
    }
    const review = this.journal.review(op.id);
    if (!review || review.state !== 'pending' || value.token !== review.token) return;
    if (value.choice === 'cancel') {
      this.journal.endReview(op.id, review.token, 'cancelled'); card.waiting = ''; card.notice = '未核销；原结果仍不确定，占用保留，不重发'; this.store.putTask(card);
      await this.messages.publish(card.id, input.id, undefined, signal); return;
    }
    if (value.choice !== 'confirm' || value.ack !== DISPATCH_MANUAL_ACK) return;
    const probe = await this.probeDispatch(op, signal);
    if (probe.snapshot && await this.reconcileDispatch(op, probe.snapshot, input.id, signal)) return;
    if (probe.active || probe.basisHash !== review.basisHash || operationIdentity(op) !== review.identityHash) {
      this.journal.endReview(op.id, review.token, 'stale'); card.waiting = ''; card.notice = '状态或核销依据已变化，旧确认作废；占用保留，请重新核对原派工'; this.store.putTask(card);
      await this.messages.publish(card.id, input.id, undefined, signal); return;
    }
    const reason = `原派工 ${op.id} 已由本人明确人工核销并释放其占用；不重发、不代表业务通过。${DISPATCH_MANUAL_ACK}`;
    const resolved = this.journal.resolveDispatch(op.id, review.identityHash, { event: input.id, reason, by: input.who, at: new Date().toISOString(), manual: true, basisHash: review.basisHash }, true, current => this.resolutionCard(current, undefined, true), review.token);
    if (!resolved) return;
    this.store.log('worker_resolution', { operation: resolved.id, resolution: resolved.resolution });
    await this.messages.publish(card.id, input.id, undefined, signal);
  }
  private async dispatchStopCallback(input: Input, value: Record<string, unknown>, signal?: AbortSignal) {
    if (typeof value.task !== 'string') return;
    const record = this.dispatchCards.valid(value.task, value.operation, value.token, input.quoteId);
    if (!record || !this.config.projects.some(p => p.id === record.target.project || p.root === record.target.project)) return;
    const original = this.operation(record.operation);
    if (!original || original.state !== 'sent') return;
    const { target } = record;
    const request: WorkerRequest = { id: hash(JSON.stringify(['dispatch-stop', record.token])).slice(0, 48), taskId: record.task,
      worker: target.worker, action: 'stop', project: target.project, batchFile: target.batchFile, stage: target.legacy?.stage ?? null,
      title: '', goal: '', completion: '', boundary: '', prompt: '', text: '', mode: 'resume', redLine: false, options: {},
      ...(target.loop ? { loopBinding: target.loop, sourceTaskId: target.loop.taskId! } : {}) };
    let basis: WorkerSnapshot;
    try { basis = await this.adapter(target.worker).status(request, signal); }
    catch (error) {
      signal?.throwIfAborted();
      this.store.log('worker_stop_unverified', { task: record.task, inputId: input.id, failure: failure(error), outcome: '无法核对原对象，未发停止' });
      const current = this.store.task(record.task);
      if (current && this.dispatchCards.valid(record.task, record.operation, record.token, input.quoteId)) {
        current.notice = '尚不能核对卡上原执行，未发送停止，不代表已停止；请稍后核对'; this.store.putTask(current);
        await this.messages.publish(current.id, input.id, undefined, signal);
      }
      return;
    }
    if (!this.dispatchCards.matches(record, basis) || basis.executable === false) return;
    const card = this.store.task(record.task)!;
    const op: WorkerOperation = { id: request.id, thread: input.id, tool: 'worker_stop', args: {}, request, token: randomUUID(),
      state: 'approved', basis, definition: definition(card), needsApproval: true, by: input.id, reason: '',
      cardStop: { dispatch: record.operation, token: record.token, messageId: input.quoteId!, targetHash: hash(JSON.stringify(target)), inputId: input.id } };
    if (!this.dispatchCards.consume(record, op, () => this.save(op))) return;
    this.store.log('worker_decision', { operation: op.id, task: record.task, by: input.who, inputId: input.id, decision: '原卡停止指令，保留成果' });
    // This approved operation is the click itself, not a global approval bypass.
    await this.executeGuarded(op, signal);
  }
  private async cardStopReceipt(op: WorkerOperation, receipt: WorkerReceipt, signal?: AbortSignal): Promise<WorkerReceipt> {
    if (!op.cardStop || receipt.status !== 'sent') return receipt;
    try {
      const record = this.dispatchCards.get(op.request.taskId)!;
      const snapshot = await this.adapter(op.request.worker).status(op.request, signal);
      const facts = (snapshot.data as LoopBatch | undefined)?.kernel;
      const pi = snapshot.data as { result?: { cleaned?: boolean } };
      const revisionOk = !facts || facts.revision >= ((op.basis.data as LoopBatch).kernel?.revision ?? -1);
      const stopped = this.dispatchCards.matches(record, snapshot, false) && revisionOk && (facts
        ? await selectedLoopStopped(this.config, this.files, record, snapshot)
        : op.request.worker === 'pi' ? snapshot.state === 'stopped' && pi.result?.cleaned === true : snapshot.state === 'stopped');
      if (stopped) return { ...receipt, snapshot, reason: '已按卡上原执行身份核实停止，保留成果；不代表业务验收通过' };
    } catch { /* The stop may already have taken effect. Never retry it. */ }
    return { status: 'uncertain', reason: '停止请求已送出，但停止结果不确定，不重复停止；保留成果，请核对原执行' };
  }
  async callback(input: Input, signal?: AbortSignal): Promise<{ handled: boolean; thread?: string }> {
    const button = input.button as { value?: Record<string, unknown> } | undefined, value = button?.value;
    if (!value || !['worker', 'task', 'unavailable', 'dispatch-reconcile', 'dispatch-stop'].includes(String(value.pa))) return { handled: false };
    if (input.source !== 'feishu' || input.who !== this.config.feishu.userId || input.chatType !== 'p2p') return { handled: true };
    if (value.pa === 'dispatch-stop') { await this.dispatchStopCallback(input, value, signal); return { handled: true }; }
    if (value.pa === 'dispatch-reconcile') { await this.dispatchReviewCallback(input, value, signal); return { handled: true }; }
    if (value.pa === 'unavailable') { this.store.log('worker_blocked', { inputId: input.id, reason: '合入、推送当前不可用，请回电脑操作' }); return { handled: true }; }
    if (value.pa === 'task') {
      const card = typeof value.task === 'string' ? this.store.task(value.task) : undefined;
      if (card && value.choice === 'hold' && card.subscriptions.some(s => s.kind === 'message' && s.value === input.quoteId)) {
        card.deferred = true; card.waiting = '回电脑再说，不催第二遍'; this.store.putTask(card);
        const pending = this.store.get<string | null>(`worker:pending:${card.id}`, null), op = pending ? this.operation(pending) : null;
        if (op?.state === 'planned') { op.state = 'rejected'; op.reason = '本人选择回电脑再说，不自动重提'; op.by = input.id; this.save(op); }
        await this.messages.publish(card.id, input.id, undefined, signal);
        if (op && this.decisions(op.thread)) { this.store.start(op.thread); return { handled: true, thread: op.thread }; }
      }
      return { handled: true };
    }
    const op = typeof value.operation === 'string' ? this.operation(value.operation) : null;
    if (!op || value.token !== op.token || !['approve', 'reject'].includes(String(value.choice))) return { handled: true };
    const card = this.store.task(op.request.taskId);
    if (!card?.subscriptions.some(s => s.kind === 'message' && s.value === input.quoteId)) return { handled: true };
    if (op.state !== 'planned') {
      // A consumed/replayed callback cannot resume a newer interrupt group.
      return { handled: true };
    }
    op.state = value.choice === 'approve' ? 'approved' : 'rejected'; op.by = input.id; op.reason = value.choice === 'reject' ? '本人选择不要，已取消本次操作' : '';
    this.save(op);
    this.store.log('worker_decision', { operation: op.id, task: card.id, by: input.who, inputId: input.id, decision: op.state });
    if (op.state === 'rejected') {
      card.waiting = ''; card.notice = op.reason;
      if (op.request.action === 'dispatch') card.status = 'cancelled';
      this.store.putTask(card); await this.messages.publish(card.id, input.id, undefined, signal);
    }
    if (!this.decisions(op.thread)) return { handled: true };
    this.store.start(op.thread); // Durable recovery even if killed before Command(resume).
    return { handled: true, thread: op.thread };
  }
  execute(thread: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = this.id(thread, name, args), active = this.inFlight.get(id);
    if (active) return active;
    const work = this.executeOnce(thread, name, args, signal).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, work); return work;
  }
  private async executeOnce(thread: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const op = await this.prepare(thread, name, args, signal), card = this.store.task(op.request.taskId)!;
    if (['sent', 'uncertain', 'blocked', 'stale', 'cancelled', 'rejected'].includes(op.state)) return { ok: op.state === 'sent', status: op.state, reason: op.reason, card };
    if (op.state === 'executing') return this.uncertain(op, '上次调用结果不确定，不重发', signal);
    if ((op.needsApproval || this.requiresExplicitApproval(op.request)) && op.state !== 'approved') return { ok: false, reason: '没有本次有效的本人点头' };
    if (terminal(card)) return this.stale(op, '这件活已取消，旧点头作废', signal);
    if (op.confirmation) {
      const source = this.store.row(op.confirmation.inputId)?.input;
      const verified = ownerInstruction(this.config, source, op.args);
      const clarification = op.confirmation.clarifiedBy;
      const current = clarification ? this.store.row(clarification.inputId)?.input : undefined;
      if (clarification && (!current || current.source !== 'feishu' || current.who !== this.config.feishu.userId || current.chatType !== 'p2p' || current.button || current.messageId !== clarification.messageId || hash(current.text.trim()) !== clarification.sourceHash)) return this.stale(op, '补充项目的本人来源已失效，未执行', signal);
      if (!verified || verified.sourceHash !== op.confirmation.sourceHash || op.confirmation.taskId !== op.request.taskId || op.confirmation.requestHash !== requestHash(op.request) || op.confirmation.scopeFingerprint !== op.basis.fingerprint) return this.stale(op, '本人指令、任务或范围绑定已失效，未执行', signal);
    }
    if (definition(card) !== op.definition) return this.stale(op, '任务定义或派工身份已变化，旧点头作废', signal);
    if (this.journal.unresolved(card.id).some(id => id !== op.id)) return this.stale(op, '原操作结果不确定、尚未按编号核销，不重发', signal);
    if (op.request.worker === 'loop' && op.request.action === 'dispatch') await this.compatibleLoopLeases();
    const resources = op.request.action === 'dispatch' ? op.basis.resources ?? (op.request.worker === 'loop' ? await loopResources(this.config, op.request) : []) : [];
    if (!resources.length) return this.executeGuarded(op, signal);
    // Hold ALL actual project/workspace resources across recheck AND dispatch.
    // A launch whose outcome is unknown keeps its durable lease across restart.
    await this.reconcileResources(resources, signal);
    if (!this.journal.reserve(op.id, resources, op.request.worker === 'loop' ? [LOOP_UNVERIFIED_RESOURCE] : [])) return this.stale(op, '项目或开发空间仍被原派工占用或启动未核销，未开工；请先核对原批次', signal);
    try { return await this.executeGuarded(this.operation(op.id)!, signal); }
    finally {
      const latest = this.operation(op.id)!;
      if (!['executing', 'sent', 'uncertain'].includes(latest.state)) this.journal.release(op.id);
    }
  }
  private async loopLeaseResources(op: WorkerOperation) {
    const saved = [...new Set([...(op.resources ?? []), ...(op.basis.resources ?? [])])];
    const origins = [...new Set([...saved.filter(key => key.startsWith('loop:project:')).map(key => key.slice('loop:project:'.length)),
      ...(op.request.launch?.project ? [op.request.launch.project] : []), ...(typeof op.request.project === 'string' && isAbsolute(op.request.project) ? [op.request.project] : [])])];
    const aliases: string[] = []; let unverified = !origins.length;
    for (const origin of origins) {
      try {
        if (await canonical(origin) !== origin) throw new Error('原项目路径变化');
        const identity = await repository(this.config, origin);
        if (identity.top !== origin) throw new Error('原仓库根身份不可核对');
        aliases.push(`loop:project:${origin}`, `loop:repository:${identity.common}`);
      } catch { unverified = true; }
    }
    // Never replace the old keys or guess from a current project display ID.
    // Unknown historical ownership blocks new Loop claims, not ordinary Pi work.
    return [...new Set([...saved, ...aliases, ...(unverified ? [LOOP_UNVERIFIED_RESOURCE] : [])])];
  }
  private async compatibleLoopLeases() {
    for (const row of this.store.db.prepare("SELECT value FROM kv WHERE key GLOB 'worker:op:*' AND json_extract(value,'$.request.worker')='loop' AND json_extract(value,'$.request.action')='dispatch' AND json_extract(value,'$.state') IN ('executing','uncertain','sent')").all()) {
      const op = parseJson<WorkerOperation>(String(row.value));
      if (op.resourceState !== 'released') this.journal.retain(op, await this.loopLeaseResources(op));
    }
  }
  private async reconcileResources(resources: string[], signal?: AbortSignal) {
    for (const id of this.journal.owners(resources)) {
      const owner = this.operation(id);
      if (!owner || !['sent', 'uncertain'].includes(owner.state) || owner.request.action !== 'dispatch' || !owner.request.batchFile) continue;
      const probe = await this.probeDispatch(owner, signal), snapshot = probe.snapshot;
      if (owner.state === 'uncertain') { if (snapshot) await this.reconcileDispatch(owner, snapshot, `resource-check:${id}`, signal); }
      else if (snapshot?.resourceReleased === true && (!owner.request.launch || snapshot.dispatchProof?.phase === 'exited' && snapshot.dispatchProof.terminal)) {
        const proof = snapshot.dispatchProof;
        const resolution: WorkerResolution | undefined = proof ? { event: `resource-release:${id}`, reason: snapshot.loopBinding ? '原启动调用已退出，原执行消费者结束已核实；释放 PA 执行占用，保留成果目录，不代表业务验收' : '原调用已退出且原批次为终态、无存活段，释放占用', by: 'program', at: new Date().toISOString(), dispatchPhase: 'exited', bindingHash: proof.bindingHash, evidence: proof.evidence } : undefined;
        if (this.journal.release(id, true, resolution)) this.store.log('worker_resource_release', { operation: id, resolution });
      }
      else if (owner.request.launch && !probe.active && !probe.observation?.ended) await this.uncertain(owner, '原批次已不活动，但原启动结束证据不足，占用保留；请在原卡核对后人工核销，不重发', signal);
    }
  }
  private async probeDispatch(op: WorkerOperation, signal?: AbortSignal) {
    let snapshot: WorkerSnapshot | undefined, lookupActive = false, lookupFingerprint = 'unavailable';
    try { snapshot = await this.adapter(op.request.worker).status({ ...op.request, action: 'reply' }, signal); }
    catch (error) { if (error instanceof LoopLookupError) { lookupActive = error.active; lookupFingerprint = error.fingerprint; } }
    const facts = (snapshot?.data as LoopBatch | undefined)?.kernel;
    if (facts && facts.revision < (this.store.task(op.request.taskId)?.sourceRevision ?? -1)) {
      lookupActive = snapshot?.active === true; lookupFingerprint = 'stale-source-revision'; snapshot = undefined;
    }
    const observation = snapshot?.launchObservation ?? (op.request.launch ? await observeLaunch(this.config, op.request.launch) : undefined);
    const active = lookupActive || snapshot?.active === true || ['running', 'started', 'resumed'].includes(snapshot?.state ?? '') || observation?.live === true;
    const description = `${snapshot ? `原批次查询状态：${snapshot.state}` : '原批次仍无法核实'}；${observation?.description ?? '旧派工没有完整启动结束回执'}`;
    return { snapshot, observation, active, description, basisHash: hash(JSON.stringify({ identity: operationIdentity(op), snapshot: snapshot?.fingerprint ?? lookupFingerprint, launch: observation?.fingerprint ?? null, active })) };
  }
  private resolutionCard(op: WorkerOperation, snapshot?: WorkerSnapshot, manual = false) {
    const card = this.store.task(op.request.taskId); if (!card) return;
    if (!terminal(card)) {
      if (manual) card.status = 'reconciled';
      else if (snapshot?.state === 'done') card.status = card.verified?.state === 'done' ? card.status : 'incomplete';
      else if (snapshot) card.status = snapshot.state;
      if (snapshot?.loopBinding) this.refreshKernelCard(card, snapshot, `dispatch:${op.id}`);
    }
    card.waiting = ''; card.notice = op.reason;
    card.dispatches.push({ id: op.id, action: op.request.action, outcome: manual ? 'manual-reconciliation' : 'dispatch-reconciliation', resolution: op.resolution });
    card.updated = new Date().toISOString(); this.store.putTask(card);
  }
  private async reconcileTaskDispatches(task: string, source: string, signal?: AbortSignal, publish = true) {
    for (const id of this.journal.unresolved(task)) {
      const op = this.operation(id);
      if (op?.state !== 'uncertain' || op.request.action !== 'dispatch' || !op.request.launch) continue;
      const probe = await this.probeDispatch(op, signal);
      if (probe.snapshot) await this.reconcileDispatch(op, probe.snapshot, source, signal, publish);
    }
  }
  private async reconcileDispatch(owner: WorkerOperation, snapshot: WorkerSnapshot, source: string, signal?: AbortSignal, publish = true) {
    const proof = snapshot.dispatchProof;
    if (owner.state !== 'uncertain' || owner.request.worker !== 'loop' || !owner.request.launch || !proof || proof.operation !== owner.id || proof.bindingHash !== hash(JSON.stringify(owner.request.launch))) return false;
    const reason = proof.phase === 'accepted'
      ? `原派工 ${owner.id} 已用原启动记录及当前存活会话核实已接收，不以原调用退出为前提；当前 ${proof.state}，不重发原开工/启动，继续保留 PA 执行占用；不代表工作区已清理或业务验收通过`
      : `原派工 ${owner.id} 已按原启动结束回执及原批次身份核销；当前 ${proof.state}，不重发原开工/启动${proof.terminal ? '，已释放占用' : '，仍保留运行中资源占用'}；不代表业务验收通过`;
    const resolved = this.journal.resolveDispatch(owner.id, operationIdentity(owner), { event: source, reason, by: 'program', at: new Date().toISOString(), dispatchPhase: proof.phase, acceptance: proof.acceptance, bindingHash: proof.bindingHash, evidence: proof.evidence }, proof.terminal, op => this.resolutionCard(op, snapshot));
    if (!resolved) return false;
    this.store.log('worker_resolution', { operation: resolved.id, resolution: resolved.resolution });
    const settled = this.operation(resolved.id)!; // release() may have advanced the durable resource state.
    settled.dispatchReceipt = { at: settled.resolution?.at ?? new Date().toISOString(), snapshot };
    if (snapshot.loopBinding) settled.request.loopBinding = snapshot.loopBinding;
    this.save(settled);
    this.dispatchCards.accept(settled, snapshot);
    // Receipt publication is program-owned and cannot wait for a later model turn.
    if (publish || this.dispatchCards.current(this.store.task(resolved.request.taskId))) await this.messages.publish(resolved.request.taskId, source, this.currentApproval(resolved.request.taskId), signal); return true;
  }
  private async executeGuarded(op: WorkerOperation, signal?: AbortSignal) {
    const card = this.store.task(op.request.taskId)!;
    let latest: WorkerSnapshot;
    try { latest = await this.adapter(op.request.worker).status(op.request, signal); }
    catch (error) {
      if (!op.cardStop) signal?.throwIfAborted(); op.failure = failure(error);
      this.store.log('worker_check_failed', { operation: op.id, failure: op.failure });
      return this.stale(op, `执行前核实失败（${op.failure.category}）：${op.failure.error} 未执行。`, op.cardStop && signal?.aborted ? undefined : signal);
    }
    if (op.cardStop && (!this.dispatchCards.ownsStop(op) || !this.dispatchCards.matches(this.dispatchCards.get(card.id)!, latest))) return this.stale(op, '卡上原执行身份已变化，旧停止令牌作废，未停止', signal);
    if (!op.cardStop && latest.fingerprint !== op.basis.fingerprint) return this.stale(op, activeStates.includes(latest.state) && !activeStates.includes(op.basis.state) ? '批次已自己恢复' : '状态或提交已变化，旧点头作废', signal, latest.state);
    if (latest.executable === false) return this.stale(op, 'worker 当前已不能接受该操作，未执行；请回电脑核对', signal);
    const currentCard = this.store.task(card.id)!;
    if (terminal(currentCard) || definition(currentCard) !== op.definition) return this.stale(op, '任务已取消或定义变化，旧点头作废', signal);
    // Re-derive mandatory consent after awaited checks, including for legacy
    // operations with an incorrect cached needsApproval/redLine flag.
    if ((op.needsApproval || this.requiresExplicitApproval(op.request)) && op.state !== 'approved') return this.stale(op, '执行前核对：缺少本次有效的本人独立点头，未执行', signal);
    // A fresh card click authorizes this original identity, not a frozen progress
    // revision of every sibling. Keep the adapter's final guard on the latest facts.
    if (op.cardStop) op.basis = latest;
    // The irreversible execution claim is before EVERY adapter effect. No retry path.
    const expected = op.state; op.state = 'executing';
    if (!this.journal.claim(op, expected)) return this.stale(op, '派工编号已被消费，或原操作结果未核销，不重复执行', signal);
    this.store.log('worker_intent', { id: op.id, task: card.id, action: op.request.action, by: op.by ?? '配置允许直接处理', basis: op.basis });
    let receipt: WorkerReceipt;
    try {
      const adapter = this.adapter(op.request.worker);
      const request = { ...op.request, expectedFingerprint: op.basis.fingerprint };
      if (op.request.action === 'dispatch') receipt = await adapter.dispatch(request, (file, launch) => {
        const current = this.store.task(card.id)!;
        current.worker = { kind: op.request.worker, project: op.request.project, batchFile: file, operation: op.id, origin: 'pa' };
        const subscription = op.request.worker === 'loop' ? { kind: 'loop' as const, value: file } : { kind: 'pi' as const, value: op.id };
        if (!current.subscriptions.some(s => s.kind === subscription.kind && s.value === subscription.value)) current.subscriptions.push(subscription);
        this.store.putTask(current); op.request.batchFile = file; if (launch) op.request.launch = launch; this.save(op);
      }, signal);
      else receipt = await adapter[op.request.action](request, signal);
    } catch { return this.uncertain(op, op.cardStop ? '停止调用结果不确定，不重复停止；保留成果，请核对卡上原执行' : '调用结果不确定，不重发；请回电脑核对原批次', signal); }
    receipt = await this.cardStopReceipt(op, receipt, signal);
    if (op.cardStop && receipt.status === 'blocked') {
      op.stopNotCalled = true;
      receipt = { ...receipt, reason: `${receipt.reason}；已核实未调用停止，可重新点击原卡停止按钮，届时重新核对原对象` };
    }
    if (op.request.worker === 'pi' && receipt.workerId) {
      const current = this.store.task(card.id)!;
      current.worker = { kind: 'pi', project: op.request.project, batchFile: receipt.workerId, operation: op.id, origin: 'pa' };
      if (!current.subscriptions.some(s => s.kind === 'pi' && s.value === receipt.workerId)) current.subscriptions.push({ kind: 'pi', value: receipt.workerId });
      this.store.putTask(current); op.request.batchFile = receipt.workerId;
    }
    if (receipt.snapshot?.loopBinding) op.request.loopBinding = receipt.snapshot.loopBinding;
    op.state = receipt.status; op.reason = receipt.reason;
    if (receipt.status === 'sent' && (op.request.action === 'dispatch' || op.request.worker === 'pi' && op.request.action === 'reply')) op.dispatchReceipt = { at: new Date().toISOString(), snapshot: receipt.snapshot };
    this.save(op);
    if (op.stopNotCalled) this.dispatchCards.rearm(op);
    this.receiptCard(op, receipt);
    this.dispatchCards.accept(op, receipt.snapshot);
    this.store.log('worker_result', { operation: op.id, task: card.id, receipt });
    const messageDigest = hash(JSON.stringify(this.messages.view(this.store.task(card.id)!)));
    await this.messages.publish(card.id, op.thread, undefined, op.stopNotCalled && signal?.aborted ? undefined : signal);
    const delivery = this.messages.delivery(card.id, messageDigest);
    return { ok: op.state === 'sent', status: op.state, reason: op.reason, card: this.store.task(card.id), delivery };
  }
  private receiptCard(op: WorkerOperation, receipt: WorkerReceipt) {
    const current = this.store.task(op.request.taskId);
    if (!current || current.worker?.batchFile !== op.request.batchFile || current.worker.kind !== op.request.worker) return;
    if (op.request.action === 'dispatch' && (current.worker.operation && current.worker.operation !== op.id
      || [current.goal, current.completion, current.boundary].join('\0') !== [op.request.goal, op.request.completion, op.request.boundary].join('\0'))) return;
    const binding = receipt.snapshot?.loopBinding;
    if (!op.cardStop && binding && current.worker.loop && !sameBinding(binding, current.worker.loop)) return;
    if (current.dispatches.some(d => d && typeof d === 'object' && 'id' in d && d.id === op.id && 'action' in d && d.action === op.request.action)) {
      if (binding && !op.cardStop) this.refreshKernelCard(current, receipt.snapshot!, `receipt:${op.id}`);
      return;
    }
    if (receipt.status === 'sent' && (op.request.action === 'dispatch' || op.request.worker === 'pi' && op.request.action === 'reply') && !current.work?.tracking) current.work = { ...workRecord(current), tracking: { endpoint: current.completion, state: 'active', inputId: op.confirmation?.inputId ?? op.thread } };
    current.dispatches.push({ id: op.id, action: op.request.action, outcome: op.state, by: op.by ?? 'config', at: new Date().toISOString() });
    if (!terminal(current)) {
      current.waiting = ''; current.notice = `${!op.needsApproval && receipt.status === 'sent' ? '已直接处理。' : ''}${receipt.reason}`;
      if (op.state === 'uncertain') current.status = 'uncertain';
      else if (op.state === 'sent') {
        if (op.cardStop) current.status = 'stopped';
        else if (op.request.loopBinding) current.status = op.request.action === 'stop' ? op.request.loopBinding.taskId ? current.status : 'stopped' : 'resume-requested';
        else current.status = op.request.worker === 'pi' ? op.request.action === 'stop' ? 'stopping' : this.pi.job(op.request.batchFile)?.state === 'queued' ? 'queued' : 'running' : op.request.action === 'stop' ? 'stopped' : 'running';
      }
    }
    current.updated = new Date().toISOString(); this.store.putTask(current);
    if (receipt.snapshot?.loopBinding && !op.cardStop) this.refreshKernelCard(current, receipt.snapshot, `receipt:${op.id}`);
    syncExecutionFacts(this.store, this.store.task(current.id)!);
  }
  private async stale(op: WorkerOperation, reason: string, signal?: AbortSignal, state?: string) {
    const current = this.operation(op.id);
    if (current && !['planned', 'approved'].includes(current.state)) return { ok: false, status: current.state, reason: current.reason, card: this.store.task(op.request.taskId) };
    op.state = 'stale';
    if (op.cardStop) { op.stopNotCalled = true; reason += ' 已核实未调用停止；可重新点击原卡停止按钮，届时重新核对原对象。'; }
    op.reason = reason; this.save(op);
    if (op.cardStop) this.dispatchCards.rearm(op);
    const card = this.store.task(op.request.taskId)!; card.notice = reason; card.waiting = '';
    if (state && !terminal(card)) card.status = state;
    card.dispatches.push({ id: op.id, outcome: 'stale', reason, at: new Date().toISOString() }); this.store.putTask(card);
    await this.messages.publish(card.id, op.thread, op.cardStop ? this.currentApproval(card.id) : undefined, signal);
    this.store.log('worker_stale', { id: op.id, reason });
    return { ok: false, status: 'stale', reason, ...(op.failure ? { category: op.failure.category, error: op.failure.error } : {}), card, next: '把当前整张卡和变化用于重新给建议，不执行旧方案' };
  }
  private async uncertain(op: WorkerOperation, reason: string, signal?: AbortSignal) {
    op.state = 'uncertain'; op.reason = reason; this.save(op);
    const card = this.store.task(op.request.taskId)!; card.status = terminal(card) ? card.status : 'uncertain'; card.waiting = ''; card.notice = reason;
    card.dispatches.push({ id: op.id, outcome: 'uncertain', at: new Date().toISOString() }); this.store.putTask(card);
    this.store.log('worker_result', { operation: op.id, outcome: '不确定，不重发' });
    await this.messages.publish(card.id, op.thread, undefined, signal);
    return { ok: false, status: 'uncertain', reason, card };
  }
  async recover() {
    for (const row of this.store.db.prepare("SELECT value FROM kv WHERE key GLOB 'worker:op:*'").all()) {
      const op = parseJson<WorkerOperation>(String(row.value));
      if (op.request.action === 'dispatch' && op.resourceState !== 'released' && ['executing', 'uncertain', 'sent'].includes(op.state)) {
        const resources = op.request.worker === 'loop' ? await this.loopLeaseResources(op) : op.resources ?? op.basis.resources ?? [];
        if (resources.length) this.journal.retain(op, resources);
      } else if (op.resourceState === 'held' && !['executing', 'uncertain', 'sent'].includes(op.state)) this.journal.release(op.id);
      if (op.state === 'executing' && op.request.worker === 'pi' && this.pi.job(op.id)) {
        const job = this.pi.job(op.id)!;
        op.state = 'sent'; op.reason = 'Pi 原派工已持久化，继续跟踪原编号，不重派'; op.resolution = { event: `recovery:${op.id}`, reason: op.reason };
        op.request.batchFile = job.id; op.dispatchReceipt = { at: new Date(job.created).toISOString() }; this.save(op);
        const card = this.store.task(op.request.taskId);
        if (card) { card.worker = { kind: 'pi', project: op.request.project, batchFile: job.id, operation: op.id, origin: 'pa' }; if (!card.subscriptions.some(s => s.kind === 'pi' && s.value === job.id)) card.subscriptions.push({ kind: 'pi', value: job.id }); this.store.putTask(card); }
      } else if (op.cardStop && op.state === 'approved') await this.stale(op, '上次停止点击在执行领取前中断，未调用停止');
      else if (op.state === 'executing') await this.uncertain(this.operation(op.id)!, op.cardStop ? '上次 PA 中断时停止未定案，停止结果不确定、不重复停止；保留成果，请核对原执行' : '上次 PA 中断时调用未定案，不确定、不重发；请回电脑核对');
      else if (op.state === 'uncertain') this.save(op); // Rebuild legacy per-task unresolved indexes, never from display status.
      const pending = this.operation(op.id)!;
      if (pending.stopNotCalled && this.dispatchCards.rearm(pending)) await this.messages.publish(pending.request.taskId, `recovery:${pending.id}`, this.currentApproval(pending.request.taskId));
      if (pending.state === 'uncertain' && pending.request.action === 'dispatch' && pending.request.launch) {
        const probe = await this.probeDispatch(pending);
        if (probe.snapshot) await this.reconcileDispatch(pending, probe.snapshot, `recovery:${pending.id}`);
      }
      const settled = this.operation(op.id)!;
      if (settled.state === 'sent' && (settled.request.action === 'dispatch' || settled.request.worker === 'pi' && settled.request.action === 'reply')) {
        if (settled.dispatchReceipt) this.receiptCard(settled, { status: 'sent', reason: settled.reason, snapshot: settled.dispatchReceipt.snapshot });
        this.dispatchCards.accept(settled, settled.dispatchReceipt?.snapshot);
        if (this.dispatchCards.current(this.store.task(settled.request.taskId))) await this.messages.publish(settled.request.taskId, `recovery:${settled.id}`, this.currentApproval(settled.request.taskId));
      }
    }
    // Crash may occur after the last decision is durable but before its queue
    // wake-up. Recover ready groups too, rather than relying on callback replay.
    for (const row of this.store.db.prepare("SELECT key FROM kv WHERE key GLOB 'worker:group:*'").all()) this.resumeReadyGroup(String(row.key).slice('worker:group:'.length));
  }
  async cancel(id: string, input: Input, signal?: AbortSignal) {
    if (input.source !== 'feishu' || input.who !== this.config.feishu.userId) return { ok: false, reason: '只有本人来话能取消任务，worker 材料不算指令' };
    const card = this.store.task(id);
    if (!card) {
      const draft = this.store.get<Record<string, unknown> | null>(`worker:clarify:${id}`, null);
      if (!draft) return { ok: false, reason: '未找到这件活' };
      this.store.set(`worker:clarify:${id}`, { ...draft, cancelled: true, cancelledBy: input.id });
      this.store.log('task_cancelled', { task: id, by: input.who, inputId: input.id, outcome: '未补齐项目的原指令作废，记录保留' });
      return { ok: true, reason: '原指令已取消，不能靠补项目继续派工' };
    }
    if (card.work?.tracking) card.work.tracking.state = 'cancelled';
    card.status = 'cancelled'; card.waiting = ''; card.notice = '已取消；尚未执行的点头全部作废。已在运行的 worker 不冒充已停止，请回电脑核对或另行停止。'; this.store.putTask(card);
    for (const row of this.store.db.prepare("SELECT value FROM kv WHERE key GLOB 'worker:op:*'").all()) {
      const op = parseJson<WorkerOperation>(String(row.value));
      if (op.request.taskId === id && ['planned', 'approved'].includes(op.state)) {
        op.state = 'cancelled'; op.reason = '本人取消这件活，点头作废'; op.by = input.id; this.save(op);
        this.resumeReadyGroup(op.thread);
      }
    }
    this.store.log('task_cancelled', { task: id, by: input.who, inputId: input.id });
    await this.messages.publish(id, input.id, undefined, signal);
    return { ok: true, card: this.store.task(id) };
  }
  relevant(card: TaskCard, input: Input) {
    return this.store.match(input).some(c => c.id === this.store.taskTarget(card.id))
      || input.source === 'feishu' && input.who === this.config.feishu.userId && !input.button
        && (card.title.length > 1 && input.text.includes(card.title) || input.text.split(/[\s，。；：,;:]+/).includes(card.id));
  }
  quietTask(card: TaskCard, input: Input) {
    const pending = this.currentApproval(card.id);
    return (card.deferred || !!pending || !!card.waiting) && !this.relevant(card, input);
  }
  async show(id: string, args: Record<string, unknown>, input: Input, signal?: AbortSignal) {
    const card = this.store.task(id); if (!card) return { ok: false, reason: '未找到任务' };
    if (this.quietTask(card, input)) return { ok: false, category: 'no_new_decision', reason: '旧事项没有相关新事实或本人重新问起，保留原待办，不重复发卡或催办' };
    card.presentation = { cause: str(args, 'cause'), assessment: str(args, 'assessment'), suggestion: str(args, 'suggestion') };
    if (!card.presentation.suggestion) return { ok: false, reason: '找用户必须带方案' };
    this.store.putTask(card); await this.messages.publish(id, input.id, this.currentApproval(id), signal);
    return { ok: true, card: this.store.task(id), note: '合入、推送始终不可用；要让用户点头续跑，请调用 worker_reply，暂停后原卡将带按钮' };
  }
  private async reconcileReply(card: TaskCard, event: WorkerEvent, input: Input, snapshot: WorkerSnapshot) {
    if (event.status !== 'resumed' || event.detail.via !== 'pa' || typeof event.detail.id !== 'string') return;
    const op = this.operation(event.detail.id);
    if (!op || op.state !== 'uncertain' || op.request.taskId !== card.id || op.request.action !== 'reply' || op.request.worker !== 'loop' || op.request.stage !== event.stage) return;
    const p = this.config.projects.find(p => p.id === op.request.project || p.root === op.request.project);
    if (!p || p.root !== event.project || await canonical(op.request.batchFile) !== await canonical(event.batchFile)) return;
    const batch = snapshot.data as LoopBatch;
    if (op.request.mode === 'send' && !batch.stages.find(s => s.stage === op.request.stage)?.paRelays?.some(r => r.id === op.id)) return;
    // Only the official PA relay/resume evidence naming THIS original operation
    // can reconcile an unknown receipt. Ordinary status/queue events cannot.
    op.state = 'sent'; op.reason = `原操作 ${op.id} 已按原编号核销，不重发`;
    op.resolution = { event: input.id, reason: '同项目、批次、原段的 PA resumed 编号与原操作一致' }; this.save(op);
    card.notice = op.reason; this.store.log('worker_resolution', { operation: op.id, resolution: op.resolution });
    return op.id;
  }
  private async ingestPi(input: Input, signal?: AbortSignal) {
    const job = input.workerId ? this.pi.job(input.workerId) : null;
    const raw = input.raw as { fingerprint?: string } | undefined;
    if (!job?.outcome || input.id !== `pi:${job.id}:result` || input.status !== job.state || raw?.fingerprint !== hash(JSON.stringify(job.outcome))) return false;
    let card = this.store.task(job.task);
    if (!card || card.worker?.batchFile !== job.id || terminal(card)) return false;
    const refs: Material[] = [];
    for (const path of Object.values(input.evidence ?? {})) {
      try { const { data } = await readBytes(path, () => this.files.check(path, true), this.config.intake.maxFileBytes); refs.push({ path, sha256: hash(data), bytes: data.length }); }
      catch { /* Unverified artifacts stay out of the archived result; no expanded grant. */ }
    }
    card = this.store.task(job.task);
    if (!card || card.worker?.batchFile !== job.id || terminal(card)) return false;
    const op = this.operation(job.id);
    card.waiting = job.state === 'needs-decision' ? job.outcome.answer.question ?? '需要你决定' : '';
    card.conclusion = job.outcome.answer.summary;
    card.lastVerifiedAt = new Date().toISOString();
    card.sourceCurrent = { worker: 'pi', state: job.state, checkedAt: card.lastVerifiedAt, active: false };
    card.sourceHealth = { ok: true, checkedAt: card.lastVerifiedAt };
    card.notice = `${op && !op.needsApproval ? '已直接处理。' : ''}${input.text}${!job.outcome.cleaned ? '（未确认无残留，保留并发占用，请回电脑核对）' : ''}`;
    card.presentation = job.state === 'needs-decision' ? { cause: input.text, assessment: 'Pi 已结束，不能原地等答复', suggestion: '请回答这项取舍；带本人答案在同一件活下新派一次，不自动重派' } : { cause: input.text, assessment: '按本次身份及结果文件核实，不代表业务验收通过', suggestion: job.state === 'done' ? '查看结果及证据；不合入、不推送' : '请核对本次派工日志；没有自动重派' };
    card.verified = { event: input.id, state: job.state, stage: null, layers: null, manual: [], evidence: input.evidence ?? {}, snapshot: { operation: job.id, cleaned: job.outcome.cleaned, fingerprint: raw.fingerprint } };
    const identity = { kind: 'pi' as const, sourceId: job.request.project, sessionId: card.id, instanceId: 'pa', executionId: job.id }, key = executionKey(identity);
    this.store.transaction(() => {
      this.store.recordTaskEvent(card!, input, job.state);
      recordExecution(this.store, card!.id, { ...identity, key, originTaskId: card!.id, revision: (this.store.task(card!.id)?.work?.executions.find(e => e.key === key)?.revision ?? 0) + 1, origin: 'pa', state: job.state, observedAt: input.at, receivedAt: new Date().toISOString(), verifiedAt: card!.lastVerifiedAt!, result: { summary: job.outcome!.answer.summary, refs, verified: job.outcome!.cleaned } });
      syncExecutionFacts(this.store, this.store.task(card!.id)!, key, input.id);
    });
    const owner = this.store.workTask(this.store.taskTarget(card.id))!;
    const notify = !terminal(owner) && new Attention(this.config, this.store).mayNotify({ ...owner, work: { ...workRecord(owner), tracking: card.work?.tracking ?? owner.work?.tracking } }, true);
    if (notify) await this.messages.publish(card.id, input.id, this.currentApproval(card.id), signal);
    if (notify && job.state === 'done' && this.messages.delivery(card.id).status === 'sent') {
      const delivered = this.store.task(card.id)!;
      if (delivered.work?.tracking?.state === 'active') {
        delivered.work.tracking.state = 'reported'; delivered.work.tracking.reportedBy = input.id; this.store.putTask(delivered);
        const owner = this.store.task(this.store.taskTarget(delivered.id))!;
        if (owner.id !== delivered.id && owner.work?.tracking?.inputId === delivered.work.tracking.inputId && owner.work.tracking.endpoint === delivered.work.tracking.endpoint) { owner.work.tracking = delivered.work.tracking; this.store.putTask(owner); }
      }
    }
    return notify;
  }
  async trackLoop(project: string, batchFile: string, sourceTaskId?: string, signal?: AbortSignal) {
    const request: WorkerRequest = { id: '', taskId: '', worker: 'loop', action: 'reply', lookupKernel: true, project, batchFile, sourceTaskId, stage: null, title: '', goal: '', completion: '', boundary: '', prompt: '', text: '', mode: 'resume', redLine: false, options: {} };
    const snapshot = await this.adapter('loop').status(request, signal), binding = snapshot.loopBinding;
    if (!binding) throw new SafeError('unverified', '旧记录没有新版执行身份；保留原记录，控制不可用');
    const facts = (snapshot.data as LoopBatch).kernel!;
    if (!sourceTaskId && facts.tasks.length > 1) throw new SafeError('ambiguous_target', '多任务须指定来源任务 ID，不将整批当一件任务');
    const actual = binding.taskId ?? facts.tasks[0]!.id, selected = { ...binding, taskId: actual };
    return this.adoptKernel(facts, actual, snapshot, true);
  }
  /** Discovery is read-only adoption, never dispatch. All identities in one run
   * are persisted together; a failed save leaves the discovery cursor untouched. */
  observeLoop(facts: KernelFacts) {
    const attention = new Attention(this.config, this.store), project = this.config.projects.find(p => [p.id, p.root].includes(facts.project));
    const admission = attention.admission('loop', project?.id ?? facts.project, facts.verifiedAt);
    return this.store.transaction(() => facts.tasks.flatMap(task => {
      const existing = this.sourceCards(facts.binding, facts.project).some(c => c.worker?.loop?.taskId === task.id);
      if (!existing && !admission.accept) return [];
      const card = this.adoptKernel(facts, task.id);
      if (admission.ids.length) attention.attach(card, admission.ids);
      return [this.store.task(card.id)!];
    }));
  }
  private adoptKernel(facts: KernelFacts, actual: string, snapshot?: WorkerSnapshot, refresh = false) {
    const binding = facts.binding, selected = { ...binding, taskId: actual };
    const id = `loop-${hash(JSON.stringify(selected)).slice(0, 24)}`;
    const candidates = this.store.db.prepare("SELECT body FROM tasks WHERE json_extract(body,'$.worker.kind')='loop' AND json_extract(body,'$.worker.batchFile')=?").all(binding.cardFile).map(r => parseJson<TaskCard>(String(r.body)));
    const old = this.store.task(id) ?? candidates.find(t => t.worker?.loop?.repository === binding.repository && t.worker.loop.runId === binding.runId
      && (t.worker.loop.taskId === actual || t.worker.loop.taskId === null && facts.tasks.length === 1)) ?? candidates.find(t => {
        const launch = t.worker?.operation ? this.operation(t.worker.operation)?.request.launch : undefined;
        return !t.worker?.loop && facts.tasks.length === 1 && launch?.protocol === 'kernel:1' && launch.batchFile === binding.cardFile && launch.repository === binding.repository;
      });
    const awakened = old && ['已合入', '已放弃', 'done'].includes(old.status) && !facts.executionEnded;
    if (old && (terminal(old) || !refresh && old.worker?.loop && !awakened)) return old;
    const task = facts.tasks.find(t => t.id === actual)!;
    const card: TaskCard = old ?? { id, title: task.name, goal: '', completion: '分别核对执行、技术检查、发布和业务验收；任务定义待读取', boundary: '原项目授权内；不合入、不推送、不部署', status: task.state, waiting: '', dispatches: [], conclusion: '', updated: facts.verifiedAt,
      sourceDefinition: { state: 'pending' }, subscriptions: [{ kind: 'loop', value: binding.cardFile }], worker: { kind: 'loop', project: facts.project, batchFile: binding.cardFile, loop: selected, origin: 'owner-loop' } };
    const data: LoopBatch = { project: facts.project, batch: { file: binding.cardFile, name: facts.name }, state: facts.state, stages: [], kernel: facts };
    return this.store.transaction(() => {
      if (!old) this.store.putTask(card);
      this.refreshKernelCard(card, { ...(snapshot ?? { state: task.state, fingerprint: kernelFingerprint(facts, actual), data }), loopBinding: selected }, `bind:${card.id}`);
      return this.store.task(card.id)!;
    });
  }
  private refreshKernelCard(card: TaskCard, snapshot: WorkerSnapshot, event: string) {
    const facts = (snapshot.data as LoopBatch).kernel, sourceBinding = snapshot.loopBinding, original = card.worker?.loop;
    // A whole-run dispatch receipt for a sole task must not erase a more precise
    // source task identity already established by discovery.
    const binding = sourceBinding?.taskId === null && original?.taskId && sameSourceBinding(original, { ...sourceBinding, taskId: original.taskId }) ? original : sourceBinding;
    if (!facts || !binding || terminal(card) || facts.revision < (this.store.task(card.id)?.sourceRevision ?? -1)) return false;
    const selected = selectKernel(facts, binding).task;
    card.worker!.loop = binding;
    const changed = this.store.applyLoopSnapshot(card, facts.revision, kernelFingerprint(facts, binding.taskId), () => {
      if (card.sourceDefinition) card.sourceDefinition.state = 'pending';
      card.status = facts.executionEnded && ['已合入', '已放弃'].includes(facts.state) ? facts.state : selected?.state ?? facts.state; card.lastVerifiedAt = facts.verifiedAt; card.sourceHealth = { ok: true, checkedAt: facts.verifiedAt }; card.control = `查询、按原对象停止；${facts.resumeBlocked ? `普通续跑不可用：${facts.resumeBlocked}` : '仅无新增要求且无发布后果的续跑'}；送话/合入/推送/部署不可用`;
      card.verified = { event, state: card.status, stage: null, layers: { execution: selected ?? facts.tasks, checks: facts.checks, results: facts.results, missing: facts.missing, publication: facts.publication, businessAcceptance: '未验证' }, manual: facts.acceptanceItems, evidence: facts.evidence, snapshot: { protocol: 'kernel:1', binding, revision: facts.revision, state: facts.state, executionEnded: facts.executionEnded, node: facts.node, verifiedAt: facts.verifiedAt, tasks: (selected ? [selected] : facts.tasks).map(t => ({ id: t.id, epoch: t.epoch })), note: '当前事实投影；原任务详情和证据按需读取，不保留完整来源快照' } };
      card.dispatches.push({ event, revision: facts.revision, runId: binding.runId, sourceTaskId: binding.taskId, at: facts.verifiedAt });
      card.updated = facts.verifiedAt;
    });
    const indexed = loopExecution(this.store, this.store.task(card.id)!, selected?.epoch ?? 0, selected?.state ?? facts.state, facts.verifiedAt);
    if (indexed) card.work = indexed.work;
    return changed;
  }
  private markSourceRemoved(card: TaskCard, facts: KernelFacts, event: string) {
    const binding = card.worker!.loop!;
    if (!binding.taskId || terminal(card) || card.verified?.state === 'source-removed') return false;
    const changed = this.store.applyLoopSnapshot(card, facts.revision, kernelFingerprint(facts, binding.taskId), () => {
      card.status = 'incomplete'; // Not business completion or stop/release proof.
      card.lastVerifiedAt = facts.verifiedAt; card.sourceHealth = { ok: true, checkedAt: facts.verifiedAt };
      card.control = '原来源任务已移出；保留原绑定与历史，不能转绑兄弟任务或扩大控制范围';
      card.verified = { event, state: 'source-removed', stage: null,
        layers: { execution: { id: binding.taskId, state: 'source-removed', stopped: '未核实', reason: '原任务已从正式记录移出；不代表执行清理或业务完成' }, checks: '历史检查保留，未重新核对', publication: '原事项未核实', businessAcceptance: '未验证' },
        manual: card.verified?.manual ?? [], evidence: card.verified?.evidence ?? {},
        snapshot: { protocol: 'kernel:1', binding, revision: facts.revision, state: 'source-removed', verifiedAt: facts.verifiedAt, tasks: [] } };
      card.dispatches.push({ event, revision: facts.revision, sourceTaskId: binding.taskId, state: 'source-removed', at: facts.verifiedAt }); card.updated = facts.verifiedAt;
    });
    if (changed) {
      const current = this.store.task(card.id)!;
      if (!current.waiting) current.waiting = '原来源任务已移出，请核对原事项的后续安排；没有自动重派';
      current.notice = `原来源任务 ${binding.taskId} 已移出；原绑定及历史保留，停止/清理和业务交付仍未核实。${current.notice ?? ''}`;
      this.store.putTask(current); syncExecutionFacts(this.store, current, ownExecution(current)?.key, event);
    }
    return changed;
  }
  private sourceCards(binding: LoopBinding, project: string) {
    const p = this.config.projects.find(p => p.id === project || p.root === project);
    if (!p) return [];
    return this.store.db.prepare("SELECT body FROM tasks WHERE json_extract(body,'$.worker.kind')='loop' AND json_extract(body,'$.worker.project') IN (?,?) AND json_extract(body,'$.worker.loop.protocol')='kernel:1' AND json_extract(body,'$.worker.loop.repository')=? AND json_extract(body,'$.worker.loop.runId')=? AND json_extract(body,'$.worker.loop.cardFile')=? AND json_extract(body,'$.worker.loop.ledger')=? ORDER BY rowid")
      .all(p.id, p.root, binding.repository, binding.runId, binding.cardFile, binding.ledger).map(row => parseJson<TaskCard>(String(row.body))).filter(card => !terminal(card) && card.verified?.state !== 'source-removed');
  }
  private async ingestKernel(input: Input, signal?: AbortSignal) {
    const raw = input.raw as { runId?: string; revision?: number; ledger?: string };
    const card = input.workerId ? this.store.task(input.workerId) : undefined, binding = card?.worker?.loop;
    if (!card || !binding || raw.runId !== binding.runId || raw.ledger !== binding.ledger || !Number.isSafeInteger(raw.revision)) return false;
    const existing = this.sourceCards(binding, card.worker!.project);
    if (!existing.length || existing.every(c => raw.revision! <= (c.sourceRevision ?? -1))) { this.store.loopVerification(input, false); return false; }
    this.store.loopVerification(input, true); // Durable observation is not yet successful verification.
    const request = this.request(`kernel:${input.id}`, 'worker_reply', { taskId: card.id, mode: 'resume' });
    // This is verification of the original RUN, not a control operation on the
    // wake-up card. Its former task may have been removed from that run.
    const snapshot = await this.adapter('loop').status({ ...request, loopBinding: { ...binding, taskId: null } }, signal), facts = (snapshot.data as LoopBatch).kernel;
    if (!facts || !sameSourceBinding(binding, { ...facts.binding, taskId: binding.taskId })) throw new SafeError('identity_mismatch', '运行级核实没有返回原仓库/运行/原卡/ledger 身份');
    if (facts.revision < raw.revision!) throw new SafeError('unverified', '原修订尚不能核实，保留只读重核');
    const changed = this.store.transaction(() => {
      const current = this.sourceCards(binding, card.worker!.project);
      if (current.some(c => (c.sourceRevision ?? -1) > facts.revision)) throw new SafeError('unverified', '原来源返回旧修订，保留最新可靠事实');
      this.observeLoop(facts);
      const updated: TaskCard[] = [];
      // A run revision wakes Router once, while every original task keeps its
      // own binding, facts, approval, output references and message identity.
      for (const selected of this.sourceCards(binding, card.worker!.project)) {
        const target = selected.worker!.loop!;
        const taskId = target.taskId ?? (facts.tasks.length === 1 ? facts.tasks[0]!.id : null);
        if (!taskId) continue;
        const present = facts.tasks.some(t => t.id === taskId);
        const saved = present ? this.refreshKernelCard(selected, { ...snapshot, loopBinding: { ...target, taskId }, fingerprint: kernelFingerprint(facts, taskId) }, input.id) : this.markSourceRemoved(selected, facts, input.id);
        if (saved) {
          this.store.db.prepare('INSERT OR IGNORE INTO task_events(task,event) VALUES(?,?)').run(selected.id, input.id);
          syncExecutionFacts(this.store, this.store.task(selected.id)!, ownExecution(this.store.task(selected.id)!)?.key, input.id);
          updated.push(this.store.task(selected.id)!);
        }
      }
      this.store.loopVerification(input, false); // Facts + event association are durable before Router.
      return updated;
    });
    if (!changed.length) return false;
    for (const selected of changed) {
      const pendingId = this.store.get<string | null>(`worker:pending:${selected.id}`, null), pending = pendingId ? this.operation(pendingId) : null;
      if (pending?.state === 'planned' && pending.basis.fingerprint !== kernelFingerprint(facts, selected.worker!.loop!.taskId)) {
        pending.state = 'stale'; pending.reason = selected.verified?.state === 'source-removed' ? '原来源任务已移出，旧操作不能执行' : '原执行版本变化，旧点头作废'; this.save(pending); this.resumeReadyGroup(pending.thread);
      }
      // Removal is absence from the formal task set, never release/stop proof.
      if (selected.verified?.state !== 'source-removed') await this.reconcileTaskDispatches(selected.id, input.id, signal, false);
    }
    const quietRecovery = this.store.get<boolean>(`kernel:quiet-recovery:${input.id}`, false);
    if (quietRecovery) this.store.set(`kernel:quiet-recovery:${input.id}`, false);
    return changed.some(c => new Attention(this.config, this.store).mayNotify(c, ['已合入', '已放弃', '可合入', '等你决定', 'done', 'needs-decision', 'paused', 'failed', 'incomplete'].includes(c.status))) && !quietRecovery;
  }
  async ingest(input: Input, signal?: AbortSignal) {
    if (input.source === 'loop' && (input.raw as { kernel?: number } | undefined)?.kernel === 1) {
      try { return await this.ingestKernel(input, signal); } catch (error) {
        signal?.throwIfAborted();
        const card = input.workerId ? this.store.task(input.workerId) : undefined;
        if (card?.worker?.loop) { card.sourceHealth = { ok: false, checkedAt: new Date().toISOString(), reason: failure(error).error }; this.store.putTask(card); }
        this.store.log('worker_unverified', { inputId: input.id, failure: failure(error) }); return false;
      }
    }
    if (input.source === 'pi') return this.ingestPi(input, signal);
    if (input.source !== 'loop' || !input.project || !input.batchFile || !input.status) return true;
    const raw = input.raw as { stage?: unknown; seq?: unknown; detail?: Record<string, unknown> } | undefined;
    const event: WorkerEvent = { project: await canonical(input.project), batchFile: input.batchFile, stage: typeof raw?.stage === 'string' ? raw.stage : null, status: input.status, detail: raw?.detail ?? {} };
    const request: WorkerRequest = { id: input.id, taskId: '', worker: 'loop', action: 'reply', project: event.project, batchFile: input.batchFile, stage: event.stage, title: '', goal: '', completion: '', boundary: '', prompt: '', text: '', mode: 'resume', redLine: false, options: {} };
    const adapter = this.adapter('loop');
    let snapshot: WorkerSnapshot, phaseKey = '';
    const report = ['paused', 'needs-decision', 'repair-limit', 'done', 'failed'].includes(event.status);
    try {
      snapshot = await adapter.status(request, signal);
      if ((snapshot.data as LoopBatch).kernel) throw new SafeError('invalid_event', '旧事件不控制新版卡；只接已绑定 ledger 修订');
      const expected = event.status === 'queue' || (activeStates.includes(event.status) ? activeStates.includes(snapshot.state) : snapshot.state === event.status);
      const lastSeq = (snapshot.data as LoopBatch).events?.lastSeq;
      if (raw?.stage !== undefined && raw.stage !== null && (typeof raw.stage !== 'string' || !raw.stage.trim())) throw new SafeError('invalid_event', '事件中的段标识无效');
      if (!expected || !currentLoopEvent(event, input, snapshot) || event.status === 'done' && !await adapter.result(event, snapshot, signal)) throw new SafeError('state_mismatch', '事件与当前查询或结果证据不一致');
      if (event.status !== 'queue' && Number.isSafeInteger(raw?.seq)) {
        const file = await canonical(event.batchFile), key = (stage: string | null) => `worker:phase:${hash(JSON.stringify([event.project, file, stage]))}`;
        phaseKey = key(event.stage);
        const seen = Math.max(this.store.get<number>(phaseKey, 0), event.stage ? this.store.get<number>(key(null), 0) : 0);
        // Batch lastSeq includes queue-only changes. It is an upper bound, NOT
        // the identity of a stage/lifecycle or its committed completion.
        if (Number(raw!.seq) <= 0 || Number(raw!.seq) < seen || Number.isSafeInteger(lastSeq) && Number(raw!.seq) > lastSeq!) throw new SafeError('stale_event', '事件代次或顺序已过期');
      }
    } catch (error) {
      signal?.throwIfAborted();
      this.store.log('worker_unverified', { inputId: input.id, batchFile: input.batchFile, outcome: '核实不了，没叫你', failure: failure(error) });
      return false;
    }
    if (report) await adapter.ask(event); else await adapter.progress(event);
    if (phaseKey) this.store.set(phaseKey, Number(raw!.seq));
    let cards = this.store.match(input, true);
    const canonicalFile = await canonical(input.batchFile);
    if (!cards.length && canonicalFile !== input.batchFile) cards = this.store.match({ ...input, batchFile: canonicalFile }, true);
    for (const card of cards) if (!card.subscriptions.some(s => s.kind === 'loop' && s.value === input.batchFile)) { card.subscriptions.push({ kind: 'loop', value: input.batchFile }); this.store.putTask(card); }
    const attention = new Attention(this.config, this.store), ownerProject = this.config.projects.find(p => p.root === event.project);
    const admission = attention.admission('loop', ownerProject?.id ?? event.project, input.at);
    if (!cards.length && !admission.accept) return false;
    if (!cards.length) {
      const b = snapshot.data as LoopBatch;
      const card: TaskCard = { id: `loop-${hash(await canonical(input.batchFile)).slice(0, 24)}`, title: b.batch.name, goal: '托管本人在授权项目开的 Loop 批次', completion: '门禁通过、评审无必修、提交到批次分支；验收欠项逐项说明', boundary: '不合入、不推送、不碰真实账号', status: snapshot.state, waiting: '', dispatches: [], conclusion: '', updated: input.at, subscriptions: [{ kind: 'loop', value: input.batchFile }], worker: { kind: 'loop', project: event.project, batchFile: input.batchFile } };
      this.store.putTask(card); if (admission.ids.length) attention.attach(card, admission.ids); cards = [this.store.task(card.id)!];
    }
    const checked = layers(event.detail);
    for (let card of cards) {
      await this.reconcileTaskDispatches(card.id, input.id, signal, false);
      card = this.store.task(card.id)!;
      if (terminal(card)) { this.store.log('worker_after_cancel', { task: card.id, event: input.id, outcome: '已取消，不恢复旧任务或点头' }); continue; }
      card.worker ??= { kind: 'loop', project: event.project, batchFile: input.batchFile };
      const resolved = await this.reconcileReply(card, event, input, snapshot);
      const status = event.status === 'done' && !checked.complete ? 'incomplete' : event.status === 'queue' && snapshot.state === 'done' ? card.status : snapshot.state;
      if (report && card.verified?.event !== input.id) { card.presentation = undefined; card.notice = ''; card.waiting = ''; }
      const pendingId = this.store.get<string | null>(`worker:pending:${card.id}`, null), pending = pendingId ? this.operation(pendingId) : null;
      if (pending?.state === 'planned' && pending.basis.fingerprint !== snapshot.fingerprint) {
        pending.state = 'stale'; pending.reason = activeStates.includes(snapshot.state) ? '批次已自己恢复' : '状态或提交已变化，旧点头作废'; this.save(pending);
        card.notice = pending.reason; card.waiting = '';
        card.dispatches.push({ id: pending.id, outcome: 'stale', reason: pending.reason, event: input.id });
        this.store.log('worker_stale', { operation: pending.id, event: input.id, reason: pending.reason });
        this.resumeReadyGroup(pending.thread);
      }
      if (report) card.verified = { event: input.id, state: snapshot.state, stage: event.stage, branch: typeof event.detail.branch === 'string' ? event.detail.branch : undefined, commit: typeof event.detail.commit === 'string' ? event.detail.commit : undefined, layers: checked.value, manual: checked.manual, evidence: input.evidence ?? {}, snapshot };
      if (event.status === 'done' && !checked.complete && !card.presentation) card.presentation = { cause: `各层尚未全过：${JSON.stringify(checked.value)}`, assessment: '还需 Router 根据证据区分真问题或误判，未知不冒充通过', suggestion: '建议核对未过层的证据，再决定是否再给一轮；合入当前不可用，请回电脑' };
      if (event.status === 'resumed' || activeStates.includes(snapshot.state)) {
        // First resumed publish must already represent recovery, before any model turn.
        card.presentation = undefined; card.conclusion = '';
        card.verified = { event: input.id, state: snapshot.state, stage: event.stage, branch: (snapshot.data as LoopBatch).branch, commit: undefined, layers: { gate: '未重新核实', review: '未重新核实', acceptance: '未重新核实' }, manual: [], evidence: input.evidence ?? {}, snapshot };
        card.notice = resolved ? `批次已恢复；原操作 ${resolved} 已按原编号核销，本次不重发` : '批次已自己恢复'; card.waiting = '';
      }
      const unresolved = this.journal.unresolved(card.id);
      if (unresolved.length) card.notice = `原操作 ${unresolved.join('、')} 结果仍不确定、尚未按原编号核销，不重发；请回电脑核对`;
      card.lastVerifiedAt = new Date().toISOString();
      card.sourceCurrent = { worker: 'loop', state: snapshot.state, checkedAt: card.lastVerifiedAt, active: snapshot.active === true, next: snapshot.next };
      card.sourceHealth = { ok: true, checkedAt: card.lastVerifiedAt };
      this.store.transaction(() => {
        this.store.recordTaskEvent(card, input, status);
        const ref = ownExecution(card);
        if (ref) recordExecution(this.store, card.id, { ...ref, state: status, revision: ref.revision + 1, verifiedAt: card.lastVerifiedAt! });
        syncExecutionFacts(this.store, this.store.task(card.id)!, ref?.key, input.id);
      });
      if ((event.status === 'done' || event.status === 'resumed') && attention.mayNotify(card, report)) await this.messages.publish(card.id, input.id, this.currentApproval(card.id), signal);
    }
    return cards.some(c => !terminal(c) && attention.mayNotify(c, report));
  }
}
