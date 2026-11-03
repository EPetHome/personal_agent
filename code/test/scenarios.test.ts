// 只读历史场景继续参与门禁：聊天与旧loop总结均不再驱动当前运行入口。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readOutbox } from '../src/core/store.ts';
const samples = process.env.PA_SAMPLE_ROOT, options = { skip: samples ? false : '未配置 PA_SAMPLE_ROOT；外部场景另行核验' };
const dirs: string[] = []; after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function fingerprint(path: string): Promise<Record<string, string>> { const all: Record<string, string> = {}; for (const entry of await readdir(path, { withFileTypes: true })) {
  const file = join(path, entry.name); if (entry.isDirectory()) Object.assign(all, await fingerprint(file)); else all[file] = createHash('sha256').update(await readFile(file)).digest('hex'); } return all; }
function run(args: string[]) { const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
for (const name of ['01-等授权', '02-干到一半', '03-看不见了', '04-loop暂停', '05-loop完成', '06-正常做完', '07-全部正常', '08-追加要求'])
  test(`历史场景减法：${name}没有新协议事件就不出卡，不修改样本`, options, async () => {
    const before = await fingerprint(join(samples!, name)), root = await mkdtemp(join(tmpdir(), 'pa-scenario-')); dirs.push(root);
    const dataDir = join(root, 'data'), config = join(root, 'config.json');
    run([resolve(import.meta.dirname, '../deploy/sample-config.ts'), join(samples!, name), dataDir, config]);
    const now = name === '04-loop暂停' ? '2026-10-20T13:10:00Z' : name === '05-loop完成' ? '2026-10-20T14:10:00Z' : '2026-10-20T16:30:00Z';
    const cli = resolve(import.meta.dirname, '../src/cli/main.ts'), view = JSON.parse(run([cli, 'detect', '--config', config, '--now', now, '--json']));
    assert.deepEqual(view.tickets, {}); assert.deepEqual(view.assignments, {}); assert.deepEqual(view.cards, {}); assert.equal(view.observations.queries, 0);
    if (name === '04-loop暂停') run([cli, 'detect', '--config', config, '--now', '2026-10-20T13:15:00Z']);
    assert.deepEqual(await readOutbox(dataDir), [], '新结构不从旧总结补发暂停/完成；新协议保留项由managed-loop专项覆盖');
    assert.deepEqual(await fingerprint(join(samples!, name)), before);
  });
