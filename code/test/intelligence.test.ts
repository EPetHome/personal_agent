// 后台分析已删除；读取围栏本身保留，供下一段研判复用。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ReadSandbox, broadProject } from '../src/core/read-sandbox.ts';
import type { ReadAudit } from '../src/core/intelligence-types.ts';
import { ccAnswer, ccUser, ordinaryProject, put, sandbox, unmanaged } from './fixtures.ts';
async function fixture(t: TestContext) {
  const f = await sandbox(), projectRoot = await ordinaryProject(), projectDir = join(projectRoot, 'project');
  t.after(async () => { await rm(f.root, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });
  const root = await realpath(f.root); f.config.dataDir = join(root, 'data'); f.config.sources.cc = join(root, 'cc');
  const file = join(f.config.sources.cc!, 'a.jsonl'); await put(file, [ccUser('构造缓存任务'), ccAnswer()]);
  await put(join(projectDir, 'README.md'), '允许读取的构造材料'); const audit: ReadAudit[] = [];
  const box = await ReadSandbox.create({ transcript: file, project: projectDir, home: '/constructed-home', dataDir: f.config.dataDir,
    sourceDirs: [f.config.sources.cc!], maxToolCalls: 100 }, async row => { audit.push(row); });
  return { ...f, file, projectRoot, projectDir, audit, box };
}
test('后台分析已删除：新问句不会读取会话与项目或建立影子请求', async t => { const answer = ccAnswer(); answer.message.content[0]!.text = '缓存多久？'; await unmanaged(t, 'cc', [ccUser(), answer]); });
test('保留读取围栏：四种只读工具不泄露敏感文件，模板/代码仍可读', async t => {
  const f = await fixture(t);
  const denied = ['.env', '.env.local', 'id_rsa', 'id_ed25519.pub', 'cert.pem', '.npmrc', 'auth.json', 'session.sqlite', 'cookie.db', '.bak/saved.txt',
    '旧备份/data.txt', 'my-backup/config.json', 'eval/cases/real.txt', 'eval/runs/output.txt', 'eval/待标注/real.txt', '.git/config'];
  for (const path of denied) await put(join(f.projectDir, path), 'DENIED-CONTENT-ONLY');
  await put(join(f.config.dataDir, 'config.json'), 'PERSONAL-CONFIG-ONLY'); await put(join(f.config.sources.cc!, 'other.jsonl'), 'OTHER-SESSION-ONLY');
  await put(join(f.projectDir, '.env.example'), 'ALLOWED-TEMPLATE'); await put(join(f.projectDir, 'token-secret-password.ts'), 'ALLOWED-CODE');
  const messages = [];
  for (const path of denied) messages.push(await f.box.execute('read', { path }));
  for (const path of [join(f.config.dataDir, 'config.json'), join(f.config.sources.cc!, 'other.jsonl'), '~/.ssh/config']) messages.push(await f.box.execute('read', { path }));
  for (const name of ['grep', 'find', 'ls']) messages.push(await f.box.execute(name, { path: f.projectDir, pattern: name === 'grep' ? 'CONTENT' : '**' }));
  for (const path of ['.env.example', 'token-secret-password.ts']) messages.push(await f.box.execute('read', { path }));
  assert.doesNotMatch(messages.join('\n'), /DENIED-CONTENT-ONLY|PERSONAL-CONFIG-ONLY|OTHER-SESSION-ONLY/); assert.match(messages.join('\n'), /ALLOWED-TEMPLATE|ALLOWED-CODE/);
  assert.ok(f.audit.some(row => row.kind === 'blocked')); assert.ok(f.audit.some(row => row.kind === 'read'));
});
test('保留读取围栏：大容器只许会话，链接/硬链接/穿越均拒绝', async t => {
  const f = await fixture(t), home = join(f.projectRoot, 'home'); await mkdir(home); await put(join(home, 'private.txt'), 'PRIVATE-CONTENT');
  const broad = await ReadSandbox.create({ ...f.box.scope, project: home, home }, async row => { f.audit.push(row); });
  assert.match(await broad.execute('read', { path: f.file }), /构造缓存/); assert.match(await broad.execute('read', { path: join(home, 'private.txt') }), /拒绝/);
  for (const path of ['/Users/Admin', '/Users/Admin/Desktop', '/Users/Admin/Documents', '/Users/Admin/Downloads']) assert.equal(broadProject(path, '/Users/Admin'), true);
  await symlink(join(home, 'private.txt'), join(f.projectDir, 'alias.txt')); await link(join(home, 'private.txt'), join(f.projectDir, 'hard.txt'));
  for (const path of ['alias.txt', 'hard.txt', '../home/private.txt']) assert.match(await f.box.execute('read', { path }), /拒绝/);
});
test('保留读取围栏：长行分页和审计行列指纹完整', async t => {
  const f = await fixture(t), content = '长行😀上下文。'.repeat(9000) + '最后目标依据', path = join(f.projectDir, 'long.txt'); await put(path, content);
  let args: Record<string, unknown> = { path }, combined = '';
  for (;;) { const page = JSON.parse(await f.box.execute('read', args)); assert.ok(Buffer.byteLength(page.text) <= 32768); combined += page.text;
    if (page.eof) break; assert.equal(page.next.offset, 1); args = { path, ...page.next }; }
  assert.equal(combined, content); assert.ok(f.box.calls > 2);
  assert.ok(f.audit.filter(r => r.kind === 'read').every(r => r.kind === 'read' && r.read.startColumn && r.read.endColumn));
});
