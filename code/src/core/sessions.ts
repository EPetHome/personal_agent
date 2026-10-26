import { dirname } from 'node:path';
import { isIgnoredProject } from './config.ts';
import type { Config, PushRecord, SessionIdentity, SessionMember, SessionRecord } from './types.ts';

export function isIgnoredMember(member: SessionIdentity, peers: readonly SessionIdentity[], config: Config): boolean {
  const seen = new Set<string>();
  let current: SessionIdentity | undefined = member;
  while (current && !seen.has(current.sessionId)) {
    if (isIgnoredProject(current.project, config)) return true;
    seen.add(current.sessionId);
    const parentId: string | undefined = current.parentSessionId;
    if (!parentId) break;
    current = peers.find(peer => peer.sessionId === parentId);
  }
  return false;
}

/** 文件或其目录本轮失败；只比较已配置来源产生的路径，不读取推送所指原件。 */
export function isFailedOriginal(tool: SessionRecord['tool'], path: string, failedPaths: ReadonlySet<string>): boolean {
  for (let current = path; ; current = dirname(current)) {
    if (failedPaths.has(`${tool}:${current}`)) return true;
    if (dirname(current) === current) return false;
  }
}
export function membersOf(record: SessionRecord): readonly SessionMember[] {
  return record.members?.length ? record.members : [record];
}
export function memberSnapshot(record: SessionRecord): SessionMember {
  const { sessionId, project, originals, lastActivityAt, recentSteps, pendingTools, assistantFinished, sessionEnded, assistantReply, parentSessionId, unavailable } = record;
  return structuredClone({
    sessionId, project, originals, lastActivityAt, recentSteps, pendingTools, assistantFinished, sessionEnded,
    ...(assistantReply === undefined ? {} : { assistantReply }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(unavailable === undefined ? {} : { unavailable }),
  });
}
export function pushMatchesMember(push: PushRecord, member: SessionMember): boolean {
  return member.sessionId === push.sessionId && member.project === push.project &&
    member.originals.some(original => original.path === push.transcriptPath);
}
/** 新对账必须 requireReadable；历史已验证推送仍可定位缓存成员，以保留先前等待。 */
export function findPushTarget(records: Iterable<SessionRecord>, push: PushRecord, requireReadable = false): SessionRecord | undefined {
  const matches = [...records].filter(record => record.tool === push.tool
    && membersOf(record).some(member => (!requireReadable || (!member.unavailable && member.lastActivityAt !== null)) && pushMatchesMember(push, member)));
  return matches.length === 1 ? matches[0] : undefined;
}
