import { agentNotice } from './learning.ts';
import { renderNotice } from './judge.ts';
import { localDate } from './statistics.ts';
import { renderIntelligenceStatistics, intelligenceStatistics } from './intelligence-statistics.ts';
import { completedAnalysis, shadowSessionName } from './intelligence.ts';
import type { Notice, Projection } from './types.ts';

/** 当地20:00；停机后补最近时点，不补首次接入前历史。20点以后的新事实归入下一次，避免漏汇总。 */
export function dailyIntelligence(projection: Projection, now: string): Notice | null {
  const slot = new Date(now); slot.setHours(20, 0, 0, 0);
  if (slot.getTime() > Date.parse(now)) slot.setDate(slot.getDate() - 1);
  const at = slot.toISOString(), key = `daily-intelligence:${localDate(slot)}`;
  if (!projection.startedAt || at < projection.startedAt || projection.notices.some(n => n.dedupeKey === key)) return null;
  const previous = projection.notices.filter(n => n.kind === 'daily' && n.intelligencePeriod && n.intelligencePeriod.to < at)
    .sort((a, b) => a.intelligencePeriod!.to.localeCompare(b.intelligencePeriod!.to)).at(-1);
  const from = previous?.intelligencePeriod?.to ?? projection.startedAt;
  // 已汇总的边界时刻不重复计数。
  const begin = previous ? new Date(Date.parse(from) + 1).toISOString() : from;
  const cells = intelligenceStatistics(projection, begin, at);
  if (!cells.length) return null;
  const blocked = new Map<string, string>();
  for (const decision of projection.shadowDecisions.values()) {
    if (decision.mode !== 'blocked' || decision.at < begin || decision.at > at) continue;
    const request = projection.analysisRequests.get(decision.analysisId);
    const output = request && completedAnalysis(projection, request)?.output;
    if (request && output) blocked.set(`${request.tool}:${request.sessionId}`, `${shadowSessionName(request)}：${output.situation}；已交代完：${output.reason}`);
  }
  const count = cells.reduce((sum, cell) => sum + cell.blockedReminders, 0), uncertain = cells.reduce((sum, cell) => sum + cell.uncertainReferred, 0);
  const details = `每日汇总（当地20:00；上次汇总后至本次时点）\n今天挡掉的提醒：${count} 次\n${[...blocked.values()].join('\n') || '无'}\n拿不准转给你：${uncertain} 次\n${renderIntelligenceStatistics(cells)}`;
  // 建议、意图草稿和你的实际回复都不离开本机；这里只出数字及明确准许汇总的挡提醒理由。
  const notice = agentNotice('daily', key, now, 'personal agent 的每日汇总', details,
    'node code/src/cli/main.ts stats --config <你运行时使用的配置文件>');
  notice.intelligencePeriod = { from: begin, to: at };
  notice.content.evidence.reason = details;
  notice.text = renderNotice(notice.content, now);
  return notice;
}
