import { readFeedback } from './feedback.ts';
import { readOutbox } from './store.ts';
import { iso } from './utils.ts';
import { toolNames } from './types.ts';
import type { Feedback, Notice } from './types.ts';

export const kindNames: Record<Notice['kind'], string> = { waiting: '在等你', drift: '疑似跑偏', stalled: '停滞', blind: '看不见了', unreadable: '会话读不了', loop_paused: 'loop 暂停', loop_completed: 'loop 完成', weekly: '每周小结', recurrence: '同类问题', service_restart: '常驻重启' };
export function localDate(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function weekStart(now: string): string { const date = new Date(now); date.setDate(date.getDate() - 7); return date.toISOString(); }
export interface StatisticCell {
  tool: string; kind: string; sent: number; correct: number; falsePositive: number; missed: number; responded: number;
  accuracy: number | null; responseRate: number | null; perDay: number; daily: Record<string, number>; sufficient: boolean;
}
export interface Statistics { from: string; to: string; cells: StatisticCell[] }
export function feedbackCategory(feedback: Feedback, linked?: Notice): { tool: string; kind: string } {
  if (linked) return { tool: linked.tool, kind: linked.kind };
  const text = feedback.comment;
  const tool = /\bloop\b/i.test(text) ? 'loop' : /\bcodex\b/i.test(text) ? 'codex' : /\bpi\b/i.test(text) ? 'pi' : /\bcc\b|claude/i.test(text) ? 'cc' : '未指定';
  const kind = /暂停/.test(text) ? 'loop_paused' : /跑偏/.test(text) ? 'drift' : /停滞|卡住/.test(text) ? 'stalled' : /等|授权/.test(text) ? 'waiting' : /看不见|失明/.test(text) ? 'blind' : '未指定';
  return { tool, kind };
}
/** 每个提醒只取截至统计时刻的最后一次正确/误报；漏报逐条计数；无回应绝不算正确。 */
export function calculateStatistics(notices: Notice[], feedback: Feedback[], nowInput: string, fromInput?: string): Statistics {
  const now = iso(nowInput), from = iso(fromInput ?? weekStart(now));
  const included = notices.filter(n => !['weekly', 'recurrence', 'service_restart'].includes(n.kind));
  const lookup = new Map(included.map(n => [n.id, n]));
  const cells = new Map<string, StatisticCell>();
  const startDate = new Date(from), endDate = new Date(now);
  const days = Math.max(1, (Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()) - Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())) / 86400000);
  function get(tool: string, kind: string) {
    const key = `${tool}:${kind}`;
    if (!cells.has(key)) cells.set(key, { tool, kind, sent: 0, correct: 0, falsePositive: 0, missed: 0, responded: 0, accuracy: null, responseRate: null, perDay: 0, daily: {}, sufficient: false });
    return cells.get(key)!;
  }
  const inPeriod = (at: string) => Date.parse(at) >= Date.parse(from) && Date.parse(at) <= Date.parse(now);
  const latest = new Map<string, Feedback>();
  for (const row of feedback.filter(f => Date.parse(f.at) <= Date.parse(now)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (row.noticeId && row.verdict !== '漏了') latest.set(row.noticeId, row);
    if (row.verdict === '漏了' && inPeriod(row.at)) {
      const category = feedbackCategory(row, row.noticeId ? lookup.get(row.noticeId) : undefined);
      get(category.tool, category.kind).missed++;
    }
  }
  for (const notice of included.filter(n => inPeriod(n.at))) {
    const cell = get(notice.tool, notice.kind);
    cell.sent++;
    const date = localDate(notice.at); cell.daily[date] = (cell.daily[date] ?? 0) + 1;
    const response = latest.get(notice.id);
    if (response) { cell.responded++; if (response.verdict === '正确') cell.correct++; else cell.falsePositive++; }
    else if (feedback.some(f => f.noticeId === notice.id && Date.parse(f.at) <= Date.parse(now) && f.verdict === '漏了')) cell.responded++;
  }
  for (const cell of cells.values()) {
    const classified = cell.correct + cell.falsePositive;
    cell.accuracy = classified ? cell.correct / classified : null;
    cell.responseRate = cell.sent ? cell.responded / cell.sent : null;
    cell.perDay = cell.sent / days; cell.sufficient = classified >= 20;
  }
  return { from, to: now, cells: [...cells.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.kind.localeCompare(b.kind)) };
}
export async function statistics(dataDir: string, now = new Date().toISOString()): Promise<Statistics> {
  return calculateStatistics(await readOutbox(dataDir), await readFeedback(dataDir), now);
}
export function renderStatistics(stats: Statistics): string {
  const percent = (n: number | null) => n === null ? '—' : `${(n * 100).toFixed(1)}%`;
  return [`反馈统计（${stats.from} ～ ${stats.to}）`, '工具 × 提醒类型 | 发出 | 正确 / 误报 | 准确率 | 漏了 | 回应率 | 每天叫几次', ...stats.cells.map(c => `${toolNames[c.tool as keyof typeof toolNames] ?? c.tool} × ${kindNames[c.kind as Notice['kind']] ?? c.kind} | ${c.sent} | ${c.correct} / ${c.falsePositive} | ${percent(c.accuracy)} | ${c.missed} | ${percent(c.responseRate)}（${c.responded}/${c.sent}） | ${c.perDay.toFixed(2)}${c.sufficient ? '' : '（不足 20 条，只列数字）'}\n  每日：${Object.entries(c.daily).map(([date, n]) => `${date} ${n}`).join('；') || '0'}`), ...(stats.cells.length ? [] : ['暂无发件或反馈'])].join('\n');
}
