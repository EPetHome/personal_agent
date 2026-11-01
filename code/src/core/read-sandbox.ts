import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hash } from './utils.ts';
import type { ReadAudit, ReadScope } from './intelligence-types.ts';

export function within(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === '' || (!isAbsolute(diff) && diff !== '..' && !diff.startsWith('../'));
}
export function broadProject(project: string, home: string): boolean {
  const path = resolve(project), base = basename(path).toLowerCase();
  return !isAbsolute(project) || path === '/' || path === resolve(home) || dirname(path) === path
    || ['/users', '/home', '/volumes', '/tmp', '/private/tmp'].includes(path.toLowerCase())
    || ['desktop', 'documents', 'downloads', '桌面', '文稿', '文档', '下载'].includes(base);
}
function forbidden(path: string, directory = false): string | null {
  const parts = path.split('/').filter(Boolean), dirs = directory ? parts : parts.slice(0, -1);
  if (dirs.some(p => /^(?:\.ssh|\.aws|\.gnupg|\.personal-agent|\.bak|\.git|keychains?|钥匙串|passwords?|密码管理器|私人聊天|private.?chats?|1password|bitwarden|lastpass|keepass|wechat|微信|telegram)$/i.test(p)
    || /backup|备份|私人聊天|密码管理器|钥匙串/i.test(p)
    || /^(?:\.1password|keepassxc|dashlane|enpass|messages|whatsapp|signal|com\.tencent\.xinwechat|wechat\s*files)$/i.test(p))) return '不许读的目录';
  if (dirs.some((p, i) => p.toLowerCase() === 'eval' && /^(?:cases|runs|待标注)$/i.test(dirs[i + 1] ?? ''))) return '真实评测数据目录';
  if (directory) return null;
  const name = basename(path);
  if (/^\.env(?:\.|$)/i.test(name) && !/^\.env(?:\.[\w-]+)*\.(?:example|sample|template)$/i.test(name)) return '环境凭证文件';
  if (/\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i.test(name) || /^id_(?:rsa|ed25519|ecdsa)/i.test(name)) return '私钥或证书';
  if (/^(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i.test(name)) return '凭证配置文件';
  if (/(?:auth|session|cookie).*\.(?:db|sqlite|json)$/i.test(name)) return '登录态文件';
  return null;
}
export class ReadDenied extends Error {}
export class ToolLimit extends Error {}
/** 不调用 rg/find 子进程；递归中的每一个入口同样先授权。只返回文本，不返回图片或二进制。 */
export class ReadSandbox {
  scope: ReadScope;
  project: string | null = null;
  transcript = '';
  calls = 0;
  limited = false;
  private audit: (entry: ReadAudit) => Promise<void>;
  private constructor(scope: ReadScope, audit: (entry: ReadAudit) => Promise<void>) { this.scope = scope; this.audit = audit; }
  static async create(scope: ReadScope, audit: (entry: ReadAudit) => Promise<void>): Promise<ReadSandbox> {
    const box = new ReadSandbox(scope, audit);
    box.transcript = resolve(scope.transcript);
    // 会话例外只认这一个普通文件，不把 realpath 指向的其他会话当作授权。
    if (!broadProject(scope.project, scope.home)) {
      const candidate = resolve(scope.project);
      try {
        const actual = await realpath(candidate);
        if (!broadProject(actual, scope.home) && !forbidden(candidate, true) && !forbidden(actual, true)
          && (await lstat(actual)).isDirectory()) box.project = actual;
      } catch { /* 项目不存在/读不了：降为只读该会话。 */ }
    }
    return box;
  }
  private async deny(path: string, reason: string): Promise<never> {
    await this.audit({ kind: 'blocked', blocked: { path, reason } });
    throw new ReadDenied(`拒绝读取：${path}（${reason}）`);
  }
  private absolute(path: unknown): string {
    if (typeof path !== 'string' || path.includes('\0')) throw new ReadDenied('路径必须是普通字符串');
    return resolve(path === '~' ? this.scope.home : path.startsWith('~/') ? join(this.scope.home, path.slice(2))
      : isAbsolute(path) ? path : join(this.project ?? this.scope.project, path));
  }
  async authorize(input: string, directory: boolean | 'either' = false): Promise<string> {
    const path = this.absolute(input), session = path === this.transcript && directory !== true;
    if (!session) {
      if (!this.project || !within(this.project, path)) return this.deny(path, '不在当前会话的项目范围内');
      const reason = forbidden(path, directory === true);
      if (reason) return this.deny(path, reason);
      if (within(resolve(this.scope.dataDir), path) || this.scope.sourceDirs.some(root => within(resolve(root), path)))
        return this.deny(path, '运行数据或其他会话目录');
    }
    try {
      const actual = await realpath(path);
      if (actual !== path) return this.deny(path, '不跟随符号链接或路径别名');
      // 连同祖先检查；不能从允许目录里的链接跳到其他项目/敏感目录。
      const root = session ? dirname(path) : this.project!;
      for (let current = path;; current = dirname(current)) {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) return this.deny(path, '不跟随符号链接');
        if (current === root || dirname(current) === current) break;
      }
      const stat = await lstat(path);
      if (!session) {
        const reason = forbidden(path, stat.isDirectory());
        if (reason) return this.deny(path, reason);
      }
      if (directory === true ? !stat.isDirectory() : directory === 'either' ? !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)
        : !stat.isFile() || stat.nlink !== 1) return this.deny(path, '不是普通单链接文件/目录');
      return path;
    } catch (error) {
      if (error instanceof ReadDenied) throw error;
      return this.deny(path, '路径不存在或无法安全读取');
    }
  }
  /** 程序提取实际回复亦走相同授权；正文只在内存，不写入审计。 */
  async text(path: string, offset = 1, limit = 300, byteLimit = 32768, column = 1): Promise<{ text: string; endLine: number; eof: boolean; next?: { offset: number; column: number } }> {
    path = await this.authorize(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat(), visible = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== visible.ino || stat.dev !== visible.dev || await realpath(path) !== path)
        return this.deny(path, '读取期间路径发生变化');
      let lineNo = 0, bytes = 0, endLine = offset - 1, endColumn = column, eof = true;
      let next: { offset: number; column: number } | undefined;
      const lines: string[] = [];
      for await (const line of file.readLines({ autoClose: false })) {
        lineNo++;
        if (lineNo < offset) continue;
        if (lines.length >= limit) { eof = false; next = { offset: lineNo, column: 1 }; break; }
        if (line.includes('\0')) return this.deny(path, '不读取二进制文件');
        const startColumn = lineNo === offset ? column : 1;
        if (startColumn > line.length + 1) throw new ReadDenied('column 超出当前行');
        const rest = line.slice(startColumn - 1), available = byteLimit - bytes - (lines.length ? 1 : 0);
        if (Buffer.byteLength(rest) > available) {
          eof = false;
          if (!lines.length) {
            let prefix = '', used = 0;
            for (const char of rest) {
              const size = Buffer.byteLength(char); if (used + size > available) break;
              prefix += char; used += size;
            }
            if (!prefix) throw new ReadDenied('单个字符超过本次字节预算');
            lines.push(prefix); endLine = lineNo; endColumn = startColumn + prefix.length;
            next = { offset: lineNo, column: endColumn };
          } else next = { offset: lineNo, column: 1 };
          break;
        }
        lines.push(rest); bytes += Buffer.byteLength(rest) + (lines.length > 1 ? 1 : 0); endLine = lineNo; endColumn = line.length + 1;
      }
      if (lineNo > 0 && endLine < offset) throw new ReadDenied('offset 超出文件行数');
      const text = lines.join('\n');
      await this.audit({ kind: 'read', read: { path, startLine: offset, endLine: Math.max(offset, endLine),
        startColumn: column, endColumn, contentSha256: hash(text) } });
      return { text, endLine, eof, ...(next ? { next } : {}) };
    } finally { await file.close(); }
  }
  private async *walk(input: string, recursive: boolean, signal?: AbortSignal): AsyncGenerator<string> {
    const root = await this.authorize(input, true);
    const stack = [root]; let visited = 0;
    while (stack.length && visited < 2000) {
      if (signal?.aborted) throw new Error('cancelled');
      const dir = await this.authorize(stack.pop()!, true);
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 2000) break;
        const path = join(dir, entry.name);
        try {
          await this.authorize(path, entry.isDirectory());
          yield path;
          if (recursive && entry.isDirectory()) stack.push(path);
        } catch (error) { if (!(error instanceof ReadDenied)) throw error; }
      }
    }
  }
  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('cancelled');
    if (this.calls >= this.scope.maxToolCalls) {
      if (!this.limited) { this.limited = true; await this.audit({ kind: 'limit' }); }
      throw new ToolLimit('只读工具调用次数上限');
    }
    this.calls++; await this.audit({ kind: 'call' });
    try {
      if (!['read', 'grep', 'find', 'ls'].includes(name)) return await this.deny(String(args.path ?? name), '只允许 read,grep,find,ls');
      const path = this.absolute(args.path ?? this.project ?? this.transcript);
      if (name === 'read') {
        const offset = Number(args.offset ?? 1), limit = Number(args.limit ?? 300), column = Number(args.column ?? 1);
        if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(column) || column < 1
          || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ReadDenied('offset/column/limit 非法，limit 最大1000');
        const value = await this.text(path, offset, limit, 32768, column);
        return JSON.stringify({ path, startLine: offset, startColumn: column, endLine: value.endLine, eof: value.eof, next: value.next, text: value.text });
      }
      const limit = Math.min(200, Math.max(1, Number(args.limit ?? 100) || 100));
      const result: string[] = [];
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      if (pattern.length > 500) throw new ReadDenied('搜索词过长');
      // grep 使用字面量搜索，避免任意正则造成拒绝服务。find 仅按简单 glob 过滤路径。
      const glob = new RegExp('^' + pattern.split(/(\*\*|\*|\?)/).map(part => part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
      const isFile = (await lstat(await this.authorize(path, 'either'))).isFile();
      const entries = isFile ? [await this.authorize(path)] : this.walk(path, name !== 'ls', signal);
      for await (const entry of entries) {
        if (result.length >= limit) break;
        const stat = await lstat(entry), rel = relative(this.project ?? dirname(this.transcript), entry);
        if (name === 'ls' || (name === 'find' && (!pattern || glob.test(rel) || glob.test(basename(entry))))) result.push(rel + (stat.isDirectory() ? '/' : ''));
        if (name === 'grep' && stat.isFile()) {
          let offset = 1, column = 1;
          // 每个文件最多扫描2MiB，所有已读范围留指纹，不把未命中的正文送给模型。
          for (let bytes = 0; bytes < 2 * 1024 * 1024;) {
            const page = await this.text(entry, offset, 1000, 32768, column);
            const lines = page.text.split('\n'); bytes += Buffer.byteLength(page.text);
            lines.forEach((line, i) => { if (result.length < limit && (args.ignoreCase ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern))) result.push(`${entry}:${offset + i}:${line}`); });
            if (page.eof || result.length >= limit || page.endLine < offset) break;
            offset = page.next?.offset ?? page.endLine + 1; column = page.next?.column ?? 1;
          }
        }
      }
      return result.join('\n').slice(0, 32768) + '\n[最多200项；目录遍历最多2000项；grep每文件最多2MiB]';
    } catch (error) {
      if (error instanceof ReadDenied) return error.message;
      throw error;
    }
  }
}
