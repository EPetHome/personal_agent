import { watch, type FSWatcher } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readBytes } from './file-policy.js';
import type { Config, Input } from './types.js';
import type { Store } from './store.js';
import type { Files } from './files.js';
import { canonical, hash } from './util.js';
import { LoopDiscovery, DISCOVERY_FALLBACK_MS, DISCOVERY_WAKE_MS } from './loop-discovery.js';
import type { KernelFacts } from './loop-kernel.js';
import { PiObservation } from './pi-observation.js';

export class Intake {
  private watchers: FSWatcher[] = [];
  private boundWatches = new Set<string>();
  private fallback?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private observationDebounce?: NodeJS.Timeout;
  private observationWork?: Promise<void>;
  private observationAgain = false;
  private stopped = false;
  private restoring = true;
  private boundCycleComplete = false;
  private scanPromise: Promise<void> = Promise.resolve();
  readonly discovery?: LoopDiscovery;
  readonly observations: PiObservation;
  constructor(readonly c: Config, readonly store: Store, readonly files: Files, readonly receive: (input: Input) => void, adopt?: (facts: KernelFacts) => unknown) {
    if (adopt) this.discovery = new LoopDiscovery(c, store, files, adopt, () => this.wake());
    this.observations = new PiObservation(c, store, files, receive, () => this.wakeObservation());
  }
  private wake() {
    // Do not reset this timer on every write: a busy producer cannot starve verification.
    if (!this.debounce && !this.stopped) this.debounce = setTimeout(() => { this.debounce = undefined; void this.scan(); }, DISCOVERY_WAKE_MS);
  }
  private wakeObservation() {
    if (!this.observationDebounce && !this.stopped) this.observationDebounce = setTimeout(() => { this.observationDebounce = undefined; void this.scanObservations(); }, DISCOVERY_WAKE_MS);
  }
  private scanObservations(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.observationWork) { this.observationAgain = true; return this.observationWork; }
    const work = (async () => {
      do {
        this.observationAgain = false;
        let more = await this.observations.scan(false);
        while (more && !this.stopped) { await new Promise<void>(resolve => setImmediate(resolve)); more = await this.observations.scan(true); }
      } while (this.observationAgain && !this.stopped);
    })().catch(() => { if (!this.stopped) this.store.log('pi_observation_failure', { outcome: '观察源暂未核实；保留最后可靠事实，等待有界补查' }); });
    this.observationWork = work;
    void work.finally(() => { this.observationWork = undefined; if (this.observationAgain && !this.stopped) void this.scanObservations(); });
    return work;
  }
  async start() {
    const roots = [...this.c.inboxDirs, ...this.c.loop.eventDirs];
    if (this.c.intake.watch) for (const root of roots) {
      try {
        const watcher = watch(root, { recursive: true }, () => this.wake());
        watcher.on('error', () => { this.store.log('intake_watch_failure', { path: root, outcome: '文件通知失效，继续低频兜底' }); });
        this.watchers.push(watcher);
      } catch { this.store.log('intake_watch_failure', { path: root, outcome: '文件通知不可用，继续低频兜底' }); }
    }
    this.fallback = setInterval(() => this.scan(), Math.min(DISCOVERY_FALLBACK_MS, this.c.intake.fallbackMs));
    await this.scan();
  }
  scan(continuation = false) {
    // Independent lane: a slow/failed Loop query must not hold a healthy Pi notification.
    const observations = this.scanObservations();
    this.scanPromise = this.scanPromise.then(async () => {
      if (this.stopped) return;
      if (!continuation) this.boundCycleComplete = false;
      for (const root of this.c.inboxDirs) await this.walk(root, false);
      for (const root of this.c.loop.eventDirs) await this.walk(root, true);
      const more = await this.discovery?.scan(continuation);
      const boundMore = this.boundCycleComplete ? false : await this.boundLoops();
      if (!boundMore) this.boundCycleComplete = true;
      if ((more || boundMore) && !this.stopped) setImmediate(() => this.scan(true));
    }).catch(() => { if (!this.stopped) this.store.log('intake_failure', { outcome: '来源暂不可读；保留游标，下次兜底再收' }); });
    return Promise.all([this.scanPromise, observations]).then(() => {});
  }
  /** Bound revisions share the existing durable verification queue. Discovery
   * above handles only authorized new identities, never global session bodies. */
  private async boundLoops() {
    const page = this.store.boundLoopPage(this.store.get<{ after: number; upper?: number }>('kernel:scan-position', { after: 0 })), emitted = new Set<string>();
    for (const card of page.cards) {
      const binding = card.worker!.loop!, project = this.c.projects.find(p => p.id === card.worker!.project || p.root === card.worker!.project);
      if (!project) continue;
      try {
        const check = () => this.files.protocolPath(project.root, binding.ledger);
        await check();
        if (this.c.intake.watch && !this.boundWatches.has(binding.ledger)) {
          const watcher = watch(dirname(binding.ledger), (_kind, file) => {
            if (file === 'ledger.json') this.wake();
          });
          watcher.on('error', () => { this.boundWatches.delete(binding.ledger); watcher.close(); });
          this.boundWatches.add(binding.ledger); this.watchers.push(watcher);
        }
        const info = await lstat(binding.ledger), signature = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
        const key = `kernel-source:${hash(JSON.stringify([binding.repository, binding.runId, binding.ledger]))}`, previous = this.store.get<string | { signature: string; revision: number; historical?: boolean }>(key, '');
        let revision: number, historical: boolean;
        if (typeof previous === 'object' && previous.signature === signature && typeof previous.historical === 'boolean') { revision = previous.revision; historical = previous.historical; }
        else {
          const { data } = await readBytes(binding.ledger, check, this.c.intake.maxFileBytes);
          const raw = JSON.parse(data.toString('utf8'));
          if (raw.id !== binding.runId || raw.common !== binding.repository || raw.file !== binding.cardFile || !Number.isSafeInteger(raw.revision)) throw new Error('原运行记录身份不符');
          revision = raw.revision;
          historical = !!raw.abandoned || raw.publication?.local === 'merged' && !raw.activity && !(raw.taskRecords ?? []).some((t: { activity?: unknown }) => t.activity);
          this.store.set(key, { signature, revision, historical }); // Observed cursor only; card.sourceRevision is the verified cursor.
        }
        if (revision <= (card.sourceRevision ?? -1)) continue;
        const source = JSON.stringify([binding.repository, binding.runId, binding.cardFile, binding.ledger, revision]);
        if (emitted.has(source)) continue;
        const pending = this.store.pendingLoopInput(binding, revision);
        if (pending && ['pending', 'processing'].includes(pending.state)) { emitted.add(source); continue; }
        const inputId = pending?.id ?? `kernel:${hash(JSON.stringify([binding, revision]))}`;
        if (this.restoring && historical) this.store.set(`kernel:quiet-recovery:${inputId}`, true);
        this.receive(pending?.input ?? { id: inputId, source: 'loop', who: 'loop', at: new Date().toISOString(), text: '已绑定 Loop 原执行的记录修订变化，请沿原身份核实。', project: project.root, batchFile: binding.cardFile, workerId: card.id, status: 'revision', attachments: [], raw: { kernel: 1, runId: binding.runId, revision, ledger: binding.ledger } });
        emitted.add(source);
      } catch {
        // Freshness metadata only; do not turn an unreadable/half-written source
        // into a lifecycle event, failed task or notification.
        const current = this.store.task(card.id);
        if (current) { current.sourceHealth = { ok: false, checkedAt: new Date().toISOString(), reason: '来源记录当前不可读或未通过权限核对；保留最后确认事实，待补查' }; this.store.putTask(current); }
      }
    }
    this.store.set('kernel:scan-position', page.cursor);
    if (!page.hasMore) this.restoring = false;
    return page.hasMore;
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
  async stop() { this.stopped = true; clearInterval(this.fallback); clearTimeout(this.debounce); clearTimeout(this.observationDebounce); await Promise.all([this.scanPromise, this.observationWork]); for (const w of this.watchers) w.close(); await this.discovery?.stop(); await this.observations.stop(); }
}
