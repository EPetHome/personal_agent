import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { validateConfig } from '../src/core/config.ts';
import { event } from '../src/core/events.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { acquireLock } from '../src/core/locks.ts';
import { ccAnswer, ccCall, ccUser, piHeader, piMessage, codexMeta, codexEvent, put, putLoop, sandbox, unmanaged, start } from './fixtures.ts';
for (const [tool, rows] of [['cc', [ccUser(), ccCall(), ccAnswer()]], ['codex', [codexMeta(), codexEvent({ type: 'user_message', message: '构造任务' })]],
  ['pi', [piHeader(), piMessage('u', null, 'user', '构造任务')]]] as const)
  test(`减法：${tool}完成/停滞/问句都不扫描、不出卡、不调模型`, async t => { await unmanaged(t, tool, [...rows]); });
async function fixture(t: { after(fn: () => Promise<unknown>): void }) { const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true })); await putLoop(f.config, f.root); return f; }
test('loop暂停与完成保留、原文/次数/欠项/回看齐全、重复检测不重发', async t => {
  const f = await fixture(t); await detect(f.config, start); let out = await readOutbox(f.config.dataDir); assert.equal(out.length, 1); assert.equal(out[0]!.kind, 'loop_paused');
  assert.match(out[0]!.text, /评审 3 次，返修 2 次/); assert.match(out[0]!.text, /构造人工项/); assert.match(out[0]!.content.returnCommand, /^open /);
  await putLoop(f.config, f.root, '完成'); await detect(f.config, '2026-10-20T10:01:00Z'); await rebuild(f.config); await detect(f.config, '2026-10-20T10:02:00Z');
  out = await readOutbox(f.config.dataDir); assert.equal(out.length, 2); assert.equal(out[1]!.kind, 'loop_completed');
});
test('状态缺失/损坏仍从事件重建，删除发件索引后只补已提交loop决策', async t => {
  const f = await fixture(t); await detect(f.config, start); const before = await readOutbox(f.config.dataDir), events = await readEvents(f.config.dataDir);
  await writeFile(join(f.config.dataDir, 'state.json'), '{broken'); await rm(join(f.config.dataDir, 'outbox.jsonl')); await rebuild(f.config); await detect(f.config, start);
  assert.deepEqual(await readOutbox(f.config.dataDir), before); assert.ok(events.length > 0); assert.equal((await overview(f.config)).records[0]!.tool, 'loop');
});
for (const broken of ['{broken\n', JSON.stringify(event({ kind: 'scan_completed' }, start))]) test('损坏事件/半行不继续追加、不覆盖现场', async t => {
  const f = await fixture(t); const path = join(f.config.dataDir, 'events.jsonl'); await put(path, broken); await assert.rejects(detect(f.config, start)); assert.equal(await readFile(path, 'utf8'), broken);
});
test('loop来源路径损坏仍报警；CC目录错误完全忽略', async t => {
  const f = await fixture(t); f.config.sources.loop = join(f.root, 'missing-loop'); f.config.sources.cc = join(f.root, 'missing-cc');
  const view = await detect(f.config, start); assert.deepEqual([...view.projection.health.keys()], ['loop']); const [notice] = await readOutbox(f.config.dataDir); assert.equal(notice!.kind, 'blind'); assert.equal(notice!.tool, 'loop');
});
test('数据目录与仍启用的loop/转达来源不能重叠，包含符号链接别名', async t => {
  const f = await fixture(t); await assert.rejects(validateConfig({ ...f.config, dataDir: join(f.config.sources.loop!, 'nested') }), /不能重叠/);
  const alias = join(f.root, 'alias'); await symlink(f.config.sources.loop!, alias); await assert.rejects(validateConfig({ ...f.config, dataDir: join(alias, 'new') }), /不能重叠/);
});
for (const kind of ['symlink', 'hardlink']) test(`数据文件${kind}拒绝写入，不破坏原件`, async t => {
  const f = await fixture(t), target = join(f.root, 'untouched'); await writeFile(target, '原件'); await mkdir(f.config.dataDir);
  if (kind === 'symlink') await symlink(target, join(f.config.dataDir, 'events.jsonl')); else await link(target, join(f.config.dataDir, 'events.jsonl'));
  await assert.rejects(detect(f.config, start)); assert.equal(await readFile(target, 'utf8'), '原件');
});
test('检测不绕过活锁；无配置CLI非0且不生成文件', async t => {
  const f = await fixture(t), release = await acquireLock(f.config.dataDir, '.detect.lock'); try { await assert.rejects(detect(f.config, start), /锁|正在/); } finally { await release(); }
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), 'detect'], { cwd: f.root, encoding: 'utf8', env: { ...process.env, HOME: f.root } }); assert.notEqual(result.status, 0); assert.match(result.stderr, /请先配置/);
});
test('不自动迁移格式/归档/清理旧临时文件，旧日志只追加新事实', async t => {
  const f = await fixture(t), raw = JSON.stringify(event({ kind: 'scan_completed' }, '2026-09-01T10:00:00Z')) + '\n';
  await put(join(f.config.dataDir, 'events.jsonl'), raw); await put(join(f.config.dataDir, '.state-old.tmp'), '旧文件'); await detect(f.config, start);
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(raw)); assert.equal(await readFile(join(f.config.dataDir, '.state-old.tmp'), 'utf8'), '旧文件');
});
