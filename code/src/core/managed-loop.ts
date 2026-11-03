import { withNamedLock } from './locks.ts';
import { readLedger, refreshTicketProgress, updateLedger } from './ledger.ts';
import { assessLoop } from './loop-assessor.ts';
import { dispatchWrites } from './managed-actions.ts';
import { dispatchTasks } from './task-actions.ts';
import { commandWorker } from './worker-adapter.ts';
import { inspectLoopStatuses, intakeLoop } from './loop-intake.ts';
import { guardCard, validBatchBranch } from './guard.ts';
import { saveHandoff } from './handoff.ts';
import { watchManagedFacts } from './watchdog.ts';
import { hash } from './utils.ts';
import { planAutonomy } from './autonomy.ts';
import { offerModes } from './autonomy-policy.ts';
import { draftMemory, learnRuleCandidates } from './managed-memory.ts';
import { safeDeliveryFailure } from './failures.ts';
import { intakeConfiguredSources } from './source-intake.ts';
import { processMaterials } from './materials.ts';
import { delayForMeeting, meetingUntil } from './schedule-gate.ts';
import type { ScheduleReader } from '../channels/feishu/schedule.ts';
import { reportStorageFailure, withStorageAlerts } from './alerts.ts';
import type { Config, Channel, Notice } from './types.ts';
import type { Assessment, CardDelivery, LedgerChange, LedgerState, LoopWorker, ManagedCard } from './managed-types.ts';

