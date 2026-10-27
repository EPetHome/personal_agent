import { addIntent, addStep, commandSummary, compact, contentText, emptyRecord, findJsonObject, findRow, finishRecord, intentText, isHuman, iso, jsonLines, observeCwd, requiredString, withoutInjectedContext } from '../../core/utils.ts';
import type { JsonObject } from '../../core/utils.ts';
import { replyExcerpt } from '../../core/notice-text.ts';
import type { Original, SessionIdentity, SessionRecord, SourceComponent } from '../../core/types.ts';

const events = ['user_message', 'task_started', 'agent_message', 'task_complete', 'session_end', 'turn_aborted'];
const calls = ['function_call', 'custom_tool_call', 'local_shell_call'];
const outputs = ['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'];
const items = ['UserMessage', 'AgentMessage', 'CommandExecution', 'FileChange', 'McpToolCall'];
function completedItem(row: JsonObject): JsonObject | undefined {
  if (row.type === 'event_msg' && row.payload?.type === 'item_completed') return row.payload.item;
  if (row.type === 'item_completed') return row.item ?? row.payload?.item ?? row.payload;
}
function humanMessage(item: JsonObject, row: JsonObject): string | null {
  const text = contentText(item.content ?? item.message);
  return !intentText(text).trimStart().startsWith('<') && isHuman(text, row, item) ? text : null;
}

