import { humanText, readableLines, requestedAction } from './notice-text.ts';
import { compact } from './utils.ts';
import type { TaskActionItem, TaskActionLabel, TaskSnapshotInput } from './types.ts';

export const actionLabels: readonly TaskActionLabel[] = ['回复会话', '你去做', '要你定·红线', '不用管'];
/** 在清理路径/截短之前硬判；模型标签和建议都不能降级红线。 */
export function isRedline(text: string): boolean {
  return /删除|删掉|删去|清空|清除|清理(?:旧|过期|缓存|临时)?(?:文件|目录|数据)|移除|销毁|抹掉|合入|合并|推到远端|推送(?:到|至)?(?:远端|远程|origin|分支|代码)|远端推|对外|发消息|发送消息|发给|发邮件|付款|付费|支付|花钱|购买|扣费|充值|授权|批准|允许执行|\b(?:rm|rmdir|unlink|delete|remove|erase|purge|wipe|drop|truncate|merge|push|publish|deploy|payment|purchase|buy|pay|spend|authorize|approve|grant)\b|send\s+(?:a\s+)?(?:message|email)/i.test(text);
}
function labelFor(text: string): TaskActionLabel {
  if (isRedline(text)) return '要你定·红线';
  if (/不用管|无需(?:回复|操作|处理)/.test(text)) return '不用管';
  if (/回去看看|去(?:浏览器|终端|手机|设置)|打开(?:浏览器|软件|总结)|重启|安装|点击/.test(text)) return '你去做';
  if (/回到会话|回复|回答|[？?]|是否|请选|选择|确认|决定|提供/.test(text)) return '回复会话';
  return '你去做';
}
function sourceItems(output: string, project: string): { text: string; suggestion?: string }[] {
  const lines = readableLines(output, project);
  const result: { text: string; suggestion?: string }[] = [];
  for (const line of lines) {
    const match = /^(.*?)(?:[（(；;，,]\s*|\s+)?(?:我(?:的)?|个人)?(?:建议|推荐)[:：]?\s*(.+?)[）)]?$/.exec(line);
    if (match) {
      const text = match[1]!.replace(/[（(；;，,\s]+$/, '').trim();
      if (text) result.push({ text, suggestion: match[2]!.trim() });
      else if (result.length) result[result.length - 1]!.suggestion = match[2]!.trim();
    } else if (!/[:：]$/.test(line)) result.push({ text: line });
  }
  return result;
}
export function validActionItems(value: unknown): TaskActionItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TaskActionItem => !!item && typeof item === 'object'
    && typeof item.text === 'string' && !!item.text.trim())
    .map(item => ({ text: item.text, label: actionLabels.includes(item.label) ? item.label : labelFor(item.text),
      ...(typeof item.suggestion === 'string' && item.suggestion.trim() ? { suggestion: item.suggestion } : {}) }));
}
/** 所有新快照共用这一道规则，包括模型起草、失败兜底、授权等待。 */
export function buildActionItems(value: unknown, fallback: string, input: TaskSnapshotInput, project: string, now: string): TaskActionItem[] {
  const supplied = validActionItems(value);
  const source = sourceItems(input.lastOutput, project);
  const question = requestedAction(input.lastOutput, project, '');
  const sourceActions = source.filter(item => /[？?]|请|需要你|等你|是否|确认|选择|删除|合入|授权|去|不用管/.test(item.text));
  const rules = supplied.length ? [] : sourceActions.length > 1 && question
    ? sourceActions : [{ text: fallback || question || '请回到会话确认下一步' }];
  const items: TaskActionItem[] = supplied.length ? supplied : rules.map(item => ({ ...item, label: labelFor(item.text) }));
  return items.map((item, index) => {
    const same = source.find(row => row.suggestion && (row.text.includes(item.text) || item.text.includes(row.text)))
      ?? (sourceActions.length === items.length ? sourceActions[index] : undefined)
      ?? (items.length === 1 ? source.find(row => row.suggestion) : undefined);
    const suggestion = same?.suggestion ?? item.suggestion;
    const risky = isRedline(`${item.text}\n${suggestion ?? ''}\n${same?.text ?? ''}`)
      || (items.length === 1 && isRedline(input.lastOutput));
    const clean = (text: string, limit: number) => compact(humanText(text, project, now), limit);
    return { text: clean(item.text, 160) || '请回到会话确认下一步', label: risky ? '要你定·红线' : item.label,
      ...(suggestion ? { suggestion: clean(suggestion, 200) } : {}) };
  });
}
