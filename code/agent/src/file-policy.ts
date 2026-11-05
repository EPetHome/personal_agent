import { constants } from 'node:fs';
import { open, stat, realpath, readdir, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { canonical, inside, hash } from './util.js';

export class ReadDenied extends Error { constructor() { super('拒绝读取：不在授权范围内，或命中不许读名单。'); } }
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
  attachmentDir: string; origins: Record<string, string>; write: string[]; scope?: string[]; edit?: Record<string, string>;
}
/** Serializable policy, shared with Pi. Evidence grants only the registered file. */
export class ScopedFiles {
  constructor(readonly policy: FilePolicy, readonly denied: (path: string, action: string) => void = () => {}) {}
  private refuse(path: string, action: string): never { this.denied(path, action); throw new ReadDenied(); }
  async check(path: string, action: 'read' | 'write' = 'read') {
    const requested = resolve(this.policy.cwd, path), actual = await canonical(requested), p = this.policy;
    if (nameDenied(requested) || nameDenied(actual) || p.deny.some(root => inside(root, actual) || inside(root, requested))) return this.refuse(requested, action);
    if (action === 'write') {
      // Rule/config changes and overwrites are not granted by an ordinary file dispatch.
      if (actual.split('/').some(part => ['.git', '.pi', '.autoreview'].includes(part)) || /^(?:AGENTS|CLAUDE)\.md$/i.test(basename(actual)) || !p.write.some(root => inside(root, actual)) || p.write.includes(actual)) return this.refuse(requested, action);
    } else {
      const origin = p.origins[actual];
      if (origin && nameDenied(origin) || !origin && inside(p.attachmentDir, actual) && /^[a-f0-9]{24}-/.test(basename(actual))) return this.refuse(requested, action);
      if (!p.roots.some(root => inside(root, actual)) && !p.evidence.includes(actual)) return this.refuse(requested, action);
      if (p.narrow.length && !p.narrow.some(root => inside(root, actual)) || p.scope?.length && !p.scope.some(root => inside(root, actual))) return this.refuse(requested, action);
    }
    return actual;
  }
  async read(path: string, offset = 0, limit = 64000) {
    const actual = await this.check(path), fd = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await fd.stat(), current = await stat(actual);
      if (!info.isFile() || info.nlink !== 1 || current.ino !== info.ino || current.dev !== info.dev || actual !== await realpath(resolve(this.policy.cwd, path)) || actual !== await this.check(path)) return this.refuse(path, 'read');
      // Scan the whole bounded file, not just the requested range, for PEM material.
      if (info.size > 2 * 1024 * 1024) return this.refuse(path, 'read');
      const data = await fd.readFile();
      if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/.test(data.toString('utf8'))) return this.refuse(path, 'read');
      const start = Math.max(0, Math.floor(offset)), content = data.subarray(start, start + Math.min(64000, Math.max(1, limit)));
      return { path: actual, content: content.toString('utf8'), sha256: hash(content), totalBytes: info.size, truncated: start + content.length < info.size };
    } finally { await fd.close(); }
  }
  async list(path: string) {
    const actual = await this.check(path), entries = await readdir(actual, { withFileTypes: true }), result: { path: string; directory: boolean }[] = [];
    for (const entry of entries.slice(0, 10000)) {
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
