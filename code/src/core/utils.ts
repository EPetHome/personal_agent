import { createHash } from 'node:crypto';
import type { Original, SessionRecord, Tool } from './types.ts';

// 外部 JSON 只在组件解析边界使用；统一记录在内部保持强类型。
export type JsonObject = Record<string, any>;
export function object(value: unknown, label = '记录'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}不是对象`);
  return value as JsonObject;
}
export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少${label}`);
  return value;
}
export function iso(value: unknown, label = '时间'): string {
  const text = requiredString(value, label);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error(`${label}必须是带时区的 ISO 时间`);
  }
  return new Date(text).toISOString();
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function jsonLines(text: string): JsonObject[] {
  const rows: JsonObject[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try { rows.push(object(JSON.parse(line))); }
    catch { throw new Error(`第 ${index + 1} 行无法解析为 JSON 对象`); }
  }
  if (!rows.length) throw new Error('会话文件为空');
  return rows;
}
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(b => b && ['text', 'input_text', 'output_text'].includes(b.type))
    .map(b => typeof b.text === 'string' ? b.text : '').join('\n');
}
export function compact(text: string, limit = 220): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
export function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
export function commandSummary(name: string, value: unknown): string {
  let args: JsonObject = {};
  if (typeof value === 'string') {
    try { args = object(JSON.parse(value)); } catch { return compact(name); }
  } else if (value && typeof value === 'object') args = value as JsonObject;
  const command = args.command ?? args.cmd;
  if (typeof command === 'string') return compact(`${name}：${command}`);
  if (Array.isArray(command)) return compact(`${name}：${command.join(' ')}`);
  const path = args.file_path ?? args.path;
  if (typeof path === 'string') return compact(`${name}：${path}`);
  if (typeof args.input === 'string') return compact(`${name}：${args.input.split('\n').slice(0, 3).join(' ')}`);
  return compact(name);
}
export function isHuman(text: string, ...metadata: JsonObject[]): boolean {
  for (const data of metadata) {
    if (data.origin?.kind && data.origin.kind !== 'human') return false;
    if (data.source && ['system', 'extension', 'loop', 'task-notification'].includes(data.source)) return false;
    if (data.promptSource === 'system' || data.isSynthetic === true || data.is_meta === true) return false;
  }
  if (metadata.some(data => data.origin?.kind === 'human')) return !!text.trim();
  return !!text.trim() && !/^\s*(?:<task-notification[\s>]|<\/?autoreview[\s>]|\[loop\]|\[自动评审返修\])/.test(text);
}
export function emptyRecord(tool: Tool, sessionId: string, project: string, at: string, original: Original): SessionRecord {
  return {
    key: `${tool}:${sessionId}`, tool, sessionId, project, type: 'ai_session',
    originals: [original], intent: { initial: null, additions: [] }, lastActivityAt: at,
    recentSteps: [], pendingTools: [], assistantFinished: false, sessionEnded: false,
  };
}
export function addIntent(record: SessionRecord, text: string): void {
  if (record.intent.initial === null) record.intent.initial = text;
  else record.intent.additions.push(text);
}
export function finishRecord(record: SessionRecord): SessionRecord {
  record.recentSteps = record.recentSteps.slice(-8);
  return record;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '未知错误'; }
