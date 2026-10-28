import { hash } from './utils.ts';
import type { SessionRecord } from './types.ts';

export type DeltaPath = (string | number)[];
export type DeltaOperation =
  | { path: DeltaPath; value: unknown }
  | { path: DeltaPath; remove: true }
  | { path: DeltaPath; length: number };
export interface SessionDelta {
  key: string;
  base: string | null;
  result: string;
  changes: DeltaOperation[];
}
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function fingerprint(value: unknown): string {
  function ordered(value: any): any {
    if (Array.isArray(value)) return value.map(ordered);
    if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
    return value;
  }
  return hash(JSON.stringify(ordered(value)));
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** 数组按索引/长度记变化：累计要求、真人索引和成员不会每轮重抄。 */
export function sessionDelta(previous: SessionRecord | undefined, record: SessionRecord): SessionDelta | null {
  // 同时规范 undefined 等 JSON 边界，磁盘重放与内存比较使用同一表示。
  const before = previous ? JSON.parse(JSON.stringify(previous)) : {}, after = JSON.parse(JSON.stringify(record));
  const changes: DeltaOperation[] = [];
  function diff(a: any, b: any, path: DeltaPath) {
    if (same(a, b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < b.length; i++) diff(a[i], b[i], [...path, i]);
      if (b.length < a.length) changes.push({ path, length: b.length });
    } else if (object(a) && object(b)) {
      for (const key of Object.keys(a)) if (!(key in b)) changes.push({ path: [...path, key], remove: true });
      for (const key of Object.keys(b)) diff(a[key], b[key], [...path, key]);
    } else changes.push({ path, value: b });
  }
  diff(before, after, []);
  return changes.length ? { key: record.key, base: previous ? fingerprint(before) : null,
    result: fingerprint(after), changes } : null;
}
export function validateSessionDelta(delta: SessionDelta): void {
  if (!delta || typeof delta.key !== 'string' || !delta.key || (delta.base !== null && typeof delta.base !== 'string')
    || typeof delta.result !== 'string' || !Array.isArray(delta.changes) || !delta.changes.length) throw new Error('会话差量结构损坏');
  for (const change of delta.changes) {
    if (!change || !Array.isArray(change.path) || change.path.some(part => typeof part === 'number'
      ? !Number.isSafeInteger(part) || part < 0 : typeof part !== 'string' || forbidden.has(part))
      || Number('value' in change) + Number('remove' in change) + Number('length' in change) !== 1
      || ('length' in change && (!Number.isSafeInteger(change.length) || change.length < 0))
      || ('remove' in change && change.remove !== true)) throw new Error('会话差量操作损坏');
  }
}
/** 写时复制路径，不修改旧事件/检查点里的对象；缺基底或校验不符绝不猜测。 */
export function applySessionDelta(previous: SessionRecord | undefined, delta: SessionDelta): SessionRecord {
  validateSessionDelta(delta);
  if ((previous ? fingerprint(previous) : null) !== delta.base) throw new Error('会话差量基底不符，保留日志，请从备份/归档恢复');
  let value: any = previous ?? {};
  for (const change of delta.changes) {
    function apply(current: any, depth: number): any {
      if (depth === change.path.length) {
        if ('value' in change) return change.value;
        if ('length' in change && Array.isArray(current) && change.length <= current.length) return current.slice(0, change.length);
        throw new Error('会话差量操作与基底不符');
      }
      if (!Array.isArray(current) && !object(current)) throw new Error('会话差量路径不存在');
      const part = change.path[depth]!;
      if (Array.isArray(current) && (typeof part !== 'number' || part > current.length)) throw new Error('会话差量数组索引不符');
      const copy: any = Array.isArray(current) ? [...current] : { ...current };
      if ('remove' in change && depth === change.path.length - 1) {
        if (Array.isArray(current) || !Object.hasOwn(current, part)) throw new Error('会话差量删除路径不符');
        delete copy[part];
      } else copy[part] = apply((current as any)[part], depth + 1);
      return copy;
    }
    value = apply(value, 0);
  }
  if (!value || value.key !== delta.key || !value.originals || !value.intent || fingerprint(value) !== delta.result) {
    throw new Error('会话差量结果校验失败，保留日志，请从备份/归档恢复');
  }
  return value;
}
