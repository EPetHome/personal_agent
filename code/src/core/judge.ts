import { basename } from 'node:path';
import { channelName, undeliveredNotices } from './delivery.ts';
import { humanText, localTime, presentNotice } from './notice-text.ts';
import { routeNotice, WAITING_INTERVAL_MS } from './interaction.ts';
import { traceSuppression } from './telemetry.ts';
import { noticeSnapshotKey, ruleSnapshot, snapshotInput } from './task-snapshot.ts';
import { feedbackSuppressionKey } from './feedback.ts';
import { compact, hash, shellQuote, truncateUtf8 } from './utils.ts';
import { toolNames } from './types.ts';
import type { Config, EventPayload, JudgedRecord, Notice, NoticeContent, Projection, TaskSnapshot, TaskSnapshotInput } from './types.ts';

const ONE_DAY = 24 * 60 * 60 * 1000;
const FIRST_LOOKBACK = 60 * 60 * 1000;
/** 不再投递聊天卡、报告和无法核实的旧停滞卡；历史记录仍可读取和反馈。 */
export function isActiveNotice(notice: Notice): boolean {
  return notice.tool === 'loop' && ['loop_paused', 'loop_completed', 'blind', 'unreadable'].includes(notice.kind)
    || notice.tool === 'agent' && ['service_restart', 'delivery_failed', 'storage_full'].includes(notice.kind);
}
export function judgeRecords(projection: Projection, now: string): JudgedRecord[] {
  return [...projection.sessions.values()].filter(record => record.tool === 'loop').map(record => {
    // 轮次开始/总结mtime不是worker的最后活动；未采集实际活动时不能据此判停滞。
    const judged: JudgedRecord = { ...record, status: '进行中', reason: 'loop 总结状态：进行中；总结时间不代表最后活动时间，未据此判断停滞' };
    let id: NonNullable<JudgedRecord['rule']>['id'] = 'active_unfinished';
    const health = projection.health.get('loop');
    if (health?.errors.length) {
      id = 'source_unavailable'; judged.status = '看不见了';
      judged.reason = '来源读取失败，保留最后一次读到的事实，当前状态不能确认';
    } else if (record.loop?.status === '暂停' && Date.parse(now) - Date.parse(record.loopPausedAt ?? now) > ONE_DAY) {
      id = 'inactive_24h'; judged.status = '已搁置'; judged.reason = 'loop 暂停已超过 24 小时；只进总览，不提醒';
    } else if (record.loop?.status === '暂停') {
      id = 'loop_paused'; judged.status = '在等我'; judged.reason = record.loop.conclusion;
    } else if (record.loop?.status === '完成') {
      id = 'loop_completed'; judged.status = '已完成'; judged.reason = 'loop 总结状态：完成';
    }
    judged.rule = { id, facts: { lastActivityAt: record.lastActivityAt,
      ...(record.loop ? { loopStatus: record.loop.status } : {}), ...(record.loopPausedAt ? { loopPausedAt: record.loopPausedAt } : {}),
      ...(id === 'inactive_24h' ? { thresholdMs: ONE_DAY } : {}),
      members: [{ sessionId: record.sessionId, lastActivityAt: record.lastActivityAt, sessionEnded: record.sessionEnded,
        assistantFinished: record.assistantFinished, pendingTools: record.pendingTools.length, unavailable: !!record.unavailable,
        completed: record.loop?.status === '完成' }] } };
    return judged;
  }).sort((a, b) => a.project.localeCompare(b.project) || a.key.localeCompare(b.key));
}
export function renderNotice(content: NoticeContent, at?: string, evidenceAt = at): string {
  const e = content.evidence;
  return [
    content.title, content.summary, at && evidenceAt ? `时间 / 回去看：${localTime(evidenceAt, at)}\n${content.returnCommand}` : `回去看：${content.returnCommand}`,
    '证据：', `项目：${e.project ?? '来源读取故障，项目暂不可知'}`,
    `意图原文：${e.intentOriginal ?? '原件未提供开工指令，未推测'}`,
    '你后来追加的要求：', ...(e.additionalRequirements.length ? e.additionalRequirements.map(text => `- ${text}`) : ['- 无']),
    '做到哪了（最近几步）：', ...(e.recentSteps.length ? e.recentSteps.map(step => `- ${step.at} ${step.text}`) : ['- 暂不可读']),
    `判断依据：${e.reason}`, ...(e.assistantReply ? [`助手原话：${e.assistantReply}`] : []),
    ...(e.presentation ? [`这件事（完整）：${e.presentation.situation}`, `要你做（完整）：${e.presentation.action}`] : []),
    ...(e.needs ? [`还欠什么：${e.needs.length ? e.needs.join('；') : '无'}`] : []), ...e.originals.map(original => `原件：${original.path}`),
  ].join('\n');
}
function createNotice(kind: Notice['kind'], key: string, at: string, content: NoticeContent, evidenceAt: string, sessionKey?: string): Notice {
  return { version: 1, id: hash(key), dedupeKey: key, at, tool: 'loop', kind,
    level: kind === 'loop_completed' ? '有空看' : '现在就要你',
    ...(sessionKey ? { sessionKey } : {}), evidenceAt, content, text: renderNotice(content, at, evidenceAt) };
}
function attachSnapshot(notice: Notice, value: TaskSnapshot, projection: Projection): Notice {
  const snapshot = projection.noticeSnapshots.get(noticeSnapshotKey(notice)) ?? value;
  notice.snapshot = snapshot;
  notice.content = presentNotice({ ...notice.content, actionItems: snapshot.actionItems, evidence: { ...notice.content.evidence,
    presentation: { situation: snapshot.situation, action: snapshot.action } } }, snapshot.situation, snapshot.action, notice.at);
  notice.text = notice.kind === 'blind' || notice.kind === 'unreadable'
    ? truncateUtf8(renderNotice(notice.content, notice.at, notice.evidenceAt), 4096) : renderNotice(notice.content, notice.at, notice.evidenceAt);
  return notice;
}
export function planNotices(records: JudgedRecord[], projection: Projection, _config: Config, now: string, suppressed?: EventPayload[]): Notice[] {
  const candidates: Notice[] = [];
  for (const record of records) {
    if (record.tool !== 'loop' || record.status === '已搁置' || record.status === '看不见了') continue;
    const previous = projection.ruleDecisions.get(record.key)?.rule.facts;
    if (previous?.loopStatus === '暂停' && record.loop?.status !== '暂停'
      && !projection.notices.some(n => n.kind === 'loop_paused' && n.sessionKey === record.key && n.evidenceAt === previous.loopPausedAt)) {
      traceSuppression(projection, suppressed, { dedupeKey: `loop_paused:${record.key}`, evidenceAt: previous.loopPausedAt ?? previous.lastActivityAt,
        sessionKey: record.key, scope: 'notice', intervalMs: WAITING_INTERVAL_MS }, 'loop_resumed');
    }
    const loop = record.loop!;
    if (loop.status === '进行中') continue;
    const kind = loop.status === '暂停' ? 'loop_paused' : 'loop_completed';
    // 展示字段不改变旧事实身份，升级不补发已交代的总结。
    const { batch: _batch, phase: _phase, sessions: _sessions, summary: _summary, ...facts } = loop;
    const key = `${kind}:${record.key}:${hash(JSON.stringify(facts))}`;
    const evidenceAt = kind === 'loop_paused' ? record.loopPausedAt ?? now : record.lastActivityAt;
    const suppress = (reason: Parameters<typeof traceSuppression>[3]) => traceSuppression(projection, suppressed,
      { dedupeKey: key, evidenceAt, scope: 'notice', sessionKey: record.key, memberSessionId: record.sessionId }, reason);
    if (kind === 'loop_paused' && Date.parse(now) - Date.parse(evidenceAt) < WAITING_INTERVAL_MS) { suppress('waiting_interval'); continue; }
    const feedbackKey = feedbackSuppressionKey({ tool: 'loop', kind, sessionKey: record.key, memberSessionId: record.sessionId });
    if (feedbackKey && projection.feedbackSuppressions.has(feedbackKey)) { record.notice = '因你的误报没提醒'; suppress('feedback_false_positive'); continue; }
    const existing = projection.notices.find(n => n.dedupeKey === key);
    if (existing) { record.notice = projection.deliveredNoticeIds.has(existing.id) ? '已提醒，本轮去重' : '待写发件记录'; suppress('duplicate_notice'); continue; }
    if (projection.startedAt && Date.parse(evidenceAt) < Date.parse(projection.startedAt) - FIRST_LOOKBACK) {
      record.notice = '首次接入历史记录，不补发'; suppress('first_connection_history'); continue;
    }
    const batch = humanText(loop.batch ?? '批次名暂未记录', record.project, now), ai = `${basename(record.project)} 的 loop（${batch}）`;
    const content: NoticeContent = { title: `${ai}${kind === 'loop_paused' ? '停下了，需要你决定' : '做完了，给你一份交代'}`,
      summary: '', returnCommand: `open ${shellQuote(record.originals[0]!.path)}`,
      evidence: { project: record.project, intentOriginal: record.intent.initial, additionalRequirements: record.intent.additions,
        recentSteps: record.recentSteps, reason: `${record.reason}；评审 ${loop.reviews} 次，返修 ${loop.repairs} 次`, originals: record.originals,
        assistantReply: record.assistantReply?.text, needs: loop.needs, needsProvided: loop.needsProvided } };
    const notice = createNotice(kind, key, now, content, evidenceAt, record.key);
    const lastOutput = `${basename(record.project)} · ${batch}：${loop.conclusion}${loop.summary ? `；${loop.summary}` : ''}；还欠 ${loop.needs.length} 项${loop.needsProvided === false ? '；总结没写还欠什么' : ''}`;
    const input = snapshotInput(record, lastOutput, kind === 'loop_paused' ? 'loop 暂停' : 'loop 完成', evidenceAt);
    notice.memberSessionId = record.sessionId; record.notice = '待写发件记录';
    candidates.push(attachSnapshot(notice, ruleSnapshot(input, record.project, now), projection));
  }
  for (const health of projection.health.values()) {
    if (health.source !== 'loop') continue;
    const kind = health.since ? 'blind' : health.fileFailures?.count ? 'unreadable' : null;
    if (!kind) continue;
    const evidenceAt = (kind === 'blind' ? health.since : health.fileFailureSince) ?? now;
    const key = `${kind}:loop:${kind === 'blind' ? health.episodeId : health.fileFailureEpisodeId}`;
    const failureDetails = [...health.errors, ...(health.fileFailures?.examples ?? [])].join('\n');
    const affected = health.affectedSessions?.[0] ?? records.find(r => r.originals.some(o => failureDetails.includes(o.path)));
    const scope = affected && (health.affectedSessions?.length ?? 1) <= 1 && (health.fileFailures?.count ?? 0) <= 1 && health.errors.length <= 1
      ? `loop:${affected.sessionId}` : undefined;
    const feedbackKey = feedbackSuppressionKey({ tool: 'loop', kind, feedbackScope: scope });
    if (feedbackKey && projection.feedbackSuppressions.has(feedbackKey)) {
      traceSuppression(projection, suppressed, { dedupeKey: key, evidenceAt, scope: 'notice' }, 'feedback_false_positive'); continue;
    }
    if (projection.notices.some(n => n.dedupeKey === key)) {
      traceSuppression(projection, suppressed, { dedupeKey: key, evidenceAt, scope: 'notice' }, 'duplicate_notice'); continue;
    }
    const record = affected && [...(projection.snapshotSessions ?? projection.sessions).values()].find(r => r.sessionId === affected.sessionId);
    const seen = record?.assistantReply?.text ?? record?.recentSteps.at(-1)?.text;
    const what = kind === 'blind' ? `从 ${localTime(evidenceAt, now)} 起暂时读不了 loop 的记录，当前批次状态不能确认`
      : `从 ${localTime(evidenceAt, now)} 起发现 ${health.fileFailures!.count} 份 loop 总结读不了；其余批次照常判断和显示`;
    const content: NoticeContent = { title: kind === 'blind' ? 'loop 的盯防看不见了' : `loop 有 ${health.fileFailures!.count} 份会话读不了`, summary: '',
      returnCommand: record ? `open ${shellQuote(record.originals[0]!.path)}` : '暂时无法定位总结，请打开 loop 检查。',
      evidence: { project: affected?.project ?? null, intentOriginal: record?.intent.initial ?? null, additionalRequirements: [], recentSteps: [], originals: [],
        reason: [what, ...health.errors.slice(0, 3), ...(health.fileFailures?.examples.slice(0, 3) ?? [])].map(error => compact(error, 240)).join('\n') } };
    const notice = createNotice(kind, key, now, content, evidenceAt);
    notice.sourceEvidence = record?.originals ?? []; if (scope) notice.feedbackScope = scope;
    const lastOutput = [what, seen ? `最后看到：${seen}` : '', failureDetails].filter(Boolean).join('\n');
    const input: TaskSnapshotInput = record ? snapshotInput(record, lastOutput, '看不见了', evidenceAt)
      : { goal: null, currentTask: null, lastOutput: compact(lastOutput, 1200), factualStatus: '看不见了' };
    candidates.push(attachSnapshot(notice, ruleSnapshot(input, affected?.project ?? '', now), projection));
  }
  return candidates.map(notice => routeNotice(notice, projection, now));
}
export function renderOverview(records: JudgedRecord[], projection: Projection): string {
  const lines = ['工具 | 项目 | 意图 | 状态 | 最后活动时间 | 提醒'];
  for (const record of records) {
    const intent = [record.intent.initial ?? '总结未提供开工指令', ...record.intent.additions].join('；');
    lines.push([toolNames[record.tool], record.project, compact(intent), record.status, record.lastActivityAt, record.notice ?? '—'].map(v => v.replaceAll('|', '｜').replace(/[\r\n]/g, ' ')).join(' | '));
  }
  if (!records.length) lines.push('暂无会话');
  for (const health of projection.health.values()) {
    if (health.since) lines.push(`盯防异常：${toolNames[health.source]}，从 ${health.since} 起看不见；${projection.notices.some(n => n.dedupeKey === `blind:${health.source}:${health.episodeId}` && projection.deliveredNoticeIds.has(n.id)) ? '已提醒，本轮去重' : '待写发件记录'}`);
    else if (health.fileFailures?.count) lines.push(`${toolNames[health.source]} 有 ${health.fileFailures.count} 份会话读不了，其余会话照常显示。`);
  }
  const undelivered = undeliveredNotices(projection);
  for (const name of ['local', 'feishu']) {
    const failed = undelivered.filter(item => item.channel === name && !item.stopped).length;
    if (failed) lines.push(`${name === 'local' ? '本机通知' : '飞书'}尚未成功：${failed} 条；已写发件记录，下轮检测重试。`);
  }
  if (projection.feishuConnection) {
    const connection = projection.feishuConnection;
    const status = connection.state === 'connected' ? '已连接' : connection.state === 'fake' ? '假渠道（未连接真实飞书）'
      : connection.state === 'connecting' ? '未连接（连接中）' : connection.state === 'reconnecting' ? '未连接（重连中）' : '未连接';
    lines.push(`飞书长连接：${status}${connection.failure ? `；${connection.failure.category}：${connection.failure.message}` : ''}`);
  }
  for (const item of undelivered.filter(item => item.stopped)) lines.push(`没发出去：${item.title} → ${channelName(item.channel)}；${item.historyUnknown
    ? '历史失败次数待恢复，暂停发送' : `连续失败 ${item.failures} 次，已停发`}；${item.failure.category}：${item.failure.reason}`);
  return lines.join('\n');
}
