import { membersOf, pushMatchesMember } from './sessions.ts';
import { modelEvidenceKey } from './evidence.ts';
import { requestedAction } from './notice-text.ts';
import { boundedContext, piJudge, validateJudgment } from './model.ts';
import { compact, hash } from './utils.ts';
import { ComponentFailure, safeFailure } from './process.ts';
import type { Config, EventPayload, Judge, JudgedRecord, JudgmentContext, JudgmentRequest, ModelCheck, Projection, SessionMember, SessionRecord } from './types.ts';

const TEN_MINUTES = 10 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
const FIRST_LOOKBACK = 60 * 60 * 1000;
interface Candidate { key: string; task: 'waiting' | 'drift'; sessionId: string; evidenceAt: string; fingerprint: string; context: JudgmentContext; stepIds: string[] }
function stepId(step: { at: string; text: string }): string { return hash(JSON.stringify(step)); }
function candidate(record: SessionRecord, member: SessionMember, task: Candidate['task'], reply: string, at: string, projection: Projection, config: Config): Candidate {
  const key = `${task}:${record.key}${task === 'waiting' ? `:${member.sessionId}` : ''}`;
  const previous = projection.modelChecks.get(key);
  const stepIds = member.recentSteps.map(stepId);
  const context = boundedContext({
    intentOriginal: record.intent.initial, additionalRequirements: record.intent.additions,
    previousSummary: previous?.summary ?? '',
    newSteps: member.recentSteps.filter(step => (previous?.error === '调用失败，仅规则判断' && !previous.failure) || !previous?.stepIds.includes(stepId(step))), assistantReply: reply,
  });
  return { key, task, sessionId: member.sessionId, evidenceAt: at, context, stepIds,
    fingerprint: hash(JSON.stringify([config.judge?.executable, config.judge?.model, record.intent, member.recentSteps, reply, at])) };
}
function candidates(record: JudgedRecord, projection: Projection, config: Config, now: string): Candidate[] {
  if (!config.judge || record.tool === 'loop' || ['看不见了', '已搁置'].includes(record.status) || membersOf(record).some(m => m.unavailable)) return [];
  const result: Candidate[] = [];
  const source = projection.sessions.get(record.key) ?? record;
  if (!record.waiting) for (const member of membersOf(source)) {
    const push = projection.pushes.filter(p => p.recordKey === record.key && pushMatchesMember(p, member) && p.at <= now
      && member.lastActivityAt !== null && p.at >= member.lastActivityAt)
      .sort((a, b) => a.at.localeCompare(b.at) || ['waiting_permission', 'turn_end', 'session_end'].indexOf(a.event) - ['waiting_permission', 'turn_end', 'session_end'].indexOf(b.event)).at(-1);
    if (member.sessionEnded || push?.event === 'session_end' || push?.event === 'waiting_permission' || member.pendingTools.length
      || !(member.assistantFinished || push?.event === 'turn_end')) continue;
    const reply = push?.event === 'turn_end' ? push.detail : member.assistantReply?.text ?? '';
    if (reply.trim()) result.push(candidate(record, member, 'waiting', reply, push?.at ?? member.lastActivityAt!, projection, config));
  }
  if (!record.waiting && record.intent.initial && record.recentSteps.length && !membersOf(record).every(m => m.sessionEnded)) {
    result.push(candidate(record, { ...record, lastActivityAt: record.lastActivityAt }, 'drift', '', record.lastActivityAt, projection, config));
  }
  return result;
}
const DEFERRED = '本轮模型时限用完，仅规则判断' as const;
async function timedJudgment(judge: Judge, request: JudgmentRequest, milliseconds: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new ComponentFailure('timeout', '模型调用或本轮等待超时')); controller.abort(); }, Math.max(1, milliseconds));
  });
  try { return await Promise.race([Promise.resolve().then(() => judge.judge(request, { signal: controller.signal })), timeout]); }
  finally { clearTimeout(timer!); }
}
/** 模型等待必须在数据锁外；persist 只短暂持锁，预留额度返回 false 表示当前额度已用完。 */
export async function checkModels(records: JudgedRecord[], projection: Projection, config: Config, now: string,
  persist: (payload: EventPayload) => Promise<boolean | void>, injected?: Judge): Promise<number> {
  if (!config.judge) return 0;
  const judge = injected ?? piJudge(config.judge);
  const day = now.slice(0, 10);
  const deadline = performance.now() + (config.judge.cycleTimeoutMs ?? 60000);
  let checked = 0;
  // 总览的工具/项目排序不能决定模型排队；最新证据优先，同一时刻先查是否在等用户。
  const queue = records.flatMap(record => candidates(record, projection, config, now).map(item => ({ record, item })))
    .sort((a, b) => b.item.evidenceAt.localeCompare(a.item.evidenceAt)
      || (a.item.task === b.item.task ? 0 : a.item.task === 'waiting' ? -1 : 1) || a.item.key.localeCompare(b.item.key));
  for (const { record, item } of queue) {
    const evidence = projection.modelEvidence.get(modelEvidenceKey({ ...item, recordKey: record.key }));
    // 同一事实已有成功的是/否答案，改提取方式、文案或模型配置都不重新花额度。
    if (evidence?.result && !evidence.error) continue;
    const previous = evidence ?? projection.modelChecks.get(item.key);
    const deferred = previous?.error === DEFERRED;
    const retry = deferred || previous?.error === '调用失败，仅规则判断'
      || (previous?.error === '每日额度用完，仅规则判断' && previous.at.slice(0, 10) !== day);
    if (evidence && !retry) continue;
    // 首次接入的旧完成记录也不是新动静，不能先耗尽额度再轮到当前任务。
    if (Date.parse(now) - Date.parse(item.evidenceAt) > ONE_DAY
      || (projection.startedAt && Date.parse(item.evidenceAt) < Date.parse(projection.startedAt) - FIRST_LOOKBACK)) continue;
    if (item.task === 'drift' && (!item.context.newSteps.length || (previous && !retry && Date.parse(now) - Date.parse(previous.at) < TEN_MINUTES))) continue;
    const check: ModelCheck = { key: item.key, recordKey: record.key, sessionId: item.sessionId, task: item.task,
      at: now, evidenceAt: item.evidenceAt, fingerprint: item.fingerprint, stepIds: item.stepIds,
      summary: compact([...([previous?.summary ?? '', ...item.context.newSteps.map(s => s.text)].filter(Boolean).join('；'))].slice(-500).join(''), 500) };
    const used = projection.modelCalls.get(day) ?? 0;
    if (used >= config.judge.dailyLimit) check.error = '每日额度用完，仅规则判断';
    else if (performance.now() >= deadline) {
      check.error = DEFERRED;
      // 尚未调用，不能吞掉这些新步骤或启动跑偏冷却；下轮继续而不是永远按缓存跳过。
      check.stepIds = previous?.stepIds ?? [];
      check.summary = previous?.summary ?? '';
    } else if (await persist({ kind: 'model_call_started', task: item.task, key: item.key }) === false) {
      check.error = '每日额度用完，仅规则判断';
    } else {
      projection.modelCalls.set(day, used + 1);
      const request: JudgmentRequest = { task: item.task, format: 'binary', context: item.context };
      try {
        const answer = await timedJudgment(judge, request, Math.min(config.judge.timeoutMs, deadline - performance.now()));
        try { check.result = validateJudgment(answer, request); }
        catch { throw new ComponentFailure('invalid_answer', '答案缺少约定的是非或依据字段'); }
      } catch (error) {
        check.error = '调用失败，仅规则判断'; check.failure = safeFailure(error);
      }
    }
    if (check.error) {
      // 失败/超限并未完成判断，不吞步骤；下一轮重试仍提供相同证据。
      check.stepIds = previous?.stepIds ?? [];
      check.summary = previous?.summary ?? '';
    }
    await persist({ kind: 'model_checked', check });
    projection.modelChecks.set(item.key, check);
    projection.modelEvidence.set(modelEvidenceKey(check), check);
    checked++;
  }
  return checked;
}
function ruleWaiting(record: JudgedRecord, item: Candidate, now: string): void {
  if (item.task !== 'waiting' || Date.parse(now) - Date.parse(item.evidenceAt) > ONE_DAY) return;
  const question = requestedAction(item.context.assistantReply, record.project, '');
  if (!question || !/[？?]|(?:请|需要你|等你).*(?:确认|选择|授权|回复|提供|核销)|是否/.test(question)) return;
  record.ruleWaiting = { sessionId: item.sessionId, evidenceAt: item.evidenceAt, reply: item.context.assistantReply };
  record.status = '在等我';
  record.reason = '判断模型不可用，仅按助手最后一个明确问题兜底；尚需你回复或确认';
}
/** 纯投影：overview/rebuild 不调模型；无模型/调用失败时用最后的明确问题兜底。 */
export function applyModelChecks(records: JudgedRecord[], projection: Projection, config: Config, now: string): void {
  for (const record of records) {
    for (const item of candidates(record, projection, config, now)) {
      const check = projection.modelEvidence.get(modelEvidenceKey({ ...item, recordKey: record.key }));
      if (!check) {
        const previous = projection.modelChecks.get(item.key);
        if (item.task === 'drift' && previous && Date.parse(now) - Date.parse(previous.at) < TEN_MINUTES) (record.modelNotes ??= []).push('跑偏检查间隔未到，本轮仅规则判断');
        continue;
      }
      if (check.error) {
        (record.modelNotes ??= []).push(check.error);
        if (check.failure) record.modelNotes.push(`${check.failure.category}：${check.failure.detail}`);
        ruleWaiting(record, item, now);
        continue;
      }
      if (check.result?.answer !== '是') continue;
      if (Date.parse(now) - Date.parse(item.evidenceAt) > ONE_DAY) {
        if (Date.parse(now) - Date.parse(record.lastActivityAt) > ONE_DAY) {
          record.status = '已搁置';
          record.reason = '模型先前判断可能需要你处理，但已超过 24 小时没有新动静；只进总览，不提醒';
        }
        continue;
      }
      const finding = { ...check, result: check.result };
      if (item.task === 'waiting') {
        record.modelWaiting = finding;
        record.status = '在等我';
        record.reason = `模型判断可能在等你回复：${check.result.reason}`;
      } else if (!record.modelWaiting && !record.ruleWaiting && !record.waiting) {
        record.drift = finding;
        record.status = '疑似跑偏';
        record.reason = `可能偏离意图「${check.result.intentQuote}」；实际步骤「${check.result.stepQuote}」；${check.result.reason}`;
      }
    }
  }
}
