#!/usr/bin/env node
// Offline operator preparation, NOT a model tool. No account/model/PA/Loop calls.
import { lstat, realpath, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), sha = b => createHash('sha256').update(b).digest('hex');
const inside = (a, b) => { const p = relative(a, b); return p === '' || p !== '..' && !p.startsWith('../') && !isAbsolute(p); };
class PreparationError extends Error {}
const fail = message => { throw new PreparationError(message); };
async function regular(path, directory = false, missing = false) {
  try { const s = await lstat(path); if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) fail(`链接/类型/硬链接冲突：${path}`); return s; }
  catch (e) { if (missing && e.code === 'ENOENT') return; throw e; }
}
async function parents(path) {
  for (let p = resolve(path); ; p = dirname(p)) { await regular(p, true, true); if (dirname(p) === p) return; }
}
async function canonicalInput(path, directory = false) { path = resolve(path); const actual = await realpath(path); if (actual !== path) fail(`路径别名冲突：${path}；请使用真实路径`); await parents(dirname(path)); await regular(path, directory); return path; }
async function git(root, args) { return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10000 })).stdout; }
async function replace(path, bytes) {
  await parents(dirname(path)); await regular(path, false, true);
  const temp = `${path}.pa-outputs-${randomUUID()}.tmp`;
  await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await rename(temp, path);
}
async function readOptional(path) { const s = await regular(path, false, true); return s ? readFile(path) : null; }
const optionNames = new Set(['--config', '--pa', '--loop', '--promate', '--idaas', '--run-root', '--backup', '--restore']);
function options(argv) {
  const o = {};
  for (let n = 0; n < argv.length; n++) {
    const key = argv[n]; if (key === '--apply') { o.apply = true; continue; }
    if (!optionNames.has(key) || !argv[n + 1] || argv[n + 1].startsWith('--') || o[key.slice(2)] !== undefined) fail('参数无效；使用 --help 查看。');
    o[key.slice(2)] = argv[++n];
  }
  return o;
}
async function restore(backup) {
  backup = await canonicalInput(backup, true); await regular(join(backup, 'manifest.json')); const m = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
  if (m.version !== 1 || !Array.isArray(m.files)) fail('恢复清单无效。');
  // Check the ENTIRE set first; never erase later operator edits or follow links.
  for (const f of m.files) {
    if (!isAbsolute(f.path) || !/^[a-f0-9]{64}$/.test(f.after) || f.before !== null && !/^[a-f0-9]{64}$/.test(f.before)) fail('恢复清单路径/摘要无效。');
    await parents(dirname(f.path)); const current = await readOptional(f.path), digest = current === null ? null : sha(current);
    if (digest !== f.after && digest !== f.before) fail(`恢复冲突，保留现场：${f.path}`);
    if (f.before !== null) { await regular(join(backup, `${m.files.indexOf(f)}.before`)); const data = await readFile(join(backup, `${m.files.indexOf(f)}.before`)); if (sha(data) !== f.before) fail('备份摘要不匹配。'); }
  }
  for (const [i, f] of m.files.entries()) {
    const current = await readOptional(f.path); if ((current === null ? null : sha(current)) === f.before) continue;
    if (f.before === null) await unlink(f.path); // Only the exact, script-created .gitignore.
    else await replace(f.path, await readFile(join(backup, `${i}.before`)));
  }
  console.log(JSON.stringify({ ok: true, restored: m.files.map(f => f.path), outputsPreserved: true, note: '仅恢复准备配置/忽略规则；产出和目录全部保留，不启停服务。' }));
}
async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：node scripts/prepare-outputs.mjs --config <配置> [--pa <PA真实根>] [--loop <根>] [--promate <根>] [--idaas <根>] [--run-root <约定Loop运行根>] [--apply --backup <尚不存在的备份目录>]\n默认只预检并输出最小变更摘要，不修改文件、不常驻、不接账号/模型。默认项目路径沿主需求；沙盒必须显式传入四个临时项目根。\n获准发布时 --apply：备份配置和 .gitignore，增量准备目录/忽略和项目读+产出写，不开代码派工、不放宽 readAllow/readDeny、不启动或重启。存在冲突先失败，不删除/取消跟踪。\n恢复：node scripts/prepare-outputs.mjs --restore <备份目录>；只恢复仍匹配本次写入摘要的配置/忽略规则，不删产出。'); return;
  }
  const o = options(process.argv.slice(2));
  if (o.restore) { if (Object.keys(o).length !== 1) fail('--restore 不与其他参数混用。'); return restore(o.restore); }
  if (!o.config || o.apply && !o.backup || !o.apply && o.backup) fail('必须指定 --config；--apply 必须同时指定新建 --backup。');
  const configPath = await canonicalInput(o.config), original = await readFile(configPath), config = JSON.parse(original.toString('utf8'));
  // Use the product's existing validator, including unknown fields and all current grants.
  const { loadConfig } = await import('../dist/src/config.js'); const loaded = await loadConfig(configPath);
  const roots = await Promise.all([o.pa ?? '/Users/Admin/Desktop/personal agent', o.loop ?? '/Users/Admin/Desktop/loop', o.promate ?? '/Users/Admin/Desktop/Promate', o.idaas ?? '/Users/Admin/Desktop/IDaaS'].map(p => canonicalInput(p, true)));
  if (new Set(roots).size !== 4 || roots.some((r, i) => roots.some((p, j) => i !== j && inside(p, r)))) fail('四个项目根重复或嵌套。');
  const existingRoots = new Map(loaded.projects.map(p => [p.id, p.root]));
  const pa = config.projects.find(p => existingRoots.get(p.id) === roots[0]); if (!pa) fail('PA 根必须是配置中现有授权项目，不猜测身份。');
  const runRoot = resolve(o['run-root'] ?? join(homedir(), '.pi-autoreview/pipelines'));
  await parents(runRoot);
  const incoming = [...loaded.inboxDirs, ...loaded.loop.eventDirs, loaded.attachmentDir, loaded.dataDir];
  const files = [], plans = [], created = [];
  for (const [i, root] of roots.entries()) {
    if ((await git(root, ['rev-parse', '--show-toplevel'])).trim() !== root) fail(`不是独立 Git 根：${root}`);
    const output = join(root, 'PA产出'); await parents(output); await regular(output, true, true);
    if (i === 0) { await parents(join(output, 'other')); await regular(join(output, 'other'), true, true); }
    if (incoming.some(p => inside(p, output) || inside(output, p))) fail(`产出与监听/附件/数据范围冲突：${output}`);
    if ((await git(root, ['ls-files', '-z', '--', 'PA产出'])).length) fail(`PA产出 已被 Git 跟踪，保留现场、不取消跟踪：${root}`);
    const id = i === 0 ? pa.id : ['loop', 'Promate', 'IDaaS'][i - 1];
    let project = config.projects.find(p => p.id === id || existingRoots.get(p.id) === root);
    if (project && (project.id !== id || existingRoots.get(project.id) !== root)) fail(`项目身份/路径冲突：${id}`);
    const added = !project;
    if (!project) { project = { id, root, loopRunDirs: [runRoot] }; config.projects.push(project); }
    const writeDirs = project.pi?.writeDirs ?? [], skills = project.pi?.skills ?? {};
    project.pi = { writeDirs: [...new Set([...writeDirs, output])], skills };
    if (!project.loopRunDirs.includes(runRoot)) project.loopRunDirs.push(runRoot);
    // A nonempty readAllow is a restriction, never broaden it automatically.
    if (loaded.readAllow.length && !loaded.readAllow.some(p => inside(p, root))) fail(`readAllow 当前不允许项目读取：${id}；未自行放宽。`);
    if (loaded.readDeny.some(p => inside(p, root) || inside(p, output))) fail(`项目或产出命中 readDeny：${id}`);
    const ignore = join(root, '.gitignore'), before = await readOptional(ignore);
    const text = before?.toString('utf8') ?? '', after = /(?:^|\n)\/PA产出\/(?:\r?\n|$)/.test(text) ? before : Buffer.from(text + (text && !text.endsWith('\n') ? '\n' : '') + '/PA产出/\n');
    if (after && (before === null || !after.equals(before))) files.push({ path: ignore, before, bytes: after });
    plans.push({ id, root, output, added, codeDispatchAdded: false, existingCodeDispatch: !!project.loop });
  }
  if (config.outputs && config.outputs.otherProject !== pa.id) fail('outputs.otherProject 与既有配置冲突。');
  config.outputs = { otherProject: pa.id };
  const afterConfig = Buffer.from(JSON.stringify(config, null, 2) + '\n');
  if (!original.equals(afterConfig)) files.push({ path: configPath, before: original, bytes: afterConfig });
  if (!o.apply) { console.log(JSON.stringify({ ok: true, mode: 'preflight', projects: plans, changes: files.map(f => f.path), otherProject: pa.id, formalEnabled: false, note: '未改任何项目/配置；启用须另获发布授权。' })); return; }
  const backup = resolve(o.backup); await parents(dirname(backup));
  if ([...roots, ...incoming].some(p => inside(p, backup))) fail('备份目录不能放在授权项目、监听或数据/附件目录中。');
  await mkdir(backup, { mode: 0o700 });
  const manifest = { version: 1, at: new Date().toISOString(), files: files.map(f => ({ path: f.path, before: f.before === null ? null : sha(f.before), after: sha(f.bytes) })), created };
  for (const [i, file] of files.entries()) if (file.before !== null) await writeFile(join(backup, `${i}.before`), file.before, { flag: 'wx', mode: 0o600 });
  await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    for (const file of files) {
      const current = await readOptional(file.path); if ((current === null ? null : sha(current)) !== (file.before === null ? null : sha(file.before))) fail(`预检后文件变化，未覆盖：${file.path}`);
      await replace(file.path, file.bytes);
    }
    for (const p of [...plans.map(p => p.output), join(plans[0].output, 'other')]) {
      await parents(p); if (!await regular(p, true, true)) { await mkdir(p, { mode: 0o700 }); created.push(p); }
    }
    await loadConfig(configPath);
    for (const p of plans) {
      if ((await git(p.root, ['ls-files', '-z', '--', 'PA产出'])).length) fail(`启用后发现跟踪冲突：${p.root}`);
      await git(p.root, ['check-ignore', '--no-index', '--', 'PA产出/.pa-output-probe']);
    }
    console.log(JSON.stringify({ ok: true, mode: 'prepared', backup, projects: plans, otherProject: pa.id, restarted: false, note: '准备完成，尚未重载正式权限；由协调方在获准发布时正常重启。' }));
  } catch (error) { console.error(JSON.stringify({ ok: false, category: 'preparation_incomplete', backup, note: '准备部分失败，保留现场；用 --restore 恢复，不删产出或取消跟踪。' })); throw error; }
}
main().catch(error => { console.error(JSON.stringify({ ok: false, error: error instanceof PreparationError ? error.message : '预检/准备/恢复失败（配置内容不回显）；请检查路径、链接、Git跟踪、readAllow/readDeny 或备份摘要冲突。' })); process.exitCode = 1; });
