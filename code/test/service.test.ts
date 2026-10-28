import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { installService, serviceLabel, uninstallService } from '../src/service/launchd.ts';
import { recoverDeadLock } from '../src/core/locks.ts';
import { readJsonl, readOutbox } from '../src/core/store.ts';
import { componentPath } from '../src/core/process.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { ccCall, ccUser, put, pushed, sandbox } from './fixtures.ts';

const cli = resolve(import.meta.dirname, '../src/cli/main.ts');
async function waitFor<T>(operation: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const value = await operation(); if (accept(value)) return value; } catch {}
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('等待构造常驻的外部结果超时');
}
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 2000 }; f.config.learning = false;
  f.config.service = { intervalMs: 100, restartWindowMs: 60000, restartThreshold: 3 };
  const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
  return { ...f, configPath };
}
function daemon(config: string) {
  const child = spawn(process.execPath, [cli, 'daemon', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout!.on('data', c => output += c); child.stderr!.on('data', c => output += c);
  return { child, output: () => output };
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(signal); await exited;
}

test('段2 A5：临时目标 plist 语法/登录启动/崩溃拉起/固定 argv；卸载精确恢复已有目录', async t => {
  const { root, config, configPath } = await fixture(t);
  const target = join(root, 'agents & space'); await mkdir(target); await chmod(target, 0o750);
  await writeFile(join(target, 'original.txt'), '原有文件\n', { mode: 0o640 });
  await installService(configPath, target);
  const path = join(target, `${serviceLabel}.plist`), content = await readFile(path, 'utf8');
  assert.match(content, /<key>RunAtLoad<\/key><true\/>/); assert.match(content, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/>/);
  assert.ok(content.includes(process.execPath)); assert.ok(content.includes(cli)); assert.ok(content.includes(configPath));
  assert.ok(content.includes(config.dataDir)); assert.ok(!content.includes('FEISHU_APP_SECRET'));
  if (process.platform === 'darwin') { const lint = spawnSync('/usr/bin/plutil', ['-lint', '--', path], { encoding: 'utf8' }); assert.equal(lint.status, 0, lint.stdout + lint.stderr); }
  await uninstallService(configPath, target); await uninstallService(configPath, target);
  assert.deepEqual(await readdir(target), ['original.txt']); assert.equal(await readFile(join(target, 'original.txt'), 'utf8'), '原有文件\n');
  assert.equal((await lstat(target)).mode & 0o777, 0o750); assert.equal((await lstat(join(target, 'original.txt'))).mode & 0o777, 0o640);
  const absent = join(root, 'absent', 'nested-agents'); await installService(configPath, absent); await uninstallService(configPath, absent);
  await assert.rejects(lstat(join(root, 'absent')), { code: 'ENOENT' });
});

test('返修1-1 最小PATH仍能运行 env node 的Pi替身；plist仅登记可控PATH，不复制环境', async t => {
  const { root, config, configPath } = await fixture(t);
  const executable = join(root, 'pi-env-node-stub'), capture = join(root, 'model-path'), emptyBin = join(root, 'empty-bin');
  await mkdir(emptyBin);
  await writeFile(executable, `#!/usr/bin/env node\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(capture)},process.env.PATH);console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({answer:'是',reason:'构造的范围偏离',intentQuote:'只改 A 文件',stepQuote:'修改 B 模块'})}]}}));});\n`); await chmod(executable, 0o700);
  config.judge = { executable, model: 'test/fake', timeoutMs: 5000, dailyLimit: 10, cycleTimeoutMs: 10000 };
  await put(join(config.sources.cc!, 'session.jsonl'), [ccUser('只改 A 文件'), ccCall(undefined, 'drift', '修改 B 模块')]);
  await put(configPath, JSON.stringify(config));
  const before = spawnSync(executable, [], { encoding: 'utf8', env: { PATH: emptyBin }, input: '' });
  assert.notEqual(before.status, 0, '空PATH的对照应无法找到 shebang 的 node');
  const detected = spawnSync(process.execPath, [cli, 'detect', '--config', configPath, '--now', '2026-10-20T10:01:00Z', '--json'], { encoding: 'utf8', env: { PATH: emptyBin, HOME: root }, timeout: 15000 });
  assert.equal(detected.status, 0, detected.stderr);
  assert.equal(JSON.parse(detected.stdout).records[0].status, '疑似跑偏');
  assert.equal((await readOutbox(config.dataDir)).filter(n => n.kind === 'drift').length, 1);
  assert.equal((await readFile(capture, 'utf8')).split(delimiter)[0], dirname(process.execPath));
  const target = join(root, 'minimal-path-agents'); await installService(configPath, target);
  const plist = await readFile(join(target, `${serviceLabel}.plist`), 'utf8');
  const environment = /<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s.exec(plist)![1]!;
  assert.equal(environment, `<key>PATH</key><string>${componentPath().replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')}</string>`);
  assert.ok(!environment.includes(emptyBin)); assert.ok(!plist.includes('FEISHU_APP_ID')); assert.ok(!plist.includes('FEISHU_APP_SECRET'));
  await uninstallService(configPath, target);
});

test('launchd CLI 默认只写临时目录；安装冲突和卸载后改动均拒绝覆盖', async t => {
  const { root, configPath } = await fixture(t); const target = join(root, 'cli-agents');
  const installed = spawnSync(process.execPath, [cli, 'service-install', '--config', configPath, '--target', target], { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr); assert.match(installed.stdout, /未激活/);
  await assert.rejects(installService(configPath, target), /已有安装记录/);
  const path = join(target, `${serviceLabel}.plist`); const before = await readFile(path, 'utf8'); await appendFile(path, '\n<!-- user changed -->\n');
  await assert.rejects(uninstallService(configPath, target), /改动/); assert.match(await readFile(path, 'utf8'), /user changed/);
  await writeFile(path, before); await uninstallService(configPath, target);
});

test('段2 A6：实际前台常驻→追加已满等候窗口的构造推送→文件与假飞书卡片；同时收私聊漏报', async t => {
  const { config, configPath } = await fixture(t), transcript = join(config.sources.cc!, 'session.jsonl');
  const at = new Date(Date.now() - 12 * 60000).toISOString(); await put(transcript, [ccUser('构造前台常驻任务', at), ccCall(at)]);
  const process = daemon(configPath); t.after(() => stop(process.child, 'SIGKILL'));
  await waitFor(() => readJsonl<{ kind: string }>(join(config.dataDir, 'service.log.jsonl')), rows => rows.some(r => r.kind === 'scan_completed'));
  const began = Date.now(); await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript, 'waiting_permission', at)]);
  const notices = await waitFor(() => readOutbox(config.dataDir), rows => rows.some(n => n.kind === 'waiting'));
  const notice = notices.find(n => n.kind === 'waiting')!;
  await waitFor(() => readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl')), rows => rows.some(m => m.noticeId === notice.id));
  assert.ok(Date.now() - began < 120000);
  await put(join(config.dataDir, 'feishu-inbox.jsonl'), [{ header: { event_id: 'daemon-miss', event_type: 'im.message.receive_v1' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_test' } }, message: { message_id: 'om_daemon_miss', message_type: 'text', chat_type: 'p2p', content: JSON.stringify({ text: '漏了 loop 暂停没叫我' }) } } }]);
  await waitFor(() => readJsonl<{ verdict: string }>(join(config.dataDir, 'feedback.jsonl')), rows => rows.some(f => f.verdict === '漏了'));
  await stop(process.child); assert.equal(process.child.exitCode, 0, process.output());
  t.diagnostic(`构造常驻追加推送到发件/卡片 ${Date.now() - began} ms（含后续收件及正常退出）`);
});

test('段2 A7：三次实际 SIGKILL 与重启，恢复已退出进程锁，只发一条带日志路径的重启告警', async t => {
  const { config, configPath } = await fixture(t); config.sources.cc = null; await put(configPath, JSON.stringify(config));
  const children: ChildProcess[] = []; t.after(async () => { for (const child of children) await stop(child, 'SIGKILL'); });
  for (let i = 0; i < 3; i++) {
    const before = (await readJsonl<{ kind: string }>(join(config.dataDir, 'service.log.jsonl'))).filter(r => r.kind === 'scan_completed').length;
    const p = daemon(configPath); children.push(p.child);
    try {
      await waitFor(() => readJsonl<{ kind: string }>(join(config.dataDir, 'service.log.jsonl')), rows => rows.filter(r => r.kind === 'scan_completed').length > before);
    } catch (error) {
      // 只补构造现场，不改变等待上限/断言；失败时不要再只剩一个泛化超时。
      const names = await readdir(config.dataDir);
      const locks = await Promise.all(names.filter(name => name.includes('.lock')).map(async name => ({ name,
        files: await readdir(join(config.dataDir, name)).catch(e => (e as NodeJS.ErrnoException).code),
        owner: await readFile(join(config.dataDir, name, 'owner.json'), 'utf8').catch(e => (e as NodeJS.ErrnoException).code),
      })));
      t.diagnostic(JSON.stringify({ round: i + 1, before, exitCode: p.child.exitCode, signalCode: p.child.signalCode, output: p.output(), locks,
        log: await readJsonl(join(config.dataDir, 'service.log.jsonl')).catch(e => String(e)) }));
      throw error;
    }
    await stop(p.child, 'SIGKILL');
  }
  const last = daemon(configPath); children.push(last.child);
  const notices = await waitFor(() => readOutbox(config.dataDir), rows => rows.some(n => n.kind === 'service_restart'));
  const alerts = notices.filter(n => n.kind === 'service_restart'); assert.equal(alerts.length, 1);
  assert.match(alerts[0]!.text, /反复重启/); assert.ok(alerts[0]!.text.includes(join(config.dataDir, 'service.log.jsonl')));
  const messages = await waitFor(() => readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl')), rows => rows.some(m => m.noticeId === alerts[0]!.id));
  assert.equal(messages.filter(m => m.noticeId === alerts[0]!.id).length, 1);
  await stop(last.child); assert.equal(last.child.exitCode, 0, last.output());
});

test('锁恢复不删除活进程锁或未知锁；launchd 激活/停用仅调用显式测试替身', async t => {
  const { root, config, configPath } = await fixture(t);
  const lock = join(config.dataDir, '.unknown.lock'); await mkdir(lock, { recursive: true }); await writeFile(join(lock, 'owner.json'), '{}');
  await assert.rejects(recoverDeadLock(config.dataDir, '.unknown.lock'), /不明/); assert.deepEqual(await readdir(lock), ['owner.json']);
  const alive = join(config.dataDir, '.alive.lock'); await mkdir(alive); await writeFile(join(alive, 'owner.json'), JSON.stringify({ program: 'personal-agent', pid: process.pid, token: 'sample' }));
  await recoverDeadLock(config.dataDir, '.alive.lock'); assert.deepEqual(await readdir(alive), ['owner.json']);
  const command = join(root, 'launchctl-stub'), log = join(root, 'launchctl-args.jsonl'), registered = join(root, 'registered-path');
  await writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[0]==='bootstrap')fs.writeFileSync(${JSON.stringify(registered)},args[2]);if(args[0]==='print')console.log('path = '+fs.readFileSync(${JSON.stringify(registered)},'utf8'));\n`); await chmod(command, 0o700);
  const target = join(root, 'test-activation'); await installService(configPath, target, true, command);
  await writeFile(registered, join(root, 'foreign-service.plist'));
  await assert.rejects(uninstallService(configPath, target), /不属于此安装/);
  assert.ok((await readFile(join(target, `${serviceLabel}.plist`), 'utf8')).includes(serviceLabel));
  await writeFile(registered, join(target, `${serviceLabel}.plist`));
  await uninstallService(configPath, target); // 复用登记的测试替身，不意外改调真实 launchctl。
  assert.deepEqual((await readJsonl<string[]>(log)).map(args => args[0]), ['bootstrap', 'print', 'print', 'bootout']);
});

test('launchd bootstrap 失败/超时不按label误停已有同名服务，保留未确认现场', async t => {
  const { root, configPath } = await fixture(t);
  const command = join(root, 'launchctl-failure-stub'), log = join(root, 'failure-args.jsonl');
  await writeFile(command, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');process.exit(1);\n`); await chmod(command, 0o700);
  const target = join(root, 'activation-failed'); await mkdir(target); await writeFile(join(target, 'original.txt'), '保留原件');
  await assert.rejects(installService(configPath, target, true, command), /未停止任何已有服务/);
  assert.deepEqual((await readJsonl<string[]>(log)).map(args => args[0]), ['bootstrap']);
  assert.equal(await readFile(join(target, 'original.txt'), 'utf8'), '保留原件');
  assert.ok((await readFile(join(target, `${serviceLabel}.plist`), 'utf8')).includes(serviceLabel));
  await assert.rejects(uninstallService(configPath, target), /未登记或状态不明/);
  assert.deepEqual((await readJsonl<string[]>(log)).map(args => args[0]), ['bootstrap']);
});
