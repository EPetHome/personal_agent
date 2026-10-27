import { compact, intentText } from './utils.ts';
import type { Notice, NoticeContent, SessionRecord } from './types.ts';

/** 按运行机器当地日历显示，不把 UTC 或跨夏令时的24小时差当作「昨天」。 */
export function localTime(at: string, now: string): string {
  const date = new Date(at), current = new Date(now);
  if (!Number.isFinite(date.getTime())) return '时间暂不清楚';
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = (day(current) - day(date)) / 86400000;
  const hour = date.getHours();
  const label = days === 0 ? hour >= 18 ? '今晚' : hour < 6 ? '今天凌晨' : hour < 12 ? '今天上午' : '今天下午'
    : days === 1 ? '昨天' : `${date.getFullYear() === current.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
  return `${label} ${String(hour).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
/** 第一屏只讲人话；原文完整保留在证据，不泄漏中枢路径/行号。 */
export function humanText(text: string, project: string, now: string): string {
  return readableLines(text, project).join('；')
    .replace(/[+]?[0-9]{4,6}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g, at => localTime(at, now))
    .replace(/(\d\d:\d\d)(?=[\p{L}\p{N}])/gu, '$1 ')
    .replace(/(?:第\s*\d+\s*行|\b(?:line\s*\d+|L\d+(?:-L?\d+)?))/gi, '')
    .replace(/(?:[A-Za-z]:\\|(?:\.{1,2}|~)?\/)[^\s，；。！？、：'"<>]+/g, '相关文件')
    .replace(/\b[\w.-]+(?:\/[\w.-]+)+(?::\d+(?::\d+)?)?/g, '相关文件')
    .replace(/[A-Za-z0-9_.-]+\.(?:jsonl|json|[cm]?[jt]sx?|md|txt|log|lock)\b(?::\d+(?::\d+)?)?/g, '相关文件')
    .replace(/\b(?:Read|read)[:：]?\s*/g, '查看文件：').replace(/\b(?:Edit|Write|edit|write)[:：]?\s*/g, '修改文件：').replace(/\b(?:Bash|bash)[:：]?\s*/g, '运行命令：')
    .replace(/transcript(?:_path)?/gi, '会话记录').replace(/推送/g, '报信').replace(/对账/g, '核对').replace(/来源/g, '记录');
}
export function firstScreen(situation: string, action: string): string {
  return `这件事：${situation}\n\n要你做：${action}`;
}
/** 每块只留一句短话；完整起草与溢出文字进证据。旧版发件也能渲染，不改原记录。 */
export function noticeSections(content: NoticeContent): { situation: string; action: string } {
  const situation = content.situation ?? /(?:^|\n)这件事：([^\n]*)/.exec(content.summary)?.[1]
    ?? /(?:^|\n)出了什么事：([^\n]*)/.exec(content.summary)?.[1] ?? content.summary;
  const action = content.action ?? /(?:^|\n)(?:要你做|要不要你管)：([^\n]*)/.exec(content.summary)?.[1] ?? '不用管，只是告诉你';
  return { situation, action };
}
export function presentNotice(content: NoticeContent, situation: string, action: string, now: string): NoticeContent {
  const project = content.evidence.project ?? '';
  const short = (text: string, limit: number) => compact(humanText(text, project, now).replace(/^(?:这件事|要你做)[:：]\s*/, ''), limit);
  const what = short(situation, 100) || '这件事暂时说不清，请回会话查看';
  const todo = short(action, 58) || '请回到会话确认下一步';
  return { ...content, title: compact(humanText(content.title, project, now), 72),
    situation: what, action: todo,
    summary: firstScreen(what, todo),
    evidence: { ...content.evidence, presentation: content.evidence.presentation ?? { situation, action } } };
}
export function noticeTimeAndReturn(notice: Notice): string {
  return `${localTime(notice.evidenceAt ?? notice.at, notice.at)}\n${notice.content.returnCommand}`;
}
export function localNoticeText(notice: Notice): string {
  const raw = noticeSections(notice.content), sections = noticeSections(presentNotice(notice.content, raw.situation, raw.action, notice.at));
  return `${firstScreen(sections.situation, sections.action)}\n\n时间 / 回去看：${noticeTimeAndReturn(notice)}`;
}
/** 长会话不能拿「合入。」等操作词当任务，优先最近一条有内容的真人要求。 */
export function currentTask(record: SessionRecord): string {
  return [record.intent.initial ?? '', ...record.intent.additions].reverse()
    .map(text => readableLines(text, record.project).join('；'))
    .find(text => text && !/^(?:合入|继续|好的?|可以|同意|收到|开始|确认|是|否|行|没问题|继续吧|你来做)[。.!！\s]*$/.test(text)) ?? '意图不明';
}

/** 无模型文案时，只用真人要求和最后的问题，改成陈述卡点，不重复整句动作。 */
export function waitingSituation(record: SessionRecord, reply: string): string {
  const question = requestedAction(reply, record.project, '').replace(/^请(?:你)?(?:确认|选择)?\s*/, '').replace(/[？?。！!]/g, '').trim();
  return `${currentTask(record)}：${question ? `${compact(question, 100)}，待你确认` : '停下来等你确认下一步'}`;
}

/** 有界保留回复首尾和换行，避免长表格挤掉末尾的问题。 */
export function replyExcerpt(text: string): string {
  const chars = [...text.trim()];
  return chars.length <= 1200 ? chars.join('') : chars.slice(0, 400).join('') + '\n…\n' + chars.slice(-790).join('');
}
export function readableLines(text: string, project = ''): string[] {
  let fence = '';
  const result: string[] = [];
  for (const raw of intentText(text).split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker) { if (!fence) fence = marker[0]!; else if (marker[0] === fence) fence = ''; continue; }
    if (fence || /^\s*(?:\|.*\||(?:[-:]\s*){3,}\|)/.test(raw) || (raw.match(/\|/g)?.length ?? 0) >= 2) continue;
    const line = (project ? raw.replaceAll(project, '这个项目') : raw)
      .replace(/^\s*(?:#{1,6}\s*|[-*>]\s+|\d+[.)、]\s+)/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')
      .replace(/([。！？!?；;，,：:])\1+/g, '$1').replace(/\.{2,}/g, '…').trim();
    if (line) result.push(line);
  }
  return [...new Set(result)];
}
/** 先挑真正的问题/要做的事，不拿模型解释代替助手的话。 */
export function requestedAction(reply: string, project: string, fallback = '请回到会话确认下一步。'): string {
  const raw = intentText(reply).split(/\r?\n/), candidates: { text: string; items?: string[] }[] = [];
  let fence = '';
  for (let i = 0; i < raw.length; i++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw[i]!)?.[1];
    if (marker) { if (!fence) fence = marker[0]!; else if (marker[0] === fence) fence = ''; continue; }
    if (fence) continue;
    const line = readableLines(raw[i]!, project)[0];
    if (!line) continue;
    const items: string[] = [];
    let end = i + 1;
    if (/[:：]$/.test(line)) {
      while (end < raw.length) {
        if (!raw[end]!.trim()) { end++; continue; }
        const match = /^\s*(?:[-+*]\s+|\d+[.)、]\s+)(?:\[[ xX]\]\s*)?(.+)$/.exec(raw[end]!);
        if (match) items.push(...readableLines(match[1]!, project));
        else if (items.length && /^\s{2,}\S/.test(raw[end]!)) items[items.length - 1] += ' ' + readableLines(raw[end]!, project).join('；');
        else break;
        end++;
      }
    }
    // 引子和列表是同一个动作；列表里的「请/需要你/问号」不能把它拆成只剩最后一项。
    if (items.length) { candidates.push({ text: line, items }); i = end - 1; }
    else for (const text of line.split(/(?<=[。！？!?])\s*/).map(s => s.trim()).filter(Boolean)) candidates.push({ text });
  }
  const whole = (candidate: typeof candidates[number]) => [candidate.text, ...(candidate.items ?? [])].join('；');
  const action = candidates.findLast(s => /[？?]/.test(whole(s)))
    ?? candidates.findLast(s => /请|需要你|等你|是否|允许|授权|你(?:要|想|选|希望)/.test(whole(s)));
  if (action?.items) return compact(`${compact(action.text, 100)} ${action.items.join('；')}`, 240);
  return compact(action?.text ?? fallback, 240);
}
