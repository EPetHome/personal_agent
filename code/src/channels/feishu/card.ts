import { basename } from 'node:path';
import type { Notice } from '../../core/types.ts';
import { RELAY_INPUT_LIMIT, WINDOW_WARNING } from '../../core/relay.ts';
import type { RelayView } from '../../core/relay.ts';
import { localTime, noticeSections, noticeTimeAndReturn, presentNotice, renderActionItems } from '../../core/notice-text.ts';

function markdown(content: string) { return { tag: 'markdown', content, margin: '0px 0px 12px 0px' }; }
function button(text: string, value: Record<string, string>) {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type: 'default', value };
}
function buttons(actions: unknown[]) {
  return { tag: 'column_set', flex_mode: 'none', columns: actions.map(action => ({ tag: 'column', width: 'auto', elements: [action] })) };
}
function relayElements(notice: Notice, view: RelayView): unknown[] {
  const value = (action: string) => ({ action, noticeId: notice.id, ...(view.draft ? { draftId: view.draft.id } : {}) });
  // JSON 2.0 普通文本仍使用 div + text.plain_text；不能改成 markdown 解释用户原话。
  // https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/plain-text
  const plain = (content: string) => ({ tag: 'div', text: { tag: 'plain_text', content } });
  const elements: unknown[] = [markdown('**回复这个 CC 会话**')];
  if (view.message) elements.push(plain(view.message));
  if (view.stage === 'entry' && view.target) elements.push(buttons([
    ...(view.suggestion ? [button('按建议回', value('relay_suggest'))] : []), button('手动输入', value('relay_manual')),
  ]));
  if (view.stage === 'input') elements.push({ tag: 'form', name: 'relay_form', elements: [
    { tag: 'input', name: 'relay_text', input_type: 'multiline_text', max_length: RELAY_INPUT_LIMIT,
      placeholder: { tag: 'plain_text', content: '写你自己的原话（不预填；完全替换建议）' } },
    { ...button('预览原话', value('relay_input')), action_type: 'form_submit' },
  ] });
  if (view.draft) {
    const target = view.draft.target;
    elements.push(plain(`将发给 ${basename(target.cwd)} 的 CC 会话 ${target.sessionId}：\n${view.draft.text}`), plain(WINDOW_WARNING));
    const confirm = { preview: ['确认发送', 'relay_confirm'], stale: ['仍然发送', 'relay_stale_confirm'], redline: ['红线再次确认发送', 'relay_red_confirm'] }[view.stage as 'preview' | 'stale' | 'redline'];
    if (confirm) elements.push(buttons([button(confirm[0]!, value(confirm[1]!)), button('取消', value('relay_cancel'))]));
  }
  return elements;
}
/** 原卡片其他内容不变；只有显式传入转达状态时才显示回复区。 */
export function noticeCard(notice: Notice, relay?: RelayView) {
  const raw = noticeSections(notice.content);
  // 包括仍待投递的旧版卡片：兼容读取但不改写发件原件。
  const content = presentNotice(notice.content, raw.situation, raw.action, notice.at), evidence = content.evidence;
  const items = content.actionItems ?? notice.snapshot?.actionItems;
  const elements: unknown[] = [markdown(`**这件事**：${content.situation}`), markdown(`**要你做**：${items?.length ? `\n${renderActionItems(items)}` : content.action}`),
    markdown(`**时间 / 回去看**：${noticeTimeAndReturn(notice)}`)];
  if (relay) elements.push(...relayElements(notice, relay));
  const verdicts = ['weekly', 'recurrence', 'service_restart', 'daily'].includes(notice.kind) ? ['看不懂'] : ['正确', '误报', '看不懂'];
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
