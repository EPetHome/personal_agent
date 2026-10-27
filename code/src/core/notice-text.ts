import { compact } from './utils.ts';

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
