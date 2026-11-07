import { watch, type FSWatcher } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readBytes } from './file-policy.js';
import type { Config, Input } from './types.js';
import type { Store } from './store.js';
import type { Files } from './files.js';
import { canonical, hash } from './util.js';

export class Intake {
  private watchers: FSWatcher[] = [];
  private boundWatches = new Set<string>();
  private fallback?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private stopped = false;
  private scanPromise: Promise<void> = Promise.resolve();
  constructor(readonly c: Config, readonly store: Store, readonly files: Files, readonly receive: (input: Input) => void) {}
  async start() {
    const roots = [...this.c.inboxDirs, ...this.c.loop.eventDirs];
    if (this.c.intake.watch) for (const root of roots) {
      try {
        const watcher = watch(root, { recursive: true }, () => { clearTimeout(this.debounce); this.debounce = setTimeout(() => this.scan(), 60); });
        watcher.on('error', () => { this.store.log('intake_watch_failure', { path: root, outcome: '文件通知失效，继续低频兜底' }); });
        this.watchers.push(watcher);
      } catch { this.store.log('intake_watch_failure', { path: root, outcome: '文件通知不可用，继续低频兜底' }); }
    }
    this.fallback = setInterval(() => this.scan(), this.c.intake.fallbackMs);
    await this.scan();
  }
  scan() {
    this.scanPromise = this.scanPromise.then(async () => {
      if (this.stopped) return;
      for (const root of this.c.inboxDirs) await this.walk(root, false);
      for (const root of this.c.loop.eventDirs) await this.walk(root, true);
      await this.boundLoops();
    }).catch(() => { if (!this.stopped) this.store.log('intake_failure', { outcome: '来源暂不可读；保留游标，下次兜底再收' }); });
    return this.scanPromise;
  }
  /** Existing bindings only. Never enumerate the kernel root or expose a raw ledger as input. */
  private async boundLoops() {
    for (const card of this.store.boundLoops()) {
      const binding = card.worker!.loop!, project = this.c.projects.find(p => p.id === card.worker!.project || p.root === card.worker!.project);
      if (!project) continue;
      try {
        const check = () => this.files.protocolPath(project.root, binding.ledger);
        await check();
        if (this.c.intake.watch && !this.boundWatches.has(binding.ledger)) {
          const watcher = watch(dirname(binding.ledger), (_kind, file) => {
            if (file === 'ledger.json') { clearTimeout(this.debounce); this.debounce = setTimeout(() => this.scan(), 60); }
          });
          watcher.on('error', () => { this.boundWatches.delete(binding.ledger); watcher.close(); });
          this.boundWatches.add(binding.ledger); this.watchers.push(watcher);
        }
        const info = await lstat(binding.ledger), signature = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
        const key = `kernel-source:${card.id}`, previous = this.store.get<string | { signature: string; revision: number }>(key, '');
        let revision: number;
        if (typeof previous === 'object' && previous.signature === signature) revision = previous.revision;
        else {
          const { data } = await readBytes(binding.ledger, check, this.c.intake.maxFileBytes);
          const raw = JSON.parse(data.toString('utf8'));
          if (raw.id !== binding.runId || raw.common !== binding.repository || raw.file !== binding.cardFile || !Number.isSafeInteger(raw.revision)) continue;
          revision = raw.revision;
          this.store.set(key, { signature, revision }); // Observed cursor only; card.sourceRevision is the verified cursor.
        }
        if (revision > (card.sourceRevision ?? -1)) this.receive({ id: `kernel:${hash(JSON.stringify([binding, revision]))}`, source: 'loop', who: 'loop', at: new Date().toISOString(), text: '已绑定 Loop 原执行的记录修订变化，请沿原身份核实。', project: project.root, batchFile: binding.cardFile, workerId: card.id, status: 'revision', attachments: [], raw: { kernel: 1, runId: binding.runId, revision, ledger: binding.ledger } });
      } catch { /* Keep previous verified facts; no-event detection is a later task. */ }
    }
  }
  private async walk(path: string, loop: boolean) {
    if (this.stopped) return;
    let actual: string;
    try { actual = await this.files.check(path, false, loop); } catch { return; }
    const info = await lstat(actual).catch(() => undefined); if (!info) return;
    if (info.isDirectory()) {
      for (const item of await readdir(actual, { withFileTypes: true })) if (!item.isSymbolicLink()) await this.walk(join(actual, item.name), loop);
      return;
    }
    if (!info.isFile() || info.nlink !== 1) return;
    const old = this.store.db.prepare('SELECT signature,offset FROM sources WHERE path=?').get(actual);
    const signature = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
    if (old?.signature === signature && (!loop || Number(old.offset) >= info.size)) return;
    if (!loop) {
      this.receive({ id: `inbox:${hash(`${actual}:${signature}`)}`, source: 'inbox', who: 'inbox', at: new Date().toISOString(), text: '收件箱文件新增或变化；先理解内容，需要动手时带选项问本人，不需要处理就静默。', attachments: [{ name: actual.split('/').at(-1)!, kind: /\.(png|jpe?g|gif|webp)$/i.test(actual) ? 'image' : 'file', path: actual }] });
      this.cursor(actual, signature, info.size); return;
    }
    if (!/\.(jsonl|json)$/.test(actual)) { this.cursor(actual, signature, info.size); return; }
    const fd = await open(actual, 'r');
    try {
      const sameFile = String(old?.signature ?? '').startsWith(`${info.dev}:${info.ino}:`);
      let offset = sameFile && Number(old?.offset) <= info.size ? Number(old?.offset ?? 0) : 0;
      if (actual.endsWith('.json')) {
        if (info.size > this.c.intake.maxFileBytes) { this.cursor(actual, signature, info.size); return; }
        offset = 0;
      }
      if (offset === info.size && old?.signature !== signature) offset = 0;
      const buffer = Buffer.alloc(Math.min(actual.endsWith('.json') ? this.c.intake.maxFileBytes : 256 * 1024, info.size - offset));
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, offset);
      const data = buffer.subarray(0, bytesRead), end = actual.endsWith('.json') ? data.length : data.lastIndexOf(10) + 1;
      if (!end) return; // Keep incomplete lines for the next notification/fallback.
      for (const line of (actual.endsWith('.json') ? [data.subarray(0, end).toString('utf8')] : data.subarray(0, end).toString('utf8').split('\n').filter(Boolean))) {
        let raw: any;
        try { raw = JSON.parse(line); } catch { this.store.log('loop_event_rejected', { path: actual, reason: '不是完整有效 JSON' }); continue; }
        const roots = await Promise.all(this.c.projects.map(p => canonical(p.root)));
        if (raw.v !== 1 || typeof raw.id !== 'string' || typeof raw.project !== 'string' || !roots.includes(await canonical(raw.project)) || typeof raw.batch?.file !== 'string' || typeof raw.status !== 'string') {
          this.store.log('loop_event_rejected', { path: actual, reason: '格式不合法或不是授权项目' }); continue;
        }
        await this.files.registerEvidence(raw.project, raw.evidence ?? {});
        this.receive({ id: `loop:${raw.id}`, source: 'loop', who: 'loop', at: raw.at ?? new Date().toISOString(), text: raw.reason?.text ?? '', project: raw.project,
          batchFile: raw.batch.file, status: raw.status, evidence: raw.evidence, attachments: [], raw });
      }
      this.cursor(actual, signature, offset + end);
      // Large appends are consumed incrementally, without waiting for a new write.
      if (offset + end < info.size && bytesRead === buffer.length && !this.stopped) setImmediate(() => this.scan());
    } finally { await fd.close(); }
  }
  private cursor(path: string, signature: string, offset: number) { this.store.db.prepare('INSERT INTO sources VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET signature=excluded.signature,offset=excluded.offset').run(path, signature, offset); }
  async stop() { this.stopped = true; clearInterval(this.fallback); clearTimeout(this.debounce); for (const w of this.watchers) w.close(); await this.scanPromise; }
}
