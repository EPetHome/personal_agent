import { basename } from 'node:path';
import { humanText, localTime, presentNotice } from './notice-text.ts';
import { pushIdentity } from './events.ts';
import { modelEvidenceKey } from './evidence.ts';
import { noticeSnapshotKey, ruleSnapshot, snapshotInput, stepSnapshotInput } from './task-snapshot.ts';
import { feedbackSuppressionKey, isFeedbackSuppressed } from './feedback.ts';
import { compact, hash, shellQuote, truncateUtf8 } from './utils.ts';
import { toolNames } from './types.ts';
import { membersOf, pushMatchesMember } from './sessions.ts';
import type { Config, EventPayload, JudgedRecord, Notice, NoticeContent, Projection, PushRecord, SessionRecord, TaskSnapshot, TaskSnapshotInput } from './types.ts';

const THIRTY_MINUTES = 30 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
const FIRST_LOOKBACK = 60 * 60 * 1000;
function comparePushes(a: PushRecord, b: PushRecord): number {
  const order = ['waiting_permission', 'turn_end', 'session_end'];
  return a.at.localeCompare(b.at) || order.indexOf(a.event) - order.indexOf(b.event);
}
export function judgeRecords(projection: Projection, now: string): JudgedRecord[] {
  return [...projection.sessions.values()].map(record => {
    const judged: JudgedRecord = { ...record, status: '进行中', reason: '会话有新记录，尚未答完' };
    // 推送属于具体成员。父/兄弟的新动静不能解除这个子会话的等待，子会话结束也不能结束父会话。
    const activities = membersOf(record).map(member => {
      const latest = projection.pushes.filter(p => p.recordKey === record.key && p.tool === record.tool && pushMatchesMember(p, member) && p.at <= now)
        .sort(comparePushes).at(-1);
      const push = latest && member.lastActivityAt !== null && latest.at >= member.lastActivityAt ? latest : undefined;
      const waiting = push?.event === 'waiting_permission' ? push : undefined;
      const completed = !member.unavailable && !waiting && (member.sessionEnded || push?.event === 'session_end' || push?.event === 'turn_end' || (member.assistantFinished && !member.pendingTools.length));
      return { member, push, waiting, completed, lastActivityAt: push?.at ?? member.lastActivityAt };
    });
    judged.lastActivityAt = activities.reduce((last, activity) => activity.lastActivityAt !== null && activity.lastActivityAt > last ? activity.lastActivityAt : last, record.lastActivityAt);
    judged.pendingTools = activities.filter(a => !a.completed).flatMap(a => a.member.pendingTools);
    const waiting = activities.filter(a => a.waiting).sort((a, b) => comparePushes(a.waiting!, b.waiting!)).at(-1);
    if (projection.health.get(record.tool)?.since || (record.tool !== 'loop' && projection.health.get('inbox')?.since)) {
      judged.status = '看不见了';
      judged.reason = '来源或推送读取失败，保留最后一次读到的事实，当前状态不能确认';
    } else if (!activities.some(a => a.member.unavailable) && !activities.every(a => a.completed)
      && Date.parse(now) - Date.parse(judged.lastActivityAt) > ONE_DAY) {
      judged.status = '已搁置';
      judged.reason = '尚无全部结束证据，超过 24 小时没有新动静；只进总览，不提醒';
    } else if (record.loop?.status === '暂停') {
      judged.status = '在等我';
      judged.reason = record.loop.conclusion;
    } else if (record.loop?.status === '完成') {
      judged.status = '已完成';
      judged.reason = 'loop 总结状态：完成';
    } else if (waiting?.waiting) {
      judged.status = '在等我';
      judged.reason = waiting.member.unavailable
        ? `子会话本轮读不了，保留最后一次已对账的等授权事实，尚无解除证据：${waiting.waiting.detail}`
        : `${waiting.member.sessionId === record.sessionId ? '会话' : '子会话'}收到等授权事件，该会话之后没有新动静：${waiting.waiting.detail}`;
      judged.waiting = waiting.waiting;
    } else if (activities.some(a => a.member.unavailable)) {
      judged.reason = '部分子会话本轮读不了，保留已知关联；没有全部完成证据，暂不能确认完成';
    } else if (activities.every(a => a.completed)) {
      judged.status = '已完成';
      judged.reason = activities.length > 1 ? '父会话及子会话均已结束或本轮答完' : activities[0]?.push?.event === 'session_end' || record.sessionEnded ? '会话已结束' : '本轮助手已答完，且没有未返回的工具调用（规则判断）';
    } else if (Date.parse(now) - Date.parse(judged.lastActivityAt) > THIRTY_MINUTES) {
      judged.status = '停滞';
      judged.reason = '尚未答完，最后一条记录超过 30 分钟，且仍有会话没有结束';
    }
    return judged;
  }).sort((a, b) => a.tool.localeCompare(b.tool) || a.project.localeCompare(b.project) || a.key.localeCompare(b.key));
}
function returnCommand(record: SessionRecord, config: Config, sessionId = record.sessionId): string {
  if (record.tool === 'loop') return `open ${shellQuote(record.originals[0]!.path)}`;
  const command = shellQuote(config.commands[record.tool]);
  return `${command} ${record.tool === 'cc' ? '--resume' : record.tool === 'codex' ? 'resume' : '--session'} ${shellQuote(sessionId)}`;
}
export function renderNotice(content: NoticeContent, at?: string, evidenceAt = at): string {
  const e = content.evidence;
  return [
    content.title, content.summary, at && evidenceAt ? `时间 / 回去看：${localTime(evidenceAt, at)}\n${content.returnCommand}` : `回去看：${content.returnCommand}`,
    '证据：', `项目：${e.project ?? '来源读取故障，项目暂不可知'}`,
    `意图原文：${e.intentOriginal ?? '原件未提供开工指令，未推测'}`,
    '你后来追加的要求：', ...(e.additionalRequirements.length ? e.additionalRequirements.map(text => `- ${text}`) : ['- 无']),
    '做到哪了（最近几步）：', ...(e.recentSteps.length ? e.recentSteps.map(step => `- ${step.at} ${step.text}`) : ['- 暂不可读']),
    `判断依据：${e.reason}`,
    ...(e.assistantReply ? [`助手原话：${e.assistantReply}`] : []),
    ...(e.presentation ? [`这件事（完整）：${e.presentation.situation}`, `要你做（完整）：${e.presentation.action}`] : []),
    ...(e.needs ? [`还欠什么：${e.needs.length ? e.needs.join('；') : '无'}`] : []),
    ...e.originals.map(original => `原件：${original.path}`),
  ].join('\n');
}
function createNotice(tool: Notice['tool'], kind: Notice['kind'], dedupeKey: string, at: string, content: NoticeContent, sessionKey?: string, evidenceAt?: string): Notice {
  return {
    version: 1, id: hash(dedupeKey), dedupeKey, at, tool, kind,
    level: kind === 'stalled' || kind === 'loop_completed' ? '有空看' : '现在就要你',
    ...(sessionKey ? { sessionKey } : {}), ...(evidenceAt ? { evidenceAt } : {}), content,
    text: kind === 'blind' || kind === 'unreadable' ? truncateUtf8(renderNotice(content, at, evidenceAt), 4096) : renderNotice(content, at, evidenceAt),
  };
}
function attachSnapshot(notice: Notice, value: TaskSnapshot, projection: Projection): Notice {
  const snapshot = projection.noticeSnapshots.get(noticeSnapshotKey(notice)) ?? value;
  notice.snapshot = snapshot;
  notice.content = presentNotice({ ...notice.content, evidence: { ...notice.content.evidence,
    presentation: { situation: snapshot.situation, action: snapshot.action } } }, snapshot.situation, snapshot.action, notice.at);
  notice.text = notice.kind === 'blind' || notice.kind === 'unreadable'
    ? truncateUtf8(renderNotice(notice.content, notice.at, notice.evidenceAt), 4096) : renderNotice(notice.content, notice.at, notice.evidenceAt);
  return notice;
}
export function planNotices(records: JudgedRecord[], projection: Projection, config: Config, now: string, suppressed?: EventPayload[]): Notice[] {
  const candidates: Notice[] = [];
  for (const record of records) {
    if (record.status === '已搁置') continue;
    let kind: Notice['kind'] | undefined;
    let key = '';
    let title = '';
    const ai = `${basename(record.project) || record.project} 的 ${toolNames[record.tool]}`;
    const waitingId = record.waiting?.sessionId ?? record.modelWaiting?.sessionId ?? record.ruleWaiting?.sessionId;
    const waitingMember = waitingId ? membersOf(record).find(member => member.sessionId === waitingId) : undefined;
    const modelReply = record.modelWaiting ? projection.pushes.findLast(p => p.recordKey === record.key && p.sessionId === record.modelWaiting!.sessionId
      && p.event === 'turn_end' && p.at === record.modelWaiting!.evidenceAt)?.detail ?? waitingMember?.assistantReply?.text : undefined;
    const last = record.loop?.phase ?? modelReply ?? record.ruleWaiting?.reply ?? waitingMember?.pendingTools.at(-1)?.text ?? (record.waiting?.detail || undefined) ?? record.pendingTools.at(-1)?.text ?? record.recentSteps.at(-1)?.text ?? '尚未答完';
    const batch = record.loop ? humanText(record.loop.batch ?? '批次名暂未记录', record.project, now) : '';
    if (record.loop && record.status !== '看不见了' && record.loop.status !== '进行中') {
      kind = record.loop.status === '暂停' ? 'loop_paused' : 'loop_completed';
      // 展示用的批名/当前步骤/关联会话不改变旧版去重键，升级不能重发已交代的总结。
      const { batch: _batch, phase: _phase, sessions: _sessions, summary: _summary, ...facts } = record.loop;
      key = `${kind}:${record.key}:${hash(JSON.stringify(facts))}`;
      title = `${ai}（${batch}）${record.loop.status === '暂停' ? '停下了，需要你决定' : '做完了，给你一份交代'}`;
    } else if (record.status === '在等我' && record.waiting) {
      kind = 'waiting';
      key = `waiting:${record.key}:${pushIdentity(record.waiting)}`;
      const child = record.waiting.sessionId !== record.sessionId;
      title = `${ai}${child ? ' 子会话' : ''} 在等你授权`;
    } else if (record.status === '在等我' && (record.modelWaiting || record.ruleWaiting)) {
      kind = 'waiting';
      const fact = record.modelWaiting ?? { ...record.ruleWaiting!, recordKey: record.key, task: 'waiting' as const };
      key = `model_waiting:${record.key}:${modelEvidenceKey(fact)}`;
      title = `${ai} 可能在等你回复`;
    } else if (record.status === '疑似跑偏' && record.drift) {
      kind = 'drift';
      key = `drift:${record.key}:${modelEvidenceKey(record.drift)}`;
      title = `${ai} 疑似跑偏`;
    } else if (record.status === '停滞') {
      kind = 'stalled';
      key = `stalled:${record.key}`;
      title = `${ai}${record.loop ? `（${batch}）` : ''} 干到一半没动静了`;
    }
    if (!kind) continue;
    const evidenceAt = record.waiting?.at ?? record.modelWaiting?.evidenceAt ?? record.ruleWaiting?.evidenceAt ?? record.drift?.evidenceAt ?? record.lastActivityAt;
    const memberId = waitingId ?? record.drift?.sessionId ?? record.sessionId;
    const feedbackKey = feedbackSuppressionKey({ tool: record.tool, kind, sessionKey: record.key, memberSessionId: memberId });
    if (feedbackKey && projection.feedbackSuppressions.has(feedbackKey)) {
      record.notice = '因你的误报没提醒';
      continue;
    }
    const existing = projection.notices.find(n => n.dedupeKey === key || ((record.waiting || record.modelWaiting || record.ruleWaiting || record.drift)
      && n.kind === kind && n.sessionKey === record.key && (n.memberSessionId ?? record.sessionId) === memberId
      && Date.parse(n.evidenceAt ?? '') === Date.parse(evidenceAt)));
    const already = !!existing;
    const recovered = kind === 'waiting' && projection.pushes.some(push => push.recovered && push.recordKey === record.key
      && (record.waiting ? pushIdentity(push) === pushIdentity(record.waiting)
        : push.event === 'turn_end' && push.sessionId === waitingId && push.at === evidenceAt));
    if (!already && (recovered || (projection.startedAt && Date.parse(evidenceAt) < Date.parse(projection.startedAt) - FIRST_LOOKBACK))) {
      record.notice = '首次接入历史记录，不补发';
      if (projection.suppressedNotices.get(key) !== evidenceAt) suppressed?.push({ kind: 'notice_suppressed', dedupeKey: key, evidenceAt });
      continue;
    }
    if (already) { record.notice = projection.deliveredNoticeIds.has(existing.id) ? '已提醒，本轮去重' : '待写发件记录'; continue; }
    const content: NoticeContent = {
      title, summary: '', returnCommand: returnCommand(record, config, waitingId),
      evidence: {
        project: waitingMember?.project ?? record.project, intentOriginal: record.intent.initial,
        additionalRequirements: record.intent.additions, recentSteps: waitingMember?.recentSteps ?? record.recentSteps,
        reason: record.loop ? `${record.reason}；评审 ${record.loop.reviews} 次，返修 ${record.loop.repairs} 次` : record.reason, originals: record.originals,
        assistantReply: modelReply ?? record.ruleWaiting?.reply ?? record.waiting?.detail ?? record.assistantReply?.text,
        ...(record.loop ? { needs: record.loop.needs, needsProvided: record.loop.needsProvided } : {}),
      },
    };
    const notice = createNotice(record.tool, kind, key, now, content, record.key, evidenceAt);
    const finding = record.modelWaiting ?? record.drift;
    const factualStatus: TaskSnapshotInput['factualStatus'] = kind === 'waiting' ? '在等你' : kind === 'drift' ? '跑偏'
      : kind === 'stalled' ? '停滞' : kind === 'loop_paused' ? 'loop 暂停' : 'loop 完成';
    const lastOutput = record.loop && kind !== 'stalled'
      ? `${basename(record.project)} · ${batch}：${record.loop.conclusion}${record.loop.summary ? `；${record.loop.summary}` : ''}；还欠 ${record.loop.needs.length} 项${record.loop.needsProvided === false ? '；总结没写还欠什么' : ''}`
      : kind === 'stalled' ? `${record.loop ? `${basename(record.project)} · ${batch}，` : ''}最后在做 ${record.loop?.phase ?? record.recentSteps.at(-1)?.text ?? last}；已 ${Math.floor((Date.parse(now) - Date.parse(record.lastActivityAt)) / 60000)} 分钟没动静`
        : kind === 'drift' ? record.drift!.result.stepQuote ?? last : modelReply ?? record.ruleWaiting?.reply ?? record.waiting?.detail ?? record.assistantReply?.text ?? last;
    const quotedStep = kind === 'drift' ? record.recentSteps.findLast(step => step.text.includes(record.drift!.result.stepQuote!)) : undefined;
    const input = quotedStep ? stepSnapshotInput(record, quotedStep) : snapshotInput(record, lastOutput, factualStatus,
      record.assistantReply && kind === 'waiting' && !record.waiting ? record.assistantReply.at : evidenceAt,
      kind === 'waiting' && !record.waiting ? 'reply' : 'step');
    attachSnapshot(notice, finding?.snapshot?.factualStatus === factualStatus ? finding.snapshot : ruleSnapshot(input, record.project, now), projection);
    notice.memberSessionId = memberId;
    record.notice = '待写发件记录';
    candidates.push(notice);
  }
  for (const health of projection.health.values()) {
    const kind = health.since ? 'blind' : health.fileFailures?.count ? 'unreadable' : null;
    if (!kind) continue;
    const key = `${kind}:${health.source}:${kind === 'blind' ? health.episodeId : health.fileFailureEpisodeId}`;
    const failures = health.fileFailures;
    const failureDetails = [...health.errors, ...(failures?.examples ?? [])].join('\n');
    const affected = health.affectedSessions?.[0] ?? records.find(r => r.tool === health.source && r.originals.some(o => failureDetails.includes(o.path)));
    const feedbackScope = affected && health.source !== 'inbox' && (health.affectedSessions?.length ?? 1) <= 1
      && (health.fileFailures?.count ?? 0) <= 1 && health.errors.length <= 1 ? `${health.source}:${affected.sessionId}` : undefined;
    const feedbackKey = feedbackSuppressionKey({ tool: health.source, kind, feedbackScope });
    if (feedbackKey && projection.feedbackSuppressions.has(feedbackKey)) {
      for (const record of records) if (record.tool === health.source && membersOf(record).some(m => m.sessionId === affected?.sessionId)) record.notice = '因你的误报没提醒';
      continue;
    }
    if (projection.notices.some(n => n.dedupeKey === key)) continue;
    const affectedRecord = affected && [...(projection.snapshotSessions ?? projection.sessions).values()].find(r => r.tool === health.source
      && membersOf(r).some(m => m.sessionId === affected.sessionId));
    const intent = affectedRecord?.intent.initial ?? (affected && ('intentOriginal' in affected ? affected.intentOriginal : 'intent' in affected ? affected.intent.initial : null));
    const ai = affected ? `${basename(affected.project)} 的 ${toolNames[health.source]}` : `${toolNames[health.source]}（项目和会话暂时无法辨认）`;
    const mismatch = health.errors.some(error => /推送与已读取会话对不上/.test(error));
    const since = localTime((kind === 'blind' ? health.since : health.fileFailureSince) ?? now, now);
    const scope = health.source === 'inbox' ? '所有 AI 工具会话的当前状态都暂时不能确认；loop 仍继续检测。'
      : `${toolNames[health.source]} 的所有会话当前状态都暂时不能确认；其他工具继续检测。`;
    const what = mismatch ? `从 ${since} 起，这个会话的报信和记录没能核对上；${scope}`
      : kind === 'blind' ? `从 ${since} 起，暂时读不了${affected ? '这个会话的记录' : `${toolNames[health.source]} 的会话记录`}；${scope}`
        : `从 ${since} 起发现 ${failures!.count} 份会话读不了；其余会话照常判断和显示。`;
    const command = affected && health.source !== 'inbox'
      ? health.source === 'loop' && 'originals' in affected ? `open ${shellQuote(affected.originals[0]!.path)}`
        : health.source !== 'loop' ? `${shellQuote(config.commands[health.source])} ${health.source === 'cc' ? '--resume' : health.source === 'codex' ? 'resume' : '--session'} ${shellQuote(affected.sessionId)}` : '暂时无法定位总结，请打开 loop 检查。'
      : `暂时无法定位具体会话，请打开 ${toolNames[health.source]} 检查。`;
    const content: NoticeContent = {
      title: kind === 'blind' ? `${affected ? ai : toolNames[health.source]} 的盯防看不见了`
        : `${affected ? ai : toolNames[health.source]} 有 ${failures!.count} 份会话读不了`,
      summary: '',
      returnCommand: command,
      evidence: {
        project: affected?.project ?? null, intentOriginal: intent ?? null, additionalRequirements: [], recentSteps: [],
        reason: [what, ...(kind === 'blind' ? health.errors.slice(0, 3) : []), ...(failures?.examples.slice(0, 3) ?? [])]
          .map(error => compact(error, 240)).join('\n'), originals: [],
      },
    };
    const notice = { ...createNotice(health.source, kind, key, now, content, undefined, (kind === 'blind' ? health.since : health.fileFailureSince) ?? now), ...(feedbackScope ? { feedbackScope } : {}) };
    const seen = affectedRecord?.assistantReply?.text ?? affectedRecord?.recentSteps.at(-1)?.text;
    const unreadable = `${mismatch ? '这个会话报信与记录未核对上' : kind === 'blind' ? '会话记录暂时读不了' : `${failures!.count} 份会话读不了`}；${kind === 'blind' ? scope : '其他会话继续检测'}`;
    const lastOutput = [unreadable, seen ? `最后看到：${seen}` : '', what, failureDetails].filter(Boolean).join('\n');
    const input: TaskSnapshotInput = affectedRecord ? snapshotInput(affectedRecord, lastOutput, '看不见了', notice.evidenceAt!)
      : { goal: intent ?? null, currentTask: null, lastOutput: compact(lastOutput, 1200), factualStatus: '看不见了' };
    candidates.push(attachSnapshot(notice, ruleSnapshot(input, affected?.project ?? '', now), projection));
  }
  return candidates;
}
export function renderOverview(records: JudgedRecord[], projection: Projection): string {
  const lines = ['工具 | 项目 | 意图 | 状态 | 最后活动时间 | 提醒'];
  for (const record of records) {
    const intent = [record.intent.initial ?? '总结未提供开工指令', ...record.intent.additions].join('；');
    lines.push([toolNames[record.tool], record.project, compact(intent), record.status, record.lastActivityAt, [record.notice ?? '—', ...new Set(record.modelNotes ?? [])].join('；')].map(v => v.replaceAll('|', '｜').replace(/[\r\n]/g, ' ')).join(' | '));
  }
  if (!records.length) lines.push('暂无会话');
  for (const health of projection.health.values()) {
    if (health.since) lines.push(`盯防异常：${toolNames[health.source]}，从 ${health.since} 起看不见；${projection.notices.some(n => n.kind === 'blind' && n.dedupeKey === `blind:${health.source}:${health.episodeId}` && projection.deliveredNoticeIds.has(n.id)) ? '已提醒，本轮去重' : '待写发件记录'}`);
    else if (health.fileFailures?.count) lines.push(`${toolNames[health.source]} 有 ${health.fileFailures.count} 份会话读不了，其余会话照常显示。`);
  }
  const day = projection.lastScanAt?.slice(0, 10);
  if (day && projection.modelCalls.has(day)) lines.push(`模型用量（UTC ${day}）：${projection.modelCalls.get(day)} 次；失败或额度用完的会话已标「仅规则判断」。`);
  const failed = projection.notices.filter(n => !isFeedbackSuppressed(n, projection.feedbackSuppressions) && projection.channelDeliveries.get(`local:${n.id}`) === false).length;
  if (failed) lines.push(`本机通知尚未成功：${failed} 条；已写发件记录，下轮检测重试。`);
  if (projection.feishuConnection) {
    const connection = projection.feishuConnection;
    const status = connection.state === 'connected' ? '已连接' : connection.state === 'fake' ? '假渠道（未连接真实飞书）'
      : connection.state === 'connecting' ? '未连接（连接中）' : connection.state === 'reconnecting' ? '未连接（重连中）' : '未连接';
    lines.push(`飞书长连接：${status}${connection.failure ? `；${connection.failure.category}：${connection.failure.message}` : ''}`);
  }
  const feishuFailed = projection.notices.filter(n => !isFeedbackSuppressed(n, projection.feedbackSuppressions) && projection.channelDeliveries.get(`feishu:${n.id}`) === false).length;
  if (feishuFailed) lines.push(`飞书尚未成功：${feishuFailed} 条；已写发件记录，下轮检测重试。`);
  return lines.join('\n');
}
