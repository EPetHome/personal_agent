import { isAbsolute, join, relative } from 'node:path';
import { fileChannel } from '../channels/file/index.ts';
import { accepts, configuredChannels } from '../channels/index.ts';
import { maintain } from './maintenance.ts';
import type { ExperienceModel } from './learning.ts';
import { applyModelChecks, checkModels } from './model-checks.ts';
import { isIgnoredProject, validateConfig } from './config.ts';
import { event, project, pushIdentity } from './events.ts';
import { skipAnomaly } from './health.ts';
import { feedbackSuppressions, isFeedbackSuppressed, readFeedback } from './feedback.ts';
import { judgeRecords, planNotices } from './judge.ts';
import { normalize } from './normalize.ts';
import { perceive } from './perception.ts';
import { findPushTarget, isFailedOriginal, isIgnoredMember, isInternalSession, membersOf } from './sessions.ts';
import { appendJsonl, readEvents, readOutbox, withModelLock, withStoreLock, writeState } from './store.ts';
import { iso } from './utils.ts';
import type { AgentEvent, Channel, Config, EventPayload, Judge, JudgedRecord, Notice, Projection } from './types.ts';

export interface Snapshot { at: string; records: JudgedRecord[]; projection: Projection }
function activeProjection(projection: Projection, config: Config): Projection {
  const sessions = new Map([...projection.sessions].filter(([, record]) => {
    if (config.sources[record.tool] === null || isIgnoredProject(record.project, config) || isInternalSession(record.tool, record.sessionId, record.project)) return false;
    const health = projection.health.get(record.tool);
    // 整体故障时保留最后事实并标失明；局部故障不能让坏文件的旧状态冒充本轮正常。
    return health?.errors.length || !health?.sessionKeys || health.sessionKeys.includes(record.key);
  }).map(([key, record]) => {
    const members = record.members?.filter(member => !isIgnoredMember(member, record.members!, config, record.tool));
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
    feishuConnection: config.feishu ? projection.feishuConnection ?? { state: config.feishu.mode === 'fake' ? 'fake' : 'stopped', at: projection.lastScanAt ?? '' } : undefined,
    health: new Map([...projection.health].filter(([source]) => source === 'inbox' ? config.inboxDir !== null : config.sources[source] !== null)),
    notices: projection.notices.filter(notice => (notice.tool === 'agent' || (notice.tool === 'inbox' ? config.inboxDir !== null : config.sources[notice.tool] !== null))
      && (notice.kind !== 'blind' || (notice.tool !== 'agent' && !!projection.health.get(notice.tool)?.since
        && notice.dedupeKey === `blind:${notice.tool}:${projection.health.get(notice.tool)?.episodeId}`))
      && (notice.kind !== 'unreadable' || (notice.tool !== 'agent' && !!projection.health.get(notice.tool)?.fileFailures?.count
        && notice.dedupeKey === `unreadable:${notice.tool}:${projection.health.get(notice.tool)?.fileFailureEpisodeId}`))
      && (!notice.sessionKey || sessions.has(notice.sessionKey))
      && (!notice.memberSessionId || (!!notice.sessionKey && membersOf(sessions.get(notice.sessionKey)!).some(member => member.sessionId === notice.memberSessionId)))
      && (notice.kind !== 'waiting' || notice.dedupeKey.startsWith('model_waiting:') || waitingKeys.has(notice.dedupeKey))
      && (!notice.content.evidence.project || !isIgnoredProject(notice.content.evidence.project, config))),
  };
}
async function feedbackProjection(projection: Projection, config: Config, at: string): Promise<Projection> {
  // 发件包含旧版未带新字段的记录；事件投影有追溯到的成员/事实身份，优先使用后者。
  const notices = new Map((await readOutbox(config.dataDir)).map(n => [n.id, n]));
  for (const notice of projection.notices) notices.set(notice.id, notice);
  const rows = await readFeedback(config.dataDir);
  // 检测的 now 是开轮时刻；开轮后收到的反馈也必须马上生效，不等下一轮。
  const boundary = rows.reduce((last, row) => row.at > last ? row.at : last, at);
  return { ...projection, feedbackSuppressions: feedbackSuppressions(rows, [...notices.values()], boundary) };
}
async function snapshot(events: AgentEvent[], config: Config, now?: string): Promise<Snapshot> {
  const raw = project(events);
  const at = iso(now ?? raw.lastScanAt ?? new Date().toISOString());
  const projection = activeProjection(await feedbackProjection(raw, config, at), config);
  const records = judgeRecords(projection, at);
  applyModelChecks(records, projection, config, at);
  planNotices(records, projection, config, at);
  // 查询不投递；只有交付确认事件才算已发，其余候选明确标为待写发件。
  return { at, records, projection };
}
function serializedState(view: Snapshot) {
  return { version: 1, at: view.at, records: view.records, health: [...view.projection.health.values()], ...(view.projection.feishuConnection ? { feishuConnection: view.projection.feishuConnection } : {}) };
}
/** 必须在数据锁内调用：决策先落盘，文件幂等交付，再分别确认外部渠道。 */
async function settle(config: Config, events: AgentEvent[], added: AgentEvent[], now: string, channels: Channel[], attempted: Set<string>) {
  const previous = project(events);
  const raw = project([...events, ...added]);
  // 模型等待期间可能已有另一轮感知/反馈，不能用旧时间/旧会话覆盖新事实。
  const at = raw.lastScanAt && raw.lastScanAt > now ? raw.lastScanAt : now;
  const projection = activeProjection(await feedbackProjection(raw, config, at), config);
  const add = (payload: EventPayload) => { added.push(event(payload, at)); };
  const records = judgeRecords(projection, at);
  applyModelChecks(records, projection, config, at);
  const suppressed: EventPayload[] = [];
  const planned = planNotices(records, projection, config, at, suppressed);
  for (const decision of suppressed) add(decision);
  for (const notice of planned) add({ kind: 'notice_planned', notice });
  const queued = activeProjection(project([...events, ...added]), config);
  for (const channel of channels) for (const notice of queued.notices) {
    if (!accepts(channel, notice) || isFeedbackSuppressed(notice, projection.feedbackSuppressions)) continue;
    const key = `${channel.name}:${notice.id}`;
    if (!queued.channelDeliveries.has(key) && !previous.deliveredNoticeIds.has(notice.id)) add({ kind: 'channel_delivery', channel: channel.name, noticeId: notice.id, ok: false });
  }
  let written = 0;
  const flush = async () => {
    await appendJsonl(join(config.dataDir, 'events.jsonl'), added.slice(written));
    written = added.length;
  };
  await flush();
  const completeRaw = project([...events, ...added]);
  const complete = activeProjection(await feedbackProjection(completeRaw, config, at), config);
  const deliverable = complete.notices.filter(n => !isFeedbackSuppressed(n, complete.feedbackSuppressions));
  const outbox = await readOutbox(config.dataDir), lookup = new Map(outbox.map(n => [n.id, n]));
  for (const notice of completeRaw.notices) lookup.set(notice.id, notice);
  const suppressionNotices = [...lookup.values()];
  // 外部发送可能很慢，每笔真实投递前短读反馈；不为已交付历史逐条重放事件/读写日志。
  const canDeliver = async (notice: Notice) => {
    const rows = await readFeedback(config.dataDir), boundary = rows.reduce((last, row) => row.at > last ? row.at : last, at);
    return !isFeedbackSuppressed(notice, feedbackSuppressions(rows, suppressionNotices, boundary));
  };
  const known = new Set(outbox.map(n => n.id));
  const file = fileChannel(config.dataDir);
  let noticesAdded = 0;
  for (const notice of deliverable) {
    if (known.has(notice.id) || !await canDeliver(notice)) continue;
    await file.send(notice);
    if (!known.has(notice.id)) { noticesAdded++; known.add(notice.id); }
  }
  for (const channel of channels) for (const notice of deliverable) {
    const key = `${channel.name}:${notice.id}`;
    if (!accepts(channel, notice) || complete.channelDeliveries.get(key) !== false || attempted.has(key)) continue;
    if (!await canDeliver(notice)) continue;
    attempted.add(key);
    let ok = true;
    try { await channel.send(notice); } catch { ok = false; }
    add({ kind: 'channel_delivery', channel: channel.name, noticeId: notice.id, ok });
    await flush();
  }
  const unconfirmed = deliverable.filter(notice => known.has(notice.id) && !complete.deliveredNoticeIds.has(notice.id)).map(notice => notice.id);
  if (unconfirmed.length) { add({ kind: 'notices_delivered', ids: unconfirmed }); await flush(); }
  const view = await snapshot([...events, ...added], config, at);
  await writeState(config.dataDir, serializedState(view));
  return { ...view, noticesAdded };
}
export async function publishNotices(config: Config, notices: Notice[], now: string, channels = configuredChannels(config), attempted = new Set<string>()) {
  return withStoreLock(config.dataDir, async () => {
    const events = await readEvents(config.dataDir), known = new Set(project(events).notices.map(n => n.id));
    const added = notices.filter(n => !known.has(n.id)).map(notice => event({ kind: 'notice_planned', notice }, now));
    return settle(config, events, added, now, channels, attempted);
  });
}
export async function detect(configInput: Config, currentTime = new Date().toISOString(), components: { judge?: Judge; channels?: Channel[]; experienceModel?: ExperienceModel } = {}) {
  const config = await validateConfig(configInput);
  const now = iso(currentTime, '当前时间');
  const channels = components.channels ?? configuredChannels(config);
  const attempted = new Set<string>();
  let modelDeadline = Infinity;
  const finish = async (view: Snapshot & { noticesAdded: number }) => {
    for (const channel of channels) if ('drain' in channel && typeof channel.drain === 'function') await channel.drain(now);
    // 归因与普通判断共用单轮模型预算，避免常驻被两段各60秒串行拖住。
    const maintenanceConfig = config.judge ? { ...config, judge: { ...config.judge, cycleTimeoutMs: Math.max(0, modelDeadline - Date.now()) } } : config;
    const supplemental = await maintain(maintenanceConfig, now, components.experienceModel);
    if (!supplemental.length) return view;
    const settled = await publishNotices(config, supplemental, now, channels, attempted);
    return { ...settled, noticesAdded: view.noticesAdded + settled.noticesAdded };
  };
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
    const seenSessions = new Set(previous.seenSessions);
    for (const record of input.records) for (const member of membersOf(record)) seenSessions.add(`${record.tool}:${member.sessionId}`);
    for (const identity of input.seenSessions) {
      const key = `${identity.tool}:${identity.sessionId}`;
      if (!seenSessions.has(key)) { add({ kind: 'session_seen', ...identity }); seenSessions.add(key); }
    }
    const ids = new Set(events.map(e => e.id));
    const emptyPushes = new Set(events.flatMap(e => e.kind === 'push_empty' ? [e.pushId] : []));
    const observedPushes = new Set(events.flatMap(e => e.kind === 'push_observed' ? [event({ kind: 'push_observed', push: e.push }, now).id] : []));
    const unhealthySources = new Set(input.health.filter(report => report.errors.length).map(report => report.source));
    const deferred = new Map(events.flatMap(e => e.kind === 'push_deferred' ? [[e.pushId, e.rounds] as const] : []));
    for (const push of input.pushes) {
      const entry = event({ kind: 'push_observed', push }, now);
      if (!ids.has(entry.id)) { added.push(entry); ids.add(entry.id); }
      // 原件/目录/归并本轮已失败：仅留原始推送，不借缓存成员对账，也不放大局部故障。
      const unwritten = input.unwrittenPaths.has(`${push.tool}:${push.transcriptPath}`);
      if (!unwritten && isFailedOriginal(push.tool, push.transcriptPath, input.failedPaths)) continue;
      const record = unwritten ? undefined : findPushTarget(input.records, push, true);
      if (!record) {
        const report = input.health.find(h => h.source === push.tool);
        const root = config.sources[push.tool];
        const path = root ? relative(root, push.transcriptPath) : '..';
        const conflicting = [...available.values()].filter(r => r.tool === push.tool).flatMap(membersOf)
          .some(m => (m.sessionId === push.sessionId && !m.originals.some(o => o.path === push.transcriptPath))
            || (m.sessionId !== push.sessionId && m.originals.some(o => o.path === push.transcriptPath)));
        // 身份/路径冲突仍立即报；仅目录尚未写到文件时，也按推送早到给最多两轮。
        const canDefer = path && path !== '..' && !path.startsWith('../') && !isAbsolute(path) && !conflicting && !unhealthySources.has(push.tool);
        if (canDefer && (deferred.get(entry.id) ?? 0) < 2) {
          add({ kind: 'push_deferred', pushId: entry.id, rounds: (deferred.get(entry.id) ?? 0) + 1 });
          continue;
        }
        if (canDefer && push.event === 'session_end' && push.transcriptPath.endsWith('.jsonl')
          && !seenSessions.has(`${push.tool}:${push.sessionId}`) && !input.presentPaths.has(`${push.tool}:${push.transcriptPath}`)) {
          if (!emptyPushes.has(entry.id)) {
            add({ kind: 'push_empty', pushId: entry.id, reason: '空会话：会话结束推送；从未在会话文件读到此身份；两轮宽限后文件仍不存在，不生成会话或提醒' });
            emptyPushes.add(entry.id);
          }
          continue;
        }
        report?.errors.push(`${push.original.path}：第 ${push.original.line} 行推送与已读取会话对不上；未跟随 transcript_path 读取其他文件`);
        if (report && (report.affectedSessions?.length ?? 0) < 3 && !report.affectedSessions?.some(s => s.sessionId === push.sessionId)) {
          const known = [...available.values()].find(r => r.tool === push.tool && membersOf(r).some(m => m.sessionId === push.sessionId));
          (report.affectedSessions ??= []).push({ sessionId: push.sessionId, project: push.project, intentOriginal: known?.intent.initial ?? null });
        }
        continue;
      }
      const recovered = observedPushes.has(entry.id) && previous.health.get(push.tool)?.errors.some(error =>
        error.startsWith(`${push.original.path}：第 ${push.original.line} 行推送与已读取会话对不上`));
      const validated = event({ kind: 'push_validated', pushId: entry.id, recordKey: record.key, ...(recovered ? { recovered: true } : {}) }, now);
      if (!ids.has(validated.id)) { added.push(validated); ids.add(validated.id); }
    }
    for (const cursor of input.cursors) {
      if (cursor.kind !== 'push_cursor') continue;
      const previousCursor = events.findLast(e => e.kind === 'push_cursor' && e.path === cursor.path);
      if (!previousCursor || previousCursor.kind !== 'push_cursor' || previousCursor.lines !== cursor.lines || previousCursor.fingerprint !== cursor.fingerprint) add(cursor);
    }
    for (const report of input.health) {
      const last = previous.health.get(report.source);
      const anomaly = skipAnomaly(report, last);
      if (anomaly) report.errors.push(anomaly);
      if (!last || JSON.stringify([last.errors, last.paths, last.fileFailures, last.sessionKeys, last.fileStats, last.fileStatsProfile, last.affectedSessions]) !== JSON.stringify([report.errors, report.paths, report.fileFailures, report.sessionKeys, report.fileStats, report.fileStatsProfile, report.affectedSessions])) add({ kind: 'source_health', report });
    }
    add({ kind: 'scan_completed' });
    // 授权等待等已确定提醒先交付并写当前状态，绝不等待其他会话的模型。
    return settle(config, events, added, now, channels, attempted);
  });
  if (!config.judge) return finish(ruleView);
  modelDeadline = Date.now() + (config.judge.cycleTimeoutMs ?? 60000);
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
  return finish(modelView ? { ...modelView, noticesAdded: ruleView.noticesAdded + modelView.noticesAdded } : ruleView);
}
export async function overview(configInput: Config, now?: string): Promise<Snapshot> {
  const config = await validateConfig(configInput);
  return snapshot(await readEvents(config.dataDir), config, now);
}
export async function rebuild(configInput: Config, now?: string): Promise<Snapshot> {
  const config = await validateConfig(configInput);
  return withStoreLock(config.dataDir, async () => {
    const view = await snapshot(await readEvents(config.dataDir), config, now);
    await writeState(config.dataDir, serializedState(view));
    return view;
  });
}
