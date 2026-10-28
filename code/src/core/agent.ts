import { isAbsolute, join, relative } from 'node:path';
import { fileChannel } from '../channels/file/index.ts';
import { accepts, configuredChannels } from '../channels/index.ts';
import { maintain } from './maintenance.ts';
import type { ExperienceModel } from './learning.ts';
import { applyModelChecks, checkModels } from './model-checks.ts';
import { checkSnapshotModels } from './snapshot-model.ts';
import { noticeSnapshotKey, standaloneSnapshot } from './task-snapshot.ts';
import { nextNoticeReplies, routeNotice } from './interaction.ts';
import { isIgnoredProject, validateConfig } from './config.ts';
import { event, project, pushIdentity } from './events.ts';
import { isMemberScopedDriftNotice } from './evidence.ts';
import { prepareEventLog } from './event-archive.ts';
import { sessionDelta } from './session-delta.ts';
import { skipAnomaly } from './health.ts';
import { feedbackSuppressions, isFeedbackSuppressed, readFeedback } from './feedback.ts';
import { judgeRecords, planNotices } from './judge.ts';
import { normalize } from './normalize.ts';
import { perceive } from './perception.ts';
import { findPushTarget, isFailedOriginal, isIgnoredMember, isInternalSession, membersOf, mismatchedMemberIds } from './sessions.ts';
import { appendJsonl, readEvents, readOutbox, withModelLock, withStoreLock, writeState } from './store.ts';
import { iso } from './utils.ts';
import type { AgentEvent, Channel, Config, EventPayload, Judge, JudgedRecord, Notice, Projection } from './types.ts';

