import { guardWrite } from './guard.ts';
import { actionScope, automaticApproval, ensureMode } from './autonomy-policy.ts';
import { stageTaskAction } from './task-actions.ts';
import { hash } from './utils.ts';
import type { LedgerChange, LedgerState, ManagedWrite } from './managed-types.ts';

/** 行动层只生成待写。没有模型/worker/channel调用，发出前仍由适配器重新过围栏。 */
export function planAutonomy(state: LedgerState, add: (change: LedgerChange) => void, at: string) {
  for (const original of Object.values(state.tables.cards)) {
    const scope = actionScope(state, original); if (!scope) continue;
    const mode = ensureMode(state, add, scope, at);
    let card = state.tables.cards[original.id]!;
    if (card.modeScopeId !== scope.id) { card = { ...card, modeScopeId: scope.id }; add({ kind: 'put', table: 'cards', value: card }); }
    // 红线不受影子/自动档掩盖，仍然正常出卡等本人逐条确认。
    if (mode.mode === 'shadow' && !card.redline) {
      if (card.notifyChannels?.length !== 0) add({ kind: 'put', table: 'cards', value: { ...card, notifyChannels: [], interrupt: false } });
      continue;
    }
    if (card.notifyChannels?.length === 0) {
      card = { ...card, revision: card.revision + 1, notifyChannels: undefined, interrupt: true };
      add({ kind: 'put', table: 'cards', value: card });
    }
    const approval = automaticApproval(state, card);
    if (!approval || Object.values(state.tables.writes).some(write => write.cardId === card.id && write.eventId === card.eventId && !['revoked', 'blocked'].includes(write.state))) continue;
    if (card.proposalId) {
      const proposal = state.tables.proposals[card.proposalId];
      if (proposal?.status === 'proposed' && card.taskAction) stageTaskAction(state, add, { id: approval.inputId, actor: 'pa:auto', at, messageId: '', cardId: card.id, revision: card.revision, action: 'auto_dispatch' }, approval);
      continue;
    }
    if (card.actionMode === 'none') continue;
    const id = `pa-auto-${hash(JSON.stringify([card.id, card.eventId, approval.version])).slice(0, 28)}`;
    // 同一事件撤回后不再自动处理，即使后来又改回自动也不重投。
    if (state.tables.writes[id]) continue;
    const write: ManagedWrite = { id, ticketId: card.ticketId, assignmentId: card.assignmentId, cardId: card.id, cardRevision: card.revision,
      eventId: card.eventId, intentVersion: state.tables.tickets[card.ticketId]!.intents.at(-1)!.version, actor: 'pa:auto', inputId: approval.inputId,
      at, text: card.suggestion, action: 'auto_reply', state: 'pending', redline: false, explicitConfirmation: false,
      basis: `${card.basis}\n本人档位授权 ${approval.inputId}；${scope.id} v${approval.version}`, automation: approval };
    const decision = guardWrite(state, write);
    add({ kind: 'observation', observation: { kind: 'guard', scopeId: scope.id, ticketId: card.ticketId, requestId: id, actor: write.actor, detail: `自动待写：${decision.reason}` } });
    if (!decision.allowed) continue; // 不把一次自动资格不足变成重复投递许可，原卡照常等确认。
    add({ kind: 'put', table: 'writes', value: write });
    add({ kind: 'put', table: 'cards', value: { ...card, lastRequestId: id, automaticRequestId: id, interrupt: false } });
    add({ kind: 'observation', observation: { kind: 'write', scopeId: scope.id, ticketId: card.ticketId, requestId: id, actor: write.actor, detail: '按本人该类授权先落自动待写；结果将在原卡交代，红线不自动' } });
  }
}
