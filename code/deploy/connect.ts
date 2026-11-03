#!/usr/bin/env node
/** 默认只读预检；不扫描数据/凭据、不启动模型。应用/回退均需显式动作与独立备份目录。 */
import { lstat, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRegularFile, validateConfig } from '../src/core/config.ts';
import { exclusiveText, safeDirectory } from '../src/core/scoped-files.ts';
import { within } from '../src/core/read-sandbox.ts';
import { hash, object } from '../src/core/utils.ts';
import { decodeJson } from '../src/core/protocol-json.ts';
import { launchdPlist, heartbeatPlist, serviceLabel, heartbeatLabel } from '../src/service/launchd.ts';
import { runCommand } from '../src/core/process.ts';

type Entry = { path: string; kind: 'service' | 'heartbeat' };
interface Change { path: string; before: string | null; after: string; mode: number }
interface Manifest { schema: 1; config: string; changes: Change[]; entries: Entry[]; reloaded?: boolean }
async function optional(path: string): Promise<string | null> {
  if (/^\.env(?:\.|$)/i.test(basename(path))) throw new Error('部署不读取或备份.env凭据文件');
  try { await safeDirectory(dirname(path)); await assertRegularFile(path); return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function path(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`${label}须为显式绝对路径`);
  return resolve(value);
}
function noInlineSecrets(raw: unknown) {
  if (!raw || typeof raw !== 'object') return;
  for (const [key, value] of Object.entries(raw)) {
    if (/^(?:api_?key|access_?token|refresh_?token|userAccessToken|appSecret|password|secret|FEISHU_.+(?:TOKEN|SECRET))$/i.test(key)) throw new Error('配置含内联凭据；请先改为外部.env引用，不备份/输出秘密');
    noInlineSecrets(value);
  }
}
export async function deploymentPlan(configPath: string, settingsPath: string) {
  configPath = path(configPath, '--config'); settingsPath = path(settingsPath, '--settings');
  const before = await optional(configPath); if (before === null) throw new Error('须先有显式PA配置；不推导个人目录或账号');
  const raw = object(decodeJson(before), '原配置'), settings = object(decodeJson((await optional(settingsPath))!), '部署设置');
  noInlineSecrets(raw); noInlineSecrets(settings);
  if (Object.keys(settings).some(key => !['patch', 'loopConfig', 'entries', 'launchctl'].includes(key))) throw new Error('部署设置含未知字段');
  const patch = object(settings.patch ?? {}, 'patch');
  if (Object.keys(patch).some(key => !['worker', 'piWorker', 'dispatch', 'loopEvents', 'sidebar', 'workspace', 'schedule'].includes(key))) throw new Error('部署不允许改数据、旧输入前缀、凭据引用或原启动方式');
  const candidate = { ...raw, ...patch };
  for (const key of ['sidebar', 'workspace', 'schedule']) if (raw[key] != null && patch[key] != null && JSON.stringify(raw[key]) !== JSON.stringify(patch[key])) throw new Error(`已开启的${key}配置必须原样保留；不要用部署覆盖`);
  if (raw.dispatch && patch.dispatch) {
    const supplied = patch.dispatch.projects;
    if (!Array.isArray(supplied) || raw.dispatch.projects?.some((old: any) => !supplied.some((project: any) => JSON.stringify(project) === JSON.stringify(old)))) throw new Error('部署不能移除/改写既有项目范围');
    for (const [key, value] of Object.entries(raw.dispatch.skills ?? {})) if (patch.dispatch.skills?.[key] !== value) throw new Error('部署不能移除/改写既有skill映射');
  }
  // 首次应用冻结下界；重复应用沿用已经落盘的值，绝不重新回灌。
  if (candidate.loopEvents && !candidate.loopEvents.since) candidate.loopEvents = { ...candidate.loopEvents, since: raw.loopEvents?.since ?? new Date().toISOString() };
  if (raw.loopEvents?.since && patch.loopEvents && !patch.loopEvents.since) candidate.loopEvents.since = raw.loopEvents.since;
  const config = await validateConfig(candidate), changes: Change[] = [];
  const add = async (target: string, content: string) => {
    target = path(target, '变更文件');
    const old = await optional(target);
    if (old === content) return;
    changes.push({ path: target, before: old, after: content, mode: old === null ? 0o600 : (await lstat(target)).mode & 0o777 });
  };
  await add(configPath, JSON.stringify(candidate, null, 2) + '\n');
  if (settings.loopConfig) {
    if (!config.loopEvents) throw new Error('Loop出口设置缺少loopEvents');
    const target = path(settings.loopConfig, 'loopConfig');
    if (target === configPath || target === settingsPath) throw new Error('配置路径不能复用');
    const previous = await optional(target), loop = previous === null ? {} : object(decodeJson(previous), 'Loop配置'); noInlineSecrets(loop);
    if (loop.pa?.eventsDir && loop.pa.eventsDir !== config.loopEvents.dir) throw new Error('已有Loop事件出口不能被部署重定向；请沿用原目录，保留原输入前缀');
    await add(target, JSON.stringify({ ...loop, pa: { ...(loop.pa ?? {}), eventsDir: config.loopEvents.dir } }, null, 2) + '\n');
  }
  const entries: Entry[] = [];
  if (!Array.isArray(settings.entries ?? [])) throw new Error('entries须为显式入口数组');
  for (const item of settings.entries ?? []) {
    if (!['service', 'heartbeat'].includes(item.kind)) throw new Error('入口类型不合法');
    const entry: Entry = { kind: item.kind, path: path(item.path, 'entry.path') }, current = await optional(entry.path);
    if (entries.some(old => old.path === entry.path || old.kind === entry.kind)) throw new Error('部署入口重复');
    if (current !== null) {
      const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
      const command = entry.kind === 'service' ? 'daemon' : 'heartbeat-check';
      if (!current.includes(`<string>${xml(configPath)}</string>`) || !current.includes(`<string>${command}</string>`)) throw new Error('已有同名入口不是本配置的原启动入口；拒绝覆盖');
    } else await add(entry.path, entry.kind === 'service' ? launchdPlist(configPath, config.dataDir) : heartbeatPlist(configPath, config));
    entries.push(entry);
  }
  if (new Set(changes.map(row => row.path)).size !== changes.length) throw new Error('部署目标重复');
  for (const change of changes) for (const root of [config.dataDir, config.loopEvents?.dir, config.inboxDir, config.workspace?.inboxDir].filter((root): root is string => !!root)) if (within(root, change.path)) throw new Error('部署文件不得混入数据/输入目录');
  const missing: string[] = [];
  if (!config.worker || config.worker.protocol !== 'loop-v1') missing.push('真实Loop worker未配置');
  if (!config.loopEvents || !settings.loopConfig) missing.push('官方事件出口/Loop配置引用未齐');
  if (!config.piWorker || config.piWorker.protocol !== 'pi-v1') missing.push('真实Pi未配置');
  if (!config.dispatch?.projects.length) missing.push('本人配置的项目/开发空间/Loop范围');
  if (!config.piWorker?.transcriber) missing.push('本地转写工具及已有模型文件（不自动下载）');
  else for (const tool of Object.values(config.piWorker.transcriber)) if (await lstat(tool).then(stat => stat.size > 0, () => false) === false) missing.push('本地转写工具或模型文件不存在');
  missing.push('日历/妙记用户授权未由本预检读取或验证；应用凭据不代表用户授权', 'Loop当前执行端预期目标绑定/推送秘密扫描未就绪，PA拒绝推送/合入', '真实账号与飞书任务往返、模型质量待用户体验');
  return { config, settings, changes, entries, missing, summary: { mode: 'preflight', changes: changes.map(row => row.path), entries, missing, dataUntouched: true, credentialsNotRead: true } };
}
async function replace(change: Change, reverse = false) {
  const expected = reverse ? change.after : change.before, desired = reverse ? change.before : change.after;
  const current = await optional(change.path);
  if (current !== expected) throw new Error('配置/入口在检查后变化，保留现场，未覆盖');
  if (desired === null) { await unlink(change.path); return; }
  const dir = await safeDirectory(dirname(change.path), true), temp = join(dir, `.pa-deploy-${hash(change.path).slice(0, 12)}.tmp`);
  await exclusiveText(temp, desired);
  // 原文件独立留在manifest；重检后原子替换，不跟随目标链接。
  if (await optional(change.path) !== expected) throw new Error('目标在写入前变化；保留部署临时文件');
  const { chmod } = await import('node:fs/promises'); await chmod(temp, change.mode);
  await rename(temp, change.path);
}
async function reload(entries: Entry[], executable: string) {
  const domain = `gui/${process.getuid?.() ?? 0}`;
  for (const entry of entries) {
    const label = entry.kind === 'service' ? serviceLabel : heartbeatLabel;
    const result = await runCommand(executable, ['print', `${domain}/${label}`], 10000);
    const registered = /^\s*path\s*=\s*(.*?)\s*$/m.exec(result)?.[1]?.replace(/^"|"$/g, '');
    if (registered !== entry.path) throw new Error('launchd活动入口不属于这次明确配置，未重载');
  }
  for (const entry of entries) await runCommand(executable, ['kickstart', '-k', `${domain}/${entry.kind === 'service' ? serviceLabel : heartbeatLabel}`], 10000);
}
export async function applyDeployment(configPath: string, settingsPath: string, backup: string, restart = false) {
  const plan = await deploymentPlan(configPath, settingsPath);
  backup = path(backup, '--backup');
  for (const root of [plan.config.dataDir, plan.config.inboxDir, plan.config.loopEvents?.dir, plan.config.workspace?.inboxDir].filter((root): root is string => !!root)) if (within(root, backup) || within(backup, root)) throw new Error('备份目录须独立于数据和输入');
  if (!plan.changes.length) return { ...plan.summary, mode: 'unchanged', backup: null, reloaded: false };
  await safeDirectory(dirname(backup), true); await mkdir(backup, { mode: 0o700 });
  const manifest: Manifest = { schema: 1, config: resolve(configPath), changes: plan.changes, entries: plan.entries, reloaded: restart };
  await exclusiveText(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const change of plan.changes) await replace(change);
  if (restart) await reload(plan.entries, plan.settings.launchctl ?? '/bin/launchctl');
  return { ...plan.summary, mode: 'applied', backup, reloaded: restart, note: '配置已应用不等于服务已启动或账号授权；数据未迁移。回退使用本备份。' };
}
export async function rollbackDeployment(backup: string, launchctl?: string) {
  const text = await optional(join(path(backup, '--rollback'), 'manifest.json')), raw = object(decodeJson(text!), '部署备份');
  if (raw.schema !== 1 || !Array.isArray(raw.changes) || !Array.isArray(raw.entries) || raw.reloaded !== undefined && typeof raw.reloaded !== 'boolean') throw new Error('备份格式不合法');
  const changes: Change[] = raw.changes.map((value: unknown) => {
    const row = object(value, '备份变更');
    if (row.before !== null && typeof row.before !== 'string' || typeof row.after !== 'string' || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777) throw new Error('备份变更格式不合法');
    return { path: path(row.path, '备份目标'), before: row.before, after: row.after, mode: row.mode };
  });
  const entries: Entry[] = raw.entries.map((value: unknown) => {
    const row = object(value, '备份入口'); if (!['service', 'heartbeat'].includes(row.kind)) throw new Error('备份入口类型不合法');
    return { path: path(row.path, '备份入口'), kind: row.kind };
  });
  if (new Set(changes.map(row => row.path)).size !== changes.length) throw new Error('备份变更目标重复');
  const manifest: Manifest = { schema: 1, config: path(raw.config, '备份配置'), changes, entries, reloaded: raw.reloaded };
  // 先核对全部目标，再还原；别人修改的文件一律不碰。已回退可重复执行。
  for (const change of manifest.changes) { const current = await optional(change.path); if (current !== change.after && current !== change.before) throw new Error('部署后有他人修改，拒绝自动回退'); }
  for (const change of [...manifest.changes].reverse()) if (await optional(change.path) !== change.before) await replace(change, true);
  if (launchctl && manifest.reloaded) await reload(manifest.entries.filter(entry => !manifest.changes.some(change => change.path === entry.path && change.before === null)), launchctl);
  return { mode: 'rolled_back', config: manifest.config, dataUntouched: true, note: '只还原本次配置/新入口；原数据和已执行业务不回滚。代码回退另走合入提交revert。' };
}
async function main() {
  const args = process.argv.slice(2), options = new Map<string, string>(), flags = new Set<string>();
  while (args.length) {
    const name = args.shift()!; if (options.has(name) || flags.has(name)) throw new Error('参数重复');
    if (['--apply', '--reload'].includes(name)) flags.add(name);
    else if (['--config', '--settings', '--backup', '--rollback', '--launchctl'].includes(name) && args[0] && !args[0].startsWith('--')) options.set(name, args.shift()!);
    else throw new Error('用法：connect.ts --config <绝对路径> --settings <绝对路径> [--apply --backup <新目录> [--reload]]；或 --rollback <备份目录> [--launchctl <显式入口>]');
  }
  if (options.has('--rollback')) { if (flags.size || options.has('--config') || options.has('--settings')) throw new Error('回退不可与应用混用'); return rollbackDeployment(options.get('--rollback')!, options.get('--launchctl')); }
  if (!options.has('--config') || !options.has('--settings') || flags.has('--reload') && !flags.has('--apply')) throw new Error('缺少显式配置/设置，或重载未明确应用');
  return flags.has('--apply') ? applyDeployment(options.get('--config')!, options.get('--settings')!, options.get('--backup')!, flags.has('--reload')) : (await deploymentPlan(options.get('--config')!, options.get('--settings')!)).summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(`部署未完成：${error instanceof SyntaxError ? '配置不是合法JSON（未输出内容）' : error instanceof Error ? error.message : '检查失败'}。保留备份和现场，不自动重试。`); process.exitCode = 1; });
