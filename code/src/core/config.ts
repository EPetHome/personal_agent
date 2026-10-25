import { readFile, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
export async function validateConfig(value: unknown): Promise<Config> {
  const data = object(value, '配置');
  const sources = object(data.sources, 'sources 配置');
  const commands = object(data.commands, 'commands 配置');
  const config: Config = {
    sources: { cc: null, codex: null, pi: null, loop: null },
    inboxDir: data.inboxDir === null ? null : absolute(data.inboxDir, 'inboxDir'),
    dataDir: absolute(data.dataDir, 'dataDir'),
    commands: {
      cc: requiredString(commands.cc, 'commands.cc'),
      codex: requiredString(commands.codex, 'commands.codex'),
      pi: requiredString(commands.pi, 'commands.pi'),
    },
  };
  for (const tool of tools) config.sources[tool] = sources[tool] === null ? null : absolute(sources[tool], `sources.${tool}`);
  const readPaths = [...Object.values(config.sources), config.inboxDir].filter((p): p is string => p !== null);
  const dataPath = await canonical(config.dataDir);
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
  return validateConfig(JSON.parse(await readFile(path, 'utf8')));
}
export async function assertRegularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`拒绝访问非普通文件或链接：${path}`);
}
