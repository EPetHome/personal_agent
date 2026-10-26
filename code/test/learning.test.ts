import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detect, publishNotices, rebuild } from '../src/core/agent.ts';
import { agentNotice, changeExperience, experienceRevision, exportExperiences, readLearning, reviewItems } from '../src/core/learning.ts';
import type { ExperienceModel } from '../src/core/learning.ts';
import { receiveFeedback } from '../src/core/feedback.ts';
import { calculateStatistics, renderStatistics } from '../src/core/statistics.ts';
import { weeklySlot } from '../src/core/maintenance.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { appendJsonl, readEvents, readJsonl, readOutbox, withStoreLock } from '../src/core/store.ts';
import type { Config, Feedback, Notice } from '../src/core/types.ts';
import { loopSummary, put, sandbox } from './fixtures.ts';

const friday = '2026-10-23T18:00:00.000Z'; // 本文件子进程/门禁以 TZ=UTC 运行该调度测试。
const model: ExperienceModel = { async draft() { return { layer: '盯防自身', reason: '构造归因：阈值不适合', countermeasure: '先确认阈值与证据' }; }, async same() { return false; } };
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true })); f.config.sources.cc = null;
  f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 2000 };
  f.config.judge = { executable: '/test-only/no-real-model', model: 'test/fake', timeoutMs: 1000, dailyLimit: 100, cycleTimeoutMs: 3000 };
  return f;
}
function notice(id: string, at: string, tool: Notice['tool'] = 'cc', kind: Notice['kind'] = 'waiting'): Notice {
  return { version: 1, id, dedupeKey: id, at, tool, kind, level: '现在就要你', content: { title: '构造提醒', summary: '构造的授权等待', returnCommand: '返回构造会话', evidence: { project: '/sample/project', intentOriginal: '构造任务', additionalRequirements: [], recentSteps: [], reason: '构造判断', originals: [] } }, text: '构造提醒' };
}
function feedback(id: string | null, verdict: Feedback['verdict'], at: string, comment = ''): Feedback { return { version: 1, at, date: at.slice(0, 10), channel: 'test', noticeId: id, verdict, comment }; }
function cardValues(content: unknown): Record<string, string>[] {
  if (Array.isArray(content)) return content.flatMap(cardValues);
  if (!content || typeof content !== 'object') return [];
  const node = content as { tag?: string; value?: Record<string, string> };
  return node.tag === 'button' && node.value ? [node.value] : Object.values(content).flatMap(cardValues);
}
async function sentReview(config: Config, noticeId: string) {
  const message = (await readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl'))).find(m => m.noticeId === noticeId);
  assert.ok(message);
  const values = cardValues(message.content), agree = values.find(v => v.action === 'agree'), revise = values.find(v => v.action === 'revise');
  assert.ok(agree); assert.ok(revise); assert.ok(agree.experienceRevision);
  return { messageId: message.messageId, content: message.content, agree, revise };
}
async function publishReview(config: Config, key: string, at: string) {
  const state = await readLearning(config.dataDir);
  const reviews = reviewItems(state.problems, state.experiences, '2026-10-01T00:00:00.000Z', at);
  const notice = agentNotice('recurrence', key, at, '构造的新版本复盘', '请确认当前展示的对策', '查看构造记录', reviews);
  await publishNotices(config, [notice], at);
  return sentReview(config, notice.id);
}
async function clickReview(config: Config, id: string, messageId: string, value: Record<string, string>, at: string) {
  await appendJsonl(join(config.dataDir, 'feishu-inbox.jsonl'), [{ header: { event_type: 'card.action.trigger', event_id: id, create_time: String(Date.parse(at)) }, event: { operator: { open_id: 'ou_test' }, context: { open_message_id: messageId }, action: { value } } }]);
  await feishuChannel(config).drain(at);
}

test('统计按工具×类型现算：不回应不算正确、重复反馈取最新、未关联漏报保留，20条门槛不下结论', async () => {
  const outbox = Array.from({ length: 22 }, (_, i) => notice(`n${i}`, '2026-10-22T10:00:00.000Z'));
  outbox.push(notice('other', '2026-10-22T12:00:00.000Z', 'pi', 'stalled'));
  const rows = outbox.slice(0, 20).map((n, i) => feedback(n.id, i < 15 ? '正确' : '误报', '2026-10-22T13:00:00.000Z'));
  rows.push(feedback('n0', '误报', '2026-10-22T14:00:00.000Z'), feedback(null, '漏了', '2026-10-22T14:00:00.000Z', 'loop 暂停没叫我'), feedback('other', '正确', '2026-10-24T10:00:00.000Z'));
  const stats = calculateStatistics(outbox, rows, friday), cc = stats.cells.find(c => c.tool === 'cc')!;
  assert.equal(cc.correct, 14); assert.equal(cc.falsePositive, 6); assert.equal(cc.accuracy, .7); assert.equal(cc.responded, 20); assert.equal(cc.responseRate, 20 / 22); assert.equal(cc.perDay, 22 / 7); assert.equal(cc.sufficient, true);
  const pi = stats.cells.find(c => c.tool === 'pi')!; assert.equal(pi.correct, 0); assert.equal(pi.accuracy, null); assert.equal(pi.sufficient, false);
  assert.equal(stats.cells.find(c => c.tool === 'loop')!.missed, 1); assert.match(renderStatistics(stats), /不足 20 条，只列数字/);
});

test('段2 A8：本地周五18点实际CLI小结、统计与命令一致，不另存统计；重复/重建不再发', async t => {
  const { root, config } = await fixture(t); config.judge = null;
  await withStoreLock(config.dataDir, async () => {
    await appendJsonl(join(config.dataDir, 'outbox.jsonl'), [notice('one', '2026-10-22T10:00:00.000Z'), notice('two', '2026-10-22T11:00:00.000Z', 'pi', 'stalled')]);
    await appendJsonl(join(config.dataDir, 'feedback.jsonl'), [feedback('one', '误报', '2026-10-22T12:00:00.000Z'), feedback(null, '漏了', '2026-10-22T12:00:00.000Z', 'loop 暂停没叫我')]);
  });
  const path = join(root, 'config.json'); await put(path, JSON.stringify(config));
  const cli = (command: string) => spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), command, '--config', path, '--now', friday], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  const detected = cli('detect'); assert.equal(detected.status, 0, detected.stderr);
  const summary = (await readOutbox(config.dataDir)).find(n => n.kind === 'weekly')!; assert.ok(summary);
  for (const value of ['Claude Code × 在等你', 'Pi × 停滞', 'loop × loop 暂停', '准确率', '漏了', '回应率', '每天叫几次', '复盘']) assert.ok(summary.text.includes(value), value);
  const stats = cli('stats'); assert.equal(stats.status, 0, stats.stderr); assert.ok(summary.text.includes(stats.stdout.trim()));
  assert.equal((await readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl'))).filter(m => m.noticeId === summary.id).length, 1);
  await rebuild(config); assert.equal(cli('detect').status, 0); assert.equal((await readOutbox(config.dataDir)).filter(n => n.kind === 'weekly').length, 1);
  assert.ok((await readdir(config.dataDir)).every(name => !/statistics|stats/.test(name)));
});

test('周五调度采用运行机器当地时间（纽约与UTC），跨过时间点可补发，不补初次接入前历史', async t => {
  const script = `import {weeklySlot} from ${JSON.stringify(resolve(import.meta.dirname, '../src/core/maintenance.ts'))}; console.log(weeklySlot('2026-10-23T21:59:00Z').toISOString());`;
  const ny = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  assert.equal(ny.status, 0, ny.stderr); assert.equal(ny.stdout.trim(), '2026-10-16T22:00:00.000Z');
  assert.ok(Number.isFinite(weeklySlot(friday).getTime()));
  const { config } = await fixture(t); config.judge = null;
  await detect(config, '2026-10-20T10:00:00Z'); assert.ok(!(await readOutbox(config.dataDir)).some(n => n.kind === 'weekly'));
  await detect(config, '2026-10-24T10:00:00Z'); assert.equal((await readOutbox(config.dataDir)).filter(n => n.kind === 'weekly').length, 1);
});

test('段2 A9：先定对策，几天后同类第2次即时单发；周五排在新问题前，保留上次日期/对策', async t => {
  const { root, config } = await fixture(t);
  await detect(config, '2026-10-19T09:00:00Z', { experienceModel: model });
  await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at: '2026-10-19T10:00:00Z' });
  await detect(config, '2026-10-19T10:01:00Z', { experienceModel: model });
  let state = await readLearning(config.dataDir); const id = [...state.experiences.keys()][0]!;
  assert.equal(state.problems.length, 1); assert.equal(state.experiences.get(id)!.status, '待确认');
  await changeExperience(config.dataDir, id, '已确认', { countermeasure: '保留暂停信号并核对推送对账' }, '2026-10-19T11:00:00Z');
  await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at: '2026-10-22T10:00:00Z' });
  await detect(config, '2026-10-22T10:01:00Z', { experienceModel: model });
  const recurring = (await readOutbox(config.dataDir)).filter(n => n.kind === 'recurrence'); assert.equal(recurring.length, 1); assert.match(recurring[0]!.text, /第 2 次/); assert.match(recurring[0]!.text, /2026-10-19/); assert.match(recurring[0]!.text, /保留暂停信号/);
  await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 Pi 在等我', at: '2026-10-23T10:00:00Z' });
  // 在子进程显式 UTC，使用模型替身已有归因；此轮未分类新问题允许降级未定。
  const path = join(root, 'config.json'); config.judge = null; await put(path, JSON.stringify(config));
  const cli = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), 'detect', '--config', path, '--now', friday], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  assert.equal(cli.status, 0, cli.stderr);
  const summary = (await readOutbox(config.dataDir)).find(n => n.kind === 'weekly')!;
  assert.equal(summary.reviews![0]!.experienceId, id); assert.equal(summary.reviews![0]!.count, 2); assert.equal(summary.reviews![0]!.previousAt, '2026-10-19T10:00:00.000Z'); assert.match(summary.text, /有对策却又出现/);
  state = await readLearning(config.dataDir); assert.equal(state.problems.length, 3);
  const exported = await exportExperiences(config.dataDir); assert.match(exported, /# 经验集/); assert.match(exported, /来源/); assert.match(exported, /最后使用/); assert.match(exported, /保留暂停信号/);
});

