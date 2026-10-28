import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, rebuild } from '../src/core/agent.ts';
import { readLearning } from '../src/core/learning.ts';
import { localNoticeText, localTime } from '../src/core/notice-text.ts';
import { readJsonl, readOutbox } from '../src/core/store.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { ccAnswer, ccUser, codexEvent, codexMeta, loopSummary, put, sandbox } from './fixtures.ts';

// 飞书版式用已离场且过等候窗口的时点。
const now = '2026-10-20T10:11:00.000Z';
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.feishu = { mode: 'fake', receiverId: 'ou_synthetic', timeoutMs: 1000 }; f.config.learning = false;
  return f;
}
// 只看第一屏：折叠的证据与按钮隐藏value不参与可读性断言。
function front(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(front).join('\n');
  if (!value || typeof value !== 'object') return '';
  if ('tag' in value && value.tag === 'collapsible_panel') return '';
  return Object.entries(value).filter(([key]) => key !== 'value').map(([, child]) => front(child)).join('\n');
}
function assertLayout(body: string) {
  let previous = -1;
  for (const label of ['**这件事**：', '**要你做**：', '**时间 / 回去看**：']) {
    const index = body.indexOf(label); assert.ok(index > previous, label); previous = index;
  }
  assert.doesNotMatch(body, /\d{4}-\d\d-\d\dT|transcript|推送|对账|来源|第\s*\d+\s*行|learning\.jsonl|feishu-.*\.jsonl/);
}
async function sent(dir: string, noticeId: string) {
  const message = (await readJsonl<SentMessage>(join(dir, 'feishu-sent.jsonl'))).find(m => m.noticeId === noticeId);
  assert.ok(message); return message.content;
}