export interface Snapshot { at: string; records: JudgedRecord[]; projection: Projection }
function activeProjection(projection: Projection, config: Config): Projection {
  const pushMismatches = new Map([...projection.pushMismatches].filter(([, mismatch]) => config.inboxDir !== null
    && config.sources[mismatch.push.tool] !== null && !isIgnoredProject(mismatch.push.project, config)
    && !isInternalSession(mismatch.push.tool, mismatch.push.sessionId, mismatch.push.project)));
  const sessions = new Map([...projection.sessions].filter(([, record]) => {
    if (config.sources[record.tool] === null || isIgnoredProject(record.project, config) || isInternalSession(record.tool, record.sessionId, record.project)) return false;
    const health = projection.health.get(record.tool);
    // 整体故障时保留最后事实并标失明；局部故障不能让坏文件的旧状态冒充本轮正常。
    return health?.errors.length || !health?.sessionKeys || health.sessionKeys.includes(record.key)
      || [...pushMismatches.values()].some(m => m.recordKey === record.key);
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
  const localDriftScopes = new Map([...sessions].map(([key, record]) => [key, mismatchedMemberIds(record, { pushMismatches })] as const)
    .filter(([, ids]) => ids.size));
  return {
    ...projection, sessions, pushes, pushMismatches,
    snapshotSessions: new Map([...projection.sessions].filter(([, r]) => config.sources[r.tool] !== null
      && !isIgnoredProject(r.project, config) && !isInternalSession(r.tool, r.sessionId, r.project))),
    feishuConnection: config.feishu ? projection.feishuConnection ?? { state: config.feishu.mode === 'fake' ? 'fake' : 'stopped', at: projection.lastScanAt ?? '' } : undefined,
    health: new Map([...projection.health].filter(([source]) => source === 'inbox' ? config.inboxDir !== null : config.sources[source] !== null)),
    notices: projection.notices.filter(notice => (notice.tool === 'agent' || (notice.tool === 'inbox' ? config.inboxDir !== null : config.sources[notice.tool] !== null))
      && (notice.kind !== 'blind' || (notice.dedupeKey.startsWith('blind:push:')
        ? [...pushMismatches.values()].some(m => notice.dedupeKey === `blind:push:${m.push.tool}:${m.push.sessionId}:${m.episodeId}`)
        : notice.tool !== 'agent' && !!projection.health.get(notice.tool)?.since
          && notice.dedupeKey === `blind:${notice.tool}:${projection.health.get(notice.tool)?.episodeId}`))
      && (notice.kind !== 'unreadable' || (notice.tool !== 'agent' && !!projection.health.get(notice.tool)?.fileFailures?.count
        && notice.dedupeKey === `unreadable:${notice.tool}:${projection.health.get(notice.tool)?.fileFailureEpisodeId}`))
      && (!notice.sessionKey || sessions.has(notice.sessionKey))
      // 局部故障下不重试旧组级跑偏卡，也不借健康成员的新结论复用它的错误快照。
      && (notice.kind !== 'drift' || !notice.sessionKey || !localDriftScopes.has(notice.sessionKey)
        || (isMemberScopedDriftNotice(notice) && !localDriftScopes.get(notice.sessionKey)!.has(notice.memberSessionId!)))
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
  return { version: 1, at: view.at, records: view.records, health: [...view.projection.health.values()],
    ...(view.projection.pushMismatches.size ? { pushMismatches: [...view.projection.pushMismatches.values()] } : {}), ...(view.projection.feishuConnection ? { feishuConnection: view.projection.feishuConnection } : {}) };
}
/** 必须在数据锁内调用：决策先落盘，文件幂等交付，再分别确认外部渠道。 */
async function settle(config: Config, events: AgentEvent[], added: AgentEvent[], now: string, channels: Channel[], attempted: Set<string>, deferSnapshots = false) {
  const previous = project(events);
  const raw = project([...events, ...added]);
  // 模型等待期间可能已有另一轮感知/反馈，不能用旧时间/旧会话覆盖新事实。
  const at = raw.lastScanAt && raw.lastScanAt > now ? raw.lastScanAt : now;
  const projection = activeProjection(await feedbackProjection(raw, config, at), config);
  const add = (payload: EventPayload) => { added.push(event(payload, at)); };
  for (const reply of nextNoticeReplies(projection)) add({ kind: 'notice_reply_observed', ...reply });
  // supplemental 通知也走同一分流；历史卡片（缺字段）绝不重新计划或改变出口。
  for (const entry of added) if (entry.kind === 'notice_planned') entry.notice = routeNotice(entry.notice, projection, at);
  const records = judgeRecords(projection, at);
  applyModelChecks(records, projection, config, at);
  const suppressed: EventPayload[] = [];
  const planned = planNotices(records, projection, config, at, suppressed).filter(n => !deferSnapshots || !standaloneSnapshot(n)
    || projection.noticeSnapshots.has(noticeSnapshotKey(n)));
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
    const events = await prepareEventLog(config.dataDir, now), known = new Set(project(events).notices.map(n => n.id));
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
  const deferSnapshots = !!config.judge && (!components.judge || !!components.judge.writeSnapshot);
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
    const events = await prepareEventLog(config.dataDir, now);
    const previous = project(events);
    const input = normalize(await perceive(config), previous.sessions.values(), config);
    const available = new Map([...previous.sessions, ...input.records.map(r => [r.key, r] as const)]);
    const added: AgentEvent[] = [];
    const add = (payload: EventPayload) => { added.push(event(payload, now)); };
    for (const record of input.records) {
      const delta = sessionDelta(previous.sessions.get(record.key), record);
      if (delta) add({ kind: 'session_delta', delta });
    }
    const seenSessions = new Set(previous.seenSessions);
    for (const record of input.records) for (const member of membersOf(record)) seenSessions.add(`${record.tool}:${member.sessionId}`);
    for (const identity of input.seenSessions) {
      const key = `${identity.tool}:${identity.sessionId}`;
      if (!seenSessions.has(key)) { add({ kind: 'session_seen', ...identity }); seenSessions.add(key); }
    }
    const ids = new Set([...previous.rawPushes.keys(), ...previous.validatedPushIds]);
    const emptyPushes = previous.emptyPushIds;
    const observedPushes = new Set([...previous.rawPushes.values()].map(push => event({ kind: 'push_observed', push }, now).id));
    const unhealthySources = new Set(input.health.filter(report => report.errors.length).map(report => report.source));
    const deferred = previous.deferredPushes;
    const mismatches = new Map<string, Extract<EventPayload, { kind: 'push_mismatches' }>['mismatches'][number]>();
    for (const push of input.pushes) {
      const entry = event({ kind: 'push_observed', push }, now);
      if (!ids.has(entry.id)) { added.push(entry); ids.add(entry.id); }
      // 原件/目录/归并本轮已失败：仅留原始推送，不借缓存成员对账，也不放大局部故障。
      const transcriptKey = `${push.tool}:${push.transcriptPath}`;
      const unwritten = input.unwrittenPaths.has(transcriptKey);
      if (!unwritten && isFailedOriginal(push.tool, push.transcriptPath, input.failedPaths)) continue;
      const record = unwritten ? undefined : findPushTarget(input.records, push, true);
      if (!record) {
        const root = config.sources[push.tool];
        const path = root ? relative(root, push.transcriptPath) : '..';
        const knownMembers = [...available.values()].filter(r => r.tool === push.tool).flatMap(membersOf);
        const conflicting = knownMembers.some(m => (m.sessionId === push.sessionId && !m.originals.some(o => o.path === push.transcriptPath))
          || (m.sessionId !== push.sessionId && m.originals.some(o => o.path === push.transcriptPath)));
        // 身份/路径冲突仍立即报；仅目录尚未写到文件时，也按推送早到给最多两轮。
        const canDefer = path && path !== '..' && !path.startsWith('../') && !isAbsolute(path) && !conflicting && !unhealthySources.has(push.tool);
        if (canDefer && (deferred.get(entry.id) ?? 0) < 2) {
          add({ kind: 'push_deferred', pushId: entry.id, rounds: (deferred.get(entry.id) ?? 0) + 1 });
          continue;
        }
        // 元数据里的身份不等于读过真实会话；但已有对话/子成员的历史不能被空文件抹掉。
        const knownSession = knownMembers.some(m => m.sessionId === push.sessionId || m.originals.some(o => o.path === push.transcriptPath));
        const emptyReason = input.emptyPaths.has(transcriptKey) && !knownSession
          ? '两轮宽限后文件存在，但完整校验后只有元数据/噪音、没有核心消息'
          : !seenSessions.has(`${push.tool}:${push.sessionId}`) && !input.presentPaths.has(transcriptKey)
            ? '从未在会话文件读到此身份；两轮宽限后文件仍不存在' : null;
        if (canDefer && push.event === 'session_end' && push.transcriptPath.endsWith('.jsonl') && emptyReason) {
          if (!emptyPushes.has(entry.id)) {
            add({ kind: 'push_empty', pushId: entry.id, reason: `空会话，放过：会话结束推送；${emptyReason}；不生成会话或提醒` });
            emptyPushes.add(entry.id);
          }
          continue;
        }
        const known = [...available.values()].find(r => r.tool === push.tool && membersOf(r).some(m => m.sessionId === push.sessionId));
        mismatches.set(entry.id, { pushId: entry.id, ...(known ? { recordKey: known.key } : {}),
          reason: `${push.original.path}：第 ${push.original.line} 行推送与已读取会话对不上；未跟随 transcript_path 读取其他文件` });
        continue;
      }
      const recovered = observedPushes.has(entry.id) && (previous.pushMismatches.has(entry.id) || previous.health.get(push.tool)?.errors.some(error =>
        error.startsWith(`${push.original.path}：第 ${push.original.line} 行推送与已读取会话对不上`)));
      const validated = event({ kind: 'push_validated', pushId: entry.id, recordKey: record.key, ...(recovered ? { recovered: true } : {}) }, now);
      if (!ids.has(validated.id)) { added.push(validated); ids.add(validated.id); }
    }
    const previousMismatches = [...previous.pushMismatches.values()].map(({ pushId, recordKey, reason }) => ({ pushId, ...(recordKey ? { recordKey } : {}), reason }));
    const mismatchRows = [...mismatches.values()];
    if (JSON.stringify(previousMismatches) !== JSON.stringify(mismatchRows)) add({ kind: 'push_mismatches', mismatches: mismatchRows });
    for (const cursor of input.cursors) {
      if (cursor.kind !== 'push_cursor') continue;
      const previousCursor = previous.pushCursors.get(cursor.path);
      if (!previousCursor || previousCursor.kind !== 'push_cursor' || previousCursor.lines !== cursor.lines || previousCursor.fingerprint !== cursor.fingerprint) add(cursor);
    }
    for (const report of input.health) {
      const last = previous.health.get(report.source);
      const anomaly = skipAnomaly(report, last);
      if (anomaly) report.errors.push(anomaly);
      if (!last || JSON.stringify([last.errors, last.paths, last.fileFailures, last.sessionKeys, last.fileStats, last.fileStatsProfile, last.affectedSessions]) !== JSON.stringify([report.errors, report.paths, report.fileFailures, report.sessionKeys, report.fileStats, report.fileStatsProfile, report.affectedSessions])) add({ kind: 'source_health', report });
    }
    add({ kind: 'scan_completed' });
    // 已过等候间隔的授权等待等确定提醒先交付，绝不等待其他会话的模型。
    return settle(config, events, added, now, channels, attempted, deferSnapshots);
  });
  if (!config.judge) return finish(ruleView);
  modelDeadline = Date.now() + (config.judge.cycleTimeoutMs ?? 60000);
  const modelView = await withModelLock(config.dataDir, async () => {
    const load = () => withStoreLock(config.dataDir, async () => activeProjection(await feedbackProjection(project(await readEvents(config.dataDir)), config, now), config));
    let projection = await load();
    let records = judgeRecords(projection, now);
    applyModelChecks(records, projection, config, now);
    const pending = planNotices(records, projection, config, now);
    const persist = (payload: EventPayload) => withStoreLock(config.dataDir, async () => {
      if (payload.kind === 'model_call_started') {
        // 短锁内按最新日志原子预留；不能拿模型阶段开始时的旧额度覆盖并发用量。
        const used = project(await readEvents(config.dataDir)).modelCalls.get(now.slice(0, 10)) ?? 0;
        if (used >= config.judge!.dailyLimit) return false;
      }
      await appendJsonl(join(config.dataDir, 'events.jsonl'), [event(payload, now)]);
      return true;
    });
    const snapshots = await checkSnapshotModels(pending, projection, config, now, persist, components.judge, modelDeadline);
    const early = snapshots ? await withStoreLock(config.dataDir, async () => settle(config, await readEvents(config.dataDir), [], now, channels, attempted, true)) : null;
    projection = await load();
    records = judgeRecords(projection, now);
    const remainingConfig = { ...config, judge: { ...config.judge!, cycleTimeoutMs: Math.max(0, modelDeadline - Date.now()) } };
    const changed = await checkModels(records, projection, remainingConfig, now, persist, components.judge);
    if (!changed) return early;
    const final = await withStoreLock(config.dataDir, async () => settle(config, await readEvents(config.dataDir), [], now, channels, attempted));
    return { ...final, noticesAdded: (early?.noticesAdded ?? 0) + final.noticesAdded };
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
    const at = now ?? project(await readEvents(config.dataDir)).lastScanAt ?? new Date().toISOString();
    const view = await snapshot(await prepareEventLog(config.dataDir, at), config, now);
    await writeState(config.dataDir, serializedState(view));
    return view;
  });
}
