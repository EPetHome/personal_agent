#!/usr/bin/env node
// Offline preparation only. Never starts/reloads Pi or changes permissions/launchers.
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { digest, decodeJson, safePath, readPrivate, atomicWrite, validateConfig } from './pi-observer.mjs';

const fail = () => { throw new Error('preparation_invalid_or_conflict'); };
const inside = (root, path) => { const p = relative(root, path); return p === '' || p !== '..' && !p.startsWith('../') && !isAbsolute(p); };
const hash = bytes => bytes === null ? null : digest(bytes);
function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (Object.hasOwn(result, key)) fail();
    if (['--apply', '--disable'].includes(key)) result[key] = true;
    else if (['--config', '--loader', '--settings', '--backup', '--restore'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) result[key] = resolve(argv[++i]);
    else fail();
  }
  return result;
}
async function restore(backup, apply) {
  await safePath(backup, { directory: true, privateMode: true });
  const manifest = decodeJson(await readPrivate(join(backup, 'manifest.json')));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 3) fail();
  const files = [];
  // Validate the complete set before changing anything. Backups are not commands.
  for (const [i, f] of manifest.files.entries()) {
    if (typeof f.path !== 'string' || !isAbsolute(f.path) || inside(backup, f.path) || !/^[a-f0-9]{64}$/.test(f.after) || f.before !== null && !/^[a-f0-9]{64}$/.test(f.before) || !Number.isInteger(f.mode) || f.mode < 0 || f.mode > 0o777) fail();
    const current = await readPrivate(f.path, { optional: true, privateMode: false });
    const info = await safePath(f.path, { missing: true });
    if (hash(current) !== f.before && hash(current) !== f.after || info && (info.mode & 0o777) !== f.mode) fail();
    const before = f.before === null ? null : await readPrivate(join(backup, `${i}.before`));
    if (hash(before) !== f.before) fail();
    files.push({ ...f, beforeBytes: before, current });
  }
  if (new Set(files.map(f => f.path)).size !== files.length) fail();
  if (apply) for (const f of files) {
    const current = await readPrivate(f.path, { optional: true, privateMode: false });
    const info = await safePath(f.path, { missing: true });
    if (hash(current) !== hash(f.current) || info && (info.mode & 0o777) !== f.mode) fail();
    if (hash(current) === f.before) continue;
    if (f.beforeBytes === null) await unlink(f.path);
    else await atomicWrite(f.path, f.beforeBytes, f.mode);
  }
  return { ok: true, mode: apply ? 'restored' : 'restore-preflight', changes: files.map(f => f.path), preservedExportRecords: true, loaded: false };
}
export async function prepare(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return {
    usage: 'node scripts/prepare-pi-observer.mjs --config <私有观察授权JSON> --loader <指定.mjs> [--settings <指定settings.json>] [--disable] [--apply --backup <新目录>] | --restore <备份目录> [--apply]',
    note: '默认只预检，包括恢复；显式 --apply 才写。只生成明确授权的加载器/增量登记路径；不扫描凭据/会话、不加载/重载、不改 auto/yolo/deny/模型/启动器。--disable 关闭授权并移除指定加载项；原 Pi 继续工作。备份目录及导出记录保留。',
  };
  const o = options(argv), apply = !!o['--apply'];
  if (o['--restore']) {
    if (Object.keys(o).some(k => !['--restore', '--apply'].includes(k))) fail();
    return restore(o['--restore'], apply);
  }
  const configPath = o['--config'], loaderPath = o['--loader'], settingsPath = o['--settings'];
  if (!configPath || !loaderPath || !loaderPath.endsWith('.mjs') || apply !== Boolean(o['--backup'])) fail();
  const configBytes = await readPrivate(configPath), config = await validateConfig(decodeJson(configBytes), { allowMissingRoot: true });
  if (!o['--disable'] && !config.enabled) fail();
  const rootExists = !!await safePath(config.exportRoot, { directory: true, missing: true, privateMode: true });
  if (inside(config.exportRoot, configPath) || inside(config.exportRoot, loaderPath) || settingsPath && inside(config.exportRoot, settingsPath)) fail();
  const targets = [configPath, loaderPath, settingsPath].filter(Boolean);
  if (new Set(targets).size !== targets.length) fail();
  const loaderBefore = await readPrivate(loaderPath, { optional: true, privateMode: false });
  const extensionUrl = new URL('./pi-observer.mjs', import.meta.url).href;
  const loaderBytes = Buffer.from(`// Prepared PA observer only; does not change Pi permissions or model.\nimport observer from ${JSON.stringify(extensionUrl)};\nexport default pi => observer(pi, { configPath: ${JSON.stringify(configPath)} });\n`);
  // Never overwrite an unrelated module. A different path/scope is an operator conflict.
  if (loaderBefore !== null && !loaderBefore.equals(loaderBytes)) fail();
  const files = [];
  const plan = async (path, before, bytes, privateMode = false) => {
    if (before?.equals(bytes)) return;
    const s = await safePath(path, { missing: true, privateMode });
    files.push({ path, before, bytes, mode: s ? s.mode & 0o777 : 0o600 });
  };
  if (o['--disable']) await plan(configPath, configBytes, Buffer.from(JSON.stringify({ ...config, enabled: false }, null, 2) + '\n'), true);
  else await plan(loaderPath, loaderBefore, loaderBytes);
  if (settingsPath) {
    if (!settingsPath.endsWith('/settings.json')) fail();
    const before = await readPrivate(settingsPath, { privateMode: false }), settings = decodeJson(before);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || settings.extensions !== undefined && (!Array.isArray(settings.extensions) || settings.extensions.some(s => typeof s !== 'string'))) fail();
    const old = settings.extensions ?? [];
    let extensions = old;
    if (o['--disable']) extensions = old.filter(s => s !== loaderPath);
    else if (!old.includes(loaderPath)) extensions = [...old, loaderPath];
    // Unknown existing settings (including permission-extension settings) remain byte-equivalent values.
    if (JSON.stringify(old) !== JSON.stringify(extensions)) await plan(settingsPath, before, Buffer.from(JSON.stringify({ ...settings, extensions }, null, 2) + '\n'));
  }
  const changes = files.map(f => ({ path: f.path, before: hash(f.before), after: digest(f.bytes) }));
  const result = { ok: true, mode: apply ? 'prepared' : 'preflight', action: o['--disable'] ? 'disable' : 'enable', changes,
    createExportRoot: !rootExists && !o['--disable'] ? config.exportRoot : null,
    extensionArgument: ['-e', loaderPath], loaded: false, reloaded: false, originalWorkUnchanged: true,
    note: '准备不等于接通。仅在另获加载授权、原工作已空闲时按原入口 /reload 并核对原 session ID；忙碌/不支持安全重载则保留未接通，不重派。' };
  if (!apply) return result;
  const backup = o['--backup'];
  await safePath(backup, { directory: true, missing: true });
  if ([...targets, config.exportRoot, fileURLToPath(new URL('.', import.meta.url))].some(p => inside(p, backup) || inside(backup, p))) fail();
  await mkdir(backup, { mode: 0o700 });
  const manifest = { version: 1, files: files.map(f => ({ path: f.path, before: hash(f.before), after: digest(f.bytes), mode: f.mode })) };
  for (const [i, f] of files.entries()) if (f.before !== null) await writeFile(join(backup, `${i}.before`), f.before, { mode: 0o600, flag: 'wx' });
  await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    const unchanged = async f => {
      const current = await readPrivate(f.path, { optional: true, privateMode: false }), info = await safePath(f.path, { missing: true });
      if (hash(current) !== hash(f.before) || info && (info.mode & 0o777) !== f.mode) fail();
    };
    // Full precondition check after backup, before the first target write.
    for (const f of files) await unchanged(f);
    if (!rootExists && !o['--disable']) await mkdir(config.exportRoot, { mode: 0o700 });
    for (const f of files) {
      await unchanged(f);
      await atomicWrite(f.path, f.bytes, f.mode);
    }
  } catch { return { ok: false, mode: 'preparation-incomplete', backup, note: '保留现场；用 --restore 预检，再 --restore ... --apply 按前后摘要恢复，不覆盖后改。', loaded: false }; }
  return { ...result, backup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepare(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result)); if (result.ok === false) process.exitCode = 1; }).catch(() => {
    console.error(JSON.stringify({ ok: false, error: '观察准备/恢复拒绝：检查显式范围、普通文件/私有权限、路径别名或前后摘要冲突；未加载扩展，未回显配置内容。' })); process.exitCode = 1;
  });
}
