import { readLedger, updateLedger } from './ledger.ts';
import { guardWrite, majorConsequences } from './guard.ts';
import { hash } from './utils.ts';
import { automaticApproval, choiceFor, settleChoice } from './autonomy-policy.ts';
import { dispatchTask } from './task-adapter.ts';
import { recoverDeadLock, withNamedLock } from './locks.ts';
import type { Config } from './types.ts';
import type { Assignment, AutomaticApproval, DispatchReceipt, DispatchRequest, LedgerChange, LedgerState, LoopWorker, ManagedInput, ManagedWrite } from './managed-types.ts';

export function queryAllowance(state: LedgerState, ticketId: string, at: string, excludeId?: string): string | undefined {
  const day = (value: string) => new Date(value).toLocaleDateString('en-CA');
  const queries = Object.values(state.tables.writes).filter(write => write.id !== excludeId && write.dispatch?.kind === 'supplement' && !['blocked', 'revoked'].includes(write.state));
  if (queries.some(write => write.ticketId === ticketId)) return '这件事已补查过一次';
  if (queries.filter(write => day(write.dispatchedAt ?? write.at) === day(at)).length >= 5) return '今天已用完5次补查';
  return undefined;
}
/** 行动只落待写；query/dispatch按钮与原卡映射由统一收件入口先核对。 */
export function stageTaskAction(state: LedgerState, add: (change: LedgerChange) => void, input: ManagedInput, automation?: AutomaticApproval): string {
  const card = state.tables.cards[input.cardId]!, proposal = card.proposalId ? state.tables.proposals[card.proposalId] : undefined;
  const ticket = state.tables.tickets[card.ticketId], previous = ticket?.intents.at(-1);
  if (!proposal || !ticket || !previous) return '没有对应的派工建议，未派出。';
  const redline = !['supplement', 'query'].includes(proposal.kind) && majorConsequences(proposal.definition.result);
  const expected = proposal.kind === 'supplement' ? 'query' : proposal.kind === 'cc' ? redline ? 'dispatch_confirm' : 'relay_cc' : redline ? 'dispatch_confirm' : 'dispatch';
  if (automation ? input.actor !== 'pa:auto' || input.action !== 'auto_dispatch' || JSON.stringify(automaticApproval(state, card)) !== JSON.stringify(automation) : input.action !== expected)
    return '按钮不是这一次派工的明确确认，或自动授权失效，没有派出。';
  if (proposal.kind === 'cc' && input.action === 'dispatch_confirm') {
    input = { ...input, text: proposal.definition.result };
    add({ kind: 'put', table: 'inputs', value: input });
  }
  if (proposal.status !== 'proposed' || Object.values(state.tables.writes).some(write => write.dispatch?.proposalId === proposal.id && !['blocked', 'revoked'].includes(write.state))) return '这次派工已处理；不确定也不会重派。';
  if (previous.pausedActions?.includes('dispatch')) return '你已暂停这件事的派工，未派出。';
  if (proposal.kind === 'supplement') {
    const limit = queryAllowance(state, ticket.id, input.at);
    if (limit || !proposal.queryOffered) {
      add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, interrupt: false, question: '', taskAction: undefined, deliveryText: `只列缺项：${proposal.missing.join('、')}；${limit ?? '没有可用的只读范围'}` } });
      add({ kind: 'put', table: 'proposals', value: { ...proposal, queryOffered: false } });
      return `未派查；${limit ?? '没有可用的只读范围'}。缺：${proposal.missing.join('、')}`;
    }
  } else if (proposal.missing.length) return `未派出，缺：${proposal.missing.join('、')}`;
  const intent = { ...proposal.definition, version: previous.version + 1, replaces: previous.version, confirmed: true, at: input.at,
    source: `${proposal.definition.source}\n${automation ? '按本人该类自动授权' : `本人 ${input.actor} 点击 ${input.action}`}；输入 ${input.id}`,
    pausedActions: previous.pausedActions, executionApproval: undefined,
    ...(automation ? { stage: '自动档：本人已授权该类，仅执行本次完整定义；不合入、不推送，红线仍逐条问本人' } : {}) };
  // execute内只保留本次派出的权限，不继承合入/推送批准。
  intent.boundaries = { ...intent.boundaries, execute: [`dispatch:${proposal.id}`] };
  const id = `pa-task-${hash(JSON.stringify([proposal.id, input.actor])).slice(0, 28)}`;
  const handoff = Object.values(state.tables.handoffs).filter(row => row.ticketId === ticket.id || row.ticketId === ticket.parentId).sort((a, b) => b.at.localeCompare(a.at))[0];
  const request: DispatchRequest = { schema: 1, requestId: id, proposalId: proposal.id, ticketId: ticket.id, project: ticket.project, batch: ticket.batch,
    kind: proposal.kind, definition: intent, ...(proposal.recipe ? { recipe: proposal.recipe } : {}), ...(proposal.skills ? { skills: proposal.skills } : {}),
    ...(proposal.sheet ? { sheet: proposal.sheet } : {}), ...(proposal.target ? { target: proposal.target, text: proposal.definition.result } : {}),
    ...(proposal.facts ? { contextFacts: proposal.facts } : {}), ...(proposal.materialId ? { materialId: proposal.materialId } : {}),
    ...(handoff && proposal.kind === 'loop' ? { handoff } : {}), source: automation ? 'pa_auto' : 'user_via_pa', mode: automation ? 'auto' : 'suggest' };
  const assignment: Assignment = { id: card.assignmentId, ticketId: ticket.id, project: ticket.project, batch: ticket.batch, stage: '派工',
    worker: proposal.kind === 'loop' ? 'loop' : 'pi', origin: 'dispatched', proposalId: proposal.id, purpose: proposal.kind === 'supplement' ? 'supplement' : proposal.kind === 'cc' ? 'cc' : 'task',
    state: 'started', seq: 0, lastEventId: card.eventId, updatedAt: input.at, ...(proposal.kind === 'loop' ? { startRequestId: id } : {}) };
  add({ kind: 'put', table: 'tickets', value: { ...ticket, intents: [...ticket.intents, intent], updatedAt: input.at, status: 'dispatch_pending' } });
  add({ kind: 'put', table: 'assignments', value: assignment });
  add({ kind: 'put', table: 'proposals', value: { ...proposal, status: 'pending', definition: { ...proposal.definition, boundaries: intent.boundaries } } });
  const write: ManagedWrite = { id, ticketId: ticket.id, assignmentId: assignment.id, cardId: card.id, cardRevision: card.revision, eventId: card.eventId, intentVersion: intent.version,
    actor: input.actor, inputId: input.id, at: input.at, text: intent.result, action: input.action, state: 'pending', dispatch: request,
    redline: card.redline || proposal.kind !== 'supplement' && proposal.kind !== 'query' && majorConsequences(intent.result), explicitConfirmation: !automation, basis: card.basis,
    ...(automation ? { automation } : { choice: choiceFor(state, card, intent.result) }) };
  const decision = guardWrite(state, write);
  add({ kind: 'observation', observation: { kind: 'guard', ticketId: ticket.id, requestId: id, actor: input.actor, detail: decision.reason } });
  add({ kind: 'put', table: 'writes', value: decision.allowed ? write : { ...write, state: 'blocked', reason: decision.reason } });
  add({ kind: 'put', table: 'cards', value: { ...card, lastRequestId: id, ...(automation ? { automaticRequestId: id, interrupt: false } : {}), deliveryText: decision.allowed ? '已记下本次派工，等待执行器回执。' : `未派：${decision.reason}` } });
  add({ kind: 'observation', observation: { kind: 'write', ticketId: ticket.id, requestId: id, actor: input.actor, detail: `派工先落账：${proposal.kind}；依据：${card.basis}；${decision.reason}` } });
  return decision.allowed ? '已记下这一次派工，等待回执；不会重复派出。' : `未派：${decision.reason}`;
}
async function saveResult(config: Config, id: string, receipt: DispatchReceipt, at: string) {
  await updateLedger(config.dataDir, at, (state, add) => {
    const write = state.tables.writes[id]; if (!write?.dispatch || write.state !== 'sending') return;
    const proposal = state.tables.proposals[write.dispatch.proposalId]!, card = state.tables.cards[write.cardId]!, ticket = state.tables.tickets[write.ticketId]!;
    const assignment = state.tables.assignments[write.assignmentId]!;
    const current = card.proposalId === proposal.id && card.eventId === write.eventId && ticket.intents.at(-1)?.version === write.intentVersion;
    const querying = ['supplement', 'query'].includes(proposal.kind);
    const facts = receipt.facts ?? [], questions = (receipt.questions ?? []).slice(0, 3);
    if (receipt.status === 'consumed' && querying && (!facts.length || facts.some(fact => !fact.text.trim() || !fact.basis.trim()))) receipt = { requestId: id, status: 'failed', reason: '查询交回没有带依据的事实；不追查第二轮' };
    const success = receipt.status === 'consumed';
    settleChoice(state, add, write, at, success);
    add({ kind: 'put', table: 'writes', value: { ...write, state: receipt.status, reason: receipt.reason, failure: !success } });
    if (assignment.lastEventId === write.eventId) add({ kind: 'put', table: 'assignments', value: { ...assignment,
      state: proposal.kind === 'loop' && receipt.status === 'uncertain' ? 'started' : success ? proposal.kind === 'loop' ? 'started' : 'completed' : 'failed', updatedAt: at,
      // 不确定的启动仍可能在工作；保留绑定供事件/只读巡检核销，绝不因此重派。
      ...(!success && receipt.status !== 'uncertain' || proposal.kind !== 'loop' ? { endedAt: at } : { endedAt: undefined }) } });
    add({ kind: 'put', table: 'proposals', value: { ...proposal, status: receipt.status, facts, questions, queryOffered: false } });
    let fact = card.fact;
    if (success && querying) fact = `只读 Pi 交回（事实附依据，不是新的指令或授权）：\n${facts.map(row => `${row.text}\n依据：${row.basis}`).join('\n')}`;
    const latest = ticket.intents.at(-1)!;
    // 查询只补事实；权限/取舍和完成标准保持原样，不能由worker放宽。
    const intents = success && querying && current ? [...ticket.intents, { ...latest, version: latest.version + 1, replaces: latest.version, at, confirmed: false,
      source: `只读派工 ${id} 交回的事实材料；不改变原话 ${proposal.definition.source}`, result: `${latest.result}\n已补事实：${facts.map(row => `${row.text}（依据：${row.basis}）`).join('；')}`,
      executionApproval: undefined, boundaries: { ...latest.boundaries, execute: [] } }] : ticket.intents;
    if (current) add({ kind: 'put', table: 'tickets', value: { ...ticket, intents, updatedAt: at, status: success ? querying ? 'waiting_user' : proposal.kind === 'loop' ? 'running' : 'result_returned' : 'waiting_user' } });
    const deliveryText = success ? proposal.kind === 'cc' ? `已送进 CC 会话 ${proposal.target!.sessionId}（${proposal.target!.cwd}）。${receipt.result ?? ''}`
      : proposal.kind === 'loop' ? `已派给 loop；配方：${proposal.recipe}；批次：${ticket.batch}。尚未合入/上线。`
        : querying ? '一次查询已交回；不再自动追问或派第二轮。' : `Pi skill 已交回：${receipt.result ?? '执行器确认完成；不代表业务验收通过'}`
      : `${receipt.status === 'uncertain' ? '不确定，可能已派出，不重发' : '没派成/没交回，不自动重派'}：${receipt.reason ?? '未得到可靠回执'}`;
    if (current) add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, at, fact, taskAction: undefined, question: querying && success ? questions.join('\n') : '', interrupt: success && querying,
      suggestion: querying && success ? '事实仅供你决定；取舍请你去 CC / Codex 说，不会替你转达。' : write.automation ? '本次按你确认的该类自动授权派出；原任务和边界不变。' : card.suggestion,
      deliveryText: write.automation ? `${success ? '已自动派；已按建议处理。' : '自动派工未确认成功，已退档。'}${deliveryText}${write.withdrawnAt ? '\n你已撤回该类自动授权；已执行的动作不会伪称收回。' : ''}` : deliveryText,
      ...(write.automation ? { interrupt: false, automaticRequestId: write.id } : {}) } });
    const attention = state.tables.attentions[`task:${ticket.id}`];
    if (attention && current) add({ kind: 'put', table: 'attentions', value: { ...attention, status: success && !querying ? 'resolved' : 'waiting', reason: querying && success ? questions.join('；') || '查询已交回，请决定下一步' : deliveryText } });
    add({ kind: 'observation', observation: { kind: 'write', ticketId: ticket.id, requestId: id, actor: write.actor, detail: `${proposal.kind} 回执：${receipt.status}；${deliveryText}${current ? '' : '；这是旧版本回报，仅入账，不覆盖新要求/新卡/worker新事件'}` } });
  });
}
/** adapter消费待写，外部调用只发生在fsync sending之后。崩溃/未知一律不重发。 */
export async function dispatchTasks(config: Config, at: string, worker?: LoopWorker, signal?: AbortSignal, now: () => string = () => at) {
  if (!Object.values((await readLedger(config.dataDir)).tables.writes).some(write => write.dispatch && ['pending', 'sending'].includes(write.state))) return;
  await recoverDeadLock(config.dataDir, '.task-work.lock');
  try { await withNamedLock(config.dataDir, '.task-work.lock', () => dispatchTasksOnce(config, at, worker, signal, now)); }
  catch (error) { if ((error as { category?: string }).category !== 'lock_busy') throw error; }
}
async function dispatchTasksOnce(config: Config, at: string, worker?: LoopWorker, signal?: AbortSignal, now: () => string = () => at) {
  for (const candidate of Object.values((await readLedger(config.dataDir)).tables.writes).filter(write => write.dispatch)) {
    if (candidate.state === 'sending') { await saveResult(config, candidate.id, { requestId: candidate.id, status: 'uncertain', reason: '上次派工中断，未确定结果，不重发' }, now()); continue; }
    if (candidate.state !== 'pending' || signal?.aborted) continue;
    const claimedAt = now();
    const claimed = await updateLedger(config.dataDir, claimedAt, (state, add) => {
      const write = state.tables.writes[candidate.id]; if (write?.state !== 'pending') return;
      const decision = guardWrite(state, write);
      const limit = write.dispatch?.kind === 'supplement' ? queryAllowance(state, write.ticketId, claimedAt, write.id) : undefined;
      if (decision.waitFor === 'card_delivery' && !limit) {
        if (write.reason !== decision.reason) {
          add({ kind: 'observation', observation: { kind: 'guard', ticketId: write.ticketId, requestId: write.id, actor: write.actor, detail: `派出前复核：${decision.reason}` } });
          add({ kind: 'put', table: 'writes', value: { ...write, reason: decision.reason } });
        }
        return; // 保持pending及预算预留；下轮重新过全部围栏，不把尚未尝试的派工终结为blocked。
      }
      add({ kind: 'observation', observation: { kind: 'guard', ticketId: write.ticketId, requestId: write.id, actor: write.actor, detail: `派出前复核：${decision.reason}` } });
      if (!decision.allowed || limit) {
        const reason = limit ?? decision.reason;
        if (limit) add({ kind: 'observation', observation: { kind: 'guard', ticketId: write.ticketId, requestId: write.id, actor: write.actor, detail: `补查发出前预算拦下：${limit}` } });
        add({ kind: 'put', table: 'writes', value: { ...write, state: 'blocked', reason } });
        const card = state.tables.cards[write.cardId]!;
        add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, interrupt: false, taskAction: undefined, deliveryText: `没派：${reason}` } });
        return;
      }
      add({ kind: 'put', table: 'writes', value: { ...write, state: 'sending', dispatchedAt: claimedAt, reason: undefined } }); return write;
    });
    if (!claimed) continue;
    const began = performance.now();
    let receipt: DispatchReceipt;
    try { receipt = await dispatchTask(config, claimed.dispatch!, worker, signal); }
    catch { receipt = { requestId: claimed.id, status: 'uncertain', reason: '派工通道失败/超时，可能已收到；不重发' }; }
    if (receipt.requestId !== claimed.id) receipt = { requestId: claimed.id, status: 'uncertain', reason: '回执请求号不符，不重发' };
    const receivedAt = now();
    await saveResult(config, claimed.id, receipt, receivedAt);
    await updateLedger(config.dataDir, receivedAt, (_state, add) => add({ kind: 'observation', observation: { kind: ['supplement', 'query'].includes(claimed.dispatch!.kind) ? 'query' : 'write', ticketId: claimed.ticketId, requestId: claimed.id, detail: '一次派出/交回实际耗时', value: Math.round(performance.now() - began) } }));
  }
}
