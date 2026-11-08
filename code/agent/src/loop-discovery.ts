import { watch, type FSWatcher, type Dir } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Config, Project } from './types.js';
import type { Store } from './store.js';
import type { Files } from './files.js';
import { kernelIndexes, kernelSource, type KernelFacts } from './loop-kernel.js';
import { queryKernelSource } from './loop.js';
import { hash, inside, parseJson } from './util.js';
import { failure } from './errors.js';

export const DISCOVERY_FALLBACK_MS = 60_000;
export const DISCOVERY_WAKE_MS = 60;
const PAGE = 24;
interface IndexState { signature?: string; position: number; complete: boolean; checkedAt?: string }
interface SourceState { signature: string; revision: number; runId: string; historical: boolean; project?: string; ledger?: string }
interface OpenIndex { dir: Dir; position: number; skip: number; signature: string }
interface Job { kind: 'direct' | 'index' | 'known' | 'retry'; project?: string; path?: string; after?: number; upper?: number }
interface Round { scope: string; pending: Job[]; errors: Record<string, string> }
const signature = (s: { dev: number; ino: number; mtimeMs: number; size: number }) => `${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`;

/** Domain-specific fair sweeps: each slot gets one unit, then goes behind the
 * other projects/slots. Enumeration/signature cursors are not verified facts.
 * Only successful source verification + persistence advances the latter. */
