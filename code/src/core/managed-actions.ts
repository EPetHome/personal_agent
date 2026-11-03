import { hash } from './utils.ts';
import { readLedger, updateLedger } from './ledger.ts';
import { guardWrite, majorConsequences } from './guard.ts';
import { saveHandoff } from './handoff.ts';
import { stageTaskAction } from './task-actions.ts';
import { actionScope, choiceFor, downgradeMode, handleModeAction, settleChoice } from './autonomy-policy.ts';
import { handleMemoryAction } from './managed-memory.ts';
import { chooseMaterial } from './materials.ts';
import { managedControls } from '../channels/feishu/card.ts';
import type { Config } from './types.ts';
import type { LedgerChange, LedgerState, LoopWorker, ManagedInput, ManagedWrite, WorkerReceipt } from './managed-types.ts';

/** 原有反馈词的当前入口：只追加观测，不起模型，不生成汇总。unknown 显式ID留给旧卡兼容。 */
export async function recordManagedFeedback(config: Config, input: { id: string; actor: string; at: string; content: string; cardId?: string | null }): Promise<string | undefined> {
  return updateLedger(config.dataDir, input.at, (state, add) => {
    const id = `feedback:${input.id}`, previous = state.tables.receipts[id];
    if (previous) return previous.response;
    const match = /^(正确|误报|漏了|看不懂)(?:\s|$)/.exec(input.content);
    if (!match) return '反馈请用「正确 / 误报 / 漏了 / 看不懂 + 一句话」。';
    const cards = Object.values(state.tables.cards);
    const card = input.cardId === null ? undefined : input.cardId ? state.tables.cards[input.cardId] : cards.at(-1);
    if (input.cardId && !card) return undefined;
    if (!card && match[1] !== '漏了') return '没有找到托管卡片；请明确引用卡片再反馈。';
    add({ kind: 'observation', observation: { kind: 'feedback', ticketId: card?.ticketId, eventId: card?.eventId, actor: input.actor, detail: input.content } });
    const response = '已记下，不生成报告或复盘。';
    add({ kind: 'put', table: 'receipts', value: { id, at: input.at, response } });
    return response;
  });
}
/** channel 只登记本人点击；行动层只写待写，不直接调用 worker。 */
export async function recordManagedAction(config: Config, input: ManagedInput, source: 'feishu' | 'sidebar' = 'feishu'): Promise<string> {
  input = { ...input, source: source === 'sidebar' ? 'sidebar' : undefined };
  return updateLedger(config.dataDir, input.at, (state, add) => {
    const receiptId = `action:${input.id}`, previous = state.tables.receipts[receiptId];
    if (previous) return previous.response;
    let response: string;
    const card = state.tables.cards[input.cardId];
    const mapped = source === 'sidebar' ? !!config.sidebar && input.messageId === `sidebar:${input.cardId}`
      : Object.values(state.tables.deliveries).some(row => row.cardId === input.cardId && row.channel === 'feishu' && row.messageId === input.messageId && row.state === 'sent');
    const owner = config.feishu?.receiverId ?? 'local:owner';
    if (input.actor !== owner || !mapped || source === 'feishu' && !config.feishu) response = '未找到本人可操作的那张卡片，没有送话。';
    else if (!card || card.revision !== input.revision) response = '卡片已更新，旧按钮失效；请打开最新卡片，没有送话。';
    else if (source === 'sidebar' && !managedControls(card).some(control => control.action === input.action && control.option === input.option)) response = '这个动作不在当前卡片上，没有执行。';
    else {
      add({ kind: 'put', table: 'inputs', value: input });
      if (input.action === 'material_option') response = chooseMaterial(state, add, input);
      else if (input.action.startsWith('mode_')) response = handleModeAction(state, add, input);
      else if (input.action.startsWith('memory_')) response = handleMemoryAction(state, add, input);
      else if (input.action === 'feedback_严重错误') {
        add({ kind: 'observation', observation: { kind: 'feedback', ticketId: card.ticketId, eventId: card.eventId, actor: input.actor, detail: `严重错误：${input.text ?? card.title}` } });
        const scope = card.modeScopeId ?? actionScope(state, card)?.id, id = `serious:${scope}:${card.eventId}`;
        if (!scope) response = '这张卡没有可退档的动作，已记录严重错误。';
        else if (state.tables.receipts[id]) response = '这次严重错误已记录，没有重复退档。';
        else {
          downgradeMode(state, add, scope, input.at, input.actor, input.id, `本人报告严重错误：${input.text ?? card.title}`, true);
          add({ kind: 'put', table: 'receipts', value: { id, at: input.at, response: '已退回上一档' } });
          add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, interrupt: false, deliveryText: '已记录严重错误并退回上一档；取消尚未发送的自动请求，已执行的结果须核对。' } });
          response = '已记录严重错误，退回上一档；这类不再满足自动提示线。';
        }
      } else if (['feedback_正确', 'feedback_误报', 'feedback_看不懂'].includes(input.action)) {
        const verdict = input.action.slice('feedback_'.length);
        add({ kind: 'observation', observation: { kind: 'feedback', ticketId: card.ticketId, eventId: card.eventId, actor: input.actor, detail: `${verdict}${input.text ? `：${input.text}` : ''}` } });
        response = verdict === '误报' ? '已记下误报；同一事实不再催，不影响其他派工。' : '已记下，不生成报告或复盘。';
      } else if (input.action === 'defer') {
        add({ kind: 'put', table: 'cards', value: { ...card, deferred: true, revision: card.revision + 1, interrupt: false, deliveryText: '已放进等你清单，不再催。' } });
        const attention = state.tables.attentions[`attention:${card.assignmentId}`];
        if (attention) add({ kind: 'put', table: 'attentions', value: { ...attention, status: 'waiting' } });
        response = '已放进等你清单，不再催。';
      } else if (input.action === 'manual') {
        add({ kind: 'put', table: 'cards', value: { ...card, input: true, revision: card.revision + 1, interrupt: false } });
        response = '请在原卡输入一句；只会送给这张卡指向的那一条派工。';
      } else if (input.action === 'withdraw') {
        const write = state.tables.writes[card.automaticRequestId ?? card.lastRequestId ?? ''];
        if (!write) response = '没有可撤回的请求。';
        else if (write.automation) {
          if (write.withdrawnAt) response = '已经撤回该类自动授权，不重复退档或投递。';
          else {
            const mode = state.tables.modes[write.automation.scopeId];
            if (mode?.mode === 'auto') downgradeMode(state, add, mode.id, input.at, input.actor, input.id, '本人撤回一次自动处理');
            const pending = write.state === 'pending';
            add({ kind: 'put', table: 'writes', value: { ...write, ...(pending ? { state: 'revoked' as const } : {}), withdrawnAt: input.at } });
            response = pending ? '已撤回，未发送；这类退回建议档。' : '已撤回该类自动授权，退回建议档。已送出/已执行的动作不能收回；不会重发，请核对原卡结果。';
            add({ kind: 'observation', observation: { kind: 'withdrawal', scopeId: write.automation.scopeId, ticketId: write.ticketId, requestId: write.id, actor: input.actor, detail: response } });
            add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, interrupt: false, actionMode: 'none', taskAction: undefined, deliveryText: response } });
          }
        } else if (write.state !== 'pending') response = '已经尝试投递，不能收回已送出的话；不会再投。';
        else {
          add({ kind: 'put', table: 'writes', value: { ...write, state: 'revoked', withdrawnAt: input.at } });
          add({ kind: 'observation', observation: { kind: 'withdrawal', ticketId: write.ticketId, requestId: write.id, actor: input.actor, detail: '用户撤回尚未发送的请求' } });
          add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, interrupt: false, deliveryText: '已撤回，未发送。' } });
          response = '已撤回，未发送。';
        }
      } else if (['query', 'dispatch', 'dispatch_confirm', 'relay_cc'].includes(input.action)) {
        response = stageTaskAction(state, add, input);
      } else if (['push', 'merge', 'stop'].includes(input.action)) {
        response = stageExecution(state, add, input);
      } else {
        const allowed = ['suggest', 'option', 'send_text', 'continue', 'repair', 'confirm'];
        const text = input.action === 'option' || input.action === 'confirm' && input.option !== undefined ? card.options[input.option ?? -1] : input.action === 'send_text' ? input.text
          : input.action === 'continue' ? '继续' : input.action === 'repair' ? '再给一轮' : card.suggestion;
        if (!allowed.includes(input.action) || card.actionMode === 'none' || !text) response = '按钮不属于当前派工，没有送话。';
        else if (input.action === 'send_text' && (card.redline || majorConsequences(text))) {
          // 先固定原话，下一次必须按明确的“确认送话”按钮；不能把红线手写当已确认。
          add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, suggestion: text, basis: '用户刚输入的这一句话；重大后果须明确确认。', redline: true, input: false, interrupt: false } });
          response = '这句话涉及重大后果，请在原卡核对完整原话并明确确认；尚未发送。';
        } else if (Object.values(state.tables.writes).some(write => write.cardId === card.id && write.eventId === card.eventId && !['revoked', 'blocked'].includes(write.state))) {
          response = '这次决定已有送话请求；不会重复投递，请等原卡回执。';
        } else {
          const ticket = state.tables.tickets[card.ticketId];
          const id = `pa-${hash(JSON.stringify([card.id, card.eventId, input.action, text, input.actor])).slice(0, 32)}`;
          const write: ManagedWrite = { id, ticketId: card.ticketId, assignmentId: card.assignmentId, cardId: card.id, cardRevision: card.revision,
            eventId: card.eventId, intentVersion: ticket?.intents.at(-1)?.version ?? 0, actor: input.actor, inputId: input.id,
            at: input.at, text, action: input.action, state: 'pending', redline: card.redline || majorConsequences(text),
            explicitConfirmation: input.action === 'confirm', basis: card.basis, choice: choiceFor(state, card, text) };
          const decision = guardWrite(state, write);
          add({ kind: 'observation', observation: { kind: 'guard', ticketId: card.ticketId, requestId: id, actor: input.actor, detail: decision.reason } });
          if (!decision.allowed) {
            add({ kind: 'put', table: 'writes', value: { ...write, state: 'blocked', reason: decision.reason } });
            response = `没送：${decision.reason}`;
          } else {
            add({ kind: 'put', table: 'writes', value: write });
            // 不改卡版本：发送前围栏仍须核对用户点的版本。只有回执才更新可见卡。
            add({ kind: 'put', table: 'cards', value: { ...card, lastRequestId: id } });
            add({ kind: 'observation', observation: { kind: 'suggestion', ticketId: card.ticketId, eventId: card.eventId, requestId: id,
              actor: input.actor, detail: input.action, value: input.action === 'suggest' || input.action === 'confirm' && text === card.suggestion ? 1 : 0 } });
            add({ kind: 'observation', observation: { kind: 'write', ticketId: card.ticketId, requestId: id, actor: input.actor, detail: '已先记待写；只送这一句话，等待回执' } });
            response = '已记下这条送话，等待投递回执。';
          }
        }
      }
    }
    add({ kind: 'put', table: 'receipts', value: { id: receiptId, at: input.at, response } });
    return response;
  });
}
function stageExecution(state: LedgerState, add: (change: LedgerChange) => void, input: ManagedInput): string {
  const card = state.tables.cards[input.cardId]!, target = card.executions?.find(target => target.action === input.action);
  const ticket = state.tables.tickets[card.ticketId], intent = ticket?.intents.at(-1);
  if (!target || !ticket || !intent) return '这个按钮不属于当前卡片，没有执行。';
  if (intent.pausedActions?.includes(input.action)) return '用户已收紧要求，这项动作暂停；没有执行。';
  const previous = Object.values(state.tables.writes).filter(write => write.cardId === card.id);
  if (previous.some(write => ['pending', 'sending'].includes(write.state))) return '已有请求等待回执，不能同时执行另一项。';
  if (previous.some(write => write.eventId === card.eventId && write.action === input.action && write.execution && write.state !== 'revoked' && !(write.state === 'blocked' && !write.outcome)))
    return '这项执行已经请求过；结果不明确也不会重发。';
  // 点击仅批准这一条派工/动作/提交；不从loop材料或模型中获得执行权限。
  const version = intent.version + 1;
  add({ kind: 'put', table: 'tickets', value: { ...ticket, intents: [...ticket.intents, { ...intent, version, replaces: intent.version, at: input.at,
    source: `本人 ${input.actor} 点击 ${input.action}；输入 ${input.id}；原任务：${intent.source}`, confirmed: true,
    stage: `明确确认本次 ${input.action}，不允许其他执行或自动档`,
    boundaries: { ...intent.boundaries, execute: [`loop_${input.action}`] },
    executionApproval: { inputId: input.id, assignmentId: card.assignmentId, eventId: card.eventId, target },
  }] } });
  const id = `pa-${hash(JSON.stringify([card.id, card.eventId, target, input.actor])).slice(0, 32)}`;
  const labels = { push: '推到仓库', merge: '合入', stop: '停掉这批' };
  const write: ManagedWrite = { id, ticketId: card.ticketId, assignmentId: card.assignmentId, cardId: card.id, cardRevision: card.revision,
    eventId: card.eventId, intentVersion: version, actor: input.actor, inputId: input.id, at: input.at,
    text: `${labels[target.action]}${target.branch ? ` ${target.branch}` : ''}${target.commit ? ` @ ${target.commit}` : ''}${target.candidateRef ? `（核实候选 ${target.candidateRef}）` : ''}${target.remote ? ` → ${target.remote}（${target.visibility ?? 'unknown'}）` : ''}`,
    action: target.action, state: 'pending', redline: true, explicitConfirmation: true, basis: card.basis, execution: target };
  const decision = guardWrite(state, write);
  add({ kind: 'observation', observation: { kind: 'guard', ticketId: card.ticketId, requestId: id, actor: input.actor, detail: decision.reason } });
  add({ kind: 'put', table: 'writes', value: decision.allowed ? write : { ...write, state: 'blocked', reason: decision.reason } });
  if (!decision.allowed) return `没有执行：${decision.reason}`;
  add({ kind: 'put', table: 'cards', value: { ...card, lastRequestId: id } });
  add({ kind: 'observation', observation: { kind: 'write', ticketId: card.ticketId, requestId: id, actor: input.actor, detail: `已先记执行待写：${write.text}；依据：${write.basis}` } });
  return `已记下「${labels[target.action]}」的明确确认，等待 loop 执行回执。`;
}
export async function recordWorkerReceipt(config: Config, receipt: WorkerReceipt, at: string) {
  await updateLedger(config.dataDir, at, (state, add) => {
    const write = state.tables.writes[receipt.requestId];
    if (!write || !['sending', 'delivered', 'uncertain'].includes(write.state)) return;
    if (!['delivered', 'consumed', 'uncertain', 'failed'].includes(receipt.status)) return;
    if (write.state === 'delivered' && receipt.status !== 'consumed') return; // 不倒退已送达状态。
    let label: string | undefined;
    if (write.execution) {
      const expected = { push: 'pushed', merge: 'merged', stop: 'stopped' }[write.execution.action];
      if (['consumed', 'delivered'].includes(receipt.status) && (receipt.outcome !== expected
        || write.execution.action !== 'stop' && !/^[a-f0-9]{40,64}$/i.test(receipt.commit ?? '')
        || write.execution.action === 'push' && receipt.commit !== write.execution.commit)) {
        receipt = { requestId: write.id, status: 'uncertain', reason: '执行回执缺少可核对的结果/提交号，或与确认的提交不同；不重发', failure: true };
      }
      if (receipt.code === 'suspected_secret') receipt = { ...receipt, status: 'failed', outcome: 'blocked', reason: '发现疑似密钥，没推' };
      label = receipt.outcome === 'blocked' ? receipt.code === 'suspected_secret' ? '发现疑似密钥，没推' : `没有执行：${receipt.reason ?? 'loop 围栏拦下'}`
        : receipt.status === 'uncertain' ? '不确定：说不清执行结果，不重发'
          : receipt.status === 'failed' ? `执行没成功：${receipt.reason ?? 'loop 报告失败'}；不自动重发`
            : `${{ pushed: '已推送', merged: '已合入', stopped: '已停' }[expected as 'pushed' | 'merged' | 'stopped']}${receipt.commit ? ` · ${receipt.commit}` : ''}`;
      if (['consumed', 'delivered'].includes(receipt.status) && ['merged', 'stopped'].includes(receipt.outcome ?? '')) {
        const ticket = state.tables.tickets[write.ticketId]!;
        const kind = receipt.outcome as 'merged' | 'stopped';
        add({ kind: 'put', table: 'tickets', value: { ...ticket, status: kind, closure: { kind, requestId: write.id, at, ...(receipt.commit ? { commit: receipt.commit } : {}) } } });
        for (const assignment of Object.values(state.tables.assignments).filter(row => row.ticketId === ticket.id)) add({ kind: 'put', table: 'assignments', value: { ...assignment, endedAt: at } });
        for (const attention of Object.values(state.tables.attentions).filter(row => row.ticketId === ticket.id && row.status !== 'resolved')) add({ kind: 'put', table: 'attentions', value: { ...attention, status: 'resolved' } });
      }
    }
    settleChoice(state, add, write, at, ['delivered', 'consumed'].includes(receipt.status) && receipt.outcome !== 'blocked');
    add({ kind: 'put', table: 'writes', value: { ...write, state: receipt.outcome === 'blocked' ? 'blocked' : receipt.status, reason: receipt.reason,
      outcome: receipt.outcome, commit: receipt.commit, code: receipt.code, failure: receipt.failure } });
    add({ kind: 'observation', observation: { kind: 'write', ticketId: write.ticketId, requestId: write.id, actor: write.actor, detail: `回执：${receipt.status}${receipt.reason ? `；${receipt.reason}` : ''}` } });
    const card = state.tables.cards[write.cardId];
    const labels = { delivered: '已送达（已送到）', consumed: '已送达（已读）', uncertain: '不确定：说不清是否送到，不重发', failed: '话没送到：投递失败，不自动重发' };
    if (card && card.eventId === write.eventId && card.assignmentId === write.assignmentId
      && state.tables.tickets[write.ticketId]?.intents.at(-1)?.version === write.intentVersion) add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, at, input: false, interrupt: false, deliveryText: write.automation ? `${['delivered', 'consumed'].includes(receipt.status) ? `已按建议处理：${write.text}；` : '自动处理未确认成功，已退档；'}${labels[receipt.status]}${write.withdrawnAt ? '\n该类自动授权已撤回；不表示已收回外部动作。' : ''}` : label ?? labels[receipt.status], lastRequestId: write.id,
      ...(write.automation ? { automaticRequestId: write.id, actionMode: 'none' as const } : {}),
      ...(write.execution ? { executions: state.tables.tickets[write.ticketId]?.closure ? [] : card.executions?.filter(target => target.action !== write.execution!.action),
        ...(state.tables.tickets[write.ticketId]?.closure ? { actionMode: 'none' as const } : {}) } : {}) } });
    if (write.execution?.action === 'stop' && receipt.outcome === 'stopped' && ['consumed', 'delivered'].includes(receipt.status)) saveHandoff(state, add, write.assignmentId, at, 'stopped', write.id);
  });
}
/** adapter 消费待写。sending 先 fsync；进程崩溃后只能变 uncertain，不能自动再投。 */
export async function dispatchWrites(config: Config, at: string, worker?: LoopWorker) {
  for (const candidate of Object.values((await readLedger(config.dataDir)).tables.writes)) {
    if (candidate.dispatch) continue; // 派工由独立adapter消费，不能当成loop送话。
    if (candidate.state === 'sending') {
      await recordWorkerReceipt(config, { requestId: candidate.id, status: 'uncertain', reason: '上次投递未记到回执，重启不重发' }, at); continue;
    }
    if (candidate.state !== 'pending') continue;
    const claimed = await updateLedger(config.dataDir, at, (state, add) => {
      const write = state.tables.writes[candidate.id]; if (!write || write.state !== 'pending') return;
      const decision = guardWrite(state, write);
      add({ kind: 'observation', observation: { kind: 'guard', ticketId: write.ticketId, requestId: write.id, actor: write.actor, detail: `发送前复核：${decision.reason}` } });
      if (!decision.allowed) {
        add({ kind: 'put', table: 'writes', value: { ...write, state: 'blocked', reason: decision.reason } });
        const card = state.tables.cards[write.cardId];
        if (card) add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, interrupt: false, deliveryText: `没有执行/发送：${decision.reason}` } });
        return;
      }
      add({ kind: 'put', table: 'writes', value: { ...write, state: 'sending' } });
      return { write, assignment: state.tables.assignments[write.assignmentId]! };
    });
    if (!claimed) continue;
    let receipt: WorkerReceipt;
    try {
      if (claimed.write.execution) receipt = worker?.execute ? await worker.execute({ ...claimed.write.execution, requestId: claimed.write.id,
        project: claimed.assignment.project, batch: claimed.assignment.batch, batchFile: claimed.assignment.batchFile, stage: claimed.assignment.stage, source: 'user_via_pa', force: false, checkSecrets: true, protectedBranches: ['main', 'master'] })
        : { requestId: claimed.write.id, status: 'failed', reason: 'worker 未配置执行接口，没有执行' };
      else receipt = worker ? await worker.send({ requestId: claimed.write.id, project: claimed.assignment.project, batch: claimed.assignment.batch, batchFile: claimed.assignment.batchFile, stage: claimed.assignment.stage, text: claimed.write.text, source: claimed.write.automation ? 'pa_auto' : 'user_via_pa' })
        : { requestId: claimed.write.id, status: 'failed', reason: '未配置 worker 命令，没有投递' };
    }
    catch { receipt = { requestId: claimed.write.id, status: 'uncertain', reason: '适配器失败/超时，可能已送到，不重发', failure: true }; }
    if (receipt.requestId !== claimed.write.id) receipt = { requestId: claimed.write.id, status: 'uncertain', reason: '回执请求号不匹配，不重发', failure: true };
    await recordWorkerReceipt(config, receipt, at);
  }
}
