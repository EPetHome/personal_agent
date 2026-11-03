import { join } from 'node:path';
import { fileChannel } from '../channels/file/index.ts';
import { accepts, configuredChannels } from '../channels/index.ts';
import { localAlert, reportStorageFailure, withStorageAlerts } from './alerts.ts';
import { channelName, MAX_CHANNEL_FAILURES, undeliveredNotices } from './delivery.ts';
import { safeDeliveryFailure } from './failures.ts';
import { checkSnapshotModels } from './snapshot-model.ts';
import { noticeSnapshotKey, standaloneSnapshot } from './task-snapshot.ts';
import { routeNotice } from './interaction.ts';
import { isIgnoredProject, validateConfig } from './config.ts';
import { event, project } from './events.ts';
import { prepareDeliveryLog } from './event-archive.ts';
import { sessionDelta } from './session-delta.ts';
import { skipAnomaly } from './health.ts';
import { feedbackSuppressions, isFeedbackSuppressed, readFeedback } from './feedback.ts';
import { isActiveNotice, judgeRecords, planNotices } from './judge.ts';
import { normalize } from './normalize.ts';
import { perceive } from './perception.ts';
import { appendJsonl, readEvents, readOutbox, withModelLock, withStoreLock, writeState } from './store.ts';
import { iso } from './utils.ts';
import { codeVersion } from './runtime-version.ts';
import type { AgentEvent, Channel, Config, EventPayload, Judge, JudgedRecord, Notice, Projection } from './types.ts';

