import { AGREEMENTS } from './intelligence-types.ts';
import type { Agreement } from './intelligence-types.ts';
import type { Projection } from './types.ts';

export interface ShadowStatisticCell {
  category: string; shadows: number; attempts: number; failed: number; blockedReads: number; blockedReminders: number;
  couldSkip: number; uncertainReferred: number; agreements: Record<Agreement, number>; agreementRate: number | null;
  owed: number; finished: number; unknown: number; correct: number; incorrect: number; needlessDaily: Record<string, number>;
}
export function intelligenceStatistics(projection: Projection, from: string, to: string): ShadowStatisticCell[] {
  const inPeriod = (at: string) => Date.parse(at) >= Date.parse(from) && Date.parse(at) <= Date.parse(to);
  const cells = new Map<string, ShadowStatisticCell>();
  for (const request of projection.analysisRequests.values()) {
    const result = projection.analysisResults.get(request.id), decision = projection.shadowDecisions.get(request.id);
    const comparison = projection.shadowComparisons.get(request.id), label = projection.shadowLabels.get(request.id);
    if (![result?.at, decision?.at, comparison?.at, label?.at].some(at => at && inPeriod(at))) continue;
    // 旧影子记录的离线统计，不再导入或启动分析行为。
    const category = `在等你 × ${result?.output?.actionType ?? request.actionType} × ${request.tool} × ${request.ruleRedline || result?.output?.redline ? '红线' : '非红线'}`;
    if (!cells.has(category)) cells.set(category, { category, shadows: 0, attempts: 0, failed: 0, blockedReads: 0, blockedReminders: 0,
      couldSkip: 0, uncertainReferred: 0, agreements: Object.fromEntries(AGREEMENTS.map(a => [a, 0])) as Record<Agreement, number>,
      agreementRate: null, owed: 0, finished: 0, unknown: 0, correct: 0, incorrect: 0, needlessDaily: {} });
    const cell = cells.get(category)!;
    if (result && inPeriod(result.at)) {
      cell.attempts++; cell.blockedReads += result.blockedReads.length;
      if (result.output && !result.failure) cell.shadows++; else cell.failed++;
    }
    if (decision && inPeriod(decision.at)) {
      if (decision.mode === 'blocked') cell.blockedReminders++;
      if (decision.mode === 'could_skip') cell.couldSkip++;
      if (decision.mode !== 'blocked' && (result?.output?.debt === '拿不准' || result?.output?.confidence !== '有把握')) cell.uncertainReferred++;
    }
    if (comparison && inPeriod(comparison.at)) {
      cell.agreements[comparison.agreement]++;
      if (comparison.agreement === '一致' && !request.ruleRedline && !result?.output?.redline) {
        const at = projection.shadowReplies.get(request.id)?.reply.at ?? comparison.at;
        const date = new Date(at), day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        cell.needlessDaily[day] = (cell.needlessDaily[day] ?? 0) + 1;
      }
    }
    if (label && inPeriod(label.at)) {
      if (label.debt === '当时欠你') cell.owed++; else if (label.debt === '聊完了') cell.finished++; else cell.unknown++;
      if (label.correct === true) cell.correct++; else if (label.correct === false) cell.incorrect++;
    }
  }
  for (const cell of cells.values()) {
    const total = cell.agreements['一致'] + cell.agreements['部分一致'] + cell.agreements['不一致'];
    cell.agreementRate = total ? cell.agreements['一致'] / total : null;
  }
  return [...cells.values()].sort((a, b) => a.category.localeCompare(b.category));
}
export function renderIntelligenceStatistics(cells: ShadowStatisticCell[]): string {
  return ['影子统计（类别 = 卡片类型 × 要你干什么 × 工具 × 红线；无法判断不计一致率分母）',
    ...cells.map(c => `${c.category} | 影子 ${c.shadows} | 一致/部分一致/不一致/无法判断 ${AGREEMENTS.map(a => c.agreements[a]).join('/')} | 一致率 ${c.agreementRate === null ? '—' : `${(c.agreementRate * 100).toFixed(1)}%`} | 被拦读取 ${c.blockedReads} | 挡掉提醒 ${c.blockedReminders} | 本可以不叫 ${c.couldSkip} | 拿不准转给你 ${c.uncertainReferred} | 当时欠你 ${c.owed} / 聊完了 ${c.finished} / 未定 ${c.unknown} | 判对 ${c.correct} / 判错 ${c.incorrect} | 失败 ${c.failed}\n  每天本来不用你：${Object.entries(c.needlessDaily).map(([day, count]) => `${day} ${count}`).join('；') || '0'}`),
    ...(cells.length ? [] : ['暂无影子记录'])].join('\n');
}
