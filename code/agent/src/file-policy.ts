import { constants } from 'node:fs';
import { open, stat, realpath, opendir, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { canonical, inside, hash } from './util.js';
import { SafeError } from './errors.js';
import { extract, READ_CAPABILITY, textChunk } from './documents.js';

export class ReadDenied extends SafeError {
  constructor(category = 'outside_scope') { super(category, category === 'blacklist' ? '拒绝读取：命中不许读名单。' : '拒绝读取：不在授权范围内。'); }
}
export async function readBytes(path: string, check: () => Promise<string>, maxBytes: number) {
  const actual = await check(), before = await stat(actual);
  if (before.isDirectory()) throw new SafeError('is_directory', '这是目录，请使用列目录工具。');
  if (!before.isFile()) throw new SafeError('not_regular_file', '不是可读的普通文件。');
  const fd = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fd.stat(), current = await stat(actual);
    if (!info.isFile() || info.nlink !== 1 || current.ino !== info.ino || current.dev !== info.dev || actual !== await realpath(path) || actual !== await check()) throw new ReadDenied();
    if (info.size > maxBytes) throw new SafeError('resource_limit', '文件超过本次读取的资源上限，未提取正文。');
    // Read a fixed bound, not readFile() on a file another process can keep growing.
    const data = Buffer.alloc(info.size); let position = 0;
    while (position < data.length) { const r = await fd.read(data, position, data.length - position, position); if (!r.bytesRead) break; position += r.bytesRead; }
    const after = await fd.stat();
    if (position !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || actual !== await check()) throw new SafeError('file_changed', '读取期间文件发生变化，未返回内容。');
    if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/.test(data.toString('utf8'))) throw new ReadDenied('blacklist');
    return { actual, data };
  } finally { await fd.close(); }
}
export function nameDenied(path: string) {
  const parts = path.replaceAll('\\', '/').toLowerCase().split('/');
  return parts.some((part, i) => {
    if (/^\.env/i.test(part) && !/\.(example|sample|template)$/.test(part)) return true;
    if (['.ssh', '.aws', '.gnupg', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'keychains', 'keychain', '1password', '.1password', 'bitwarden', '.bitwarden', '私人聊天', 'private-chats', 'chats', '备份', '备份目录', 'backup', 'backups', '.backup', '.backups'].includes(part)) return true;
    if (part.includes('备份') || /(?:^|[._-])backups?(?:$|[._-])/.test(part) || /\.(?:pem|key|crt|cer|der|p12|pfx|p8|ppk|jks|keystore|kdbx|bak|backup)$/.test(part) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:$|\.)/.test(part)) return true;
    if (/(?:auth|session|cookie)/.test(part) && /\.(?:json|jsonl|db|sqlite|sqlite3)(?:-(?:wal|shm))?$/.test(part)) return true;
    if (part === '.git' && parts[i + 1] === 'config') return true;
    return part === 'eval' && ['cases', 'runs', '待标注'].includes(parts[i + 1] ?? '');
  });
}
export interface FilePolicy {
  cwd: string; roots: string[]; evidence: string[]; narrow: string[]; deny: string[];
  attachmentDir: string; origins: Record<string, string>; write: string[]; scope?: string[]; edit?: Record<string, string>; maxReadBytes?: number;
}
/** Serializable policy, shared with Pi. Evidence grants only the registered file. */
export class ScopedFiles {
  constructor(readonly policy: FilePolicy, readonly denied: (path: string, action: string) => void = () => {}) {}
  private refuse(path: string, action: string, category = 'outside_scope'): never { this.denied(path, action); throw new ReadDenied(category); }
  async check(path: string, action: 'read' | 'write' = 'read') {
    const requested = resolve(this.policy.cwd, path), p = this.policy;
    let actual: string;
    try { actual = await canonical(requested); }
    catch (error) { if (![...p.roots, ...p.evidence].some(root => inside(root, requested))) return this.refuse(requested, action); throw error; }
    if (inside(p.attachmentDir, requested) && !inside(p.attachmentDir, actual)) return this.refuse(requested, action);
    if (nameDenied(requested) || nameDenied(actual) || p.deny.some(root => inside(root, actual) || inside(root, requested))) return this.refuse(requested, action, 'blacklist');
    if (action === 'write') {
      // Rule/config changes and overwrites are not granted by an ordinary file dispatch.
      if (actual.split('/').some(part => ['.git', '.pi', '.autoreview'].includes(part)) || /^(?:AGENTS|CLAUDE)\.md$/i.test(basename(actual)) || !p.write.some(root => inside(root, actual)) || p.write.includes(actual)) return this.refuse(requested, action);
    } else {
      const origin = p.origins[actual];
      if (origin && nameDenied(origin) || !origin && inside(p.attachmentDir, actual) && /^[a-f0-9]{24}-/.test(basename(actual))) return this.refuse(requested, action, 'blacklist');
      if (!p.roots.some(root => inside(root, actual)) && !p.evidence.includes(actual)) return this.refuse(requested, action);
      if (p.narrow.length && !p.narrow.some(root => inside(root, actual)) || p.scope?.length && !p.scope.some(root => inside(root, actual))) return this.refuse(requested, action);
    }
    return actual;
  }
  async read(path: string, offset = 0, limit = 64000, signal?: AbortSignal) {
    const { actual, data } = await readBytes(resolve(this.policy.cwd, path), () => this.check(path), Math.min(this.policy.maxReadBytes ?? READ_CAPABILITY.maxSourceBytes, READ_CAPABILITY.maxSourceBytes));
    const parsed = await extract(data, actual, signal);
    if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/.test(parsed.text)) throw new ReadDenied('blacklist');
    const chunk = textChunk(parsed.text, offset, limit);
    return { path: actual, ...chunk, sha256: hash(chunk.content), sourceSha256: hash(data), totalBytes: data.length, format: parsed.format, ...(parsed.pages ? { pages: parsed.pages, textPages: parsed.textPages } : {}) };
  }
  async list(path: string) {
    const actual = await this.check(path);
    if (!(await stat(actual)).isDirectory()) throw new SafeError('not_directory', '这不是目录。');
    const directory = await opendir(actual), result: { path: string; directory: boolean }[] = []; let visited = 0;
    for await (const entry of directory) {
      if (++visited > 10000) break;
      const child = resolve(actual, entry.name);
      // Do not follow directory aliases, sockets, devices or hard links in traversal.
      if (!entry.isDirectory() && !entry.isFile()) continue;
      try { await this.check(child); result.push({ path: child, directory: entry.isDirectory() }); }
      catch (e) { if (!(e instanceof ReadDenied)) throw e; }
    }
    return result;
  }
  async search(path: string, needle: string, contents: boolean) {
    const pending = [await this.check(path)], matches: unknown[] = []; let visited = 0;
    while (pending.length && visited++ < 2000 && matches.length < 100) {
      const file = pending.shift()!;
      try {
        if ((await stat(file)).isDirectory()) {
          for (const entry of await this.list(file)) pending.push(entry.path);
        } else if (contents) {
          const data = await this.read(file);
          for (const [i, line] of data.content.split('\n').entries()) if (line.includes(needle)) { matches.push({ path: data.path, line: i + 1, text: line.slice(0, 1000) }); if (matches.length >= 100) break; }
        } else if (file.includes(needle)) { await this.read(file, 0, 1); matches.push(file); }
      } catch (e) { if (!(e instanceof ReadDenied)) throw e; }
    }
    return { matches, bounded: true, visited };
  }
  async edit(path: string, oldText: string, newText: string) {
    const actual = await this.check(path, 'write'), expected = this.policy.edit?.[actual];
    if (!expected || !oldText) return this.refuse(path, 'edit');
    await this.check(path);
    const fd = await open(actual, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const info = await fd.stat(), current = await stat(actual);
      if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024 || info.ino !== current.ino || info.dev !== current.dev || actual !== await this.check(path, 'write')) return this.refuse(path, 'edit');
      const before = await fd.readFile(), text = before.toString('utf8');
      if (hash(before) !== expected || /-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/.test(text) || text.split(oldText).length !== 2) return this.refuse(path, 'edit');
      const next = text.replace(oldText, () => newText);
      if (Buffer.byteLength(next) > 2 * 1024 * 1024) throw new Error('文件过大');
      await fd.write(Buffer.from(next), 0, Buffer.byteLength(next), 0); await fd.truncate(Buffer.byteLength(next)); await fd.sync();
      this.policy.edit![actual] = hash(next); // Subsequent edits still require this exact file version.
      return { path: actual, sha256: hash(next) };
    } finally { await fd.close(); }
  }
  async write(path: string, content: string) {
    const actual = await this.check(path, 'write');
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('文件过大');
    await mkdir(dirname(actual), { recursive: true });
    if (actual !== await this.check(path, 'write')) return this.refuse(path, 'write');
    // No overwrite: destructive edits need separate red-line authorization, not a directory grant.
    const fd = await open(actual, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
    return { path: actual, sha256: hash(content) };
  }
}
