import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cc } from '../src/sources/cc/index.ts';
import { codex } from '../src/sources/codex/index.ts';
import { pi } from '../src/sources/pi/index.ts';
import { detect } from '../src/core/agent.ts';
import { isIgnoredProject, validateConfig } from '../src/core/config.ts';
import { readOutbox } from '../src/core/store.ts';
import { truncateText, truncateUtf8 } from '../src/core/utils.ts';
import { ccAnswer, ccUser, codexMeta, codexEvent, piHeader, piMessage, sandbox, put, putLoop, unmanaged, start } from './fixtures.ts';
for (const source of [cc, codex, pi]) test(`保留旧原件解析：${source.tool}未知元数据不污染意图与活动`, () => {
  const rows = source.tool === 'cc' ? [ccUser('构造任务'), { type: 'future-metadata' }, ccAnswer()]
    : source.tool === 'codex' ? [codexMeta(), { type: 'future-metadata' }, codexEvent({ type: 'user_message', message: '构造任务' }), codexEvent({ type: 'task_complete', last_agent_message: '完成' })]
      : [piHeader(), piMessage('u', null, 'user', '构造任务'), { type: 'future-metadata' }, piMessage('a', 'u', 'assistant', '完成')];
  const record = source.parse(rows.map(row => JSON.stringify(row)).join('\n'), { path: '/constructed', fingerprint: 'fp' })!;
  assert.equal(record.intent.initial, '构造任务'); assert.equal(record.lastActivityAt, start); assert.equal(record.assistantFinished, true);
});
for (const tool of ['cc', 'codex', 'pi'] as const) test(`旧坏文件/孤儿/权限兼容：${tool}来源不再感知或报告`, async t => { await unmanaged(t, tool, '{broken\n', { pushes: '{bad hook\n' }); });
test('loop只列项目下一层合法总结，不跟随文件/目录链接，不读取资料子树', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true })); const summary = await putLoop(f.config, f.root, '完成');
  await put(join(f.config.sources.loop!, '总表.md'), 'broken'); await put(join(f.config.sources.loop!, 'resources', 'nested', '11111111-1111-4111-8111-111111111111.md'), 'broken');
  await symlink(summary, join(f.config.sources.loop!, 'project', '22222222-2222-4222-8222-222222222222.md'));
  const view = await detect(f.config, start); assert.equal(view.records.length, 1); assert.equal((await readOutbox(f.config.dataDir)).length, 1);
});
test('loop单份无权限总结跳过，不把其他正常批次弄盲', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true })); const summary = await putLoop(f.config, f.root);
  await chmod(summary, 0); const view = await detect(f.config, start); assert.deepEqual(view.records, []); assert.deepEqual(await readOutbox(f.config.dataDir), []);
});
test('忽略仍按路径边界：loop坏总结能识别忽略项目时不报警', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true })); f.config.ignoreProjectPrefixes = ['/sample/project'];
  assert.equal(isIgnoredProject('/sample/project-a', f.config), false); assert.equal(isIgnoredProject('/sample/project/nested', f.config), true);
  const path = await putLoop(f.config, f.root); await put(path, '# 自动评审总结\n- 项目：/sample/project\n- 状态：坏状态\n');
  await detect(f.config, start); assert.deepEqual(await readOutbox(f.config.dataDir), []);
});
test('忽略前缀与运行配置仍强校验，旧功能项不进入配置', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const ignoreProjectPrefixes of ['bad', ['relative'], [123]]) await assert.rejects(validateConfig({ ...f.config, ignoreProjectPrefixes }));
  await assert.rejects(validateConfig({ ...f.config, dataDir: 'relative' }));
});
test('Unicode字符/字节截断不切开代理对，字节上限含省略号', () => {
  const text = '😀'.repeat(3000); assert.equal([...truncateText(text, 20)].length, 21); const short = truncateUtf8(text, 40);
  assert.ok(Buffer.byteLength(short) <= 40); assert.equal(Buffer.from(short).toString('utf8'), short);
});
