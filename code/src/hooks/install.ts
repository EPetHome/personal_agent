import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, writeFile, chmod, realpath, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, shellQuote } from '../core/utils.ts';
import type { HookTool } from './protocol.ts';

const here = dirname(fileURLToPath(import.meta.url));
const market = 'personal-agent-local';
const plugin = `message-listener@${market}`;
interface SavedFile { path: string; mode: number; data?: string }
interface Backup {
  version: 1; tool: HookTool; home: string; paths: string[]; before: SavedFile[]; after?: string; command?: string; asset: string;
  /** 缺省仅兼容有 after 的旧成功安装；其他未知现场不允许自动恢复。 */
  phase?: 'installing' | 'installed' | 'restoring' | 'rolled_back' | 'recovery_required';
}
const paths: Record<HookTool, string[]> = {
  cc: ['.claude/settings.json', '.claude/plugins'],
  codex: ['.codex/config.toml', '.codex/plugins'],
  pi: ['.pi/agent/settings.json'],
};
async function exists(path: string) {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
async function noLinkedParents(home: string, path: string): Promise<void> {
  const diff = relative(home, path);
  if (diff.startsWith('..') || isAbsolute(diff)) throw new Error('安装路径超出目标主目录');
  for (let current = path; current !== home; current = dirname(current)) {
    if (await exists(current) && (await lstat(current)).isSymbolicLink()) throw new Error('目标配置或父目录是链接，拒绝安装/恢复');
  }
}
async function snapshot(home: string, roots: string[]): Promise<SavedFile[]> {
  const result: SavedFile[] = [];
  async function visit(path: string) {
    await noLinkedParents(home, path);
    if (!await exists(path)) return;
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('配置含链接或特殊文件，未备份/改动');
    const entry: SavedFile = { path: relative(home, path), mode: stat.mode & 0o777 };
    if (stat.isFile()) entry.data = (await readFile(path)).toString('base64');
    result.push(entry);
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  for (const path of roots) await visit(join(home, path));
  return result;
}
async function fingerprint(backup: Backup): Promise<string> { return hash(JSON.stringify(await snapshot(backup.home, backup.paths))); }
async function restore(backup: Backup, expected: string) {
  // 每个恢复入口均须提供刚确认的现场指纹；不能用“没有 after”放行覆盖。
  if (await fingerprint(backup) !== expected) throw new Error('配置另有变化，拒绝覆盖；请先备份并人工合并');
  for (const path of backup.paths) {
    await noLinkedParents(backup.home, join(backup.home, path));
    await rm(join(backup.home, path), { recursive: true, force: true });
  }
  for (const file of backup.before) {
    const path = resolve(backup.home, file.path);
    await noLinkedParents(backup.home, path);
    if (file.data === undefined) await mkdir(path, { recursive: true, mode: file.mode });
    else { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, Buffer.from(file.data, 'base64'), { mode: file.mode }); }
    await chmod(path, file.mode);
  }
}
function runPlugin(command: string, args: string[], home: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, { cwd: home, timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), PI_CODING_AGENT_DIR: join(home, '.pi/agent'),
        XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    }, error => error ? reject(new Error('插件管理命令失败；已尝试恢复安装前配置')) : resolveRun());
  });
}
async function json(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
async function saveBackup(path: string, backup: Backup) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}
async function packageAssets(tool: HookTool, asset: string, inbox: string, node: string) {
  await mkdir(asset, { recursive: true, mode: 0o700 });
  await json(join(asset, 'package.json'), { name: 'message-listener', private: true, type: 'module' });
  if (tool === 'pi') {
    await writeFile(join(asset, 'protocol.ts'), await readFile(join(here, 'protocol.ts')));
    const source = (await readFile(join(here, 'pi/index.ts'), 'utf8')).replaceAll("from '../protocol.ts'", "from './protocol.ts'");
    await writeFile(join(asset, 'listener.ts'), source);
    await writeFile(join(asset, 'message-listener.ts'), `import { registerMessageListener } from './listener.ts';\nimport type { ListenerAPI } from './listener.ts';\nexport default function (pi: ListenerAPI) { registerMessageListener(pi, ${JSON.stringify(inbox)}); }\n`);
    return;
  }
  const root = join(asset, 'plugins/message-listener');
  await mkdir(root, { recursive: true });
  for (const file of ['protocol.ts', 'message-listener.ts']) await writeFile(join(root, file), await readFile(join(here, file)));
  const manifest = { name: 'message-listener', version: '1.0.0', description: '只追加通知事件，不改变工具行为', hooks: './hooks/hooks.json' };
  await json(join(root, tool === 'cc' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json'), manifest);
  const hookNames = tool === 'cc' ? ['Notification', 'Stop', 'SessionEnd'] : ['PermissionRequest', 'Stop', 'SessionEnd'];
  const hooks = Object.fromEntries(hookNames.map(name => [name, [{ ...(name === 'Notification' ? { matcher: 'permission_prompt' } : {}), hooks: [{
    type: 'command', timeout: 1, ...(tool === 'cc' ? { async: true } : {}),
    command: `${shellQuote(node)} ${shellQuote(join(root, 'message-listener.ts'))} --tool ${tool} --inbox ${shellQuote(inbox)} --event ${name} >/dev/null 2>&1 || true`,
  }] }]]));
  await json(join(root, 'hooks/hooks.json'), { hooks });
  await json(join(asset, '.claude-plugin/marketplace.json'), { name: market, owner: { name: 'personal agent' }, plugins: [{ name: 'message-listener', source: './plugins/message-listener' }] });
  await json(join(asset, '.agents/plugins/marketplace.json'), { name: market, interface: { displayName: 'personal agent（本机）' }, plugins: [{ name: 'message-listener', source: { source: 'local', path: './plugins/message-listener' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }] });
}
export interface InstallOptions { home: string; tool: HookTool; inboxDir?: string; command?: string; node?: string }
/** 目标主目录始终必填。CC/Codex 仅通过官方插件命令登记，不直接添加 hooks/settings。 */
export async function installListener(options: InstallOptions): Promise<string> {
  if (!isAbsolute(options.home) || !['cc', 'codex', 'pi'].includes(options.tool)) throw new Error('必须指定绝对 --home 和 --tool cc|codex|pi');
  const { tool } = options;
  if (!options.inboxDir || !isAbsolute(options.inboxDir)) throw new Error('安装必须指定绝对 --inbox');
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const home = await realpath(options.home);
  const asset = join(home, '.message-listener', tool);
  const backupPath = join(home, '.message-listener-backups', `${tool}.json`);
  await noLinkedParents(home, asset);
  await noLinkedParents(home, backupPath);
  if (await exists(backupPath) || await exists(asset)) throw new Error('已有安装或备份；请先卸载/恢复，不覆盖备份');
  const before = await snapshot(home, paths[tool]);
  const backup: Backup = { version: 1, tool, home, paths: paths[tool], before, asset, phase: 'installing',
    ...(tool !== 'pi' ? { command: options.command ?? (tool === 'cc' ? 'claude' : 'codex') } : {}) };
  // 先落完整字节备份（只含白名单配置，不读取 auth、Key 或会话目录），再生成/登记。
  await saveBackup(backupPath, backup);
  try {
    await packageAssets(tool, asset, options.inboxDir, options.node ?? process.execPath);
    if (tool === 'pi') {
      const path = join(home, '.pi/agent/settings.json');
      const settings = await exists(path) ? JSON.parse(await readFile(path, 'utf8')) : {};
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) || (settings.extensions !== undefined && !Array.isArray(settings.extensions))) throw new Error('Pi extensions 配置无效');
      settings.extensions = [...(settings.extensions ?? []), join(asset, 'message-listener.ts')];
      await json(path, settings);
    } else {
      await runPlugin(backup.command!, ['plugin', 'marketplace', 'add', asset], home);
      await runPlugin(backup.command!, ['plugin', tool === 'cc' ? 'install' : 'add', plugin, ...(tool === 'cc' ? ['--scope', 'user'] : [])], home);
    }
    backup.after = await fingerprint(backup);
    backup.phase = 'installed';
    await saveBackup(backupPath, backup);
    return backupPath;
  } catch (error) {
    try {
      backup.after = await fingerprint(backup);
      backup.phase = 'restoring';
      await saveBackup(backupPath, backup);
      await restore(backup, backup.after);
      backup.phase = 'rolled_back';
      backup.after = hash(JSON.stringify(backup.before));
      await saveBackup(backupPath, backup);
      await rm(asset, { recursive: true, force: true });
    } catch {
      backup.phase = 'recovery_required';
      delete backup.after;
      await saveBackup(backupPath, backup).catch(() => {});
      throw new Error('安装失败且恢复未完成；已保留备份和现场，请先备份并人工核对，不能自动卸载恢复');
    }
    // 已完成回滚的备份只能用于清理自己的包，绝不能再次覆盖后来变化的配置。
    throw error;
  }
}
export async function uninstallListener(options: InstallOptions): Promise<void> {
  if (!isAbsolute(options.home) || !['cc', 'codex', 'pi'].includes(options.tool)) throw new Error('必须指定绝对 --home 和 --tool cc|codex|pi');
  const home = await realpath(options.home);
  const backupPath = join(home, '.message-listener-backups', `${options.tool}.json`);
  await noLinkedParents(home, backupPath);
  if (!await exists(backupPath)) return;
  const backup: Backup = JSON.parse(await readFile(backupPath, 'utf8'));
  if (backup.version !== 1 || backup.home !== home || backup.tool !== options.tool || JSON.stringify(backup.paths) !== JSON.stringify(paths[options.tool]) || backup.asset !== join(home, '.message-listener', options.tool)) throw new Error('安装备份身份不匹配，未恢复');
  if (!Array.isArray(backup.before) || backup.before.some(file => typeof file.path !== 'string'
    || file.path !== relative(home, resolve(home, file.path))
    || !backup.paths.some(root => file.path === root || file.path.startsWith(`${root}/`))
    || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777
    || (file.data !== undefined && typeof file.data !== 'string'))) throw new Error('安装备份内容不合法，未恢复');
  const phase = backup.phase ?? (typeof backup.after === 'string' ? 'installed' : 'recovery_required');
  if (phase !== 'installed' && phase !== 'rolled_back') throw new Error('安装/恢复未完成或缺少可核对的状态；保留现场，请先备份并人工恢复');
  if (phase === 'installed') {
    if (typeof backup.after !== 'string' || backup.after !== await fingerprint(backup)) throw new Error('安装后配置另有变化，拒绝覆盖；请先备份并人工合并后卸载');
    try {
      backup.phase = 'restoring';
      await saveBackup(backupPath, backup);
      if (backup.command) {
        await runPlugin(options.command ?? backup.command, ['plugin', options.tool === 'cc' ? 'uninstall' : 'remove', plugin], home).catch(() => {});
        await runPlugin(options.command ?? backup.command, ['plugin', 'marketplace', 'remove', market], home).catch(() => {});
      }
      const expected = await fingerprint(backup);
      await restore(backup, expected);
      backup.phase = 'rolled_back';
      backup.after = hash(JSON.stringify(backup.before));
      await saveBackup(backupPath, backup);
    } catch {
      backup.phase = 'recovery_required';
      delete backup.after;
      await saveBackup(backupPath, backup).catch(() => {});
      throw new Error('卸载恢复未完成；已保留备份和现场，请先备份并人工恢复');
    }
  }
  // rolled_back 可能来自一次失败安装：只清理自己的包和备份登记，不碰配置或插件目录。
  await noLinkedParents(home, backup.asset);
  await rm(backup.asset, { recursive: true, force: true });
  // 备份留存供核对，改名为已卸载，下一次安装可重新备份。
  const removed = `${backupPath}.removed`;
  await rename(backupPath, await exists(removed) ? `${removed}.${randomUUID()}` : removed);
}
