import { basename } from 'node:path';
import type { Notice } from '../../core/types.ts';
import type { ManagedCard } from '../../core/managed-types.ts';
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
/** 托管 loop 原卡：事实与建议分开；用户原话用 plain_text，不解释成指令或 Markdown。 */
export function managedCard(card: ManagedCard) {
  const plain = (content: string) => ({ tag: 'div', text: { tag: 'plain_text', content } });
  const value = (action: string, extra: Record<string, string> = {}) => ({ action: `managed_${action}`, noticeId: card.id, revision: String(card.revision), ...extra });
  const elements: unknown[] = [plain(`${card.memoryCandidateId ? '待确认的候选' : '核实过的事实'}：\n${card.fact}`)];
  if (card.question) elements.push(plain(`问题原文：\n${card.question}`));
  if (card.options.length) elements.push(plain(`原选项：\n${card.options.map((option, index) => `选项 ${index + 1}：${option}`).join('\n')}`));
  elements.push(plain(`建议（仅这一条）：\n${card.suggestion}`), plain(`依据：\n${card.basis}`));
  if (card.deliveryText) elements.push(plain(card.deliveryText));
  if (card.modeControl) elements.push(buttons([
    button('明确设为影子（只记录）', value('mode_shadow')), button('明确设为建议', value('mode_suggest')),
    ...(card.modeControl.canAuto ? [button('明确确认：这一类设为自动', value('mode_auto'))] : []),
  ]));
  if (card.memoryCandidateId && !card.deliveryText) elements.push(buttons([
    button('确认这一条记忆', value('memory_confirm')), button('不记', value('memory_dismiss')),
  ]));
  if (card.modeScopeId) elements.push(buttons([button('这一类的档位', value('mode_settings'))]));
  if (card.materialOptions?.length) elements.push(buttons(card.materialOptions.map((option, index) => button(option.label, value('material_option', { option: String(index) })))));
  if (card.taskAction) {
    if (card.taskAction === 'dispatch_confirm') elements.push(plain('这一项涉及红线，必须明确确认；不提供「按建议」。'));
    elements.push(buttons([button(card.taskAction === 'query' ? '查' : card.taskAction === 'dispatch_confirm' ? `明确确认本次派出：${card.fact}` : '派', value(card.taskAction))]));
  }
  if (card.executions?.length) {
    elements.push(plain('以下为红线动作：只执行你明确点的这一项，不进入自动档。'));
    for (const target of card.executions) if (target.action !== 'stop') elements.push(plain(`${target.action === 'push' ? '推送' : '合入'}对象：${target.branch} @ ${target.commit}${target.candidateRef ? `\n核实候选：${target.candidateRef}（尚未提交到批次分支）` : ''}${target.remote ? ` → ${target.remote}（${target.visibility === 'public' ? '公开' : target.visibility === 'private' ? '私有' : '可见性未知，可能公开'}）` : ''}`));
    elements.push(buttons(card.executions.map(target => button(target.action === 'push'
      ? `推到仓库${target.visibility === 'public' ? '（公开）' : target.visibility === 'private' ? '' : '（可见性未知，可能公开）'}`
      : target.action === 'merge' ? '合入' : '停掉这批', value(target.action)))));
  }
  if (card.actionMode !== 'none') {
    const actions: unknown[] = [button(card.redline ? `确认送话：${card.suggestion}` : '按建议', value(card.redline ? 'confirm' : 'suggest'))];
    card.options.forEach((option, index) => actions.push(button(`${card.redline ? '明确确认选项' : '选项'} ${index + 1}：${option}`, value(card.redline ? 'confirm' : 'option', { option: String(index) }))));
    if (!card.redline) {
      if (card.actionMode === 'repair') actions.push(button('再给一轮', value('repair')));
      else if (!card.question) actions.push(button('继续', value('continue')));
    }
    actions.push(button('我写一句', value('manual')), button('回电脑再说', value('defer')));
    elements.push(buttons(actions));
    if (card.input) elements.push({ tag: 'form', name: 'managed_reply', elements: [
      { tag: 'input', name: 'relay_text', input_type: 'multiline_text', max_length: 4000, placeholder: { tag: 'plain_text', content: '只送给当前这条派工；红线原话还需明确确认' } },
      { ...button('送出这一句', value('send_text')), action_type: 'form_submit' },
    ] });
  } else elements.push(buttons([button('先放着', value('defer'))]));
  if (card.lastRequestId) elements.push(buttons([button(card.automaticRequestId ? '撤回' : '撤回尚未发送的请求', value('withdraw'))]));
  if (card.automaticRequestId) elements.push(plain('撤回会收回这类自动授权、退档，并取消尚未发送的自动请求；不能收回已送出或已执行的动作，请核对原卡结果。'));
  elements.push({ tag: 'collapsible_panel', expanded: false, header: { title: { tag: 'plain_text', content: '给 personal agent 的反馈' } },
    elements: [buttons(['正确', '误报', '看不懂', ...(card.modeScopeId ? ['严重错误'] : [])].map(verdict => button(verdict, value(`feedback_${verdict}`))))] });
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: card.title }, template: 'orange' }, body: { elements } };
}
/** 同一张卡的按钮投影供本机侧边栏使用，不另外维护一套动作。 */
export function managedControls(card: ManagedCard): { label: string; action: string; option?: number; textInput?: boolean }[] {
  const result: ReturnType<typeof managedControls> = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'button' && typeof node.value?.action === 'string') result.push({ label: node.text.content, action: node.value.action.replace(/^managed_/, ''),
      ...(node.value.option === undefined ? {} : { option: Number(node.value.option) }), ...(node.action_type === 'form_submit' ? { textInput: true } : {}) });
    if (Array.isArray(node)) node.forEach(walk); else for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(managedCard(card)); return result;
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