function identifyRow(row: JsonObject): SessionIdentity | null {
  const meta = row.type === 'session_meta' ? row.payload : undefined;
  if (!meta || typeof (meta.id ?? meta.session_id) !== 'string' || !(meta.id ?? meta.session_id).trim()
    || typeof meta.cwd !== 'string' || !meta.cwd.trim()) return null;
  const parent = meta.parent_session_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id;
  return { sessionId: meta.id ?? meta.session_id, project: meta.cwd,
    ...(typeof parent === 'string' && parent.trim() ? { parentSessionId: parent } : {}) };
}
function parseRows(rows: Iterable<JsonObject>, original: Original): SessionRecord | null {
    const header = findRow(rows, r => r.type === 'session_meta');
    const meta = header?.payload;
    if (!header || !identifyRow(header)) return null;
    const record = emptyRecord('codex', requiredString(meta.id ?? meta.session_id, '会话 id'), requiredString(meta.cwd, 'cwd'), iso(meta.timestamp ?? header.timestamp), original);
    const parent = meta.parent_session_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id;
    if (typeof parent === 'string' && parent) record.parentSessionId = parent;
    const pending = new Map<string, { id: string; at: string; text: string }>();
    // 两代同时出现时，新版真人文字优先；无文字的真实图片只重开状态，不能遮蔽旧文字意图。
    // response_item user 是重复副本，始终忽略；带媒体文本占位的既有输入仍按原代际选择。
    const hasNewUsers = findRow(rows, row => {
      const item = completedItem(row);
      const text = item?.type === 'UserMessage' ? humanMessage(item, row) : null;
      return text !== null && !!withoutInjectedContext(text).trim();
    }) !== undefined;
    let recognized = 0;
    let lastAgent: { text: string; phase?: string } | undefined;
    let turnCompleted = false;
    function agentMessage(message: string, phase: string | undefined, at: string) {
      if (message && lastAgent?.text !== message) addStep(record, { at, text: compact(message) });
      const actualPhase = phase ?? (lastAgent?.text === message ? lastAgent.phase : undefined);
      record.assistantFinished = actualPhase !== 'commentary';
      if (message) record.assistantReply = { at, text: replyExcerpt(message) };
      lastAgent = { text: message, phase: actualPhase };
    }
    for (const row of rows) {
      observeCwd(record, row.cwd);
      if (row.type === 'session_meta' || row.type === 'turn_context') observeCwd(record, row.payload?.cwd);
      const item = completedItem(row);
      const p = row.payload;
      const isItem = item && items.includes(item.type);
      const isEvent = row.type === 'event_msg' && p && events.includes(p.type);
      const isResponse = ['response_item', 'item_completed'].includes(row.type) && p
        && (calls.includes(p.type) || outputs.includes(p.type) || (p.type === 'message' && p.role === 'assistant'));
      if (!isItem && !isEvent && !isResponse) continue; // 噪音的 payload、时间等字段也不校验。
      const at = iso(row.timestamp);
      record.lastActivityAt = at > record.lastActivityAt ? at : record.lastActivityAt;
      recognized++;
      if (isItem) {
        if (item.type === 'UserMessage') {
          const userText = humanMessage(item, row);
          if (userText !== null) {
            addIntent(record, userText);
            turnCompleted = false;
            record.assistantFinished = false;
            record.sessionEnded = false;
          }
        } else if (item.type === 'AgentMessage') {
          agentMessage(contentText(item.content ?? item.text), item.phase, at);
        } else {
          const name = item.type === 'CommandExecution' ? 'command'
            : item.type === 'FileChange' ? '文件改动' : `MCP ${item.server ?? ''}/${item.tool ?? ''}`;
          const args = item.type === 'CommandExecution' ? { command: item.command }
            : item.type === 'FileChange' ? { path: Object.keys(item.changes ?? {}).slice(0, 3).join('、') } : item.arguments;
          const step = { at, text: commandSummary(name, args) };
          addStep(record, step);
          // 本轮 task_complete 后落盘的后台完成项不重新打开这一轮。
          if (!turnCompleted || ['in_progress', 'running', 'started'].includes(item.status)) {
            record.assistantFinished = false;
            record.sessionEnded = false;
          }
          // item_completed 是结束事实；显式 in_progress/running 才保留为待返回。
          if (['in_progress', 'running', 'started'].includes(item.status)) {
            const id = requiredString(item.call_id ?? item.id, '工具项 id');
            pending.set(id, { ...step, id });
          } else if (typeof (item.call_id ?? item.id) === 'string') pending.delete(item.call_id ?? item.id);
        }
      } else if (isEvent) {
        if (p.type === 'user_message') {
          if (!hasNewUsers) {
            const userText = humanMessage(p, row);
            if (userText !== null) {
              addIntent(record, userText);
              turnCompleted = false;
              record.assistantFinished = false;
              record.sessionEnded = false;
            }
          }
        } else if (p.type === 'task_started') {
          turnCompleted = false;
          record.assistantFinished = false;
          record.sessionEnded = false;
        } else if (p.type === 'agent_message') agentMessage(contentText(p.message), p.phase, at);
        else if (p.type === 'task_complete') {
          record.assistantFinished = true;
          turnCompleted = true;
          pending.clear();
          if (typeof p.last_agent_message === 'string') {
            addStep(record, { at, text: compact(p.last_agent_message) });
            record.assistantReply = { at, text: replyExcerpt(p.last_agent_message) };
          }
        } else if (p.type === 'session_end') record.sessionEnded = true;
        else if (p.type === 'turn_aborted') {
          record.assistantFinished = false;
          record.sessionEnded = true;
        }
      } else if (calls.includes(p.type)) {
        const id = requiredString(p.call_id ?? p.id, 'call_id');
        const step = { id, at, text: commandSummary(p.name ?? 'shell', p.arguments ?? p.input ?? p.action) };
        turnCompleted = false;
        pending.set(id, step); // 调用项 status:completed 不等于对应 output 已返回。
        record.assistantFinished = false;
        record.sessionEnded = false;
        addStep(record, { at, text: step.text });
      } else if (outputs.includes(p.type)) {
        pending.delete(requiredString(p.call_id ?? p.id, 'call_id'));
        addStep(record, { at, text: '工具结果已返回' });
      } else agentMessage(contentText(p.content), p.phase, at);
    }
    if (!recognized) return null;
    record.pendingTools = [...pending.values()];
    return finishRecord(record);
}
export const codex: SourceComponent = {
  tool: 'codex', extension: '.jsonl', identifyRow, parseRows,
  sessionIdOf(row) {
    const id = row.type === 'session_meta' ? row.payload?.id ?? row.payload?.session_id : undefined;
    return typeof id === 'string' && id.trim() ? id : null;
  },
  identify(text) { const row = findJsonObject(text, row => identifyRow(row) !== null); return row ? identifyRow(row) : null; },
  parse(text, original) { return parseRows(jsonLines(text), original); },
};
