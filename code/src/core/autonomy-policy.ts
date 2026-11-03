import { hash } from './utils.ts';
import type { ActionMode, ActionScope, AutomaticApproval, LedgerChange, LedgerState, ManagedCard, ManagedInput, ManagedWrite, QuestionSheet } from './managed-types.ts';

type Add = (change: LedgerChange) => void;
export const modeVersion = (mode?: ActionMode) => mode?.version ?? 1;
export const modeEpoch = (mode?: ActionMode) => mode?.epoch ?? 1;
/** 类别只由结构化来源/动作与已配置的范围组成，模型不能指定自己的放权类别。 */
export function actionScope(state: LedgerState, card: ManagedCard): ActionScope | undefined {
  if (card.modeControl || card.memoryCandidateId || card.id.startsWith('health:')) return;
  if (card.proposalId) {
    const p = state.tables.proposals[card.proposalId], ticket = state.tables.tickets[card.ticketId];
    if (!p || !ticket || p.kind === 'cc') return;
    const b = p.definition.boundaries;
    const scope = hash(JSON.stringify([ticket.project, p.kind, p.recipe, p.skills, b.read, b.write, b.prohibitedChanges, b.realDevice, b.outbound, p.sheet?.boundary])).slice(0, 24);
    const source = state.tables.threads[ticket.threadId]?.source ?? 'feishu', action = `dispatch:${p.kind}:${p.recipe ?? p.skills?.join('+') ?? 'read'}:${scope}`;
    return { id: `${source}:${action}`, source, action };
  }
  const event = state.events[card.eventId];
  if (!event || card.actionMode === 'none' && !card.automaticRequestId || !['paused', 'needs_decision', 'repair_limit', 'failed'].includes(event.state)) return;
  const action = `reply:${event.state}:${event.reason.category}`;
  return { id: `loop:${action}`, source: 'loop', action };
}
export function ensureMode(state: LedgerState, add: Add, scope: ActionScope, at: string): ActionMode {
  let mode = state.tables.modes[scope.id];
  if (!mode) { mode = { ...scope, mode: 'suggest', at, version: 1, epoch: 1 }; add({ kind: 'put', table: 'modes', value: mode }); }
  return mode;
}
/** 只用实际卡片投递判断当前可达性。worker请求失败是历史事实，不是渠道故障。
 * 通道恢复允许其他卡继续；原卡仍须有更新版本的成功送达，不能借别的卡核销未决首发。 */
