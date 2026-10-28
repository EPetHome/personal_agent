import type { Notice } from '../../core/types.ts';
import { localTime, noticeSections, noticeTimeAndReturn, presentNotice, renderActionItems } from '../../core/notice-text.ts';

function markdown(content: string) { return { tag: 'markdown', content, margin: '0px 0px 12px 0px' }; }
function button(text: string, value: Record<string, string>) {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type: 'default', value };
}
function buttons(actions: unknown[]) {
  return { tag: 'column_set', flex_mode: 'none', columns: actions.map(action => ({ tag: 'column', width: 'auto', elements: [action] })) };
}
/** 要你做逐件呈现；反馈默认收起，与回复会话的动作分开，不放输入框。 */
export function noticeCard(notice: Notice) {
  const raw = noticeSections(notice.content);
  // 包括仍待投递的旧版卡片：兼容读取但不改写发件原件。
  const content = presentNotice(notice.content, raw.situation, raw.action, notice.at), evidence = content.evidence;
  const items = content.actionItems ?? notice.snapshot?.actionItems;
  const elements: unknown[] = [markdown(`**这件事**：${content.situation}`), markdown(`**要你做**：${items?.length ? `\n${renderActionItems(items)}` : content.action}`),
    markdown(`**时间 / 回去看**：${noticeTimeAndReturn(notice)}`)];
  const verdicts = ['weekly', 'recurrence', 'service_restart'].includes(notice.kind) ? ['看不懂'] : ['正确', '误报', '看不懂'];
  elements.push({ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: '给 personal agent 的反馈' } },
    elements: [buttons(verdicts.map(verdict => button(verdict, { action: 'feedback', verdict, noticeId: notice.id })))] });
  let reason = evidence.reason;
  for (const item of notice.reviews ?? []) reason = reason.replaceAll(item.title, '');
  const details: unknown[] = [markdown([
    `项目：${evidence.project ?? '暂未关联'}`, `意图原文：${evidence.intentOriginal ?? '未提供'}`,
    ...evidence.additionalRequirements.map(s => `追加要求：${s}`),
    ...evidence.recentSteps.map(s => `${localTime(s.at, notice.at)} ${s.text}`),
    ...(evidence.assistantReply ? [`助手原话：${evidence.assistantReply}`] : []),
    ...(evidence.presentation ? [`这件事（完整）：${evidence.presentation.situation}`, `要你做（完整）：${evidence.presentation.action}`] : []),
    `判断依据：${reason}`,
    ...(evidence.needs ? [`还欠什么：${evidence.needs.length ? evidence.needs.join('\n') : '无'}`] : []),
    ...evidence.originals.map(o => `原件：${o.path}`),
  ].join('\n'))];
  for (const item of notice.reviews ?? []) {
    details.push(markdown(item.title));
    if (item.experienceRevision) details.push(buttons([
      button('同意', { action: 'agree', experienceId: item.experienceId, experienceRevision: item.experienceRevision }),
      button('改一下', { action: 'revise', experienceId: item.experienceId, experienceRevision: item.experienceRevision }),
    ]));
    else details.push(markdown('这份复盘未绑定审阅版本，请查看最新复盘或用本机 experience 命令确认。'));
  }
  elements.push({ tag: 'collapsible_panel', expanded: false, header: { title: { tag: 'plain_text', content: '证据' } }, elements: details });
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: content.title }, template: notice.level === '现在就要你' ? 'orange' : 'blue' }, body: { elements } };
}
