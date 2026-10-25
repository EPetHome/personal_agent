import { basename } from 'node:path';
import { pushIdentity } from './events.ts';
import { compact, hash, shellQuote } from './utils.ts';
import { toolNames } from './types.ts';
import { membersOf, pushMatchesMember } from './sessions.ts';
import type { Config, JudgedRecord, Notice, NoticeContent, Projection, PushRecord, SessionRecord } from './types.ts';

const THIRTY_MINUTES = 30 * 60 * 1000;
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
      const push = latest && latest.at >= member.lastActivityAt ? latest : undefined;
      const waiting = push?.event === 'waiting_permission' ? push : undefined;
      const completed = !waiting && (member.sessionEnded || push?.event === 'session_end' || push?.event === 'turn_end' || (member.assistantFinished && !member.pendingTools.length));
      return { member, push, waiting, completed, lastActivityAt: push?.at ?? member.lastActivityAt };
    });
    judged.lastActivityAt = activities.reduce((last, activity) => activity.lastActivityAt > last ? activity.lastActivityAt : last, record.lastActivityAt);
    judged.pendingTools = activities.filter(a => !a.completed).flatMap(a => a.member.pendingTools);
    const waiting = activities.filter(a => a.waiting).sort((a, b) => comparePushes(a.waiting!, b.waiting!)).at(-1);
    if (projection.health.get(record.tool)?.since || (record.tool !== 'loop' && projection.health.get('inbox')?.since)) {
      judged.status = '看不见了';
      judged.reason = '来源或推送读取失败，保留最后一次读到的事实，当前状态不能确认';
    } else if (record.loop?.status === '暂停') {
      judged.status = '在等我';
      judged.reason = record.loop.conclusion;
    } else if (record.loop?.status === '完成') {
      judged.status = '已完成';
      judged.reason = 'loop 总结状态：完成';
    } else if (waiting?.waiting) {
      judged.status = '在等我';
      judged.reason = `${waiting.member.sessionId === record.sessionId ? '会话' : '子会话'}收到等授权事件，该会话之后没有新动静：${waiting.waiting.detail}`;
      judged.waiting = waiting.waiting;
    } else if (activities.every(a => a.completed)) {
      judged.status = '已完成';
      judged.reason = activities.length > 1 ? '父会话及子会话均已结束或本轮答完' : activities[0]?.push?.event === 'session_end' || record.sessionEnded ? '会话已结束' : '本轮助手已答完，且没有未返回的工具调用（本批规则判断）';
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
    ...(e.needs ? [`还欠什么：${e.needs.length ? e.needs.join('；') : '总结写明无'}`] : []),
    ...e.originals.map(original => `原件：${original.path}`),
  ].join('\n');
}
function createNotice(tool: Notice['tool'], kind: Notice['kind'], dedupeKey: string, at: string, content: NoticeContent, sessionKey?: string): Notice {
  return {
    version: 1, id: hash(dedupeKey), dedupeKey, at, tool, kind,
    level: kind === 'stalled' || kind === 'loop_completed' ? '有空看' : '现在就要你',
    ...(sessionKey ? { sessionKey } : {}), content, text: renderNotice(content),
  };
}
export function planNotices(records: JudgedRecord[], projection: Projection, config: Config, now: string): Notice[] {
  const candidates: Notice[] = [];
  for (const record of records) {
    let kind: Notice['kind'] | undefined;
    let key = '';
    let title = '';
    let summary = '';
    const ai = `${basename(record.project) || record.project} 的 ${toolNames[record.tool]}`;
    const waitingMember = record.waiting ? membersOf(record).find(member => pushMatchesMember(record.waiting!, member)) : undefined;
    const last = waitingMember?.pendingTools.at(-1)?.text ?? (record.waiting?.detail || undefined) ?? record.pendingTools.at(-1)?.text ?? record.recentSteps.at(-1)?.text ?? '尚未答完';
    if (record.loop && record.status !== '看不见了' && record.loop.status !== '进行中') {
      kind = record.loop.status === '暂停' ? 'loop_paused' : 'loop_completed';
      key = `${kind}:${record.key}:${hash(JSON.stringify(record.loop))}`;
      title = `${ai} ${record.loop.status === '暂停' ? '停下了，需要你决定' : '做完了，给你一份交代'}`;
      summary = `${record.project}：${record.loop.conclusion}；评审 ${record.loop.reviews} 次，返修 ${record.loop.repairs} 次。${record.loop.needs.join('；') || '总结写明没有待办。'}`;
    } else if (record.status === '在等我' && record.waiting) {
      kind = 'waiting';
      key = `waiting:${record.key}:${pushIdentity(record.waiting)}`;
      const child = record.waiting.sessionId !== record.sessionId;
      title = `${ai}${child ? ' 子会话' : ''} 在等你授权`;
      const scope = child ? `子会话${waitingMember?.project !== record.project ? `（${waitingMember?.project}）` : ''}` : '';
      summary = `${record.project}：${scope}在等你授权 ${last}。${record.waiting.detail}`;
    } else if (record.status === '停滞') {
      kind = 'stalled';
      key = `stalled:${record.key}`;
      title = `${ai} 干到一半没动静了`;
      const minutes = Math.floor((Date.parse(now) - Date.parse(record.lastActivityAt)) / 60000);
      summary = `${record.project}：最后在做 ${last}，已经 ${minutes} 分钟没有新记录，按规则判为停滞。`;
    }
    if (!kind) continue;
    const content: NoticeContent = {
      title, summary, returnCommand: returnCommand(record, config, record.waiting?.sessionId),
      evidence: {
        project: record.project, intentOriginal: record.intent.initial,
        additionalRequirements: record.intent.additions, recentSteps: waitingMember?.recentSteps ?? record.recentSteps,
        reason: record.reason, originals: record.originals,
        ...(record.loop ? { needs: record.loop.needs } : {}),
      },
    };
    const notice = createNotice(record.tool, kind, key, now, content, record.key);
    const already = projection.notices.some(n => n.dedupeKey === key);
    record.notice = projection.deliveredNoticeIds.has(notice.id) ? '已提醒，本轮去重' : '待写发件记录';
    if (!already) candidates.push(notice);
  }
  for (const health of projection.health.values()) {
    if (!health.since) continue;
    const key = `blind:${health.source}:${health.episodeId}`;
    if (projection.notices.some(n => n.dedupeKey === key)) continue;
    const content: NoticeContent = {
      title: `${toolNames[health.source]} 的盯防看不见了`,
      summary: `从 ${health.since} 起读不了 ${toolNames[health.source]}，当前状态不能确认；其他来源继续检测。`,
      returnCommand: `open ${shellQuote(health.paths[0] ?? config.dataDir)}`,
      evidence: {
        project: null, intentOriginal: null, additionalRequirements: [], recentSteps: [],
        reason: health.errors.map(error => compact(error, 500)).join('\n'), originals: [],
      },
    };
    candidates.push(createNotice(health.source, 'blind', key, now, content));
  }
  return candidates;
}
export function renderOverview(records: JudgedRecord[], projection: Projection): string {
  const lines = ['工具 | 项目 | 意图 | 状态 | 最后活动时间 | 提醒'];
  for (const record of records) {
    const intent = [record.intent.initial ?? '总结未提供开工指令', ...record.intent.additions].join('；');
    lines.push([toolNames[record.tool], record.project, compact(intent), record.status, record.lastActivityAt, record.notice ?? '—'].map(v => v.replaceAll('|', '｜').replace(/[\r\n]/g, ' ')).join(' | '));
  }
  if (!records.length) lines.push('暂无会话');
  for (const health of projection.health.values()) {
    if (health.since) lines.push(`盯防异常：${toolNames[health.source]}，从 ${health.since} 起看不见；${projection.notices.some(n => n.kind === 'blind' && n.dedupeKey === `blind:${health.source}:${health.episodeId}` && projection.deliveredNoticeIds.has(n.id)) ? '已提醒，本轮去重' : '待写发件记录'}`);
  }
  return lines.join('\n');
}
