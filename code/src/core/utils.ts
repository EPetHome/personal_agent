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
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value as JsonObject);
    } catch { throw new Error(`第 ${index + 1} 行无法解析为 JSON`); }
  }
  return rows;
}
export function findRow(rows: Iterable<JsonObject>, matches: (row: JsonObject) => boolean): JsonObject | undefined {
  for (const row of rows) if (matches(row)) return row;
}
export function filterRows(rows: Iterable<JsonObject>, matches: (row: JsonObject) => boolean): Iterable<JsonObject> {
  return { *[Symbol.iterator]() { for (const row of rows) if (matches(row)) yield row; } };
}
/** 故障隔离时只找核心身份；容忍其他行损坏，但结果不能代替完整 parse。 */
export function findJsonObject(text: string, matches: (row: JsonObject) => boolean): JsonObject | undefined {
  for (const line of text.split('\n')) {
    try {
      const row = object(JSON.parse(line));
      if (matches(row)) return row;
    } catch { /* 只提取仍可见的核心身份，不把坏文件判为正常。 */ }
  }
}
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(b => b && ['text', 'input_text', 'output_text'].includes(b.type))
    .map(b => typeof b.text === 'string' ? b.text : '').join('\n');
}
/** 按 Unicode 码点截断，不留下 UTF-16 的半个代理对。 */
export function truncateText(text: string, limit: number): string {
  let result = '';
  let count = 0;
  for (const character of text) {
    if (count++ >= limit) return `${result}…`;
    result += character;
  }
  return result;
}
/** 提醒正文的硬字节上限；省略号也计入上限。 */
export function truncateUtf8(text: string, limit: number): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let result = '';
  let bytes = Buffer.byteLength('…');
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) break;
    result += character;
  }
  return `${result}…`;
}
export function compact(text: string, limit = 220): string {
  return truncateText(text.replace(/\s+/g, ' ').trim(), limit);
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
/** 只收结构化 cwd 字段，不从命令、正文或工具输出推测目录。 */
export function observeCwd(record: SessionRecord, cwd: unknown): void {
  if (typeof cwd !== 'string' || !cwd.trim()) return;
  record.cwdHistory ??= [{ path: record.originals[0]!.path, cwds: [record.project] }];
  const history = record.cwdHistory[0]!;
  if (!history.cwds.includes(cwd)) history.cwds.push(cwd);
}
/** 媒体块已由 contentText 排除；再跳过工具写进 text 的图片/附件占位，保留同条消息里的真人文字。 */
export function intentText(text: string): string {
  return text.replace(/!\[[^\]\r\n]*\]\([^\r\n)]*\)/g, '')
    .replace(/\[(?:image|attachment|file|attached\s+(?:image|file)|图片|截图|附件)(?:\s*:[^\]\r\n]*|\s*：[^\]\r\n]*|\s*#?\d+)?\]/gi, '').trim();
}
export function addIntent(record: SessionRecord, text: string): void {
  const meaningful = intentText(text);
  if (!meaningful) return;
  const bounded = truncateText(meaningful, 1000);
  if (record.intent.initial === null) record.intent.initial = bounded;
  else record.intent.additions.push(bounded);
}
export function addStep(record: SessionRecord, step: { at: string; text: string }): void {
  record.recentSteps.push(step);
  if (record.recentSteps.length > 8) record.recentSteps.shift();
}
export function finishRecord(record: SessionRecord): SessionRecord {
  record.recentSteps = record.recentSteps.slice(-8);
  return record;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '未知错误'; }
