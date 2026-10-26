import { membersOf, pushMatchesMember } from './sessions.ts';
import { boundedContext, piJudge, validateJudgment } from './model.ts';
import { compact, hash } from './utils.ts';
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
    newSteps: member.recentSteps.filter(step => !previous?.stepIds.includes(stepId(step))), assistantReply: reply,
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
    timer = setTimeout(() => { controller.abort(); reject(new Error('模型判断超时')); }, Math.max(1, milliseconds));
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
  for (const record of records) for (const item of candidates(record, projection, config, now)) {
    const previous = projection.modelChecks.get(item.key);
    const deferred = previous?.error === DEFERRED;
    if (previous?.fingerprint === item.fingerprint && !deferred) continue;
    // 首次接入的旧完成记录也不是新动静，不能先耗尽额度再轮到当前任务。
    if (Date.parse(now) - Date.parse(item.evidenceAt) > ONE_DAY
      || (projection.startedAt && Date.parse(item.evidenceAt) < Date.parse(projection.startedAt) - FIRST_LOOKBACK)) continue;
    if (item.task === 'drift' && (!item.context.newSteps.length || (previous && !deferred && Date.parse(now) - Date.parse(previous.at) < TEN_MINUTES))) continue;
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
      try { check.result = validateJudgment(await timedJudgment(judge, request, Math.min(config.judge.timeoutMs, deadline - performance.now())), request); }
      catch { check.error = '调用失败，仅规则判断'; }
    }
    await persist({ kind: 'model_checked', check });
    projection.modelChecks.set(item.key, check);
    checked++;
  }
  return checked;
}
/** 纯投影：overview/rebuild 不调模型，仅使用仍与当前证据一致的已记录答案。 */
export function applyModelChecks(records: JudgedRecord[], projection: Projection, config: Config, now: string): void {
  for (const record of records) {
    for (const item of candidates(record, projection, config, now)) {
      const check = projection.modelChecks.get(item.key);
      if (check?.fingerprint !== item.fingerprint) {
        if (item.task === 'drift' && check && Date.parse(now) - Date.parse(check.at) < TEN_MINUTES) (record.modelNotes ??= []).push('跑偏检查间隔未到，本轮仅规则判断');
        continue;
      }
      if (check.error) { (record.modelNotes ??= []).push(check.error); continue; }
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
      } else if (!record.modelWaiting && !record.waiting) {
        record.drift = finding;
        record.status = '疑似跑偏';
        record.reason = `可能偏离意图「${check.result.intentQuote}」；实际步骤「${check.result.stepQuote}」；${check.result.reason}`;
      }
    }
  }
}
