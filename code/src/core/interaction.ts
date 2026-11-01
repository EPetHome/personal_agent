import { membersOf, pushMatchesMember } from './sessions.ts';
import { isRedline } from './action-items.ts';
import { hash } from './utils.ts';
import { DEFAULT_WAITING } from './types.ts';
import type { Config, ModelFinding, Notice, Projection, RequestRef, SessionMember, SessionRecord, Step, WaitingDecision } from './types.ts';

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
/** 模型候选与等候锁存必须选择同一份有效钩子；旧的 push 时间仍是事实/去重身份。 */
export function latestMemberPush(record: SessionRecord, member: SessionMember, projection: Projection, now: string) {
  return projection.pushes.filter(push => push.recordKey === record.key && pushMatchesMember(push, member) && push.at <= now
    && member.lastActivityAt !== null && push.at >= member.lastActivityAt)
    .sort((a, b) => a.at.localeCompare(b.at) || ['waiting_permission', 'turn_end', 'session_end'].indexOf(a.event)
      - ['waiting_permission', 'turn_end', 'session_end'].indexOf(b.event)).at(-1);
}
export function waitingEvidenceAt(record: SessionRecord, member: SessionMember, push?: { at: string }): string {
  // Pi 自动返修 user 消息可晚于停下；其他来源及已有钩子保持原事实身份。
  return push?.at ?? (record.tool === 'pi' ? member.assistantReply?.at : undefined) ?? member.lastActivityAt!;
}
export function waitingActivityKey(record: SessionRecord, member: SessionMember): string {
  return JSON.stringify([record.key, member.sessionId]);
}
/** 停下时间固定本次等候的分类；后续去过别的会话便锁存，不用发卡时的十分钟在场窗口。 */
export function decideWaiting(record: SessionRecord, member: SessionMember, evidenceAt: string, projection: Projection,
  config: Config, now: string, output = '', permission = false): WaitingDecision {
  const settings = { ...DEFAULT_WAITING, ...config.waiting }, evidence = Date.parse(evidenceAt), time = Date.parse(now);
  const refs = humanRequests(member), last = refs.filter(ref => Date.parse(ref.at) <= evidence).reduce<RequestRef | undefined>((last, ref) =>
    !last || Date.parse(ref.at) > Date.parse(last.at) ? ref : last, undefined);
  const activeConversation = !!last && evidence - Date.parse(last.at) < settings.activeConversationMinutes * 60000;
  const replied = refs.some(ref => Date.parse(ref.at) > evidence && Date.parse(ref.at) <= time);
  const previous = projection.waitingActivity.get(waitingActivityKey(record, member));
  let otherHumanAt = previous?.evidenceAt === evidenceAt && Date.parse(previous.otherHumanAt) <= time ? previous.otherHumanAt : undefined;
  for (const other of projection.sessions.values()) {
    if (other.tool === 'loop') continue; // loop 摘要复用开发会话要求，不是另一次真人发言。
    for (const candidate of membersOf(other)) {
      if (other.tool === record.tool && candidate.sessionId === member.sessionId) continue;
      for (const ref of humanRequests(candidate)) if (Date.parse(ref.at) > evidence && Date.parse(ref.at) <= time
        && (!otherHumanAt || Date.parse(ref.at) < Date.parse(otherHumanAt))) otherHumanAt = ref.at;
    }
  }
  const redline = permission || isRedline(output);
  const intervalMs = (redline ? 0 : !activeConversation ? settings.inactiveMinutes
    : otherHumanAt ? settings.otherSessionMinutes : settings.awayMinutes) * 60000;
  return { evidenceAt, activeConversation, state: replied ? 'replied' : otherHumanAt ? 'other_session'
    : activeConversation && time - evidence < intervalMs ? 'same_session' : 'away', intervalMs,
    ready: !replied && time - evidence >= intervalMs, redline, ...(otherHumanAt ? { otherHumanAt } : {}) };
}
/** 同轮到点合并本机弹窗，逐事实保留卡片、反馈和重试身份；红线不被普通等候裹住。 */
export function batchWaitingNotices(notices: Notice[]): Notice[] {
  const waiting = notices.filter(n => n.kind === 'waiting' && n.waitingDecision && !n.waitingDecision.redline && n.delivery?.channels.includes('local'));
  if (!waiting.length) return notices;
  const entries = waiting.map(n => ({ noticeId: n.id, sessionId: n.memberSessionId!, project: n.content.evidence.project ?? '', returnCommand: n.content.returnCommand }));
  const batch = { id: hash(JSON.stringify(entries.map(e => e.noticeId).sort())),
    title: waiting.some(n => n.waitingDecision!.otherHumanAt) ? '还有会话在等你' : '有会话在等你', entries };
  return notices.map(n => waiting.includes(n) && (waiting.length > 1 || n.waitingDecision!.otherHumanAt) ? { ...n, localBatch: batch } : n);
}
/** 跑偏从核验引文的实际步骤计时，不用最后活动或模型返回时间代替；旧判断按引文追溯。 */
export function driftTrigger(record: SessionRecord, finding: ModelFinding, step?: Step): { at: string; sessionId: string } {
  if (finding.triggerStep) return finding.triggerStep;
  const members = membersOf(record).filter(member => finding.key !== `drift:${record.key}:${finding.sessionId}` || member.sessionId === finding.sessionId);
  const matches = members.flatMap(member => member.recentSteps
    .filter(candidate => step ? candidate.at === step.at && candidate.text === step.text
      : !!finding.result.stepQuote && candidate.text.includes(finding.result.stepQuote))
    .map(candidate => ({ at: candidate.at, sessionId: member.sessionId }))).sort((a, b) => a.at.localeCompare(b.at));
  return matches.at(-1) ?? { at: finding.evidenceAt, sessionId: finding.sessionId };
}
/** 仅新卡片选择出口；只有普通等待按跨会话活动分流，旧决定一律原样保留。 */
export function routeNotice(notice: Notice, projection: Projection, now: string): Notice {
  if (notice.delivery) return notice;
  const time = Date.parse(now);
  let last: RequestRef | undefined;
  for (const record of projection.sessions.values()) for (const member of membersOf(record)) for (const ref of humanRequests(member)) {
    if (Date.parse(ref.at) <= time && (!last || Date.parse(ref.at) > Date.parse(last.at))) last = ref;
  }
  const present = !!last && time - Date.parse(last.at) <= PRESENCE_INTERVAL_MS;
  return { ...notice, delivery: { presence: present ? '在场' : '不在场',
    channels: notice.level === '有空看' ? ['feishu']
      : notice.kind === 'waiting' && notice.waitingDecision?.otherHumanAt && !notice.waitingDecision.redline ? ['local'] : ['local', 'feishu'],
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
