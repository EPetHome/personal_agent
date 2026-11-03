import { readFile, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { object, requiredString } from './utils.ts';
import { OperationFailure } from './failures.ts';
import type { Config } from './types.ts';

function absolute(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (!isAbsolute(path)) throw new Error(`${label}必须是绝对路径（不展开 ~）`);
  return resolve(path);
}
function contains(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === '' || (diff !== '..' && !diff.startsWith('../') && !isAbsolute(diff));
}
export function isIgnoredProject(project: string, config: Config): boolean {
  return (config.ignoreProjectPrefixes ?? []).some(prefix => contains(prefix, resolve(project)));
}
// 即使最终目录还没创建，也解析已有父目录，防止符号链接造成来源/数据重叠。
async function canonical(path: string, source = false): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 读不进的来源留给感知组件报失明，不能在配置阶段中断其他来源。
    if (code !== 'ENOENT' && !(source && ['EACCES', 'EPERM', 'ENOTDIR'].includes(code ?? ''))) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent, source), path.slice(parent.length));
  }
}
function integer(value: unknown, fallback: number, label: string, minimum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > 2_147_483_647) throw new Error(`${label}必须是 >= ${minimum} 的安全整数`);
  return result as number;
}
export async function validateConfig(value: unknown): Promise<Config> {
  const data = object(value, '配置');
  const sources = object(data.sources, 'sources 配置');
  const commands = data.commands == null ? {} : object(data.commands, 'commands 配置');
  if (data.ignoreProjectPrefixes !== undefined && !Array.isArray(data.ignoreProjectPrefixes)) {
    throw new Error('ignoreProjectPrefixes 必须是绝对目录路径数组');
  }
  const config: Config = {
    sources: { cc: null, codex: null, pi: null, loop: null },
    inboxDir: data.inboxDir === null ? null : absolute(data.inboxDir, 'inboxDir'),
    dataDir: absolute(data.dataDir, 'dataDir'),
    ignoreProjectPrefixes: (data.ignoreProjectPrefixes ?? []).map((path: unknown) => absolute(path, 'ignoreProjectPrefixes')),
    commands: {
      cc: commands.cc === undefined ? 'claude' : requiredString(commands.cc, 'commands.cc'),
    },
  };
  if (data.loopEvents != null) {
    const events = object(data.loopEvents, 'loopEvents');
    if (events.since !== undefined && (typeof events.since !== 'string' || !Number.isFinite(Date.parse(events.since)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(events.since))) throw new Error('loopEvents.since 必须是带时区的时间');
    config.loopEvents = { dir: absolute(events.dir, 'loopEvents.dir'), ...(events.since === undefined ? {} : { since: events.since }) };
  }
  const managed = data.managedLoop == null ? {} : object(data.managedLoop, 'managedLoop');
  config.managedLoop = {
    verifyAfterMs: integer(managed.verifyAfterMs, 180000, 'managedLoop.verifyAfterMs', 0),
    inspectEveryMs: integer(managed.inspectEveryMs, 600000, 'managedLoop.inspectEveryMs', 1),
    intakeEveryMs: integer(managed.intakeEveryMs, 500, 'managedLoop.intakeEveryMs', 1),
    staleAfterMs: integer(managed.staleAfterMs, 1800000, 'managedLoop.staleAfterMs', 1),
  };
  const heartbeat = data.heartbeat == null ? {} : object(data.heartbeat, 'heartbeat');
  config.heartbeat = {
    everyMs: integer(heartbeat.everyMs, 30000, 'heartbeat.everyMs', 1),
    timeoutMs: integer(heartbeat.timeoutMs, 180000, 'heartbeat.timeoutMs', 1),
    checkEveryMs: integer(heartbeat.checkEveryMs, 60000, 'heartbeat.checkEveryMs', 1),
    executable: heartbeat.executable === undefined ? '/usr/bin/osascript' : requiredString(heartbeat.executable, 'heartbeat.executable'),
    notifyTimeoutMs: integer(heartbeat.notifyTimeoutMs, 3000, 'heartbeat.notifyTimeoutMs', 1),
  };
  if (config.heartbeat.everyMs >= config.heartbeat.timeoutMs) throw new Error('heartbeat.everyMs 必须小于 timeoutMs');
  if (data.worker != null) {
    const worker = object(data.worker, 'worker');
    const args = worker.args ?? [], refs = worker.candidateRefs ?? ['refs/pa/candidate', 'refs/loop/candidate'];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('worker.args 必须是字符串数组');
    if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string' || !/^refs\/[A-Za-z0-9_./-]+$/.test(ref) || ref.includes('..'))) throw new Error('worker.candidateRefs 必须是完整 Git ref 数组');
    if (worker.protocol !== undefined && !['json', 'loop-v1'].includes(worker.protocol)) throw new Error('worker.protocol 不支持');
    config.worker = { executable: requiredString(worker.executable, 'worker.executable'), args,
      timeoutMs: integer(worker.timeoutMs, 10000, 'worker.timeoutMs', 1), candidateRefs: refs,
      ...(worker.protocol ? { protocol: worker.protocol } : {}) };
  }
  if (data.piWorker != null) {
    const pi = object(data.piWorker, 'piWorker'), args = pi.args ?? [];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('piWorker.args 必须是字符串数组');
    if (pi.protocol !== undefined && !['json', 'pi-v1'].includes(pi.protocol)) throw new Error('piWorker.protocol 不支持');
    if (pi.protocol === 'pi-v1' && args.length) throw new Error('真实Pi不接受附加自由参数');
    const transcriber = pi.transcriber == null ? undefined : object(pi.transcriber, 'transcriber');
    config.piWorker = { executable: requiredString(pi.executable, 'piWorker.executable'), args,
      timeoutMs: Math.min(1200000, integer(pi.timeoutMs, 1200000, 'piWorker.timeoutMs', 1)),
      ...(pi.protocol ? { protocol: pi.protocol } : {}),
      ...(pi.protocol === 'pi-v1' ? { model: requiredString(pi.model, 'piWorker.model') } : {}),
      ...(transcriber ? { transcriber: { executable: absolute(transcriber.executable, 'transcriber.executable'),
        modelFile: absolute(transcriber.modelFile, 'transcriber.modelFile'), ffmpeg: absolute(transcriber.ffmpeg, 'transcriber.ffmpeg') } } : {}) };
  }
  if (data.dispatch != null) {
    const dispatch = object(data.dispatch, 'dispatch'), skills = object(dispatch.skills ?? {}, 'dispatch.skills');
    if (!Array.isArray(dispatch.projects)) throw new Error('dispatch.projects 必须是项目数组');
    const names = new Set<string>();
    config.dispatch = { projects: dispatch.projects.map((raw: unknown) => {
      const project = object(raw, 'dispatch.project'), name = requiredString(project.name, 'project.name');
      if (names.has(name)) throw new Error('派工项目名不能重复'); names.add(name);
      const loop = project.loop == null ? undefined : object(project.loop, 'project.loop');
      const prefixes = (value: unknown): string[] => {
        if (!Array.isArray(value) || !value.length || value.some(p => typeof p !== 'string' || !p || isAbsolute(p) || p.split('/').includes('..') || /[\0\\*?]/.test(p))) throw new Error('Loop范围须是非空的项目相对路径前缀数组');
        return value as string[];
      };
      if (loop && (typeof loop.batchDir !== 'string' || !loop.batchDir || isAbsolute(loop.batchDir) || loop.batchDir.split('/').some((p: string) => !p || p === '..' || p === '.') || /[\0\\]/.test(loop.batchDir))) throw new Error('loop.batchDir 须是项目内的相对目录');
      return { name, path: absolute(project.path, 'project.path'), workspace: absolute(project.workspace, 'project.workspace'),
        done: project.done === undefined ? '门禁通过、评审无必须修改、一次提交到批次分支；不合入、不推送' : requiredString(project.done, 'project.done'),
        ...(loop ? { loop: { batchDir: loop.batchDir, ...(loop.workspace === undefined ? {} : { workspace: requiredString(loop.workspace, 'loop.workspace') }), allow: prefixes(loop.allow), deny: loop.deny?.length ? prefixes(loop.deny) : [],
          ...(loop.review ? { review: { base: requiredString(loop.review.base, 'review.base'), head: requiredString(loop.review.head, 'review.head') } } : {}) } } : {}) };
    }), skills: Object.fromEntries(['transcribe', 'summary', 'wiki'].filter(key => skills[key] !== undefined).map(key => {
      if (typeof skills[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(skills[key])) throw new Error('skill 名必须是固定标识符');
      return [key, skills[key]];
    })) };
  }
  if (data.sidebar != null) {
    const sidebar = object(data.sidebar, 'sidebar');
    if (Object.keys(sidebar).some(key => !['port', 'refreshMs'].includes(key))) throw new Error('sidebar 只接受 port/refreshMs，监听地址固定127.0.0.1');
    const port = integer(sidebar.port, 17321, 'sidebar.port', 0);
    if (port > 65535) throw new Error('sidebar.port 必须在0–65535');
    config.sidebar = { port, refreshMs: integer(sidebar.refreshMs, 2000, 'sidebar.refreshMs', 100) };
  }
  if (data.workspace != null) {
    const workspace = object(data.workspace, 'workspace');
    if (workspace.inboxDir != null) config.workspace = { inboxDir: absolute(workspace.inboxDir, 'workspace.inboxDir'),
      pollEveryMs: integer(workspace.pollEveryMs, 2000, 'workspace.pollEveryMs', 1), settleMs: integer(workspace.settleMs, 1000, 'workspace.settleMs', 0) };
  }
  if (data.schedule != null) {
    const schedule = object(data.schedule, 'schedule');
    if (!['fake', 'real'].includes(schedule.mode)) throw new Error('schedule.mode 必须是 fake 或 real');
    if (Object.keys(schedule).some(key => !['mode', 'calendarIds', 'minuteTokens', 'minuteOwnerIds', 'pollEveryMs', 'timeoutMs', 'fakeFile', 'envFile'].includes(key))) throw new Error('日程配置不接受凭证；只能使用环境或.env');
    const ids = (key: string) => {
      const values = schedule[key] ?? [];
      if (!Array.isArray(values) || values.length > 100 || values.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.@-]{1,256}$/.test(id))) throw new Error(`schedule.${key} 必须是最多100项的资源ID数组`);
      return [...new Set(values)] as string[];
    };
    config.schedule = { mode: schedule.mode, calendarIds: ids('calendarIds'), minuteTokens: ids('minuteTokens'), minuteOwnerIds: ids('minuteOwnerIds'),
      pollEveryMs: integer(schedule.pollEveryMs, 60000, 'schedule.pollEveryMs', 1), timeoutMs: integer(schedule.timeoutMs, 10000, 'schedule.timeoutMs', 1),
      ...(schedule.fakeFile === undefined ? {} : { fakeFile: absolute(schedule.fakeFile, 'schedule.fakeFile') }),
      ...(schedule.envFile === undefined ? {} : { envFile: absolute(schedule.envFile, 'schedule.envFile') }) };
    if (config.schedule.envFile && basename(config.schedule.envFile) !== '.env') throw new Error('凭证文件必须命名为 .env');
    if (schedule.mode === 'fake' && (config.schedule.calendarIds.length || config.schedule.minuteTokens.length || config.schedule.minuteOwnerIds?.length) && !config.schedule.fakeFile) throw new Error('假日程必须显式指定 schedule.fakeFile');
  }
  if (data.judge != null) {
    const judge = object(data.judge, 'judge');
    config.judge = {
      executable: requiredString(judge.executable, 'judge.executable'),
      model: requiredString(judge.model, 'judge.model'),
      ...(judge.dailyLimit == null ? {} : { dailyLimit: integer(judge.dailyLimit, 0, 'judge.dailyLimit', 0) }),
      timeoutMs: integer(judge.timeoutMs, 30000, 'judge.timeoutMs', 1),
      cycleTimeoutMs: integer(judge.cycleTimeoutMs, 60000, 'judge.cycleTimeoutMs', 1),
    };
  }
  if (data.localChannel != null) {
    const channel = object(data.localChannel, 'localChannel');
    config.localChannel = { executable: requiredString(channel.executable, 'localChannel.executable'), timeoutMs: integer(channel.timeoutMs, 3000, 'localChannel.timeoutMs', 1) };
  }
  if (data.feishu != null) {
    const channel = object(data.feishu, 'feishu');
    if (!['fake', 'real'].includes(channel.mode)) throw new Error('feishu.mode 必须是 fake 或 real');
    if (Object.keys(channel).some(key => !['mode', 'receiverId', 'envFile', 'timeoutMs'].includes(key))) throw new Error('飞书配置只接受 mode/receiverId/envFile/timeoutMs；凭证只能放环境变量或已忽略的 .env');
    const envFile = channel.envFile === undefined ? undefined : absolute(channel.envFile, 'feishu.envFile');
    if (envFile && basename(envFile) !== '.env') throw new Error('凭证文件必须命名为 .env 并由 git 忽略');
    config.feishu = { mode: channel.mode, receiverId: requiredString(channel.receiverId, 'feishu.receiverId'),
      timeoutMs: integer(channel.timeoutMs, 5000, 'feishu.timeoutMs', 1), ...(envFile ? { envFile } : {}) };
  }
  if (data.relay != null) {
    const relay = object(data.relay, 'relay');
    if (typeof relay.enabled !== 'boolean') throw new Error('relay.enabled 必须是布尔值');
    config.relay = { enabled: relay.enabled, timeoutMs: integer(relay.timeoutMs, 600000, 'relay.timeoutMs', 1),
      ...(relay.ccSessionsDir === undefined ? {} : { ccSessionsDir: absolute(relay.ccSessionsDir, 'relay.ccSessionsDir') }) };
    if (relay.enabled && (!config.relay.ccSessionsDir || !config.feishu || sources.cc === null))
      throw new Error('开启 relay 必须配置 feishu、sources.cc 和 relay.ccSessionsDir');
  }
  if (data.service != null) {
    const service = object(data.service, 'service');
    config.service = { intervalMs: integer(service.intervalMs, 60000, 'service.intervalMs', 1),
      restartWindowMs: integer(service.restartWindowMs, 300000, 'service.restartWindowMs', 1),
      restartThreshold: integer(service.restartThreshold, 3, 'service.restartThreshold', 1) };
  }
  // 旧 waiting/intelligence/learning 与聊天检测来源不再验证，也不进入有效配置。
  // CC 路径只供用户明确点击旧卡片时转达；不在常规检测中访问。
  config.sources.cc = typeof sources.cc === 'string' && isAbsolute(sources.cc) ? resolve(sources.cc) : null;
  if (config.relay?.enabled && !config.sources.cc) throw new Error('开启 relay 必须配置绝对路径 sources.cc');
  config.sources.loop = sources.loop == null ? null : absolute(sources.loop, 'sources.loop');
  const readPaths = [config.sources.loop, config.loopEvents?.dir, config.workspace?.inboxDir, config.schedule?.fakeFile, ...(config.relay?.enabled ? [config.sources.cc, config.relay.ccSessionsDir] : [])]
    .filter((p): p is string => typeof p === 'string');
  const dataPath = await canonical(config.dataDir);
  const repository = await canonical(resolve(import.meta.dirname, '../../..'));
  if (contains(repository, dataPath)) throw new Error('数据目录必须放在仓库外，不能把运行数据写进仓库');
  for (const envFile of [config.feishu?.envFile, config.schedule?.envFile]) if (envFile && contains(dataPath, await canonical(envFile))) throw new Error('.env 须独立放在数据目录外，避免把凭证混进运行数据/导出');
  for (const path of readPaths) {
    const source = await canonical(path, true);
    if (path === config.loopEvents?.dir && config.inboxDir && (contains(await canonical(config.inboxDir, true), source) || contains(source, await canonical(config.inboxDir, true)))) throw new Error('官方Loop事件目录必须独立于旧inboxDir');
    if (contains(source, dataPath) || contains(dataPath, source)) {
      throw new Error('数据目录与来源/推送目录不能重叠（包括符号链接）；请使用新的独立临时目录');
    }
  }
  return config;
}
export async function loadConfig(path: string | undefined): Promise<Config> {
  if (!path) throw new Error('请先配置：用 --config <配置文件> 显式指定来源、推送、数据目录和回看命令');
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('配置文件读不了或不是合法 JSON（未输出文件内容）'); }
  return validateConfig(value);
}
export async function assertRegularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new OperationFailure('unsafe_file', `拒绝访问非普通文件或链接：${path}`);
}
