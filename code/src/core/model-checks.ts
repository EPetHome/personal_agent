import { membersOf, mismatchedMemberIds, pushMatchesMember, sourceUnavailable } from './sessions.ts';
import { indexModelEvidence, modelEvidenceFor, sameModelEvidenceScope } from './evidence.ts';
import { humanRequests, waitingReady } from './interaction.ts';
import { requestedAction } from './notice-text.ts';
import { modelSnapshot, ruleSnapshot, snapshotInput, stepSnapshotInput } from './task-snapshot.ts';
import { boundedContext, piJudge, validateJudgment } from './model.ts';
import { compact, hash } from './utils.ts';
import { ComponentFailure, safeFailure } from './process.ts';
import type { Config, EventPayload, Judge, JudgedRecord, JudgmentContext, JudgmentRequest, ModelCheck, Projection, SessionMember, SessionRecord, TaskSnapshotInput } from './types.ts';

const TEN_MINUTES = 10 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
const FIRST_LOOKBACK = 60 * 60 * 1000;
interface Candidate { key: string; task: 'waiting' | 'drift'; sessionId: string; evidenceAt: string; fingerprint: string; context: JudgmentContext; stepIds: string[]; snapshotInput: TaskSnapshotInput; snapshotInputsByStep?: TaskSnapshotInput[] }
function stepId(step: { at: string; text: string }): string { return hash(JSON.stringify({ at: step.at, text: step.text })); }
function candidate(record: SessionRecord, member: SessionMember, task: Candidate['task'], reply: string, at: string, projection: Projection, config: Config, memberScoped = false): Candidate {
  const key = `${task}:${record.key}${task === 'waiting' || memberScoped ? `:${member.sessionId}` : ''}`;
  const previous = projection.modelChecks.get(key);
  const stepIds = member.recentSteps.map(stepId);
  const newSteps = member.recentSteps.filter(step => (previous?.error === '调用失败，仅规则判断' && !previous.failure)
    || !previous?.stepIds.includes(stepId(step))).slice(-8);
  const context = boundedContext({
    intentOriginal: record.intent.initial, additionalRequirements: record.intent.additions,
    previousSummary: previous?.summary ?? '',
    newSteps, assistantReply: reply,
  });
  return { key, task, sessionId: member.sessionId, evidenceAt: at, context, stepIds,
    snapshotInput: snapshotInput(record, task === 'waiting' ? reply : context.newSteps.at(-1)?.text ?? member.recentSteps.at(-1)?.text ?? '',
      task === 'waiting' ? '在等你' : '跑偏', task === 'waiting' ? member.assistantReply?.at ?? at : at, task === 'waiting' ? 'reply' : 'step'),
    ...(task === 'drift' ? { snapshotInputsByStep: context.newSteps.map((step, index) => stepSnapshotInput(record,
      { ...step, requestRef: newSteps[index]!.requestRef })) } : {}),
    fingerprint: hash(JSON.stringify([config.judge?.executable, config.judge?.model, record.intent, member.recentSteps, reply, at])) };
}
function candidates(record: JudgedRecord, projection: Projection, config: Config, now: string): Candidate[] {
  if (!config.judge || record.tool === 'loop' || record.status === '已搁置' || sourceUnavailable(projection, record.tool)) return [];
  const source = projection.sessions.get(record.key) ?? record;
  const mismatches = mismatchedMemberIds(source, projection);
  if (record.status === '看不见了' && !mismatches.size) return [];
  // 组的未知展示不能阻挡健康成员；故障成员既不作等待候选，也不把动作混进跑偏材料。
  const members = membersOf(source).filter(member => !mismatches.has(member.sessionId));
  if (!members.length || members.some(member => member.unavailable)) return [];
  const result: Candidate[] = [];
  const activities = members.map(member => ({ member,
    push: projection.pushes.filter(p => p.recordKey === record.key && pushMatchesMember(p, member) && p.at <= now
      && member.lastActivityAt !== null && p.at >= member.lastActivityAt)
      .sort((a, b) => a.at.localeCompare(b.at) || ['waiting_permission', 'turn_end', 'session_end'].indexOf(a.event) - ['waiting_permission', 'turn_end', 'session_end'].indexOf(b.event)).at(-1),
  }));
  if (!record.waiting) for (const { member, push } of activities) {
    if (member.sessionEnded || push?.event === 'session_end' || push?.event === 'waiting_permission' || member.pendingTools.length
      || !(member.assistantFinished || push?.event === 'turn_end')) continue;
    const reply = push?.event === 'turn_end' ? push.detail : member.assistantReply?.text ?? '';
    const at = push?.at ?? member.lastActivityAt!;
    const known = modelEvidenceFor(projection, { recordKey: record.key, sessionId: member.sessionId, task: 'waiting', evidenceAt: at });
    if (reply.trim() && (waitingReady(member, at, now) || (!!known?.result && !known.error))) {
      result.push(candidate(record, member, 'waiting', reply, at, projection, config));
    }
  }
  if (!record.waiting && record.intent.initial && record.recentSteps.length && !members.every(m => m.sessionEnded)) {
    // 单独的收尾问句不能绕过等待窗口花一次跑偏调用；真正的执行步骤仍立即检查。
    // 真人已接话而尚无后续步骤时，也不能拿旧答复重调模型。
    const actionable = activities.filter(({ member, push }) => {
      const latestHuman = humanRequests(member).at(-1)?.at;
      const finished = !member.pendingTools.length
        && (member.assistantFinished || member.sessionEnded || push?.event === 'turn_end' || push?.event === 'session_end');
      return member.recentSteps.some(step => {
        if (latestHuman && Date.parse(step.at) < Date.parse(latestHuman)) return false;
        // 工具与说明可在同一消息/同一毫秒；只给已结束回合的最终回复套窗口。
        // 旧步骤没有 kind 时按文本识别最终回复，不把同时间的工具一起压住。
        const replyStep = step.kind !== 'tool' && step.kind !== 'tool_result'
          && step.text === compact(member.assistantReply?.text ?? '');
        return !finished || !replyStep || waitingReady(member, push?.at ?? member.assistantReply?.at ?? step.at, now);
      });
    });
    if (mismatches.size) {
      for (const { member } of actionable) if (member.lastActivityAt !== null) {
        // 局部故障时按成员缓存，不能把旧组级摘要/冷却或其他成员步骤带进来。
        result.push(candidate(record, member, 'drift', '', member.lastActivityAt, projection, config, true));
      }
    } else if (actionable.length) result.push(candidate(record, { ...record, lastActivityAt: record.lastActivityAt }, 'drift', '', record.lastActivityAt, projection, config));
  }
  return result;
}
const DEFERRED = '本轮模型时限用完，仅规则判断' as const;
export async function timedModel<T>(call: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new ComponentFailure('timeout', '模型调用或本轮等待超时')); controller.abort(); }, Math.max(1, milliseconds));
  });
  try { return await Promise.race([Promise.resolve().then(() => call(controller.signal)), timeout]); }
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
    const evidence = modelEvidenceFor(projection, { ...item, recordKey: record.key });
    // 同一事实已有成功的是/否答案，改提取方式、文案或模型配置都不重新花额度。
    if (evidence?.result && !evidence.error) continue;
    // 升级抑制可看各类已交代事实；文案复用只能看本次判断的同类别。
    const announced = projection.notices.filter(n => n.sessionKey === record.key
      && sameModelEvidenceScope(n, { ...item, recordKey: record.key })
      && ['waiting', 'drift', 'stalled'].includes(n.kind) && (n.memberSessionId ?? record.sessionId) === item.sessionId
      && Date.parse(n.evidenceAt ?? '') === Date.parse(item.evidenceAt));
    if (announced.length && evidence && evidence.snapshotVersion !== 1) continue;
    const sameKind = announced.find(n => n.kind === item.task);
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
      at: now, evidenceAt: item.evidenceAt, fingerprint: item.fingerprint, stepIds: item.stepIds, snapshotVersion: 1,
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
      const context = item.task === 'waiting' ? { ...item.context, intentOriginal: item.snapshotInput.goal,
        additionalRequirements: item.snapshotInput.currentTask ? [item.snapshotInput.currentTask] : [], previousSummary: '', newSteps: [] } : item.context;
      const request: JudgmentRequest = { task: item.task, format: 'binary', context,
        ...(item.task === 'drift' ? { snapshotInputsByStep: item.snapshotInputsByStep } : { snapshotInput: item.snapshotInput }), draftSnapshot: !sameKind };
      try {
        const answer = await timedModel(signal => judge.judge(request, { signal }), Math.min(config.judge.timeoutMs, deadline - performance.now()));
        try { check.result = validateJudgment(answer, request); }
        catch { throw new ComponentFailure('invalid_answer', '答案缺少约定的是非或依据字段'); }
        if (check.result.answer === '是') {
          // validateJudgment 已核验引文；选其对应步骤/当时要求，不用末步或本轮最后活动代替。
          const index = item.task === 'drift' ? context.newSteps.findLastIndex(step => step.text.includes(check.result!.stepQuote!)) : -1;
          const input = item.snapshotInputsByStep?.[index] ?? item.snapshotInput;
          check.snapshot = (sameKind?.snapshot?.factualStatus === input.factualStatus ? sameKind.snapshot : null)
            ?? (sameKind ? null : modelSnapshot(input, check.result, record.project, now))
            ?? ruleSnapshot(input, record.project, now);
        }
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
    indexModelEvidence(projection.modelEvidence, check);
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
    const locallyBlind = mismatchedMemberIds(record, projection).size > 0;
    for (const item of candidates(record, projection, config, now)) {
      const check = modelEvidenceFor(projection, { ...item, recordKey: record.key });
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
        if (!locallyBlind && Date.parse(now) - Date.parse(record.lastActivityAt) > ONE_DAY) {
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
