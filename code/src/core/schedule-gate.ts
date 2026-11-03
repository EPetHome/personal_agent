import { hash } from './utils.ts';
import type { LedgerState, ManagedCard } from './managed-types.ts';

/** 纯账本闸门：完成卡上的推/合按钮不是一条新的红线请求，完成通知仍须会后发。 */
export function meetingUntil(state: LedgerState, at: string, calendarIds: string[]): number | undefined {
  const clock = Date.parse(at);
  const ends = Object.values(state.tables.calendars).filter(snapshot => calendarIds.includes(snapshot.calendarId))
    .flatMap(snapshot => snapshot.meetings).filter(meeting => Date.parse(meeting.start) <= clock && clock < Date.parse(meeting.end))
    .map(meeting => Date.parse(meeting.end));
  return ends.length ? Math.max(...ends) : undefined;
}
export function delayForMeeting(state: LedgerState, card: ManagedCard, at: string, calendarIds: string[]): boolean {
  if (!calendarIds.length) return false;
  const urgency = card.urgency ?? (card.id.startsWith('health:') ? 'fault'
    : state.events[card.eventId]?.state === 'completed' ? 'completion'
      : card.redline ? 'redline' : card.actionMode !== 'none' || card.taskAction ? 'decision' : 'display');
  if (['fault', 'redline', 'decision'].includes(urgency)) return false;
  const clock = Date.parse(at);
  // 首轮日历尚未读完/来源失明时不能先把完成卡漏出去；故障本身照常立即告知。
  const unknown = state.tables.health['source:schedule']?.ok === false || calendarIds.some(id => {
    const snapshot = state.tables.calendars[`calendar:${id}`];
    return !snapshot || Date.parse(snapshot.from) > clock || Date.parse(snapshot.to) <= clock
      || state.tables.health[`source:calendar:${hash(id).slice(0, 16)}`]?.ok === false;
  });
  return unknown || !!meetingUntil(state, at, calendarIds);
}
