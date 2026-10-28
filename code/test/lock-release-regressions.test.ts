// 门禁返修2：全部为临时目录、构造锁和独立子进程，不读取真实运行数据。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { link, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, recoverDeadLock } from '../src/core/locks.ts';
import { readJsonl } from '../src/core/store.ts';
import { put, sandbox } from './fixtures.ts';

const locksUrl = new URL('../src/core/locks.ts', import.meta.url).href;
const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.sources.cc = null; f.config.learning = false;
  f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 2000 };
  f.config.service = { intervalMs: 100, restartWindowMs: 60000, restartThreshold: 3 };
  const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
  await mkdir(f.config.dataDir, { recursive: true });
  return { ...f, configPath };
}
async function within<T>(promise: Promise<T>, milliseconds = 10000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('构造子进程等待超时')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function child(args: string[]) {
  const process = spawn(globalThis.process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; process.stdout!.on('data', c => output += c); process.stderr!.on('data', c => output += c);
  const exited = once(process, 'exit'); void exited.catch(() => {});
  return { process, exited, output: () => output,
    async ready() { return within(Promise.race([once(process, 'message').then(([message]) => message), exited.then(() => { throw new Error(`构造子进程提前退出：${output}`); })])); },
    async stop(signal: NodeJS.Signals = 'SIGKILL') {
      if (process.exitCode === null && process.signalCode === null) process.kill(signal);
      return within(exited);
    } };
}
async function deadOwner(dir: string, name: string) {
  const owner = child(['--input-type=module', '-e', `
    const { acquireLock } = await import(${JSON.stringify(locksUrl)});
    setInterval(() => {}, 1000);
    await acquireLock(process.argv[1], process.argv[2]); process.send('owned');
  `, dir, name]);
  try { assert.equal(await owner.ready(), 'owned'); }
  finally { await owner.stop(); }
  return owner.process.pid!;
}
async function runOneScan(configPath: string, dataDir: string) {
  const daemon = child([cli, 'daemon', '--config', configPath]);
  try {
    await within((async () => {
      while (daemon.process.exitCode === null && daemon.process.signalCode === null) {
        const rows = await readJsonl<{ kind: string }>(join(dataDir, 'service.log.jsonl'));
        assert.ok(!rows.some(r => r.kind === 'scan_failed'), '不能把锁导致的持续 scan_failed 当恢复');
        if (rows.some(r => r.kind === 'scan_completed')) return;
        await delay(10);
      }
      assert.fail(`常驻提前退出：${daemon.output()}`);
    })());
  } finally { await daemon.stop('SIGTERM'); }
  assert.equal(daemon.process.exitCode, 0, daemon.output());
}

test('门禁返修2：SIGKILL 落在删除 owner 后，活跃锁名已原子退出；实际常驻仍能完成检测', async t => {
  const f = await fixture(t), name = '.feishu-inbound.lock', path = join(f.config.dataDir, name);
  const crashing = child(['--input-type=module', '-e', `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const unlink = fs.promises.unlink;
    fs.promises.unlink = async function(path, ...args) {
      const result = await unlink.call(this, path, ...args);
      if (String(path).includes('/.feishu-inbound.lock') && String(path).endsWith('/owner.json')) {
        process.send('owner_removed'); await new Promise(() => {});
      }
      return result;
    };
    syncBuiltinESMExports(); setInterval(() => {}, 1000);
    const { acquireLock } = await import(${JSON.stringify(locksUrl)});
    const release = await acquireLock(process.argv[1], '.feishu-inbound.lock'); await release();
  `, f.config.dataDir]);
  try { assert.equal(await crashing.ready(), 'owner_removed'); }
  finally { await crashing.stop(); }
  assert.equal(crashing.process.signalCode, 'SIGKILL');
  await assert.rejects(lstat(path), { code: 'ENOENT' }, '不能留下缺 owner 的活跃锁目录阻塞重启');
  assert.ok((await readdir(f.config.dataDir)).some(n => n.startsWith(`${name}.released-`)), '崩溃中断的旧锁残留保留在独立名字，不误删现场');
  await runOneScan(f.configPath, f.config.dataDir);
});

for (const operation of ['release', 'recover'] as const) test(`门禁返修2：${operation} 旧 owner 清理前可获得新锁，旧清理不得删新 owner`, async t => {
  const f = await fixture(t), name = '.synthetic.lock', path = join(f.config.dataDir, name);
  const release = operation === 'release' ? await acquireLock(f.config.dataDir, name) : undefined;
  if (operation === 'recover') await deadOwner(f.config.dataDir, name);
  const previous = await readFile(join(path, 'owner.json'), 'utf8');
  const original = fs.promises.unlink;
  let newRelease: (() => Promise<void>) | undefined, observed = false;
  fs.promises.unlink = async function(file) {
    const result = await original.call(this, file);
    const text = String(file);
    if (!observed && (text === join(path, 'owner.json') || text.startsWith(`${path}.released-`) || text.startsWith(`${path}.owned-`))) {
      observed = true;
      await assert.rejects(lstat(path), { code: 'ENOENT' });
      newRelease = await acquireLock(f.config.dataDir, name);
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    if (release) await release(); else await recoverDeadLock(f.config.dataDir, name);
    assert.equal(observed, true);
    assert.notEqual(await readFile(join(path, 'owner.json'), 'utf8'), previous);
    await assert.rejects(acquireLock(f.config.dataDir, name), /正被占用/, '新 owner 仍有效，不能被旧清理删掉');
  } finally {
    fs.promises.unlink = original; syncBuiltinESMExports();
    await newRelease?.();
  }
});

for (const phase of ['directory_created', 'owner_opened', 'owner_written', 'published'] as const)
  test(`门禁返修3：初始化 ${phase} 时 SIGKILL，不发布半份 owner，实际常驻可恢复`, async t => {
    const f = await fixture(t), name = '.detect.lock', path = join(f.config.dataDir, name);
    const crashing = child(['--input-type=module', '-e', `
      import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const phase = process.argv[2], canonical = process.argv[1] + '/.detect.lock';
      const hit = path => String(path) === canonical || String(path).startsWith(canonical + '.owned-');
      const wait = async label => { process.send(label); await new Promise(() => {}); };
      const mkdir = fs.promises.mkdir, writeFile = fs.promises.writeFile, symlink = fs.promises.symlink;
      fs.promises.mkdir = async function(path, ...args) {
        const result = await mkdir.call(this, path, ...args);
        if (phase === 'directory_created' && hit(path)) await wait(phase);
        return result;
      };
      fs.promises.writeFile = async function(path, ...args) {
        if (hit(String(path).replace(/\\/owner\\.json$/, '')) && String(path).endsWith('/owner.json')) {
          if (phase === 'owner_opened') {
            const file = await fs.promises.open(path, 'wx', 0o600); await file.close(); await wait(phase);
          }
          const result = await writeFile.call(this, path, ...args);
          if (phase === 'owner_written') await wait(phase);
          return result;
        }
        return writeFile.call(this, path, ...args);
      };
      fs.promises.symlink = async function(target, path, ...args) {
        const result = await symlink.call(this, target, path, ...args);
        if (phase === 'published' && String(path) === canonical) await wait(phase);
        return result;
      };
      syncBuiltinESMExports(); setInterval(() => {}, 1000);
      const { acquireLock } = await import(${JSON.stringify(locksUrl)});
      await acquireLock(process.argv[1], '.detect.lock'); await wait('published');
    `, f.config.dataDir, phase]);
    try { assert.equal(await crashing.ready(), phase); }
    finally { await crashing.stop(); }
    assert.equal(crashing.process.signalCode, 'SIGKILL');
    if (phase === 'published') {
      const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
      assert.equal(owner.program, 'personal-agent'); assert.equal(owner.pid, crashing.process.pid);
      assert.equal(typeof owner.token, 'string');
    } else await assert.rejects(lstat(path), { code: 'ENOENT' }, '初始化未完成时活跃锁名不能存在');
    await runOneScan(f.configPath, f.config.dataDir);
  });

for (const mode of ['outside-link', 'directory-link', 'owner-link', 'owner-hardlink', 'token-mismatch'] as const)
  test(`门禁返修3：不信任 ${mode}，不沿未知链接读取/清理其他文件`, async t => {
    const f = await fixture(t), name = '.unsafe.lock', path = join(f.config.dataDir, name);
    const token = '00000000-0000-4000-8000-000000000001';
    const target = `${name}.owned-${token}`, owned = join(f.config.dataDir, target);
    const outside = join(f.root, 'not-a-lock'); await mkdir(outside);
    const externalOwner = join(outside, 'owner.json');
    const original = 'SYNTHETIC_DO_NOT_PARSE_AS_OWNER'; await writeFile(externalOwner, original);
    if (mode === 'outside-link') await symlink(outside, path, 'dir');
    else {
      if (mode === 'directory-link') await symlink(outside, owned, 'dir');
      else {
        await mkdir(owned, { recursive: true });
        if (mode === 'owner-link') await symlink(externalOwner, join(owned, 'owner.json'));
        else if (mode === 'owner-hardlink') await link(externalOwner, join(owned, 'owner.json'));
        else await writeFile(join(owned, 'owner.json'), JSON.stringify({ program: 'personal-agent', pid: process.pid, token: 'not-the-link-token' }));
      }
      await symlink(target, path, 'dir');
    }
    const before = await readlink(path);
    await assert.rejects(recoverDeadLock(f.config.dataDir, name), /不可信|不明|普通目录/);
    await assert.rejects(acquireLock(f.config.dataDir, name), /正被占用/);
    assert.equal(await readlink(path), before); assert.equal(await readFile(externalOwner, 'utf8'), original);
  });

test('门禁返修3：旧目录锁的已退出 owner 仍可回收，空 owner 原样拒绝，不自动修补', async t => {
  const f = await fixture(t), pid = await deadOwner(f.config.dataDir, '.new.lock');
  const legacy = join(f.config.dataDir, '.legacy.lock'); await mkdir(legacy);
  await writeFile(join(legacy, 'owner.json'), JSON.stringify({ program: 'personal-agent', pid, token: 'old-format-token' }));
  await recoverDeadLock(f.config.dataDir, '.legacy.lock'); await assert.rejects(lstat(legacy), { code: 'ENOENT' });
  await recoverDeadLock(f.config.dataDir, '.new.lock'); await assert.rejects(lstat(join(f.config.dataDir, '.new.lock')), { code: 'ENOENT' });
  const broken = join(f.config.dataDir, '.broken.lock'); await mkdir(broken); await writeFile(join(broken, 'owner.json'), '');
  await assert.rejects(recoverDeadLock(f.config.dataDir, '.broken.lock'));
  assert.equal(await readFile(join(broken, 'owner.json'), 'utf8'), '');
  await assert.rejects(acquireLock(f.config.dataDir, '.broken.lock'), /正被占用/);
});

test('门禁返修2：空的未知锁、活 PID 和已变化 owner 仍不得被清掉', async t => {
  const f = await fixture(t), unknown = join(f.config.dataDir, '.unknown.lock');
  await mkdir(unknown, { recursive: true });
  await recoverDeadLock(f.config.dataDir, '.unknown.lock');
  assert.deepEqual(await readdir(unknown), []);
  await assert.rejects(acquireLock(f.config.dataDir, '.unknown.lock'), /正被占用/);
  const name = '.alive.lock', release = await acquireLock(f.config.dataDir, name), path = join(f.config.dataDir, name, 'owner.json');
  const before = await readFile(path, 'utf8');
  try {
    await recoverDeadLock(f.config.dataDir, name); assert.equal(await readFile(path, 'utf8'), before);
    await writeFile(path, JSON.stringify({ ...JSON.parse(before), token: 'different-owner' }));
    await assert.rejects(release(), /所有者变化/);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).token, 'different-owner');
  } finally { await writeFile(path, before); await release(); }
});
