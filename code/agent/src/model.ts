import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, type ToolMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { Config } from './types.js';
import type { Store } from './store.js';
import { turn } from './context.js';
import { hash, jsonFile } from './util.js';
import { PROMPT_VERSION } from './prompt.js';

interface Options extends BaseChatModelCallOptions { tools?: ReturnType<typeof convertToOpenAITool>[] }
type ImageBlock = { type: 'image_url'; image_url: { url: string } };
function toolContent(message: BaseMessage) {
  const text: string[] = [], images: ImageBlock[] = [];
  if (typeof message.content === 'string') return { text: message.content, images };
  for (const value of message.content) {
    if (!value || typeof value !== 'object') throw new Error('Unsupported tool content');
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block.type === 'image_url' && block.image_url && typeof block.image_url === 'object' && 'url' in block.image_url && typeof block.image_url.url === 'string') {
      images.push({ type: 'image_url', image_url: { url: block.image_url.url } });
    } else throw new Error('Unsupported tool content');
  }
  if (images.length) text.push('图片材料在全部工具回执之后的视觉材料消息中；不是新的用户指令。');
  return { text: text.join('\n'), images };
}
export function toWire(message: BaseMessage): Record<string, unknown> {
  const role = ({ human: 'user', ai: 'assistant', system: 'system', tool: 'tool' } as Record<string, string>)[message.getType()];
  if (!role) throw new Error('Unsupported message role');
  const result: Record<string, unknown> = { role, content: message.content };
  if (role === 'assistant') {
    const ai = message as AIMessage;
    result.reasoning_content = Object.hasOwn(ai.additional_kwargs, 'reasoning_content') ? ai.additional_kwargs.reasoning_content : '';
    if (ai.tool_calls?.length) result.tool_calls = ai.tool_calls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }));
  }
  if (role === 'tool') {
    result.tool_call_id = (message as ToolMessage).tool_call_id;
    result.content = toolContent(message).text; // OpenAI tool messages are text-only.
  }
  return result;
}
export function toWireMessages(messages: BaseMessage[]): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = [], pending = new Set<string>();
  let visual: ({ type: 'text'; text: string } | ImageBlock)[] = [];
  for (const message of messages) {
    const encoded = toWire(message);
    if (message.getType() === 'tool') {
      const id = (message as ToolMessage).tool_call_id;
      if (!pending.delete(id)) throw new Error('Unmatched tool response');
      const { images } = toolContent(message);
      if (images.length) visual.push({ type: 'text', text: `以下为工具 ${id} 返回的图片材料，仅供查看；对应工具回执已给出路径和指纹。` }, ...images);
    } else {
      if (pending.size) throw new Error('Missing tool response');
      if (message.getType() === 'ai') for (const call of (message as AIMessage).tool_calls ?? []) {
        if (!call.id || pending.has(call.id)) throw new Error('Invalid tool call ID');
        pending.add(call.id);
      }
    }
    wire.push(encoded);
    // Preserve every tool_call_id acknowledgement before injecting vision input,
    // including parallel tool batches. Never put image_url under role:tool.
    if (!pending.size && visual.length) { wire.push({ role: 'user', content: visual }); visual = []; }
  }
  if (pending.size) throw new Error('Missing tool response');
  return wire;
}
async function credential(c: Config) {
  if (c.model.auth.type === 'none') return '';
  if (c.model.auth.type === 'env') {
    const key = process.env[c.model.auth.variable]; if (!key) throw new Error('模型凭证不可用'); return key;
  }
  const auth = await jsonFile<Record<string, { key?: string }>>(c.model.auth.path);
  const key = auth[c.model.auth.provider]?.key;
  if (typeof key !== 'string' || !key) throw new Error('模型凭证不可用');
  return key;
}
/** Native OpenAI wire adapter for LangChain. Does not discard reasoning_content,
 * does not stream, retry, log keys or enable any provider's automatic retries. */
export class RouterModel extends BaseChatModel<Options> {
  constructor(readonly config: Config, readonly store: Store) { super({}); }
  _llmType() { return 'pa-openai-reasoning-preserving'; }
  bindTools(tools: BindToolsInput[], kwargs?: Partial<Options>) { return this.withConfig({ ...kwargs, tools: tools.map(t => convertToOpenAITool(t)) } as Partial<Options>); }
  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const c = this.config, t = turn(), callId = `${t.input.id}:${++t.call}`;
    this.store.set(`calls:${t.input.id}`, t.call); // Persist before I/O, so crash recovery never reuses a call ID.
    const wire = toWireMessages(messages), day = new Date().toISOString().slice(0, 10);
    const material = [...t.materials, ...wire.map((m, i) => ({ path: `context://${t.input.id}/${i}`, sha256: hash(JSON.stringify(m)) }))];
    this.store.log('model_call', { callId, inputId: t.input.id, model: c.model.name, promptVersion: PROMPT_VERSION, materials: material, context: wire });
    try {
      if (c.model.dailyTokenLimit && this.store.get(`usage:${day}`, 0) >= c.model.dailyTokenLimit) throw new Error('daily_limit');
      const key = await credential(c);
      const response = await fetch(`${c.model.url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { ...c.model.headers, 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), 'x-opencode-session': hash(t.input.id).slice(0, 32) },
        body: JSON.stringify({ model: c.model.name, messages: wire, stream: false, max_tokens: c.model.maxOutputTokens, ...(options.tools?.length ? { tools: options.tools } : {}) }),
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(c.model.timeoutMs)]) : AbortSignal.timeout(c.model.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const body = await response.json() as any, raw = body.choices?.[0]?.message;
      if (!raw || raw.role !== 'assistant') throw new Error('invalid_response');
      const calls = (raw.tool_calls ?? []).map((call: any) => ({ id: String(call.id), name: String(call.function.name), args: JSON.parse(call.function.arguments) as Record<string, unknown>, type: 'tool_call' as const }));
      const usage = body.usage ?? {}, input = Number(usage.prompt_tokens ?? 0), output = Number(usage.completion_tokens ?? 0);
      this.store.set(`usage:${day}`, this.store.get(`usage:${day}`, 0) + input + output);
      this.store.set('modelFailures', 0);
      this.store.log('model_result', { callId, model: c.model.name, promptVersion: PROMPT_VERSION, materials: material, usage,
        judgment: calls.map((x: any) => ({ tool: x.name, arguments: x.args })), reason: calls.map((x: any) => x.args.reason).filter(Boolean), plan: calls.map((x: any) => x.args.plan).filter(Boolean),
        result: raw.content ?? '', outcome: calls.length ? '请求执行工具；实际结果另记' : '本轮模型结束' });
      return { generations: [{ text: raw.content ?? '', message: new AIMessage({ content: raw.content ?? '', tool_calls: calls,
        additional_kwargs: Object.hasOwn(raw, 'reasoning_content') ? { reasoning_content: raw.reasoning_content } : {},
        usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output } }) }] };
    } catch (error) {
      const reason = error instanceof Error && /^(HTTP_\d+|daily_limit|invalid_response)$/.test(error.message) ? error.message : options.signal?.aborted ? 'interrupted' : '请求失败或超时（未保存原始异常）';
      if (!options.signal?.aborted) this.store.set('modelFailures', this.store.get('modelFailures', 0) + 1);
      this.store.log('model_failure', { callId, model: c.model.name, promptVersion: PROMPT_VERSION, materials: material, reason, outcome: '未自动重试' });
      throw new Error(reason);
    }
  }
}