function cardDeliveryState(state: LedgerState, card: ManagedCard): 'ready' | 'waiting' | 'blocked' {
  const health = state.tables.health['card-channel:feishu'];
  const rows = Object.values(state.tables.deliveries).filter(row => row.channel === 'feishu');
  if (health?.ok === false || !health && rows.some(row => row.state === 'failed' || row.state === 'uncertain')) return 'blocked';
  const own = rows.filter(row => row.cardId === card.id), sentRevision = Math.max(0, ...own.filter(row => row.state === 'sent').map(row => row.revision));
  if (own.some(row => ['failed', 'uncertain'].includes(row.state) && row.revision >= sentRevision)) return 'blocked';
  // sending不是失败，也不是已送达。未尝试的派工等回执；遗留sending由渠道恢复核销为uncertain。
  return own.some(row => row.state === 'sending' && row.revision >= sentRevision) ? 'waiting' : 'ready';
}
/** 补查的定义是封闭提问单，不是尚待补齐事实的开发任务；准入和最终围栏共用校验。 */
export function completeQuestionSheet(sheet: QuestionSheet | undefined): boolean {
  const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
  const list = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  return !!sheet && nonempty(sheet.goal) && list(sheet.questions) && nonempty(sheet.arrival) && !!sheet.boundary
    && list(sheet.boundary.read) && Array.isArray(sheet.boundary.write) && sheet.boundary.write.length === 0
    && sheet.boundary.outbound === false && sheet.boundary.realDevice === false && list(sheet.boundary.tools)
    && sheet.boundary.tools.every(tool => ['read', 'grep', 'find', 'ls'].includes(tool)) && !!sheet.budget
    && sheet.budget.maxRounds === 1 && Number.isSafeInteger(sheet.budget.timeoutMs)
    && sheet.budget.timeoutMs > 0 && sheet.budget.timeoutMs <= 1200000;
}
/** 不含卡片在途状态的动作范围/定义检查；不能借“等待回执”放宽这些硬条件。 */
function automaticScopeSafety(state: LedgerState, card: ManagedCard): boolean {
  const ticket = state.tables.tickets[card.ticketId], intent = ticket?.intents.at(-1);
  if (!ticket || !intent || ticket.closure || card.redline || card.deferred) return false;
  if (!['fake', 'connected'].includes(state.tables.connections.feishu?.state ?? '')) return false;
  if (card.proposalId) {
    const p = state.tables.proposals[card.proposalId];
    const origin = state.tables.threads[ticket.threadId]?.source;
    if (!p || p.kind === 'cc' || p.materialId || origin === 'workspace' || origin === 'minutes' || intent.pausedActions?.includes('dispatch') || p.definition.boundaries.realDevice
      || p.definition.boundaries.outbound.some(value => value !== 'loop_reply')
      || !p.definition.boundaries.read.length || !p.definition.result.trim() || !p.definition.done.trim()) return false;
    if (p.kind === 'supplement' || p.kind === 'query') return completeQuestionSheet(p.sheet)
      && !p.definition.boundaries.write.length && !p.definition.boundaries.outbound.length
      && JSON.stringify(p.sheet!.boundary.read) === JSON.stringify(p.definition.boundaries.read)
      // 成功补查保留为该类别的资格证据；预算/每事一次仍在行动及派出前检查，历史卡不能再派。
      && (p.kind === 'supplement' ? p.queryOffered === true || p.status === 'consumed' : !p.missing.length);
    return !p.missing.length;
  }
  const assignment = state.tables.assignments[card.assignmentId], assessment = card.assessmentId ? state.tables.assessments[card.assessmentId] : undefined;
  return !!assignment?.stage && !assignment.endedAt && assignment.worker === 'loop' && !!intent.confirmed
    && intent.boundaries.outbound.includes('loop_reply') && !intent.pausedActions?.includes('reply')
    && !!assessment && !assessment.suppressed && !assessment.statusFailure
    && !!assessment.status?.stages.some(stage => stage.name === assignment.stage && ['paused', 'needs_decision', 'repair_limit', 'failed'].includes(stage.state))
    && !!card.suggestion.trim() && Array.from(card.suggestion).length <= 4000;
}
/** 准入仍要求实际可达；不能把正常sending当成已经成功而抢先执行。 */
export function automaticSafety(state: LedgerState, card: ManagedCard): boolean {
  return automaticScopeSafety(state, card) && cardDeliveryState(state, card) === 'ready';
}
export function automaticApproval(state: LedgerState, card: ManagedCard): AutomaticApproval | undefined {
  const scope = actionScope(state, card), mode = scope ? state.tables.modes[scope.id] : undefined;
  if (mode?.mode === 'auto' && mode.inputId && automaticSafety(state, card)) return { scopeId: mode.id, version: modeVersion(mode), inputId: mode.inputId };
}
/** 发出前仍核对本人改档的真实输入；自动不能伪造一次本人点击。 */
function automaticScopePermission(state: LedgerState, card: ManagedCard, write: ManagedWrite): boolean {
  const approval = write.automation, scope = actionScope(state, card), mode = scope ? state.tables.modes[scope.id] : undefined;
  const input = approval ? state.tables.inputs[approval.inputId] : undefined;
  return !!approval && !!mode && mode.id === approval.scopeId && mode.mode === 'auto' && modeVersion(mode) === approval.version
    && mode.inputId === approval.inputId && mode.actor === input?.actor && input?.action === 'mode_auto'
    && state.tables.cards[input.cardId]?.modeControl?.scopeId === mode.id && automaticScopeSafety(state, card)
    && write.actor === 'pa:auto' && write.inputId === input.id && !write.withdrawnAt && !write.execution && !write.redline
    && (write.dispatch ? write.action === 'auto_dispatch' : write.action === 'auto_reply' && write.text === card.suggestion);
}
export function automaticPermission(state: LedgerState, card: ManagedCard, write: ManagedWrite): boolean {
  return automaticScopePermission(state, card, write) && cardDeliveryState(state, card) === 'ready';
}
/** 只给尚未尝试、授权/定义仍有效的自动派工等待资格；绝不重试worker的sending/未知请求。 */
export function waitingForAutomaticCard(state: LedgerState, card: ManagedCard, write: ManagedWrite): boolean {
  return !!write.dispatch && write.state === 'pending' && !write.dispatchedAt
    && automaticScopePermission(state, card, write) && cardDeliveryState(state, card) === 'waiting';
}
export function ruleKey(project: string, category: string, question: string, options: string[]): string {
  return hash(JSON.stringify([project, category, question, options]));
}
function canonical(text: string, options: string[]): string {
  if (options.includes(text)) return text;
  const pick = /^选(?:择|项)?\s*([A-Ja-j]|[1-9]|10)\s*$/.exec(text.trim());
  if (!pick) return text;
  const n = /^[A-Ja-j]$/.test(pick[1]!) ? pick[1]!.toUpperCase().charCodeAt(0) - 65 : Number(pick[1]) - 1;
  return options[n] ?? text;
}
export function choiceFor(state: LedgerState, card: ManagedCard, selected: string): ManagedWrite['choice'] {
  const scope = actionScope(state, card); if (!scope) return;
  const event = state.events[card.eventId], value = canonical(selected, card.options), suggested = canonical(card.suggestion, card.options);
  return { scopeId: scope.id, epoch: modeEpoch(state.tables.modes[scope.id]), eventId: card.eventId,
    selected: value, suggested, agreed: card.proposalId ? true : value === suggested, eligible: automaticSafety(state, card),
    ...(event?.state === 'needs_decision' && card.options.includes(value) ? { ruleKey: ruleKey(event.project, event.reason.category, card.question, card.options), question: card.question, options: card.options } : {}) };
}
export function modeStats(state: LedgerState, mode: ActionMode) {
  const samples = Object.values(state.tables.choices).filter(row => row.scopeId === mode.id && row.epoch === modeEpoch(mode) && row.eligible);
  const agreed = samples.filter(row => row.agreed).length;
  const serious = state.observations.filter(row => row.kind === 'serious_error' && row.scopeId === mode.id).length;
  return { count: samples.length, agreed, serious, eligible: samples.length >= 20 && agreed * 10 >= samples.length * 9 && serious === 0 };
}
export function changeMode(state: LedgerState, add: Add, mode: ActionMode, next: ActionMode['mode'], at: string, actor: string, inputId: string, reason: string) {
  const value: ActionMode = { ...mode, mode: next, at, actor, inputId, version: modeVersion(mode) + 1, epoch: modeEpoch(mode) + 1 };
  add({ kind: 'put', table: 'modes', value });
  add({ kind: 'observation', observation: { kind: 'mode', scopeId: mode.id, actor, detail: `${mode.mode} → ${next}；v${modeVersion(mode)}→v${value.version}；输入 ${inputId}；${reason}` } });
  for (const write of Object.values(state.tables.writes)) if (write.automation?.scopeId === mode.id && write.state === 'pending') {
    add({ kind: 'put', table: 'writes', value: { ...write, state: 'revoked', withdrawnAt: at, reason: '档位已改变，取消尚未发送的自动请求' } });
  }
  return value;
}
export function downgradeMode(state: LedgerState, add: Add, scopeId: string, at: string, actor: string, inputId: string, reason: string, serious = false) {
  const mode = state.tables.modes[scopeId]; if (!mode) return;
  if (serious) add({ kind: 'observation', observation: { kind: 'serious_error', scopeId, actor, detail: `${reason}；输入 ${inputId}` } });
  if (mode.mode !== 'shadow') changeMode(state, add, mode, mode.mode === 'auto' ? 'suggest' : 'shadow', at, actor, inputId, reason);
}
/** 仅成功投递的本人选择成为放权样本；重复回执/重放/自动结果不增加分母。 */
export function settleChoice(state: LedgerState, add: Add, write: ManagedWrite, at: string, success: boolean) {
  if (write.automation) {
    if (!success && !state.tables.receipts[`auto-failure:${write.id}`]) {
      if (state.tables.modes[write.automation.scopeId]?.mode === 'auto') downgradeMode(state, add, write.automation.scopeId, at, 'guard', write.id, '自动请求失败或结果不确定，保守退档', true);
      else add({ kind: 'observation', observation: { kind: 'serious_error', scopeId: write.automation.scopeId, actor: 'guard', detail: `自动请求 ${write.id} 失败或不确定；该类已经退档，不重复再降一级` } });
      add({ kind: 'put', table: 'receipts', value: { id: `auto-failure:${write.id}`, at, response: '已退档，不重发' } });
    }
    return;
  }
  if (!success || !write.choice || state.tables.choices[`choice:${write.id}`]) return;
  if (Object.values(state.tables.choices).some(row => row.ticketId === write.ticketId && row.eventId === write.eventId)) return;
  add({ kind: 'put', table: 'choices', value: { ...write.choice, id: `choice:${write.id}`, ticketId: write.ticketId, requestId: write.id, at } });
}
export function modeControlCard(state: LedgerState, add: Add, mode: ActionMode, at: string) {
  const id = `mode:${hash(mode.id).slice(0, 24)}`, old = state.tables.cards[id], stats = modeStats(state, mode);
  const example = Object.values(state.tables.cards).find(card => actionScope(state, card)?.id === mode.id);
  const proposal = example?.proposalId ? state.tables.proposals[example.proposalId] : undefined;
  const scopeText = proposal ? `项目：${state.tables.tickets[proposal.ticketId]?.project}\n执行者：${proposal.kind}；配方：${proposal.recipe ?? '无'}；skills：${proposal.skills?.join('、') || '无'}\n读：${proposal.definition.boundaries.read.join('、')}\n写：${proposal.definition.boundaries.write.join('、') || '无'}\n禁改：${proposal.definition.boundaries.prohibitedChanges?.join('；') || '无额外禁改'}\n仅此执行路径与范围，不包含其他项目、配方或技能。`
    : '仅向当前意图允许的明确 loop 派工送本卡这一条建议；不自动推送、合入、停止或执行红线。';
  const card: ManagedCard = { id, ticketId: '', assignmentId: '', eventId: `${id}:${modeVersion(mode)}`, revision: (old?.revision ?? 0) + 1, at,
    title: stats.eligible && mode.mode !== 'auto' ? '这类可以改自动' : '这一类的档位',
    fact: `来源：${mode.source}\n动作：${mode.action}\n${scopeText}\n当前：${mode.mode}\n有效样本 ${stats.count}，与本人一致 ${stats.agreed}，严重错误 ${stats.serious}。`,
    question: '改档是权限变更，只认你明确点的这一类。', suggestion: stats.eligible ? '可明确确认改自动；红线仍逐条问你。' : '默认建议；自动须至少20条、九成一致、严重错误0次。',
    basis: '账本里的成功人工选择；自动结果、重复点击和观测推测不算样本。只有边界完整、错了能由原卡及时发现的动作才自动。',
    options: [], redline: true, actionMode: 'none', notifyChannels: ['feishu'], modeControl: { scopeId: mode.id, version: modeVersion(mode), canAuto: stats.eligible && mode.mode !== 'auto' } };
  add({ kind: 'put', table: 'cards', value: card }); return card;
}
export function handleModeAction(state: LedgerState, add: Add, input: ManagedInput): string {
  const card = state.tables.cards[input.cardId]!;
  if (input.action === 'mode_settings') {
    const scope = actionScope(state, card); if (!scope) return '这张卡没有可改档的动作。';
    modeControlCard(state, add, ensureMode(state, add, scope, input.at), input.at); return '已列出这一类的档位；尚未改权限。';
  }
  const control = card.modeControl, mode = control ? state.tables.modes[control.scopeId] : undefined;
  if (!mode || control!.version !== modeVersion(mode)) return '档位提示已过期，没有改权限。';
  const modes = { mode_shadow: 'shadow', mode_suggest: 'suggest', mode_auto: 'auto' } as const;
  const next = modes[input.action as keyof typeof modes];
  if (!next) return '按钮不属于这张档位卡。';
  if (next === mode.mode) return `这一类已是 ${next}，没有重复改档。`;
  if (next === 'auto' && (!modeStats(state, mode).eligible || !Object.values(state.tables.cards).some(row => actionScope(state, row)?.id === mode.id && automaticSafety(state, row))))
    return '没有够线的有效样本，或此类动作不能撤回/及时发现；未改自动。';
  const updated = changeMode(state, add, mode, next, input.at, input.actor, input.id, '本人在档位卡明确确认这一类');
  modeControlCard(state, add, updated, input.at);
  return `已将 ${mode.source} × ${mode.action} 改为 ${next}；红线仍须逐条确认。`;
}
/** 每代只提示一次；退档后必须重新积累人工样本，严重错误不会被换代清零。 */
export function offerModes(state: LedgerState, add: Add, at: string) {
  for (const mode of Object.values(state.tables.modes)) {
    const id = `mode-offered:${mode.id}:${modeVersion(mode)}`;
    if (mode.mode === 'auto' || state.tables.receipts[id] || !modeStats(state, mode).eligible) continue;
    if (!Object.values(state.tables.cards).some(card => actionScope(state, card)?.id === mode.id && automaticSafety(state, card))) continue;
    modeControlCard(state, add, mode, at);
    add({ kind: 'put', table: 'receipts', value: { id, at, response: '已提示，等待本人明确确认' } });
  }
}
