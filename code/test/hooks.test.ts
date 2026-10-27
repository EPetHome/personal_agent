import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installListener, uninstallListener } from '../src/hooks/install.ts';
import { registerMessageListener } from '../src/hooks/pi/index.ts';
import { readJsonl } from '../src/core/store.ts';
import type { HookTool } from '../src/hooks/protocol.ts';

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'message-listener-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const inbox = join(home, 'inbox');
  const command = join(home, 'fake-plugin-manager');
  // 官方插件管理边界的替身：只有它写 CC/Codex 登记和启用配置，不连网/调模型。
  await writeFile(command, `#!${process.execPath}\n${String.raw`
const fs = require('node:fs'); const path = require('node:path');
const home = process.env.HOME; const a = process.argv.slice(2);
if (!home || process.env.CLAUDE_CONFIG_DIR !== path.join(home,'.claude') || process.env.CODEX_HOME !== path.join(home,'.codex')) process.exit(9);
const tool = process.env.PA_FAKE_UNUSED || (fs.existsSync(path.join(home,'use-codex')) ? '.codex' : '.claude');
const dir = path.join(home, tool, 'plugins'); fs.mkdirSync(dir,{recursive:true});
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {};
const json = (file,value) => fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const market = 'personal-agent-local', plugin = 'message-listener@'+market;
if (tool === '.claude') {
 const settings = path.join(home,tool,'settings.json'), value = read(settings);
 if (a[1] === 'marketplace') {
  value.extraKnownMarketplaces = {...value.extraKnownMarketplaces,[market]:{source:{source:'directory',path:a[3]}}};
  const known = path.join(dir,'known_marketplaces.json'); json(known,{...read(known),[market]:{installLocation:a[3]}});
 } else {
  value.enabledPlugins = {...value.enabledPlugins,[plugin]:true};
  const installed = path.join(dir,'installed_plugins.json'), registry = read(installed);
  json(installed,{...registry,version:2,plugins:{...registry.plugins,[plugin]:[{scope:'user',version:'1.0.0'}]}});
 }
 json(settings,value);
} else {
 const config = path.join(home,tool,'config.toml');
 fs.appendFileSync(config,a[1]==='marketplace' ? '\n[marketplaces.personal-agent-local]\nsource_type = "local"\nsource = '+JSON.stringify(a[3])+'\n' : '\n[plugins."message-listener@personal-agent-local"]\nenabled = true\n');
}
`}`);
  await chmod(command, 0o700);
  return { home, inbox, command };
}
async function hookCommand(home: string, tool: 'cc' | 'codex', event: string) {
  const file = join(home, '.message-listener', tool, 'plugins/message-listener/hooks/hooks.json');
  const hooks = JSON.parse(await readFile(file, 'utf8')).hooks;
  const hook = hooks[event][0].hooks[0];
  if (tool === 'cc') assert.equal(hook.async, true);
  return hook.command as string;
}
const payload = { session_id: 'constructed-session', cwd: '/sample/project', transcript_path: '/sample/transcript.jsonl', at: '2026-10-20T10:00:00Z' };
function piHarness(inbox: string) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const bus = new Map<string, (data: unknown) => void>();
  const ctx = { cwd: payload.cwd, sessionManager: { getSessionId: () => payload.session_id, getSessionFile: () => payload.transcript_path } };
  registerMessageListener({ on(name, fn) { handlers.set(name, fn); }, events: { on(name, fn) { bus.set(name, fn); } } }, inbox);
  handlers.get('session_start')!({}, ctx);
  return { handlers, bus, ctx };
}

