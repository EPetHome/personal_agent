import { readFile, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { object, requiredString } from './utils.ts';
import { tools } from './types.ts';
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
  const commands = object(data.commands, 'commands 配置');
  if (data.ignoreProjectPrefixes !== undefined && !Array.isArray(data.ignoreProjectPrefixes)) {
    throw new Error('ignoreProjectPrefixes 必须是绝对目录路径数组');
  }
  const config: Config = {
    sources: { cc: null, codex: null, pi: null, loop: null },
    inboxDir: data.inboxDir === null ? null : absolute(data.inboxDir, 'inboxDir'),
    dataDir: absolute(data.dataDir, 'dataDir'),
    ignoreProjectPrefixes: (data.ignoreProjectPrefixes ?? []).map((path: unknown) => absolute(path, 'ignoreProjectPrefixes')),
    commands: {
      cc: requiredString(commands.cc, 'commands.cc'),
      codex: requiredString(commands.codex, 'commands.codex'),
      pi: requiredString(commands.pi, 'commands.pi'),
    },
  };
  if (data.judge != null) {
    const judge = object(data.judge, 'judge');
    config.judge = {
      executable: requiredString(judge.executable, 'judge.executable'),
      model: requiredString(judge.model, 'judge.model'),
      dailyLimit: integer(judge.dailyLimit, 240, 'judge.dailyLimit', 0),
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
  if (data.service != null) {
    const service = object(data.service, 'service');
    config.service = { intervalMs: integer(service.intervalMs, 60000, 'service.intervalMs', 1),
      restartWindowMs: integer(service.restartWindowMs, 300000, 'service.restartWindowMs', 1),
      restartThreshold: integer(service.restartThreshold, 3, 'service.restartThreshold', 1) };
  }
  if (data.learning !== undefined) {
    if (typeof data.learning !== 'boolean') throw new Error('learning 必须是布尔值');
    config.learning = data.learning;
  }
  for (const tool of tools) config.sources[tool] = sources[tool] === null ? null : absolute(sources[tool], `sources.${tool}`);
  const readPaths = [...Object.values(config.sources), config.inboxDir].filter((p): p is string => p !== null);
  const dataPath = await canonical(config.dataDir);
  const repository = await canonical(resolve(import.meta.dirname, '../../..'));
  if (contains(repository, dataPath)) throw new Error('数据目录必须放在仓库外，不能把运行数据写进仓库');
  if (config.feishu?.envFile && contains(dataPath, await canonical(config.feishu.envFile))) throw new Error('.env 须独立放在数据目录外，避免把凭证混进运行数据/导出');
  for (const path of readPaths) {
    const source = await canonical(path, true);
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
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`拒绝访问非普通文件或链接：${path}`);
}
