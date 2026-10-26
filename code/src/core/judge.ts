import { basename } from 'node:path';
import { pushIdentity } from './events.ts';
import { compact, hash, shellQuote, truncateUtf8 } from './utils.ts';
import { toolNames } from './types.ts';
import { membersOf, pushMatchesMember } from './sessions.ts';
import type { Config, EventPayload, JudgedRecord, Notice, NoticeContent, Projection, PushRecord, SessionRecord } from './types.ts';

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
export function renderNotice(content: NoticeContent): string {
  const e = content.evidence;
  return [
    content.title, content.summary, `回去看：${content.returnCommand}`,
    '证据：', `项目：${e.project ?? '来源读取故障，项目暂不可知'}`,
    `意图原文：${e.intentOriginal ?? '原件未提供开工指令，未推测'}`,
    '你后来追加的要求：', ...(e.additionalRequirements.length ? e.additionalRequirements.map(text => `- ${text}`) : ['- 无']),
    '最近几步：', ...(e.recentSteps.length ? e.recentSteps.map(step => `- ${step.at} ${step.text}`) : ['- 暂不可读']),
    `判断依据：${e.reason}`,
    ...(e.needs ? [`还欠什么：${e.needsProvided === false ? '总结里没写' : e.needs.length ? e.needs.join('；') : '总结写明无'}`] : []),
    ...e.originals.map(original => `原件：${original.path}`),
  ].join('\n');
}
function createNotice(tool: Notice['tool'], kind: Notice['kind'], dedupeKey: string, at: string, content: NoticeContent, sessionKey?: string): Notice {
  return {
    version: 1, id: hash(dedupeKey), dedupeKey, at, tool, kind,
    level: kind === 'stalled' || kind === 'loop_completed' ? '有空看' : '现在就要你',
    ...(sessionKey ? { sessionKey } : {}), content,
    text: kind === 'blind' || kind === 'unreadable' ? truncateUtf8(renderNotice(content), 4096) : renderNotice(content),
  };
}
export function planNotices(records: JudgedRecord[], projection: Projection, config: Config, now: string, suppressed?: EventPayload[]): Notice[] {
  const candidates: Notice[] = [];
  for (const record of records) {
    if (record.status === '已搁置') continue;
    let kind: Notice['kind'] | undefined;
    let key = '';
    let title = '';
    let summary = '';
    const ai = `${basename(record.project) || record.project} 的 ${toolNames[record.tool]}`;
    const waitingMember = record.waiting ? membersOf(record).find(member => pushMatchesMember(record.waiting!, member))
      : record.modelWaiting ? membersOf(record).find(member => member.sessionId === record.modelWaiting!.sessionId) : undefined;
    const last = (record.modelWaiting ? waitingMember?.assistantReply?.text : undefined) ?? waitingMember?.pendingTools.at(-1)?.text ?? (record.waiting?.detail || undefined) ?? record.pendingTools.at(-1)?.text ?? record.recentSteps.at(-1)?.text ?? '尚未答完';
    if (record.loop && record.status !== '看不见了' && record.loop.status !== '进行中') {
      kind = record.loop.status === '暂停' ? 'loop_paused' : 'loop_completed';
      key = `${kind}:${record.key}:${hash(JSON.stringify(record.loop))}`;
      title = `${ai} ${record.loop.status === '暂停' ? '停下了，需要你决定' : '做完了，给你一份交代'}`;
      summary = `${record.project}：${record.loop.conclusion}；评审 ${record.loop.reviews} 次，返修 ${record.loop.repairs} 次。${record.loop.needsProvided === false ? '总结里没写' : record.loop.needs.join('；') || '总结写明没有待办。'}`;
    } else if (record.status === '在等我' && record.waiting) {
      kind = 'waiting';
      key = `waiting:${record.key}:${pushIdentity(record.waiting)}`;
      const child = record.waiting.sessionId !== record.sessionId;
      title = `${ai}${child ? ' 子会话' : ''} 在等你授权`;
      const scope = child ? `子会话${waitingMember?.project !== record.project ? `（${waitingMember?.project}）` : ''}` : '';
      summary = `${record.project}：${scope}在等你授权 ${last}。${record.waiting.detail}`;
    } else if (record.status === '在等我' && record.modelWaiting) {
      kind = 'waiting';
      key = `model_waiting:${record.key}:${record.modelWaiting.fingerprint}`;
      title = `${ai} 在等你回复`;
      summary = `${record.project}：可能在等你回复；${record.modelWaiting.result.reason}。做到哪了：${last}。`;
    } else if (record.status === '疑似跑偏' && record.drift) {
      kind = 'drift';
      key = `drift:${record.key}:${record.drift.fingerprint}`;
      title = `${ai} 疑似跑偏`;
      summary = `${record.project}：可能跑偏。意图是「${record.drift.result.intentQuote}」，实际在做「${record.drift.result.stepQuote}」；对不上：${record.drift.result.reason}`;
    } else if (record.status === '停滞') {
      kind = 'stalled';
      key = `stalled:${record.key}`;
      title = `${ai} 干到一半没动静了`;
      const minutes = Math.floor((Date.parse(now) - Date.parse(record.lastActivityAt)) / 60000);
      summary = `${record.project}：最后在做 ${last}，已经 ${minutes} 分钟没有新记录，按规则判为停滞。`;
    }
    if (!kind) continue;
    if (kind === 'waiting') summary += ` 意图：${compact(record.intent.initial ?? '原件未提供', 120)}；做到哪了：${compact(last, 160)}；等你做什么：${compact(record.waiting?.detail ?? record.modelWaiting?.result.reason ?? record.reason, 200)}。`;
    const already = projection.notices.some(n => n.dedupeKey === key);
    const evidenceAt = record.waiting?.at ?? record.modelWaiting?.evidenceAt ?? record.drift?.evidenceAt ?? record.lastActivityAt;
    if (!already && projection.startedAt && Date.parse(evidenceAt) < Date.parse(projection.startedAt) - FIRST_LOOKBACK) {
      record.notice = '首次接入历史记录，不补发';
      if (projection.suppressedNotices.get(key) !== evidenceAt) suppressed?.push({ kind: 'notice_suppressed', dedupeKey: key, evidenceAt });
      continue;
    }
    const content: NoticeContent = {
      title, summary, returnCommand: returnCommand(record, config, record.waiting?.sessionId ?? record.modelWaiting?.sessionId),
      evidence: {
        project: record.project, intentOriginal: record.intent.initial,
        additionalRequirements: record.intent.additions, recentSteps: waitingMember?.recentSteps ?? record.recentSteps,
        reason: record.reason, originals: record.originals,
        ...(record.loop ? { needs: record.loop.needs, needsProvided: record.loop.needsProvided } : {}),
      },
    };
    const notice = createNotice(record.tool, kind, key, now, content, record.key);
    if (record.modelWaiting) notice.memberSessionId = record.modelWaiting.sessionId;
    record.notice = projection.deliveredNoticeIds.has(notice.id) ? '已提醒，本轮去重' : '待写发件记录';
    if (!already) candidates.push(notice);
  }
  for (const health of projection.health.values()) {
    const kind = health.since ? 'blind' : health.fileFailures?.count ? 'unreadable' : null;
    if (!kind) continue;
    const key = `${kind}:${health.source}:${kind === 'blind' ? health.episodeId : health.fileFailureEpisodeId}`;
    if (projection.notices.some(n => n.dedupeKey === key)) continue;
    const failures = health.fileFailures;
    const content: NoticeContent = {
      title: kind === 'blind' ? `${toolNames[health.source]} 的盯防看不见了`
        : `${toolNames[health.source]} 有 ${failures!.count} 份会话读不了`,
      summary: kind === 'blind' ? `从 ${health.since} 起读不了 ${toolNames[health.source]}，当前状态不能确认；其他来源继续检测。`
        : `从 ${health.fileFailureSince} 起发现 ${failures!.count} 份会话读不了；其余会话照常判断和显示。`,
      returnCommand: `open ${shellQuote(health.paths[0] ?? config.dataDir)}`,
      evidence: {
        project: null, intentOriginal: null, additionalRequirements: [], recentSteps: [],
        reason: [...(kind === 'blind' ? health.errors.slice(0, 3) : []), ...(failures?.examples.slice(0, 3) ?? [])]
          .map(error => compact(error, 240)).join('\n'), originals: [],
      },
    };
    candidates.push(createNotice(health.source, kind, key, now, content));
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
  const failed = projection.notices.filter(n => projection.channelDeliveries.get(`local:${n.id}`) === false).length;
  if (failed) lines.push(`本机通知尚未成功：${failed} 条；已写发件记录，下轮检测重试。`);
  const feishuFailed = projection.notices.filter(n => projection.channelDeliveries.get(`feishu:${n.id}`) === false).length;
  if (feishuFailed) lines.push(`飞书尚未成功：${feishuFailed} 条；已写发件记录，下轮检测重试。`);
  return lines.join('\n');
}
