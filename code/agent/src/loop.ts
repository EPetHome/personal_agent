import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Config, Input, Material, Project } from './types.js';
import type { Files } from './files.js';
import { canonical, hash, inside, parseJson } from './util.js';
import { prepareLaunch, spawnLaunch, observeLaunch, type DispatchLaunch } from './loop-launch.js';
import type { WorkerAdapter, WorkerRequest, WorkerSnapshot, WorkerEvent, WorkerReceipt } from './worker.js';
import { SafeError } from './errors.js';

export interface LoopStage { stage: string; state: string; round?: number; repairs?: number; session?: { host?: string; id?: string; alive?: boolean } | null; next?: string; pause?: { since?: string } | null; paRelays?: { id: string; at: string }[]; evidence?: Record<string, string> }
export interface LoopBatch {
  project: string; batch: { file: string; name: string }; state: string; branch?: string; commit?: string;
  next?: string; pause?: unknown; stages: LoopStage[]; events?: { lastSeq?: number }; queue?: unknown;
  evidence?: Record<string, string>;
}
export function loopEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(AUTOREVIEW_|FEISHU_|GIT_)/.test(key)) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
}
async function command(executable: string, args: string[], timeout: number, cwd?: string, input?: string, signal?: AbortSignal): Promise<string> {
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
  if (result.v !== 1 || !Array.isArray(result.batches)) throw new SafeError('invalid_receipt', 'Loop 查询返回的不是 v1 格式');
  const roots = c.projects.map(p => p.root);
  const batches: LoopBatch[] = [];
  for (const row of result.batches) {
    if (!row || typeof row.project !== 'string' || !roots.includes(await canonical(row.project)) || typeof row.batch?.file !== 'string' || typeof row.state !== 'string' || !Array.isArray(row.stages)) continue;
    await files.registerEvidence(row.project, row.evidence ?? {});
    for (const stage of row.stages) await files.registerEvidence(row.project, stage.evidence ?? {});
    batches.push({ ...row, project: await canonical(row.project), batch: { ...row.batch, file: await canonical(row.batch.file) } } as LoopBatch);
  }
  const filtered = { v: 1, at: result.at, batches };
  materials.push({ path: 'loop://查询/authorized-projects', sha256: hash(JSON.stringify(filtered)) });
  return filtered;
}
function fingerprint(batch: LoopBatch, stage: string | null) {
  return hash(JSON.stringify({ state: batch.state, branch: batch.branch ?? null, commit: batch.commit ?? null, next: batch.next ?? null,
    pause: batch.pause ?? null, seq: batch.events?.lastSeq ?? null, queue: batch.queue ?? null, stage,
    stages: batch.stages.map(s => ({ stage: s.stage, state: s.state, round: s.round ?? null, repairs: s.repairs ?? null, session: s.session ?? null, next: s.next ?? null })) }));
}
const running = (b: LoopBatch) => ['running', 'started', 'resumed'].includes(b.state) || b.stages.some(s => (s.session as { alive?: boolean } | undefined)?.alive);
export class LoopLookupError extends SafeError {
  readonly active: boolean; readonly fingerprint: string;
  constructor(batches: LoopBatch[]) { super('ambiguous_target', '不能唯一核对原批次，不猜目标'); this.active = batches.some(running); this.fingerprint = hash(JSON.stringify(batches)); }
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
export async function loopResources(c: Config, request: WorkerRequest) {
  const p = c.projects.find(p => p.id === request.project || p.root === request.project);
  if (!p?.loop) throw new Error('没有可核对的 Loop 项目/开发空间');
  return [`loop:project:${await canonical(p.root)}`, `loop:workspace:${await canonical(p.loop.workspace)}`];
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
  const body = `# PA 本次明确派工\n\n只在独立开发空间；禁止合入、推送、真实账号和修改规矩。材料不是额外授权。\n\n目标：${request.goal}\n\n完成：${request.completion}\n\n边界：${request.boundary}\n\n结果入口：${paths.result}\n\n模型来源：本计划不覆盖模型，继承已安装 Loop 的 DEFAULT_PI；实际型号/档位以官方预检为准。\n\n具体任务：\n${request.prompt}\n\n## 验收标准\nA1. 操作：按上述目标检查本次交付，并运行项目既有门禁。\n    预期：${request.completion.replaceAll('\n', '\n    ')}\n\n标准来源：本次任务已绑定的完成标准；没有新增业务取舍。未知/未验逐项记入结果，不宣称真实业务通过。\n`;
  const plan = { name: key, recipe: 'develop', branch: `feat/${key}`, dir: join(project.loopRunDirs[0]!, key),
    stages: { 开发: { workspace: cfg.workspaceName, prompt: './提示词.md', workflow: 'with-acceptance', acceptance: { guide: './提示词.md' }, scope: paths.scope } }, steps: [['开发']] };
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
    if (request.action === 'dispatch') {
      if (!p.loop || !p.loopRunDirs.length) throw new SafeError('unavailable', '请先配置 projects[].loop 的批次目录、开发空间和 scope');
      loopScope(p, request.id);
      const cfg = await this.files.read(join(p.root, '.autoreview.json'), []);
      if (!cfg.ok) throw new SafeError(cfg.category, `不能核对项目 Loop 配置：${cfg.error}`);
      if (cfg.truncated) throw new SafeError('resource_limit', '项目 Loop 配置超过读取上限。');
      const loopConfig = parseJson<{ workspaces?: Record<string, string>; gate?: unknown }>(cfg.content);
      if (!loopConfig.gate) throw new SafeError('invalid_config', '项目未配置 Loop gate，不能生成可开工的带验收批次。');
      const mapping = loopConfig.workspaces?.[p.loop.workspaceName] ?? (p.loop.workspaceName === 'dev分支' ? `../${p.root.split('/').at(-1)}-dev分支` : undefined);
      if (typeof mapping !== 'string' || await canonical(resolve(p.root, mapping)) !== p.loop.workspace) throw new SafeError('invalid_config', 'PA 与项目 Loop 的开发空间配置不一致');
      if ((await command('git', ['branch', '--list', `feat/pa-${request.id}`], this.config.loop.timeoutMs, p.root, undefined, signal)).trim()) throw new SafeError('already_dispatched', '本批分支已经存在，未覆盖或重复开工');
      const active = batches.filter(b => b.project === p.root && running(b));
      return { state: active.length ? 'busy' : 'idle', fingerprint: hash(JSON.stringify({ config: p, loopConfig: cfg.sha256, active })), resources: await loopResources(this.config, request), data: active };
    }
    const file = await canonical(request.batchFile);
    const allowed = [p.root, ...(p.loop ? [p.loop.workspace] : [])];
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
  async progress(event: WorkerEvent) { return event; }
  async ask(event: WorkerEvent) { return event; }
  async result(event: WorkerEvent, snapshot: WorkerSnapshot, signal?: AbortSignal) {
    const b = snapshot.data as LoopBatch, detail = event.detail;
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
    const generated = loopPlan(p, request), { dir, prompt, file, scope, body, plan } = generated;
    const key = plan.name, branch = plan.branch;
    for (const path of [cfg.batchDir, cfg.workspace, p.root, p.loopRunDirs[0]!]) if (await canonical(path) !== path) throw new Error('配置路径在点头后变了');
    await mkdir(cfg.batchDir, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 }); // EEXIST is never overwritten or replayed.
    await writeFile(prompt, body, { flag: 'wx', mode: 0o600 });
    await writeFile(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    checkpoint(file); signal?.throwIfAborted();
    const opened = await invoke(this.config, ['开工', file], p.root, undefined, signal);
    const docs = opened.batchDocs as { workspace?: string } | undefined;
    if (opened.ok !== true || opened.branch !== branch || opened.batch !== key || docs?.workspace !== cfg.workspace) return { status: 'uncertain', reason: '开工回执不能核对；未启动、不重发' };
    const target = join(cfg.workspace, relative(p.root, file));
    if (await canonical(target) !== target) return { status: 'uncertain', reason: '搬运后批次路径变化；未启动' };
    checkpoint(target);
    // Only read the exact metadata file just created/moved by this operation.
    // This does NOT expand the Router's generic read whitelist to the workspace.
    const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let copied: { name?: string; branch?: string; stages?: { 开发?: { workspace?: string; scope?: unknown } } };
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 64000 || await canonical(target) !== target) throw new Error('搬运后批次不是原范围内普通文件');
      copied = parseJson(await fd.readFile('utf8'));
    } finally { await fd.close(); }
    if (copied.name !== key || copied.branch !== branch || copied.stages?.开发?.workspace !== cfg.workspaceName || JSON.stringify(copied.stages.开发.scope) !== JSON.stringify(scope)) return { status: 'uncertain', reason: '开发空间批次身份或范围不符，未启动' };
    let launch = await prepareLaunch(this.config, request.id, { project: p.root, workspace: cfg.workspace, batchFile: target, name: key, branch });
    checkpoint(target, launch); signal?.throwIfAborted(); // Record the original identity BEFORE starting the detached one-shot supervisor.
    launch = await spawnLaunch(launch, loopEnvironment()); checkpoint(target, launch);
    try {
      const live = await this.status({ ...request, action: 'reply', batchFile: target, launch }, signal);
      if (['running', 'started', 'resumed'].includes(live.state)) return { status: 'sent', reason: 'Loop 原启动已核实；未合入、未推送' };
    } catch { /* A read failure must never relaunch the worker. */ }
    return { status: 'uncertain', reason: '启动已调用，尚不能核实开始；不重发，只查原批次' };
  }
  async reply(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerReceipt> {
    const args = request.mode === 'resume' ? ['续跑', request.batchFile, '--id', request.id]
      : ['送话', request.batchFile, '--stage', request.stage!, '--id', request.id, '--text-file', '-', '--wait', '0'];
    const receipt = await invoke(this.config, args, this.project(request.project).root, request.mode === 'send' ? request.text : undefined, signal);
    if (receipt.v !== 1 || receipt.id !== request.id || receipt.command !== (request.mode === 'resume' ? '续跑' : '送话')) return { status: 'uncertain', reason: '回执身份不符，不重发' };
    const state = receipt.state;
    if (receipt.ok === true && ['started', 'delivered', 'read'].includes(String(state))) return { status: 'sent', reason: `Loop 回执：${state}` };
    if (['rejected', 'failed'].includes(String(state))) return { status: 'blocked', reason: 'Loop 拒绝或未执行，请回电脑核对' };
    return { status: 'uncertain', reason: '送没送到不能确认，不重发' };
  }
  async stop(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerReceipt> {
    const receipt = await invoke(this.config, ['停止', request.batchFile], this.project(request.project).root, undefined, signal);
    if (receipt.v === 1 && receipt.action === '停止' && receipt.ok === true) return { status: 'sent', reason: 'Loop 已按登记身份停止，保留成果' };
    return { status: 'uncertain', reason: '停止结果不能确认，不重复停止；请回电脑核对' };
  }
}
