import { addIntent, addStep, commandSummary, compact, contentText, emptyRecord, findJsonObject, findRow, finishRecord, isHuman, iso, jsonLines, requiredString, truncateText } from '../../core/utils.ts';
import type { JsonObject } from '../../core/utils.ts';
import type { Original, SessionIdentity, SessionRecord, SourceComponent } from '../../core/types.ts';

const metadataNodes = new Set(['branch_summary', 'compaction', 'model_change', 'thinking_level_change', 'custom', 'custom_message', 'session_info', 'context_edit']);
const messageRoles = new Set(['user', 'assistant', 'toolResult']);
function identifyRow(row: JsonObject): SessionIdentity | null {
  return row.type === 'session' && typeof row.id === 'string' && row.id.trim() && typeof row.cwd === 'string' && row.cwd.trim()
    ? { sessionId: row.id, project: row.cwd } : null;
}
/** 树中只留定位与有限核心信号，不保留工具输出、思考、图片、自定义数据等大正文。 */
function node(row: JsonObject): JsonObject {
  const result: JsonObject = { type: row.type, id: row.id, parentId: row.parentId, timestamp: row.timestamp };
  if (row.type !== 'message') return result;
  const message = row.message;
  if (message?.role === 'user') {
    const text = contentText(message.content);
    result.message = { role: 'user', content: truncateText(text, 1000), human: isHuman(text, row, message) };
  } else if (message?.role === 'assistant') {
    const blocks: JsonObject[] = [];
    const text = contentText(message.content);
    if (text) blocks.push({ type: 'text', text: compact(text, 1200) });
    for (const b of Array.isArray(message.content) ? message.content : []) {
      if (b?.type === 'toolCall' && !['error', 'aborted'].includes(message.stopReason)) blocks.push({ type: b.type, id: b.id, name: b.name,
        summary: typeof b.name === 'string' ? commandSummary(b.name, b.arguments) : '' });
    }
    result.message = { role: 'assistant', content: blocks, stopReason: message.stopReason };
  } else if (message?.role === 'toolResult') {
    result.message = { role: 'toolResult', toolCallId: message.toolCallId, isError: message.isError };
  } else result.message = { role: message?.role };
  return result;
}
function parseRows(rows: Iterable<JsonObject>, original: Original): SessionRecord | null {
  const header = findRow(rows, row => row.type === 'session' || (row.type === 'header' && row.version === 1));
  if (!header || header.version === 1 || !identifyRow(header)) return null;
  const entries = new Map<string, JsonObject>();
  let leaf: JsonObject | undefined;
  let messages = 0;
  for (const source of rows) {
    if (source.type === 'session') continue;
    const row = node(source);
    const coreMessage = row.type === 'message' && messageRoles.has(row.message?.role);
    if (coreMessage) messages++;
    const meaningful = coreMessage || metadataNodes.has(row.type);
    if (typeof row.id !== 'string' || !row.id || (row.parentId !== null && typeof row.parentId !== 'string')) {
      if (coreMessage) throw new Error('Pi 消息缺少树节点 id/parentId');
      continue;
    }
    if (entries.has(row.id)) {
      if (!meaningful) continue;
      const previous = entries.get(row.id)!;
      if (metadataNodes.has(previous.type) || (previous.type === 'message' && messageRoles.has(previous.message?.role))) throw new Error('Pi 树节点 id 重复');
    }
    entries.set(row.id, row);
    if (meaningful) leaf = row;
  }
  if (!messages) return null;
  const record = emptyRecord('pi', requiredString(header.id, '会话 id'), requiredString(header.cwd, 'cwd'), iso(header.timestamp), original);
  const branch: JsonObject[] = [];
  const seen = new Set<string>();
  while (leaf) {
    if (seen.has(leaf.id)) throw new Error('Pi 分支成环');
    seen.add(leaf.id);
    branch.push(leaf);
    if (leaf.parentId === null) break;
    const parent = entries.get(leaf.parentId);
    if (!parent) throw new Error('Pi 当前分支缺少父节点');
    leaf = parent;
  }
  const pending = new Map<string, { id: string; at: string; text: string }>();
  for (const row of branch.reverse()) {
    if (row.type !== 'message') continue;
    const message = row.message;
    if (!message || !messageRoles.has(message.role)) continue;
    const at = iso(row.timestamp);
    record.lastActivityAt = at > record.lastActivityAt ? at : record.lastActivityAt;
    if (message.role === 'user') {
      if (message.human) addIntent(record, message.content);
      record.assistantFinished = false;
      record.sessionEnded = false;
    } else if (message.role === 'assistant') {
      record.sessionEnded = false;
      for (const b of message.content) {
        if (b.type !== 'toolCall') continue;
        const id = requiredString(b.id, 'toolCall id');
        requiredString(b.name, '工具名');
        const step = { id, at, text: b.summary };
        pending.set(id, step);
        addStep(record, { at, text: step.text });
      }
      const text = contentText(message.content);
      if (text) {
        addStep(record, { at, text: compact(text) });
        record.assistantReply = { at, text };
      }
      record.assistantFinished = message.stopReason === 'stop' && !message.content.some((b: JsonObject) => b.type === 'toolCall');
    } else {
      pending.delete(requiredString(message.toolCallId, 'toolCallId'));
      addStep(record, { at, text: message.isError ? '工具返回错误' : '工具结果已返回' });
    }
  }
  record.pendingTools = [...pending.values()];
  return finishRecord(record);
}
export const pi: SourceComponent = {
  tool: 'pi', extension: '.jsonl', identifyRow, parseRows,
  identify(text) { const row = findJsonObject(text, row => identifyRow(row) !== null); return row ? identifyRow(row) : null; },
  parse(text, original) { return parseRows(jsonLines(text), original); },
};
