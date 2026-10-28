import { membersOf } from './sessions.ts';
import type { Notice, Projection, RequestRef, SessionMember } from './types.ts';

export const WAITING_INTERVAL_MS = 5 * 60 * 1000;
export const PRESENCE_INTERVAL_MS = 10 * 60 * 1000;

export function humanRequests(member: SessionMember): readonly RequestRef[] {
  // 子代理的 user 角色常是自动派活。包括旧缓存，只有明确真人标记才可计入活动。
  const refs = member.humanRequestRefs ?? (member.requestRefs?.latest ? [member.requestRefs.latest] : []);
  return member.parentSessionId ? refs.filter(ref => ref.explicitHuman === true) : refs;
}
export function waitingReady(member: SessionMember, evidenceAt: string, now: string): boolean {
  const evidence = Date.parse(evidenceAt);
  return Date.parse(now) - evidence >= WAITING_INTERVAL_MS
    && !humanRequests(member).some(ref => Date.parse(ref.at) > evidence && Date.parse(ref.at) <= Date.parse(now));
}
/** 路由在新卡片落盘前决定；旧卡无此字段时仍按原有级别投递。 */
export function routeNotice(notice: Notice, projection: Projection, now: string): Notice {
  if (notice.delivery) return notice;
  const time = Date.parse(now);
  let last: RequestRef | undefined;
  for (const record of projection.sessions.values()) for (const member of membersOf(record)) for (const ref of humanRequests(member)) {
    if (Date.parse(ref.at) <= time && (!last || Date.parse(ref.at) > Date.parse(last.at))) last = ref;
  }
  const present = !!last && time - Date.parse(last.at) <= PRESENCE_INTERVAL_MS;
  return { ...notice, delivery: { presence: present ? '在场' : '不在场',
    channels: notice.level === '有空看' ? ['feishu'] : present ? ['local'] : ['local', 'feishu'],
    decidedAt: now, ...(last ? { lastHumanAt: last.at } : {}) } };
}
/** 首次看到的下一句，按卡片目标成员关联；在会话变化时追加引用，原卡/原文不改。 */
export function nextNoticeReplies(projection: Projection): { noticeId: string; reply: RequestRef }[] {
  return projection.notices.flatMap(notice => {
    if (!notice.snapshot || !notice.sessionKey || projection.noticeReplies.has(notice.id)) return [];
    const record = projection.sessions.get(notice.sessionKey);
    const member = record && membersOf(record).find(m => m.sessionId === (notice.memberSessionId ?? record.sessionId));
    if (!member || member.unavailable) return [];
    let reply: RequestRef | undefined;
    for (const ref of humanRequests(member)) {
      if (Date.parse(ref.at) > Date.parse(notice.at) && (!reply || Date.parse(ref.at) < Date.parse(reply.at))) reply = ref;
    }
    return reply ? [{ noticeId: notice.id, reply: { ...reply, sessionId: member.sessionId } }] : [];
  });
}
