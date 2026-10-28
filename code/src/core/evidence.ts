import { hash } from './utils.ts';
import type { ModelCheck, Notice, Projection } from './types.ts';

type EvidenceFact = Pick<ModelCheck, 'recordKey' | 'sessionId' | 'task' | 'evidenceAt'> & Partial<Pick<ModelCheck, 'key'>>;
/** 成员级跑偏的 key 已在首次成员隔离中落盘；不靠模型配置、指纹或展示文字猜作用域。 */
export function isMemberScopedDrift(fact: Omit<EvidenceFact, 'evidenceAt'>): boolean {
  return fact.task === 'drift' && fact.key === `drift:${fact.recordKey}:${fact.sessionId}`;
}
/** 组级/等待保留旧身份；成员级跑偏有独立的证据作用域，即使成员和事实时间完全相同。 */
export function modelEvidenceKey(fact: EvidenceFact): string {
  const time = Date.parse(fact.evidenceAt);
  const identity = [fact.recordKey, fact.sessionId, fact.task, Number.isFinite(time) ? time : fact.evidenceAt];
  if (isMemberScopedDrift(fact)) identity.push('member-drift-v1');
  return hash(JSON.stringify(identity));
}
/** 执行与纯投影共用；旧检查点的索引即使未重建，也不能以错误作用域命中。 */
export function modelEvidenceFor(projection: Pick<Projection, 'modelEvidence'>, fact: EvidenceFact): ModelCheck | undefined {
  const key = modelEvidenceKey(fact), check = projection.modelEvidence.get(key);
  return check && modelEvidenceKey(check) === key ? check : undefined;
}
export function isMemberScopedDriftNotice(notice: Notice): boolean {
  if (notice.kind !== 'drift' || !notice.sessionKey || !notice.memberSessionId || !notice.evidenceAt) return false;
  const recordKey = notice.sessionKey, sessionId = notice.memberSessionId;
  return notice.dedupeKey === `drift:${recordKey}:${modelEvidenceKey({ recordKey, sessionId, task: 'drift',
    evidenceAt: notice.evidenceAt, key: `drift:${recordKey}:${sessionId}` })}`;
}
export function sameModelEvidenceScope(notice: Notice, fact: Omit<EvidenceFact, 'evidenceAt'>): boolean {
  return fact.task !== 'drift' || isMemberScopedDriftNotice(notice) === isMemberScopedDrift(fact);
}
export function indexModelEvidence(index: Map<string, ModelCheck>, check: ModelCheck): void {
  const key = modelEvidenceKey(check), previous = index.get(key);
  // 同一作用域的成功是/否答案不能被后来失败覆盖；不同作用域不会互相挤掉。
  if ((!check.error && check.result) || !previous?.result || previous.error) index.set(key, check);
}
/** 检查点只重建内存索引，不读归档、不改事实；兼容旧索引把两个作用域挤到同一位置的情况。 */
export function restoreModelEvidence(projection: Pick<Projection, 'modelEvidence' | 'modelChecks' | 'legacyChecks'>): Map<string, ModelCheck> {
  const index = new Map<string, ModelCheck>();
  for (const check of projection.modelEvidence.values()) indexModelEvidence(index, check);
  const authoritative = new Set(index.keys());
  for (const check of [...projection.legacyChecks.values(), ...projection.modelChecks.values()]) {
    const key = modelEvidenceKey(check), previous = index.get(key);
    if (!authoritative.has(key) || (check.result && !check.error && (!previous?.result || previous.error))) indexModelEvidence(index, check);
  }
  return index;
}
