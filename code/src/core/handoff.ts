import type { LedgerState, LedgerChange, Handoff } from './managed-types.ts';

/** 只从已入账事实起草，不推断决定，不复制原始日志或会话。开新批可按 ticketId 取最近一份。 */
export function saveHandoff(state: LedgerState, add: (change: LedgerChange) => void, assignmentId: string, at: string, trigger: Handoff['trigger'], key: string) {
  const assignment = state.tables.assignments[assignmentId], ticket = assignment && state.tables.tickets[assignment.ticketId];
  if (!assignment || !ticket) return;
  const id = `handoff:${key}`; if (state.tables.handoffs[id]) return;
  const event = state.events[assignment.lastEventId], assessment = state.tables.assessments[`assessment:${assignment.lastEventId}`];
  const writes = Object.values(state.tables.writes).filter(write => write.ticketId === ticket.id);
  const decisions = writes.map(write => `${write.at} · ${write.actor} · ${write.text} · ${write.state}${write.commit ? ` · ${write.commit}` : ''}`);
  const mustFix = Array.isArray(event?.detail.mustFix) ? event.detail.mustFix.filter((value): value is string => typeof value === 'string') : [];
  const latest = ticket.intents.at(-1), commit = assessment?.commit;
  add({ kind: 'put', table: 'handoffs', value: { id, ticketId: ticket.id, assignmentId, eventId: assignment.lastEventId, at, trigger,
    goal: latest?.goal ?? '目标未提供，待确认',
    progress: `${trigger === 'stopped' ? '用户已停掉这批' : '返修到上限'}；${assessment?.fact ?? event?.reason.text ?? '当前进度未提供'}；事情状态 ${ticket.status}（不代表业务验收通过）`,
    decisions: decisions.length ? decisions : ['账本中没有已确认的关键决定'],
    unresolved: mustFix.length ? mustFix : [assessment?.question || (typeof event?.detail.question === 'string' ? event.detail.question : '') || '尚无完整遗留问题清单，需下一批核对'],
    codeLocation: [ticket.project, `批次：${ticket.batch}；段：${assignment.stage || '未提供'}`,
      `分支：${commit?.branch || (typeof event?.detail.branch === 'string' ? event.detail.branch : '未提供')}`,
      `提交：${commit?.resolved || (typeof event?.detail.commit === 'string' ? event.detail.commit : '未核实')}`,
      `任务定义：${latest?.source ?? '未提供'}`],
  } });
}