test('A1/A2 临时安装 CC/Codex 插件，权限事件有全部字段；Stop/SessionEnd/idle 映射正确', async t => {
  for (const tool of ['cc', 'codex'] as const) {
    const { home, inbox, command } = await fixture(t);
    if (tool === 'codex') await writeFile(join(home, 'use-codex'), '');
    await installListener({ home, inboxDir: inbox, tool, command });
    const permission = tool === 'cc' ? 'Notification' : 'PermissionRequest';
    for (const [event, expected] of [[permission, 'waiting_permission'], ['Stop', 'turn_end'], ['SessionEnd', 'session_end']]) {
      const result = spawnSync('/bin/sh', ['-c', await hookCommand(home, tool, event!)], {
        input: JSON.stringify({ ...payload, notification_type: 'permission_prompt', last_assistant_message: '是否继续？' }), encoding: 'utf8', timeout: 1000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout + result.stderr, '');
      const rows = await readJsonl<Record<string, string>>(join(inbox, `${tool}.jsonl`));
      const row = rows.at(-1)!;
      assert.equal(row.event, expected); assert.equal(row.tool, tool);
      for (const key of ['session_id', 'cwd', 'transcript_path']) assert.equal(row[key], payload[key as keyof typeof payload]);
      assert.equal(row.at, '2026-10-20T10:00:00.000Z');
      if (event === 'Stop') assert.equal(row.detail, '是否继续？');
    }
    if (tool === 'cc') {
      spawnSync('/bin/sh', ['-c', await hookCommand(home, tool, 'Notification')], { input: JSON.stringify({ ...payload, notification_type: 'idle_prompt' }) });
      assert.equal((await readJsonl(join(inbox, 'cc.jsonl'))).length, 3);
    }
  }
});

test('A2 Pi 仅监听通知事件，权限、最终回复、会话结束均写入，不读会话内容', async t => {
  const { inbox } = await fixture(t);
  const { handlers, bus, ctx } = piHarness(inbox);
  assert.equal(handlers.has('tool_call'), false);
  assert.equal(bus.get('permissions:ui_prompt')!({ title: '允许写 A 吗？' }), undefined);
  handlers.get('message_end')!({ message: { role: 'assistant', content: [{ type: 'text', text: '已完成' }] } }, ctx);
  handlers.get('agent_settled')!({}, ctx);
  handlers.get('session_shutdown')!({}, ctx);
  const rows = await readJsonl<Record<string, string>>(join(inbox, 'pi.jsonl'));
  assert.deepEqual(rows.map(row => row.event), ['waiting_permission', 'turn_end', 'session_end']);
  assert.ok(rows.every(row => row.session_id === payload.session_id && row.cwd === payload.cwd && row.transcript_path === payload.transcript_path && Number.isFinite(Date.parse(row.at!))));
  assert.equal(rows[1]!.detail, '已完成');
});

test('A3 不可写目录时三个钩子均静默成功且 <1 秒；损坏输入/堵塞 stdin 不挡工具', async t => {
  const { home, inbox, command } = await fixture(t);
  // 复现门禁临时目录落在一个未声明 type 的祖先 Node 包之下，不能靠屏蔽警告通过。
  await writeFile(join(home, 'package.json'), '{"private":true}\n');
  await mkdir(inbox); await chmod(inbox, 0o500);
  t.after(() => chmod(inbox, 0o700).catch(() => {}));
  for (const tool of ['cc', 'codex'] as const) {
    if (tool === 'codex') await writeFile(join(home, 'use-codex'), '');
    await installListener({ home, inboxDir: inbox, tool, command });
    const start = performance.now();
    const result = spawnSync('/bin/sh', ['-c', await hookCommand(home, tool, tool === 'cc' ? 'Notification' : 'PermissionRequest')], {
      input: JSON.stringify({ ...payload, notification_type: 'permission_prompt' }), encoding: 'utf8', timeout: 1000,
    });
    assert.equal(result.status, 0); assert.equal(result.stdout + result.stderr, ''); assert.ok(performance.now() - start < 1000);
  }
  await installListener({ home, inboxDir: inbox, tool: 'pi' });
  const entry = pathToFileURL(join(home, '.message-listener/pi/message-listener.ts')).href;
  const start = performance.now();
  const pi = spawnSync(process.execPath, ['--input-type=module', '-e', `import factory from ${JSON.stringify(entry)}; let h,b; factory({on(n,f){if(n==='session_start')h=f;},events:{on(n,f){b=f;}}}); h({}, {cwd:'/sample/project',sessionManager:{getSessionId(){return 'p'},getSessionFile(){return '/sample/p.jsonl'}}}); b({title:'授权'});`], { encoding: 'utf8', timeout: 1000 });
  assert.equal(pi.status, 0, pi.stderr); assert.equal(pi.stdout + pi.stderr, ''); assert.ok(performance.now() - start < 1000);
  const malformed = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/hooks/message-listener.ts'), '--tool', 'cc', '--inbox', inbox], { input: 'broken', encoding: 'utf8' });
  assert.equal(malformed.status, 0); assert.equal(malformed.stderr, '');
});

test('A4 三个装卸只删自有登记、保留原设置和权限；原字节备份留存、重复卸载成功', async t => {
  for (const tool of ['cc', 'codex', 'pi'] as HookTool[]) {
    const { home, inbox, command } = await fixture(t);
    const configPath = join(home, tool === 'cc' ? '.claude/settings.json' : tool === 'codex' ? '.codex/config.toml' : '.pi/agent/settings.json');
    const content = tool === 'codex' ? '# 构造配置\nmodel = "test"\n' : '{  "existing": true, "extensions": [] }\n';
    await mkdir(join(configPath, '..'), { recursive: true }); await writeFile(configPath, content, { mode: 0o640 });
    if (tool === 'codex') await writeFile(join(home, 'use-codex'), '');
    const backupPath = await installListener({ home, inboxDir: inbox, tool, command });
    const backup = JSON.parse(await readFile(backupPath, 'utf8'));
    assert.equal(Buffer.from(backup.before.find((f: { path: string }) => f.path === configPath.slice(home.length + 1)).data, 'base64').toString(), content);
    await uninstallListener({ home, tool, command });
    const remaining = await readFile(configPath, 'utf8');
    if (tool === 'codex') assert.equal(remaining.trim(), content.trim());
    else assert.deepEqual(JSON.parse(remaining), JSON.parse(content));
    assert.equal((await stat(configPath)).mode & 0o777, 0o640);
    const retainedBackup = await readFile(`${backupPath}.removed`, 'utf8');
    if (tool === 'pi') {
      await installListener({ home, inboxDir: inbox, tool });
      await uninstallListener({ home, tool });
      assert.equal(await readFile(`${backupPath}.removed`, 'utf8'), retainedBackup);
    }
    if (tool === 'cc') for (const file of ['known_marketplaces.json', 'installed_plugins.json'])
      await assert.rejects(readFile(join(home, '.claude/plugins', file)), { code: 'ENOENT' });
    await assert.rejects(readFile(join(home, '.message-listener', tool, 'message-listener.ts')), { code: 'ENOENT' });
    await uninstallListener({ home, tool, command });
  }
});

test('装后其他配置变化仍可卸载；插件 CLI 无改动失败则保留原配置', async t => {
  const { home, inbox, command } = await fixture(t);
  await installListener({ home, inboxDir: inbox, tool: 'pi' });
  const settings = join(home, '.pi/agent/settings.json');
  await writeFile(settings, '{"newUserSetting":true}\n');
  const cli = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/hooks/main.ts'), 'uninstall', '--tool', 'pi', '--home', home], { encoding: 'utf8', timeout: 5000 });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /只移除本程序条目.*保留你的其他设置/);
  assert.ok(!cli.stdout.includes('恢复到安装前备份'));
  assert.equal(await readFile(settings, 'utf8'), '{"newUserSetting":true}\n');
  await writeFile(command, `#!${process.execPath}\nprocess.exit(1);\n`);
  const original = '{ "keep": true }\n';
  await mkdir(join(home, '.claude'), { recursive: true }); await writeFile(join(home, '.claude/settings.json'), original);
  await assert.rejects(installListener({ home, inboxDir: inbox, tool: 'cc', command }), /插件管理命令失败/);
  assert.equal(await readFile(join(home, '.claude/settings.json'), 'utf8'), original);
});

test('返修2-1 安装失败→回滚→用户改配置/安装其他插件→清理卸载不覆盖新内容', async t => {
  for (const tool of ['cc', 'codex'] as const) {
    const { home, inbox, command } = await fixture(t);
    const dir = join(home, tool === 'cc' ? '.claude' : '.codex');
    const settings = join(dir, tool === 'cc' ? 'settings.json' : 'config.toml');
    await mkdir(join(dir, 'plugins'), { recursive: true });
    await writeFile(settings, tool === 'cc' ? '{ "keep": true }\n' : '# keep\n');
    const original = await readFile(settings, 'utf8');
    const partial = tool === 'cc' ? JSON.stringify({ keep: true, enabledPlugins: { 'message-listener@personal-agent-local': true } })
      : `${original}[plugins."message-listener@personal-agent-local"]\nenabled = true\n`;
    await writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(settings)},${JSON.stringify(partial)});process.exit(1);\n`);
    await assert.rejects(installListener({ home, inboxDir: inbox, tool, command }), /插件管理命令失败/);
    if (tool === 'cc') assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), JSON.parse(original));
    else assert.equal(await readFile(settings, 'utf8'), original);
    const backupPath = join(home, '.message-listener-backups', `${tool}.json`);
    assert.equal(JSON.parse(await readFile(backupPath, 'utf8')).phase, 'rolled_back');
    const later = tool === 'cc' ? '{ "laterUserSetting": true }\n' : 'later_user_setting = true\n';
    await writeFile(settings, later);
    await writeFile(join(dir, 'plugins/later-plugin.json'), 'later plugin registration');
    await uninstallListener({ home, tool, command });
    assert.equal(await readFile(settings, 'utf8'), later);
    assert.equal(await readFile(join(dir, 'plugins/later-plugin.json'), 'utf8'), 'later plugin registration');
    assert.equal(JSON.parse(await readFile(`${backupPath}.removed`, 'utf8')).phase, 'rolled_back');
  }
});

test('返修2-1 缺 after 的旧备份、安装中/恢复中现场均拒绝盲目恢复', async t => {
  for (const phase of [undefined, 'installing', 'restoring', 'recovery_required']) {
    const { home, inbox } = await fixture(t);
    const path = await installListener({ home, inboxDir: inbox, tool: 'pi' });
    const backup = JSON.parse(await readFile(path, 'utf8'));
    backup.phase = phase; delete backup.after;
    await writeFile(path, JSON.stringify(backup));
    const settings = join(home, '.pi/agent/settings.json');
    await writeFile(settings, '{"laterUserSetting":true}\n');
    await assert.rejects(uninstallListener({ home, tool: 'pi' }), /未完成|缺少可核对/);
    assert.equal(await readFile(settings, 'utf8'), '{"laterUserSetting":true}\n');
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(backup));
  }
});

test('真机 A3：500MiB 无关插件不读进备份；CC/Codex 备份均小于1MiB', async t => {
  for (const tool of ['cc', 'codex'] as const) {
    const { home, inbox, command } = await fixture(t);
    if (tool === 'codex') await writeFile(join(home, 'use-codex'), '');
    const directory = join(home, tool === 'cc' ? '.claude' : '.codex', 'plugins/other-plugin');
    await mkdir(directory, { recursive: true });
    const payload = join(directory, '500MiB.bin');
    const file = await open(payload, 'wx');
    try { await file.truncate(500 * 1024 * 1024); await file.write(Buffer.from('keep'), 0, 4, 0); } finally { await file.close(); }
    const before = await stat(payload);
    const backup = await installListener({ home, inboxDir: inbox, tool, command });
    assert.ok((await stat(backup)).size < 1024 * 1024);
    assert.ok(!JSON.parse(await readFile(backup, 'utf8')).before.some((f: { path: string }) => f.path.includes('other-plugin')));
    await uninstallListener({ home, tool });
    assert.equal((await stat(payload)).size, 500 * 1024 * 1024);
    assert.equal((await stat(payload)).mtimeMs, before.mtimeMs);
    t.diagnostic(`${tool} 500MiB构造稀疏文件未改；备份 ${(await stat(backup + '.removed')).size} bytes`);
  }
});

test('真机 A4：三个工具装后改模型/无关设置和其他插件，卸载全部保留，只移自有登记', async t => {
  for (const tool of ['cc', 'codex', 'pi'] as const) {
    const { home, inbox, command } = await fixture(t);
    if (tool === 'codex') await writeFile(join(home, 'use-codex'), '');
    const path = join(home, tool === 'cc' ? '.claude/settings.json' : tool === 'codex' ? '.codex/config.toml' : '.pi/agent/settings.json');
    await mkdir(join(path, '..'), { recursive: true });
    const initial = tool === 'codex' ? 'model = "before"\n# 保留注释\n[plugins.other]\nenabled = true\n'
      : JSON.stringify({ model: 'before', effortLevel: 'low', ...(tool === 'cc' ? { enabledPlugins: { other: true }, extraKnownMarketplaces: { other: { keep: true } } } : { extensions: ['/constructed/other.ts'] }) });
    await writeFile(path, initial, { mode: 0o640 });
    const backup = await installListener({ home, inboxDir: inbox, tool, command });
    const installed = await readFile(path, 'utf8');
    if (tool === 'codex') await writeFile(path, installed.replace('model = "before"', 'model = "after"') + '\n[plugins.later]\nenabled = true\n');
    else {
      const value = JSON.parse(installed); value.model = 'after'; value.effortLevel = 'high';
      if (tool === 'cc') value.enabledPlugins.later = true;
      else value.extensions.push('/constructed/later.ts');
      await writeFile(path, JSON.stringify(value));
    }
    await uninstallListener({ home, tool });
    const result = await readFile(path, 'utf8');
    if (tool === 'codex') {
      assert.match(result, /model = "after"/); assert.match(result, /# 保留注释/);
      assert.match(result, /\[plugins.other\]/); assert.match(result, /\[plugins.later\]/);
      assert.ok(!result.includes('personal-agent-local'));
    } else {
      const expected = JSON.parse(initial); expected.model = 'after'; expected.effortLevel = 'high';
      if (tool === 'cc') expected.enabledPlugins.later = true; else expected.extensions.push('/constructed/later.ts');
      assert.deepEqual(JSON.parse(result), expected);
    }
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    assert.ok(await stat(backup + '.removed'));
  }
});

test('真机 A4：旧v1成功安装备份可定点卸载，仍不恢复安装前整份目录', async t => {
  const { home, inbox, command } = await fixture(t);
  const backupPath = await installListener({ home, inboxDir: inbox, tool: 'cc', command });
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  backup.version = 1; backup.paths = ['.claude/settings.json', '.claude/plugins'];
  backup.before.push({ path: '.claude/plugins', mode: 0o700 });
  await writeFile(backupPath, JSON.stringify(backup));
  const path = join(home, '.claude/settings.json'); const settings = JSON.parse(await readFile(path, 'utf8'));
  settings.model = 'later'; await writeFile(path, JSON.stringify(settings));
  const other = join(home, '.claude/plugins/other.json'); await writeFile(other, 'keep');
  await uninstallListener({ home, tool: 'cc' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { model: 'later' });
  assert.equal(await readFile(other, 'utf8'), 'keep');
});

test('返修2-1 回滚无法完成时保留 recovery_required，后续修改也不会被卸载覆盖', async t => {
  const { home, inbox, command } = await fixture(t);
  const dir = join(home, '.claude'); const settings = join(dir, 'settings.json');
  const target = join(home, 'constructed-link-target');
  await mkdir(dir); await writeFile(settings, '{"keep":true}\n'); await writeFile(target, 'do not change');
  await writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs');fs.unlinkSync(${JSON.stringify(settings)});fs.symlinkSync(${JSON.stringify(target)},${JSON.stringify(settings)});process.exit(1);\n`);
  await assert.rejects(installListener({ home, inboxDir: inbox, tool: 'cc', command }), /恢复未完成/);
  const backupPath = join(home, '.message-listener-backups/cc.json');
  assert.equal(JSON.parse(await readFile(backupPath, 'utf8')).phase, 'recovery_required');
  assert.equal(await readFile(target, 'utf8'), 'do not change');
  await rm(settings); await writeFile(settings, '{"userFixedIt":true}\n');
  await assert.rejects(uninstallListener({ home, tool: 'cc' }), /未完成/);
  assert.equal(await readFile(settings, 'utf8'), '{"userFixedIt":true}\n');
});