export interface ManagedChannel extends Channel {
  deliverManaged?(card: ManagedCard, key: string, messageId?: string): Promise<string>;
}
export interface ManagedComponents { channels: ManagedChannel[]; worker?: LoopWorker; intake?: boolean; inspect?: boolean; dispatch?: boolean; scheduleReader?: ScheduleReader; now?: () => string }
/** 闸门只读账本研判，写待发；不访问 worker 或渠道。 */
export function gateAssessments(state: LedgerState, add: (change: LedgerChange) => void, at: string) {
  for (const assignment of Object.values(state.tables.assignments)) {
    if (assignment.worker !== 'loop' || assignment.endedAt || !state.events[assignment.lastEventId]) continue;
    const assessment = state.tables.assessments[`assessment:${assignment.lastEventId}`];
    if (!assessment || assessment.eventId === assignment.assessedEventId) continue;
    const event = state.events[assignment.lastEventId]!;
    if (state.tables.tickets[assignment.ticketId]?.closure) continue;
    add({ kind: 'put', table: 'assignments', value: { ...assignment, assessedEventId: event.id } });
    if (assessment.mismatch) add({ kind: 'observation', observation: { kind: 'loop_misreport', ticketId: assignment.ticketId, eventId: event.id, detail: assessment.fact } });
    if (assessment.suppressed) {
      add({ kind: 'observation', observation: { kind: 'not_called', ticketId: assignment.ticketId, eventId: event.id, detail: assessment.fact } });
      const attention = state.tables.attentions[`attention:${assignment.id}`];
      if (attention) add({ kind: 'put', table: 'attentions', value: { ...attention, status: 'resolved', assessmentId: assessment.id } });
      const old = state.tables.cards[assignment.ticketId];
      if (old && old.assignmentId === assignment.id) add({ kind: 'put', table: 'cards', value: { ...old, revision: old.revision + 1, eventId: event.id, at,
        title: `${event.batch} · 停下信号已核销`, fact: assessment.fact, question: '', options: [], input: false, actionMode: 'none', interrupt: false, deliveryText: undefined } });
      continue;
    }
    const queueQuiet = event.state === 'queue' && (event.detail.status !== 'returned' || Number(event.detail.returns ?? 0) < 3);
    if (queueQuiet) {
      add({ kind: 'put', table: 'attentions', value: { id: `attention:${assignment.id}`, ticketId: assignment.ticketId, assignmentId: assignment.id,
        eventId: event.id, assessmentId: assessment.id, status: 'waiting', reason: `合入队列 ${String(event.detail.status)}，退回 ${Number(event.detail.returns ?? 0)} 次；前两次只陈列` } });
      add({ kind: 'observation', observation: { kind: 'not_called', ticketId: assignment.ticketId, eventId: event.id, detail: '队列变化只进等你清单' } });
      continue;
    }
    const titles: Record<string, string> = { needs_decision: '需要你决定', paused: '暂停', failed: '失败', repair_limit: '返修到上限', completed: '做完', queue: '合入队列退回三次' };
    const old = state.tables.cards[assignment.ticketId];
    const card: ManagedCard = { id: assignment.ticketId, ticketId: assignment.ticketId, assignmentId: assignment.id, eventId: event.id,
      assessmentId: assessment.id, revision: (old?.revision ?? 0) + 1, at, title: `${event.batch} · ${titles[event.state] ?? event.state}`,
      fact: assessment.fact, question: assessment.question, suggestion: assessment.suggestion, basis: assessment.basis,
      options: assessment.options, redline: assessment.redline, urgency: event.state === 'completed' ? 'completion' : 'decision', actionMode: event.state === 'completed' || event.stage === '@batch' && event.detail.next === 'manual' ? 'none' : event.state === 'repair_limit' ? 'repair' : 'reply' };
    if (event.state === 'queue') {
      const completed = Object.values(state.tables.assignments).find(row => row.ticketId === assignment.ticketId && row.stage === assignment.stage && row.state === 'completed' && !row.endedAt);
      const completion = completed ? state.tables.assessments[`assessment:${completed.lastEventId}`] : undefined;
      if (completion) {
        card.fact += `\n最近完成报告（不代替本次队列结论）：\n${completion.fact}`;
        card.basis += `\n完成事实仍保留：${completion.eventId}；${completion.basis}`;
      }
    }
    if (event.state === 'completed' && !assessment.status?.executionBlock && assessment.commit?.result !== 'missing' && assessment.commit?.resolved && validBatchBranch(assessment.commit.branch)) {
      const target = { branch: assessment.commit.branch, commit: assessment.commit.resolved,
        ...(assessment.commit.result === 'candidate' ? { candidateRef: assessment.commit.ref } : {}) };
      card.executions = [{ action: 'merge', ...target }];
      const push = assessment.status?.pushTarget;
      if (assessment.commit.result === 'branch' && push && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(push.remote) && ['public', 'private', 'unknown'].includes(push.visibility))
        card.executions.unshift({ action: 'push', ...target, remote: push.remote, visibility: push.visibility });
    } else if (['paused', 'repair_limit', 'failed', 'queue', 'needs_decision'].includes(event.state)) card.executions = [{ action: 'stop' }];
    const paused = state.tables.tickets[assignment.ticketId]?.intents.at(-1)?.pausedActions ?? [];
    if (paused.length) {
      card.suspendedExecutions = card.executions?.filter(target => paused.includes(target.action));
      card.executions = card.executions?.filter(target => !paused.includes(target.action));
    }
    if (event.state === 'repair_limit') saveHandoff(state, add, assignment.id, at, 'repair_limit', event.id);
    add({ kind: 'put', table: 'cards', value: card });
    for (const draft of assessment.memoryDrafts ?? []) draftMemory(state, add, draft, at, assignment.ticketId);
    add({ kind: 'put', table: 'attentions', value: { id: `attention:${assignment.id}`, ticketId: assignment.ticketId, assignmentId: assignment.id,
      eventId: event.id, assessmentId: assessment.id, status: 'notified', reason: assessment.question || assessment.fact } });
    add({ kind: 'observation', observation: { kind: 'attention_ready', ticketId: assignment.ticketId, eventId: event.id, detail: card.title } });
  }
}
function asNotice(card: ManagedCard): Notice {
  const content = { title: card.title, summary: card.fact, situation: card.fact, action: card.suggestion,
    returnCommand: 'node code/src/cli/main.ts overview --config <运行配置> --json',
    evidence: { project: null, intentOriginal: null, additionalRequirements: [], recentSteps: [], reason: card.basis, originals: [] } };
  return { version: 1, id: `${card.id}:${card.revision}`, dedupeKey: `${card.id}:${card.revision}`, at: card.at, tool: card.id.startsWith('health:') ? 'agent' : 'loop',
    kind: card.actionMode === 'none' ? 'loop_completed' : 'loop_paused', level: '现在就要你', content, text: `${card.title}\n${card.fact}\n${card.question}\n建议：${card.suggestion}\n依据：${card.basis}` };
}
/** 当前卡片渠道状态与历史worker请求分开。只有失败之后才开始的实际成功可核销故障。 */
function recordCardChannelResult(state: LedgerState, add: (change: LedgerChange) => void, at: string, delivery: CardDelivery, failure?: string) {
  if (delivery.channel !== 'feishu') return;
  const id = 'card-channel:feishu', previous = state.tables.health[id];
  if (failure) {
    add({ kind: 'put', table: 'health', value: { id, ok: false, kind: 'delivery', at,
      episode: previous?.ok === false ? previous.episode : `${id}:${state.seq + 1}`, reason: `卡片未确认送达：${failure}`,
      lastFailureSeq: state.seq + 1, deliveryId: delivery.id, attemptSeq: delivery.attemptSeq } });
    return;
  }
  if (previous?.ok || previous && !((delivery.attemptSeq ?? -1) >= (previous.lastFailureSeq ?? Infinity))) return;
  // 兼容只有deliveries失败记录的账本：先停自动，新的实际成功才能建立恢复证据。
  if (!previous && !Object.values(state.tables.deliveries).some(row => row.channel === 'feishu' && ['failed', 'uncertain'].includes(row.state))) return;
  add({ kind: 'put', table: 'health', value: { id, ok: true, kind: 'delivery', at, episode: previous?.episode ?? id,
    reason: `卡片渠道已由实际成功投递核实：${delivery.id}；尝试事务 ${delivery.attemptSeq}`,
    ...(previous?.lastFailureSeq ? { lastFailureSeq: previous.lastFailureSeq } : {}), deliveryId: delivery.id, attemptSeq: delivery.attemptSeq } });
}
/** channel 是唯一本人写口；每个批次始终沿用账本里的 messageId。 */
async function deliverCards(config: Config, channels: ManagedChannel[], now: () => string) {
  for (const card of Object.values((await readLedger(config.dataDir)).tables.cards)) for (const channel of channels) {
    const claimed = await updateLedger(config.dataDir, now(), (state, add) => {
      const at = now(); // 在拿到短锁、读完账本之后再取当前时钟，不能沿用处理轮次开始时间。
      const current = state.tables.cards[card.id]; if (!current || !guardCard(state, current) || delayForMeeting(state, current, at, config.schedule?.calendarIds ?? [])) return;
      // 已启用桌面陈列时，完成状态只安静移组，不额外弹本机；飞书仍按会议闸门发。
      if (channel.name === 'local' && config.sidebar && (current.urgency === 'completion' || state.events[current.eventId]?.state === 'completed')) return;
      const id = `${channel.name}:${card.id}:${card.revision}`;
      const history = Object.values(state.tables.deliveries).filter(row => row.cardId === card.id && row.channel === channel.name);
      // 工作锁已归本次处理：任何版本遗留的sending都不是可重投授权，换版本也不能绕过。
      for (const row of history) if (row.state === 'sending') {
        add({ kind: 'put', table: 'deliveries', value: { ...row, state: 'uncertain', reason: '上次发卡结果不确定，未新发卡；待人工核对' } });
        recordCardChannelResult(state, add, at, row, '上次卡片尝试没有可靠回执；未重发');
      }
      if (history.some(row => ['sending', 'uncertain'].includes(row.state) && !row.messageId)) return;
      const old = state.tables.deliveries[id];
      if (current.notifyChannels && !current.notifyChannels.includes(channel.name)) return;
      if (current.revision !== card.revision || old?.state === 'sent' || old?.state === 'uncertain' || (old?.failures ?? 0) >= 5) return;
      const delivered = history.filter(row => row.messageId).sort((a, b) => b.revision - a.revision)[0];
      // 本机只作首次打断，不为送达/已读等原卡更新再次弹通知。
      if (channel.name === 'local' && (current.interrupt === false || Object.values(state.tables.deliveries).some(row => row.channel === 'local' && row.cardId === card.id && row.eventId === card.eventId && row.state === 'sent'))) return;
      add({ kind: 'put', table: 'deliveries', value: { id, cardId: card.id, revision: card.revision, eventId: card.eventId, channel: channel.name, state: 'sending', attemptSeq: state.seq + 1, failures: old?.failures ?? 0, ...(delivered?.messageId ? { messageId: delivered.messageId } : {}) } });
      add({ kind: 'observation', observation: { kind: 'guard', ticketId: current.ticketId, detail: `待发围栏放行：${channel.name}；只发给配置的本人；卡片 ${current.id} v${current.revision}` } });
      return { id, messageId: delivered?.messageId };
    });
    if (!claimed) continue;
    // sending先落盘可能也跨过会议边界；实际调用渠道前按最新快照/时钟再判一次。
    const sendingState = await readLedger(config.dataDir);
    if (delayForMeeting(sendingState, card, now(), config.schedule?.calendarIds ?? [])) {
      await updateLedger(config.dataDir, now(), (state, add) => {
        const delivery = state.tables.deliveries[claimed.id];
        if (delivery?.state === 'sending') add({ kind: 'put', table: 'deliveries', value: { ...delivery, state: 'pending', reason: '实际调用渠道前已进入会议，仍待发；尚未调用渠道' } });
      });
      continue;
    }
    let messageId = claimed.messageId, failure: ReturnType<typeof safeDeliveryFailure> | undefined;
    try {
      if (channel.deliverManaged) messageId = await channel.deliverManaged(card, claimed.id, messageId);
      else { await channel.send(asNotice(card)); messageId = `local:${card.id}`; }
    } catch (error) { failure = safeDeliveryFailure(error); await reportStorageFailure(config, error, channels); }
    const at = now();
    await updateLedger(config.dataDir, at, (state, add) => {
      const old = state.tables.deliveries[claimed.id]!;
      if (!failure && card.interrupt !== false && !state.observations.some(row => row.kind === 'called' && row.eventId === card.eventId)) add({ kind: 'observation', observation: { kind: 'called', ticketId: card.ticketId, eventId: card.eventId, detail: `${channel.name} 已确认：${card.title}` } });
      const uncertain = failure && ['channel_timeout', 'channel_connection', 'channel_unknown', 'storage_full'].includes(failure.category);
      add({ kind: 'put', table: 'deliveries', value: { ...old, state: failure ? uncertain ? 'uncertain' : 'failed' : 'sent', failures: old.failures + (failure ? 1 : 0),
        ...(messageId ? { messageId } : {}), ...(failure ? { reason: `${failure.category}：${failure.reason}${uncertain ? '；结果不确定，不新发卡' : '；最多五次尝试'}` } : {}) } });
      recordCardChannelResult(state, add, at, old, failure ? `${failure.category}：${failure.reason}` : undefined);
      if (failure && !card.id.startsWith('health:') && channel.name !== 'local' && (uncertain || old.failures + 1 >= 5)) {
        const id = `health:delivery:${channel.name}:${card.id}`;
        if (!state.tables.cards[id]) add({ kind: 'put', table: 'cards', value: { id, ticketId: '', assignmentId: '', eventId: claimed.id, revision: 1, at,
          title: 'personal agent · 卡片未确认送达', fact: `${card.title} → ${channel.name}；${failure.category}：${failure.reason}。${uncertain ? '结果不确定，不新发卡' : '已尝试5次，停止重试'}`,
          question: '', suggestion: '请查看本机账本并核对渠道；不会重复送话', basis: '渠道实际回执与账本尝试次数', options: [], redline: false, actionMode: 'none', notifyChannels: ['local'] } });
      }
    });
  }
}
function healthCards(state: LedgerState, add: (change: LedgerChange) => void, at: string) {
  for (const health of Object.values(state.tables.health)) {
    const id = `health:${health.id}:${hash(health.episode).slice(0, 12)}`;
    // 卡片渠道故障沿用deliverCards的原卡/本机告警路径，不再生成另一张同源告警。
    if (health.id.startsWith('card-channel:') || health.ok || state.tables.cards[id]) continue;
    add({ kind: 'put', table: 'cards', value: { id, ticketId: '', assignmentId: '', eventId: health.episode, revision: 1, at,
      title: `personal agent · ${health.kind === 'delivery' ? '话没送到' : health.kind === 'service' ? 'PA 自身故障' : '来源故障'}`, fact: health.reason, question: '',
      suggestion: health.kind === 'delivery' ? '请核对原卡和 worker；结果不确定不重发' : '请回电脑检查来源与运行日志',
      basis: 'watchdog 仅报告接入回执/账本里的机械事实，不作语义判断', options: [], redline: false, actionMode: 'none' } });
  }
}
/** 按需处理新事件/核实到期；模型在账本锁外。intake 可在另一调度中持续运行，不等研判。 */
export async function processManagedLoop(config: Config, at: string, components: ManagedComponents) {
  return withStorageAlerts(config, components.channels, () => processManagedLoopOnce(config, at, components), false);
}
async function processManagedLoopOnce(config: Config, at: string, components: ManagedComponents) {
  const now = components.now ?? (() => at); // CLI/offline保持显式时间；常驻注入实时/测试时钟。
  if (components.intake !== false) { await intakeLoop(config, at); await intakeConfiguredSources(config, at, components.scheduleReader); }
  return withNamedLock(config.dataDir, '.managed-work.lock', async () => {
    const worker = components.worker ?? commandWorker(config);
    if (components.inspect) await inspectLoopStatuses(config, at, worker);
    let state = await readLedger(config.dataDir);
    const modelDeadline = performance.now() + (config.judge?.cycleTimeoutMs ?? 60000);
    for (const assignment of Object.values(state.tables.assignments)) {
      if (assignment.worker !== 'loop' || !state.events[assignment.lastEventId] || assignment.endedAt || state.tables.tickets[assignment.ticketId]?.closure || ['started', 'resumed'].includes(assignment.state) || assignment.lastEventId === assignment.assessedEventId
        || assignment.dueAt && Date.parse(at) < Date.parse(assignment.dueAt)) continue;
      const remaining = Math.floor(modelDeadline - performance.now());
      const assessConfig = config.judge ? { ...config, judge: { ...config.judge, timeoutMs: Math.max(1, Math.min(config.judge.timeoutMs, remaining)), ...(remaining <= 0 ? { dailyLimit: 0 } : {}) } } : config;
      const assessment: Assessment = state.tables.assessments[`assessment:${assignment.lastEventId}`] ?? await assessLoop(assessConfig, state, assignment, at, worker);
      await updateLedger(config.dataDir, at, (current, add) => {
        if (!current.tables.assessments[assessment.id]) {
          add({ kind: 'put', table: 'assessments', value: assessment });
          add({ kind: 'observation', observation: { kind: 'query', ticketId: assessment.ticketId, eventId: assessment.eventId, detail: '只读核实及方案起草耗时（含被新事件取代的研判）', value: assessment.queryMs } });
        }
      });
      state = await readLedger(config.dataDir);
    }
    const remaining = Math.floor(modelDeadline - performance.now());
    await processMaterials(config.judge ? { ...config, judge: { ...config.judge, cycleTimeoutMs: Math.max(1, remaining), ...(remaining <= 0 ? { dailyLimit: 0 } : {}) } } : config, at);
    await updateLedger(config.dataDir, at, (current, add) => {
      gateAssessments(current, add, at); refreshTicketProgress(current, add); planAutonomy(current, add, at);
      if (components.inspect) add({ kind: 'put', table: 'receipts', value: { id: 'inspection', at, response: '低频巡检完成' } });
    });
    await dispatchWrites(config, at, worker);
    if (components.dispatch !== false) await dispatchTasks(config, at, worker);
    await deliverManagedHealth(config, now(), components.channels, components.inspect, now);
    return readLedger(config.dataDir);
  });
}
/** 失败路径也可单独运行：不再起研判/worker，只把机械故障过闸门交给渠道。 */
export async function deliverManagedHealth(config: Config, at: string, channels: ManagedChannel[], inspect = false, now: () => string = () => at) {
  const checkedAt = now();
  await updateLedger(config.dataDir, checkedAt, (state, add) => { watchManagedFacts(state, add, checkedAt, config, inspect); healthCards(state, add, checkedAt); learnRuleCandidates(state, add, checkedAt); offerModes(state, add, checkedAt); });
  // 交付仍由channel执行，watchdog本身不接触外部；各渠道临发送前重新取时钟。
  await deliverCards(config, channels, now);
}
export async function nextManagedDue(dataDir: string, at = new Date().toISOString(), calendarIds: string[] = []): Promise<number | undefined> {
  const state = await readLedger(dataDir), assignments = Object.values(state.tables.assignments);
  const due = assignments.filter(row => row.worker === 'loop' && !!state.events[row.lastEventId] && !row.endedAt && !state.tables.tickets[row.ticketId]?.closure && row.dueAt && row.lastEventId !== row.assessedEventId).map(row => Date.parse(row.dueAt!));
  const meetingEnd = meetingUntil(state, at, calendarIds);
  if (meetingEnd && Object.values(state.tables.cards).some(card => delayForMeeting(state, card, at, calendarIds)
    && !Object.values(state.tables.deliveries).some(row => row.cardId === card.id && row.revision === card.revision && row.channel === 'feishu' && row.state === 'sent'))) due.push(meetingEnd);
  return due.length ? Math.min(...due) : undefined;
}
