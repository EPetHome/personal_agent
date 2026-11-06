import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { canonical, inside, jsonFile, localUrl, parseUrl } from './util.js';
import { SafeError } from './errors.js';
import type { Config } from './types.js';

export const CONFIG_FIELDS: Record<string, string[]> = Object.fromEntries(Object.entries({
  root: 'dataDir attachmentDir inboxDirs projects readAllow readDeny windowTokens checkpointKeep maxToolRounds model feishu loop pi queue intake concurrency approval watchdog',
  model: 'url name auth headers timeoutMs maxOutputTokens dailyTokenLimit', 'model.auth': 'type path provider variable',
  feishu: 'mode userId url envFile pollMs timeoutMs', loop: 'command args eventDirs timeoutMs actionTimeoutMs',
  pi: 'command args timeoutMs pollMs startupMs maxTurns model', 'pi.model': 'url name',
  queue: 'busyMs inputTimeoutMs stopMs', intake: 'watch fallbackMs maxFileBytes', concurrency: 'router read skill writePerDirectory',
  approval: 'readPi send dispatch stop redLine', watchdog: 'pollMs heartbeatMs heartbeatStaleMs inputStaleMs modelFailures feishuStaleMs minDiskBytes local',
  'watchdog.local': 'mode url', project: 'id root loopRunDirs loop pi', 'project.loop': 'batchDir workspace workspaceName allow deny', 'project.pi': 'writeDirs skills',
}).map(([key, value]) => [key, value.split(' ')]));
export class ConfigError extends SafeError { constructor(message: string) { super('invalid_config', message); } }
function fields(value: unknown, label: string) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`${label} 必须是配置对象。`);
  if (Object.keys(value).some(key => !CONFIG_FIELDS[label]!.includes(key))) throw new ConfigError(label === 'pi' && Object.hasOwn(value, 'readPaths')
    ? 'pi.readPaths 不是有效启动配置字段；派工 readPaths 只会缩小已有读取范围。' : `${label} 含未知或不生效字段，未加载业务配置。`);
}
export type NotificationConfig = Pick<Config, 'dataDir' | 'feishu' | 'watchdog' | 'intake'>;
/** Deliberately does not inspect dispatch/model/projects. Never grants business permissions. */
export async function loadNotificationConfig(path: string): Promise<NotificationConfig> {
  let raw: Partial<Config>; try { raw = await jsonFile(path); } catch { throw new ConfigError('通知配置文件不可读或 JSON 无效。'); }
  return notificationConfig(raw);
}
async function notificationConfig(raw: Partial<Config>): Promise<NotificationConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('通知配置必须是对象。');
  fields(raw.feishu, 'feishu'); fields(raw.watchdog, 'watchdog'); fields(raw.watchdog?.local, 'watchdog.local');
  const dataDir = raw.dataDir ?? `${homedir()}/.personal-agent-v2`;
  const feishu: Config['feishu'] = { mode: 'fake', userId: '', url: '', envFile: '', pollMs: 1000, timeoutMs: 10000, ...raw.feishu };
  const watchdog: Config['watchdog'] = { pollMs: 10000, heartbeatMs: 60000, heartbeatStaleMs: 120000, inputStaleMs: 300000, modelFailures: 3, feishuStaleMs: 300000, minDiskBytes: 1024 ** 3, ...raw.watchdog, local: { mode: 'native', url: '', ...raw.watchdog?.local } };
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || dataDir.includes('\0') || typeof feishu.envFile !== 'string' || feishu.envFile && !isAbsolute(feishu.envFile)) throw new ConfigError('通知数据目录和凭据文件须为绝对路径。');
  if (typeof feishu.userId !== 'string' || !feishu.userId || !['fake', 'real'].includes(feishu.mode)) throw new ConfigError('必须配置本人飞书 ID 和渠道模式。');
  try {
    if (feishu.mode === 'fake' && !localUrl(feishu.url)) throw new Error();
    if (!['fake', 'native'].includes(watchdog.local.mode) || watchdog.local.mode === 'fake' && !localUrl(watchdog.local.url)) throw new Error();
  } catch { throw new ConfigError('飞书/本机通知模式或地址无效；替身仅允许本地 HTTP。'); }
  if ([feishu.pollMs, feishu.timeoutMs, ...Object.values(watchdog).filter(x => typeof x === 'number')].some(x => !Number.isSafeInteger(x) || Number(x) <= 0)) throw new ConfigError('通知时限和阈值须为正整数。');
  return { dataDir: await canonical(dataDir), feishu, watchdog, intake: { watch: false, fallbackMs: 60000, maxFileBytes: 20 * 1024 * 1024 } };
}
export async function loadConfig(path: string): Promise<Config> {
  try { return await businessConfig(path); }
  catch (error) { if (error instanceof ConfigError) throw error; throw new ConfigError('业务配置结构、路径或数值无效，未加载；请按使用说明核对。'); }
}
async function businessConfig(path: string): Promise<Config> {
  const raw = await jsonFile<Partial<Config>>(path);
  fields(raw, 'root');
  for (const key of ['model', 'feishu', 'loop', 'pi', 'queue', 'intake', 'concurrency', 'approval', 'watchdog'] as const) fields(raw[key], key);
  fields(raw.model?.auth, 'model.auth'); fields(raw.pi?.model, 'pi.model'); fields(raw.watchdog?.local, 'watchdog.local');
  if (raw.projects !== undefined && !Array.isArray(raw.projects)) throw new ConfigError('projects 必须是数组。');
  for (const p of raw.projects ?? []) { fields(p, 'project'); fields(p.loop, 'project.loop'); fields(p.pi, 'project.pi'); }
  const notification = await notificationConfig(raw), home = homedir();
  const c: Config = {
    attachmentDir: `${home}/.personal-agent-附件`, inboxDirs: [], projects: [], readAllow: [], readDeny: [],
    configPath: resolve(path), windowTokens: 100000, checkpointKeep: 8, maxToolRounds: 30, ...raw, ...notification,
    model: { url: 'https://opencode.ai/inference/go/openai/v1', name: 'deepseek-v4.1-flash', timeoutMs: 60000, maxOutputTokens: 8192, dailyTokenLimit: 0, headers: {}, ...raw.model,
      auth: { type: 'pi', path: `${home}/.pi/agent/auth.json`, provider: 'opencode-go', variable: 'PA_MODEL_KEY', ...raw.model?.auth } },
    loop: { command: '', args: [], eventDirs: [], timeoutMs: 15000, actionTimeoutMs: 300000, ...raw.loop },
    pi: { command: 'pi', args: [], timeoutMs: 1200000, pollMs: 1000, startupMs: 10000, maxTurns: 30, ...raw.pi },
    queue: { busyMs: 10000, inputTimeoutMs: 300000, stopMs: 30000, ...raw.queue },
    intake: { watch: true, fallbackMs: 60000, maxFileBytes: 20 * 1024 * 1024, ...raw.intake },
    concurrency: { router: 1, read: 3, skill: 1, writePerDirectory: 1, ...raw.concurrency },
    approval: { readPi: true, send: true, dispatch: true, stop: true, ...raw.approval, redLine: true },
  };
  const paths = [c.dataDir, c.attachmentDir, ...c.inboxDirs, ...c.readAllow, ...c.readDeny, ...c.loop.eventDirs,
    ...c.projects.flatMap(p => [p.root, ...p.loopRunDirs, ...(p.loop ? [p.loop.batchDir, p.loop.workspace] : [])]), c.model.auth.path, c.feishu.envFile].filter(Boolean);
  if (paths.some(p => typeof p !== 'string' || !isAbsolute(p) || p.includes('\0'))) throw new ConfigError('配置中的目录必须使用绝对路径');
  if (!['pi', 'env', 'none'].includes(c.model.auth.type)) throw new ConfigError('模型凭证来源不支持');
  if (c.model.auth.type === 'none' && !localUrl(c.model.url)) throw new ConfigError('无凭证模式只允许本地模型替身');
  const modelUrl = parseUrl(c.model.url);
  if (modelUrl.username || modelUrl.password) throw new ConfigError('模型地址不能包含凭证');
  const numbers = [c.windowTokens, c.checkpointKeep, c.maxToolRounds, ...Object.values(c.queue), ...Object.values(c.intake).filter((x): x is number => typeof x === 'number'),
    ...Object.values(c.concurrency), c.model.timeoutMs, c.model.maxOutputTokens, c.loop.timeoutMs, c.loop.actionTimeoutMs, c.pi.timeoutMs, c.pi.pollMs, c.pi.startupMs, c.pi.maxTurns];
  if (numbers.some(n => !Number.isSafeInteger(n) || n <= 0) || c.windowTokens < 32 || c.queue.stopMs > 30000 || c.concurrency.router !== 1) throw new ConfigError('时限/上限须为正整数；Router 并发固定 1，停止最长 30 秒');
  if (!Number.isSafeInteger(c.model.dailyTokenLimit) || c.model.dailyTokenLimit < 0) throw new ConfigError('每日模型用量上限不合法');
  c.attachmentDir = await canonical(c.attachmentDir);
  c.projects = await Promise.all(c.projects.map(async p => {
    const project = { ...p, root: await canonical(p.root), loopRunDirs: await Promise.all(p.loopRunDirs.map(canonical)) };
    if (p.loop) {
      project.loop = { ...p.loop, batchDir: await canonical(p.loop.batchDir), workspace: await canonical(p.loop.workspace) };
      if (!inside(project.root, project.loop.batchDir) || project.root === project.loop.batchDir || inside(project.root, project.loop.workspace) || inside(project.loop.workspace, project.root)) throw new ConfigError('Loop 批次目录须在项目内，开发空间须独立');
      if (!p.loop.workspaceName || !p.loop.allow?.length || !Array.isArray(p.loop.deny) || [...p.loop.allow, ...p.loop.deny].some(x => typeof x !== 'string' || !x || isAbsolute(x) || x.split(/[\\/]/).includes('..')) || p.loop.allow.some(x => !/^code(?:\/|$)/.test(x))) throw new ConfigError('Loop scope 必须由配置限定在 code/，不能含越界路径');
    }
    if (p.pi) {
      if (!Array.isArray(p.pi.writeDirs) || !p.pi.skills || typeof p.pi.skills !== 'object' || [...p.pi.writeDirs, ...Object.values(p.pi.skills)].some(path => typeof path !== 'string' || !isAbsolute(path))) throw new ConfigError('Pi 写目录和技能路径须由配置明确指定绝对路径');
      project.pi = { writeDirs: await Promise.all(p.pi.writeDirs.map(canonical)), skills: Object.fromEntries(await Promise.all(Object.entries(p.pi.skills).map(async ([key, path]) => [key, await canonical(path)]))) };
      if (project.pi.writeDirs.some(path => !inside(project.root, path) || path === project.root) || Object.values(project.pi.skills).some(path => !inside(project.root, path))) throw new ConfigError('Pi 写目录和技能只能位于授权项目内');
    }
    return project;
  }));
  if (new Set(c.projects.map(p => p.id)).size !== c.projects.length || new Set(c.projects.map(p => p.root)).size !== c.projects.length) throw new ConfigError('授权项目身份不能重复');
  for (const value of Object.values(c.approval)) if (typeof value !== 'boolean') throw new ConfigError('点头开关须为布尔值');
  c.inboxDirs = await Promise.all(c.inboxDirs.map(canonical)); c.loop.eventDirs = await Promise.all(c.loop.eventDirs.map(canonical));
  c.readAllow = await Promise.all(c.readAllow.map(canonical)); c.readDeny = await Promise.all(c.readDeny.map(canonical));
  if (!c.pi.command || !Array.isArray(c.pi.args) || c.pi.args.some(a => typeof a !== 'string')) throw new ConfigError('Pi 命令配置无效');
  if (c.pi.model && (!c.pi.model.name || c.model.auth.type === 'none' && !localUrl(c.pi.model.url))) throw new ConfigError('无凭证 Pi 只允许本地模型替身');
  const configReal = await canonical(c.configPath);
  if (inside(c.dataDir, c.attachmentDir) || inside(c.attachmentDir, c.dataDir)) throw new ConfigError('附件目录必须独立于数据目录');
  const incoming = [...c.inboxDirs, ...c.loop.eventDirs];
  if (incoming.some(p => inside(p, c.dataDir) || inside(c.dataDir, p) || inside(p, c.attachmentDir) || inside(c.attachmentDir, p))) throw new ConfigError('来源目录不能与数据/附件目录重叠');
  if (inside(c.dataDir, configReal)) throw new ConfigError('配置文件须在数据目录之外（PA 不写配置）');
  return c;
}
