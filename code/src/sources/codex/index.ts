import { addIntent, commandSummary, contentText, emptyRecord, finishRecord, isHuman, iso, jsonLines, requiredString } from '../../core/utils.ts';
import type { SourceComponent } from '../../core/types.ts';

export const codex: SourceComponent = {
  tool: 'codex', extension: '.jsonl',
  parse(text, original) {
    const rows = jsonLines(text);
    const meta = rows.find(r => r.type === 'session_meta')?.payload;
    if (!meta) throw new Error('缺少 Codex session_meta（可能格式已变化）');
    const record = emptyRecord('codex', requiredString(meta.id ?? meta.session_id, '会话 id'), requiredString(meta.cwd, 'cwd'), iso(meta.timestamp ?? rows[0]?.timestamp), original);
    record.parentSessionId = meta.parent_session_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id;
    const pending = new Map<string, { id: string; at: string; text: string }>();
    let recognized = 0;
    let lastAgent: { text: string; phase?: string } | undefined;
    for (const row of rows) {
      const at = iso(row.timestamp);
      record.lastActivityAt = at > record.lastActivityAt ? at : record.lastActivityAt;
      const p = row.payload;
      if (row.type === 'session_meta' || row.type === 'turn_context') continue;
      if (!p || typeof p.type !== 'string') throw new Error('无法识别 Codex 事件结构');
      if (row.type === 'event_msg') {
        recognized++;
        if (p.type === 'user_message') {
          const userText = contentText(p.message);
          if (isHuman(userText, row, p)) addIntent(record, userText);
          record.assistantFinished = false;
          record.sessionEnded = false;
        } else if (p.type === 'task_started') {
          record.assistantFinished = false;
          record.sessionEnded = false;
        } else if (p.type === 'agent_message') {
          const message = contentText(p.message);
          lastAgent = { text: message, phase: p.phase };
          record.assistantFinished = p.phase !== 'commentary';
          if (message) record.recentSteps.push({ at, text: message.slice(0, 220) });
        } else if (p.type === 'task_complete') {
          record.assistantFinished = true;
          pending.clear();
          if (typeof p.last_agent_message === 'string') record.recentSteps.push({ at, text: p.last_agent_message.slice(0, 220) });
        } else if (p.type === 'session_end') record.sessionEnded = true;
        else if (p.type === 'turn_aborted') {
          record.assistantFinished = false;
          record.sessionEnded = true;
        }
      } else if (row.type === 'response_item' || row.type === 'item_completed') {
        recognized++;
        // user 的 response_item 是 event_msg 的重复副本，不作为第二条意图。
        if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
          const id = requiredString(p.call_id ?? p.id, 'call_id');
          const step = { id, at, text: commandSummary(p.name ?? 'shell', p.arguments ?? p.input ?? p.action) };
          pending.set(id, step); // status:completed 只代表调用已生成，必须等 output。
          record.assistantFinished = false;
          record.recentSteps.push({ at, text: step.text });
        } else if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(p.type)) {
          pending.delete(requiredString(p.call_id ?? p.id, 'call_id'));
          record.recentSteps.push({ at, text: '工具结果已返回' });
        } else if (p.type === 'message' && p.role === 'assistant') {
          const message = contentText(p.content);
          if (message && lastAgent?.text !== message) record.recentSteps.push({ at, text: message.slice(0, 220) });
          const phase = p.phase ?? (lastAgent?.text === message ? lastAgent.phase : undefined);
          record.assistantFinished = phase !== 'commentary';
        }
      } else if (!['compacted'].includes(row.type)) throw new Error(`无法识别 Codex 记录类型：${row.type}`);
    }
    if (!recognized) throw new Error('没有可识别的 Codex 消息');
    record.pendingTools = [...pending.values()];
    return finishRecord(record);
  },
};
