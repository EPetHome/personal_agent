import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScopedFiles, type FilePolicy } from './file-policy.js';
import { hash, parseJson, parseUrl } from './util.js';
import { failure, SafeError } from './errors.js';
import { produceOutput, type OutputResult } from './outputs.js';
import { atomicJson } from './util.js';

export interface PiPolicy extends FilePolicy { operation: string; token: string; commands: boolean; network: boolean; maxTurns: number }
interface PiContext { shutdown(): void }
interface PiEvent { toolName?: string; input?: Record<string, unknown>; payload?: unknown; message?: { role?: string; content?: { type: string; text?: string }[]; stopReason?: string; usage?: { totalTokens?: number } }; aborted?: boolean }
interface Tool { name: string; label: string; description: string; parameters: object; execute(id: string, args: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; details: unknown }> }
/** Only the documented Pi surface needed here; no runtime/package dependency on the host. */
interface PiAPI { on(name: string, handler: (event: PiEvent, ctx: PiContext) => unknown): void; registerTool(tool: Tool): void; setActiveTools(names: string[]): void; getActiveTools(): string[] }
const string = { type: 'string' }, number = { type: 'integer', minimum: 0 };

export default function permissions(pi: PiAPI) {
  const dir = process.env.PA_PI_JOB_DIR;
  if (!dir) throw new Error('缺少 PA 派工身份；不加载任何工具');
  const p = parseJson<PiPolicy>(readFileSync(join(dir, 'policy.json'), 'utf8'));
  if (!p.operation || !p.token || !Array.isArray(p.roots) || !Array.isArray(p.write)) throw new Error('派工权限不完整');
  const log = (event: Record<string, unknown>) => appendFileSync(join(dir, 'permissions.jsonl'), JSON.stringify({ at: Date.now(), operation: p.operation, ...event }) + '\n', { mode: 0o600 });
  const files = new ScopedFiles(p, (path, action) => log({ kind: 'denied', path, action }));
  const names: string[] = [];
  const tool = (name: string, description: string, properties: Record<string, object>, required: string[], run: (args: Record<string, unknown>) => Promise<unknown>) => {
    names.push(name);
    pi.registerTool({ name, label: name, description, parameters: { type: 'object', properties, required, additionalProperties: true },
      async execute(_id, args) {
        try { const result = await run(args); return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: undefined }; }
        catch (error) { const result = failure(error); log({ kind: 'tool_failed', tool: name, ...result }); throw new SafeError(result.category, `${result.category}: ${result.error}`); }
      } });
  };
  const path = (a: Record<string, unknown>) => { if (typeof a.path !== 'string' || !a.path || a.path.includes('\0')) throw new Error('path 无效'); return a.path; };
  tool('pa_read', '按真实路径白名单和黑名单读取纯文本/DOCX/PDF文本层；offset/limit 是提取后 UTF-8 字节。不支持的二进制明确拒绝，不写产物。', { path: string, offset: number, limit: number }, ['path'], async a => {
    const result = await files.read(path(a), Number(a.offset) || 0, Number(a.limit) || 64000);
    log({ kind: 'read', path: result.path, sha256: result.sha256 }); return result;
  });
  tool('pa_ls', '列目录，仅返回允许读的项，不跟随链接。', { path: string }, ['path'], a => files.list(path(a)));
  tool('pa_grep', '文字字面搜索，遍历及每个文件均检查权限；有数量和大小上限。', { path: string, pattern: string }, ['path', 'pattern'], a => files.search(path(a), String(a.pattern), true));
  tool('pa_find', '按路径字面片段找文件，每个文件均检查权限。', { path: string, pattern: string }, ['path', 'pattern'], a => files.search(path(a), String(a.pattern), false));
  if (p.write.length && !p.output) tool('pa_write', '只在本派工范围创建文件，不覆盖已有文件。', { path: string, content: string }, ['path', 'content'], a => files.write(path(a), String(a.content)));
  let mutations = Promise.resolve<unknown>(undefined);
  let outputRun: Promise<OutputResult> | undefined;
  if (p.output && p.write.length && !p.commands && !p.network) tool('pa_output', '只生成本次已绑定源与目标的产物：完整 DOCX 转 UTF-8 TXT 或按原字节保存图片；无任意路径/内容参数，不覆盖，回执含实际路径/摘要，other 含同名说明。', {}, [], () => outputRun ??= (async () => {
    const target = p.output!;
    await atomicJson(join(dir, 'output-result.json'), { ok: false, status: 'incomplete', files: [], expected: [target.target, ...(target.companion ? [target.companion] : [])], error: '产出工具开始，但尚未核实完整交付。' });
    const result = await produceOutput(files, target);
    await atomicJson(join(dir, 'output-result.json'), result); log({ kind: 'output', result }); return result;
  })());
  if (Object.keys(p.edit ?? {}).length && !p.output) tool('pa_edit', '只修改本次本人逐文件明确批准且版本匹配的文件，oldText 必须唯一。', { path: string, oldText: string, newText: string }, ['path', 'oldText', 'newText'], a => {
    const work = mutations.then(() => files.edit(path(a), String(a.oldText), String(a.newText)));
    mutations = work.catch(() => { log({ kind: 'mutation_failed', path: path(a) }); }); return work;
  });
  if (p.network) tool('pa_fetch', '本次经本人批准的 HTTP(S) 联网读取；最多 64KB、15 秒，不携带账号凭证。', { url: string }, ['url'], async a => {
    const url = parseUrl(String(a.url));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL 不允许');
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('联网读取失败');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 64000) throw new Error('联网内容超限'); chunks.push(part.value); } }
    finally { await reader.cancel(); }
    const data = Buffer.concat(chunks); log({ kind: 'network', sha256: hash(data) }); return { content: data.toString('utf8') };
  });
  if (p.commands) tool('pa_bash', '本次经本人明确批准的命令；命令内部不保证文件边界。未批联网时由系统沙箱禁网。', { command: string }, ['command'], async a => {
    const { execFile } = await import('node:child_process');
    const env = { PATH: process.env.PATH, HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), LC_ALL: 'C' };
    const command = String(a.command), executable = p.network ? '/bin/sh' : '/usr/bin/sandbox-exec';
    const args = p.network ? ['-c', command] : ['-p', '(version 1)(allow default)(deny network*)', '/bin/sh', '-c', command];
    log({ kind: 'command', sha256: hash(command), network: p.network });
    return new Promise((accept, reject) => execFile(executable, args, { cwd: p.cwd, env, timeout: 60000, maxBuffer: 64000 }, (error, stdout) => error ? reject(new Error('命令失败或超时')) : accept({ stdout })));
  });
  const writeTools = new Set(['pa_write', 'pa_edit']);
  pi.on('tool_call', async event => {
    const name = event.toolName ?? '';
    if (!names.includes(name)) { log({ kind: 'denied', tool: name }); return { block: true, reason: '拒绝：本次派工没有这项能力' }; }
    if (['pa_fetch', 'pa_bash'].includes(name)) return;
    try {
      if (name === 'pa_output' && p.output) { await files.check(p.output.source); await files.check(p.output.target, 'write'); if (p.output.companion) await files.check(p.output.companion, 'write'); }
      else await files.check(path(event.input ?? {}), writeTools.has(name) ? 'write' : 'read');
    }
    catch (error) { const result = failure(error); return { block: true, reason: `${result.category}: ${result.error}` }; }
    return;
  });
  let final = '', failed = false, turns = 0, calls = 0, totalTokens = 0;
  pi.on('before_provider_request', event => {
    log({ kind: 'model_call', call: ++calls, promptVersion: 'pa-pi-c-1', payloadHash: hash(JSON.stringify(event.payload ?? null)) });
  });
  pi.on('session_start', () => {
    pi.setActiveTools(names);
    writeFileSync(join(dir, 'ready.json'), JSON.stringify({ operation: p.operation, token: p.token, pid: process.pid, tools: pi.getActiveTools() }), { mode: 0o600 });
    log({ kind: 'ready', tools: pi.getActiveTools() });
  });
  pi.on('before_agent_start', () => { pi.setActiveTools(names); });
  pi.on('message_end', event => {
    if (event.message?.role !== 'assistant') return;
    totalTokens += event.message.usage?.totalTokens ?? 0;
    log({ kind: 'model_result', call: calls, usage: event.message.usage, stopReason: event.message.stopReason });
    final = event.message.content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') ?? '';
    if (['error', 'aborted'].includes(event.message.stopReason ?? '')) failed = true;
  });
  pi.on('turn_end', (_event, ctx) => { if (++turns >= p.maxTurns) { failed = true; ctx.shutdown(); } });
  pi.on('agent_settled', event => {
    writeFileSync(join(dir, 'agent-result.json'), JSON.stringify({ operation: p.operation, token: p.token, final, totalTokens, failed: failed || event.aborted === true }), { mode: 0o600 });
  });
}
