import type { Perception } from './perception.ts';
import type { Config, SessionIdentity, SessionMember, SessionRecord, Tool } from './types.ts';
import { isFailedOriginal, isIgnoredMember, membersOf, memberSnapshot } from './sessions.ts';
import { coreUnavailable, unreadable } from './health.ts';

function appendMember(parent: SessionRecord, member: SessionMember): void {
  parent.members ??= [memberSnapshot(parent)];
  parent.members.push(member);
  parent.originals.push(...member.originals);
  if (member.lastActivityAt !== null && member.lastActivityAt > parent.lastActivityAt) parent.lastActivityAt = member.lastActivityAt;
  parent.pendingTools.push(...member.pendingTools);
  parent.recentSteps.push(...member.recentSteps);
  if (member.pendingTools.length || member.unavailable) parent.assistantFinished = false;
}
/** 只解析关联，终点必须是本轮完整读到的根；身份线索不能生成根会话。 */
function identifiedRoot(tool: Tool, identity: SessionIdentity, identities: ReadonlyMap<string, SessionIdentity>, records: ReadonlyMap<string, SessionRecord>): SessionRecord | undefined {
  let current: SessionIdentity | undefined = identity;
  const seen = new Set<string>();
  while (current) {
    const key = `${tool}:${current.sessionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!current.parentSessionId) {
      const root = records.get(key);
      return root && !root.parentSessionId ? root : undefined;
    }
    current = identities.get(`${tool}:${current.parentSessionId}`);
  }
}
/** 子代理归入父会话；局部失败保留已知关联，但缓存事实不能证明当前已完成。 */
export function normalize(input: Perception, previous: Iterable<SessionRecord> = [], config?: Config): Perception {
  const records = new Map<string, SessionRecord>();
  for (const record of input.records) {
    const previous = records.get(record.key);
    if (!previous) records.set(record.key, structuredClone(record));
    else {
      const latest = previous.lastActivityAt > record.lastActivityAt ? previous : structuredClone(record);
      latest.originals = [...previous.originals, ...record.originals];
      records.set(record.key, latest);
    }
  }
  const roots: SessionRecord[] = [];
  const unresolved: SessionRecord[] = [];
  for (const record of records.values()) {
    if (!record.parentSessionId) { roots.push(record); continue; }
    let parent = record;
    const seen = new Set<string>();
    while (parent.parentSessionId && !seen.has(parent.key)) {
      seen.add(parent.key);
      const next = records.get(`${parent.tool}:${parent.parentSessionId}`);
      if (!next) break;
      parent = next;
    }
    if (parent.parentSessionId) {
      const health = input.health.find(h => h.source === record.tool);
      if (health) unreadable(health, `子代理 ${record.originals[0]?.path} 缺少父会话或父子关系成环`);
      for (const original of record.originals) input.failedPaths.add(`${record.tool}:${original.path}`);
      unresolved.push(record);
      continue;
    }
    appendMember(parent, memberSnapshot(record));
  }
  const previousByKey = new Map([...previous].map(record => [record.key, record] as const));
  const identities = new Map<string, SessionIdentity>();
  for (const failure of input.failedSessions) identities.set(`${failure.tool}:${failure.sessionId}`, failure);
  for (const record of records.values()) identities.set(record.key, record);
  for (const failure of input.failedSessions) {
    const root = identifiedRoot(failure.tool, failure, identities, records);
    if (!root || membersOf(root).some(member => member.sessionId === failure.sessionId)) continue;
    const cached = previousByKey.get(root.key);
    const previousMember = cached && membersOf(cached).find(member => member.sessionId === failure.sessionId
      && member.project === failure.project && member.originals.some(original => original.path === failure.original.path));
    // 正文失败只保留可靠身份；有历史事实则沿用，否则活动时间未知，不能取损坏正文的前缀。
    const member: SessionMember = previousMember ? { ...structuredClone(previousMember), parentSessionId: failure.parentSessionId,
      ...(previousMember.lastActivityAt === null ? { originals: [failure.original] } : {}), unavailable: true } : {
      sessionId: failure.sessionId, project: failure.project, parentSessionId: failure.parentSessionId,
      originals: [failure.original], lastActivityAt: null, recentSteps: [], pendingTools: [],
      assistantFinished: false, sessionEnded: false, unavailable: true,
    };
    appendMember(root, member);
  }
  for (const record of unresolved) {
    const root = identifiedRoot(record.tool, record, identities, records);
    if (root && !membersOf(root).some(member => member.sessionId === record.sessionId)) {
      // 经失败祖先身份才能关联的成员也保持不确定；其新推送仍由 failedPaths 隔离。
      appendMember(root, { ...memberSnapshot(record), unavailable: true });
    }
  }
  for (const record of roots) {
    const cached = previousByKey.get(record.key);
    if (cached) {
      const cachedMembers = membersOf(cached);
      const currentIds = new Set(membersOf(record).map(member => member.sessionId));
      for (const member of cachedMembers) {
        if (currentIds.has(member.sessionId) || !member.originals.some(original => isFailedOriginal(record.tool, original.path, input.failedPaths))
          || (config && isIgnoredMember(member, cachedMembers, config))) continue;
        // 只给本轮仍读到的根保留失败子成员；不复活旧根，也不把缓存当成新读到的事实。
        appendMember(record, { ...structuredClone(member), unavailable: true });
        currentIds.add(member.sessionId);
      }
    }
    record.recentSteps.sort((a, b) => a.at.localeCompare(b.at));
    record.recentSteps = record.recentSteps.slice(-8);
  }
  for (const health of input.health) {
    if (health.source === 'inbox') continue;
    health.sessionKeys = roots.filter(record => record.tool === health.source).map(record => record.key).sort();
    if (!health.sessionKeys.length && input.records.some(record => record.tool === health.source) && health.fileFailures?.count) coreUnavailable(health);
  }
  return { ...input, records: roots };
}
