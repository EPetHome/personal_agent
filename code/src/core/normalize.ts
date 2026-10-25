import type { Perception } from './perception.ts';
import type { SessionRecord } from './types.ts';
import { memberSnapshot } from './sessions.ts';

/** 子代理归入父会话；其系统任务不是用户后来追加的要求。 */
export function normalize(input: Perception): Perception {
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
      health?.errors.push(`子代理 ${record.originals[0]?.path} 缺少父会话或父子关系成环`);
      continue;
    }
    parent.members ??= [memberSnapshot(parent)];
    parent.members.push(memberSnapshot(record));
    parent.originals.push(...record.originals);
    parent.lastActivityAt = parent.lastActivityAt > record.lastActivityAt ? parent.lastActivityAt : record.lastActivityAt;
    parent.pendingTools.push(...record.pendingTools);
    parent.recentSteps.push(...record.recentSteps);
    if (record.pendingTools.length) parent.assistantFinished = false;
  }
  for (const record of roots) {
    record.recentSteps.sort((a, b) => a.at.localeCompare(b.at));
    record.recentSteps = record.recentSteps.slice(-8);
  }
  return { ...input, records: roots };
}
