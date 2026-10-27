import { addIntent, addStep, commandSummary, compact, contentText, emptyRecord, filterRows, findJsonObject, findRow, finishRecord, isHuman, iso, jsonLines, requiredString } from '../../core/utils.ts';
import type { Original, SessionIdentity, SessionRecord, SourceComponent } from '../../core/types.ts';
import type { JsonObject } from '../../core/utils.ts';
import { replyExcerpt } from '../../core/notice-text.ts';

function identifyRow(row: JsonObject): SessionIdentity | null {
  return ['user', 'assistant'].includes(row.type) && row.isSidechain !== true
    && typeof row.sessionId === 'string' && row.sessionId.trim().length > 0 && typeof row.cwd === 'string' && row.cwd.trim().length > 0
    ? { sessionId: row.sessionId, project: row.cwd } : null;
}
function parseRows(all: Iterable<JsonObject>, original: Original): SessionRecord | null {
  const rows = filterRows(all, r => r.isSidechain !== true);
  const coreRows = filterRows(rows, r => (['user', 'assistant'].includes(r.type) && ['user', 'assistant'].includes(r.message?.role))
    || r.type === 'session_end' || r.subtype === 'session_end');
  if (!findRow(coreRows, r => ['user', 'assistant'].includes(r.type))) return null;
  const meta = findRow(coreRows, r => typeof r.sessionId === 'string' && r.sessionId.trim().length > 0 && typeof r.cwd === 'string' && r.cwd.trim().length > 0);
  if (!meta) return null; // 完整可解析但没有身份的产物不是会话。
  const record = emptyRecord('cc', requiredString(meta.sessionId, 'sessionId'), requiredString(meta.cwd, 'cwd'), iso(meta.timestamp), original);
  const pending = new Map<string, { id: string; at: string; text: string }>();
  let messages = 0;
  for (const row of coreRows) {
    if (row.sessionId && row.sessionId !== record.sessionId) throw new Error('同一文件出现不同会话');
    if (!row.timestamp) continue;
    const at = iso(row.timestamp);
    record.lastActivityAt = at > record.lastActivityAt ? at : record.lastActivityAt;
    if (row.type === 'session_end' || row.subtype === 'session_end') record.sessionEnded = true;
    if (!['user', 'assistant'].includes(row.type)) continue;
    messages++;
    const message = row.message;
    const blocks: JsonObject[] = Array.isArray(message.content) ? message.content.filter((b: unknown) => b && typeof b === 'object') : [];
    const textContent = contentText(message.content);
    if (row.type === 'user') {
      const human = isHuman(textContent, row, message) && (row.origin?.kind === 'human'
        || (row.origin === undefined && !textContent.trimStart().startsWith('<')));
      if (human) {
        addIntent(record, textContent);
        record.assistantFinished = false;
        record.sessionEnded = false;
      }
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          pending.delete(requiredString(b.tool_use_id, 'tool_use_id'));
          addStep(record, { at, text: b.is_error ? '工具返回错误' : '工具结果已返回' });
        }
      }
    } else {
      record.sessionEnded = false;
      for (const b of blocks) {
        if (b.type !== 'tool_use') continue;
        const id = requiredString(b.id, '工具调用 id');
        const step = { id, at, text: commandSummary(requiredString(b.name, '工具名'), b.input) };
        pending.set(id, step);
        addStep(record, { at, text: step.text });
      }
      if (textContent) {
        addStep(record, { at, text: compact(textContent) });
        record.assistantReply = { at, text: replyExcerpt(textContent) };
      }
      record.assistantFinished = message.stop_reason === 'end_turn' && !blocks.some(b => b.type === 'tool_use');
    }
  }
  if (!messages) return null;
  record.pendingTools = [...pending.values()];
  return finishRecord(record);
}
export const cc: SourceComponent = {
  tool: 'cc', extension: '.jsonl', identifyRow, parseRows,
  identify(text) { const row = findJsonObject(text, row => identifyRow(row) !== null); return row ? identifyRow(row) : null; },
  parse(text, original) { return parseRows(jsonLines(text), original); },
};
