import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent, humanInTheLoopMiddleware } from 'langchain';
import { join } from 'node:path';
import type { Config, Input, QueueRow, Turn } from './types.js';
import { Store } from './store.js';
import { Files } from './files.js';
import { RouterModel } from './model.js';
import { turns, turn } from './context.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { deliver, type Channel } from './channel.js';
import { hash } from './util.js';
import { queryLoop } from './loop.js';

const stringField = { type: 'string' as const };
type Field = { type: 'string' | 'boolean' | 'integer'; minimum?: number; maximum?: number };
export class Router {
  readonly saver: SqliteSaver;
  readonly files: Files;
  readonly agent;
  private readonly replyFinal: (text: string) => Promise<unknown>;
  constructor(readonly config: Config, readonly store: Store, readonly channel: Channel) {
    this.saver = SqliteSaver.fromConnString(join(config.dataDir, 'checkpoints.sqlite'));
    this.saver.db.pragma('journal_mode = WAL'); this.saver.db.pragma('synchronous = FULL');
    this.files = new Files(config, store);
    const make = (name: string, description: string, fields: Record<string, Field>, required: string[], run: (args: Record<string, unknown>) => Promise<unknown> | unknown) => tool(async (args: Record<string, unknown>) => {
      let result: unknown;
      try {
        for (const field of [...required, 'reason', 'plan']) if (typeof args[field] !== 'string' || args[field].length > 64000) throw new Error('bad_arguments');
        result = await run(args);
      } catch { result = { ok: false, error: '工具调用失败或参数不合法；没有自动重试。' }; }
      const t = turn();
      const view = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      store.log('tool_result', { inputId: t.input.id, tool: name, arguments: args, result: name === 'read_file' || name === 'read_image' ? { ok: view.ok, error: view.error, path: view.path, sha256: view.sha256 } : result });
      return result;
    }, { name, description, schema: { type: 'object', properties: { ...fields, reason: stringField, plan: stringField }, required: [...required, 'reason', 'plan'], additionalProperties: false } });
    const record = (path: string, value: unknown) => { turn().materials.push({ path, sha256: hash(JSON.stringify(value)) }); return value; };
    const tools = [
      make('reply', '给用户本人发文字。reason 简述依据，plan 给方案或说明不需行动；不向别人发送。', { text: stringField }, ['text'], async args => {
        const t = turn();
        const key = `${t.input.id}:reply:${hash(String(args.text))}`;
        const result = await deliver(store, channel, t.input.id, key, String(args.text), t.signal);
        t.replied = result.status === 'sent' || t.replied;
        return result;
      }),
      make('get_task', '查一张任务卡，不创建卡。', { id: stringField }, ['id'], a => record(`task://${a.id}`, store.task(String(a.id)) ?? { error: '未找到任务卡' })),
      make('search_closed_tasks', '按原文搜索已关闭的卡，最多 50 张。', { query: stringField }, ['query'], a => record('tasks://closed-search', store.searchClosed(String(a.query)))),
      make('query_loop', '只读查询授权项目的 Loop 状态，不触发任何恢复。', {}, [], () => queryLoop(config, this.files, turn().materials)),
      make('read_file', '按白名单和黑名单读普通文件或已登记的 Loop 证据。offset/length 是字节，单次最多 64000。', { path: stringField, evidence: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 64000 } }, ['path'], a => this.files.read(String(a.path), turn().materials, a.evidence === true, Number.isFinite(a.offset) ? Number(a.offset) : 0, Number.isFinite(a.length) ? Number(a.length) : 64000)),
      make('read_image', '读取授权范围内图片以理解截图，返回视觉内容，不能绕过黑名单。', { path: stringField }, ['path'], async a => {
        const result = await this.files.read(String(a.path), turn().materials, false, 0, 1, true);
        if (!result.ok) return result;
        return [{ type: 'text', text: JSON.stringify({ path: result.path, sha256: result.sha256 }) }, { type: 'image_url', image_url: { url: `data:${result.mime};base64,${result.content}` } }];
      }),
      make('read_events', '专用事件日志工具：按编号增量读；不是通用文件读取。', { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, [], a => record('events://selected', store.events(Number.isSafeInteger(a.after) ? Number(a.after) : 0, Number.isSafeInteger(a.limit) ? Number(a.limit) : 20))),
    ];
    const replyTool: StructuredToolInterface = tools[0]!;
    this.replyFinal = text => replyTool.invoke({ text, reason: '模型直接返回给本人的文字', plan: '原文回复，不执行额外动作' });
    this.agent = createAgent({ model: new RouterModel(config, store), tools, checkpointer: this.saver,
      middleware: [humanInTheLoopMiddleware({ interruptOn: Object.fromEntries(tools.map(t => [t.name, false])) })] });
  }
  context(input: Input) {
    const window = this.store.window().map(m => m.role === 'user' ? new HumanMessage(m.text) : new AIMessage(m.text));
    const tasks = { type: '任务表', rows: this.store.taskTable(), matchedCards: this.store.match(input) };
    const incoming = { type: '新输入', ...input, raw: undefined };
    // Task data is not a higher-priority system instruction. Source text is always data.
    return [new SystemMessage(SYSTEM_PROMPT), ...window, new HumanMessage(JSON.stringify(tasks)), new HumanMessage(JSON.stringify(incoming))];
  }
  async process(row: QueueRow, signal: AbortSignal) {
    const stateConfig = { configurable: { thread_id: row.id } };
    const t: Turn = { input: row.input, signal, materials: [], replied: this.store.replies(row.id).some(r => !String(r.id).endsWith(':busy')), call: this.store.get(`calls:${row.id}`, 0) };
    await turns.run(t, async () => {
      try {
        // SAFETY: pinned LangChain delegates to LangGraph getState; integration tests
        // verify its snapshot shape, despite its deliberately internal `never` type.
        const snapshot = await (this.agent.getState(stateConfig) as unknown as Promise<{ values: { messages?: unknown[] }; next: string[] }>);
        const initialized = !!snapshot.values?.messages?.length;
        if (!initialized) {
          await this.agent.invoke({ messages: this.context(row.input) }, { ...stateConfig, signal, recursionLimit: this.config.maxToolRounds * 2 + 5, callbacks: [] });
        } else if (snapshot.next.length) {
          await this.agent.invoke(null, { ...stateConfig, signal, recursionLimit: this.config.maxToolRounds * 2 + 5, callbacks: [] });
        }
        // A plain final assistant message is also a model-authored reply. Route it
        // through the SAME durable reply tool, never infer intent from keywords.
        if (row.input.source === 'feishu' && !this.store.db.prepare("SELECT 1 FROM outbox WHERE input_id=? AND id<>? LIMIT 1").get(row.id, `${row.id}:busy`)) {
          // SAFETY: same pinned getState delegation; terminal graph messages contain content.
          const final = await (this.agent.getState(stateConfig) as unknown as Promise<{ values: { messages?: { content: unknown }[] } }>);
          const text = final.values.messages?.at(-1)?.content;
          if (typeof text === 'string' && text.trim()) {
            await this.replyFinal(text);
          }
        }
        this.store.log('input_result', { inputId: row.id, outcome: t.replied || this.store.replies(row.id).length ? '已回复' : '处理完成；未主动通知', materials: t.materials });
      } finally { this.store.set(`calls:${row.id}`, t.call); }
    });
  }
  remember(row: QueueRow) {
    const i = row.input;
    // No tool output, file contents, base64, raw callback or logs enter the window.
    const text = i.attachments.length || i.source !== 'feishu' ? `[${i.source} 材料] ${i.attachments.map(a => `${a.kind}: ${a.path ?? a.name}`).join('；') || i.id}` : i.text;
    this.store.addWindow(`${i.id}:user`, row.seq * 1000, 'user', text);
    let n = 1;
    for (const reply of this.store.replies(i.id)) if (!String(reply.id).endsWith(':busy')) this.store.addWindow(reply.id, row.seq * 1000 + n++, 'assistant', String(reply.text));
  }
  async prune() {
    // Keep a bounded number of complete input threads; retain pending/approval threads.
    const rows = this.store.db.prepare("SELECT id FROM inputs WHERE pruned=0 AND state IN ('done','failed') ORDER BY finished DESC LIMIT 100 OFFSET ?").all(this.config.checkpointKeep);
    for (const row of rows) { await this.saver.deleteThread(String(row.id)); this.store.db.prepare('UPDATE inputs SET pruned=1 WHERE id=?').run(String(row.id)); }
  }
  close() { this.saver.db.close(); }
}
