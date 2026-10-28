import { randomUUID } from 'node:crypto';
import { hash } from './utils.ts';
import { modelEvidenceKey } from './evidence.ts';
import { findPushTarget, membersOf } from './sessions.ts';
import { learnSkipBaseline } from './health.ts';
import type { AgentEvent, EventPayload, Projection, PushRecord } from './types.ts';

export function pushIdentity(push: PushRecord): string {
  return hash(JSON.stringify([push.tool, push.sessionId, push.event, push.at, push.detail]));
}
export function event(payload: EventPayload, at: string): AgentEvent {
  let id: string = randomUUID();
  if (payload.kind === 'push_observed') {
    // 原始事实身份包含对账字段，修正路径/项目的新事件不能被旧坏事件去重掉。
    id = `push:bound:${hash(JSON.stringify([pushIdentity(payload.push), payload.push.project, payload.push.transcriptPath]))}`;
  } else if (payload.kind === 'push_validated') id = `validated:${payload.pushId}:${payload.recordKey}`;
  return { ...payload, version: 1, at, id };
}
export function project(events: AgentEvent[]): Projection {
  const result: Projection = { sessions: new Map(), seenSessions: new Set(), pushes: [], health: new Map(), notices: [], deliveredNoticeIds: new Set(), lastScanAt: null, startedAt: null, suppressedNotices: new Map(), modelChecks: new Map(), modelEvidence: new Map(), noticeSnapshots: new Map(), noticeReplies: new Map(), feedbackSuppressions: new Set(), modelCalls: new Map(), channelDeliveries: new Map() };
  const checksByFingerprint = new Map<string, import('./types.ts').ModelCheck>();
  const rawPushes = new Map<string, PushRecord>();
  const pushes = new Set<string>();
  const notices = new Set<string>();
  for (const entry of events) {
    switch (entry.kind) {
      case 'session_observed':
        result.sessions.set(entry.record.key, entry.record);
        for (const member of membersOf(entry.record)) result.seenSessions.add(`${entry.record.tool}:${member.sessionId}`);
        break;
      case 'session_seen': result.seenSessions.add(`${entry.tool}:${entry.sessionId}`); break;
      case 'push_observed':
        // 包括旧日志在内，收到推送本身不证明它可用于判断。
        if (!rawPushes.has(entry.id)) rawPushes.set(entry.id, entry.push);
        break;
      case 'push_validated': {
        const push = rawPushes.get(entry.pushId);
        const record = result.sessions.get(entry.recordKey);
        if (push && record && findPushTarget([record], push, true) && !pushes.has(entry.id)) {
          result.pushes.push({ ...push, recordKey: entry.recordKey, ...(entry.recovered ? { recovered: true } : {}) });
          pushes.add(entry.id);
        }
        break;
      }
      case 'source_health': {
        const previous = result.health.get(entry.report.source);
        const since = entry.report.errors.length ? previous?.since ?? entry.at : null;
        const episodeId = since ? previous?.episodeId ?? entry.id : null;
        const fileFailureSince = entry.report.fileFailures?.count ? previous?.fileFailureSince ?? entry.at : null;
        const fileFailureEpisodeId = fileFailureSince ? previous?.fileFailureEpisodeId ?? entry.id : null;
        const skipBaseline = learnSkipBaseline(entry.report, previous);
        result.health.set(entry.report.source, { ...entry.report, since, episodeId, fileFailureSince, fileFailureEpisodeId, skipBaseline });
        break;
      }
      case 'scan_completed':
        result.startedAt ??= entry.at;
        result.lastScanAt = entry.at;
        break;
      case 'notice_suppressed':
        result.suppressedNotices.set(entry.dedupeKey, entry.evidenceAt);
        break;
      case 'notice_planned':
        if (!notices.has(entry.notice.id)) { result.notices.push(entry.notice); notices.add(entry.notice.id); }
        break;
      case 'notices_delivered':
        for (const id of entry.ids) result.deliveredNoticeIds.add(id);
        break;
      case 'model_call_started': {
        const day = entry.at.slice(0, 10);
        result.modelCalls.set(day, (result.modelCalls.get(day) ?? 0) + 1);
        break;
      }
      case 'model_checked': {
        const check = entry.check;
        result.modelChecks.set(check.key, check);
        const evidenceKey = modelEvidenceKey(check), previous = result.modelEvidence.get(evidenceKey);
        // 旧版可能因提取变化再次调用失败；失败不能抹掉同一事实已有的成功答案。
        if ((!check.error && check.result) || !previous?.result || previous.error) result.modelEvidence.set(evidenceKey, check);
        checksByFingerprint.set(`${check.recordKey}:${check.fingerprint}`, check);
        break;
      }
      case 'notice_snapshot_written': result.noticeSnapshots.set(entry.key, entry.snapshot); break;
      case 'notice_reply_observed':
        if (!result.noticeReplies.has(entry.noticeId)) result.noticeReplies.set(entry.noticeId, entry.reply);
        break;
      case 'channel_delivery': result.channelDeliveries.set(`${entry.channel}:${entry.noticeId}`, entry.ok); break;
      case 'feishu_connection': result.feishuConnection = { ...entry.connection, at: entry.at }; break;
      case 'push_empty':
      case 'push_cursor': break;
    }
  }
  // 老版提醒把提取指纹放在去重键里。只在投影中追溯其事实身份，磁盘原件不动。
  result.notices = result.notices.map(notice => {
    if (notice.evidenceAt || !notice.sessionKey) return notice;
    if (notice.dedupeKey.startsWith('waiting:')) {
      const push = result.pushes.find(p => p.recordKey === notice.sessionKey && notice.dedupeKey === `waiting:${p.recordKey}:${pushIdentity(p)}`);
      return push ? { ...notice, evidenceAt: push.at, memberSessionId: push.sessionId } : notice;
    }
    if (!/^(?:model_waiting|drift):/.test(notice.dedupeKey)) return notice;
    const fingerprint = notice.dedupeKey.slice(notice.dedupeKey.lastIndexOf(':') + 1);
    const check = checksByFingerprint.get(`${notice.sessionKey}:${fingerprint}`);
    return check ? { ...notice, evidenceAt: check.evidenceAt, memberSessionId: check.sessionId } : notice;
  });
  result.notices = result.notices.map(notice => {
    const reply = result.noticeReplies.get(notice.id);
    return reply && notice.snapshot ? { ...notice, snapshot: { ...notice.snapshot, nextHumanReply: reply } } : notice;
  });
  return result;
}
