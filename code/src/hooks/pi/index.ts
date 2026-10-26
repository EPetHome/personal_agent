import { emitPush } from '../protocol.ts';
import type { HookPayload } from '../protocol.ts';

// 只依赖宿主的通知接口，结构型契约避免引入第三方运行依赖。
interface Context {
  cwd: string;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
}
interface MessageEvent { message?: { role?: string; content?: unknown; stopReason?: string } }
export interface ListenerAPI {
  on(event: string, handler: (event: any, ctx: Context) => void): unknown;
  events: { on(name: string, handler: (data: unknown) => void): unknown };
}
/** 没有 tool_call、不返回控制信号，不读取 getBranch/getEntries 或任何会话文件。 */
export function registerMessageListener(pi: ListenerAPI, inboxDir: string): void {
  let current: Context | undefined;
  let lastReply = '';
  const notify = (name: string, ctx = current, data: HookPayload = {}) => {
    try {
      if (!ctx) return;
      emitPush('pi', { ...data, hook_event_name: name,
        session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
        transcript_path: ctx.sessionManager.getSessionFile(),
        ...(name === 'agent_settled' ? { last_assistant_message: lastReply } : {}),
      }, inboxDir);
    } catch { /* 通知失败不改变 Pi 的行为。 */ }
  };
  const reset = (_event: unknown, ctx: Context) => { current = ctx; lastReply = ''; };
  pi.on('session_start', reset);
  pi.on('session_switch', reset);
  pi.on('agent_start', (_event, ctx) => { current = ctx; lastReply = ''; });
  pi.on('message_end', (event: MessageEvent, ctx) => {
    try {
      current = ctx;
      const message = event.message;
      if (message?.role !== 'assistant') return;
      const blocks = Array.isArray(message.content) ? message.content : [];
      lastReply = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
      lastReply = [...lastReply].slice(0, 4000).join('');
    } catch { lastReply = ''; }
  });
  pi.on('agent_settled', (_event, ctx) => notify('agent_settled', ctx));
  pi.on('session_shutdown', (_event, ctx) => { notify('session_shutdown', ctx); current = undefined; lastReply = ''; });
  pi.events.on('permissions:ui_prompt', data => {
    try {
      const payload = data && typeof data === 'object' ? data as HookPayload & { title?: string; description?: string } : {};
      notify('permissions:ui_prompt', current, { detail: payload.detail ?? payload.message ?? payload.description ?? payload.title ?? '等待你授权' });
    } catch { /* 事件总线处理器绝不向权限扩展抛出异常。 */ }
  });
}
