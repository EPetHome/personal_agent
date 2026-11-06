import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { Config, Material } from './types.js';
import { canonical, hash, inside, parseJson } from './util.js';
import type { Store } from './store.js';
import { nameDenied, ReadDenied, ScopedFiles, readBytes, type FilePolicy } from './file-policy.js';
import { failure } from './errors.js';
import { imageType } from './image.js';
export { ReadDenied } from './file-policy.js';
export class Files {
  constructor(readonly config: Config, readonly store: Store) {}
  private readonly nameDenied = nameDenied;
  async policy(cwd: string, write: string[] = [], narrow: string[] = []): Promise<FilePolicy> {
    const c = this.config, evidence: string[] = [], origins: Record<string, string> = {};
    for (const row of this.store.db.prepare('SELECT path FROM evidence').all()) {
      try { evidence.push(await this.check(String(row.path), true)); } catch (e) { if (!(e instanceof ReadDenied)) throw e; }
    }
    for (const row of this.store.db.prepare("SELECT key,value FROM kv WHERE key GLOB 'attachment-origin:*'").all()) origins[String(row.key).slice('attachment-origin:'.length)] = parseJson<{ name: string }>(String(row.value)).name;
    return { cwd, write, evidence, origins, maxReadBytes: c.intake.maxFileBytes, attachmentDir: c.attachmentDir,
      roots: [...c.projects.map(p => p.root), ...c.inboxDirs, c.attachmentDir],
      narrow: c.readAllow, scope: await Promise.all(narrow.map(canonical)),
      deny: await Promise.all([c.dataDir, `${homedir()}/.personal-agent`, `${homedir()}/.personal-agent-v2`, c.configPath, c.model.auth.path, c.feishu.envFile, ...c.readDeny].filter(Boolean).map(canonical)) };
  }
  async check(path: string, registeredEvidence = false, protocolReceipt = false) {
    const requested = resolve(path);
    if (this.nameDenied(requested)) throw new ReadDenied('blacklist');
    const c = this.config;
    let actual: string;
    try { actual = await canonical(requested); }
    catch (error) {
      if (![...c.projects.map(p => p.root), ...c.inboxDirs, c.attachmentDir, ...(registeredEvidence ? c.projects.flatMap(p => p.loopRunDirs) : [])].some(root => inside(root, requested))) throw new ReadDenied();
      throw error;
    }
    if (inside(c.attachmentDir, requested) && !inside(c.attachmentDir, actual)) throw new ReadDenied();
    const origin = this.store.get<{ name: string } | null>(`attachment-origin:${actual}`, null);
    if (this.nameDenied(actual) || origin && this.nameDenied(origin.name)) throw new ReadDenied('blacklist');
    // Pre-fix generated attachments without origin metadata cannot be proven safe.
    // Do not infer their original policy name from a lossy/sanitized saved filename.
    if (!origin && inside(c.attachmentDir, actual) && /^[a-f0-9]{24}-/.test(basename(actual))) throw new ReadDenied('blacklist');
    const denied = [c.dataDir, `${homedir()}/.personal-agent`, `${homedir()}/.personal-agent-v2`, c.configPath, c.model.auth.path, c.feishu.envFile, ...c.readDeny].filter(Boolean);
    for (const root of denied) if (inside(await canonical(root), actual) || inside(resolve(root), requested)) throw new ReadDenied('blacklist');
    const roots = [...c.projects.map(p => p.root), ...c.inboxDirs, c.attachmentDir, ...(protocolReceipt ? c.loop.eventDirs : [])];
    let allowed = roots.some(root => inside(root, actual));
    if (registeredEvidence) {
      const row = this.store.db.prepare('SELECT project FROM evidence WHERE path=?').get(actual);
      const project = row && c.projects.find(p => p.id === row.project);
      if (project) for (const root of project.loopRunDirs) if (inside(root, actual)) allowed = true;
    }
    if (!allowed) throw new ReadDenied();
    // Optional narrowing, never an expansion beyond projects/inboxes/attachments/evidence.
    if (c.readAllow.length && !c.readAllow.some(root => inside(root, actual))) throw new ReadDenied();
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
      const roots = [project.root, ...project.loopRunDirs];
      if (!roots.some(r => inside(r, actual))) continue;
      this.store.db.prepare('INSERT INTO evidence VALUES(?,?) ON CONFLICT(path) DO UPDATE SET project=excluded.project').run(actual, project.id);
    }
  }
  async list(path: string, materials: Material[] = []) {
    try {
      const actual = await this.check(path), scoped = new ScopedFiles(await this.policy(actual));
      const entries = await scoped.list(actual);
      const value = { ok: true as const, path: actual, entries, bounded: true, limit: 10000 };
      const material = { path: actual, sha256: hash(JSON.stringify(entries)) };
      materials.push(material); this.store.log('directory_read', material); return value;
    } catch (error) { return failure(error); }
  }
  async read(path: string, materials: Material[], evidence = false, offset = 0, length = 64000, image = false, signal?: AbortSignal) {
    try {
      const actual = await this.check(path, evidence);
      let result;
      if (image) {
        const { data } = await readBytes(path, () => this.check(path, evidence), this.config.intake.maxFileBytes);
        const { mime } = imageType(data);
        result = { path: actual, content: data.toString('base64'), sha256: hash(data), mime, offset: 0, totalBytes: data.length, truncated: false };
      } else {
        const scoped = new ScopedFiles(await this.policy(this.config.projects[0]?.root ?? this.config.attachmentDir));
        result = await scoped.read(actual, offset, length, signal);
      }
      await this.check(path, evidence);
      const material = { path: actual, sha256: result.sha256, bytes: Buffer.byteLength(result.content) };
      materials.push(material); this.store.log('file_read', { ...material, offset: result.offset, input: this.store.get('activeInput', null) });
      return { ok: true as const, ...result, name: basename(actual) };
    } catch (error) { signal?.throwIfAborted(); return failure(error); }
  }
}
