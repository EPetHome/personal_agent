import type { PushRecord, SessionMember, SessionRecord } from './types.ts';

export function membersOf(record: SessionRecord): readonly SessionMember[] {
  return record.members?.length ? record.members : [record];
}
export function memberSnapshot(record: SessionRecord): SessionMember {
  const { sessionId, project, originals, lastActivityAt, recentSteps, pendingTools, assistantFinished, sessionEnded } = record;
  return structuredClone({ sessionId, project, originals, lastActivityAt, recentSteps, pendingTools, assistantFinished, sessionEnded });
}
export function pushMatchesMember(push: PushRecord, member: SessionMember): boolean {
  return member.sessionId === push.sessionId && member.project === push.project &&
    member.originals.some(original => original.path === push.transcriptPath);
}
/** 对账必须命中实际成员的原件，不能只匹配父记录聚合后的路径集合。 */
export function findPushTarget(records: Iterable<SessionRecord>, push: PushRecord): SessionRecord | undefined {
  const matches = [...records].filter(record => record.tool === push.tool && membersOf(record).some(member => pushMatchesMember(push, member)));
  return matches.length === 1 ? matches[0] : undefined;
}
