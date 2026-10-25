import { addIntent, commandSummary, contentText, emptyRecord, finishRecord, isHuman, iso, jsonLines, requiredString } from '../../core/utils.ts';
import type { JsonObject } from '../../core/utils.ts';
import type { SourceComponent } from '../../core/types.ts';

export const pi: SourceComponent = {
  tool: 'pi', extension: '.jsonl',
  parse(text, original) {
    const rows = jsonLines(text);
    const header = rows[0];
    if (header?.type !== 'session' || ![2, 3].includes(header.version)) throw new Error('不支持的 Pi 会话格式（需要 v2/v3 树形记录）');
    const record = emptyRecord('pi', requiredString(header.id, '会话 id'), requiredString(header.cwd, 'cwd'), iso(header.timestamp), original);
    const entries = new Map<string, JsonObject>();
    let leaf: JsonObject | undefined;
    for (const row of rows.slice(1)) {
      const id = requiredString(row.id, '树节点 id');
      if (entries.has(id)) throw new Error('Pi 树节点 id 重复');
      if (row.parentId !== null && typeof row.parentId !== 'string') throw new Error('Pi 树节点缺少 parentId');
      entries.set(id, row);
      leaf = row;
    }
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
      const at = iso(row.timestamp);
      record.lastActivityAt = at > record.lastActivityAt ? at : record.lastActivityAt;
      if (row.type !== 'message') continue; // custom_message / compaction / branch_summary 不是用户要求。
      const message = row.message;
      if (!message || typeof message.role !== 'string') throw new Error('无法识别 Pi message');
      const textContent = contentText(message.content);
      if (message.role === 'user') {
        if (isHuman(textContent, row, message)) addIntent(record, textContent);
        record.assistantFinished = false;
        record.sessionEnded = false;
      } else if (message.role === 'assistant') {
        const blocks: JsonObject[] = Array.isArray(message.content) ? message.content : [];
        record.sessionEnded = false;
        for (const b of blocks) {
          if (b.type !== 'toolCall') continue;
          const id = requiredString(b.id, 'toolCall id');
          const step = { id, at, text: commandSummary(requiredString(b.name, '工具名'), b.arguments) };
          pending.set(id, step);
          record.recentSteps.push({ at, text: step.text });
        }
        if (textContent) record.recentSteps.push({ at, text: textContent.slice(0, 220) });
        record.assistantFinished = message.stopReason === 'stop' && !blocks.some(b => b.type === 'toolCall');
      } else if (message.role === 'toolResult') {
        pending.delete(requiredString(message.toolCallId, 'toolCallId'));
        record.recentSteps.push({ at, text: message.isError ? '工具返回错误' : '工具结果已返回' });
      }
    }
    record.pendingTools = [...pending.values()];
    return finishRecord(record);
  },
};
