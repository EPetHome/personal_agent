import type { Config, Input } from './types.js';
import type { WorkerRequest } from './worker.js';
import { hash } from './util.js';

/** Issued only by the authenticated original-card callback, never model arguments. */
export interface CardStopConfirmation { dispatch: string; token: string; messageId: string; targetHash: string; inputId: string }
export interface InstructionConfirmation {
  kind: 'owner-instruction'; inputId: string; messageId: string; who: string; quote: string; sourceHash: string;
  taskId: string; requestHash: string; scopeFingerprint: string;
  clarifiedBy?: { inputId: string; messageId: string; sourceHash: string; quote: string };
}
export function redLineText(text: string) {
  const ordinary = text.replace(/(?:不|不要|禁止|不得)(?:合入|推送|删除|覆盖|联网|运行命令|改权限)/g, '').replace(/(?:do not|never|without)\s+(?:push|merge|delete|overwrite)/gi, '');
  return /删除|覆盖|强推|改历史|合入|推送|发布|改权限|开放.*(?:命令|联网)|(?:^|\s)(?:delete|overwrite|push|merge|publish)\b/i.test(ordinary);
}
export const requestHash = (r: WorkerRequest) => hash(JSON.stringify({ taskId: r.taskId, worker: r.worker, action: r.action,
  project: r.project, goal: r.goal, completion: r.completion, boundary: r.boundary, prompt: r.prompt, options: r.options, redLine: r.redLine }));
/** Model interprets meaning; program verifies the actual authenticated source and freezes task + scope. */
export function ownerInstruction(c: Config, input: Input | undefined, args: Record<string, unknown>) {
  if (!input || input.source !== 'feishu' || input.who !== c.feishu.userId || input.chatType !== 'p2p' || input.button || !input.messageId
    || args.instructionInput !== input.id || typeof args.instruction !== 'string') return;
  const quote = args.instruction.trim(), body = input.text.trim();
  // Require the actual current author body, not an excerpt selected out of quoted/material text.
  // Ambiguous language falls back to the existing confirmation flow, never an expanded grant.
  if (!quote || quote !== body || body.length > 64000 || redLineText(body) || /[?？]|```|^\s*>/m.test(body)
    || /(?:材料|引用|附件内容|worker输出|示例|例如)\s*[:：]/i.test(body)
    || /(?:不要|不必|暂缓|回电脑再说|先别|先不|以后|能否|是否|请问|如果)/.test(body)
    || !/^(?:请(?!问)|麻烦|帮我|替我|给我|把|将|派|用|读取|查看|检查|查询|整理|生成|新建|创建|修改|修复|实现|开发|保存|please\s+(?:read|check|create|fix|implement)|(?:read|check|create|fix|implement)\b)/i.test(body)) return;
  return { inputId: input.id, messageId: input.messageId, who: input.who, quote, sourceHash: hash(body) };
}
