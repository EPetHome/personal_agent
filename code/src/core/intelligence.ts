import { basename } from 'node:path';
import { isRedline } from './action-items.ts';
import { isIgnoredProject } from './config.ts';
import { addMemberWaiting } from './waiting-facts.ts';
import { decideWaiting, humanRequests, latestMemberPush, waitingEvidenceAt } from './interaction.ts';
import { isInternalSession, membersOf, mismatchedMemberIds, sourceUnavailable } from './sessions.ts';
import { modelSnapshot, ruleSnapshot, snapshotInput } from './task-snapshot.ts';
import { hash } from './utils.ts';
import { CONFIDENCES, DEFAULT_INTELLIGENCE, INTENT_FIELDS } from './intelligence-types.ts';
import type { AnalysisOutput, AnalysisRequest, AnalysisResult, IntelligenceEvent, ShadowDecision } from './intelligence-types.ts';
import type { Config, EventPayload, JudgedRecord, Notice, Projection, SessionMember, SessionRecord } from './types.ts';

export function intelligenceEnabled(config: Config): boolean {
  return !!config.judge && config.judge.dailyLimit !== 0 && (config.intelligence?.enabled ?? DEFAULT_INTELLIGENCE.enabled);
}
export function intelligenceWorkPending(projection: Projection, now: string): boolean {
  if ([...projection.analysisRequests.keys()].some(id => !projection.analysisResults.has(id))) return true;
  for (const decision of projection.shadowDecisions.values()) {
    if (projection.shadowComparisons.has(decision.analysisId)) continue;
    if (projection.shadowReplies.has(decision.analysisId)) return true;
    const request = projection.analysisRequests.get(decision.analysisId), record = request && projection.sessions.get(request.recordKey);
    const member = record && membersOf(record).find(member => member.sessionId === request!.sessionId);
    if (member && humanRequests(member).some(ref => ref.at > decision.at && ref.at <= now)) return true;
  }
  return false;
}
export function analysisId(recordKey: string, sessionId: string, evidenceAt: string, reply: string): string {
  return hash(JSON.stringify([recordKey, sessionId, evidenceAt, hash(reply)]));
}
export function analysisCandidates(projection: Projection, config: Config, now: string): AnalysisRequest[] {
  if (!intelligenceEnabled(config)) return [];
  const candidates: AnalysisRequest[] = [];
  for (const record of projection.sessions.values()) {
    if (record.tool === 'loop' || config.sources[record.tool] === null || isIgnoredProject(record.project, config)
      || isInternalSession(record.tool, record.sessionId, record.project) || sourceUnavailable(projection, record.tool)) continue;
    const health = projection.health.get(record.tool);
    if (health?.sessionKeys && !health.sessionKeys.includes(record.key)) continue;
    const mismatches = mismatchedMemberIds(record, projection);
    for (const member of membersOf(record)) {
      if (member.unavailable || mismatches.has(member.sessionId) || member.pendingTools.length || !member.originals[0]) continue;
      const push = latestMemberPush(record, member, projection, now);
      if (member.sessionEnded || push?.event === 'session_end' || !(member.assistantFinished || push?.event === 'turn_end' || push?.event === 'waiting_permission')) continue;
      const reply = push?.event === 'turn_end' || push?.event === 'waiting_permission' ? push.detail : member.assistantReply?.text ?? '';
      const evidenceAt = waitingEvidenceAt(record, member, push);
      if (!reply.trim() || Date.parse(evidenceAt) > Date.parse(now) || Date.parse(now) - Date.parse(evidenceAt) > 86400000
        || (projection.startedAt && Date.parse(evidenceAt) < Date.parse(projection.startedAt) - 3600000)) continue;
      const waiting = decideWaiting(record, member, evidenceAt, projection, config, now, reply, push?.event === 'waiting_permission');
      if (waiting.state === 'replied') continue;
      const input = snapshotInput(record, reply, '在等你', member.assistantReply?.at ?? evidenceAt, 'reply');
      candidates.push({ id: analysisId(record.key, member.sessionId, evidenceAt, reply), recordKey: record.key, sessionId: member.sessionId,
        tool: record.tool, project: member.project, transcript: member.originals[0].path, evidenceAt,
        replyAt: member.assistantReply?.at ?? evidenceAt, outputFingerprint: hash(reply), ruleRedline: waiting.redline,
        requestedAt: now, actionType: ruleSnapshot(input, member.project, now).actionType });
    }
  }
  return candidates;
}
export function requestAnalyses(projection: Projection, config: Config, now: string, candidates = analysisCandidates(projection, config, now)): IntelligenceEvent[] {
  return candidates.filter(request => !projection.analysisRequests.has(request.id))
    .map(request => ({ kind: 'analysis_requested', request }));
}
export function validAnalysis(value: unknown, redline: boolean): AnalysisOutput {
  const data = value as AnalysisOutput | null;
  if (!data || typeof data.situation !== 'string' || !data.situation.trim() || typeof data.reason !== 'string' || !data.reason.trim()
    || !['欠', '已交代完', '拿不准'].includes(data.debt) || !CONFIDENCES.includes(data.confidence)
    || typeof data.redline !== 'boolean' || typeof data.suggestedReply !== 'string'
    || !['回答问题', '做个决定', '去看一眼', '不用管'].includes(data.actionType)
    || !data.intent || INTENT_FIELDS.some(key => !data.intent[key] || typeof data.intent[key].value !== 'string'
      || !data.intent[key].value.trim() || typeof data.intent[key].basis !== 'string' || !data.intent[key].basis.trim()
      || !CONFIDENCES.includes(data.intent[key].confidence))) throw new Error('分析缺少约定的判断、七栏依据或把握');
  const risky = redline || data.redline || isRedline(data.suggestedReply);
  return { situation: data.situation.slice(0, 1000), debt: data.debt, reason: data.reason.slice(0, 2000), confidence: data.confidence,
    suggestedReply: risky ? '' : data.suggestedReply.slice(0, 8000), redline: risky, actionType: data.actionType, intentConfirmed: false,
    intent: Object.fromEntries(INTENT_FIELDS.map(key => [key, { value: data.intent[key].value.slice(0, 4000),
      basis: data.intent[key].basis.slice(0, 4000), confidence: data.intent[key].confidence }])) as AnalysisOutput['intent'] };
}
export function completedAnalysis(projection: Projection, request: AnalysisRequest): AnalysisResult | undefined {
  const result = projection.analysisResults.get(request.id);
  return result?.output && !result.failure ? result : undefined;
}
/** 全部当前成员事实独立保留；单值展示在规划后选择，影子正文不进入 JudgedRecord。 */
export function applyAnalyses(records: JudgedRecord[], projection: Projection, config: Config, now: string, candidates = analysisCandidates(projection, config, now)): void {
  for (const request of candidates) {
    const record = records.find(record => record.key === request.recordKey);
    if (!record) continue;
    const source = projection.sessions.get(request.recordKey)!;
    const member = membersOf(source).find(member => member.sessionId === request.sessionId)!;
    const push = latestMemberPush(source, member, projection, now);
    const reply = push?.event === 'turn_end' || push?.event === 'waiting_permission' ? push.detail : member.assistantReply?.text ?? '';
    const waiting = { sessionId: request.sessionId, evidenceAt: request.evidenceAt, reply };
    // 程序硬判红线不等分析，也不依赖另一个模型答「是」；更不能被父/兄弟的分析遮住。
    if (request.ruleRedline) addMemberWaiting(record, { kind: 'redline', programWaiting: waiting });
    const result = completedAnalysis(projection, request);
    if (!result?.output || result.at > now) continue;
    // 普通分析不覆盖跑偏；成员红线仍独立进入提醒队列。
    if (record.drift && !request.ruleRedline && !result.output.redline) continue;
    addMemberWaiting(record, { kind: 'analysis', analysisWaiting: { ...waiting, analysisId: request.id } });
    if (!record.waiting && !record.drift && record.status !== '看不见了') {
      record.status = '在等我';
      record.reason = '助手本轮已停下，按等候规则处理';
    }
  }
}
export function analysisSnapshot(notice: Notice, base: NonNullable<Notice['snapshot']>, result?: AnalysisResult): NonNullable<Notice['snapshot']> {
  if (!result?.output) return base;
  const drafted = modelSnapshot(base, { ...base, situation: result.output.situation }, notice.content.evidence.project ?? '', notice.at);
  return drafted ? { ...base, situation: drafted.situation, source: '模型' } : base;
}
export function shadowCategory(request: AnalysisRequest, result?: AnalysisResult): string {
  const output = result?.output;
  return `在等你 × ${output?.actionType ?? request.actionType} × ${request.tool} × ${request.ruleRedline || output?.redline ? '红线' : '非红线'}`;
}
export function shadowDecision(request: AnalysisRequest, result: AnalysisResult, record: SessionRecord, member: SessionMember,
  projection: Projection, config: Config, now: string, noticeId?: string): ShadowDecision {
  const waitingDecision = decideWaiting(record, member, request.evidenceAt, projection, config, now, '', request.ruleRedline || !!result.output?.redline);
  const complete = result.output?.debt === '已交代完' && result.output.confidence === '有把握' && !waitingDecision.redline;
  const paused = projection.shadowGuards.get(shadowCategory(request, result))?.paused;
  const mode = !waitingDecision.activeConversation ? 'shadow_only'
    : complete && waitingDecision.state === 'other_session' && !paused ? 'blocked'
      : complete ? 'could_skip' : 'reminded';
  return { analysisId: request.id, at: now, mode, waitingDecision, ...(noticeId ? { noticeId } : {}) };
}
export function waitingAnalysis(record: SessionRecord, member: SessionMember, evidenceAt: string, projection: Projection, config: Config, now: string) {
  if (!intelligenceEnabled(config)) return undefined;
  const push = latestMemberPush(record, member, projection, now);
  const reply = push?.event === 'turn_end' || push?.event === 'waiting_permission' ? push.detail : member.assistantReply?.text ?? '';
  const request = projection.analysisRequests.get(analysisId(record.key, member.sessionId, evidenceAt, reply));
  const result = request && completedAnalysis(projection, request);
  return request && result && result.at <= now ? { request, result } : undefined;
}
/** 在真正到点且尚未交代的事实处调用；无结果、拿不准、红线和5分钟类均不挡。 */
export function shouldBlockWaiting(record: JudgedRecord, member: SessionMember, evidenceAt: string, projection: Projection,
  config: Config, now: string, suppressed?: EventPayload[]): boolean {
  const analysis = waitingAnalysis(record, member, evidenceAt, projection, config, now);
  if (!analysis) return false;
  const { request, result } = analysis;
  const decision = shadowDecision(request, result, record, member, projection, config, now);
  if (decision.mode !== 'blocked') return false;
  record.intelligenceNote = '已交代完，没叫你';
  if (!projection.shadowDecisions.has(request.id) && !suppressed?.some(e => e.kind === 'shadow_decided' && e.decision.analysisId === request.id))
    suppressed?.push({ kind: 'shadow_decided', decision });
  return true;
}
/** 卡片/挡掉之后的下一句引用与6h/24h客观标注；不把不操作当作建议正确。 */
export function observeShadowOutcomes(projection: Projection, now: string): IntelligenceEvent[] {
  const events: IntelligenceEvent[] = [];
  for (const decision of projection.shadowDecisions.values()) {
    const request = projection.analysisRequests.get(decision.analysisId), result = projection.analysisResults.get(decision.analysisId);
    if (!request || !result?.output || decision.at > now) continue;
    const record = projection.sessions.get(request.recordKey);
    const member = record && membersOf(record).find(m => m.sessionId === request.sessionId);
    const reply = member && !member.unavailable ? humanRequests(member).filter(r => r.at > decision.at && r.at <= now).sort((a, b) => a.at.localeCompare(b.at))[0] : undefined;
    if (!projection.shadowLabels.has(request.id)) {
      const elapsed = reply ? Date.parse(reply.at) - Date.parse(decision.at) : Date.parse(now) - Date.parse(decision.at);
      if (reply && elapsed <= 6 * 3600000) events.push({ kind: 'shadow_labeled', label: { analysisId: request.id, at: now,
        debt: '当时欠你', ...(result.output.debt === '已交代完' ? { correct: false } : {}) } });
      else if (elapsed >= 86400000 || reply) {
        const health = projection.health.get(request.tool);
        const observable = !!member && !member.unavailable && !sourceUnavailable(projection, request.tool)
          && (!health?.sessionKeys || health.sessionKeys.includes(request.recordKey));
        const finished = observable && (!reply || elapsed >= 86400000);
        events.push({ kind: 'shadow_labeled', label: { analysisId: request.id, at: now,
          debt: finished ? '聊完了' : '无法判断', ...(finished && result.output.debt === '已交代完' ? { correct: true } : {}) } });
      }
    }
  }
  return events;
}
export function observeShadowDecisions(projection: Projection, now: string): IntelligenceEvent[] {
  const events: IntelligenceEvent[] = [];
  for (const request of projection.analysisRequests.values()) {
    const result = completedAnalysis(projection, request);
    if (!result?.output || projection.shadowDecisions.has(request.id)) continue;
    const notice = projection.notices.find(n => n.kind === 'waiting' && n.sessionKey === request.recordKey
      && n.memberSessionId === request.sessionId && n.evidenceAt === request.evidenceAt && n.at >= request.requestedAt && n.at <= now);
    if (!notice?.waitingDecision) continue;
    const w = notice.waitingDecision, complete = result.output.debt === '已交代完' && result.output.confidence === '有把握';
    events.push({ kind: 'shadow_decided', decision: { analysisId: request.id, at: notice.at, noticeId: notice.id, waitingDecision: w,
      mode: !w.activeConversation ? 'shadow_only' : complete && !w.redline && !result.output.redline ? 'could_skip' : 'reminded' } });
  }
  return events;
}
/** 每周五18点，按已获得6h/24h标签的挡提醒事实回看；只退回影子，绝不自动升级。 */
export function shadowGuardChanges(projection: Projection, now: string): IntelligenceEvent[] {
  const slot = new Date(now);
  slot.setDate(slot.getDate() - (slot.getDay() + 2) % 7); slot.setHours(18, 0, 0, 0);
  if (slot.getTime() > Date.parse(now)) slot.setDate(slot.getDate() - 7);
  const to = slot.toISOString(), week = to.slice(0, 10), start = slot.getTime() - 7 * 86400000;
  const counts = new Map<string, { wrong: number; total: number }>();
  for (const decision of projection.shadowDecisions.values()) {
    const label = projection.shadowLabels.get(decision.analysisId), request = projection.analysisRequests.get(decision.analysisId);
    if (decision.mode !== 'blocked' || Date.parse(decision.at) < start || decision.at > to || !label || label.at > to
      || label.correct === undefined || !request) continue;
    const category = shadowCategory(request, projection.analysisResults.get(request.id));
    const count = counts.get(category) ?? { wrong: 0, total: 0 }; count.total++; if (!label.correct) count.wrong++; counts.set(category, count);
  }
  return [...counts].filter(([category]) => projection.shadowGuards.get(category)?.week !== week).map(([category, count]) => ({
    kind: 'shadow_guard', guard: { category, week, paused: projection.shadowGuards.get(category)?.paused === true || count.wrong / count.total > 0.1 },
  }));
}
export function shadowSessionName(request: AnalysisRequest): string { return `${basename(request.project)} · ${request.tool} · ${request.sessionId}`; }
