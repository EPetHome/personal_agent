import type { Config } from './types.ts';
import type { LedgerChange, LedgerState } from './managed-types.ts';

/** 只读机械事实、只写账本。不起模型、不发消息、不读取worker会话文件。 */
export function watchManagedFacts(state: LedgerState, add: (change: LedgerChange) => void, at: string, config: Config, inspect = false) {
  for (const assignment of Object.values(state.tables.assignments)) {
    const inactive = !!assignment.endedAt || !!state.tables.tickets[assignment.ticketId]?.closure || assignment.state === 'completed';
    const missingId = `session:${assignment.id}`, staleId = `stale:${assignment.id}`;
    for (const id of [missingId, staleId]) {
      const old = state.tables.attentions[id];
      if (old && old.status !== 'resolved' && (inactive || id === missingId && assignment.session?.present === true
        || id === staleId && Date.parse(at) - Date.parse(assignment.lastActivityAt ?? assignment.updatedAt) < (config.managedLoop?.staleAfterMs ?? 1800000)))
        add({ kind: 'put', table: 'attentions', value: { ...old, status: 'resolved' } });
    }
    if (inactive) continue;
    const missing = assignment.session?.present === false;
    const stale = inspect && ['started', 'resumed'].includes(assignment.state)
      && Date.parse(at) - Date.parse(assignment.lastActivityAt ?? assignment.updatedAt) >= (config.managedLoop?.staleAfterMs ?? 1800000);
    if (!missing && !stale) continue;
    const id = missing ? missingId : staleId, old = state.tables.attentions[id];
    if (old?.eventId === assignment.lastEventId && old.status !== 'resolved') continue;
    const reason = missing ? '这件事没人在做了：只读状态查不到这段会话，事情还没完成' : '派工长时间没有新事件；仅陈列，不推送，不猜测是否停工';
    add({ kind: 'put', table: 'attentions', value: { id, ticketId: assignment.ticketId, assignmentId: assignment.id, eventId: assignment.lastEventId, status: 'waiting', reason } });
    add({ kind: 'observation', observation: { kind: 'not_called', ticketId: assignment.ticketId, eventId: assignment.lastEventId, detail: reason } });
  }
  for (const write of Object.values(state.tables.writes)) {
    if (write.state !== 'failed' && !write.failure) continue;
    const id = `write:${write.id}`;
    if (state.tables.health[id]) continue;
    add({ kind: 'put', table: 'health', value: { id, ok: false, episode: id, at, kind: 'delivery',
      reason: `${write.execution ? '执行' : '话'}没送到/未确认：请求 ${write.id}；${write.reason ?? 'worker 回执失败'}。不自动重发。` } });
  }
  for (const connection of Object.values(state.tables.connections)) {
    const id = `connection:${connection.id}`, old = state.tables.health[id];
    const failed = connection.state === 'failed' || connection.state === 'reconnecting' && !!connection.failure;
    if (old?.ok === !failed || !old && !failed) continue;
    add({ kind: 'put', table: 'health', value: { id, ok: !failed, episode: failed ? `${id}:${connection.at}` : '', at, kind: 'source',
      reason: failed ? `看不见 ${connection.id}：连接状态 ${connection.state}；${connection.failure?.category ?? 'unknown'}（不推断业务原因）` : '' } });
  }
}
