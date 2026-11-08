import { dirname, join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { lstat, opendir } from 'node:fs/promises';
import type { Config, LoopBinding, Project } from './types.js';
import type { Files } from './files.js';
import { readBytes } from './file-policy.js';
import { canonical, hash, inside, parseJson } from './util.js';
import { command } from './loop.js';
import { SafeError } from './errors.js';
import { processes } from './pi-process.js';

export interface KernelTask {
  id: string; name: string; state: string; node: string; reason: string; active: boolean; waiting: boolean; activityKind: string; processIdentity: string;
  attempt?: string; epoch: number; session?: { host: string; id: string; alive: boolean }; candidate?: unknown;
  integrated: boolean; release: unknown; counters: unknown;
}
export interface KernelFacts {
  binding: LoopBinding; project: string; revision: number; name: string; state: string; reason: string; node: string;
  tasks: KernelTask[]; candidate: unknown; checks: string[]; missing: string[]; publication: unknown;
  acceptanceItems: unknown[]; results: unknown[]; release: unknown; evidence: Record<string, string>;
  verifiedAt: string; flow: string[]; resumeBlocked?: string; executionEnded: boolean;
}
const text = (v: unknown, max = 2000) => typeof v === 'string' ? v.slice(0, max) : '';
const strings = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 200).map(s => text(s)) : [];
const candidate = (v: any) => v && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v.commit) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v.tree) ? { commit: v.commit, tree: v.tree } : null;
const release = (v: any) => ({ status: ['未释放', '已释放', '未确认'].includes(v?.status) ? v.status : '未确认', details: strings(v?.details) });
const counters = (v: any) => Object.fromEntries(['开发评审', '测试', '验收'].flatMap(n => v?.[n] ? [[n, { repairs: v[n].repairs, recoveries: v[n].recoveries }]] : []));
const states = ['进行中', '等你决定', '可合入', '已合入', '已放弃'];
export async function repository(c: Config, root: string, signal?: AbortSignal) {
  // Git plumbing only; never inspect .git/config or use a title/PID as identity.
  const common = await canonical((await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], c.loop.timeoutMs, root, undefined, signal)).trim());
  const top = await canonical((await command('git', ['rev-parse', '--show-toplevel'], c.loop.timeoutMs, root, undefined, signal)).trim());
  return { common, top };
}
/** Locate only the authorized repository's conventional index, never the global runs tree. */
export async function kernelIndexes(c: Config, files: Files, project: Project, signal?: AbortSignal) {
  await files.protocolPath(project.root, project.root);
  const identity = await repository(c, project.root, signal), key = hash(identity.common);
  const candidates = new Set<string>(), directLedgers: string[] = [];
  const defaultIndex = join(homedir(), '.pi-autoreview/kernel/runs', key);
  // Out-of-scope defaults are not promised coverage. Declared sources, however,
  // must never disappear silently when their permission/read gate fails.
  if (project.loopRunDirs.some(grant => inside(grant, defaultIndex))) candidates.add(defaultIndex);
  let unavailable = !project.loopRunDirs.length;
  for (const grant of project.loopRunDirs) {
    const runDir = basename(grant) === 'ledger.json' ? dirname(grant) : grant;
    const exactRun = basename(dirname(dirname(runDir))) === 'runs' && /^[a-f0-9]{64}$/.test(basename(dirname(runDir))) && /^[a-f0-9]{64}$/.test(basename(runDir));
    if (exactRun) {
      if (basename(dirname(runDir)) !== key) { unavailable = true; continue; }
      const ledger = join(runDir, 'ledger.json');
      try { await files.protocolPath(project.root, ledger); directLedgers.push(ledger); }
      catch { signal?.throwIfAborted(); unavailable = true; }
    } else if (basename(dirname(grant)) === 'runs' && /^[a-f0-9]{64}$/.test(basename(grant))) {
      if (basename(grant) === key) candidates.add(grant); else unavailable = true;
    } else if (basename(grant) === 'runs') candidates.add(join(grant, key));
    else candidates.add(join(grant, 'runs', key));
  }
  const indexes: string[] = [];
  for (const path of candidates) {
    // An authorized absent conventional index can be empty (e.g. first launch).
    // A refused index cannot be counted as that successful empty observation.
    try { await files.protocolPath(project.root, path); indexes.push(path); }
    catch { signal?.throwIfAborted(); unavailable = true; }
  }
  const ok = !unavailable && !!(indexes.length || directLedgers.length);
  return { ...identity, indexes, directLedgers: [...new Set(directLedgers)], coverage: { ok, reason: ok ? undefined : '新版 Loop 运行索引未接通或当前无法核对；不能判断来源为空' } };
}
/** Permission/identity gate BEFORE the public query sees the source's card path. */
export async function kernelSource(c: Config, files: Files, project: Project, ledger: string, signal?: AbortSignal) {
  const { common } = await repository(c, project.root, signal);
  if (basename(dirname(dirname(ledger))) !== hash(common)) throw new SafeError('outside_scope', '不是获准仓库的运行索引');
  const { data } = await readBytes(ledger, () => files.protocolPath(project.root, ledger), c.intake.maxFileBytes);
  const raw = parseJson<any>(data.toString('utf8'));
  if (raw.v !== 1 || typeof raw.id !== 'string' || !raw.id || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || raw.common !== common
    || typeof raw.file !== 'string' || basename(dirname(ledger)) !== hash(raw.file) || join(raw.dir ?? '', 'ledger.json') !== ledger
    || typeof raw.repo !== 'string' || !inside(raw.repo, raw.file) || await canonical(raw.file) !== raw.file)
    throw new SafeError('identity_mismatch', '来源不是完整的正式运行记录');
  const source = await repository(c, raw.repo, signal);
  if (source.common !== common || source.top !== await canonical(raw.repo)) throw new SafeError('outside_scope', '来源仓库身份不符');
  if (raw.card?.version !== 1 || raw.card?.nature === '评审' || !Array.isArray(raw.card?.tasks) || !raw.card.tasks.length)
    throw new SafeError('unsupported', '未知 Loop 开发卡协议');
  return { id: raw.id as string, card: raw.file as string, ledger, repository: common, revision: raw.revision as number,
    historical: !!raw.abandoned || raw.publication?.local === 'merged' && !raw.activity && !(raw.taskRecords ?? []).some((t: { activity?: unknown }) => t.activity),
    initial: { ok: true, kernel: 1, id: raw.id, card: raw.file, ledger, status: '等你决定', tasks: [] } };
}
export const sameBinding = (a: LoopBinding, b: LoopBinding) => a.repository === b.repository && a.runId === b.runId && a.cardFile === b.cardFile && a.ledger === b.ledger && a.taskId === b.taskId;
export function kernelFingerprint(f: KernelFacts, taskId: string | null = null) {
  const { verifiedAt: _at, ...facts } = f;
  return hash(JSON.stringify({ ...facts, selected: taskId }));
}
/** Execution leases are not artifact/worktree ownership. Inspect only registered
 * consumers of this bound run; no process names, environment dumps or signals. */
