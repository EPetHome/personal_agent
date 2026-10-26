import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { JudgedRecord, Notice } from '../src/core/types.ts';

const samples = process.env.PA_SAMPLE_ROOT_V2;
const options = { skip: samples ? false : '未配置 PA_SAMPLE_ROOT_V2；本批外部场景未核验' };
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
      // 连指纹检查也不跟随样本里的符号链接。
      else result[file] = entry.isSymbolicLink() ? `link:${await readlink(file)}`
        : createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await walk(path);
  return result;
}
before(async () => { if (samples) beforeFingerprint = await fingerprints(samples); });
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
function run(args: string[]) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TZ: 'America/New_York' } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
async function scene(name: string) {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-formats-'));
  dirs.push(root);
  const dataDir = join(root, 'data');
  const configPath = join(root, 'config.json');
  run([generator, join(samples!, name), dataDir, configPath]);
  return {
    root, dataDir,
    configure: async (change: (config: any) => void) => {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      change(config);
      await writeFile(configPath, JSON.stringify(config) + '\n');
    },
    detect: (now: string): { records: JudgedRecord[]; health: any[]; noticesAdded: number } =>
      JSON.parse(run([cli, 'detect', '--config', configPath, '--now', now, '--json'])),
    overview: (): { records: JudgedRecord[] } => JSON.parse(run([cli, 'overview', '--config', configPath, '--json'])),
    outbox: async (): Promise<Notice[]> => (await readFile(join(dataDir, 'outbox.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}
function rows(records: JudgedRecord[]) {
  return records.map(r => [r.tool, r.project, r.status, r.intent.initial]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
}
function noBlind(notices: Notice[]) { assert.ok(notices.every(n => n.kind !== 'blind')); }

test('本批 A1 / R1：Codex 新格式取本人意图，忽略噪音，子代理并入父会话', options, async () => {
  const s = await scene('R1-Codex新格式');
  s.detect('2026-10-20T09:15:00Z');
  const view = s.overview();
  assert.deepEqual(rows(view.records), [
    ['codex', '/demo/api', '进行中', '给订单导出加一个 CSV 格式'],
    ['codex', '/demo/web', '已完成', '把首页按钮颜色改成蓝色'],
  ]);
  assert.equal(view.records.find(r => r.project === '/demo/api')?.members?.length, 2);
  assert.ok(!JSON.stringify(view.records.map(r => r.intent)).includes('environment_context'));
  noBlind(await s.outbox());
});

test('本批 A2 / R2：CC 分块本人输入及无 origin 的旧版输入，排除命令记录', options, async () => {
  const s = await scene('R2-CC噪音与旧版');
  s.detect('2026-10-20T10:30:00Z');
  assert.deepEqual(rows(s.overview().records), [
    ['cc', '/demo/blog', '已完成', '给博客加一个归档页'],
    ['cc', '/demo/shop', '已完成', '把购物车按钮文字改成「加入购物车」'],
  ]);
  noBlind(await s.outbox());
});

test('回放返修 A2 / R3：Pi 跳过 v1，当前分支不把 custom_message 当追加要求', options, async () => {
  const s = await scene('R3-Pi老格式');
  s.detect('2026-10-20T11:30:00Z');
  const view = s.overview();
  assert.deepEqual(rows(view.records), [['pi', '/demo/blog', '已完成', '给博客首页加最近 5 篇文章']]);
  assert.deepEqual(view.records[0]?.intent.additions, []);
  noBlind(await s.outbox());
});

test('回放返修 A3 / R4：loop 只读项目下会话号总结，忽略资料和符号链接', options, async () => {
  const s = await scene('R4-loop目录');
  const view = s.detect('2026-10-20T13:30:00Z');
  assert.equal(view.records.length, 2);
  const notices = await s.outbox();
  assert.deepEqual(notices.map(n => [n.kind, n.level]).sort(), [
    ['loop_completed', '有空看'], ['loop_paused', '现在就要你'],
  ]);
  noBlind(notices);
});

test('回放返修 A4 / R5：单份损坏只报合并文件提醒，不遮蔽四个正常会话', options, async () => {
  const s = await scene('R5-一份坏文件');
  s.detect('2026-10-20T12:30:00Z');
  const records = s.overview().records;
  assert.equal(records.length, 4);
  assert.ok(records.every(r => r.status === '已完成'));
  const notices = await s.outbox();
  assert.equal(notices.length, 1);
  noBlind(notices);
  assert.match(notices[0]!.text, /Claude Code 有 1 份会话读不了/);
  assert.ok(Buffer.byteLength(notices[0]!.text, 'utf8') <= 4096);
  assert.ok((notices[0]!.text.match(/\.jsonl/g) ?? []).length <= 3);
});

test('回放返修 A5 / R6：来源目录缺失仍高优先级报失明，其他来源继续判断', options, async () => {
  const s = await scene('R6-来源目录不存在');
  await s.configure(c => { c.sources.codex = join(samples!, 'R6-来源目录不存在/codex-sessions-missing'); });
  s.detect('2026-10-20T14:10:00Z');
  assert.ok(s.overview().records.some(r => r.tool === 'cc' && r.status === '已完成'));
  const notices = await s.outbox();
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.kind, 'blind');
  assert.equal(notices[0]?.level, '现在就要你');
  assert.match(notices[0]!.text, /Codex.*看不见了[\s\S]*目录读不了/);
});

test('回放返修 A6 / R7：两种 CLI JSON 完整可解析，所有数据文件逐行合法且截断无半个字符', options, async () => {
  const s = await scene('R7-表情与长文本');
  s.detect('2026-10-20T15:10:00Z');
  const intent = s.overview().records[0]!.intent.initial!;
  assert.ok([...intent].length <= 1025, '长意图应有界');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/u.test(intent));
  for (const file of await readdir(s.dataDir)) {
    const text = await readFile(join(s.dataDir, file), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), file);
  }
});

test('回放返修 A7 / R8：显式忽略目录前缀后只显示正式项目，默认不忽略', options, async () => {
  const first = await scene('R8-临时目录会话');
  first.detect('2026-10-20T16:10:00Z');
  assert.equal(first.overview().records.length, 3);
  const second = await scene('R8-临时目录会话');
  await second.configure(c => { c.ignoreProjectPrefixes = ['/private/tmp', '/var/folders']; });
  second.detect('2026-10-20T16:10:00Z');
  assert.deepEqual(second.overview().records.map(r => r.project), ['/demo/shop']);
  assert.equal((await second.outbox()).length, 0);
});

test('回放返修 A8 / R9：三轮空跑后每轮新增不超过 10KB，发件不增加', options, async t => {
  const s = await scene('R9-空跑不膨胀');
  async function size() {
    let bytes = 0;
    for (const file of await readdir(s.dataDir)) bytes += (await stat(join(s.dataDir, file))).size;
    return bytes;
  }
  s.detect('2026-10-20T17:30:00Z');
  let previous = await size();
  const notices = await s.outbox();
  for (const time of ['17:35', '17:40']) {
    s.detect(`2026-10-20T${time}:00Z`);
    const current = await size();
    t.diagnostic(`${time} 新增 ${current - previous} 字节`);
    assert.ok(current - previous <= 10 * 1024);
    assert.deepEqual(await s.outbox(), notices);
    previous = current;
  }
});

test('回放返修 A9 / R10：首次只提醒一小时内的事，旧记录留总览，第二轮不补发', options, async () => {
  const s = await scene('R10-首次接入');
  const first = s.detect('2026-10-20T18:00:00Z');
  assert.equal(first.records.length, 4);
  assert.deepEqual((await s.outbox()).map(n => [n.tool, n.kind, n.content.evidence.project]).sort(), [
    ['cc', 'waiting', '/demo/shop'], ['loop', 'loop_paused', '/demo/blog'],
  ]);
  assert.equal(first.records.find(r => r.tool === 'cc' && r.project === '/demo/api')?.status, '在等我');
  assert.equal(first.records.find(r => r.tool === 'loop' && r.project === '/demo/shop')?.status, '已完成');
  assert.equal(s.detect('2026-10-20T18:10:00Z').noticesAdded, 0);
  assert.equal((await s.outbox()).length, 2);
  assert.equal(s.overview().records.length, 4);
});

test('回放返修 A10 / R11：超过24小时未结束是已搁置，仅40分钟的会话发停滞提醒', options, async () => {
  const s = await scene('R11-已搁置');
  s.detect('2026-10-20T18:00:00Z');
  assert.deepEqual(s.overview().records.map(r => [r.project, r.status]), [['/demo/a', '已搁置'], ['/demo/b', '停滞']]);
  assert.deepEqual((await s.outbox()).map(n => [n.kind, n.content.evidence.project]), [['stalled', '/demo/b']]);
});

test('本批只读保护：十一个场景全部文件及符号链接指纹不变', options, async t => {
  assert.deepEqual(await fingerprints(samples!), beforeFingerprint);
  t.diagnostic(`${Object.keys(beforeFingerprint).length} 项样本指纹一致（不跟随链接）`);
});
