import { basename } from 'node:path';
import { emptyRecord, iso, requiredString, truncateText } from '../../core/utils.ts';
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
  let counts: RegExpMatchArray | null = null;
  let needsProvided = false;
  let inNeeds = false;
  const needs: string[] = [];
  for (const line of lines) {
    if (/^#\s+自动评审总结/.test(line) || /^- 状态[：:]/.test(line)) recognized = true;
    project ??= line.match(/^- 项目[：:]\s*(.+)$/)?.[1]?.trim();
    conclusion ??= line.match(/^- 状态[：:]\s*(.+)$/)?.[1]?.trim();
    sessionId ??= line.match(/^- 开发会话[：:]\s*(\S+)/)?.[1];
    counts ??= line.match(/评审\s*(\d+)\s*次[，,、\s]*返修\s*(\d+)\s*次/);
    const round = line.match(/### 第\s*\d+\s*轮[（(](\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)/);
    if (round) lastRound = `${round[1]}T${round[2]}`;
    if (/^## 需要你做的事/.test(line)) { needsProvided = true; inNeeds = true; continue; }
    if (/^## /.test(line)) inNeeds = false;
    if (inNeeds) {
      const need = line.replace(/^[-*]\s*/, '').trim();
      if (need && need !== '无') needs.push(truncateText(need, 1000));
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
  record.loop = { status, conclusion: actualConclusion, reviews: Number(counts[1]), repairs: Number(counts[2]), needs, needsProvided };
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