test('四种来源收集、四层/未定起草、同类规则不确定才问模型；坏模型/额度耗尽安全降级', async t => {
  const { config, root } = await fixture(t); config.sources.loop = join(root, 'loop');
  await put(join(config.sources.loop, 'project/12345678-1234-1234-1234-123456789abc.md'), loopSummary('暂停（达到返修上限）'));
  await withStoreLock(config.dataDir, async () => { await appendJsonl(join(config.dataDir, 'outbox.jsonl'), [notice('correct', '2026-10-20T10:00:00.000Z'), notice('false', '2026-10-20T10:00:00.000Z')]); });
  await receiveFeedback(config.dataDir, 'test', { noticeId: 'correct', content: '正确', at: '2026-10-20T10:01:00Z' });
  await receiveFeedback(config.dataDir, 'test', { noticeId: 'false', content: '误报', at: '2026-10-20T10:01:00Z' });
  await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at: '2026-10-20T10:01:00Z' });
  let calls = 0;
  const uncertain: ExperienceModel = { async draft() { return { layer: '归因未定', reason: '构造证据不足', countermeasure: '人工核对' }; }, async same() { calls++; return true; } };
  await detect(config, '2026-10-20T10:02:00Z', { experienceModel: uncertain });
  let state = await readLearning(config.dataDir); assert.deepEqual(new Set(state.problems.map(p => p.type)), new Set(['正确:waiting', '误报', '漏了', 'loop返修']));
  await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 另一个暂停', at: '2026-10-21T10:01:00Z' });
  await detect(config, '2026-10-21T10:02:00Z', { experienceModel: uncertain }); assert.equal(calls, 1);
  state = await readLearning(config.dataDir); assert.equal(state.problems.filter(p => p.type === 'loop返修').length, 1);
  config.judge!.dailyLimit = 0;
  await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 Pi 在等我', at: '2026-10-21T10:03:00Z' });
  await detect(config, '2026-10-21T10:04:00Z', { experienceModel: { async draft() { throw new Error('不应调用'); }, async same() { throw new Error('不应调用'); } } });
  assert.equal((await readLearning(config.dataDir)).problems.at(-1)!.layer, '归因未定');
});

