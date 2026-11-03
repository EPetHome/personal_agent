import { hash } from './utils.ts';
import { WAITING_INTERVAL_MS } from './interaction.ts';
import { membersOf } from './sessions.ts';
import type { EventPayload, Projection, SessionRecord, SuppressionReason, WaitingWindow } from './types.ts';

type Suppression = Extract<EventPayload, { kind: 'notice_suppressed' }>;
export function waitingWindowKey(window: Pick<WaitingWindow, 'sessionKey' | 'memberSessionId' | 'scope'>): string {
  return JSON.stringify([window.sessionKey, window.memberSessionId, window.scope]);
}
/** 以下两个索引仅用于兼容旧事件和检查点；不产生聊天判断、抑制事件或模型请求。 */
export function indexWaitingWindow(windows: Map<string, WaitingWindow>, decision: Suppression): void {
  if (!decision.sessionKey || !decision.memberSessionId || !decision.scope || !/^(?:waiting|model_waiting):/.test(decision.dedupeKey)) return;
  const window: WaitingWindow = { dedupeKey: decision.dedupeKey, evidenceAt: decision.evidenceAt, sessionKey: decision.sessionKey,
    memberSessionId: decision.memberSessionId, scope: decision.scope, intervalMs: decision.intervalMs ?? WAITING_INTERVAL_MS };
  const key = waitingWindowKey(window);
  if (decision.reason === 'waiting_interval') windows.set(key, window);
  else if (decision.reason === 'user_replied' && windows.get(key)?.evidenceAt === window.evidenceAt) windows.delete(key);
}
export function advanceWaitingWindows(windows: Map<string, WaitingWindow>, record: SessionRecord): void {
  for (const [key, window] of windows) {
    if (window.sessionKey !== record.key) continue;
    const member = membersOf(record).find(member => member.sessionId === window.memberSessionId);
    if (!member || member.unavailable || !member.assistantReply || member.assistantReply.at <= window.evidenceAt) continue;
    const refs = member.humanRequestRefs ?? (member.requestRefs?.latest ? [member.requestRefs.latest] : []);
    if (!refs.some(ref => (!member.parentSessionId || ref.explicitHuman === true)
      && Date.parse(ref.at) > Date.parse(window.evidenceAt) && Date.parse(ref.at) <= Date.parse(window.evidenceAt) + window.intervalMs)) windows.delete(key);
  }
}
export function traceSuppression(projection: Projection, output: EventPayload[] | undefined,
  target: Omit<Suppression, 'kind' | 'reason' | 'decisionKey'>, reason: SuppressionReason): void {
  if (!output) return;
  const decisionKey = hash(JSON.stringify([target.dedupeKey, target.evidenceAt, target.scope, reason,
    ...(target.waitingDecision ? [target.waitingDecision.state, target.waitingDecision.intervalMs, target.waitingDecision.otherHumanAt] : [])]));
  if (projection.telemetrySuppressions.has(decisionKey)) return;
  projection.telemetrySuppressions.add(decisionKey);
  output.push({ kind: 'notice_suppressed', ...target, reason, decisionKey });
}
