// 原样保留真实格式脱敏样本；当前入口不扫描聊天或旧总结，也不迁移旧事件。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readOutbox } from '../src/core/store.ts';
const samples = process.env.PA_SAMPLE_ROOT_V2, options = { skip: samples ? false : '未配置 PA_SAMPLE_ROOT_V2；外部场景另行核验' }, dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function fingerprint(path: string): Promise<Record<string, string>> { const all: Record<string, string> = {}; for (const entry of await readdir(path, { withFileTypes: true })) {
  const file = join(path, entry.name), stat = await lstat(file); if (stat.isSymbolicLink()) all[file] = `link:${await readlink(file)}`;
  else if (stat.isDirectory()) Object.assign(all, await fingerprint(file)); else all[file] = createHash('sha256').update(await readFile(file)).digest('hex'); } return all; }
function run(args: string[]) { const result = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
for (const name of ['R1-Codex新格式', 'R2-CC噪音与旧版', 'R3-Pi老格式', 'R4-loop目录', 'R5-一份坏文件', 'R6-来源目录不存在', 'R7-表情与长文本', 'R8-临时目录会话', 'R9-空跑不膨胀', 'R10-首次接入', 'R11-已搁置'])
  test(`脱敏历史格式减法：${name}不扫描聊天或旧loop总结，不改样本`, options, async () => {
    const before = await fingerprint(join(samples!, name)), root = await mkdtemp(join(tmpdir(), 'pa-format-')); dirs.push(root);
    const dataDir = join(root, 'data'), config = join(root, 'config.json'), cli = resolve(import.meta.dirname, '../src/cli/main.ts');
    run([resolve(import.meta.dirname, '../deploy/sample-config.ts'), join(samples!, name), dataDir, config]);
    const view = JSON.parse(run([cli, 'detect', '--config', config, '--now', '2026-10-20T15:00:00Z', '--json']));
    assert.deepEqual(view.tickets, {}); assert.deepEqual(view.assignments, {}); assert.deepEqual(view.cards, {}); assert.equal(view.observations.queries, 0);
    assert.deepEqual(await readOutbox(dataDir), []);
    for (const now of ['2026-10-20T15:05:00Z', '2026-10-20T15:10:00Z', '2026-10-20T15:15:00Z']) {
      const prior = await readFile(join(dataDir, 'ledger.jsonl')).catch(() => Buffer.alloc(0)); run([cli, 'detect', '--config', config, '--now', now]);
      assert.deepEqual(await readFile(join(dataDir, 'ledger.jsonl')).catch(() => Buffer.alloc(0)), prior, '无新事件不反复写事实、不调模型');
    }
    assert.deepEqual(await readOutbox(dataDir), []); assert.deepEqual(await fingerprint(join(samples!, name)), before);
  });