export class LoopDiscovery {
  private handles = new Map<string, OpenIndex>();
  private visitedIndexes = new Set<string>();
  private watchers = new Map<string, FSWatcher>();
  private dirty = new Map<string, { project: Project; ledger: string }>();
  private round?: Round;
  private stopped = false;
  constructor(readonly c: Config, readonly store: Store, readonly files: Files,
    readonly adopt: (facts: KernelFacts) => unknown, readonly wake: () => void) {}
  private key(path: string) { return `discovery:ledger:${hash(path)}`; }
  private async source(project: Project, ledger: string) {
    const retryKey = `discovery:retry:${hash(ledger)}`;
    try {
      await this.files.protocolPath(project.root, ledger);
      const info = await lstat(ledger), sig = signature(info), previous = this.store.get<SourceState | null>(this.key(ledger), null);
      if (previous?.signature === sig) {
        // Add index metadata to older cursors without changing their verified position.
        if (previous.project !== project.id || previous.ledger !== ledger) this.store.set(this.key(ledger), { ...previous, project: project.id, ledger });
        this.store.set(retryKey, null); return;
      }
      const source = await kernelSource(this.c, this.files, project, ledger);
      if (previous?.runId === source.id && source.revision < previous.revision) throw new Error('来源修订倒退，保留已核实位置');
      const facts = source.historical ? undefined : await queryKernelSource(this.c, this.files, project, ledger);
      this.store.transaction(() => {
        if (facts) this.adopt(facts);
        this.store.set(this.key(ledger), { signature: sig, revision: facts?.revision ?? source.revision, runId: facts?.binding.runId ?? source.id, historical: source.historical, project: project.id, ledger } satisfies SourceState);
        this.store.set(retryKey, null);
      });
    } catch (error) { this.store.set(retryKey, { project: project.id, ledger, reason: failure(error).error, checkedAt: new Date().toISOString() }); }
  }
  private async watchIndex(project: Project, index: string) {
    if (!this.c.intake.watch || this.watchers.has(index)) return;
    let root = index;
    while (!await lstat(root).catch(() => undefined)) {
      const parent = dirname(root);
      if (parent === root || !project.loopRunDirs.some(grant => inside(grant, parent))) return;
      root = parent;
    }
    try {
      await this.files.protocolPath(project.root, root);
      const watcher = watch(root, { recursive: true }, (_event, name) => {
        if (this.stopped || !name) return;
        const path = join(root, String(name)), rel = relative(index, path);
        const ledger = /^[a-f0-9]{64}\/ledger\.json$/.test(rel) || rel === 'ledger.json';
        if (ledger) this.dirty.set(path, { project, ledger: path });
        if (ledger || /^[a-f0-9]{64}$/.test(rel) || inside(path, index)) this.wake();
      });
      watcher.on('error', () => { watcher.close(); this.watchers.delete(index); });
      this.watchers.set(index, watcher);
    } catch { /* The bounded signature sweep remains the fallback. */ }
  }
  private async startRound(scope: string) {
    const groups: Job[][] = [], errors: Record<string, string> = {};
    const upper = Number(this.store.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM kv WHERE key GLOB 'discovery:ledger:*'").get()!.n);
    for (const project of this.c.projects) {
      const jobs: Job[] = [];
      try {
        const { indexes, directLedgers, coverage } = await kernelIndexes(this.c, this.files, project);
        if (!coverage.ok) errors[project.id] = coverage.reason ?? '来源覆盖尚未核实';
        if (!indexes.length && !directLedgers.length) continue;
        // A known-source lane checks ledger signatures even when its ancestor
        // directory is unchanged. Ended/unregistered history is included too.
        jobs.push({ kind: 'known', project: project.id, after: 0, upper });
        for (const path of indexes) jobs.push({ kind: 'index', project: project.id, path });
        for (const path of directLedgers) jobs.push({ kind: 'direct', project: project.id, path });
      } catch (error) { errors[project.id] = failure(error).error; }
      groups.push(jobs);
    }
    const pending: Job[] = [];
    // Interleave projects instead of letting one project's directory count starve others.
    while (groups.some(group => group.length)) for (const group of groups) { const job = group.shift(); if (job) pending.push(job); }
    pending.push({ kind: 'retry' });
    this.round = { scope, pending, errors }; this.store.set('discovery:round', this.round);
  }
  private async indexUnit(project: Project, path: string) {
    await this.watchIndex(project, path); await this.files.protocolPath(project.root, path);
    const key = `discovery:index:${hash(path)}`, state = this.store.get<IndexState>(key, { position: 0, complete: false });
    const info = await lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return; throw e; });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('运行索引不是普通目录');
    const sig = signature(info);
    if (state.complete && state.signature === sig && this.visitedIndexes.has(path)) return false;
    let handle = this.handles.get(path);
    if (!handle) {
      handle = { dir: await opendir(path), position: 0, skip: !state.complete && state.signature === sig ? state.position : 0, signature: sig };
      this.handles.set(path, handle);
    }
    const entry = await handle.dir.read();
    if (entry) {
      handle.position++;
      if (handle.position > handle.skip) {
        if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) await this.source(project, join(path, entry.name, 'ledger.json'));
        this.store.set(key, { position: handle.position, signature: handle.signature, complete: false } satisfies IndexState);
      }
      return true;
    }
    await handle.dir.close(); this.handles.delete(path);
    const stable = handle.signature === signature(await lstat(path));
    this.store.set(key, { position: stable ? handle.position : 0, signature: stable ? handle.signature : undefined, complete: stable, checkedAt: new Date().toISOString() } satisfies IndexState);
    if (stable) this.visitedIndexes.add(path);
    return !stable;
  }
  private async unit(job: Job) {
    if (job.kind === 'retry') {
      const after = this.store.get('discovery:retry-position', 0);
      const query = (position: number) => this.store.db.prepare("SELECT rowid,value FROM kv WHERE key GLOB 'discovery:retry:*' AND value<>'null' AND rowid>? ORDER BY rowid LIMIT 1").get(position);
      const row = query(after) ?? query(0);
      if (row) {
        this.store.set('discovery:retry-position', Number(row.rowid));
        const value = parseJson<{ project: string; ledger: string }>(String(row.value)), project = this.c.projects.find(p => p.id === value.project);
        if (project && typeof value.ledger === 'string') await this.source(project, value.ledger);
      }
      return false;
    }
    const project = this.c.projects.find(p => p.id === job.project);
    if (!project) return false;
    if (job.kind === 'known') {
      const row = this.store.db.prepare("SELECT rowid,value FROM kv WHERE key GLOB 'discovery:ledger:*' AND rowid>? AND rowid<=? AND json_extract(value,'$.project')=? ORDER BY rowid LIMIT 1").get(job.after ?? 0, job.upper ?? 0, project.id);
      if (!row) return false;
      const value = parseJson<SourceState>(String(row.value));
      if (typeof value.ledger === 'string') await this.source(project, value.ledger);
      job.after = Number(row.rowid); return true;
    }
    if (!job.path) return false;
    if (job.kind === 'index') return this.indexUnit(project, job.path);
    await this.watchIndex(project, dirname(job.path)); await this.source(project, job.path); return false;
  }
  async scan(continuation = false) {
    if (this.stopped) return false;
    const scope = hash(JSON.stringify([this.c.projects, this.c.readAllow, this.c.readDeny]));
    if (!this.round) {
      const saved = this.store.get<Round | null>('discovery:round', null);
      if (saved?.scope === scope && saved.pending.length) this.round = saved;
    }
    if (this.round?.scope !== scope || !this.round?.pending.length && !continuation) await this.startRound(scope);
    let budget = PAGE;
    for (const [path, source] of this.dirty) {
      if (budget <= PAGE / 2) break;
      budget--; this.dirty.delete(path); await this.source(source.project, source.ledger);
    }
    while (budget-- > 0 && this.round?.pending.length && !this.stopped) {
      const job = this.round.pending.shift()!;
      try { if (await this.unit(job)) this.round.pending.push(job); }
      catch (error) {
        if (job.project) this.round.errors[job.project] = failure(error).error;
        if (job.path) { await this.handles.get(job.path)?.dir.close().catch(() => {}); this.handles.delete(job.path); }
      }
      this.store.set('discovery:round', this.round);
    }
    for (const project of this.c.projects) {
      const pending = this.round?.pending.some(job => job.project === project.id) ?? false;
      const retry = this.store.db.prepare("SELECT 1 FROM kv WHERE key GLOB 'discovery:retry:*' AND value<>'null' AND json_extract(value,'$.project')=? LIMIT 1").get(project.id);
      const reason = this.round?.errors[project.id] ?? (retry ? '有来源未核实，保留原事实并待补查' : pending ? '索引/签名分页核对中' : undefined);
      this.store.set(`discovery:coverage:${project.id}`, { ok: !reason, partial: !!reason, checkedAt: new Date().toISOString(), reason });
    }
    return !!this.round?.pending.length || this.dirty.size > 0;
  }
  async stop() {
    this.stopped = true;
    for (const watcher of this.watchers.values()) watcher.close();
    await Promise.all([...this.handles.values()].map(h => h.dir.close())); this.handles.clear();
  }
}
