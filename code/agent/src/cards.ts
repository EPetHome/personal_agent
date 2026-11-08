import type { Channel, MessageCard } from './channel.js';
import { withDeadline } from './channel-http.js';
import type { Store } from './store.js';
import type { TaskCard } from './types.js';
import { hash } from './util.js';
import { WorkerJournal, operationIdentity, DISPATCH_MANUAL_ACK } from './worker-journal.js';
import { DispatchCards } from './dispatch-card.js';

export interface ApprovalView { id: string; token: string; description: string; redLine: boolean; again: boolean }
export interface TaskDelivery { status: 'sent' | 'pending' | 'uncertain'; id?: string; reason?: string }
const labels: Record<string, string> = { 'waiting-approval': '等你点头', running: '进行中', queued: '排队中', stopping: '正在停止', 'timed-out': '已超时', interrupted: '已中断', paused: '卡住', 'needs-decision': '需要你决定', 'repair-limit': '没全过', done: '做完', incomplete: '没全过', cancelled: '已取消', closed: '已关闭', uncertain: '不确定', failed: '卡住', stopped: '已停止', reconciled: '已人工核销（非业务通过）' };
export class TaskMessages {
  private readonly publishing = new Map<string, Promise<unknown>>();
  constructor(readonly store: Store, readonly channel: Channel) {}
  view(card: TaskCard, approval?: ApprovalView): MessageCard {
    const state = labels[card.status] ?? card.status, closed = ['cancelled', 'closed', 'reconciled'].includes(card.status);
    const dispatches = new DispatchCards(this.store), dispatched = dispatches.current(card), stop = dispatches.stoppable(card, dispatched);
    const title = `${card.title} · ${dispatched ? '已派出 · ' : ''}${state}`;
    const journal = new WorkerJournal(this.store);
    const stopResult = dispatched?.stopOperation ? journal.operation(dispatched.stopOperation) : null;
    const verified = stopResult?.state === 'sent' && card.status === 'stopped' ? undefined : card.verified;
    const unknown = journal.unresolved(card.id).map(id => journal.operation(id)).find(op => op?.state === 'uncertain' && op.request.action === 'dispatch' && op.request.worker === 'loop');
    const storedReview = unknown ? journal.review(unknown.id) : null;
    const review = unknown && storedReview?.state === 'pending' && storedReview.identityHash === operationIdentity(unknown) ? storedReview : undefined;
    const identity = unknown ? `原派工编号：${unknown.id}\n原批次：${unknown.request.batchFile || '尚未取得'}\n原分支：${unknown.request.launch?.branch ?? `feat/pa-${unknown.id}`}\n原资源：${JSON.stringify(unknown.resources ?? [])}\n原启动器：${unknown.request.launch?.launcher ? `PID ${unknown.request.launch.launcher.pid}，启动时间 ${unknown.request.launch.launcher.started ?? '未能确认'}` : '未记录，须按原批次和运行记录在电脑核对'}\n原结束回执：${unknown.request.launch?.receiptFile ?? '未取得'}\n请同时核对批次、PID 与启动时间，不按进程名或仅凭 PID 猜测结束。` : '';
    const text = [title, `目标：${card.goal}`, `完成标准：${card.completion}`, `边界：${card.boundary}`,
      dispatched ? `${dispatches.describe(dispatched)}\n已派出只是接收事实，不代表工作完成或业务验收通过。${stop ? '理解有误可直接点停止，按卡上原对象停止并保留成果，无需再点好。' : ''}` : '',
      stopResult ? `本次卡内停止回执：${stopResult.reason || '停止正在核对，尚未确认完成；不会重复停止'}\n停止操作编号：${stopResult.id}` : '',
      card.worker ? `派给 ${card.worker.kind === 'loop' ? 'Loop' : card.worker.kind}：${card.worker.batchFile || '确认后开工'}` : '',
      verified && card.worker?.kind === 'pi' ? `Pi 原派工：${card.worker.batchFile}\n核实结果：${state}，已核对原身份与结果文件；不代表业务验收通过\n证据路径：${JSON.stringify(verified.evidence)}` : verified ? `分支：${verified.branch ?? '未知'}\n提交：${verified.commit ?? '未知'}\n核实结果（${verified.event}）：状态 ${verified.state} 已核对${verified.commit ? '、分支含此提交' : ''}\n各层：${JSON.stringify(verified.layers)}\n要人工验收的项：${JSON.stringify(verified.manual ?? [])}\n证据路径：${JSON.stringify(verified.evidence)}` : '',
      card.presentation ? `原因：${card.presentation.cause}\n真问题还是误判：${card.presentation.assessment}\n建议：${card.presentation.suggestion}` : '',
      approval ? `打算怎么做：${approval.description}\n你确认的是：本次这项操作及卡上所列状态/分支/提交；变化后不再照旧执行。` : '',
      card.waiting ? `在等：${card.waiting}` : '', card.notice ?? '', card.conclusion,
      card.status === 'done' && !card.presentation ? '建议：回电脑完成所列人工验收，再决定是否合入或推送。' : '',
      unknown ? `${identity}\n${review ? `核销前观察：${review.description}\n你确认的不是再开工，而是：${DISPATCH_MANUAL_ACK}\n若尚未亲自在电脑核对，请选先不核销。` : '建议：先等待程序按原调用结束回执核实；证据不足时，在电脑结束原调用及其相关进程后，再用专用入口核销。普通消息或状态变化不会解除占用。'}` : '',
      '合入、推送（包括仍要合入）：当前不可用，请回电脑操作。',
    ].filter(Boolean).join('\n\n');
    const buttons: MessageCard['buttons'] = [];
    if (approval && !closed) {
      const value = (choice: string) => ({ pa: 'worker', operation: approval.id, token: approval.token, choice });
      buttons.push({ label: '好', value: value('approve') }, { label: '不要', value: value('reject') });
      if (!approval.redLine && card.status === 'incomplete') buttons.push({ label: '按建议', value: value('approve') });
      if (!approval.redLine && approval.again) buttons.push({ label: '再给它一轮', value: value('approve') });
    }
    if (stop) buttons.push({ label: '停止', value: { pa: 'dispatch-stop', task: card.id, operation: stop.operation, token: stop.token } });
    if (unknown) {
      const value = (choice: string) => ({ pa: 'dispatch-reconcile', operation: unknown.id, token: review?.token ?? unknown.token, choice });
      if (review) buttons.push({ label: '已在电脑核对，核销且不重发', value: { ...value('confirm'), ack: DISPATCH_MANUAL_ACK } }, { label: '先不核销', value: value('cancel') });
      else buttons.push({ label: '核对原派工（不重发）', value: value('prepare') });
    }
    if (!closed) buttons.push({ label: '回电脑再说', value: { pa: 'task', task: card.id, choice: 'hold' } });
    // These are program-owned, never a model-controlled label/disabled flag.
    buttons.push({ label: card.status === 'incomplete' ? '仍要合入' : '合入', value: { pa: 'unavailable' }, disabled: true }, { label: '推送', value: { pa: 'unavailable' }, disabled: true });
    return { title, text, buttons };
  }
  /** Publication may be decorated by a non-blocking coordinator. Its return is
   * not an acknowledgement; only the exact persisted view/outbox can prove it. */
  delivery(taskId: string, expectedDigest?: string): TaskDelivery {
    const card = this.store.task(taskId), digest = expectedDigest ?? (card ? hash(JSON.stringify(this.view(card))) : undefined);
    const message = this.store.get<{ state: string; id?: string; digest: string } | null>(`task-message:${taskId}`, null);
    if (!message) return { status: 'pending', reason: '本次卡片尚未核实发送或更新' };
    if (message.state !== 'sent') {
      if (message.state === 'sending' && this.publishing.has(taskId)) return { status: 'pending', id: message.id, reason: '卡片正在发送或更新，尚未核实送达' };
      return { status: 'uncertain', id: message.id, reason: '原卡送达或更新不确定，不重发' };
    }
    if (message.digest !== digest) return { status: 'pending', id: message.id, reason: '已知原消息不等于本次卡片已更新，等待原发布路径核实' };
    const outbox = this.store.db.prepare('SELECT state,message_id FROM outbox WHERE id=?').get(`task:${taskId}:${digest}`);
    if (!message.id || outbox?.state !== 'sent' || outbox.message_id !== message.id) return { status: 'uncertain', id: message.id, reason: '本次卡片缺少一致的送达账，不重发' };
    return { status: 'sent', id: message.id };
  }
  publish(taskId: string, inputId: string, approval?: ApprovalView, signal?: AbortSignal): Promise<void> {
    const previous = this.publishing.get(taskId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.publishOnce(taskId, inputId, approval, signal)).then(() => {});
    this.publishing.set(taskId, work);
    void work.finally(() => { if (this.publishing.get(taskId) === work) this.publishing.delete(taskId); }).catch(() => {});
    return work;
  }
  private async publishOnce(taskId: string, inputId: string, approval?: ApprovalView, signal?: AbortSignal) {
    const card = this.store.task(taskId); if (!card) return;
    const dispatches = new DispatchCards(this.store), dispatch = dispatches.current(card);
    const view = this.view(card, approval), digest = hash(JSON.stringify(view));
    const key = `task-message:${taskId}`;
    const old = this.store.get<{ state: string; id?: string; digest: string } | null>(key, null);
    if (old && old.state !== 'sent') return { status: 'uncertain', reason: '原卡送达或更新不确定，不重发' };
    if (old?.digest === digest) return { status: 'sent', id: old.id };
    if (!old && card.deferred) return;
    // Persist before sending/updating; an interrupted request is never resent.
    this.store.set(key, { state: 'sending', id: old?.id, digest });
    const outboxKey = `task:${taskId}:${digest}`;
    this.store.db.prepare('INSERT OR IGNORE INTO outbox(id,input_id,text,state) VALUES(?,?,?,?)').run(outboxKey, inputId, view.text, 'sending');
    try {
      let id = old?.id;
      if (old && !id) throw new Error('旧卡发送结果未定');
      if (id) await withDeadline(this.store.config.feishu.timeoutMs, signal, active => this.channel.updateCard ? this.channel.updateCard(id!, view, active) : this.channel.update(id!, view.text, active));
      else id = await withDeadline(this.store.config.feishu.timeoutMs, signal, active => this.channel.sendCard ? this.channel.sendCard(view, key, active) : this.channel.send(view.text, key, active));
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.set(key, { state: 'sent', id, digest });
        this.store.db.prepare("UPDATE outbox SET state='sent',message_id=? WHERE id=?").run(id, outboxKey);
        const current = this.store.task(taskId)!;
        if (!current.subscriptions.some(s => s.kind === 'message' && s.value === id)) { current.subscriptions.push({ kind: 'message', value: id }); this.store.putTask(current); }
        if (dispatch) dispatches.published(taskId, dispatch.token, id);
        this.store.db.exec('COMMIT');
      } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
      this.store.log('task_message', { task: taskId, id, inputId, outcome: old ? '已更新原卡' : '已发卡', card: view });
      return { status: 'sent', id };
    } catch {
      this.store.set(key, { state: 'uncertain', id: old?.id, digest });
      this.store.db.prepare("UPDATE outbox SET state='uncertain' WHERE id=? AND state='sending'").run(outboxKey);
      this.store.log('delivery_uncertain', { task: taskId, inputId, outcome: '卡片送达或更新不确定，不重发，请回电脑核对' });
      return { status: 'uncertain', reason: '原卡送达或更新不确定，不重发' };
    }
  }
}
