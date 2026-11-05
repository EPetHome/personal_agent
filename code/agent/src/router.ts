import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent, humanInTheLoopMiddleware } from 'langchain';
import { Command } from '@langchain/langgraph';
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
import { Workers, type PendingAction } from './worker.js';

interface GraphSnapshot {
  values: { messages?: { content: unknown }[] }; next: string[];
  tasks?: { interrupts?: { value: { actionRequests?: PendingAction[] } }[] }[];
}

const stringField = { type: 'string' as const };
type Field = { type: 'string' | 'boolean' | 'integer'; minimum?: number; maximum?: number };
export class Router {
  readonly saver: SqliteSaver;
  readonly files: Files;
  readonly agent;
  readonly workers: Workers;
  private readonly replyFinal: (text: string) => Promise<unknown>;
  constructor(readonly config: Config, readonly store: Store, readonly channel: Channel) {
    this.saver = SqliteSaver.fromConnString(join(config.dataDir, 'checkpoints.sqlite'));
    this.saver.db.pragma('journal_mode = WAL'); this.saver.db.pragma('synchronous = FULL');
    this.files = new Files(config, store);
    this.workers = new Workers(config, store, channel, this.files);
    const make = (name: string, description: string, fields: Record<string, Field>, required: string[], run: (args: Record<string, unknown>) => Promise<unknown> | unknown) => tool(async (args: Record<string, unknown>) => {
      let result: unknown;
      try {
        for (const field of [...required, 'reason', 'plan']) if (typeof args[field] !== 'string' || args[field].length > 64000) throw new Error('bad_arguments');
        result = await run(args);
      } catch { result = { ok: false, error: '工具调用失败或参数不合法；没有自动重试。' }; }
      const t = turn();
      const view = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      const task = view.card as { id?: string } | undefined;
      if (task?.id && store.task(task.id)) t.taskId = task.id;
      store.log('tool_result', { inputId: t.input.id, tool: name, arguments: args, result: name === 'read_file' || name === 'read_image' ? { ok: view.ok, error: view.error, path: view.path, sha256: view.sha256 } : result });
      return result;
    }, { name, description, schema: { type: 'object', properties: { ...fields, reason: stringField, plan: stringField }, required: [...required, 'reason', 'plan'], additionalProperties: false } });
    const record = (path: string, value: unknown) => { turn().materials.push({ path, sha256: hash(JSON.stringify(value)) }); return value; };
    const tools = [
      make('reply', '给用户本人发文字。reason 简述依据，plan 给方案或说明不需行动；不向别人发送。', { text: stringField, taskId: stringField }, ['text'], async args => {
        const t = turn();
        const key = `${t.input.id}:reply:${hash(String(args.text))}`;
        const result = await deliver(store, channel, t.input.id, key, String(args.text), t.signal);
        t.replied = result.status === 'sent' || t.replied;
        const taskId = typeof args.taskId === 'string' ? args.taskId : t.taskId;
        const card = taskId ? store.task(taskId) : undefined;
        if (result.status === 'sent' && typeof result.id === 'string' && card && !card.subscriptions.some(s => s.kind === 'message' && s.value === result.id)) {
          card.subscriptions.push({ kind: 'message', value: result.id }); store.putTask(card);
        }
        return result;
      }),
      make('get_task', '查一张任务卡，不创建卡。', { id: stringField }, ['id'], a => record(`task://${a.id}`, store.task(String(a.id)) ?? { error: '未找到任务卡' })),
      make('search_closed_tasks', '按原文搜索已关闭的卡，最多 50 张。', { query: stringField }, ['query'], a => record('tasks://closed-search', store.searchClosed(String(a.query)))),
      make('query_loop', '只读查询授权项目的 Loop 状态，不触发任何恢复。', {}, [], () => queryLoop(config, this.files, turn().materials, turn().signal)),
      make('read_file', '按白名单和黑名单读普通文件或已登记的 Loop 证据。offset/length 是字节，单次最多 64000。', { path: stringField, evidence: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 64000 } }, ['path'], a => this.files.read(String(a.path), turn().materials, a.evidence === true, Number.isFinite(a.offset) ? Number(a.offset) : 0, Number.isFinite(a.length) ? Number(a.length) : 64000)),
      make('read_image', '读取授权范围内图片以理解截图，返回视觉内容，不能绕过黑名单。', { path: stringField }, ['path'], async a => {
        const result = await this.files.read(String(a.path), turn().materials, false, 0, 1, true);
        if (!result.ok) return result;
        return [{ type: 'text', text: JSON.stringify({ path: result.path, sha256: result.sha256 }) }, { type: 'image_url', image_url: { url: `data:${result.mime};base64,${result.content}` } }];
      }),
      make('read_events', '专用事件日志工具：按编号增量读；不是通用文件读取。', { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, [], a => record('events://selected', store.events(Number.isSafeInteger(a.after) ? Number(a.after) : 0, Number.isSafeInteger(a.limit) ? Number(a.limit) : 20))),
      make('worker_dispatch', '开一件明确的任务，派给任务表列出的可用 worker。taskId 是本件稳定编号；Loop 的 project 必填配置项目 ID。options 是适配器专用 JSON 对象，不能覆盖 Loop scope/命令。程序按配置暂停求点头；不合入推送。', { taskId: stringField, worker: stringField, project: stringField, title: stringField, goal: stringField, completion: stringField, boundary: stringField, prompt: stringField, options: stringField, redLine: { type: 'boolean' } }, ['taskId', 'title', 'goal', 'completion', 'boundary', 'prompt'], a => this.workers.execute(turn().approvalThread ?? turn().input.id, 'worker_dispatch', a, turn().signal)),
      make('worker_reply', '答复原派工。Loop 的 mode=resume 用整批续跑；mode=send 须 stage 和 text。options 是适配器专用 JSON 对象。先暂停发带方案的原卡，点头后重核、只执行一次。红线须 redLine=true；授权/手工事项回电脑。', { taskId: stringField, mode: stringField, stage: stringField, text: stringField, assessment: stringField, options: stringField, redLine: { type: 'boolean' } }, ['taskId', 'mode', 'text'], a => this.workers.execute(turn().approvalThread ?? turn().input.id, 'worker_reply', a, turn().signal)),
      make('worker_stop', '停止原派工，保留成果；按配置先问，执行前核实。', { taskId: stringField, options: stringField, redLine: { type: 'boolean' } }, ['taskId'], a => this.workers.execute(turn().approvalThread ?? turn().input.id, 'worker_stop', a, turn().signal)),
      make('worker_status', '只读核验原 worker 的启动接收/调用退出事实；接收核销不释放开发空间，不重发、不发起新动作，不代表业务验收。', { id: stringField }, ['id'], async a => record(`worker://${a.id}/status`, await this.workers.status(String(a.id), turn().signal))),
      make('cancel_task', '本人取消指定这件活；尚未执行的所有点头作废。不会冒充已停止外部批次，停批次另用 worker_stop。', { id: stringField }, ['id'], a => this.workers.cancel(String(a.id), turn().input, turn().signal)),
      make('task_card', '更新同一张任务卡的说明，必须带原因、真假判断和建议。状态、核实事实、按钮可用性由程序决定。要给用户可点的续跑建议，使用 worker_reply。', { id: stringField, cause: stringField, assessment: stringField, suggestion: stringField, buttons: stringField }, ['id', 'cause', 'assessment', 'suggestion'], a => this.workers.show(String(a.id), a, turn().input, turn().signal)),
      make('update_task', '改同一任务的目标/完成标准/边界定义，不能改程序状态或订阅；原点头会因定义变化作废。', { id: stringField, goal: stringField, completion: stringField, boundary: stringField }, ['id', 'goal', 'completion', 'boundary'], a => {
        if (turn().input.source !== 'feishu' || turn().input.who !== config.feishu.userId) return { ok: false, reason: '只有本人来话能改任务定义' };
        const card = store.task(String(a.id)); if (!card || ['cancelled', 'closed', 'reconciled'].includes(card.status)) return { ok: false, reason: '任务不存在或已关闭' };
        card.goal = String(a.goal); card.completion = String(a.completion); card.boundary = String(a.boundary); card.updated = new Date().toISOString(); store.putTask(card); return { ok: true, card };
      }),
    ];
    const replyTool: StructuredToolInterface = tools[0]!;
    this.replyFinal = text => replyTool.invoke({ text, reason: '模型直接返回给本人的文字', plan: '原文回复，不执行额外动作' });
    this.agent = createAgent({ model: new RouterModel(config, store), tools, checkpointer: this.saver,
      middleware: [humanInTheLoopMiddleware({ interruptOn: {
        ...Object.fromEntries(tools.map(t => [t.name, false])),
        worker_dispatch: { allowedDecisions: ['approve', 'reject'], when: r => this.workers.needsApproval('worker_dispatch', r.toolCall.args) },
        worker_reply: { allowedDecisions: ['approve', 'reject'], when: r => this.workers.needsApproval('worker_reply', r.toolCall.args) },
        worker_stop: { allowedDecisions: ['approve', 'reject'], when: r => this.workers.needsApproval('worker_stop', r.toolCall.args) },
      } })] });
  }
  context(input: Input) {
    const window = this.store.window().map(m => m.role === 'user' ? new HumanMessage(m.text) : new AIMessage(m.text));
    const tasks = { type: '任务表', rows: this.store.taskTable(), matchedCards: this.store.match(input),
      workers: [...this.workers.adapters.keys()], projects: this.config.projects.map(p => ({ id: p.id, root: p.root, dispatchScope: p.loop ? { allow: p.loop.allow, deny: p.loop.deny } : null })) };
    const incoming = { type: '新输入', ...input, raw: undefined };
    // Task data is not a higher-priority system instruction. Source text is always data.
    return [new SystemMessage(SYSTEM_PROMPT), ...window, new HumanMessage(JSON.stringify(tasks)), new HumanMessage(JSON.stringify(incoming))];
  }
  async process(row: QueueRow, signal: AbortSignal): Promise<'done' | 'waiting'> {
    const callback = await this.workers.callback(row.input, signal);
    if (callback.handled) {
      if (callback.thread) {
        const origin = this.store.row(callback.thread);
        if (origin) {
          try {
            const state = await this.run(origin, signal);
            this.remember(origin);
            if (state === 'done') this.store.finish(origin.id);
          } catch (error) {
            if (!(signal.reason instanceof Error && signal.reason.message === 'shutdown')) this.store.finish(origin.id, 'failed');
            throw error;
          }
        }
      }
      return 'done';
    }
    // A queued approval group is a checkpoint continuation, not a replay of
    // its original worker signal (which may now be cancelled or out of date).
    if (this.workers.decisions(row.id)) return this.run(row, signal);
    if (!await this.workers.ingest(row.input, signal)) return 'done';
    return this.run(row, signal);
  }
  private snapshot(thread: string) {
    // SAFETY: pinned createAgent delegates getState to LangGraph; HITL/restart tests
    // check the snapshot's messages, tasks and persisted interrupts at runtime.
    return this.agent.getState({ configurable: { thread_id: thread } }) as unknown as Promise<GraphSnapshot>;
  }
  private async run(row: QueueRow, signal: AbortSignal): Promise<'done' | 'waiting'> {
    const stateConfig = { configurable: { thread_id: row.id } };
    const matched = this.store.match(row.input);
    const t: Turn = { input: row.input, signal, materials: [], replied: this.store.replies(row.id).some(r => !String(r.id).endsWith(':busy')), call: this.store.get(`calls:${row.id}`, 0), taskId: matched.length === 1 ? matched[0]!.id : undefined };
    return turns.run(t, async () => {
      try {
        const snapshot = await this.snapshot(row.id);
        const initialized = !!snapshot.values?.messages?.length;
        const decisions = this.workers.decisions(row.id);
        const paused = snapshot.tasks?.some(task => task.interrupts?.length);
        const options = { ...stateConfig, signal, recursionLimit: this.config.maxToolRounds * 2 + 5, callbacks: [] };
        if (!initialized) await this.agent.invoke({ messages: this.context(row.input) }, options);
        else if (paused && decisions) await this.agent.invoke(new Command({ resume: decisions }), options);
        else if (!paused && snapshot.next.length) await this.agent.invoke(null, options);
        for (let n = 0; ; n++) {
          const after = await this.snapshot(row.id);
          const requests = after.tasks?.flatMap(task => task.interrupts?.flatMap(i => i.value.actionRequests ?? []) ?? []) ?? [];
          if (!requests.length) break;
          if (n >= this.config.maxToolRounds) throw new Error('工具轮数已到上限');
          await this.workers.suspend(row.id, requests, signal);
          const consumed = this.workers.decisions(row.id);
          if (consumed) { this.store.start(row.id); await this.agent.invoke(new Command({ resume: consumed }), options); continue; }
          this.store.log('input_result', { inputId: row.id, outcome: '等本人点头；暂停已存检查点' });
          return 'waiting';
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
        return 'done';
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