test('经验卡片同意/改一下、命令修改与四状态；撤销留原因，旧按钮不复活无效记忆', async t => {
  const { root, config } = await fixture(t);
  await detect(config, '2026-10-19T09:00:00Z', { experienceModel: model });
  for (const at of ['2026-10-19T10:00:00Z', '2026-10-20T10:00:00Z']) {
    await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at }); await detect(config, at, { experienceModel: model });
  }
  const state = await readLearning(config.dataDir), id = [...state.experiences.keys()][0]!;
  const notice = (await readOutbox(config.dataDir)).find(n => n.kind === 'recurrence')!;
  const sent = await sentReview(config, notice.id);
  await clickReview(config, 'agree', sent.messageId, sent.agree, '2026-10-20T10:01:00Z'); assert.equal((await readLearning(config.dataDir)).experiences.get(id)!.status, '已确认');
  await clickReview(config, 'stale-revise', sent.messageId, sent.revise, '2026-10-20T10:02:00Z'); assert.equal((await readLearning(config.dataDir)).experiences.get(id)!.status, '已确认');
  const refreshed = await publishReview(config, 'four-states-refreshed', '2026-10-20T10:03:00Z');
  await clickReview(config, 'revise', refreshed.messageId, refreshed.revise, '2026-10-20T10:04:00Z'); assert.equal((await readLearning(config.dataDir)).experiences.get(id)!.status, '待确认');
  const path = join(root, 'config.json'); await put(path, JSON.stringify(config));
  const cli = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), 'experience', 'confirm', id, '--countermeasure', '核对状态后再提醒', '--layer', '盯防自身', '--config', path], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout.trim(), '已记下');
  await changeExperience(config.dataDir, id, '已过时'); assert.equal((await readLearning(config.dataDir)).experiences.get(id)!.status, '已过时');
  await assert.rejects(changeExperience(config.dataDir, id, '已撤销'), /原因/);
  await changeExperience(config.dataDir, id, '已撤销', { note: '构造的撤销依据' });
  await clickReview(config, 'old-agree', sent.messageId, sent.agree, '2026-10-20T10:07:00Z'); assert.equal((await readLearning(config.dataDir)).experiences.get(id)!.status, '已撤销');
  assert.match(await exportExperiences(config.dataDir), /构造的撤销依据/);
});

