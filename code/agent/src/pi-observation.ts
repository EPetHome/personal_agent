import { watch, type FSWatcher, type Dir } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Config, Input, Material, ObservationSource, TaskCard, WorkExecution } from './types.js';
import type { Store } from './store.js';
import type { Files } from './files.js';
import { noLinkedParents, nameDenied, readBytes } from './file-policy.js';
import { Attention } from './attention.js';
import { executionKey, recordExecution, workRecord } from './work-tracking.js';
import { canonical, hash, inside, parseJson } from './util.js';
import { SafeError } from './errors.js';

export const OBSERVATION_LEASE_MS = 90_000;
export const OBSERVATION_MAX_BYTES = 64 * 1024;
export interface PiObservationRecord {
  version: 1; kind: 'session' | 'execution'; sourceId: string; sessionId: string; instanceId: string; executionId: string | null;
  revision: number; observedAt: string; heartbeatAt: string; cwd: string;
  state: 'idle' | 'running' | 'waiting' | 'settled' | 'closed' | 'unknown'; outcome?: 'completed' | 'aborted' | 'error';
  subject?: { title: string; goal: string }; result?: { summary: string; refs: { path: string; sha256: string }[] };
}
export interface ObservationSnapshot { record: PiObservationRecord; path: string; fingerprint: string; grant: string; receivedAt: string; lastVerifiedAt: string; taskId?: string; ok: boolean; reason?: string }
interface ObservationNotice { observed: string; handled?: string; generation: number; pending?: { inputId: string; semantic: string } }
const prefix = 'pi-observation:record:';
const recordKey = (r: PiObservationRecord) => hash(JSON.stringify([r.kind, r.sourceId, r.sessionId, r.instanceId, r.executionId]));
export const observationGrant = (s: ObservationSource) => hash(JSON.stringify(s));
const keysOnly = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const timestamp = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
export class PiObservation {
  private watchers = new Map<string, FSWatcher>();
  private directories = new Map<string, Dir>();
  private dirty = new Set<string>();
  private quietSources = new Set<string>();
  private stopped = false;
  private restoring = true;
  readonly attention: Attention;
  constructor(readonly c: Config, readonly store: Store, readonly files: Files, readonly receive?: (input: Input) => void, readonly wake: () => void = () => {}) { this.attention = new Attention(c, store); }
  source(id: string) {
    const source = this.c.piObservation?.sources.find(s => s.id === id && s.enabled);
    if (!source || source.project && !this.c.projects.some(p => p.id === source.project)
      || this.c.readDeny.some(p => inside(p, source.exportRoot) || source.cwds.some(cwd => inside(p, cwd))) || this.c.readAllow.length && !this.c.readAllow.some(p => inside(p, source.exportRoot))) throw new SafeError('outside_scope', 'Pi 观察来源未获准或已撤销；不读取、不披露缓存');
    return source;
  }
  private async root(source: ObservationSource) {
    if (observationGrant(this.source(source.id)) !== observationGrant(source)) throw new SafeError('outside_scope', '观察授权已变');
    const root = source.exportRoot, c = this.c;
    await noLinkedParents(root);
    const info = await lstat(root);
    const denied = [c.dataDir, c.attachmentDir, c.configPath, c.model.auth.path, c.feishu.envFile, ...c.readDeny].filter(Boolean);
    if (await canonical(root) !== root || !info.isDirectory() || info.uid !== source.ownerUid || nameDenied(root)
      || denied.some(p => inside(p, root)) || c.readAllow.length && !c.readAllow.some(p => inside(p, root))) throw new SafeError('outside_scope', 'Pi 导出根身份/所有者/读取范围无效');
    return root;
  }
  private async path(source: ObservationSource, path: string) {
    const root = await this.root(source);
    if (this.c.readDeny.some(p => inside(p, path)) || dirname(path) !== root || !/^(?:session|execution)-[a-f0-9]{64}\.json$/.test(basename(path)) || await canonical(path) !== path) throw new SafeError('outside_scope', '不是批准根内规定的普通观察记录');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== source.ownerUid) throw new SafeError('outside_scope', '观察记录的文件或所有者身份无效');
    return path;
  }
  private async validate(raw: unknown, source: ObservationSource, file: string): Promise<PiObservationRecord> {
    if (!keysOnly(raw, ['version', 'kind', 'sourceId', 'sessionId', 'instanceId', 'executionId', 'revision', 'observedAt', 'heartbeatAt', 'cwd', 'state', 'outcome', 'subject', 'result'])
      || raw.version !== 1 || !['session', 'execution'].includes(String(raw.kind)) || raw.sourceId !== source.id
      || !['sessionId', 'instanceId'].every(k => text(raw[k], 256) && raw[k] !== '') || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
      || !timestamp(raw.observedAt) || !timestamp(raw.heartbeatAt) || Date.parse(String(raw.observedAt)) > Date.now() + 30_000 || Date.parse(String(raw.heartbeatAt)) > Date.now() + 30_000
      || !['idle', 'running', 'waiting', 'settled', 'closed', 'unknown'].includes(String(raw.state))
      || raw.outcome !== undefined && !['completed', 'aborted', 'error'].includes(String(raw.outcome))
      || raw.kind === 'session' && raw.executionId !== null || raw.kind === 'execution' && (!text(raw.executionId, 256) || !raw.executionId)
      || !file.startsWith(`${raw.kind}-`) || typeof raw.cwd !== 'string' || resolve(raw.cwd) !== raw.cwd || !source.cwds.includes(raw.cwd) || await canonical(raw.cwd) !== raw.cwd
      || this.c.readDeny.some(p => inside(p, String(raw.cwd))) || nameDenied(raw.cwd)) throw new SafeError('invalid_observation', '观察记录协议、版本、身份或 cwd 未核实');
    if (raw.subject !== undefined && (!source.allowSubject || !keysOnly(raw.subject, ['title', 'goal']) || !text(raw.subject.title, 500) || !text(raw.subject.goal, 8000))) throw new SafeError('outside_scope', '来源未获准导出这些任务文字');
    if (raw.result !== undefined) {
      if (!source.allowResult || !keysOnly(raw.result, ['summary', 'refs']) || !text(raw.result.summary, 8000) || !Array.isArray(raw.result.refs) || raw.result.refs.length > 20) throw new SafeError('outside_scope', '来源未获准导出这些结果字段');
      for (const ref of raw.result.refs) {
        if (!keysOnly(ref, ['path', 'sha256']) || typeof ref.path !== 'string' || !/^[a-f0-9]{64}$/.test(String(ref.sha256))) throw new SafeError('invalid_observation', '结果引用格式无效');
        await this.files.check(ref.path, true); // A reported path is not a grant. Contents stay demand-only.
      }
    }
    return raw as unknown as PiObservationRecord;
  }
  snapshot(key: string) { return this.store.get<ObservationSnapshot | null>(prefix + key, null); }
  private known(sourceId: string, allHealthy = false) {
    return this.store.db.prepare(`SELECT key,value FROM kv WHERE key GLOB 'pi-observation:record:*' AND json_extract(value,'$.record.sourceId')=? AND json_extract(value,'$.ok')=1 ${allHealthy ? '' : "AND julianday(json_extract(value,'$.record.heartbeatAt'))<=julianday(?)"} ORDER BY key LIMIT 24`).all(sourceId, ...(allHealthy ? [] : [new Date(Date.now() - OBSERVATION_LEASE_MS).toISOString()])).map(row => ({ key: String(row.key).slice(prefix.length), snapshot: parseJson<ObservationSnapshot>(String(row.value)) }));
  }
  private counts(sourceId: string) {
    const row = this.store.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN json_extract(value,'$.ok')<>1 OR julianday(json_extract(value,'$.record.heartbeatAt'))<=julianday(?) THEN 1 ELSE 0 END) AS unhealthy FROM kv WHERE key GLOB 'pi-observation:record:*' AND json_extract(value,'$.record.sourceId')=?").get(new Date(Date.now() - OBSERVATION_LEASE_MS).toISOString(), sourceId)!;
    return { total: Number(row.total), unhealthy: Number(row.unhealthy ?? 0) };
  }
  private health(snapshot: ObservationSnapshot) {
    return snapshot.ok && Date.now() - Date.parse(snapshot.record.heartbeatAt) < OBSERVATION_LEASE_MS;
  }
  async authorize(card: TaskCard) {
    const refs = (card.work?.executions ?? []).filter(e => e.kind === 'pi-observation');
    const ids = new Set([...refs.map(e => e.sourceId), ...(card.observation ? [card.observation.sourceId] : [])]);
    for (const id of ids) {
      const source = this.source(id), grant = observationGrant(source), access = hash(JSON.stringify([this.c.projects, this.c.readAllow, this.c.readDeny]));
      const paths = [...refs.filter(e => e.sourceId === id).flatMap(e => e.recordPath ? [e.recordPath] : []), ...(card.observation?.sourceId === id ? [this.snapshot(card.observation.recordKey)?.path ?? ''] : [])];
      if (paths.some(path => path && this.c.readDeny.some(p => inside(p, path)))) throw new SafeError('outside_scope', '原观察记录当前已被拒读，旧正文也不披露');
      try { await this.root(source); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (card.observation?.sourceId === id && this.snapshot(card.observation.recordKey)?.grant !== observationGrant(source)) throw new SafeError('outside_scope', '观察字段授权已变；旧缓存不可披露');
      if (refs.some(e => e.sourceId === id && e.grant !== observationGrant(source))) throw new SafeError('outside_scope', '原执行内容授权已变；历史关联不扩大披露');
      if (refs.some(e => e.sourceId === id && e.result) && !source.allowResult || card.observation && !this.snapshot(card.observation.recordKey)) throw new SafeError('outside_scope', '原观察内容授权已变');
      for (const ref of refs.filter(e => e.sourceId === id).flatMap(e => e.result?.refs ?? [])) await this.files.check(ref.path, true);
      if (observationGrant(this.source(id)) !== grant || hash(JSON.stringify([this.c.projects, this.c.readAllow, this.c.readDeny])) !== access) throw new SafeError('outside_scope', '披露前观察授权已变化，未发送旧正文');
    }
  }
  private semantic(snapshot: ObservationSnapshot) { return hash(JSON.stringify([snapshot.record.state, snapshot.record.outcome, snapshot.record.subject, snapshot.record.result, snapshot.ok])); }
  private noticeState(key: string): ObservationNotice {
    const value = this.store.get<ObservationNotice | string>(`pi-observation:notice:${key}`, '');
    if (typeof value !== 'string') return value;
    // Preserve already queued v1 notifications when upgrading the private marker.
    const queued = this.store.db.prepare("SELECT id FROM inputs WHERE state IN ('pending','processing','waiting') AND json_extract(body,'$.raw.observation')=1 AND json_extract(body,'$.raw.recordKey')=? ORDER BY seq LIMIT 1").get(key);
    return { observed: value, handled: value || undefined, generation: 0, ...(queued ? { pending: { inputId: String(queued.id), semantic: value } } : {}) };
  }
  private notice(snapshot: ObservationSnapshot, key: string, quiet: boolean) {
    const card = snapshot.taskId ? this.store.task(snapshot.taskId) : undefined;
    if (card && card.observation?.recordKey !== key) return;
    const identity = this.semantic(snapshot), marker = `pi-observation:notice:${key}`, state = this.noticeState(key);
    state.observed = identity;
    if (state.pending) {
      const row = this.store.row(state.pending.inputId);
      if (row && ['pending', 'processing', 'waiting'].includes(row.state)) { this.store.set(marker, state); return; }
      // A failed Router is not silently replayed. Its original input and the
      // unreported one-shot remain available for explicit recovery/query.
      state.handled = state.pending.semantic; delete state.pending;
    }
    const important = !snapshot.ok || ['waiting', 'settled', 'closed'].includes(snapshot.record.state);
    const changes = card?.work?.attentionIds?.some(id => this.attention.rules().some(r => r.id === id && r.state === 'active' && r.notify === 'changes'));
    if (quiet || !card || !important && !changes || !this.attention.mayNotify(card, important)) { state.handled = identity; this.store.set(marker, state); return; }
    if (state.handled === identity) { this.store.set(marker, state); return; }
    const input: Input = { id: `pi-observation:${key}:notice:${++state.generation}`, source: 'pi', who: 'pi-observation', at: new Date().toISOString(), text: '获准独立 Pi 的运行观察有变化；沿原引用核实最新版本，运行停稳不是业务交付。', workerId: card.id, status: 'observation', attachments: [], raw: { observation: 1, recordKey: key, sourceId: snapshot.record.sourceId, revision: snapshot.record.revision } };
    state.pending = { inputId: input.id, semantic: identity };
    this.store.enqueue(input); this.store.set(marker, state);
  }
  acknowledge(input: Input, suppressed = false) {
    const raw = input.raw as { observation?: number; recordKey?: string; sourceId?: string } | undefined;
    if (raw?.observation !== 1 || !raw.recordKey) return;
    const state = this.noticeState(raw.recordKey); if (state.pending?.inputId !== input.id) return;
    state.handled = suppressed ? state.observed : this.store.get(`pi-observation:consumed-notice:${input.id}`, state.pending.semantic);
    delete state.pending; this.store.set(`pi-observation:notice:${raw.recordKey}`, state);
    if (suppressed) return;
    try { this.source(raw.sourceId!); } catch { return; }
    const current = this.snapshot(raw.recordKey);
    if (current) this.store.transaction(() => this.notice(current, raw.recordKey!, false));
  }
  async read(source: ObservationSource, path: string, quiet = false) {
    const { data } = await readBytes(path, () => this.path(source, path), Math.min(this.c.intake.maxFileBytes, OBSERVATION_MAX_BYTES));
    const record = await this.validate(parseJson(new TextDecoder('utf-8', { fatal: true }).decode(data)), source, basename(path));
    await this.path(source, path);
    const key = recordKey(record), fingerprint = hash(data), previous = this.snapshot(key), now = new Date().toISOString();
    if (previous && previous.record.revision > record.revision) return previous;
    if (previous && record.revision > previous.record.revision && (Date.parse(record.observedAt) < Date.parse(previous.record.observedAt) || Date.parse(record.heartbeatAt) < Date.parse(previous.record.heartbeatAt))) throw new SafeError('invalid_observation', '同实例来源时间倒退，保留最后可靠事实');
    if (previous?.record.revision === record.revision && previous.fingerprint !== fingerprint) throw new SafeError('invalid_observation', '同一来源版本内容冲突，保留最后可靠事实');
    const admit = this.attention.admission('pi-observation', source.id, record.observedAt);
    if (!previous && record.kind === 'execution' && !admit.accept) return undefined;
    const snapshot: ObservationSnapshot = { record, path, fingerprint, grant: observationGrant(source), receivedAt: previous?.receivedAt ?? now, lastVerifiedAt: now, ok: Date.now() - Date.parse(record.heartbeatAt) < OBSERVATION_LEASE_MS, taskId: previous?.taskId };
    if (!snapshot.ok) { snapshot.reason = '导出租约连续三个 30 秒间隔未刷新，来源未核实；不代表业务失败'; snapshot.lastVerifiedAt = previous?.lastVerifiedAt ?? record.observedAt; }
    const result = this.store.transaction(() => {
      const indexed = record.kind === 'execution' ? executionKey({ kind: 'pi-observation', sourceId: record.sourceId, sessionId: record.sessionId, instanceId: record.instanceId, executionId: record.executionId! }) : '';
      const linked = indexed ? this.store.get<string | null>(`work:execution:${indexed}`, null) : null;
      let card = linked ? this.store.task(linked) : snapshot.taskId ? this.store.task(snapshot.taskId) : undefined;
      if (record.kind === 'execution' && (card || admit.accept && snapshot.ok)) {
        if (!card) {
          card = { id: `pi-observed-${indexed.slice(0, 24)}`, title: record.subject?.title || 'Pi 运行观察（业务目标未知）', goal: record.subject?.goal || '', completion: '仅运行观察；原目标/交付与业务验收另行核实', boundary: '只读观察，不停止、送话、续跑或重派独立 Pi', status: 'observing', waiting: '', dispatches: [], conclusion: '', subscriptions: [], updated: now,
            observation: { sourceId: source.id, recordKey: key }, work: { ownership: { kind: source.project ? 'project' : 'unassigned', ...(source.project ? { id: source.project } : {}), resources: source.project ? [source.project] : [] }, executions: [], attentionIds: admit.ids }, control: '只读观察；没有任何独立 Pi 控制权限' };
          this.store.putTask(card);
        }
        snapshot.taskId = card.id;
        if (!['closed', 'cancelled', 'reconciled'].includes(card.status)) {
          const previousResult = card.work?.executions.find(e => e.key === indexed)?.result;
          const goal = card.observation?.definition === 'owner' ? card.goal : record.subject?.goal;
          const contentVersion = hash(JSON.stringify([record.subject, record.result, goal]));
          const keptVerification = previousResult?.verified && previousResult.contentVersion === contentVersion && ['settled', 'closed'].includes(record.state) && record.outcome !== 'error' && record.outcome !== 'aborted';
          const ref: WorkExecution = { key: indexed, recordPath: path, grant: observationGrant(source), kind: 'pi-observation', sourceId: record.sourceId, sessionId: record.sessionId, instanceId: record.instanceId, executionId: record.executionId!, revision: record.revision, origin: 'owner', state: record.state, observedAt: record.observedAt, receivedAt: snapshot.receivedAt, verifiedAt: snapshot.lastVerifiedAt,
            ...(record.result ? { result: { summary: keptVerification ? previousResult.summary : record.result.summary, refs: record.result.refs, verified: !!keptVerification, contentVersion, ...(keptVerification ? { verifiedBy: previousResult.verifiedBy } : {}) } } : {}) };
          card = recordExecution(this.store, card.id, ref);
          if (card.work?.currentExecution === indexed) {
            card.observation = { sourceId: source.id, recordKey: key, definition: card.observation?.definition ?? 'source' };
            if (card.observation.definition !== 'owner') { card.title = record.subject?.title || 'Pi 运行观察（业务目标未知）'; card.goal = record.subject?.goal || ''; }
            if (card.status === 'delivered' && !keptVerification) card.status = 'observing';
            card.sourceHealth = { ok: snapshot.ok, checkedAt: now, reason: snapshot.reason };
            card.lastVerifiedAt = snapshot.lastVerifiedAt; card.sourceRevision = record.revision; card.sourceFingerprint = fingerprint;
            card.sourceCurrent = { worker: 'pi-observation', state: record.state, active: record.state === 'running', checkedAt: snapshot.lastVerifiedAt };
            card.updated = now; this.store.putTask(card);
          }
        }
      }
      this.store.set(prefix + key, snapshot);
      this.notice(snapshot, key, quiet);
      // Consumed bytes, fact update and event admission are one SQLite commit.
      this.store.set(`pi-observation:consumed:${hash(path)}`, { key, revision: record.revision, fingerprint });
      return snapshot;
    });
    if (this.receive) for (const row of this.store.db.prepare("SELECT body FROM inputs WHERE state='pending' AND json_extract(body,'$.raw.observation')=1 AND json_extract(body,'$.raw.recordKey')=?").all(key)) this.receive(parseJson<Input>(String(row.body)));
    return result;
  }
  private async watchSource(source: ObservationSource) {
    if (!this.c.intake.watch || this.watchers.has(source.id)) return;
    await this.root(source);
    const watcher = watch(source.exportRoot, (_kind, file) => {
      if (file && /^(?:session|execution)-[a-f0-9]{64}\.json$/.test(String(file))) { this.dirty.add(source.id); this.wake(); }
    });
    watcher.on('error', () => { watcher.close(); this.watchers.delete(source.id); }); this.watchers.set(source.id, watcher);
  }
  async scan(continuation = false) {
    if (this.stopped) return false;
    let more = false;
    const registered = this.c.piObservation?.sources ?? [];
    const oldRoots = this.store.get<string[]>('pi-observation:private-roots', []), privateRoots = [...new Set([...oldRoots, ...registered.map(s => s.exportRoot)])];
    if (JSON.stringify(oldRoots) !== JSON.stringify(privateRoots)) this.store.set('pi-observation:private-roots', privateRoots);
    const previous = this.store.get<Record<string, { enabled: boolean; grant: string; intervals: { from: string; to: string | null }[] }>>('pi-observation:enabled', {});
    for (const id of new Set([...Object.keys(previous), ...registered.map(s => s.id)])) {
      const source = registered.find(s => s.id === id), enabled = !!source?.enabled, grant = source ? observationGrant(source) : '', old = previous[id];
      if (old?.enabled === enabled && old.grant === grant) continue;
      const now = new Date().toISOString(), intervals = old?.intervals ?? [];
      if (intervals.at(-1)?.to === null) intervals[intervals.length - 1]!.to = now;
      if (enabled) { intervals.push({ from: now, to: null }); this.quietSources.add(id); }
      previous[id] = { enabled, grant, intervals };
    }
    this.store.set('pi-observation:enabled', previous);
    const enabled = new Set(this.c.piObservation?.sources.filter(s => s.enabled).map(s => s.id));
    for (const [id, watcher] of this.watchers) if (!enabled.has(id)) { watcher.close(); this.watchers.delete(id); }
    for (const [id, dir] of this.directories) if (!enabled.has(id)) { await dir.close().catch(() => {}); this.directories.delete(id); }
    for (const source of this.c.piObservation?.sources ?? []) {
      if (!source.enabled) continue; // Do not even stat a revoked root.
      const coverageKey = `pi-observation:coverage:${source.id}`;
      const errors: string[] = continuation ? this.store.get<{ errors: string[] }>(coverageKey, { errors: [] }).errors : [];
      try {
        await this.root(source); await this.watchSource(source);
        let dir = this.directories.get(source.id);
        const quiet = this.restoring || this.quietSources.has(source.id);
        if (!dir && (!continuation || this.dirty.has(source.id))) { dir = await opendir(source.exportRoot); this.directories.set(source.id, dir); this.dirty.delete(source.id); }
        let complete = !dir;
        for (let n = 0; dir && n < 24; n++) {
          const entry = await dir.read();
          if (!entry) { complete = true; break; }
          if (!/^(?:session|execution)-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
          try { await this.read(source, join(source.exportRoot, entry.name), quiet); }
          catch { errors.push('存在未核实记录（格式/权限/文件或版本异常），保留最后可靠事实'); }
        }
        if (complete) { await dir?.close(); this.directories.delete(source.id); this.quietSources.delete(source.id); } else more = true;
        for (const { key, snapshot } of this.known(source.id, !!errors.length)) if ((!this.health(snapshot) || errors.length) && snapshot.ok) {
          snapshot.ok = false; snapshot.reason = errors.length ? errors[0] : '导出租约连续三个 30 秒间隔未刷新，来源未核实；不代表业务失败';
          this.store.transaction(() => {
            this.store.set(prefix + key, snapshot);
            const card = snapshot.taskId ? this.store.task(snapshot.taskId) : undefined;
            if (card?.observation?.recordKey === key) { card.sourceHealth = { ok: false, checkedAt: new Date().toISOString(), reason: snapshot.reason }; this.store.putTask(card); }
            this.notice(snapshot, key, quiet);
          });
        }
        if (this.known(source.id, !!errors.length).length) more = true;
        const counts = this.counts(source.id), ok = complete && !errors.length && counts.total > 0 && counts.unhealthy === 0;
        this.store.set(coverageKey, { ok, partial: !ok, checkedAt: new Date().toISOString(), errors: errors.slice(0, 5), note: counts.total ? '仅当前快照；租约和运行状态不证明业务交付' : '尚无可核实运行租约，来源未接通；不能推断没有工作' });
      } catch {
        this.store.set(coverageKey, { ok: false, partial: true, checkedAt: new Date().toISOString(), errors: ['来源根当前未核实，保留最后可靠事实'] });
        await this.directories.get(source.id)?.close().catch(() => {}); this.directories.delete(source.id);
        for (const { key, snapshot } of this.known(source.id, true)) { snapshot.ok = false; snapshot.reason = '来源根当前未核实'; this.store.set(prefix + key, snapshot); const card = snapshot.taskId ? this.store.task(snapshot.taskId) : undefined; if (card?.observation?.recordKey === key) { card.sourceHealth = { ok: false, checkedAt: new Date().toISOString(), reason: snapshot.reason }; this.store.putTask(card); } }
        if (this.known(source.id, true).length) more = true;
      }
    }
    if (!more) this.restoring = false;
    if (this.receive) for (const row of this.store.db.prepare("SELECT body FROM inputs WHERE state='pending' AND json_extract(body,'$.raw.observation')=1").all()) this.receive(parseJson<Input>(String(row.body)));
    return more || !!this.dirty.size;
  }
  async verifyResult(id: string, assessment: string, materials: Material[], input: Input) {
    const card = this.store.task(id); if (!card?.observation || !assessment.trim() || assessment.length > 8000) throw new SafeError('invalid_arguments', '须选择原观察事项并提供对照原目标的判断');
    await this.authorize(card);
    const snapshot = this.snapshot(card.observation.recordKey), record = snapshot?.record;
    if (!snapshot || !record || !this.health(snapshot) || !(card.goal || record.subject?.goal) || !record.result?.refs.length || !['settled', 'closed'].includes(record.state) || record.outcome === 'error' || record.outcome === 'aborted') throw new SafeError('unverified_delivery', '缺少目标、获准结果及材料依据，或来源当前未核实；停稳本身不证明交付');
    for (const ref of record.result.refs) {
      if (!materials.some(m => m.path === ref.path && m.sha256 === ref.sha256)) throw new SafeError('missing_evidence', '须本轮实际读取原结果材料，不能用来源自述或模型填写的 hash 冒充核对');
      const { data } = await readBytes(ref.path, () => this.files.check(ref.path, true), this.c.intake.maxFileBytes);
      if (hash(data) !== ref.sha256) throw new SafeError('file_changed', '结果材料版本已变，未核实交付');
    }
    await this.authorize(card);
    return this.store.transaction(() => {
      const current = this.store.task(id)!;
      if (['cancelled', 'closed', 'reconciled'].includes(current.status) || current.sourceRevision !== record.revision || this.snapshot(card.observation!.recordKey)?.fingerprint !== snapshot.fingerprint) throw new SafeError('stale_fact', '核对期间原事项/版本已变，未写入交付判断');
      const work = workRecord(current), execution = work.executions.find(e => e.key === work.currentExecution);
      if (!execution || execution.kind !== 'pi-observation' || execution.sourceId !== record.sourceId) throw new SafeError('identity_mismatch', '不是原当前观察执行');
      execution.result = { summary: assessment, refs: record.result!.refs, verified: true, contentVersion: hash(JSON.stringify([record.subject, record.result, current.observation?.definition === 'owner' ? current.goal : record.subject?.goal])), verifiedBy: input.id };
      current.work = work; current.status = 'delivered'; current.conclusion = assessment; this.store.putTask(current);
      return { ok: true, card: current, receipt: '已核对原结果材料版本并记录模型对照原目标的判断；不是源自述自动完成，不代表业务验收通过。' };
    });
  }
  current(card: TaskCard) { const snapshot = card.observation ? this.snapshot(card.observation.recordKey) : undefined; return !!snapshot && this.health(snapshot); }
  async view(card: TaskCard) {
    await this.authorize(card);
    let snapshot = card.observation ? this.snapshot(card.observation.recordKey) : undefined;
    if (!snapshot) return { ok: false, reason: '原观察记录未核实' };
    try { snapshot = await this.read(this.source(snapshot.record.sourceId), snapshot.path, true) ?? snapshot; }
    catch {
      snapshot = { ...snapshot, ok: false, reason: '原观察文件当前未核实；保留最后可靠事实及时间' };
      this.store.set(prefix + card.observation!.recordKey, snapshot);
      const current = this.store.task(card.id)!; current.sourceHealth = { ok: false, checkedAt: new Date().toISOString(), reason: snapshot.reason }; this.store.putTask(current);
    }
    return { ok: this.health(snapshot), state: this.health(snapshot) ? snapshot.record.state : 'unknown', lastKnownState: snapshot.record.state, observedAt: snapshot.record.observedAt, heartbeatAt: snapshot.record.heartbeatAt, lastVerifiedAt: snapshot.lastVerifiedAt, revision: snapshot.record.revision, reason: snapshot.reason, subject: snapshot.record.subject, result: snapshot.record.result ? { ...snapshot.record.result, verification: '来源报告，交付未核实' } : null, businessAcceptance: '未验证', control: '只读观察' };
  }
  async page(offset = 0, limit = 10) {
    offset = Math.max(0, Math.floor(offset)); limit = Math.min(50, Math.max(1, Math.floor(limit)));
    const configured = this.c.piObservation?.sources.filter(s => s.enabled) ?? [], sources: ObservationSource[] = [];
    for (const source of configured.slice(0, 50)) { try { await this.root(source); sources.push(source); } catch { /* Do not count inaccessible sources. */ } }
    const where = sources.map(() => "(json_extract(value,'$.record.sourceId')=? AND json_extract(value,'$.grant')=?)").join(' OR ') || '0', params = sources.flatMap(s => [s.id, observationGrant(s)]);
    const base = `key GLOB 'pi-observation:record:*' AND (${where}) AND NOT EXISTS (SELECT 1 FROM json_each(?) d WHERE json_extract(kv.value,'$.path')=d.value OR substr(json_extract(kv.value,'$.path'),1,length(d.value)+1)=d.value||'/')`;
    params.push(JSON.stringify(this.c.readDeny));
    const total = Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM kv WHERE ${base}`).get(...params)!.n);
    const rows = this.store.db.prepare(`SELECT key,value FROM kv WHERE ${base} ORDER BY key LIMIT ? OFFSET ?`).all(...params, limit, offset).map(row => {
      const snapshot = parseJson<ObservationSnapshot>(String(row.value)), r = snapshot.record;
      return { key: String(row.key).slice(prefix.length), sourceId: r.sourceId, kind: r.kind, sessionId: r.sessionId, instanceId: r.instanceId, executionId: r.executionId, revision: r.revision, state: this.health(snapshot) ? r.state : 'unknown', lastKnownState: r.state, lastVerifiedAt: snapshot.lastVerifiedAt, taskId: snapshot.taskId, business: r.subject ? '定义按需读取' : '目标/交付未知' };
    });
    const coverage = configured.slice(0, 50).map(s => ({ sourceId: s.id, ...this.store.get<Record<string, unknown>>(`pi-observation:coverage:${s.id}`, { ok: false, partial: true }) }));
    const partial = !configured.length || configured.length > 50 || sources.length !== configured.length || coverage.some(c => (c as Record<string, unknown>).ok !== true) || configured.some(s => this.c.readDeny.some(p => inside(s.exportRoot, p) || inside(p, s.exportRoot)));
    return { rows, count: rows.length, total: partial ? null : total, registered: total, hasMore: offset + limit < total, nextOffset: offset + limit < total ? offset + limit : null, partial, coverage, sourceHasMore: configured.length > 50, gaps: ['未登记/未加载导出的原 Pi 会话未接通；不扫会话历史', '运行停稳与业务交付分别核对'] };
  }
  async evidence(card: TaskCard, key: string, materials: Material[], signal?: AbortSignal) {
    await this.authorize(card);
    const snapshot = card.observation ? this.snapshot(card.observation.recordKey) : undefined, refs = snapshot?.record.result?.refs ?? [];
    if (!key) return { rows: refs.map((ref, i) => ({ key: String(i), ...ref })), note: '引用不是交付已核实；读取时核对内容版本' };
    const ref = refs[Number(key)]; if (!ref) throw new SafeError('not_found', '没有该结果引用');
    const { data } = await readBytes(ref.path, () => this.files.check(ref.path, true), this.c.intake.maxFileBytes);
    if (hash(data) !== ref.sha256) throw new SafeError('file_changed', '结果引用内容版本已变化，未当作原产物读取');
    const result = await this.files.read(ref.path, materials, true, 0, 64000, false, signal);
    if (result.ok && 'sourceSha256' in result && result.sourceSha256 !== ref.sha256) throw new SafeError('file_changed', '读取期间结果引用变化');
    await this.authorize(card); return result;
  }
  async ingest(input: Input) {
    const raw = input.raw as { observation?: number; sourceId?: string; recordKey?: string; revision?: number } | undefined;
    if (raw?.observation !== 1 || !raw.recordKey || !raw.sourceId) return false;
    try {
      this.source(raw.sourceId);
      const pending = this.noticeState(raw.recordKey).pending;
      if (pending?.inputId !== input.id) return false;
      let snapshot = this.snapshot(raw.recordKey), card = snapshot?.taskId ? this.store.task(snapshot.taskId) : undefined;
      if (!snapshot || !card || !input.workerId || this.store.taskTarget(card.id) !== this.store.taskTarget(input.workerId) || card.observation?.recordKey !== raw.recordKey) { this.acknowledge(input, true); return false; }
      // Revision is a wake-up minimum, not a claim that a heartbeat invalidates
      // the only queued notification. Re-read and consume the latest fact.
      await this.view(card);
      snapshot = this.snapshot(raw.recordKey)!; card = this.store.task(snapshot.taskId!)!;
      const important = !snapshot.ok || ['waiting', 'settled', 'closed'].includes(snapshot.record.state), changes = card.work?.attentionIds?.some(id => this.attention.rules().some(r => r.id === id && r.state === 'active' && r.notify === 'changes'));
      if (!important && !changes || !this.attention.mayNotify(card, important)) { this.acknowledge(input, true); return false; }
      await this.authorize(card);
      this.store.transaction(() => {
        const state = this.noticeState(raw.recordKey!); if (state.pending?.inputId !== input.id) return;
        state.pending.semantic = this.semantic(snapshot!); this.store.set(`pi-observation:notice:${raw.recordKey}`, state);
        this.store.set(`pi-observation:consumed-notice:${input.id}`, state.pending.semantic);
        this.store.db.prepare('INSERT OR IGNORE INTO task_events VALUES(?,?)').run(card!.id, input.id);
      });
      return true;
    } catch { this.acknowledge(input, true); return false; }
  }
  async stop() { this.stopped = true; for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear(); for (const dir of this.directories.values()) await dir.close().catch(() => {}); this.directories.clear(); }
}