async function executionEnded(c: Config, files: Files, project: Project, raw: any, row: any) {
  if (!raw.stopped && !raw.abandoned && !['可合入', '已合入', '已放弃'].includes(row.status)) return false;
  const records = [raw, ...(Array.isArray(raw.taskRecords) ? raw.taskRecords : [])];
  if (records.some(r => r.activity || r.workerRequest && (!r.stopped || !r.worker) || r.session && !r.launch)) return false;
  const groups = records.flatMap(r => [r.launch, r.supervisor, r.worker]).filter(Boolean);
  if (groups.some(g => !Number.isSafeInteger(g.pid) || g.pid < 2 || typeof g.processStarted !== 'string' || !g.processStarted || typeof g.token !== 'string' || !g.token)) return false;
  try {
    const current = groups.length || records.some(r => r.session) ? await processes() : [];
    // Even a reused/unowned group is not proof that the old consumers ended.
    if (groups.some(g => current.some(p => !p.state.includes('Z') && (p.pid === g.pid || p.pgid === g.pid)))) return false;
    for (const r of records) if (r.session && (!Number.isSafeInteger(r.session.pid) || !r.session.started || current.some(p => !p.state.includes('Z') && p.pid === r.session.pid && p.started === r.session.started))) return false;
    const results = Array.isArray(raw.results) ? raw.results : [];
    if (!raw.stopped && results.some((r: any) => r.released !== true)) return false;
    if (!Array.isArray(row.attempts) || row.attempts.length > 1000) return false;
    const listed = new Map<string, any>();
    for (const attempt of row.attempts) {
      if (typeof attempt?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(attempt.id) || typeof attempt.evidence !== 'string' || listed.has(attempt.evidence)) return false;
      listed.set(attempt.evidence, attempt);
    }
    const paths = new Map<string, boolean>(), seen = new Set<string>(), covered = new Set<unknown>();
    let visited = 0;
    for (const r of records) {
      if (typeof r.dir !== 'string' || !inside(raw.dir, r.dir)) return false;
      paths.set(join(r.dir, 'review.procs.json'), true);
      const root = join(r.dir, 'attempts');
      await files.protocolPath(project.root, root);
      const before = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return; throw error; });
      if (!before) continue;
      if (!before.isDirectory() || before.isSymbolicLink()) return false;
      // Results are written LAST. Enumerate this bound run's actual attempts,
      // including interrupted requests that never acquired a result record.
      for await (const entry of await opendir(root)) {
        if (++visited > 1000 || !entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) return false;
        const request = join(root, entry.name, 'attempt.json'), item = listed.get(request);
        if (!item || seen.has(request)) return false;
        const { data } = await readBytes(request, () => files.protocolPath(project.root, request), Math.min(64000, c.intake.maxFileBytes));
        const attempt = parseJson<any>(data.toString('utf8'));
        const owner = r === raw ? raw.taskRecords ? raw.id : raw.card?.tasks?.[0]?.name : r.id;
        if (attempt.id !== entry.name || attempt.task !== owner || !['开发评审', '测试', '验收', '提交'].includes(attempt.node)
          || !candidate(attempt.candidate) || typeof attempt.inputs !== 'string' || !attempt.inputs || !Number.isFinite(Date.parse(attempt.started))
          || !Number.isSafeInteger(attempt.epoch) || attempt.epoch < 0) return false;
        const identity = (a: any) => JSON.stringify([a.id, a.task, a.node, candidate(a.candidate), a.inputs, a.started]);
        if (identity(item) !== identity(attempt) || item.epoch !== attempt.epoch) return false;
        const result = results.find((value: any) => value.id === attempt.id);
        if (result && (identity(result) !== identity(attempt) || result.released === true && !Number.isFinite(Date.parse(result.ended)))) return false;
        if (result) covered.add(result);
        seen.add(request);
        // Without a matching ended/released result, absence is NOT cleanup
        // proof: both the main consumer record and its cleanup must be empty.
        paths.set(join(root, entry.name, 'test.procs.json'), result?.released === true);
      }
      const after = await lstat(root);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || await files.protocolPath(project.root, root) !== root) return false;
    }
    if (seen.size !== listed.size || covered.size !== results.length) return false;
    for (const [base, allowMissing] of paths) for (const path of [base, `${base}.cleanup`]) {
      const check = () => files.protocolPath(project.root, path);
      try {
        await check(); await lstat(path);
        const { data } = await readBytes(path, check, c.intake.maxFileBytes);
        const consumers = parseJson<unknown>(data.toString('utf8'));
        if (!Array.isArray(consumers) || consumers.length) return false;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) return false; }
    }
    return true;
  } catch { return false; }
}
/** Only whitelisted mechanical fields leave this function; raw user inputs/sessions never enter Router. */
export async function kernelFacts(c: Config, files: Files, initial: any, query: (card: string, project: string) => Promise<unknown>, signal?: AbortSignal): Promise<KernelFacts> {
  let row = initial;
  if (row?.kernel !== 1 || row.ok !== true || typeof row.id !== 'string' || typeof row.card !== 'string' || typeof row.ledger !== 'string' || !states.includes(row.status) || !Array.isArray(row.tasks)) throw new SafeError('invalid_receipt', '新 Loop 查询身份不完整');
  let project: Project | undefined, authorized: Awaited<ReturnType<typeof repository>> | undefined;
  // Check the configured ledger boundary BEFORE opening it (not from its self-claimed repo).
  for (const p of c.projects) {
    if (!p.loopRunDirs.some(root => inside(root, resolve(row.ledger)))) continue;
    try {
      await files.protocolPath(p.root, row.ledger);
      if (await canonical(p.root) !== p.root) continue;
      const identity = await repository(c, p.root, signal);
      if (identity.top !== p.root) continue;
      if (basename(dirname(dirname(row.ledger))) !== hash(identity.common)) continue;
      project = p; authorized = identity; break;
    } catch { signal?.throwIfAborted(); }
  }
  if (!project || !authorized) throw new SafeError('outside_scope', 'ledger 不属于获准仓库');
  const check = () => files.protocolPath(project!.root, row.ledger);
  let raw: any, consistent = false, snapshotBytes: Buffer | undefined;
  // The public query has no revision. Sandwich the EXACT read-only query between
  // equal ledger bytes; never label an old query with a later ledger revision.
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const before = await readBytes(initial.ledger, check, c.intake.maxFileBytes);
    raw = parseJson<any>(before.data.toString('utf8'));
    if (raw.v !== 1 || raw.id !== initial.id || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || raw.common !== authorized.common
      || raw.file !== initial.card || join(raw.dir ?? '', 'ledger.json') !== initial.ledger
      || basename(dirname(initial.ledger)) !== hash(initial.card) || await canonical(initial.card) !== initial.card
      || typeof raw.repo !== 'string' || !inside(raw.repo, initial.card)) throw new SafeError('identity_mismatch', 'ledger 与原运行/卡身份不符');
    const source = await repository(c, raw.repo, signal);
    if (source.common !== authorized.common || source.top !== await canonical(raw.repo)) throw new SafeError('outside_scope', '来源工作区不是获准仓库');
    const cardIdentity = await repository(c, dirname(initial.card), signal);
    if (cardIdentity.common !== authorized.common || cardIdentity.top !== source.top) throw new SafeError('outside_scope', '卡路径不是原仓库工作区');
    row = await query(initial.card, project.root);
    if (row?.kernel !== 1 || row.ok !== true || row.id !== initial.id || row.card !== initial.card || row.ledger !== initial.ledger
      || !states.includes(row.status) || !Array.isArray(row.tasks)) throw new SafeError('identity_mismatch', '原卡查询回执身份不符');
    const after = await readBytes(initial.ledger, check, c.intake.maxFileBytes);
    if (before.data.equals(after.data)) { consistent = true; snapshotBytes = before.data; break; }
  }
  if (!consistent) throw new SafeError('file_changed', '查询期间 ledger 修订连续变化；保留原核实事实，等待只读重核');
  // Paths can be evidence only inside THIS run, or the authorized project; a globally registered root is not a blanket grant.
  const evidence: Record<string, string> = {};
  const safeEvidence = async (path: unknown) => {
    if (typeof path !== 'string' || ![project!.root, raw.dir].some(root => inside(root, resolve(path)))) return;
    try { await files.protocolPath(project!.root, path); const info = await lstat(path); if (info.isFile() && info.nlink === 1) return path; } catch { return; }
  };
  const summary = await safeEvidence(row.summary); if (summary) evidence.summary = summary;
  const tasks: KernelTask[] = [];
  const definitions = Array.isArray(raw.taskRecords) ? raw.taskRecords.filter((t: any) => !t.removed) : [{ ...raw, id: raw.card?.tasks?.[0]?.name, name: raw.card?.tasks?.[0]?.name }];
  if (definitions.length > 1000) throw new SafeError('resource_limit', '单次运行任务数超过核对上限');
  if (definitions.length !== row.tasks.length || new Set(definitions.map((t: any) => t.id)).size !== definitions.length) throw new SafeError('identity_mismatch', '任务身份集合与 ledger 不一致');
  for (const t of row.tasks) {
    const bound = definitions.find((r: any) => r.id === t.id && r.name === t.name);
    if (!bound || typeof t.id !== 'string' || !t.id || !states.includes(t.status)) throw new SafeError('identity_mismatch', '任务运行身份不符');
    const activity = t.activity;
    if (activity && (activity.id !== bound.activity?.id || activity.node !== bound.activity?.node || activity.kind !== bound.activity?.kind)) throw new SafeError('file_changed', '查询与 ledger 尝试代次不一致');
    const session = t.session;
    tasks.push({ id: t.id, name: text(t.name), state: t.status, node: text(t.node), reason: text(t.reason), active: !!activity && t.processIdentity === '存活', waiting: activity?.kind === 'waiting', activityKind: text(activity?.kind, 40), processIdentity: text(t.processIdentity, 40),
      attempt: activity ? text(activity.id) : undefined, epoch: Number.isSafeInteger(bound.epoch) ? bound.epoch : 0,
      ...(session?.host && session?.id && session.id === bound.session?.id && session.host === bound.session?.host ? { session: { host: text(session.host, 40), id: text(session.id, 200), alive: activity?.kind === 'developing' && activity.session === session.id && activity.pid === session.pid && activity.started === session.started && t.processIdentity === '存活' } } : {}),
      candidate: candidate(t.candidate), integrated: t.integrated === true, release: release(t.release), counters: counters(t.counters) });
  }
  const results = [];
  for (const r of (Array.isArray(row.results) ? row.results : []).slice(-100)) {
    if (![raw.id, ...tasks.map(t => t.id)].includes(r.task)) continue;
    const paths: string[] = [];
    for (const p of strings(r.evidence)) { const checked = await safeEvidence(p); if (checked) { paths.push(checked); evidence[`result-${Object.keys(evidence).length}`] = checked; } }
    results.push({ id: text(r.id, 200), task: text(r.task, 200), node: text(r.node, 40), candidate: candidate(r.candidate), inputs: text(r.inputs, 128), status: text(r.status, 40), started: text(r.started, 80), ended: text(r.ended, 80), released: r.released === true, evidence: paths });
  }
  await files.registerEvidence(project.root, evidence);
  const p = row.publication, flow = strings(raw.card?.flow);
  let resumeBlocked: string | undefined;
  if (!flow.length || flow[0] !== '开发评审' || flow.some(n => !['开发评审', '测试', '验收'].includes(n))) resumeBlocked = '冻结流程包含提交/部署或未知节点，普通续跑可能发布，未执行';
  else if (raw.publication) resumeBlocked = '原运行已有发布事务；普通续跑可能合入/推送，未执行';
  else if (raw.pendingCard || raw.changes?.some((change: any) => ['pending', 'prepared'].includes(change.state))) resumeBlocked = '原运行有待生效改卡；续跑后果未冻结，未执行';
  else {
    try {
      const frozen = join(raw.dir, 'frozen-card.json');
      const { data } = await readBytes(frozen, () => files.protocolPath(project!.root, frozen), 200 * 1024);
      if (hash(data) !== raw.cardHash || JSON.stringify(parseJson<any>(data.toString('utf8')).flow) !== JSON.stringify(flow)) resumeBlocked = '冻结流程与原 ledger 不一致，普通续跑不可用';
    } catch { resumeBlocked = '缺少可核对的冻结流程，普通续跑不可用'; }
  }
  const ended = await executionEnded(c, files, project, raw, row);
  if (!snapshotBytes!.equals((await readBytes(initial.ledger, check, c.intake.maxFileBytes)).data)) throw new SafeError('file_changed', '核对期间原 ledger 再次变化，保留原核实事实');
  return { flow, executionEnded: ended, ...(resumeBlocked ? { resumeBlocked } : {}), project: project.root, binding: { protocol: 'kernel:1', repository: authorized.common, runId: raw.id, cardFile: row.card, ledger: row.ledger, taskId: null }, revision: raw.revision, name: text(row.name), state: row.status, reason: text(row.reason), node: text(row.node), tasks,
    candidate: candidate(row.candidate), checks: strings(row.checks), missing: strings(row.missing),
    publication: p ? { local: text(p.local, 40), push: text(p.push, 40), reason: text(p.reason), commit: text(p.commit, 64), candidate: candidate(p.candidate) } : { local: row.externalMerge ? '外部合入' : '未核实', push: '未核实' },
    acceptanceItems: (Array.isArray(row.acceptanceItems) ? row.acceptanceItems : []).slice(0, 10).map((i: any) => ({ id: text(i.id, 40), owner: text(i.owner, 200), status: text(i.status, 200) })),
    results, release: release(row.release), evidence, verifiedAt: new Date().toISOString() };
}
export function selectKernel(facts: KernelFacts, binding: LoopBinding | undefined, taskId?: string | null) {
  if (binding?.taskId && taskId != null && taskId !== binding.taskId) throw new SafeError('identity_mismatch', '已绑定事项不能切换到其他来源任务；请查询对应原事项');
  const selected = taskId ?? binding?.taskId ?? null;
  const identity = { ...facts.binding, taskId: selected };
  if (binding && !sameBinding(binding, { ...identity, taskId: binding.taskId })) throw new SafeError('identity_mismatch', '原执行身份变化，不猜映射');
  const task = selected === null ? undefined : facts.tasks.find(t => t.id === selected);
  if (selected !== null && !task) throw new SafeError('not_found', '原任务已不存在，不能扩大为整批');
  return { binding: identity, task };
}
