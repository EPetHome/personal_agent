import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Notice } from '../src/core/types.ts';

// 协调样本不进代码库。必须显式给定；普通门禁仍运行自带的构造测试。
const samples = process.env.PA_SAMPLE_ROOT;
const options = { skip: samples ? false : '未配置 PA_SAMPLE_ROOT；外部场景另行核验' };
const cli = resolve(import.meta.dirname, '../src/cli/main.ts');
const generator = resolve(import.meta.dirname, '../deploy/sample-config.ts');
const dirs: string[] = [];
let beforeFingerprint: Record<string, string>;
async function fingerprints(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else result[file] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await walk(path);
  return result;
}
before(async () => { if (samples) beforeFingerprint = await fingerprints(samples); });
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
function run(args: string[], cwd?: string) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
async function scene(name: string) {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-scenario-'));
  dirs.push(root);
  const dataDir = join(root, 'data');
  const config = join(root, 'config.json');
  run([generator, join(samples!, name), dataDir, config]);
  return {
    root, dataDir, config,
    detect: (now: string) => JSON.parse(run([cli, 'detect', '--config', config, '--now', now, '--json'])),
    overview: () => run([cli, 'overview', '--config', config]),
    outbox: async (): Promise<Notice[]> => (await readFile(join(dataDir, 'outbox.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}
function noInternalId(notice: Notice) {
  assert.ok(!notice.text.includes(notice.id));
  assert.ok(!notice.text.includes(notice.dedupeKey));
  if (notice.sessionKey) assert.ok(!notice.text.includes(notice.sessionKey));
}

test('A1 协调场景：三个工具等授权，各有原文、项目、授权动作和回看命令', options, async () => {
  const s = await scene('01-等授权');
  const view = s.detect('2026-10-20T09:20:00Z');
  assert.equal(view.noticesAdded, 3);
  const notices = await s.outbox();
  assert.equal(notices.length, 3);
  for (const [tool, project, command, action] of [
    ['cc', '/demo/shop', 'claude --resume', 'git push origin main'],
    ['codex', '/demo/api', '/sample-tools/codex resume', 'csv-writer'],
    ['pi', '/demo/blog', 'pi --session', 'rm -rf build'],
  ]) {
    const notice = notices.find(n => n.tool === tool)!;
    assert.ok(notice);
    assert.equal(notice.level, '现在就要你');
    assert.equal(notice.content.evidence.project, project);
    assert.ok(notice.content.evidence.intentOriginal);
    assert.ok(notice.text.includes(command!));
    assert.ok(notice.text.includes(action!));
    noInternalId(notice);
  }
});

test('A2 协调场景：29 分钟进行中，31 分钟提醒一次，40 分钟去重', options, async () => {
  const s = await scene('02-干到一半');
  assert.equal(s.detect('2026-10-20T10:49:00Z').records[0].status, '进行中');
  assert.equal((await s.outbox()).length, 0);
  assert.equal(s.detect('2026-10-20T10:51:00Z').noticesAdded, 1);
  const [notice] = await s.outbox();
  assert.equal(notice?.level, '有空看');
  assert.match(notice!.text, /npm test.*31 分钟/);
  assert.match(notice!.text, /src\/orders.ts/);
  assert.match(notice!.text, /test\/orders.test.ts/);
  assert.equal(s.detect('2026-10-20T11:00:00Z').noticesAdded, 0);
  assert.equal((await s.outbox()).length, 1);
  assert.match(s.overview(), /去重/);
});

test('A3 协调场景：Codex 看不见，Claude Code 正常显示已完成', options, async () => {
  const s = await scene('03-看不见了');
  const view = s.detect('2026-10-20T12:00:00Z');
  const [notice] = await s.outbox();
  assert.equal(view.noticesAdded, 1);
  assert.equal(notice?.level, '现在就要你');
  assert.equal(notice?.tool, 'codex');
  assert.match(notice!.text, /Codex.*看不见了[\s\S]*2026-10-20T12:00:00.000Z/);
  assert.match(s.overview(), /Claude Code.*已完成/);
});

test('A4 协调场景：loop 暂停有真实项目、暂停原因和总结路径', options, async () => {
  const s = await scene('04-loop暂停');
  assert.equal(s.detect('2026-10-20T13:10:00Z').noticesAdded, 1);
  const [notice] = await s.outbox();
  assert.equal(notice?.level, '现在就要你');
  assert.equal(notice?.content.evidence.project, '/demo/shop');
  assert.match(notice!.text, /开发方需要你决定/);
  assert.match(notice!.text, /商品价格为空/);
  assert.ok(notice!.text.includes(join(samples!, '04-loop暂停/pi-autoreview/shop/')));
});

test('A5 协调场景：loop 完成交代含评审/返修次数、欠项、总结路径', options, async () => {
  const s = await scene('05-loop完成');
  assert.equal(s.detect('2026-10-20T14:10:00Z').noticesAdded, 1);
  const [notice] = await s.outbox();
  assert.equal(notice?.level, '有空看');
  assert.match(notice!.text, /完成；评审 3 次，返修 2 次/);
  assert.match(notice!.text, /A2 需人工/);
  assert.ok(notice!.text.includes(join(samples!, '05-loop完成/pi-autoreview/shop/')));
});

test('A6 协调场景：正常完成只进总览，不发提醒', options, async () => {
  const s = await scene('06-正常做完');
  const view = s.detect('2026-10-20T15:20:00Z');
  assert.equal(view.records[0].status, '已完成');
  assert.equal((await s.outbox()).length, 0);
  assert.match(s.overview(), /Claude Code.*已完成/);
});

test('A7 协调场景：四个来源每个会话一行，工具/项目/意图/状态/活动时间齐全', options, async () => {
  const s = await scene('07-全部正常');
  const view = s.detect('2026-10-20T16:30:00Z');
  assert.equal(view.records.length, 4);
  const text = s.overview();
  assert.equal(text.trim().split('\n').length, 5);
  for (const [tool, status] of [['cc', '已完成'], ['codex', '进行中'], ['pi', '已完成'], ['loop', '已完成']]) {
    const record = view.records.find((r: { tool: string }) => r.tool === tool);
    assert.equal(record.status, status);
    assert.ok(record.project);
    assert.ok(record.lastActivityAt);
  }
  for (const tool of ['Claude Code', 'Codex', 'Pi', 'loop']) assert.ok(text.includes(`${tool} | /demo/`));
  assert.match(text, /总结未提供开工指令/);
});

test('A8 协调场景：提醒证据的追加要求只有用户本人那一条', options, async () => {
  const s = await scene('08-追加要求');
  s.detect('2026-10-20T17:40:00Z');
  const [notice] = await s.outbox();
  assert.equal(notice?.kind, 'stalled');
  assert.deepEqual(notice?.content.evidence.additionalRequirements, ['顺便把注册页的同一句文案也改了']);
  assert.ok(!notice!.text.includes('task-notification'));
});

test('A9 协调场景：检测前后所有样本文件的 SHA-256 完全一致', options, async t => {
  assert.deepEqual(await fingerprints(samples!), beforeFingerprint);
  t.diagnostic(`${Object.keys(beforeFingerprint).length} 个只读样本文件指纹一致`);
});

test('A10 协调场景：无配置非 0 退出，并且没有生成任何数据文件', options, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'personal-agent-unconfigured-'));
  dirs.push(dir);
  const result = spawnSync(process.execPath, [cli, 'detect'], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /请先配置/);
  assert.deepEqual(await readdir(dir), []);
});
