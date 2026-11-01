import { decideWaiting } from './interaction.ts';
import { membersOf, sourceUnavailable } from './sessions.ts';
import type { Config, JudgedRecord, MemberWaitingFact, Projection, PushRecord, SessionMember, SessionRecord } from './types.ts';

export function addMemberWaiting(record: JudgedRecord, fact: MemberWaitingFact): void { (record.memberWaitings ??= []).push(fact); }
export function permissionReason(record: SessionRecord, member: SessionMember, push: PushRecord): string {
  return member.unavailable ? `子会话本轮读不了，保留最后一次已对账的等授权事实，尚无解除证据：${push.detail}`
    : `${member.sessionId === record.sessionId ? '会话' : '子会话'}收到等授权事件，该会话之后没有新动静：${push.detail}`;
}
function factFields(fact: MemberWaitingFact, record: JudgedRecord, projection: Projection) {
  const blank = { waiting: undefined, modelWaiting: undefined, ruleWaiting: undefined, analysisWaiting: undefined, programWaiting: undefined };
  switch (fact.kind) {
    case 'permission': return { ...blank, waiting: fact.waiting, sessionId: fact.waiting.sessionId, evidenceAt: fact.waiting.at, reply: fact.waiting.detail,
      reason: permissionReason(record, membersOf(record).find(m => m.sessionId === fact.waiting.sessionId) ?? record, fact.waiting), rank: 5 };
    case 'model': {
      const finding = fact.modelWaiting, member = membersOf(record).find(m => m.sessionId === finding.sessionId);
      const reply = projection.pushes.findLast(p => p.recordKey === record.key && p.sessionId === finding.sessionId && p.event === 'turn_end' && p.at === finding.evidenceAt)?.detail
        ?? member?.assistantReply?.text ?? '';
      return { ...blank, modelWaiting: finding, sessionId: finding.sessionId, evidenceAt: finding.evidenceAt, reply,
        reason: `模型判断可能在等你回复：${finding.result.reason}`, rank: 2 };
    }
    case 'rule': return { ...blank, ruleWaiting: fact.ruleWaiting, ...fact.ruleWaiting,
      reason: '判断模型不可用，仅按助手最后一个明确问题兜底；尚需你回复或确认', rank: 1 };
    case 'analysis': return { ...blank, analysisWaiting: fact.analysisWaiting, ...fact.analysisWaiting,
      reason: '助手本轮已停下，按等候规则处理', rank: 3 };
    case 'redline': return { ...blank, programWaiting: fact.programWaiting, ...fact.programWaiting,
      reason: '当前成员最后输出命中程序红线，需要你过目', rank: 4 };
  }
}
/** 每个成员/事实独立进入原提醒流水线；同一事实的不同判断来源合并，不挑一个成员后丢掉其他人。 */
export function waitingFactViews(record: JudgedRecord, projection: Projection, config: Config, now: string): JudgedRecord[] {
  if (record.tool === 'loop' || record.status === '已搁置' || sourceUnavailable(projection, record.tool)) return [];
  const facts = [...record.memberWaitings ?? []];
  if (record.waiting) facts.push({ kind: 'permission', waiting: record.waiting });
  if (record.modelWaiting) facts.push({ kind: 'model', modelWaiting: record.modelWaiting });
  if (record.ruleWaiting) facts.push({ kind: 'rule', ruleWaiting: record.ruleWaiting });
  if (record.analysisWaiting) facts.push({ kind: 'analysis', analysisWaiting: record.analysisWaiting });
  if (record.programWaiting) facts.push({ kind: 'redline', programWaiting: record.programWaiting });
  const selected = new Map<string, ReturnType<typeof factFields>>();
  for (const fact of facts) {
    const fields = factFields(fact, record, projection);
    if (!membersOf(record).some(member => member.sessionId === fields.sessionId)) continue;
    const key = JSON.stringify([fields.sessionId, Date.parse(fields.evidenceAt)]), previous = selected.get(key);
    if (!previous || previous.rank < fields.rank) selected.set(key, fields);
  }
  const items = [...selected.values()].map(fields => {
    const member = membersOf(record).find(m => m.sessionId === fields.sessionId)!;
    const view: JudgedRecord = { ...record, waiting: fields.waiting, programWaiting: fields.programWaiting, modelWaiting: fields.modelWaiting,
      ruleWaiting: fields.ruleWaiting, analysisWaiting: fields.analysisWaiting, reason: fields.reason, project: member.project, status: '在等我',
      assistantReply: member.assistantReply, recentSteps: member.recentSteps, pendingTools: member.pendingTools,
      memberWaitings: undefined, drift: undefined, notice: undefined, intelligenceNote: undefined };
    const extraRedline = !!fields.analysisWaiting && !!projection.analysisResults.get(fields.analysisWaiting.analysisId)?.output?.redline;
    const decision = decideWaiting(record, member, fields.evidenceAt, projection, config, now, fields.reply,
      !!fields.waiting || !!fields.programWaiting || extraRedline);
    const handled = projection.notices.some(n => n.kind === 'waiting' && n.sessionKey === record.key
      && (n.memberSessionId ?? record.sessionId) === fields.sessionId && n.evidenceAt === fields.evidenceAt)
      || (!!fields.analysisWaiting && projection.shadowDecisions.get(fields.analysisWaiting.analysisId)?.mode === 'blocked');
    return { view, handled, decision, sessionId: fields.sessionId, evidenceAt: fields.evidenceAt };
  });
  // 只影响展示/发送顺序，不影响后面的成员继续被处理。已提醒/挡掉的红线也不能占住新事实。
  items.sort((a, b) => Number(a.handled) - Number(b.handled) || Number(b.decision.ready) - Number(a.decision.ready)
    || Number(b.decision.redline) - Number(a.decision.redline) || b.evidenceAt.localeCompare(a.evidenceAt) || a.sessionId.localeCompare(b.sessionId));
  const views = items.map(item => item.view);
  // 原跑偏事实仍走自己的流程；新增成员红线不吞它，它也不能吞成员红线。
  if (views.length && record.drift && record.status === '疑似跑偏') views.push({ ...record, memberWaitings: undefined });
  return views;
}
/** 规划结束再选聚合展示；待发优先，不能把部分成员挡掉误说成整组都没叫。 */
export function mergeWaitingViews(record: JudgedRecord, views: JudgedRecord[]): void {
  const chosen = views.find(view => view.notice === '待写发件记录') ?? views[0];
  if (!chosen) return;
  record.status = chosen.status; record.reason = chosen.reason; record.notice = chosen.notice;
  record.waiting = chosen.waiting; record.modelWaiting = chosen.modelWaiting; record.ruleWaiting = chosen.ruleWaiting;
  record.analysisWaiting = chosen.analysisWaiting; record.programWaiting = chosen.programWaiting;
  record.intelligenceNote = views.every(view => view.intelligenceNote) ? '已交代完，没叫你' : undefined;
}