test('返修1-2 旧卡片不能确认/退回新对策；绑定当前展示版本、写锁核验、重投幂等', async t => {
  const { root, config } = await fixture(t);
  for (const at of ['2026-10-19T10:00:00Z', '2026-10-20T10:00:00Z']) {
    await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at });
    await detect(config, at, { experienceModel: model });
  }
  const state = await readLearning(config.dataDir), id = [...state.experiences.keys()][0]!;
  const original = await sentReview(config, (await readOutbox(config.dataDir)).find(n => n.kind === 'recurrence')!.id);
  assert.ok(JSON.stringify(original.content).includes('先确认阈值与证据'));
  const path = join(root, 'config.json'); await put(path, JSON.stringify(config));
  const revised = spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), 'experience', 'revise', id, '--countermeasure', '用户后来修改的对策 B', '--now', '2026-10-20T10:01:00Z', '--config', path], { encoding: 'utf8' });
  assert.equal(revised.status, 0, revised.stderr);
  const b = (await readLearning(config.dataDir)).experiences.get(id)!;
  assert.equal(b.status, '待确认'); assert.notEqual(experienceRevision(b), original.agree.experienceRevision);
  const journal = join(config.dataDir, 'learning.jsonl'), before = await readFile(journal, 'utf8');
  await clickReview(config, 'old-agree-B', original.messageId, original.agree, '2026-10-20T10:02:00Z');
  await clickReview(config, 'old-revise-B', original.messageId, original.revise, '2026-10-20T10:02:01Z');
  await clickReview(config, 'forged-current-version', original.messageId, { ...original.agree, experienceRevision: experienceRevision(b) }, '2026-10-20T10:02:02Z');
  assert.equal(await readFile(journal, 'utf8'), before, '过期或伪造回调不追加经验版本');
  assert.deepEqual((await readLearning(config.dataDir)).experiences.get(id), b);
  const expired = (await readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl'))).filter(m => ['reply:old-agree-B', 'reply:old-revise-B', 'reply:forged-current-version'].includes(m.key));
  assert.equal(expired.length, 3); for (const reply of expired) assert.match(JSON.stringify(reply.content), /已过期，未修改经验/);
  const current = await publishReview(config, 'version-B', '2026-10-20T10:03:00Z');
  assert.ok(JSON.stringify(current.content).includes('用户后来修改的对策 B'));
  await clickReview(config, 'agree-B', current.messageId, current.agree, '2026-10-20T10:04:00Z');
  const confirmed = (await readLearning(config.dataDir)).experiences.get(id)!;
  assert.equal(confirmed.status, '已确认'); assert.equal(confirmed.countermeasure, '用户后来修改的对策 B');
  const committed = await readFile(journal, 'utf8');
  // 模拟经验已写入、渠道处理确认尚未落盘的重启窗口；不能因版本已换新重复写入。
  await rm(join(config.dataDir, 'feishu-receipts.jsonl'));
  await feishuChannel(config).drain('2026-10-20T10:05:00Z');
  assert.equal(await readFile(journal, 'utf8'), committed);
  assert.equal((await readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl'))).filter(m => m.key === 'reply:agree-B').length, 1);
  await clickReview(config, 'old-revise-confirmed-B', original.messageId, original.revise, '2026-10-20T10:06:00Z');
  assert.equal(await readFile(journal, 'utf8'), committed); assert.equal((await readLearning(config.dataDir)).experiences.get(id)!.status, '已确认');
  // 原内容改走再改回、时间相同也必须是新版本，不能让旧卡片通过 ABA 检查。
  await changeExperience(config.dataDir, id, '待确认', { countermeasure: '临时的对策 C' }, '2026-10-20T10:07:00Z');
  await changeExperience(config.dataDir, id, '待确认', { countermeasure: '用户后来修改的对策 B' }, '2026-10-20T10:07:00Z');
  const again = await readFile(journal, 'utf8');
  await clickReview(config, 'ABA-old-agree-B', current.messageId, current.agree, '2026-10-20T10:08:00Z');
  assert.equal(await readFile(journal, 'utf8'), again);
  const legacy = agentNotice('recurrence', 'legacy-no-version', '2026-10-20T10:09:00Z', '旧复盘', '旧对策', '查看构造记录', [{ ...reviewItems(state.problems, state.experiences, '2026-10-19T00:00:00Z', '2026-10-20T10:00:00Z')[0]!, experienceRevision: undefined }]);
  await publishNotices(config, [legacy], '2026-10-20T10:09:00Z');
  const legacySent = (await readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl'))).find(m => m.noticeId === legacy.id)!;
  assert.ok(!cardValues(legacySent.content).some(v => v.action === 'agree'));
  await clickReview(config, 'legacy-agree', legacySent.messageId, { action: 'agree', experienceId: id }, '2026-10-20T10:10:00Z');
  assert.equal(await readFile(journal, 'utf8'), again);
});

test('返修1-3 延迟收集：问题记录后才确认的对策不能当作事前对策，同刻亦不推断先后', async t => {
  for (const confirmationAt of ['2026-10-21T10:00:00Z', '2026-10-21T11:00:00Z']) {
    const { config } = await fixture(t);
    await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at: '2026-10-19T10:00:00Z' });
    await detect(config, '2026-10-19T10:01:00Z', { experienceModel: model });
    const id = [...(await readLearning(config.dataDir)).experiences.keys()][0]!;
    await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at: '2026-10-21T10:00:00Z' });
    await changeExperience(config.dataDir, id, '已确认', { countermeasure: '问题记录后才确认的对策' }, confirmationAt);
    const originalFeedback = await readFile(join(config.dataDir, 'feedback.jsonl'), 'utf8');
    await detect(config, '2026-10-22T10:00:00Z', { experienceModel: model });
    const state = await readLearning(config.dataDir), repeated = state.problems.findLast(p => p.experienceId === id)!;
    assert.equal(repeated.countermeasure, '', confirmationAt);
    const review = reviewItems(state.problems, state.experiences, '2026-10-19T00:00:00Z', '2026-10-22T10:00:00Z').find(r => r.experienceId === id)!;
    assert.equal(review.count, 2); assert.equal(review.previousCountermeasure, '');
    assert.doesNotMatch(review.title, /上次对策：|有对策却又出现/);
    const recurrence = (await readOutbox(config.dataDir)).find(n => n.kind === 'recurrence')!;
    assert.doesNotMatch(recurrence.text, /上次对策：|有对策却又出现/);
    assert.equal(await readFile(join(config.dataDir, 'feedback.jsonl'), 'utf8'), originalFeedback);
  }
});

