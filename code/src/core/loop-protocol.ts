import { isAbsolute, resolve } from 'node:path';
import { object } from './utils.ts';
import type { LoopEvent, LoopState, LoopStatus, WorkerReceipt } from './managed-types.ts';

export const BATCH_STAGE = '@batch';
const states: Record<string, LoopState> = { started: 'started', running: 'started', 'needs-decision': 'needs_decision', paused: 'paused', 'repair-limit': 'repair_limit', done: 'completed', failed: 'failed', resumed: 'resumed', queue: 'queue' };
const safe = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');
export function nativeIdentity(raw: unknown) {
  const batch = object(raw, 'Loop批次身份');
  if (!safe(batch.file) || !isAbsolute(batch.file) || !safe(batch.name, 200) || !batch.name || /[/\\]/.test(batch.name) || !safe(batch.recipe, 100)) throw new Error('Loop批次身份不合法');
  return { file: resolve(batch.file), name: batch.name, recipe: batch.recipe };
}
function evidence(raw: unknown): Record<string, string> {
  const value = object(raw, 'Loop证据');
  if (Object.keys(value).length > 30 || Object.entries(value).some(([key, path]) => !safe(key, 100) || !safe(path) || !isAbsolute(path))) throw new Error('Loop证据不合法');
  return value as Record<string, string>;
}
/** 只转换协议字段；原件在native保留，不把名字当成文件身份。 */
export function fromNativeEvent(raw: unknown): LoopEvent {
  const row = object(raw, 'Loop v1事件'), batch = nativeIdentity(row.batch), detail = object(row.detail, 'Loop详情');
  if (row.v !== 1 || !states[row.status] || row.status === 'running' || !safe(row.id, 200) || !row.id
    || !Number.isSafeInteger(row.seq) || row.seq < 1 || !safe(row.at, 100) || !Number.isFinite(Date.parse(row.at)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(row.at)
    || !safe(row.project) || !isAbsolute(row.project) || row.stage !== null && (!safe(row.stage, 200) || !row.stage || row.stage === BATCH_STAGE)
    || !safe(row.reason?.category, 100) || !safe(row.reason?.text)) throw new Error('Loop v1事件不合法');
  const paths = evidence(row.evidence);
  return { schema: 1, id: row.id, seq: row.seq, at: row.at, project: resolve(row.project), batch: batch.name, batchFile: batch.file, stage: row.stage ?? BATCH_STAGE,
    state: states[row.status]!, reason: row.reason, evidence: Object.values(paths), detail: { ...detail,
      ...(row.status === 'queue' ? { status: detail.queueStatus, returns: detail.returnCount } : {}),
      ...(row.status === 'needs-decision' && !detail.question ? { question: row.reason.text || 'Loop需要决定，未提供原问题；请回电脑核对' } : {}) },
    native: { v: 1, id: row.id, seq: row.seq, at: row.at, project: row.project, batch, stage: row.stage, status: row.status, reason: row.reason, evidence: paths, detail } };
}
export function fromNativeQuery(raw: unknown, project: string, name: string, file?: string): LoopStatus {
  const value = object(raw, 'Loop查询');
  if (value.v !== 1 || !safe(value.at, 100) || !Number.isFinite(Date.parse(value.at)) || !Array.isArray(value.batches)) throw new Error('Loop查询外壳不合法');
  const matches = value.batches.filter((row: any) => row?.project === project && row.batch?.name === name && (!file || row.batch?.file === file));
  if (matches.length !== 1) throw new Error('项目+批次名称/文件不能唯一定位，未猜测');
  const row = object(matches[0], 'Loop批次'), identity = nativeIdentity(row.batch);
  if (!Array.isArray(row.stages)) throw new Error('Loop段不合法');
  const stage = (name: string, state: unknown, pause: any, next: unknown, paths: unknown, session?: any, extras = {}) => {
    if (!safe(name, 200) || !name || typeof state !== 'string' || !states[state] || next !== undefined && !['send', 'resume', 'grant', 'manual'].includes(String(next))) throw new Error('Loop阶段不合法');
    return { name, state: states[state]!, ...(pause ? { reason: { category: String(pause.category), text: String(pause.text) } } : {}),
      evidence: Object.values(evidence(paths)), detail: { ...(next ? { next } : {}), ...extras },
      // 整批层不提供会话，不适用并不等于死亡；实际段也只转换明确的alive事实。
      ...(name !== BATCH_STAGE && session && typeof session.alive === 'boolean'
        ? { sessionPresent: session.alive, ...(safe(session.id, 200) ? { sessionId: session.id } : {}) } : {}) };
  };
  const stages = row.stages.map((item: any) => stage(item.stage, item.state, item.pause, item.next, item.evidence, item.session, { round: item.round, repairs: item.repairs, paRelays: item.paRelays }));
  if (row.state !== null && row.state !== undefined) stages.push(stage(BATCH_STAGE, row.state, row.pause, row.next, row.evidence, undefined));
  const activities = row.stages.map((item: any) => item.lastActivity).filter((at: unknown): at is string => safe(at, 100) && Number.isFinite(Date.parse(at))).sort();
  return { schema: 1, batch: name, batchFile: identity.file, updatedAt: value.at, stages,
    ...(activities.length ? { lastActivityAt: activities.at(-1) } : {}),
    ...(typeof row.branch === 'string' ? { branch: row.branch } : {}), ...(typeof row.commit === 'string' ? { commit: row.commit } : {}),
    ...(row.queue ? { queue: { status: row.queue.status, returns: row.queue.returnCount ?? 0 } } : {}), native: row };
}
export function fromNativeReceipt(raw: unknown, requestId: string, command: '送话' | '续跑'): WorkerReceipt {
  const row = object(raw, 'Loop回执');
  if (row.v !== 1 || row.id !== requestId || row.command !== command) return { requestId, status: 'uncertain', failure: true, reason: 'Loop回执身份不符，不重发' };
  const status = command === '送话' ? ({ read: 'consumed', delivered: 'delivered', sending: 'uncertain', unknown: 'uncertain', rejected: 'failed', failed: 'failed' } as const)[row.state as string]
    : ({ started: 'consumed', starting: 'uncertain', rejected: 'failed', failed: 'failed' } as const)[row.state as string];
  return { requestId, status: status ?? 'uncertain', ...(row.state === 'rejected' ? { code: 'rejected' } : {}),
    reason: command === '续跑' && row.state === 'started' ? '整批编排已启动；不表示验收通过或段已读' : safe(row.reason?.text, 1000) ? row.reason.text : `Loop回执：${String(row.state)}` };
}
