import type { Notice } from '../../core/types.ts';
import { localTime } from '../../core/notice-text.ts';

function markdown(content: string) { return { tag: 'markdown', content }; }
function button(text: string, value: Record<string, string>) {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type: 'default', value };
}
function buttons(actions: unknown[]) {
  return { tag: 'column_set', flex_mode: 'none', columns: actions.map(action => ({ tag: 'column', width: 'auto', elements: [action] })) };
}
/** 编号仅放按钮的隐藏 value，不放标题、正文或确认文本。 */
export function noticeCard(notice: Notice) {
  const evidence = notice.content.evidence;
  const elements: unknown[] = [markdown(notice.content.summary), markdown(`回去看：\n${notice.content.returnCommand}`)];
  if (!['weekly', 'recurrence', 'service_restart'].includes(notice.kind)) elements.push(buttons(['正确', '误报'].map(verdict => button(verdict, { action: 'feedback', verdict, noticeId: notice.id }))));
  for (const item of notice.reviews ?? []) {
    if (!notice.content.summary.includes(item.title) && notice.content.title !== item.title) elements.push(markdown(item.title));
    if (item.experienceRevision) elements.push(buttons([button('同意', { action: 'agree', experienceId: item.experienceId, experienceRevision: item.experienceRevision }), button('改一下', { action: 'revise', experienceId: item.experienceId, experienceRevision: item.experienceRevision })]));
    else elements.push(markdown('这份复盘未绑定审阅版本，请查看最新复盘或用本机 experience 命令确认。'));
  }
  elements.push({ tag: 'collapsible_panel', expanded: false, header: { title: { tag: 'plain_text', content: '证据' } }, elements: [markdown([
    `意图原文：${evidence.intentOriginal ?? '未提供'}`, ...evidence.additionalRequirements.map(s => `追加要求：${s}`),
    ...evidence.recentSteps.map(s => `${localTime(s.at, notice.at)} ${s.text}`), `判断依据：${evidence.reason}`, ...evidence.originals.map(o => `原件：${o.path}`),
  ].join('\n'))] });
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: notice.content.title }, template: notice.level === '现在就要你' ? 'orange' : 'blue' }, body: { elements } };
}