test('返修1-3 延迟收集：期间修订/重新确认按发生时有效版本取A、B或无，历史事实不改写', async t => {
  for (const scenario of [
    { name: '发生后修订B待确认', before: false, confirmB: false, expected: '已在事前确认的对策 A' },
    { name: '发生后改成已确认B', before: false, confirmB: true, expected: '已在事前确认的对策 A' },
    { name: '发生前已修订B但未确认', before: true, confirmB: false, expected: '' },
    { name: '发生前已修订并确认B', before: true, confirmB: true, expected: '修订后的对策 B' },
  ]) {
    const { config } = await fixture(t);
    await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at: '2026-10-19T10:00:00Z' });
    await detect(config, '2026-10-19T10:01:00Z', { experienceModel: model });
    const id = [...(await readLearning(config.dataDir)).experiences.keys()][0]!;
    await changeExperience(config.dataDir, id, '已确认', { countermeasure: '已在事前确认的对策 A' }, '2026-10-19T11:00:00Z');
    const revise = async (day: string) => {
      await changeExperience(config.dataDir, id, '待确认', { countermeasure: '修订后的对策 B' }, `${day}T11:00:00Z`);
      if (scenario.confirmB) await changeExperience(config.dataDir, id, '已确认', undefined, `${day}T12:00:00Z`);
    };
    if (scenario.before) await revise('2026-10-20');
    await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at: '2026-10-21T10:00:00Z' });
    if (!scenario.before) await revise('2026-10-21');
    await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 Pi 在等我', at: '2026-10-22T09:00:00Z' });
    await detect(config, '2026-10-22T10:00:00Z', { experienceModel: model });
    const state = await readLearning(config.dataDir), problem = state.problems.findLast(p => p.experienceId === id)!;
    assert.equal(problem.countermeasure, scenario.expected, scenario.name);
    const reviews = reviewItems(state.problems, state.experiences, '2026-10-19T00:00:00Z', '2026-10-22T10:00:00Z');
    assert.equal(reviews[0]!.experienceId, id); assert.equal(reviews[0]!.count, 2); assert.equal(reviews[0]!.previousCountermeasure, scenario.expected);
    if (scenario.expected) assert.ok(reviews[0]!.title.includes(`上次对策：${scenario.expected}（有对策却又出现）`), scenario.name);
    else assert.doesNotMatch(reviews[0]!.title, /上次对策：|有对策却又出现/);
    await changeExperience(config.dataDir, id, '已确认', { countermeasure: '收集后再定的对策 C' }, '2026-10-22T11:00:00Z');
    await detect(config, '2026-10-22T12:00:00Z', { experienceModel: model });
    assert.deepEqual((await readLearning(config.dataDir)).problems.find(p => p.id === problem.id), problem, scenario.name);
  }
});

