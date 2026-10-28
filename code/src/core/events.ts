import { randomUUID } from 'node:crypto';
import { hash } from './utils.ts';
import { indexModelEvidence, restoreModelEvidence } from './evidence.ts';
import { findPushTarget, membersOf } from './sessions.ts';
import { learnSkipBaseline } from './health.ts';
import { applySessionDelta } from './session-delta.ts';
import type { AgentEvent, EventPayload, Projection, ProjectionState, PushRecord } from './types.ts';

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
function emptyProjection(): Projection {
  return { sessions: new Map(), seenSessions: new Set(), pushes: [], rawPushes: new Map(), validatedPushIds: new Set(),
    emptyPushIds: new Set(), deferredPushes: new Map(), pushCursors: new Map(), pushMismatches: new Map(), legacyChecks: new Map(),
    health: new Map(), notices: [], deliveredNoticeIds: new Set(), lastScanAt: null, startedAt: null, suppressedNotices: new Map(),
    modelChecks: new Map(), modelEvidence: new Map(), noticeSnapshots: new Map(), noticeReplies: new Map(), feedbackSuppressions: new Set(),
    modelCalls: new Map(), channelDeliveries: new Map() };
}
export function packProjection(projection: Projection): ProjectionState {
  return Object.fromEntries(Object.entries(projection).filter(([key]) => key !== 'snapshotSessions').map(([key, value]) =>
    [key, value instanceof Map || value instanceof Set ? [...value] : value])) as ProjectionState;
}
export function unpackProjection(state: ProjectionState): Projection {
  const result = emptyProjection();
  if (!state || typeof state !== 'object') throw new Error('封存状态结构损坏');
  for (const [key, initial] of Object.entries(result)) {
    const value = (state as any)[key];
    if (initial instanceof Map || initial instanceof Set || Array.isArray(initial)) {
      if (!Array.isArray(value)) throw new Error(`封存状态 ${key} 结构损坏`);
      (result as any)[key] = initial instanceof Map ? new Map(value) : initial instanceof Set ? new Set(value) : [...value];
    } else {
      if (value !== null && typeof value !== 'string') throw new Error(`封存状态 ${key} 结构损坏`);
      (result as any)[key] = value;
    }
  }
  if (state.feishuConnection) result.feishuConnection = state.feishuConnection;
  result.modelEvidence = restoreModelEvidence(result);
  return result;
}
export function project(events: AgentEvent[]): Projection {
  // 检查点仅允许位于活动日志首行，防止差量在错误/缺失基底上继续运行。
  const checkpoint = events[0]?.kind === 'store_checkpoint' ? events[0] : undefined;
  const result = checkpoint ? unpackProjection(checkpoint.state) : emptyProjection();
  const checksByFingerprint = result.legacyChecks, rawPushes = result.rawPushes, pushes = result.validatedPushIds;
  const notices = new Set(result.notices.map(n => n.id));
  for (const entry of events.slice(checkpoint ? 1 : 0)) {
    switch (entry.kind) {
      case 'store_checkpoint': throw new Error('封存状态不在活动日志首行');
      case 'store_format': break;
      case 'session_delta': {
        const record = applySessionDelta(result.sessions.get(entry.delta.key), entry.delta);
        result.sessions.set(record.key, record);
        for (const member of membersOf(record)) result.seenSessions.add(`${record.tool}:${member.sessionId}`);
        break;
      }
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
      case 'push_mismatches': {
        const previous = new Map(result.pushMismatches);
        result.pushMismatches.clear();
        for (const mismatch of entry.mismatches) {
          const push = rawPushes.get(mismatch.pushId);
          if (!push) throw new Error('推送对账故障缺少原始推送');
          const last = previous.get(mismatch.pushId) ?? [...previous.values(), ...result.pushMismatches.values()]
            .find(m => m.push.tool === push.tool && m.push.sessionId === push.sessionId);
          result.pushMismatches.set(mismatch.pushId, { ...mismatch, push, since: last?.since ?? entry.at, episodeId: last?.episodeId ?? entry.id });
        }
        break;
      }
      case 'push_deferred': result.deferredPushes.set(entry.pushId, entry.rounds); break;
      case 'source_health': {
        const previous = result.health.get(entry.report.source);
        const since = entry.report.errors.length ? previous?.since ?? entry.at : null;
        const episodeId = since ? previous?.episodeId ?? entry.id : null;
        const fileFailureSince = entry.report.fileFailures?.count ? previous?.fileFailureSince ?? entry.at : null;
        const fileFailureEpisodeId = fileFailureSince ? previous?.fileFailureEpisodeId ?? entry.id : null;
        const skipBaseline = learnSkipBaseline(entry.report, previous);
        result.health.set(entry.report.source, { ...entry.report, since, episodeId, fileFailureSince, fileFailureEpisodeId, ...(skipBaseline !== undefined ? { skipBaseline } : {}) });
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
        indexModelEvidence(result.modelEvidence, check);
        checksByFingerprint.set(`${check.recordKey}:${check.fingerprint}`, check);
        break;
      }
      case 'notice_snapshot_written': result.noticeSnapshots.set(entry.key, entry.snapshot); break;
      case 'notice_reply_observed':
        if (!result.noticeReplies.has(entry.noticeId)) result.noticeReplies.set(entry.noticeId, entry.reply);
        break;
      case 'channel_delivery': result.channelDeliveries.set(`${entry.channel}:${entry.noticeId}`, entry.ok); break;
      case 'feishu_connection': result.feishuConnection = { ...entry.connection, at: entry.at }; break;
      case 'push_empty': result.emptyPushIds.add(entry.pushId); break;
      case 'push_cursor': result.pushCursors.set(entry.path, entry); break;
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
