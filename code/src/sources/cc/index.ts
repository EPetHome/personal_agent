import { addIntent, commandSummary, contentText, emptyRecord, finishRecord, isHuman, iso, jsonLines, requiredString } from '../../core/utils.ts';
import type { SourceComponent } from '../../core/types.ts';
import type { JsonObject } from '../../core/utils.ts';

export const cc: SourceComponent = {
  tool: 'cc', extension: '.jsonl',
  parse(text, original) {
    const all = jsonLines(text);
    const rows = all.filter(r => r.isSidechain !== true);
    if (!rows.length) return null; // 子代理不另外冒充用户会话。
    const meta = rows.find(r => typeof r.sessionId === 'string' && typeof r.cwd === 'string');
    if (!meta) throw new Error('缺少 Claude Code 会话标识/工作目录');
    const record = emptyRecord('cc', requiredString(meta.sessionId, 'sessionId'), requiredString(meta.cwd, 'cwd'), iso(meta.timestamp), original);
    const pending = new Map<string, { id: string; at: string; text: string }>();
    let messages = 0;
    for (const row of rows) {
      if (row.sessionId && row.sessionId !== record.sessionId) throw new Error('同一文件出现不同会话');
      if (!row.timestamp) continue;
      const at = iso(row.timestamp);
      record.lastActivityAt = at > record.lastActivityAt ? at : record.lastActivityAt;
      if (row.type === 'session_end' || row.subtype === 'session_end') record.sessionEnded = true;
      if (!['user', 'assistant'].includes(row.type)) continue;
      if (!row.message || !['user', 'assistant'].includes(row.message.role)) throw new Error('无法识别 Claude Code 消息');
      messages++;
      const message = row.message;
      const blocks: JsonObject[] = Array.isArray(message.content) ? message.content : [];
      const textContent = contentText(message.content);
      if (row.type === 'user') {
        const human = row.origin?.kind === 'human' && isHuman(textContent, row, message);
        if (human) {
          addIntent(record, textContent);
          record.assistantFinished = false;
          record.sessionEnded = false;
        }
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            pending.delete(requiredString(b.tool_use_id, 'tool_use_id'));
            record.recentSteps.push({ at, text: b.is_error ? '工具返回错误' : '工具结果已返回' });
          }
        }
      } else {
        record.sessionEnded = false;
        for (const b of blocks) {
          if (b.type !== 'tool_use') continue;
          const id = requiredString(b.id, '工具调用 id');
          const step = { id, at, text: commandSummary(requiredString(b.name, '工具名'), b.input) };
          pending.set(id, step);
          record.recentSteps.push({ at, text: step.text });
        }
        if (textContent) record.recentSteps.push({ at, text: textContent.slice(0, 220) });
        record.assistantFinished = message.stop_reason === 'end_turn' && !blocks.some(b => b.type === 'tool_use');
      }
    }
    if (!messages) throw new Error('没有可识别的 Claude Code 消息');
    record.pendingTools = [...pending.values()];
    return finishRecord(record);
  },
};
