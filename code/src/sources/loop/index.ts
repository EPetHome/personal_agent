import { basename } from 'node:path';
import { compact, emptyRecord, iso, requiredString, truncateText } from '../../core/utils.ts';
import type { Original, SessionRecord, SourceComponent, SourceReadContext } from '../../core/types.ts';

export function isLoopSummary(name: string): boolean {
  return /^(?:(?:claude|codex)-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i.test(name);
}
function parseLines(lines: Iterable<string>, original: Original, context?: SourceReadContext): SessionRecord | null {
  if (!isLoopSummary(basename(original.path))) return null;
  let recognized = false;
  let project: string | undefined;
  let conclusion: string | undefined;
  let sessionId: string | undefined;
  let lastRound: string | undefined;
  let batch: string | undefined, phase: string | undefined, reviewSession: string | undefined;
  const acceptanceSessions: string[] = [];
  let lastConclusion = '';
  let counts: RegExpMatchArray | null = null;
  let needsDepth = 0;
  let fenced = false;
  const needs: string[] = [];
  for (const line of lines) {
    if (/^#\s+自动评审总结/.test(line) || /^- 状态[：:]/.test(line)) recognized = true;
    project ??= line.match(/^- 项目[：:]\s*(.+)$/)?.[1]?.trim();
    conclusion ??= line.match(/^- 状态[：:]\s*(.+)$/)?.[1]?.trim();
    sessionId ??= line.match(/^- 开发会话[：:]\s*(\S+)/)?.[1];
    reviewSession ??= line.match(/评审会话[：:]\s*(\S+)/)?.[1];
    const acceptance = line.match(/验收会话[：:]\s*(\S+)/)?.[1];
    if (acceptance) acceptanceSessions.push(acceptance);
    batch ??= line.match(/^- (?:批次|任务)[：:]\s*(.+)$/)?.[1]?.trim();
    phase ??= line.match(/^- 当前(?:阶段|步骤)[：:]\s*(开发|评审(?:第?\s*\d+\s*轮)?|验收)/)?.[1];
    if (/^- 验收命令[：:]\s*(?:进行中|运行中)/.test(line)) phase = '验收';
    if (/^结论[：:]/.test(line)) lastConclusion = line;
    counts ??= line.match(/评审\s*(\d+)\s*次[，,、\s]*返修\s*(\d+)\s*次/);
    const round = line.match(/### 第\s*\d+\s*轮[（(](\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)/);
    if (round) lastRound = `${round[1]}T${round[2]}`;
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (/需要你做的事|小问题汇总|验收额外发现/.test(heading[2]!)) needsDepth = heading[1]!.length;
      else if (needsDepth && heading[1]!.length <= needsDepth) needsDepth = 0;
      continue;
    }
    if (needsDepth || /\[人工\]/.test(line)) {
      if (/^\s*[-*]\s*\[[xX]\]/.test(line)) continue;
      const raw = line.replace(/^\s*[-*]\s*(?:\[ \]\s*)?/, '').trim();
      if (/^\|?[\s:|-]+\|?$/.test(raw) || /^\|\s*(?:#|编号|序号|验收项|事项|问题)\s*\|/.test(raw)) continue;
      const need = compact(raw.replace(/^\||\|$/g, '').replace(/\s*\|\s*/g, '；'), 1000);
      if (need && !/^(?:无|暂无|没有)(?:新增)?(?:待办|欠项|小问题|额外发现)?[。.!！]?$/.test(need) && !needs.includes(need)) needs.push(truncateText(need, 1000));
    }
  }
  if (!recognized) throw new Error('无法识别 loop 总结格式');
  const actualProject = requiredString(project, 'loop 总结的「- 项目：」');
  const actualConclusion = requiredString(conclusion, 'loop 状态');
  const status = actualConclusion.startsWith('暂停') ? '暂停' : actualConclusion === '完成' ? '完成' : actualConclusion === '进行中' ? '进行中' : null;
  if (!status) throw new Error('无法识别 loop 状态');
  if (!counts) throw new Error('loop 总结缺少评审/返修次数');
  // 无时区轮次是运行机器的当地时间（遵循 OS/TZ 的夏令时），不是 UTC。
  const at = lastRound ? new Date(lastRound).toISOString() : iso(context?.modifiedAt, 'loop 原件修改时间');
  const record = emptyRecord('loop', sessionId ?? basename(original.path, '.md'), actualProject, at, original);
  record.type = 'loop_run';
  const reviews = Number(counts[1]);
  record.loop = { status, conclusion: actualConclusion, ...(lastConclusion ? { summary: compact(lastConclusion.replace(/^结论[：:]\s*/, ''), 600) } : {}), reviews, repairs: Number(counts[2]), needs, needsProvided: true,
    ...(batch ? { batch } : {}), phase: phase ?? (status === '完成' ? '已完成' : /需返修|不通过/.test(lastConclusion) || !reviews ? '开发' : /通过/.test(lastConclusion) ? '验收' : `评审第 ${reviews + 1} 轮`),
    sessions: { development: record.sessionId, review: reviewSession ?? `autoreview-rev-${record.sessionId}`,
      acceptance: [...acceptanceSessions, `autoreview-acc-${record.sessionId}`, `autoreview-acc-strong-${record.sessionId}`] },
  };
  record.assistantFinished = status === '完成';
  record.recentSteps = [{ at, text: `状态：${actualConclusion}` }, ...needs.slice(-7).map(text => ({ at, text }))];
  return record;
}
export const loop: SourceComponent = {
  tool: 'loop', extension: '.md', parseLines,
  identify(text) {
    const project = text.match(/^- 项目[：:]\s*(.+)$/m)?.[1]?.trim();
    const sessionId = text.match(/^- 开发会话[：:]\s*(\S+)/m)?.[1];
    return project ? { sessionId: sessionId ?? '', project } : null;
  },
  parse(text, original, context) { return parseLines(text.split('\n'), original, context); },
};
