import { join } from 'node:path';
import { fileChannel } from '../channels/file/index.ts';
import { localChannel } from '../channels/local/index.ts';
import { applyModelChecks, checkModels } from './model-checks.ts';
import { isIgnoredProject, validateConfig } from './config.ts';
import { event, project, pushIdentity } from './events.ts';
import { skipAnomaly } from './health.ts';
import { judgeRecords, planNotices } from './judge.ts';
import { normalize } from './normalize.ts';
import { perceive } from './perception.ts';
import { findPushTarget, isFailedOriginal, isIgnoredMember, membersOf } from './sessions.ts';
import { appendJsonl, readEvents, readOutbox, withModelLock, withStoreLock, writeState } from './store.ts';
import { iso } from './utils.ts';
import type { AgentEvent, Channel, Config, EventPayload, Judge, JudgedRecord, Projection } from './types.ts';

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
      && (!notice.memberSessionId || (!!notice.sessionKey && membersOf(sessions.get(notice.sessionKey)!).some(member => member.sessionId === notice.memberSessionId)))
      && (notice.kind !== 'waiting' || notice.dedupeKey.startsWith('model_waiting:') || waitingKeys.has(notice.dedupeKey))
      && (!notice.content.evidence.project || !isIgnoredProject(notice.content.evidence.project, config))),
  };
}
function snapshot(events: AgentEvent[], config: Config, now?: string): Snapshot {
  const projection = activeProjection(project(events), config);
  const at = iso(now ?? projection.lastScanAt ?? new Date().toISOString());
  const records = judgeRecords(projection, at);
  applyModelChecks(records, projection, config, at);
  planNotices(records, projection, config, at);
  // 查询不投递；只有交付确认事件才算已发，其余候选明确标为待写发件。
  return { at, records, projection };
}
function serializedState(view: Snapshot) {
  return { version: 1, at: view.at, records: view.records, health: [...view.projection.health.values()] };
}
/** 必须在数据锁内调用：决策先落盘，文件幂等交付，再分别确认外部渠道。 */
async function settle(config: Config, events: AgentEvent[], added: AgentEvent[], now: string, channels: Channel[], attempted: Set<string>) {
  const previous = project(events);
  const projection = activeProjection(project([...events, ...added]), config);
  // 模型等待期间可能已有另一轮感知，不能用旧时间/旧会话覆盖新事实。
  const at = projection.lastScanAt && projection.lastScanAt > now ? projection.lastScanAt : now;
  const add = (payload: EventPayload) => { added.push(event(payload, at)); };
  const records = judgeRecords(projection, at);
  applyModelChecks(records, projection, config, at);
  const suppressed: EventPayload[] = [];
  const planned = planNotices(records, projection, config, at, suppressed);
  for (const decision of suppressed) add(decision);
  for (const notice of planned) add({ kind: 'notice_planned', notice });
  const queued = activeProjection(project([...events, ...added]), config);
  for (const channel of channels) for (const notice of queued.notices) {
    if (notice.level !== '现在就要你') continue;
    const key = `${channel.name}:${notice.id}`;
    if (!queued.channelDeliveries.has(key) && !previous.deliveredNoticeIds.has(notice.id)) add({ kind: 'channel_delivery', channel: channel.name, noticeId: notice.id, ok: false });
  }
  let written = 0;
  const flush = async () => {
    await appendJsonl(join(config.dataDir, 'events.jsonl'), added.slice(written));
    written = added.length;
  };
  await flush();
  const complete = activeProjection(project([...events, ...added]), config);
  const known = new Set((await readOutbox(config.dataDir)).map(n => n.id));
  const file = fileChannel(config.dataDir);
  let noticesAdded = 0;
  for (const notice of complete.notices) {
    await file.send(notice);
    if (!known.has(notice.id)) { noticesAdded++; known.add(notice.id); }
  }
  for (const channel of channels) for (const notice of complete.notices) {
    const key = `${channel.name}:${notice.id}`;
    if (notice.level !== '现在就要你' || complete.channelDeliveries.get(key) !== false || attempted.has(key)) continue;
    attempted.add(key);
    let ok = true;
    try { await channel.send(notice); } catch { ok = false; }
    add({ kind: 'channel_delivery', channel: channel.name, noticeId: notice.id, ok });
    await flush();
  }
  const unconfirmed = complete.notices.filter(notice => !complete.deliveredNoticeIds.has(notice.id)).map(notice => notice.id);
  if (unconfirmed.length) { add({ kind: 'notices_delivered', ids: unconfirmed }); await flush(); }
  const view = snapshot([...events, ...added], config, at);
  await writeState(config.dataDir, serializedState(view));
  return { ...view, noticesAdded };
}
export async function detect(configInput: Config, currentTime = new Date().toISOString(), components: { judge?: Judge; channels?: Channel[] } = {}) {
  const config = await validateConfig(configInput);
  const now = iso(currentTime, '当前时间');
  const channels = components.channels ?? (config.localChannel ? [localChannel(config.dataDir, config.localChannel)] : []);
  const attempted = new Set<string>();
  const ruleView = await withStoreLock(config.dataDir, async () => {
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
    // 授权等待等已确定提醒先交付并写当前状态，绝不等待其他会话的模型。
    return settle(config, events, added, now, channels, attempted);
  });
  if (!config.judge) return ruleView;
  const modelView = await withModelLock(config.dataDir, async () => {
    const projection = await withStoreLock(config.dataDir, async () => activeProjection(project(await readEvents(config.dataDir)), config));
    const records = judgeRecords(projection, now);
    const changed = await checkModels(records, projection, config, now, payload => withStoreLock(config.dataDir, async () => {
      if (payload.kind === 'model_call_started') {
        // 短锁内按最新日志原子预留；不能拿模型阶段开始时的旧额度覆盖并发用量。
        const used = project(await readEvents(config.dataDir)).modelCalls.get(now.slice(0, 10)) ?? 0;
        if (used >= config.judge!.dailyLimit) return false;
      }
      await appendJsonl(join(config.dataDir, 'events.jsonl'), [event(payload, now)]);
      return true;
    }), components.judge);
    if (!changed) return null;
    return withStoreLock(config.dataDir, async () => settle(config, await readEvents(config.dataDir), [], now, channels, attempted));
  });
  return modelView ? { ...modelView, noticesAdded: ruleView.noticesAdded + modelView.noticesAdded } : ruleView;
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
