import { chmod, lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertRegularFile, loadConfig } from '../core/config.ts';
import { withNamedLock } from '../core/locks.ts';
import { componentPath, runCommand } from '../core/process.ts';
import { appendJsonl, readJsonl } from '../core/store.ts';
import { hash } from '../core/utils.ts';

export const serviceLabel = 'local.personal-agent';
interface Installation { target: string; plistHash: string; created: string[]; active: boolean; launchctl?: string; removed: boolean; at: string }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function contains(a: string, b: string) { const diff = relative(a, b); return diff === '' || (!diff.startsWith('../') && diff !== '..' && !isAbsolute(diff)); }
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return join(await canonical(dirname(path)), path.slice(dirname(path).length)); }
}
async function exists(path: string) { try { return await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }
export function launchdPlist(configPath: string, dataDir: string): string {
  const cli = resolve(import.meta.dirname, '../cli/main.ts');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel}</string>
<key>ProgramArguments</key><array>${[process.execPath, cli, 'daemon', '--config', configPath].map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(resolve(import.meta.dirname, '../..'))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(componentPath())}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(dataDir, 'launchd.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(dataDir, 'launchd.stderr.log'))}</string>
</dict></plist>\n`;
}
export async function installService(configPathInput: string, targetInput: string, activate = false, launchctl = '/bin/launchctl'): Promise<void> {
  if (!isAbsolute(targetInput) || !isAbsolute(configPathInput)) throw new Error('--target 和 --config 必须是绝对路径');
  const configPath = resolve(configPathInput), target = resolve(targetInput), config = await loadConfig(configPath);
  const targetPath = await canonical(target);
  for (const path of [config.dataDir, config.inboxDir, ...Object.values(config.sources)].filter((p): p is string => p !== null)) {
    const other = await canonical(path);
    if (contains(other, targetPath) || contains(targetPath, other)) throw new Error('launchd 目标目录须独立于数据、来源和推送目录');
  }
  await withNamedLock(config.dataDir, '.launchd.lock', async () => {
    const journal = join(config.dataDir, 'launchd-installations.jsonl');
    const history = await readJsonl<Installation>(journal);
    if (history.findLast(row => row.target === target)?.removed === false) throw new Error('该目标已有安装记录，请先卸载');
    const plist = join(target, `${serviceLabel}.plist`);
    if (await exists(plist)) throw new Error('目标已有同名 plist，拒绝覆盖；原目录未改动');
    const created: string[] = [];
    let path = target;
    while (!await exists(path)) { created.unshift(path); path = dirname(path); }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('目标不是普通目录，拒绝安装');
    const content = launchdPlist(configPath, config.dataDir);
    let activationAttempted = false, activated = false;
    try {
      for (const directory of created) await mkdir(directory, { mode: 0o700 });
      await writeFile(plist, content, { flag: 'wx', mode: 0o600 });
      await chmod(plist, 0o600);
      if (activate) {
        activationAttempted = true;
        await runCommand(launchctl, ['bootstrap', `gui/${process.getuid?.() ?? 0}`, plist], 10000);
        activated = true;
      }
      await appendJsonl(journal, [{ target, plistHash: hash(content), created, active: activate, launchctl, removed: false, at: new Date().toISOString() } satisfies Installation]);
    } catch (error) {
      // bootstrap 失败/超时不能证明当前同名服务属于这次安装，绝不按 label 误停旧服务。
      if (activationAttempted && !activated) throw new Error('launchd 激活未确认，保留 plist 供人工核对；未停止任何已有服务');
      if (activated) {
        try { await runCommand(launchctl, ['bootout', `gui/${process.getuid?.() ?? 0}`, plist], 10000); }
        catch { throw new Error('launchd 安装/激活未完成，状态不明；请保留目标和日志并人工核对'); }
      }
      if (await exists(plist) && hash(await readFile(plist, 'utf8')) === hash(content)) await unlink(plist);
      for (const directory of created.reverse()) await rmdir(directory);
      throw error;
    }
  });
}
export async function uninstallService(configPath: string, targetInput: string, launchctl?: string): Promise<void> {
  if (!isAbsolute(targetInput)) throw new Error('--target 必须是绝对路径');
  const config = await loadConfig(configPath), target = resolve(targetInput);
  await withNamedLock(config.dataDir, '.launchd.lock', async () => {
    const journal = join(config.dataDir, 'launchd-installations.jsonl');
    const history = await readJsonl<Installation>(journal);
    const installation = history.findLast(row => row.target === target);
    if (!installation || installation.removed) {
      if (await exists(join(target, `${serviceLabel}.plist`))) throw new Error('目标存在未登记或状态不明的 plist；保留现场，不自动卸载');
      return;
    }
    const targetStat = await lstat(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('目标目录变化，拒绝卸载');
    const plist = join(target, `${serviceLabel}.plist`);
    await assertRegularFile(plist);
    if (hash(await readFile(plist, 'utf8')) !== installation.plistHash) throw new Error('plist 安装后有改动，拒绝删除；请先备份并人工核对');
    if (installation.active) {
      const command = launchctl ?? installation.launchctl ?? '/bin/launchctl', domain = `gui/${process.getuid?.() ?? 0}`;
      let current: string;
      try { current = await runCommand(command, ['print', `${domain}/${serviceLabel}`], 10000); }
      catch { throw new Error('无法确认当前 launchd 服务归属；保留 plist，未停止任何服务'); }
      const registeredPath = /^\s*path\s*=\s*(.*?)\s*$/m.exec(current)?.[1]?.replace(/^"|"$/g, '');
      if (!registeredPath || !isAbsolute(registeredPath) || await canonical(registeredPath) !== await canonical(plist)) throw new Error('当前同名 launchd 服务不属于此安装；保留 plist，未停止服务');
      await runCommand(command, ['bootout', domain, plist], 10000);
    }
    await unlink(plist);
    for (const directory of [...installation.created].reverse()) {
      try { await rmdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
    }
    await appendJsonl(journal, [{ ...installation, removed: true, at: new Date().toISOString() }]);
  });
}
