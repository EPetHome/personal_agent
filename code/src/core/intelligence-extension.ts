import { appendFile, readFile } from 'node:fs/promises';
import { ReadSandbox, ToolLimit } from './read-sandbox.ts';
import type { ReadScope } from './intelligence-types.ts';

// 结构化的最小 Pi API：本项目不安装另一份宿主依赖；由 Pi 的显式 -e 加载本文件。
interface PiAPI {
  registerFlag(name: string, options: { type: 'string'; description: string }): void;
  getFlag(name: string): string | boolean | undefined;
  registerTool(tool: { name: string; label: string; description: string; parameters: object;
    execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined, update: unknown, ctx: { abort(): void }): Promise<unknown> }): void;
  on(event: 'tool_call' | 'session_start', handler: (event: { toolName?: string; input?: Record<string, unknown> }, ctx: { abort(): void }) => Promise<unknown>): void;
}
export default async function (pi: PiAPI) {
  pi.registerFlag('pa-analysis-policy', { type: 'string', description: 'personal agent 单次只读范围（程序生成）' });
  let box: ReadSandbox | undefined;
  // Pi先运行工厂收集flag定义，随后才解析其值；不得在工厂里getFlag后抛错。
  pi.on('session_start', async () => {
    const policy = pi.getFlag('pa-analysis-policy');
    if (typeof policy !== 'string') throw new Error('缺少单次只读策略，拒绝初始化分析工具');
    const settings = JSON.parse(await readFile(policy, 'utf8')) as { scope: ReadScope; auditPath: string };
    if (!settings.scope?.transcript || !settings.auditPath) throw new Error('只读策略无效');
    box = await ReadSandbox.create(settings.scope, async row => {
      // 仅可信扩展写审计，模型没有write；落盘失败则读取也失败。
      await appendFile(settings.auditPath, JSON.stringify(row) + '\n', { mode: 0o600 });
    });
  });
  const properties = { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 },
    pattern: { type: 'string' }, ignoreCase: { type: 'boolean' } };
  for (const name of ['read', 'grep', 'find', 'ls']) pi.registerTool({
    name, label: name, description: name === 'read' ? '只读当前会话或项目文本。用offset/limit分页；长行用column列位置续读（UTF-16，1起）。eof=false时按返回的next继续。'
      : name === 'grep' ? '在允许文件中搜索字面量 pattern（不是正则），递归过滤敏感目录。'
        : name === 'find' ? '仅在允许目录中按简单glob pattern找文件；不跟随链接。' : '只列允许目录；不跟随链接。',
    parameters: { type: 'object', properties, additionalProperties: false, ...(name === 'read' ? { required: ['path'] } : {}) },
    async execute(_id, args, signal, _update, ctx) {
      try {
        if (!box) { ctx.abort(); throw new Error('只读策略未初始化'); }
        return { content: [{ type: 'text', text: await box.execute(name, args, signal) }], details: undefined };
      }
      catch (error) {
        if (error instanceof ToolLimit) ctx.abort();
        throw new Error(error instanceof ToolLimit ? '只读工具次数用完，分析中止' : '只读工具失败（未输出内容或原始异常）');
      }
    },
  });
  pi.on('tool_call', async (event, ctx) => {
    if (['read', 'grep', 'find', 'ls'].includes(event.toolName ?? '')) return;
    ctx.abort();
    return { block: true, reason: '分析只允许 read,grep,find,ls' };
  });
}
