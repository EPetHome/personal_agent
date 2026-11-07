import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Config, Input, Material, Project } from './types.js';
import type { Files } from './files.js';
import { canonical, hash, inside, parseJson } from './util.js';
import { prepareLaunch, spawnLaunch, observeLaunch, type DispatchLaunch } from './loop-launch.js';
import type { WorkerAdapter, WorkerRequest, WorkerSnapshot, WorkerEvent, WorkerReceipt } from './worker.js';
import { SafeError } from './errors.js';
import { kernelFacts, kernelFingerprint, repository, selectKernel, type KernelFacts } from './loop-kernel.js';

export interface LoopStage { stage: string; state: string; round?: number; repairs?: number; session?: { host?: string; id?: string; alive?: boolean } | null; next?: string; pause?: { since?: string } | null; paRelays?: { id: string; at: string }[]; evidence?: Record<string, string> }
export interface LoopBatch {
  project: string; batch: { file: string; name: string }; state: string; branch?: string; commit?: string;
  next?: string; pause?: unknown; stages: LoopStage[]; events?: { lastSeq?: number }; queue?: unknown;
  evidence?: Record<string, string>; kernel?: KernelFacts;
}
export function loopEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(AUTOREVIEW_|FEISHU_|GIT_)/.test(key)) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
}
export async function command(executable: string, args: string[], timeout: number, cwd?: string, input?: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: loopEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    let output = '', settled = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); } } };
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(output); };
    const abort = () => { kill(); finish(new SafeError('cancelled', '命令已取消，调用结果不能确认')); };
    const timer = setTimeout(() => { kill(); finish(new SafeError('timeout', '命令超时，调用结果不能确认')); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; if (Buffer.byteLength(output) > 2 * 1024 * 1024) { kill(); finish(new SafeError('resource_limit', '命令输出超限')); } });
    child.stdin.on('error', () => {}); // EPIPE is resolved by the bounded exit/receipt path.
    child.stdin.end(input);
    child.once('error', () => finish(new SafeError('unavailable', '命令无法启动')));
    child.once('close', code => finish(code === 0 || output.trim().startsWith('{') ? undefined : new SafeError('command_failed', '命令失败')));
  });
}
async function invoke(c: Config, args: string[], project?: string, text?: string, signal?: AbortSignal) {
  if (!c.loop.command) throw new SafeError('unavailable', '尚未配置 Loop 命令');
  return parseJson<Record<string, unknown>>(await command(c.loop.command, [...c.loop.args, ...args, '--json'], args[0] === '查询' ? c.loop.timeoutMs : c.loop.actionTimeoutMs, project, text, signal));
}
export async function queryLoop(c: Config, files: Files, materials: Material[], signal?: AbortSignal) {
  const result = await invoke(c, ['查询', '--all'], undefined, undefined, signal);
  if (result.v !== 1 && result.kernel !== 1 || !Array.isArray(result.batches)) throw new SafeError('invalid_receipt', 'Loop 查询返回的不是 v1/kernel:1 格式');
  const roots = c.projects.map(p => p.root);
  const batches: LoopBatch[] = []; let excluded = 0;
  for (const row of result.batches) {
    if (row?.kernel === 1) {
      try {
        const facts = await kernelFacts(c, files, row, (card, project) => invoke(c, ['查询', card], project, undefined, signal), signal);
        const p = c.projects.find(p => p.root === facts.project);
        if (p) batches.push({ project: p.root, batch: { file: facts.binding.cardFile, name: facts.name }, state: facts.state, stages: [], evidence: facts.evidence, kernel: facts });
      } catch { signal?.throwIfAborted(); excluded++; /* Rejected raw records never reach the model. */ }
      continue;
    }
    if (!row || typeof row.project !== 'string' || !roots.includes(await canonical(row.project)) || typeof row.batch?.file !== 'string' || typeof row.state !== 'string' || !Array.isArray(row.stages)) continue;
    const projectRoot = await canonical(row.project), project = c.projects.find(p => p.root === projectRoot);
    if (!project) continue;
    const file = await canonical(row.batch.file);
    if (![project.root, ...(project.loop?.workspace ? [project.loop.workspace] : [])].some(root => inside(root, file))) continue;
    const evidence = async (value: Record<string, string> = {}) => {
      const safe: Record<string, string> = {};
      for (const [key, path] of Object.entries(value)) if (typeof path === 'string') {
        try { safe[key] = await files.protocolPath(project.root, path); } catch { /* Not a grant. */ }
      }
      await files.registerEvidence(project.root, safe); return safe;
    };
    const stages: LoopStage[] = [];
    for (const stage of row.stages) if (stage && typeof stage.stage === 'string' && typeof stage.state === 'string') stages.push({ stage: stage.stage, state: stage.state,
      round: stage.round, repairs: stage.repairs, next: stage.next, pause: stage.pause ? { since: stage.pause.since } : stage.pause,
      session: stage.session ? { host: stage.session.host, id: stage.session.id, alive: stage.session.alive } : stage.session,
      paRelays: Array.isArray(stage.paRelays) ? stage.paRelays.map((r: any) => ({ id: r.id, at: r.at })) : undefined, evidence: await evidence(stage.evidence) });
    batches.push({ project: project.root, batch: { name: row.batch.name, file }, state: row.state, branch: row.branch, commit: row.commit, next: row.next,
      pause: row.pause ? { since: row.pause.since } : row.pause, stages, events: row.events ? { lastSeq: row.events.lastSeq } : undefined,
      queue: row.queue ? { status: row.queue.status, position: row.queue.position, reason: row.queue.reason } : row.queue, evidence: await evidence(row.evidence) });
  }
  const filtered = { v: 1, at: new Date().toISOString(), batches, coverage: { scope: '获准项目的可核对记录；不是全来源自动发现', excludedUnverifiedOrUnauthorized: excluded } };
  materials.push({ path: 'loop://查询/authorized-projects', sha256: hash(JSON.stringify(filtered)) });
  return filtered;
}
function fingerprint(batch: LoopBatch, stage: string | null) {
  return hash(JSON.stringify({ state: batch.state, branch: batch.branch ?? null, commit: batch.commit ?? null, next: batch.next ?? null,
    pause: batch.pause ?? null, seq: batch.events?.lastSeq ?? null, queue: batch.queue ?? null, stage,
    stages: batch.stages.map(s => ({ stage: s.stage, state: s.state, round: s.round ?? null, repairs: s.repairs ?? null, session: s.session ?? null, next: s.next ?? null })) }));
}
const running = (b: LoopBatch) => b.kernel ? b.kernel.tasks.some(t => t.active && !t.waiting) : ['running', 'started', 'resumed'].includes(b.state) || b.stages.some(s => (s.session as { alive?: boolean } | undefined)?.alive);
export class LoopLookupError extends SafeError {
  readonly active: boolean; readonly fingerprint: string;
  constructor(batches: LoopBatch[]) { super('ambiguous_target', '不能唯一核对原批次，不猜目标'); this.active = batches.some(running); this.fingerprint = hash(JSON.stringify(batches, (key, value) => key === 'verifiedAt' ? undefined : value)); }
}
export function currentLoopEvent(event: WorkerEvent, input: Input, snapshot: WorkerSnapshot) {
  const batch = snapshot.data as LoopBatch, stage = event.stage ? batch.stages.find(s => s.stage === event.stage) : undefined;
  if (event.stage && !stage) return false;
  if (event.detail.scope === '整批' && event.stage !== null || event.detail.scope === '段' && event.stage === null) return false;
  for (const field of ['round', 'repairs'] as const) if (stage?.[field] !== undefined && event.detail[field] !== undefined && event.detail[field] !== stage[field]) return false;
  if (typeof event.detail.next === 'string' && snapshot.next && event.detail.next !== snapshot.next) return false;
  if (typeof event.detail.commit === 'string' && event.detail.commit !== batch.commit) return false;
  if (typeof event.detail.branch === 'string' && event.detail.branch.replace(/^refs\/heads\//, '') !== batch.branch?.replace(/^refs\/heads\//, '')) return false;
  const pause = (event.stage ? stage?.pause : batch.pause) as { since?: string } | null | undefined;
  if (['paused', 'needs-decision', 'repair-limit'].includes(event.status) && pause?.since && Date.parse(input.at) < Date.parse(pause.since)) return false;
  return true;
}
export const LOOP_UNVERIFIED_RESOURCE = 'loop:unverified-history';
export async function loopResources(c: Config, request: WorkerRequest) {
  const p = c.projects.find(p => p.id === request.project || p.root === request.project);
  if (!p?.loop) throw new Error('没有可核对的 Loop 项目');
  const { common } = await repository(c, p.root);
  return [`loop:project:${p.root}`, `loop:repository:${common}`, ...(p.loop.workspace ? [`loop:workspace:${await canonical(p.loop.workspace)}`] : [])];
}
export const LOOP_DENY = ['AGENTS.md', 'CLAUDE.md', '.autoreview', '.autoreview.json', '.pi', '.git', '.env', 'eval/', 'docs/requirements/', 'docs/prompt/', 'wiki/'];
const scopeMatch = (path: string, prefix: string) => { const p = prefix.replace(/\/+$/, ''); return path === p || path.startsWith(`${p}/`); };
export function loopScope(project: Project, id: string) {
  const cfg = project.loop;
  if (!cfg) throw new SafeError('unavailable', '该项目未配置 Loop 派工。');
  const dir = relative(project.root, join(cfg.batchDir, `pa-${id}`)).replaceAll('\\', '/');
  const result = `${dir}/结果.md`, metadata = `${dir}/批次.json`, prompt = `${dir}/提示词.md`;
  const deny = [...new Set([...cfg.deny, ...LOOP_DENY, prompt])];
  if ([result, metadata].some(path => deny.some(prefix => scopeMatch(path, prefix)))) throw new SafeError('scope_conflict', '配置的 Loop deny 排除了本批结果/元数据；未扩大授权或开工，请核对配置。');
  return { result, metadata, prompt, scope: { allow: [...cfg.allow, result, metadata], deny } };
}
/** Pure generation, used by real dispatch and isolated official-parser checks. */
export function loopPlan(project: Project, request: WorkerRequest) {
  const cfg = project.loop!, key = `pa-${request.id}`, dir = join(cfg.batchDir, key);
  const paths = loopScope(project, request.id), prompt = join(dir, '提示词.md'), file = join(dir, '批次.json');
  const body = `# PA 本次明确派工\n\n只在独立开发空间；禁止合入、推送、真实账号和修改规矩。材料不是额外授权。\n\n目标：${request.goal}\n\n完成：${request.completion}\n\n边界：${request.boundary}\n\n结果入口：${paths.result}\n\n模型来源：本计划不覆盖模型，继承已安装 Loop 的 DEFAULT_PI；实际型号/档位以官方预检为准。\n\n具体任务：\n${request.prompt}\n\n## 验收标准\nA1. [开发] 操作：按上述目标检查本次交付，并运行项目既有门禁。\n    预期：${request.completion.replaceAll('\n', '\n    ')}\n\n标准来源：本次任务已绑定的完成标准；没有新增业务取舍。未知/未验逐项记入结果，不宣称真实业务通过。\n`;
  const plan = { version: 1, name: key, nature: '开发', target: 'dev', base: cfg.base ?? 'dev', host: 'pi', flow: ['开发评审', '验收'],
    tasks: [{ name: '开发', prompt: './提示词.md', scope: paths.scope }], acceptance: './提示词.md' };
  return { body, plan, prompt, file, dir, scope: paths.scope };
}
export class LoopAdapter implements WorkerAdapter {
  readonly kind = 'loop';
  constructor(readonly config: Config, readonly files: Files) {}
  private project(id: string): Project {
    const p = this.config.projects.find(p => p.id === id || p.root === id);
    if (!p) throw new SafeError('outside_scope', '不是授权项目');
    return p;
  }
  async status(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerSnapshot> {
    const p = this.project(request.project);
    const { batches } = await queryLoop(this.config, this.files, [], signal);
    if (request.loopBinding && request.loopBinding.repository !== (await repository(this.config, p.root, signal)).common) throw new SafeError('outside_scope', '原仓库授权已变化，控制不可用');
    if (request.action === 'dispatch') {
      if (!p.loop || !p.loopRunDirs.length) throw new SafeError('unavailable', '请先配置 projects[].loop 的批次目录和 scope 及获准 Loop 记录范围');
      loopScope(p, request.id);
      const cfg = await this.files.read(join(p.root, '.autoreview.json'), []);
      if (!cfg.ok) throw new SafeError(cfg.category, `不能核对项目 Loop 配置：${cfg.error}`);
      if (cfg.truncated) throw new SafeError('resource_limit', '项目 Loop 配置超过读取上限。');
      if ((await command('git', ['ls-files', '--', '.autoreview.json'], this.config.loop.timeoutMs, p.root, undefined, signal)).trim()) throw new SafeError('invalid_config', '新版 Loop 要求本机配置未跟踪；未自动迁移或开工');
      const loopConfig = parseJson<{ acceptance?: unknown }>(cfg.content);
      if (!loopConfig.acceptance) throw new SafeError('invalid_config', '项目缺少 Loop acceptance 配置');
      await command('git', ['rev-parse', '--verify', 'refs/heads/dev^{commit}'], this.config.loop.timeoutMs, p.root, undefined, signal);
      await command('git', ['rev-parse', '--verify', `refs/heads/${p.loop.base ?? 'dev'}^{commit}`], this.config.loop.timeoutMs, p.root, undefined, signal);
      const active = batches.filter(b => b.project === p.root && running(b));
      return { state: active.length ? 'busy' : 'idle', fingerprint: hash(JSON.stringify({ config: p, loopConfig: cfg.sha256, active })), resources: await loopResources(this.config, request), data: active };
    }
    const file = await canonical(request.batchFile);
    const allowed = [p.root, ...(p.loop?.workspace ? [p.loop.workspace] : [])];
    const kernel = batches.filter(b => b.kernel && b.project === p.root && b.kernel.binding.cardFile === file && (!request.loopBinding || b.kernel.binding.repository === request.loopBinding.repository));
    if (kernel.length === 1) {
      if (!request.loopBinding && request.launch?.protocol !== 'kernel:1' && !request.lookupKernel) throw new SafeError('unverified', '旧派单缺少新版原运行身份，未猜映射；控制不可用');
      return this.kernelStatus(request, kernel[0]!, signal);
    }
    if (request.loopBinding || kernel.length > 1) throw new LoopLookupError(kernel);
    if (!allowed.some(root => inside(root, file))) throw new SafeError('outside_scope', '批次文件不在授权项目或其开发空间');
    const found = [];
    for (const b of batches) if (await canonical(b.project) === p.root && await canonical(b.batch.file) === file) found.push(b);
    if (found.length !== 1) throw new LoopLookupError(batches.filter(b => b.project === p.root));
    const b = found[0]!, stage = request.stage ? b.stages.find(s => s.stage === request.stage) : undefined;
    if (request.stage && !stage) throw new SafeError('not_found', '原段不存在');
    const state = stage?.state ?? b.state, next = stage?.next ?? (request.stage ? 'send' : b.next);
    const executable = request.action !== 'reply' || ['paused', 'needs-decision', 'repair-limit', 'done', 'failed'].includes(state)
      && (request.mode === 'resume' ? !request.stage && next === 'resume' : !!request.stage && next === 'send' && !!request.text);
    const snapshot: WorkerSnapshot = { state, fingerprint: fingerprint(b, request.stage), next, executable, active: running(b), resourceReleased: ['done', 'failed'].includes(b.state) && !running(b), data: b };
    const launch = request.launch;
    if (launch) {
      const observation = await observeLaunch(this.config, launch); snapshot.launchObservation = observation;
      const bound = launch.operation === request.id && launch.project === p.root && launch.workspace === p.loop?.workspace && launch.batchFile === file
        && launch.name === `pa-${request.id}` && launch.name === b.batch.name && launch.branch === `feat/pa-${request.id}` && b.branch === launch.branch;
      const completed = b.state !== 'done' || await this.result({ project: p.root, batchFile: file, stage: null, status: 'done', detail: { branch: b.branch, commit: b.commit } }, snapshot, signal);
      const exited = observation.ended && completed && ['running', 'started', 'resumed', 'paused', 'needs-decision', 'repair-limit', 'done', 'failed'].includes(b.state);
      const live = observation.invoked && observation.processes ? b.stages.find(s =>
        typeof s.stage === 'string' && !!s.stage.trim() && s.session?.alive === true
        && typeof s.session.id === 'string' && !!s.session.id.trim() && typeof s.session.host === 'string' && !!s.session.host.trim()) : undefined;
      if (bound && observation.evidence && (exited || live)) snapshot.dispatchProof = {
        operation: request.id, bindingHash: hash(JSON.stringify(launch)), evidence: observation.evidence, state: b.state,
        phase: exited ? 'exited' : 'accepted',
        ...(live ? { acceptance: { stage: live.stage, host: live.session!.host!, sessionId: live.session!.id!, source: observation.invocationSource!, ...observation.processes! } } : {}),
        // Receipt of the task is not release of the original CLI/workspace.
        terminal: exited && snapshot.resourceReleased === true,
      };
    }
    return snapshot;
  }
  private async kernelStatus(request: WorkerRequest, batch: LoopBatch, signal?: AbortSignal): Promise<WorkerSnapshot> {
    signal?.throwIfAborted();
    const facts = batch.kernel!, { binding, task } = selectKernel(facts, request.loopBinding, request.sourceTaskId);
    if (request.stage) throw new SafeError('unsupported', '新版 Loop 不接受旧 stage；使用原来源任务 ID');
    const active = task ? task.active && !task.waiting : facts.tasks.some(t => t.active && !t.waiting);
    const state = task?.state ?? facts.state;
    const snapshot: WorkerSnapshot = { state, fingerprint: kernelFingerprint(facts, binding.taskId), active, executable: request.action === 'stop' || !facts.resumeBlocked && request.mode === 'resume' && (!request.text || ['继续', '再给它一轮'].includes(request.text)) && state === '等你决定' && !active && (task ? !task.waiting && task.processIdentity === '无活动' : facts.tasks.every(t => !t.waiting && t.processIdentity === '无活动')),
      unavailableReason: facts.resumeBlocked, next: 'resume', resourceReleased: facts.executionEnded, data: batch, loopBinding: binding };
    const launch = request.launch;
    if (launch?.protocol === 'kernel:1') {
      const observation = await observeLaunch(this.config, launch); snapshot.launchObservation = observation;
      const bound = launch.operation === request.id && launch.project === batch.project && launch.batchFile === binding.cardFile && launch.name === facts.name
        && (!launch.repository || launch.repository === binding.repository);
      const live = facts.tasks.find(t => t.session?.alive && t.active && t.attempt);
      // End of background dispatch is NOT host acceptance. Require the formal kernel receipt or a bound live native session.
      const accepted = observation.kernelReceipt?.id === binding.runId && observation.kernelReceipt.card === binding.cardFile && observation.kernelReceipt.dispatched === true;
      if (bound && observation.evidence && observation.invoked && (accepted || live || observation.ended && snapshot.resourceReleased && observation.kernelReceipt?.id === binding.runId && observation.kernelReceipt.card === binding.cardFile)) snapshot.dispatchProof = {
        operation: request.id, bindingHash: hash(JSON.stringify(launch)), evidence: observation.evidence, state,
        phase: observation.ended && snapshot.resourceReleased ? 'exited' : 'accepted', terminal: observation.ended && snapshot.resourceReleased === true,
        ...(live && observation.processes ? { acceptance: { stage: live.id, host: live.session!.host, sessionId: live.session!.id, source: observation.invocationSource!, ...observation.processes } } : {}),
      };
    }
    return snapshot;
  }
  async progress(event: WorkerEvent) { return event; }
  async ask(event: WorkerEvent) { return event; }
  async result(event: WorkerEvent, snapshot: WorkerSnapshot, signal?: AbortSignal) {
    const b = snapshot.data as LoopBatch, detail = event.detail;
    if (b.kernel) return false; // New cards never borrow legacy done/commit qualification.
    const branch = detail.branch, commit = detail.commit;
    if (typeof branch !== 'string' || typeof commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit) || !/^[\w\p{L}./-]+$/u.test(branch) || branch.includes('..') || branch.startsWith('-')) return false;
    if (b.branch?.replace(/^refs\/heads\//, '') !== branch.replace(/^refs\/heads\//, '') || b.commit !== commit) return false;
    const ref = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
    try {
      // No fetch, checkout, config read tool or Git write. Only the configured repository.
      const head = (await command('git', ['rev-parse', '--verify', `${ref}^{commit}`], this.config.loop.timeoutMs, this.project(event.project).root, undefined, signal)).trim();
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) return false;
      await command('git', ['merge-base', '--is-ancestor', commit, head], this.config.loop.timeoutMs, this.project(event.project).root, undefined, signal);
      return true;
    } catch { return false; }
  }
  async dispatch(request: WorkerRequest, checkpoint: (file: string, launch?: DispatchLaunch) => void, signal?: AbortSignal): Promise<WorkerReceipt> {
    const p = this.project(request.project), cfg = p.loop;
    if (!cfg || !p.loopRunDirs.length) return { status: 'blocked', reason: '缺少本人配置的 Loop 派工范围' };
    // The worker guard already claimed this operation before any filesystem/CLI effect.
    const generated = loopPlan(p, request), { dir, prompt, file, body, plan } = generated;
    const key = plan.name;
    for (const path of [cfg.batchDir, p.root, p.loopRunDirs[0]!]) if (await canonical(path) !== path) throw new Error('配置路径在点头后变了');
    await mkdir(cfg.batchDir, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 }); // EEXIST is never overwritten or replayed.
    await writeFile(prompt, body, { flag: 'wx', mode: 0o600 });
    await writeFile(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    checkpoint(file); signal?.throwIfAborted();
    const identity = await repository(this.config, p.root, signal);
    let launch = await prepareLaunch(this.config, request.id, { protocol: 'kernel:1', repository: identity.common, project: p.root, workspace: '', batchFile: file, name: key, branch: '' });
    checkpoint(file, launch); signal?.throwIfAborted(); // Persist BEFORE the sole startup effect.
    launch = await spawnLaunch(launch, loopEnvironment()); checkpoint(file, launch);
    try {
      const live = await this.status({ ...request, action: 'reply', batchFile: file, launch }, signal);
      if (live.dispatchProof) return { status: 'sent', snapshot: live, reason: 'Loop 原启动接收已核实；执行、检查、发布和业务验收仍分别核对' };
      return { status: 'uncertain', snapshot: live, reason: '原运行已关联，但宿主接收仍未核实；不重发原启动' };
    } catch { /* A read failure must never relaunch the worker. */ }
    return { status: 'uncertain', reason: '启动已调用，尚不能核实开始；不重发，只查原批次' };
  }
  async reply(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerReceipt> {
    if (request.loopBinding) {
      if (request.mode !== 'resume' || request.text && !['继续', '再给它一轮'].includes(request.text)) return { status: 'blocked', reason: '新版 Loop 没有送话接口；续跑不承载新增要求，请回原会话操作' };
      return this.kernelControl('续跑', request, signal);
    }
    const args = request.mode === 'resume' ? ['续跑', request.batchFile, '--id', request.id]
      : ['送话', request.batchFile, '--stage', request.stage!, '--id', request.id, '--text-file', '-', '--wait', '0'];
    const latest = await this.status(request, signal);
    if (latest.loopBinding) return { status: 'blocked', reason: '新版身份须先持久绑定，未套用旧送话/续跑接口' };
    const receipt = await invoke(this.config, args, this.project(request.project).root, request.mode === 'send' ? request.text : undefined, signal);
    if (receipt.v !== 1 || receipt.id !== request.id || receipt.command !== (request.mode === 'resume' ? '续跑' : '送话')) return { status: 'uncertain', reason: '回执身份不符，不重发' };
    const state = receipt.state;
    if (receipt.ok === true && ['started', 'delivered', 'read'].includes(String(state))) return { status: 'sent', reason: `Loop 回执：${state}` };
    if (['rejected', 'failed'].includes(String(state))) return { status: 'blocked', reason: 'Loop 拒绝或未执行，请回电脑核对' };
    return { status: 'uncertain', reason: '送没送到不能确认，不重发' };
  }
  private async kernelControl(action: '续跑' | '停止', request: WorkerRequest, signal?: AbortSignal): Promise<WorkerReceipt> {
    const snapshot = await this.status(request, signal), binding = snapshot.loopBinding!;
    if (!binding || request.expectedFingerprint && request.expectedFingerprint !== snapshot.fingerprint) return { status: 'blocked', reason: '原新版执行身份或依据变化，未执行控制' };
    if (action === '续跑' && snapshot.executable === false) return { status: 'blocked', reason: snapshot.unavailableReason ?? '原执行不能接受安全续跑，未执行' };
    const target = binding.taskId ? (snapshot.data as LoopBatch).kernel!.tasks.find(t => t.id === binding.taskId) : undefined;
    const args = [action, binding.cardFile, ...(target ? ['--task', target.name] : [])];
    const r = await invoke(this.config, args, this.project(request.project).root, undefined, signal);
    if (r.kernel !== 1 || r.command !== action || r.id !== binding.runId || r.card !== binding.cardFile || r.ledger !== binding.ledger) return { status: 'uncertain', reason: '原执行控制回执身份不符，不重复操作' };
    if (r.ok !== true) return { status: 'uncertain', reason: '控制结果未核实，不重试；不代表业务完成' };
    return { status: 'sent', reason: `${action}请求已按原${target ? `任务 ${target.id}` : '整批'}身份核实；${action === '续跑' ? '宿主接收和实际执行仍须核实；' : ''}不代表业务完成` };
  }
  async stop(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerReceipt> {
    if (request.loopBinding) return this.kernelControl('停止', request, signal);
    if ((await this.status(request, signal)).loopBinding) return { status: 'blocked', reason: '新版身份须先持久绑定；未执行旧停止' };
    const receipt = await invoke(this.config, ['停止', request.batchFile, ...(request.stage ? ['--stage', request.stage] : [])], this.project(request.project).root, undefined, signal);
    if (receipt.v === 1 && receipt.action === '停止' && receipt.ok === true) return { status: 'sent', reason: 'Loop 已按登记身份停止，保留成果' };
    return { status: 'uncertain', reason: '停止结果不能确认，不重复停止；请回电脑核对' };
  }
}
