import { compact } from './utils.ts';

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
    .replace(/[+]?[0-9]{4,6}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, at => localTime(at, now))
    .replace(/(?:~\/|\/)[^\s，；。！？、'"<>]+/g, '相关文件')
    .replace(/[A-Za-z0-9_.-]+\.(?:jsonl|json|[cm]?[jt]sx?|md|txt|log|lock)\b(?::\d+(?::\d+)?)?/g, '相关文件').replace(/第\s*\d+\s*行/g, '')
    .replace(/\b(?:Read|read)[:：]?\s*/g, '查看文件：').replace(/\b(?:Edit|Write|edit|write)[:：]?\s*/g, '修改文件：').replace(/\b(?:Bash|bash)[:：]?\s*/g, '运行命令：')
    .replace(/transcript(?:_path)?/gi, '会话记录').replace(/推送/g, '报信').replace(/对账/g, '核对').replace(/来源/g, '记录');
}
export function firstScreen(who: string, what: string, action: string): string {
  return `谁：${who}\n出了什么事：${what}\n要不要你管：${action}`;
}

/** 有界保留回复首尾和换行，避免长表格挤掉末尾的问题。 */
export function replyExcerpt(text: string): string {
  const chars = [...text.trim()];
  return chars.length <= 1200 ? chars.join('') : chars.slice(0, 400).join('') + '\n…\n' + chars.slice(-790).join('');
}
export function readableLines(text: string, project = ''): string[] {
  let fence = '';
  const result: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
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
  const sentences = readableLines(reply, project).flatMap(line => line.split(/(?<=[。！？!?])\s*/)).map(s => s.trim()).filter(Boolean);
  const question = sentences.findLast(s => /[？?]/.test(s));
  const action = question ?? sentences.findLast(s => /请|需要你|等你|是否|允许|授权|你(?:要|想|选|希望)/.test(s));
  return compact(action ?? fallback, 240);
}
