import { join } from 'node:path';
import { fileChannel } from '../channels/file/index.ts';
import { isIgnoredProject, validateConfig } from './config.ts';
import { event, project, pushIdentity } from './events.ts';
import { skipAnomaly } from './health.ts';
import { judgeRecords, planNotices } from './judge.ts';
import { normalize } from './normalize.ts';
import { perceive } from './perception.ts';
import { findPushTarget, isFailedOriginal, isIgnoredMember } from './sessions.ts';
import { appendJsonl, readEvents, withStoreLock, writeState } from './store.ts';
import { iso } from './utils.ts';
import type { AgentEvent, Config, EventPayload, JudgedRecord, Projection } from './types.ts';

export interface Snapshot { at: string; records: JudgedRecord[]; projection: Projection }
function activeProjection(projection: Projection, config: Config): Projection {
  const sessions = new Map([...projection.sessions].filter(([, record]) => {
    if (config.sources[record.tool] === null || isIgnoredProject(record.project, config)) return false;
    const health = projection.health.get(record.tool);
    // 整体故障时保留最后事实并标失明；局部故障不能让坏文件的旧状态冒充本轮正常。
    return health?.errors.length || !health?.sessionKeys || health.sessionKeys.includes(record.key);
  }).map(([key, record]) => {
    const members = record.members?.filter(member => !isIgnoredMember(member, record.members!, config));
    if (!members || members.length === record.members?.length) return [key, record];
    return [key, {
      ...record, members, originals: members.flatMap(member => member.originals),
      recentSteps: members.flatMap(member => member.recentSteps).sort((a, b) => a.at.localeCompare(b.at)).slice(-8),
      pendingTools: members.flatMap(member => member.pendingTools),
      lastActivityAt: members.reduce((last, member) => member.lastActivityAt !== null && member.lastActivityAt > last ? member.lastActivityAt : last, members[0]!.lastActivityAt ?? record.lastActivityAt),
    }];
  }));
  const pushes = projection.pushes.filter(push => config.sources[push.tool] !== null
    && !isIgnoredProject(push.project, config) && findPushTarget(sessions.values(), push));
  const waitingKeys = new Set(pushes.map(push => `waiting:${push.recordKey}:${pushIdentity(push)}`));
  return {
    ...projection, sessions, pushes,
    health: new Map([...projection.health].filter(([source]) => source === 'inbox' ? config.inboxDir !== null : config.sources[source] !== null)),
    notices: projection.notices.filter(notice => (notice.tool === 'inbox' ? config.inboxDir !== null : config.sources[notice.tool] !== null)
      && (!notice.sessionKey || sessions.has(notice.sessionKey))
      && (notice.kind !== 'waiting' || waitingKeys.has(notice.dedupeKey))
      && (!notice.content.evidence.project || !isIgnoredProject(notice.content.evidence.project, config))),
  };
}
function snapshot(events: AgentEvent[], config: Config, now?: string): Snapshot {
  const projection = activeProjection(project(events), config);
  const at = iso(now ?? projection.lastScanAt ?? new Date().toISOString());
  const records = judgeRecords(projection, at);
  planNotices(records, projection, config, at);
  // 查询不投递；只有交付确认事件才算已发，其余候选明确标为待写发件。
  return { at, records, projection };
}
function serializedState(view: Snapshot) {
  return { version: 1, at: view.at, records: view.records, health: [...view.projection.health.values()] };
}
export async function detect(configInput: Config, currentTime = new Date().toISOString()) {
  const config = await validateConfig(configInput);
  const now = iso(currentTime, '当前时间');
  return withStoreLock(config.dataDir, async () => {
    const events = await readEvents(config.dataDir);
    const previous = project(events);
    const input = normalize(await perceive(config), previous.sessions.values(), config);
    const available = new Map([...previous.sessions, ...input.records.map(r => [r.key, r] as const)]);
    const added: AgentEvent[] = [];
    const add = (payload: EventPayload) => { added.push(event(payload, now)); };
    for (const record of input.records) {
      if (JSON.stringify(previous.sessions.get(record.key)) !== JSON.stringify(record)) add({ kind: 'session_observed', record });
    }
    const ids = new Set(events.map(e => e.id));
    for (const push of input.pushes) {
      const entry = event({ kind: 'push_observed', push }, now);
      if (!ids.has(entry.id)) { added.push(entry); ids.add(entry.id); }
      // 原件/目录/归并本轮已失败：仅留原始推送，不借缓存成员对账，也不放大局部故障。
      if (isFailedOriginal(push.tool, push.transcriptPath, input.failedPaths)) continue;
      const record = findPushTarget(available.values(), push, true);
      if (!record) {
        const report = input.health.find(h => h.source === push.tool);
        report?.errors.push(`${push.original.path}：第 ${push.original.line} 行推送与已读取会话对不上；未跟随 transcript_path 读取其他文件`);
        continue;
      }
      const validated = event({ kind: 'push_validated', pushId: entry.id, recordKey: record.key }, now);
      if (!ids.has(validated.id)) { added.push(validated); ids.add(validated.id); }
    }
    for (const cursor of input.cursors) {
      if (cursor.kind !== 'push_cursor') continue;
      const previousCursor = events.findLast(e => e.kind === 'push_cursor' && e.path === cursor.path);
      if (!previousCursor || previousCursor.kind !== 'push_cursor' || previousCursor.lines !== cursor.lines || previousCursor.fingerprint !== cursor.fingerprint) add(cursor);
    }
    for (const report of input.health) {
      const last = previous.health.get(report.source);
      const anomaly = skipAnomaly(report, last?.skipBaseline);
      if (anomaly) report.errors.push(anomaly);
      if (!last || JSON.stringify([last.errors, last.paths, last.fileFailures, last.sessionKeys, last.fileStats]) !== JSON.stringify([report.errors, report.paths, report.fileFailures, report.sessionKeys, report.fileStats])) add({ kind: 'source_health', report });
    }
    add({ kind: 'scan_completed' });
    const projection = activeProjection(project([...events, ...added]), config);
    const records = judgeRecords(projection, now);
    const suppressed: EventPayload[] = [];
    const planned = planNotices(records, projection, config, now, suppressed);
    for (const decision of suppressed) add(decision);
    for (const notice of planned) add({ kind: 'notice_planned', notice });
    // 先把决策写进只追加的事件，再幂等投递；进程中断后下一轮补齐，不重复写发件。
    await appendJsonl(join(config.dataDir, 'events.jsonl'), added);
    const complete = activeProjection(project([...events, ...added]), config);
    const noticesAdded = await fileChannel(config.dataDir).send(complete.notices);
    const unconfirmed = complete.notices.filter(notice => !complete.deliveredNoticeIds.has(notice.id)).map(notice => notice.id);
    if (unconfirmed.length) {
      const confirmation = event({ kind: 'notices_delivered', ids: unconfirmed }, now);
      await appendJsonl(join(config.dataDir, 'events.jsonl'), [confirmation]);
      added.push(confirmation);
    }
    const view = snapshot([...events, ...added], config, now);
    await writeState(config.dataDir, serializedState(view));
    return { ...view, noticesAdded };
  });
}
export async function overview(configInput: Config, now?: string): Promise<Snapshot> {
  const config = await validateConfig(configInput);
  return snapshot(await readEvents(config.dataDir), config, now);
}
export async function rebuild(configInput: Config, now?: string): Promise<Snapshot> {
  const config = await validateConfig(configInput);
  return withStoreLock(config.dataDir, async () => {
    const view = snapshot(await readEvents(config.dataDir), config, now);
    await writeState(config.dataDir, serializedState(view));
    return view;
  });
}