export interface Snapshot { at: string; eventId: string | null; records: JudgedRecord[]; projection: Projection }
function detectionLock<T>(config: Config, operation: () => Promise<T>): Promise<T> {
  return withStoreLock(config.dataDir, operation);
}
function activeProjection(projection: Projection, config: Config): Projection {
  // 历史聊天事实只保留在原日志里，不参加总览、重试、健康判断或模型候选。
  const visible = (record: JudgedRecord | import('./types.ts').SessionRecord) => record.tool === 'loop'
    && config.sources.loop !== null && !isIgnoredProject(record.project, config);
  const sessions = new Map([...projection.sessions].filter(([, record]) => {
    const health = projection.health.get('loop');
    return visible(record) && (health?.errors.length || !health?.sessionKeys || health.sessionKeys.includes(record.key));
  }));
  return {
    ...projection, sessions, pushes: [], pushMismatches: new Map(),
    snapshotSessions: new Map([...projection.sessions].filter(([, record]) => visible(record))),
    feishuConnection: config.feishu ? projection.feishuConnection ?? { state: config.feishu.mode === 'fake' ? 'fake' : 'stopped', at: projection.lastScanAt ?? '' } : undefined,
    health: new Map([...projection.health].filter(([source]) => source === 'loop' && config.sources.loop !== null)),
    notices: projection.notices.filter(notice => isActiveNotice(notice)
      && (notice.tool === 'agent' || config.sources.loop !== null)
      && (notice.kind !== 'blind' || notice.dedupeKey === `blind:loop:${projection.health.get('loop')?.episodeId}`)
      && (notice.kind !== 'unreadable' || notice.dedupeKey === `unreadable:loop:${projection.health.get('loop')?.fileFailureEpisodeId}`)
      && (!notice.sessionKey || sessions.has(notice.sessionKey))
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
  planNotices(records, projection, config, at);
  // 查询不投递；只有交付确认事件才算已发，其余候选明确标为待写发件。
  return { at, eventId: events.at(-1)?.id ?? null, records, projection };
}
function serializedState(view: Snapshot) {
  return { version: 1, at: view.at, eventId: view.eventId, codeVersion, records: view.records, health: [...view.projection.health.values()],
    ...(view.projection.pushMismatches.size ? { pushMismatches: [...view.projection.pushMismatches.values()] } : {}), ...(view.projection.feishuConnection ? { feishuConnection: view.projection.feishuConnection } : {}),
    undeliveredNotices: undeliveredNotices(view.projection) };
}
/** 必须在数据锁内调用：决策先落盘，文件幂等交付，再分别确认外部渠道。 */
async function settle(config: Config, events: AgentEvent[], added: AgentEvent[], now: string, channels: Channel[], attempted: Set<string>, deferSnapshots = false) {
  const previous = project(events);
  const raw = project([...events, ...added]);
  // 模型等待期间可能已有另一轮感知/反馈，不能用旧时间/旧会话覆盖新事实。
  const at = raw.lastScanAt && raw.lastScanAt > now ? raw.lastScanAt : now;
  const projection = activeProjection(await feedbackProjection(raw, config, at), config);
  const add = (payload: EventPayload) => { added.push(event(payload, at)); };
  // supplemental 通知也按级别选择出口；历史卡片绝不重新计划或改变出口。
  for (const entry of added) if (entry.kind === 'notice_planned') entry.notice = routeNotice(entry.notice, projection, at);
  const records = judgeRecords(projection, at);
  for (const entry of added) if (entry.kind === 'scan_completed') {
    const observations = records.filter(record => record.rule).map(record => ({ recordKey: record.key, status: record.status, rule: record.rule! }));
    const changed = observations.filter(observation => JSON.stringify(raw.ruleDecisions.get(observation.recordKey)) !== JSON.stringify(observation));
    if (changed.length) entry.ruleDecisions = changed;
  }
  const suppressed: EventPayload[] = [];
  const planned = planNotices(records, projection, config, at, suppressed).filter(n =>
    !deferSnapshots || !standaloneSnapshot(n) || projection.noticeSnapshots.has(noticeSnapshotKey(n)));
  for (const decision of suppressed) add(decision);
  for (const notice of planned) add({ kind: 'notice_planned', notice });
  const queued = activeProjection(project([...events, ...added]), config);
  for (const channel of channels) for (const notice of queued.notices) {
    if (!accepts(channel, notice) || isFeedbackSuppressed(notice, projection.feedbackSuppressions)) continue;
    const key = `${channel.name}:${notice.id}`;
    if (!queued.channelDeliveries.has(key) && !previous.deliveredNoticeIds.has(notice.id)) add({ kind: 'channel_delivery', channel: channel.name, noticeId: notice.id, ok: false, phase: 'queued' });
  }
  let written = 0;
  const flush = async () => {
    await appendJsonl(join(config.dataDir, 'events.jsonl'), added.slice(written));
    written = added.length;
  };
  await flush();
  const completeRaw = project([...events, ...added]);
  const complete = activeProjection(await feedbackProjection(completeRaw, config, at), config);
  // 复用已经判好的记录发布已提交视图，不为埋点额外重放/重读反馈；收件不等模型或外部渠道。
  await writeState(config.dataDir, serializedState({ at, eventId: added.at(-1)?.id ?? events.at(-1)?.id ?? null, records, projection: complete }));
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
    if (!accepts(channel, notice) || complete.channelDeliveries.get(key) !== false || attempted.has(key)
      || !complete.channelDeliveryStates.has(key) || complete.channelDeliveryStates.get(key)?.historyUnknown
      || (complete.channelDeliveryStates.get(key)?.failures ?? 0) >= MAX_CHANNEL_FAILURES) continue;
    if (!await canDeliver(notice)) continue;
    const group: Notice[] = [notice];
    if (channel.name === 'local' && notice.localBatch) for (const candidate of deliverable) {
      const candidateKey = `${channel.name}:${candidate.id}`, state = complete.channelDeliveryStates.get(candidateKey);
      if (candidate.id !== notice.id && candidate.localBatch?.id === notice.localBatch.id && accepts(channel, candidate)
        && complete.channelDeliveries.get(candidateKey) === false && state && !state.historyUnknown
        && state.failures < MAX_CHANNEL_FAILURES && !attempted.has(candidateKey) && await canDeliver(candidate)) group.push(candidate);
    }
    for (const candidate of group) attempted.add(`${channel.name}:${candidate.id}`);
    const localBatch = channel.name === 'local' && notice.localBatch ? { ...notice.localBatch,
      entries: notice.localBatch.entries.filter(entry => group.some(candidate => candidate.id === entry.noticeId)) } : undefined;
    const outgoing = localBatch ? { ...notice, localBatch, content: { ...notice.content, title: localBatch.title } } : notice;
    let ok = true, failure;
    try { await channel.send(outgoing); }
    catch (error) { ok = false; failure = safeDeliveryFailure(error); await reportStorageFailure(config, error, channels); }
    for (const candidate of group) add({ kind: 'channel_delivery', channel: channel.name, noticeId: candidate.id,
      ok, phase: 'attempted', ...(failure ? { failure } : {}) });
    await flush();
  }
  const delivery = activeProjection(project([...events, ...added]), config), local = channels.find(channel => channel.name === 'local');
  // 包括升级前几百次的旧失败：不再调用原渠道，直接按停止状态告知一次。
  const stoppedDeliveries = undeliveredNotices(delivery).filter(item => item.stopped && !item.historyUnknown);
  if (local) for (const notice of deliverable) {
    const stopped = stoppedDeliveries.filter(item => item.noticeId === notice.id);
    if (!stopped.length || delivery.deliveryAlerted.has(notice.id) || !await canDeliver(notice)) continue;
    // 外部通知与日志无原子事务。先持久化一次尝试，崩溃/通知失败也不无限重弹。
    add({ kind: 'notice_delivery_alerted', noticeId: notice.id }); await flush();
    delivery.deliveryAlerted.add(notice.id);
    const destinations = stopped.map(item => `${channelName(item.channel)}（${item.failure.category}：${item.failure.reason}）`).join('、');
    const alert = localAlert('delivery_failed', `delivery-failed:${notice.id}`, at, `未送达：${notice.content.title}`,
      `「${notice.content.title}」没发到${stopped.map(item => channelName(item.channel)).join('、')}，已停止重试`, `原因：${destinations}。请查看本机总览。`);
    let ok = true, failure;
    try { await local.send(alert); }
    catch (error) { ok = false; failure = safeDeliveryFailure(error); await reportStorageFailure(config, error, channels); }
    add({ kind: 'notice_delivery_alerted', noticeId: notice.id, ok, ...(failure ? { failure } : {}) }); await flush();
  }
  const unconfirmed = deliverable.filter(notice => known.has(notice.id) && !complete.deliveredNoticeIds.has(notice.id)).map(notice => notice.id);
  if (unconfirmed.length) { add({ kind: 'notices_delivered', ids: unconfirmed }); await flush(); }
  const view = await snapshot([...events, ...added], config, at);
  await writeState(config.dataDir, serializedState(view));
  return { ...view, noticesAdded };
}
export async function publishNotices(config: Config, notices: Notice[], now: string, channels = configuredChannels(config), attempted = new Set<string>()) {
  return withStorageAlerts(config, channels, () => detectionLock(config, async () => {
    const events = await prepareDeliveryLog(config.dataDir, now), known = new Set(project(events).notices.map(n => n.id));
    const added = notices.filter(n => isActiveNotice(n) && !known.has(n.id)).map(notice => event({ kind: 'notice_planned', notice }, now));
    return settle(config, events, added, now, channels, attempted);
  }), false);
}
export async function detect(configInput: Config, currentTime = new Date().toISOString(), components: { judge?: Judge; channels?: Channel[] } = {}) {
  const config = await validateConfig(configInput);
  const now = iso(currentTime, '当前时间');
  const channels = components.channels ?? configuredChannels(config);
  return withStorageAlerts(config, channels, () => detectOnce(config, now, channels, components));
}
async function detectOnce(config: Config, now: string, channels: Channel[], components: { judge?: Judge }) {
  const attempted = new Set<string>();
  const deferSnapshots = !!config.judge && (!components.judge || !!components.judge.writeSnapshot);
  const finish = async (view: Snapshot & { noticesAdded: number }) => {
    for (const channel of channels) if ('drain' in channel && typeof channel.drain === 'function') await channel.drain(now);
    return view;
  };
  const ruleView = await detectionLock(config, async () => {
    // 只追加新事实，不在启动/检测时迁移、封存、清理或重写旧文件。
    const events = await prepareDeliveryLog(config.dataDir, now);
    const previous = project(events);
    const input = normalize(await perceive(config), previous.sessions.values(), config);
    const added: AgentEvent[] = [];
    const add = (payload: EventPayload) => { added.push(event(payload, now)); };
    for (const record of input.records) {
      const last = previous.sessions.get(record.key);
      if (record.loop?.status === '暂停') record.loopPausedAt = last?.loop?.status === '暂停'
        ? last.loopPausedAt ?? record.loopPausedAt ?? now : record.loopPausedAt ?? now;
      const delta = sessionDelta(last, record);
      if (delta) add({ kind: 'session_delta', delta });
    }
    for (const report of input.health) {
      const last = previous.health.get(report.source);
      const anomaly = skipAnomaly(report, last);
      if (anomaly) report.errors.push(anomaly);
      if (!last || JSON.stringify([last.errors, last.paths, last.fileFailures, last.sessionKeys, last.fileStats, last.fileStatsProfile, last.affectedSessions]) !== JSON.stringify([report.errors, report.paths, report.fileFailures, report.sessionKeys, report.fileStats, report.fileStatsProfile, report.affectedSessions])) add({ kind: 'source_health', report });
    }
    add({ kind: 'scan_completed' });
    // 故障即时交付，loop 新卡片可继续用原快照起草，不再分析聊天。
    return settle(config, events, added, now, channels, attempted, deferSnapshots);
  });
  if (!config.judge) return finish(ruleView);
  const modelDeadline = Date.now() + (config.judge.cycleTimeoutMs ?? 60000);
  const modelView = await withModelLock(config.dataDir, async () => {
    const load = () => detectionLock(config, async () => activeProjection(await feedbackProjection(project(await readEvents(config.dataDir)), config, now), config));
    const projection = await load();
    const pending = planNotices(judgeRecords(projection, now), projection, config, now);
    const persist = (payload: EventPayload) => detectionLock(config, async () => {
      if (payload.kind === 'model_call_started') {
        // 短锁内按最新日志原子预留；不能拿模型阶段开始时的旧额度覆盖并发用量。
        const used = project(await readEvents(config.dataDir)).modelCalls.get(now.slice(0, 10)) ?? 0;
        if (used >= (config.judge!.dailyLimit ?? Infinity)) return false;
      }
      await appendJsonl(join(config.dataDir, 'events.jsonl'), [event(payload, now)]);
      return true;
    });
    const snapshots = await checkSnapshotModels(pending, projection, config, now, persist, components.judge, modelDeadline);
    return snapshots ? detectionLock(config, async () => settle(config, await readEvents(config.dataDir), [], now, channels, attempted)) : null;
  });
  return finish(modelView ? { ...modelView, noticesAdded: ruleView.noticesAdded + modelView.noticesAdded } : ruleView);
}
export async function overview(configInput: Config, now?: string): Promise<Snapshot> {
  const config = await validateConfig(configInput);
  return snapshot(await readEvents(config.dataDir), config, now);
}
export async function rebuild(configInput: Config, now?: string): Promise<Snapshot> {
  const config = await validateConfig(configInput);
  return detectionLock(config, async () => {
    const at = now ?? project(await readEvents(config.dataDir)).lastScanAt ?? new Date().toISOString();
    const view = await snapshot(await readEvents(config.dataDir), config, at);
    await writeState(config.dataDir, serializedState(view));
    return view;
  });
}