test('飞书 A4：Claude Code 等回复卡片四件事，shop/意图/原问题/直达命令；本机同文案', async t => {
  const f = await fixture(t);
  f.config.judge = { executable: '/test-only/no-real-model', model: 'fake', timeoutMs: 1000, dailyLimit: 10 };
  const transcript = join(f.config.sources.cc!, 'sample.jsonl');
  const user = ccUser('给商品列表加缓存'), answer = ccAnswer();
  user.cwd = answer.cwd = '/demo/shop'; answer.message.content[0]!.text = '请你选择缓存保留五分钟还是十分钟？';
  await put(transcript, [user, answer]);
  const calls = join(f.root, 'notifications.jsonl'), executable = join(f.root, 'notification-stub');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\n`);
  await chmod(executable, 0o700); f.config.localChannel = { executable, timeoutMs: 5000 };
  await detect(f.config, now, { judge: { async judge(request) { return { answer: request.task === 'waiting' ? '是' : '否', reason: 'SYNTHETIC_REASON_ONLY_IN_EVIDENCE' }; } } });
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'waiting')!;
  assert.match(notice.content.title, /shop 的 Claude Code.*在等你/);
  const body = front(await sent(f.config.dataDir, notice.id)); assertLayout(body);
  assert.match(body, /shop 的 Claude Code/);
  assert.match(body, /\*\*这件事\*\*：给商品列表加缓存/);
  assert.match(body, /【回复会话】请你选择缓存保留五分钟还是十分钟？/);
  assert.match(body, /claude --resume demo-cc/);
  assert.ok(!body.includes(f.config.dataDir)); assert.doesNotMatch(body, /SYNTHETIC_REASON/);
  const local = (await readJsonl<string[]>(calls))[0]!;
  assert.equal(local.at(-2), notice.content.title);
  assert.equal(local.at(-1), localNoticeText(notice));
});

test('飞书 A5：单个Codex报信核对失败写清项目/会话/影响，只给该会话的恢复命令', async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.codex = join(f.root, 'codex');
  const transcript = join(f.config.sources.codex, 'known.jsonl'), meta = codexMeta('synthetic-codex-session'); meta.payload.cwd = '/demo/shop';
  await put(transcript, [meta, codexEvent({ type: 'user_message', message: '检查商品缓存' })]);
  await put(join(f.config.inboxDir!, 'codex.jsonl'), [{ tool: 'codex', event: 'waiting_permission', session_id: 'synthetic-codex-session', cwd: '/demo/shop',
    transcript_path: join(f.config.sources.codex, 'conflicting.jsonl'), at: now, detail: '构造报信与文件不匹配' }]);
  await detect(f.config, now);
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'blind')!;
  assert.match(notice.content.title, /shop 的 Codex/);
  const body = front(await sent(f.config.dataDir, notice.id)); assertLayout(body);
  assert.match(body, /shop 的 Codex/); assert.match(body, /\*\*这件事\*\*：检查商品缓存/);
  assert.match(body, /这个会话.*核对/); assert.match(body, /【你去做】请回去看看/);
  assert.match(notice.content.evidence.reason, /只影响这一个会话，同一工具的其他会话照常判断和提醒/);
  assert.doesNotMatch(notice.content.evidence.reason, /所有会话当前状态都暂时不能确认/);
  assert.match(notice.content.returnCommand, /resume synthetic-codex-session$/);
  assert.ok(!notice.content.returnCommand.includes(f.config.sources.codex)); assert.ok(!body.includes(f.config.dataDir));
  assert.match(notice.content.evidence.reason, /第 1 行推送与已读取会话对不上/);
});

test('飞书 A6：首次五份历史返修只计数，新一批推一张复盘，写清批次/次数/同类依据/确认后果', async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.loop = join(f.root, '.pi-autoreview'); f.config.learning = true;
  async function summary(n: number, at: string) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const path = join(f.config.sources.loop!, 'shop', `${id}.md`);
    await put(path, loopSummary('完成', '/demo/shop', '- 无', at).replace('loop-demo', id).replace('- 状态：', `- 批次：商品缓存第${n}批\n- 状态：`));
    return path;
  }
  const originals: [string, string][] = [];
  for (let n = 1; n <= 5; n++) { const path = await summary(n, '2026-10-19T10:00:00Z'); originals.push([path, await readFile(path, 'utf8')]); }
  await detect(f.config, now);
  assert.equal((await readLearning(f.config.dataDir)).problems.length, 5);
  assert.deepEqual((await readOutbox(f.config.dataDir)).filter(n => n.kind === 'recurrence'), []);
  assert.deepEqual(await readJsonl(join(f.config.dataDir, 'feishu-sent.jsonl')), []);
  const before = await readFile(join(f.config.dataDir, 'learning.jsonl'), 'utf8');
  const summaryPath = await summary(6, '2026-10-20T10:12:00Z');
  await detect(f.config, '2026-10-20T10:13:00Z');
  const reviews = (await readOutbox(f.config.dataDir)).filter(n => n.kind === 'recurrence'); assert.equal(reviews.length, 1);
  const review = reviews[0]!; assert.equal(review.reviews![0]!.count, 6);
  assert.match(review.content.title, /shop 的 loop.*商品缓存第6批.*返修 2 次/);
  const body = front(await sent(f.config.dataDir, review.id)); assertLayout(body);
  assert.match(body, /\*\*这件事\*\*：shop 的 loop · 商品缓存第6批/);
  assert.match(body, /返修 2 次/); assert.match(review.content.evidence.reason, /为什么算同类：同种工具出现同样的问题事实/);
  assert.match(body, /只确认经验/);
  assert.equal(review.content.returnCommand, `open ${summaryPath}`);
  assert.ok(!review.content.returnCommand.includes('learning.jsonl'));
  assert.ok((await readFile(join(f.config.dataDir, 'learning.jsonl'), 'utf8')).startsWith(before));
  await rebuild(f.config); await detect(f.config, '2026-10-20T10:14:00Z');
  assert.equal((await readOutbox(f.config.dataDir)).filter(n => n.kind === 'recurrence').length, 1);
  for (const [path, content] of originals) assert.equal(await readFile(path, 'utf8'), content);
});

test('卡片时间按本机当地日历：纽约夏令时的今晚/昨天，不显示UTC', () => {
  const previous = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    assert.equal(localTime('2026-10-27T03:11:00Z', '2026-10-27T03:30:00Z'), '今晚 23:11');
    assert.equal(localTime('2026-10-26T22:00:00Z', '2026-10-27T05:00:00Z'), '昨天 18:00');
    assert.equal(localTime('2026-11-01T03:30:00Z', '2026-11-02T04:30:00Z'), '昨天 23:30');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
