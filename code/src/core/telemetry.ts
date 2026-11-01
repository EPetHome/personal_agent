import { hash } from './utils.ts';
import { driftTrigger, humanRequests, WAITING_INTERVAL_MS } from './interaction.ts';
import { membersOf } from './sessions.ts';
import type { Config, EventPayload, Projection, SessionRecord, SuppressionReason, WaitingWindow } from './types.ts';

type Suppression = Extract<EventPayload, { kind: 'notice_suppressed' }>;
export function waitingWindowKey(window: Pick<WaitingWindow, 'sessionKey' | 'memberSessionId' | 'scope'>): string {
  return JSON.stringify([window.sessionKey, window.memberSessionId, window.scope]);
}
/** 从已有等待窗口事件恢复跨扫描索引；新回复不能覆盖尚未结算的旧接话事实。 */
export function indexWaitingWindow(windows: Map<string, WaitingWindow>, decision: Suppression): void {
  if (!decision.sessionKey || !decision.memberSessionId || !decision.scope || !/^(?:waiting|model_waiting):/.test(decision.dedupeKey)) return;
  const window: WaitingWindow = { dedupeKey: decision.dedupeKey, evidenceAt: decision.evidenceAt, sessionKey: decision.sessionKey,
    memberSessionId: decision.memberSessionId, scope: decision.scope, intervalMs: decision.intervalMs ?? WAITING_INTERVAL_MS };
  const key = waitingWindowKey(window);
  if (decision.reason === 'waiting_interval') windows.set(key, window);
  else if (decision.reason === 'user_replied' && windows.get(key)?.evidenceAt === window.evidenceAt) windows.delete(key);
}
/** 已有新输出且原窗口没有真人接话时，旧等待已被进展替代；有窗口内接话则留给 trace 结算。 */
export function advanceWaitingWindows(windows: Map<string, WaitingWindow>, record: SessionRecord): void {
  for (const [key, window] of windows) {
    if (window.sessionKey !== record.key) continue;
    const member = membersOf(record).find(member => member.sessionId === window.memberSessionId);
    if (!member || member.unavailable || !member.assistantReply || member.assistantReply.at <= window.evidenceAt) continue;
    const evidence = Date.parse(window.evidenceAt);
    if (!humanRequests(member).some(ref => Date.parse(ref.at) > evidence && Date.parse(ref.at) <= evidence + window.intervalMs)) windows.delete(key);
  }
}
/** 仅去重埋点，不参与业务决策；旧的 suppressedNotices 保持原含义。 */
export function traceSuppression(projection: Projection, output: EventPayload[] | undefined,
  target: Omit<Suppression, 'kind' | 'reason' | 'decisionKey'>, reason: SuppressionReason): void {
  if (!output) return;
  const decisionKey = hash(JSON.stringify([target.dedupeKey, target.evidenceAt, target.scope, reason]));
  if (projection.telemetrySuppressions.has(decisionKey)) return;
  projection.telemetrySuppressions.add(decisionKey);
  output.push({ kind: 'notice_suppressed', ...target, reason, decisionKey });
}
/** 接话后候选已消失，必须在候选筛选之前留痕，不能等 planNotices 找到一张待发卡。 */
export function traceWaitingWindows(record: SessionRecord, projection: Projection, config: Config, now: string, output?: EventPayload[]): void {
  if (!output) return;
  const previous = projection.ruleDecisions.get(record.key)?.rule.facts;
  if (record.loop && previous?.loopStatus === '暂停' && record.loop.status !== '暂停'
    && !projection.notices.some(n => n.kind === 'loop_paused' && n.sessionKey === record.key
      && n.evidenceAt === (previous.loopPausedAt ?? previous.lastActivityAt))) {
    traceSuppression(projection, output, { dedupeKey: `loop_paused:${record.key}`, evidenceAt: previous.loopPausedAt ?? previous.lastActivityAt,
      sessionKey: record.key, scope: 'notice', intervalMs: WAITING_INTERVAL_MS }, 'loop_resumed');
  }
  const members = membersOf(record);
  for (const check of projection.modelChecks.values()) {
    if (check.recordKey !== record.key || check.task !== 'drift' || check.result?.answer !== '是' || check.error
      || projection.notices.some(n => n.sessionKey === record.key && n.kind === 'drift' && n.evidenceAt === check.evidenceAt)) continue;
    const trigger = driftTrigger(record, { ...check, result: check.result }), member = members.find(member => member.sessionId === trigger.sessionId);
    const reply = member && humanRequests(member).find(ref => Date.parse(ref.at) > Date.parse(trigger.at) && ref.at <= now);
    if (reply) traceSuppression(projection, output, { dedupeKey: check.key, evidenceAt: check.evidenceAt, sessionKey: record.key,
      memberSessionId: trigger.sessionId, scope: 'notice', intervalMs: WAITING_INTERVAL_MS, reply }, 'user_replied');
  }
  for (const member of members) {
    const push = projection.pushes.filter(p => p.recordKey === record.key && p.sessionId === member.sessionId && p.at <= now)
      .sort((a, b) => a.at.localeCompare(b.at) || ['waiting_permission', 'turn_end', 'session_end'].indexOf(a.event) - ['waiting_permission', 'turn_end', 'session_end'].indexOf(b.event)).at(-1);
    const facts = new Map<string, WaitingWindow>();
    const include = (window: WaitingWindow) => {
      const key = JSON.stringify([waitingWindowKey(window), window.evidenceAt]);
      if (!facts.has(key)) facts.set(key, window);
    };
    for (const window of projection.waitingWindows.values()) if (window.sessionKey === record.key && window.memberSessionId === member.sessionId) include(window);
    const current = (evidenceAt: string, scope: WaitingWindow['scope']) => include({ evidenceAt, scope,
      dedupeKey: `waiting:${record.key}:${member.sessionId}`, sessionKey: record.key, memberSessionId: member.sessionId, intervalMs: WAITING_INTERVAL_MS });
    if (push?.event === 'waiting_permission') current(push.at, 'notice');
    if (config.judge && member.assistantReply) current(member.assistantReply.at, 'model_check');
    for (const fact of facts.values()) {
      if (projection.notices.some(n => n.kind === 'waiting' && n.sessionKey === record.key
        && (n.memberSessionId ?? record.sessionId) === member.sessionId && n.evidenceAt === fact.evidenceAt)) continue;
      const reply = humanRequests(member).find(ref => Date.parse(ref.at) > Date.parse(fact.evidenceAt) && Date.parse(ref.at) <= Date.parse(now));
      const target = { ...fact, ...(reply ? { reply: { ...reply, sessionId: member.sessionId } } : {}) };
      if (reply) traceSuppression(projection, output, target, 'user_replied');
      else if ((push?.at === fact.evidenceAt || member.assistantFinished) && Date.parse(now) - Date.parse(fact.evidenceAt) < fact.intervalMs) {
        traceSuppression(projection, output, target, 'waiting_interval');
      }
    }
  }
}
