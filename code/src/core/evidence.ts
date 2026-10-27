import { hash } from './utils.ts';
import type { ModelCheck } from './types.ts';

/** 判断/提醒身份只认会话、成员、任务与事实时间，不认展示文字或模型配置。 */
export function modelEvidenceKey(fact: Pick<ModelCheck, 'recordKey' | 'sessionId' | 'task' | 'evidenceAt'>): string {
  const time = Date.parse(fact.evidenceAt);
  return hash(JSON.stringify([fact.recordKey, fact.sessionId, fact.task, Number.isFinite(time) ? time : fact.evidenceAt]));
}