test('经验模型实际子进程边界用Pi替身：只读小上下文、严格是非、共享额度、凭证不传子进程', async t => {
  const { root, config } = await fixture(t);
  const command = join(root, 'fake-pi-learning'), capture = join(root, 'captured.jsonl');
  await writeFile(command, `#!${process.execPath}\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(process.env.FEISHU_APP_SECRET||process.env.FEISHU_APP_ID)process.exit(9);require('node:fs').appendFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),input})+'\\n');const answer=input.includes('是同一类问题吗')?{answer:'是'}:{layer:'归因未定',reason:'构造的证据不足',countermeasure:'先人工对账'};console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}]}}));});\n`); await chmod(command, 0o700);
  config.judge!.executable = command; config.judge!.timeoutMs = 5000; config.judge!.cycleTimeoutMs = 10000;
  const path = join(root, 'config.json'); await put(path, JSON.stringify(config));
  const cli = (now: string) => spawnSync(process.execPath, [resolve(import.meta.dirname, '../src/cli/main.ts'), 'detect', '--config', path, '--now', now], { encoding: 'utf8', env: { PATH: process.env.PATH, TZ: 'UTC', FEISHU_APP_ID: 'constructed-env-id', FEISHU_APP_SECRET: 'constructed-env-secret' } });
  await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 暂停没叫我', at: '2026-10-20T10:00:00Z' }); assert.equal(cli('2026-10-20T10:01:00Z').status, 0);
  await receiveFeedback(config.dataDir, 'test', { noticeId: null, content: '漏了 loop 另一次暂停没叫我', at: '2026-10-21T10:00:00Z' }); assert.equal(cli('2026-10-21T10:01:00Z').status, 0);
  const captured = await readJsonl<{ args: string[]; input: string }>(capture); assert.equal(captured.length, 3);
  for (const request of captured) { assert.ok(request.args.includes('--no-tools')); assert.ok(request.args.includes('--no-session')); assert.ok(request.args.includes('--no-extensions')); assert.ok(request.input.length < 6000); }
  const events = await readEvents(config.dataDir); assert.equal(events.filter(e => e.kind === 'model_call_started').length, 3);
  assert.equal([...((await readLearning(config.dataDir)).experiences.keys())].length, 1);
});

test('同一提醒重复正确反馈不算再次出现；只补反馈后经验不篡改原始事实', async t => {
  const { config } = await fixture(t);
  await withStoreLock(config.dataDir, async () => appendJsonl(join(config.dataDir, 'outbox.jsonl'), [notice('same-occurrence', '2026-10-20T10:00:00.000Z')]));
  for (const at of ['2026-10-20T10:01:00Z', '2026-10-21T10:01:00Z']) {
    await receiveFeedback(config.dataDir, 'test', { noticeId: 'same-occurrence', content: '正确', at }); await detect(config, at, { experienceModel: model });
  }
  assert.equal((await readLearning(config.dataDir)).problems.length, 1); assert.ok(!(await readOutbox(config.dataDir)).some(n => n.kind === 'recurrence'));
  const before = await readFile(join(config.dataDir, 'feedback.jsonl'), 'utf8');
  const id = [...(await readLearning(config.dataDir)).experiences.keys()][0]!;
  await changeExperience(config.dataDir, id, '已确认', { countermeasure: '构造确认的对策' });
  assert.equal(await readFile(join(config.dataDir, 'feedback.jsonl'), 'utf8'), before);
});
