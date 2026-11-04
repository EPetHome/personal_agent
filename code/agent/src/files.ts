import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { Config, Material } from './types.js';
import { canonical, hash, inside } from './util.js';
import type { Store } from './store.js';

export class ReadDenied extends Error { constructor() { super('拒绝读取：不在授权范围内，或命中不许读名单。'); } }
export class Files {
  constructor(readonly config: Config, readonly store: Store) {}
  private nameDenied(path: string) {
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
  async check(path: string, registeredEvidence = false, protocolReceipt = false) {
    const requested = resolve(path);
    if (this.nameDenied(requested)) throw new ReadDenied();
    const actual = await canonical(requested);
    const c = this.config;
    const origin = this.store.get<{ name: string } | null>(`attachment-origin:${actual}`, null);
    if (this.nameDenied(actual) || origin && this.nameDenied(origin.name)) throw new ReadDenied();
    // Pre-fix generated attachments without origin metadata cannot be proven safe.
    // Do not infer their original policy name from a lossy/sanitized saved filename.
    if (!origin && inside(await canonical(c.attachmentDir), actual) && /^[a-f0-9]{24}-/.test(basename(actual))) throw new ReadDenied();
    const denied = [c.dataDir, `${homedir()}/.personal-agent`, `${homedir()}/.personal-agent-v2`, c.configPath, c.model.auth.path, c.feishu.envFile, ...c.readDeny].filter(Boolean);
    for (const root of denied) if (inside(await canonical(root), actual) || inside(resolve(root), requested)) throw new ReadDenied();
    const roots = await Promise.all([...c.projects.map(p => p.root), ...c.inboxDirs, c.attachmentDir, ...(protocolReceipt ? c.loop.eventDirs : [])].map(canonical));
    let allowed = roots.some(root => inside(root, actual));
    if (registeredEvidence) {
      const row = this.store.db.prepare('SELECT project FROM evidence WHERE path=?').get(actual);
      const project = row && c.projects.find(p => p.id === row.project);
      if (project) for (const root of project.loopRunDirs) if (inside(await canonical(root), actual)) allowed = true;
    }
    if (!allowed) throw new ReadDenied();
    // Optional narrowing, never an expansion beyond projects/inboxes/attachments/evidence.
    if (c.readAllow.length && !(await Promise.all(c.readAllow.map(canonical))).some(root => inside(root, actual))) throw new ReadDenied();
    return actual;
  }
  async registerEvidence(projectRoot: string, paths: Record<string, string>) {
    const root = await canonical(projectRoot);
    const project = this.config.projects.find(p => resolve(p.root) === root);
    if (!project) return;
    for (const path of Object.values(paths)) {
      if (typeof path !== 'string' || !path.startsWith('/')) continue;
      const actual = await canonical(path);
      if (this.nameDenied(actual) || this.nameDenied(path)) continue;
      const roots = await Promise.all([project.root, ...project.loopRunDirs].map(canonical));
      if (!roots.some(r => inside(r, actual))) continue;
      this.store.db.prepare('INSERT INTO evidence VALUES(?,?) ON CONFLICT(path) DO UPDATE SET project=excluded.project').run(actual, project.id);
    }
  }
  async read(path: string, materials: Material[], evidence = false, offset = 0, length = 64000, image = false) {
    try {
      const actual = await this.check(path, evidence);
      const fd = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await fd.stat();
        if (!info.isFile() || info.nlink !== 1 || actual !== await realpath(path) || actual !== await this.check(path, evidence)) throw new ReadDenied();
        const current = await stat(actual);
        if (current.ino !== info.ino || current.dev !== info.dev) throw new ReadDenied();
        const header = Buffer.alloc(Math.min(4096, info.size));
        await fd.read(header, 0, header.length, 0);
        if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/.test(header.toString('utf8'))) throw new ReadDenied();
        if (image && (!/\.(png|jpe?g|gif|webp)$/i.test(actual) || info.size > this.config.intake.maxFileBytes)) throw new ReadDenied();
        const start = Math.max(0, Math.floor(offset)), size = image ? info.size : Math.min(64000, Math.max(1, Math.floor(length)));
        const buf = Buffer.alloc(Math.max(0, Math.min(size, info.size - start)));
        const { bytesRead } = await fd.read(buf, 0, buf.length, start);
        const content = buf.subarray(0, bytesRead);
        if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/.test(content.toString('utf8'))) throw new ReadDenied();
        const material = { path: actual, sha256: hash(content), bytes: bytesRead };
        materials.push(material); this.store.log('file_read', { ...material, offset: start, input: this.store.get('activeInput', null) });
        const mime = /\.jpe?g$/i.test(actual) ? 'image/jpeg' : /\.webp$/i.test(actual) ? 'image/webp' : /\.gif$/i.test(actual) ? 'image/gif' : 'image/png';
        return { ok: true as const, ...material, name: basename(actual), content: content.toString(image ? 'base64' : 'utf8'), ...(image ? { mime } : {}), offset: start, totalBytes: info.size, truncated: start + bytesRead < info.size };
      } finally { await fd.close(); }
    } catch (error) {
      if (error instanceof ReadDenied) return { ok: false as const, error: error.message };
      return { ok: false as const, error: '文件不存在、不是可读普通文件，或读取失败。' };
    }
  }
}
