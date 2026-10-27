import { humanText, readableLines, requestedAction, replyExcerpt } from './notice-text.ts';
import { compact, hash, meaningfulRequest, object } from './utils.ts';
import type { Notice, RequestRef, SessionRecord, TaskActionType, TaskSnapshot, TaskSnapshotDraft, TaskSnapshotInput, Step } from './types.ts';

export const actionTypes: readonly TaskActionType[] = ['回答问题', '做个决定', '去看一眼', '不用管'];

/** 起草入口只有这四项。时间/索引在检测时记好，不再读原件或过程步骤。 */
export function snapshotInput(record: SessionRecord, lastOutput: string, factualStatus: TaskSnapshotInput['factualStatus'],
  at: string, anchor: 'reply' | 'step' = 'step', requestRef?: RequestRef | null): TaskSnapshotInput {
  const values = [record.intent.initial ?? '', ...record.intent.additions];
  const resolve = (ref: RequestRef | null | undefined) => ref && Date.parse(ref.at) <= Date.parse(at)
    ? meaningfulRequest(values[ref.index] ?? '') : '';
  const refs = record.requestRefs;
  const goal = refs ? resolve(refs.goal) : values.map(meaningfulRequest).find(Boolean) ?? '';
  // 子会话步骤的索引不能套进父会话 intent；旧记录无步骤索引时仍兼容原取法。
  const explicit = requestRef !== undefined && (!requestRef?.sessionId || requestRef.sessionId === record.sessionId);
  const current = explicit ? resolve(requestRef) : refs ? resolve(anchor === 'reply' ? refs.beforeReply : refs.beforeStep) || resolve(refs.latest)
    : values.map(meaningfulRequest).findLast(Boolean) ?? '';
  return {
    goal: goal || null, currentTask: current && current !== goal ? current : null,
    lastOutput: replyExcerpt(lastOutput), factualStatus,
  };
}

export function stepSnapshotInput(record: SessionRecord, step: Step): TaskSnapshotInput {
  return snapshotInput(record, step.text, '跑偏', step.at, 'step', step.requestRef);
}

function clean(text: string, project: string, now: string, limit: number): string {
  return compact(humanText(text, project, now).replace(/^(?:这件事|要你做)[:：]\s*/, ''), limit);
}
function situationText(text: string, project: string, now: string): string {
  return clean(text, project, now, 100).split(/(?<=[。！？!?])\s*/).slice(0, 2).join('');
}
function typeOf(action: string): TaskActionType {
  return /不用管/.test(action) ? '不用管' : /决定|选择|取舍|授权/.test(action) ? '做个决定'
    : /[？?]|回答|回复|提供|是否/.test(action) ? '回答问题' : '去看一眼';
}
/** 缺任一字段就整份兜底，不能把半份答案标成模型。 */
export function modelSnapshot(input: TaskSnapshotInput, value: unknown, project: string, now: string): TaskSnapshot | null {
  let data: Record<string, any>;
  try { data = object(value); } catch { return null; }
  if (typeof data.situation !== 'string' || typeof data.action !== 'string' || !actionTypes.includes(data.actionType)) return null;
  const situation = situationText(data.situation, project, now), action = clean(data.action, project, now, 58);
  if (!situation || !action) return null;
  return { ...input, situation, action, actionType: data.actionType, source: '模型' };
}
export function ruleSnapshot(input: TaskSnapshotInput, project: string, now: string): TaskSnapshot {
  const sentence = (value: string | null) => readableLines(value ?? '', project).join('；').split(/(?<=[。！？!?])\s*/)[0] ?? '';
  const goal = clean(sentence(input.goal).replace(/[。！？!?]+$/, ''), project, now, input.currentTask ? 30 : 50);
  const current = clean(sentence(input.currentTask).replace(/[。！？!?]+$/, ''), project, now, 25);
  const task = [goal, current && `当前${current}`].filter(Boolean).join('；') || '意图不明';
  const question = requestedAction(input.lastOutput, project, '');
  let situation = task, action = question;
  switch (input.factualStatus) {
    case '在等你':
      situation += question ? `：${clean(question, project, now, 30).replace(/[？?]$/, '')}，待你确认` : '：停下来等你确认下一步';
      action ||= '请回到会话确认下一步'; break;
    case '跑偏':
      situation += `：实际在做「${clean(input.lastOutput, project, now, Math.max(10, 85 - [...task].length))}」，可能偏离要求`;
      action ||= '请回到会话核对是否偏离要求'; break;
    case '停滞': {
      const prefix = goal || current ? `${task}：` : '';
      const duration = /；已 \d+ 分钟没动静$/.exec(input.lastOutput)?.[0] ?? '';
      const step = duration ? input.lastOutput.slice(0, -duration.length) : input.lastOutput;
      situation = `${prefix}${clean(step, project, now, Math.max(10, 98 - [...prefix + duration].length))}${duration}`;
      action ||= '请有空回去看看是否卡住；这里只提醒，不会替你启动或停止它。'; break;
    }
    case 'loop 完成': case 'loop 暂停': {
      situation = `${goal || current ? `${task}；` : ''}${input.lastOutput}`;
      const count = /还欠\s*(\d+)\s*项/.exec(input.lastOutput)?.[1];
      action = count && count !== '0' ? `还欠 ${count} 项，请${input.factualStatus === 'loop 暂停' ? '打开总结决定下一步' : '有空打开总结核销'}`
        : input.factualStatus === 'loop 暂停' ? '请打开总结，决定接下来怎么做'
          : /没写还欠什么/.test(input.lastOutput) ? '总结没写还欠什么，请有空打开确认' : '不用管，只是告诉你；还欠什么：无';
      break;
    }
    case '看不见了':
      situation = `${goal || current ? `${task}：` : ''}${input.lastOutput}`;
      action ||= '请回去看看这个会话是否仍在工作；正常可回「误报」'; break;
  }
  const draft: TaskSnapshotDraft = { situation: situationText(situation, project, now) || '会话目前需要你回去看一眼',
    action: clean(action, project, now, 58) || '请回到会话确认下一步', actionType: typeOf(action) };
  return { ...input, ...draft, source: '规则' };
}
export function standaloneSnapshot(notice: Notice): boolean {
  return ['stalled', 'loop_paused', 'loop_completed', 'blind', 'unreadable'].includes(notice.kind);
}
/** 不用展示文字做身份；停滞经过时长变化也不能令同一证据重花调用。 */
export function noticeSnapshotKey(notice: Notice): string {
  return hash(JSON.stringify([notice.tool, notice.sessionKey ?? notice.feedbackScope ?? notice.tool,
    notice.kind, notice.evidenceAt ?? notice.at]));
}
