// D31 / 本批 A1–A9：全部为构造数据，只使用临时目录、判断器和渠道替身。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock } from '../src/core/locks.ts';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { noticeCard } from '../src/channels/feishu/card.ts';
import { agentNotice, readLearning } from '../src/core/learning.ts';
import { calculateStatistics } from '../src/core/statistics.ts';
import { intentText, isHuman } from '../src/core/utils.ts';
import { localNoticeText } from '../src/core/notice-text.ts';
import { judgmentPrompt, validateJudgment } from '../src/core/model.ts';
import { codex } from '../src/sources/codex/index.ts';
import { pi } from '../src/sources/pi/index.ts';
import { event } from '../src/core/events.ts';
import { appendJsonl, readEvents, readJsonl, readOutbox, withStoreLock } from '../src/core/store.ts';
import { cc } from '../src/sources/cc/index.ts';
import { hash } from '../src/core/utils.ts';
import type { JudgmentRequest, ModelCheck, Notice } from '../src/core/types.ts';
import { readFeedback, receiveFeedback } from '../src/core/feedback.ts';
import { renderOverview } from '../src/core/judge.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, loopSummary, piHeader, piMessage, put, pushed, sandbox, start } from './fixtures.ts';

const now = '2026-10-20T10:01:00.000Z';
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.learning = false;
  f.config.judge = { executable: '/test-only/never-real-model', model: 'synthetic-new-model', timeoutMs: 1000, dailyLimit: 20 };
  return f;
}

test('A1/A2：误报立即按会话和原因抑制，下一次等待不发、其他会话及不同原因照常；原反馈只追加', async t => {
  const f = await fixture(t); f.config.judge = null;
  const file = join(f.config.sources.cc!, 'one.jsonl');
  await put(file, [ccUser('商品缓存任务'), ccCall()]);
  await put(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(file)]);
  await detect(f.config, now);
  const notice = (await readOutbox(f.config.dataDir))[0]!;
  const response = await receiveFeedback(f.config.dataDir, 'local', { noticeId: notice.id, content: '误报 不用叫我', at: '2026-10-20T10:02:00Z' });
  assert.match(response, /这个会话之后不会再因为等你回复或授权叫你/);
  const bytes = await readFile(join(f.config.dataDir, 'feedback.jsonl'), 'utf8');
  assert.equal((await overview(f.config)).records[0]!.notice, '因你的误报没提醒', '点完反馈查询立即可见，不等新检测');
  await appendFile(file, JSON.stringify(ccCall('2026-10-20T10:03:00Z')) + '\n');
  await appendJsonl(join(f.config.inboxDir!, 'cc.jsonl'), [pushed(file, 'waiting_permission', '2026-10-20T10:03:01Z')]);
  const other = join(f.config.sources.cc!, 'two.jsonl');
  await put(other, [ccUser('另一会话'), ccCall('2026-10-20T10:03:00Z')].map(row => ({ ...row, sessionId: 'other-session' })));
  await appendJsonl(join(f.config.inboxDir!, 'cc.jsonl'), [{ ...pushed(other, 'waiting_permission', '2026-10-20T10:03:01Z'), session_id: 'other-session' }]);
  const view = await detect(f.config, '2026-10-20T10:04:00Z');
  assert.equal(view.noticesAdded, 1);
  assert.equal(view.records.find(r => r.sessionId === 'demo-cc')!.notice, '因你的误报没提醒');
  assert.match(renderOverview(view.records, view.projection), /因你的误报没提醒/);
  assert.equal((await readOutbox(f.config.dataDir)).filter(n => n.sessionKey === 'cc:demo-cc').length, 1);
  assert.ok((await readOutbox(f.config.dataDir)).some(n => n.sessionKey === 'cc:other-session'));
  // 同一会话已解除等待后，另一种原因（停滞）不受误报影响。
  await appendFile(file, JSON.stringify(ccCall('2026-10-20T10:05:00Z')) + '\n');
  await detect(f.config, '2026-10-20T10:36:00Z');
  assert.ok((await readOutbox(f.config.dataDir)).some(n => n.sessionKey === 'cc:demo-cc' && n.kind === 'stalled'));
  await rebuild(f.config); assert.equal(await readFile(join(f.config.dataDir, 'feedback.jsonl'), 'utf8'), bytes);
  assert.equal((await readFeedback(f.config.dataDir)).length, 1);
});

test('A8：旧版数据的等待/跑偏判断与发件按事实认回；提取、模型配置变化不重判重发，历史字节不动', async t => {
  const f = await fixture(t), transcript = join(f.config.sources.cc!, 'sample.jsonl');
  const answer = ccAnswer(); answer.message.content[0]!.text = '缓存要保留五分钟还是十分钟？';
  const rows = [ccUser('合入。'), ccUser('给商品列表加缓存'), answer];
  await put(transcript, rows);
  const record = cc.parse(rows.map(row => JSON.stringify(row)).join('\n'), { path: transcript, fingerprint: 'old-file' })!;
  record.intent.initial = '[Image: source: /synthetic/screenshot.png]';
  const checks: ModelCheck[] = (['waiting', 'drift'] as const).map(task => ({
    key: `${task}:${record.key}${task === 'waiting' ? `:${record.sessionId}` : ''}`, recordKey: record.key, sessionId: record.sessionId,
    task, evidenceAt: start, at: now, fingerprint: `old-extraction-${task}`, stepIds: [], summary: '旧版摘要',
    result: { answer: task === 'waiting' ? '是' : '否', reason: '旧版已判断过' },
  }));
  const key = `model_waiting:${record.key}:${checks[0]!.fingerprint}`;
  const old: Notice = { version: 1, id: hash(key), dedupeKey: key, at: now, kind: 'waiting', tool: 'cc', level: '现在就要你', sessionKey: record.key,
    content: { title: '旧版提醒原件', summary: '旧版第一屏', returnCommand: 'claude --resume demo-cc', evidence: {
      project: record.project, intentOriginal: record.intent.initial, additionalRequirements: [], recentSteps: [], reason: '旧判断', originals: record.originals,
    } }, text: '旧版提醒原件，不可改写' };
  await withStoreLock(f.config.dataDir, async () => {
    await appendJsonl(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'session_observed', record }, start), event({ kind: 'scan_completed' }, start),
      ...checks.map(check => event({ kind: 'model_checked', check }, now)),
      event({ kind: 'model_checked', check: { ...checks[0]!, fingerprint: 'old-reextract-failed', result: undefined, error: '调用失败，仅规则判断' } }, now),
      event({ kind: 'notice_planned', notice: old }, now), event({ kind: 'notices_delivered', ids: [old.id] }, now)]);
    await appendJsonl(join(f.config.dataDir, 'outbox.jsonl'), [old]);
  });
  const beforeEvents = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8'), beforeOutbox = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8');
  let calls = 0;
  const judge = { async judge() { calls++; return { answer: '否' as const, reason: '不应重新调用' }; } };
  const view = await detect(f.config, now, { judge });
  assert.equal(calls, 0); assert.equal(view.noticesAdded, 0); assert.equal(view.records[0]!.notice, '已提醒，本轮去重');
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'model_call_started').length, 0);
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(beforeEvents));
  assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), beforeOutbox);
  await overview(f.config); await rebuild(f.config); await detect(f.config, '2026-10-20T10:02:00Z', { judge });
  assert.equal(calls, 0); assert.equal((await readOutbox(f.config.dataDir)).length, 1);
  // 真正的新一次停下仍照常判断、提醒，不能只按会话终身去重。
  const next = ccAnswer('2026-10-20T10:03:00Z'); next.message.content[0]!.text = '旧缓存直接删除吗？';
  await appendFile(transcript, JSON.stringify(next) + '\n');
  await detect(f.config, '2026-10-20T10:11:00Z', { judge: { async judge(request) { calls++; return { answer: request.task === 'waiting' ? '是' : '否', reason: '新证据' }; } } });
  assert.ok(calls > 0); assert.equal((await readOutbox(f.config.dataDir)).length, 2);
});

function front(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(front).join('\n');
  if (!value || typeof value !== 'object' || ('tag' in value && value.tag === 'collapsible_panel')) return '';
  return Object.entries(value).filter(([key]) => key !== 'value').map(([, child]) => front(child)).join('\n');
}
function values(value: unknown): Record<string, string>[] {
  if (Array.isArray(value)) return value.flatMap(values);
  if (!value || typeof value !== 'object') return [];
  if ('tag' in value && value.tag === 'button' && 'value' in value) return [value.value as Record<string, string>];
  return Object.values(value).flatMap(values);
}
function syntheticNotice(id: string): Notice {
  return { version: 1, id, dedupeKey: id, at: now, tool: 'cc', kind: 'waiting', level: '现在就要你', sessionKey: `cc:${id}`,
    content: { title: `shop 的 Claude Code 在等你回复（${id}）`, summary: '这件事：商品缓存方案待确认\n\n要你做：请选缓存保留多久', situation: '商品缓存方案待确认', action: '请选缓存保留多久',
      returnCommand: `claude --resume ${id}`, evidence: { project: '/demo/shop', intentOriginal: '商品缓存', additionalRequirements: [], recentSteps: [], reason: '构造判断', originals: [] } }, text: '构造卡片' };
}

test('A3：实际飞书按钮与引用「看不懂」带原卡片/原话/时间进入问题，周报/复盘也能反馈；重投只处理一次', async t => {
  const f = await fixture(t); f.config.judge = null; f.config.learning = true;
  f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 1000 };
  await detect(f.config, start);
  const regular = syntheticNotice('regular'), weekly = agentNotice('weekly', 'synthetic-weekly', now, '本周小结', '这件事：本周问题汇总\n\n要你做：请有空看', '查看原提醒');
  const recurrence = agentNotice('recurrence', 'synthetic-review', now, '问题复盘', '这件事：误报再次出现\n\n要你做：请确认对策', '查看原提醒');
  await withStoreLock(f.config.dataDir, () => appendJsonl(join(f.config.dataDir, 'outbox.jsonl'), [regular, weekly, recurrence]));
  for (const notice of [regular, weekly, recurrence]) await feishuChannel(f.config).send(notice);
  const sent = await readJsonl<SentMessage>(join(f.config.dataDir, 'feishu-sent.jsonl'));
  const one = sent.find(m => m.noticeId === regular.id)!, two = sent.find(m => m.noticeId === weekly.id)!;
  for (const notice of [regular, weekly, recurrence]) {
    const verdicts = values(noticeCard(notice)).map(v => v.verdict).filter(Boolean);
    assert.ok(verdicts.includes('看不懂'));
    if (notice.kind !== 'waiting') assert.deepEqual(verdicts, ['看不懂']);
  }
  const at = '2026-10-20T10:02:00.000Z';
  const click = { header: { event_type: 'card.action.trigger', event_id: 'unreadable-button', create_time: String(Date.parse(at)) }, event: {
    operator: { open_id: 'ou_test' }, context: { open_message_id: one.messageId }, action: { value: values(one.content).find(v => v.verdict === '看不懂') },
  } };
  const quote = { header: { event_type: 'im.message.receive_v1', event_id: 'unreadable-quote', create_time: String(Date.parse(at)) }, event: {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_test' } },
    message: { message_id: 'om_quote', message_type: 'text', chat_type: 'p2p', parent_id: two.messageId, content: JSON.stringify({ text: '看不懂 太挤了' }) },
  } };
  const inbox = join(f.config.dataDir, 'feishu-inbox.jsonl'); await appendJsonl(inbox, [click, quote, click]);
  const channel = feishuChannel(f.config); assert.equal(await channel.drain(at), 2);
  const feedback = await readFeedback(f.config.dataDir); assert.equal(feedback.length, 2);
  assert.deepEqual(feedback.map(f => f.originalText), ['看不懂', '看不懂 太挤了']);
  assert.deepEqual(feedback.map(f => f.card?.title), [regular.content.title, weekly.content.title]);
  assert.ok(feedback.every(f => f.at === at && !!f.card?.firstScreen));
  const replies = (await readJsonl<SentMessage>(join(f.config.dataDir, 'feishu-sent.jsonl'))).filter(m => m.type === 'text');
  assert.equal(replies.length, 2); for (const reply of replies) assert.match(JSON.stringify(reply.content), /已记下.*本周的问题汇总/);
  const before = await readFile(inbox, 'utf8');
  await detect(f.config, '2026-10-20T10:03:00Z');
  const problems = (await readLearning(f.config.dataDir)).problems; assert.equal(problems.length, 2);
  assert.deepEqual(problems.map(p => p.card?.title), [regular.content.title, weekly.content.title]);
  assert.ok(problems.every(p => p.type === '看不懂' && p.at === at)); assert.equal(problems[1]!.originalText, '看不懂 太挤了');
  assert.equal(await readFile(inbox, 'utf8'), before); await channel.drain(at); assert.equal((await readFeedback(f.config.dataDir)).length, 2);
  const configPath = join(f.root, 'config.json'); await put(configPath, JSON.stringify(f.config));
  const cli = spawnSync(process.execPath, [join(import.meta.dirname, '../src/cli/main.ts'), 'feedback', '看不懂', '段落太挤', '--id', recurrence.id, '--config', configPath, '--now', at], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /已记下.*本周的问题汇总/);
  assert.equal((await readFeedback(f.config.dataDir)).at(-1)!.comment, '段落太挤');
});

test('A4：3次看不懂、2次误报、5次正确，周报分类计数；正确不进问题、不推复盘；看不懂不覆盖准确率', async t => {
  const f = await fixture(t); f.config.judge = null; f.config.learning = true; f.config.sources.cc = null;
  const tz = process.env.TZ; process.env.TZ = 'UTC';
  try {
    await detect(f.config, '2026-10-19T10:00:00Z');
    const notices = Array.from({ length: 10 }, (_, i) => syntheticNotice(`n-${i}`));
    await withStoreLock(f.config.dataDir, () => appendJsonl(join(f.config.dataDir, 'outbox.jsonl'), notices));
    for (let i = 0; i < 10; i++) await receiveFeedback(f.config.dataDir, 'local', { noticeId: notices[i]!.id,
      content: `${i < 3 ? '看不懂' : i < 5 ? '误报' : '正确'} 构造的第${i}种具体反馈`, at: '2026-10-20T10:02:00Z' });
    await detect(f.config, '2026-10-23T18:00:00Z');
    const outbox = await readOutbox(f.config.dataDir), weekly = outbox.find(n => n.kind === 'weekly')!;
    assert.ok(weekly); assert.match(weekly.text, /看不懂 3 次/); assert.match(weekly.text, /误报 2 次/);
    assert.match(weekly.content.evidence.reason, /看不懂（单列）\n看不懂 · Claude Code · 在等你：3 次/);
    const state = await readLearning(f.config.dataDir); assert.equal(state.problems.length, 5);
    assert.ok(state.problems.every(p => p.type !== '正确')); assert.ok(!outbox.some(n => n.kind === 'recurrence'));
    const cell = calculateStatistics(outbox, await readFeedback(f.config.dataDir), '2026-10-23T18:00:00Z').cells.find(c => c.kind === 'waiting')!;
    assert.equal(cell.correct, 5); assert.equal(cell.falsePositive, 2); assert.equal(cell.unreadable, 3); assert.equal(cell.responded, 10);
    await receiveFeedback(f.config.dataDir, 'local', { noticeId: notices[5]!.id, content: '看不懂 内容不清楚', at: '2026-10-23T18:01:00Z' });
    const after = calculateStatistics(outbox, await readFeedback(f.config.dataDir), '2026-10-23T18:02:00Z').cells.find(c => c.kind === 'waiting')!;
    assert.equal(after.correct, 5); assert.equal(after.falsePositive, 2);
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
});

for (const first of ['合入。', '[Image: source: /synthetic/screenshot.png]']) test(`A5/A7：长会话以${first.startsWith('[') ? '截图' : '合入'}开头，判断顺带写两句；三块分开，原文只在证据，本机措辞一致`, async t => {
  const f = await fixture(t); f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 1000 };
  const answer = ccAnswer(); answer.cwd = '/demo/shop';
  answer.message.content[0]!.text = '接口层已改完。\n等你选择：\n- 保留旧缓存\n  旧缓存保留多久？\n- 删除旧缓存';
  await put(join(f.config.sources.cc!, 'sample.jsonl'), [ccUser(first), ...Array.from({ length: 25 }, (_, i) => ccUser(`早期第${i}轮讨论`)), ccUser('给商品列表加缓存，现在讨论旧缓存怎么处理'), answer].map(row => ({ ...row, cwd: '/demo/shop' })));
  const captured = join(f.root, 'local-calls.jsonl'), executable = join(f.root, 'notify-stub');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(captured)},JSON.stringify(process.argv.slice(2))+'\\n');\n`); await chmod(executable, 0o700);
  f.config.localChannel = { executable, timeoutMs: 5000 };
  const situation = '给商品列表加缓存：接口层已改完，卡在旧缓存怎么处理', action = '请确认旧缓存是保留还是删除';
  let calls = 0;
  await detect(f.config, now, { judge: { async judge(request) { calls++; return { answer: request.task === 'waiting' ? '是' : '否', reason: 'SYNTHETIC_PRIVATE_REASON', situation, action }; } } });
  assert.equal(calls, 2, '写卡片不能额外调用模型');
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'waiting')!;
  assert.equal(notice.content.situation, situation); assert.equal(notice.content.action, action);
  const card = noticeCard(notice), firstBlocks = card.body.elements.slice(0, 3) as { tag: string; content: string }[];
  assert.deepEqual(firstBlocks.map(b => b.tag), ['markdown', 'markdown', 'markdown']);
  for (const block of firstBlocks) assert.ok(block.content.split('\n').length <= 2);
  const body = front(card); for (const label of ['**这件事**', '**要你做**', '**时间 / 回去看**']) assert.ok(body.includes(label));
  assert.doesNotMatch(body, /合入。|SYNTHETIC_PRIVATE_REASON|\[Image|<ide_|\d{4}-\d\d-\d\dT|第\s*\d+\s*行|events\.jsonl/);
  assert.match(JSON.stringify(card), /SYNTHETIC_PRIVATE_REASON/); assert.match(JSON.stringify(card), /旧缓存保留多久/);
  assert.equal((await readJsonl<string[]>(captured))[0]!.at(-1), localNoticeText(notice));
  assert.ok(notice.content.summary.includes(situation) && notice.content.summary.includes(action));
});

for (const mode of ['unavailable', 'timeout', 'missing-copy'] as const) test(`A6：IDE标签开头、判断器${mode}时仍有合格兜底，末尾列表问题不丢`, async t => {
  const f = await fixture(t);
  if (mode === 'timeout') f.config.judge!.timeoutMs = 5;
  const answer = ccAnswer(); answer.message.content[0]!.text = '请确认旧缓存的处理：\n- 保留旧缓存\n  保留多久？\n- 直接删除';
  await put(join(f.config.sources.cc!, 'sample.jsonl'), [ccUser('<ide_opened_file>INJECTED_FILE_ONLY</ide_opened_file>'), ccUser('合入。'),
    ccUser('<ide_selection>INJECTED_SELECTION</ide_selection>\n给商品列表加缓存\n<system-reminder>INJECTED_SYSTEM</system-reminder>\n[Attachment: /synthetic/a.pdf]'), answer]);
  await detect(f.config, now, { judge: { async judge(request) {
    if (mode === 'unavailable') throw new Error('synthetic unavailable');
    if (mode === 'timeout') return new Promise(() => {});
    return { answer: request.task === 'waiting' ? '是' : '否', reason: '旧版答案没有两句文案' };
  } } });
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'waiting')!; assert.ok(notice);
  assert.match(notice.content.situation!, /给商品列表加缓存/); assert.match(notice.content.action!, /保留多久/);
  assert.doesNotMatch(front(noticeCard(notice)), /合入。|INJECTED|ideopened|system-reminder|\[Attachment|\.pdf/);
  assert.match(notice.content.evidence.assistantReply!, /保留多久/);
});

for (const tool of ['cc', 'codex', 'pi'] as const) for (const trailing of ['', '\n给商品列表加缓存']) test(`IDE标签只有块/块后有文字：${tool} ${trailing ? '带正文' : '只标签'}，不把注入视作意图`, () => {
  const text = '<ide_opened_file>opened a file</ide_opened_file>\n<system-reminder>system block</system-reminder>' + trailing;
  assert.equal(intentText(text), trailing.trim());
  const rows = tool === 'cc' ? [{ ...ccUser(text), origin: undefined }, ccAnswer()]
    : tool === 'codex' ? [codexMeta(), codexEvent({ type: 'user_message', message: text }), codexEvent({ type: 'task_complete', last_agent_message: '完成' })]
      : [piHeader(), piMessage('u', null, 'user', text), piMessage('a', 'u', 'assistant', '完成')];
  const record = ({ cc, codex, pi }[tool]).parse(rows.map(row => JSON.stringify(row)).join('\n'), { path: '/synthetic/sample.jsonl', fingerprint: 'synthetic' })!;
  assert.equal(record.intent.initial, trailing.trim() || null);
});

for (const shape of ['event', 'item', 'payload'] as const) test(`评审返修2：Codex 旧真人要求加新版纯注入（${shape}）仍执行跑偏检查`, async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.codex = join(f.root, 'codex');
  const item = { type: 'UserMessage', content: '<environment_context>构造的系统环境</environment_context>' };
  const injected = shape === 'event' ? codexEvent({ type: 'item_completed', item })
    : shape === 'item' ? { type: 'item_completed', timestamp: start, item }
      : { type: 'item_completed', timestamp: start, payload: item };
  await put(join(f.config.sources.codex, 'sample.jsonl'), [codexMeta(),
    codexEvent({ type: 'user_message', message: '只改 A 文件' }), injected,
    codexEvent({ type: 'function_call', name: 'shell', call_id: 'b', arguments: JSON.stringify({ command: '修改 B 模块' }) }, 'response_item'),
  ]);
  const calls: JudgmentRequest[] = [];
  const view = await detect(f.config, now, { judge: { async judge(request) {
    calls.push(request);
    return { answer: '是', reason: 'B 不在指定范围内', intentQuote: '只改 A 文件', stepQuote: '修改 B 模块' };
  } } });
  assert.equal(view.records[0]!.intent.initial, '只改 A 文件');
  assert.deepEqual(view.records[0]!.intent.additions, []);
  assert.deepEqual(calls.map(request => request.task), ['drift'], '纯注入不得吞掉旧真人要求而静默停用防跑偏');
  assert.equal(view.records[0]!.status, '疑似跑偏');
  assert.equal((await readOutbox(f.config.dataDir)).filter(notice => notice.kind === 'drift').length, 1);
});

for (const source of ['cc-human', 'cc-legacy', 'codex-new', 'codex-legacy'] as const) for (const ended of [false, true]) test(`评审返修2：${source} ${ended ? '会话已结束' : '本轮答完'}后追加纯注入，不重开完成状态`, () => {
  const tag = '<ide_opened_file>自动打开的构造文件</ide_opened_file>\n<environment_context>构造环境</environment_context>';
  const at = '2026-10-20T10:00:30.000Z';
  const legacy = source.endsWith('legacy');
  const isCC = source.startsWith('cc-');
  const user = (text: string, timestamp = start) => isCC
    ? { ...ccUser(text, timestamp), ...(legacy ? { origin: undefined } : {}) }
    : codexEvent(legacy ? { type: 'user_message', message: text } : { type: 'item_completed', item: { type: 'UserMessage', content: text } }, 'event_msg', timestamp);
  const rows = isCC ? [user('给商品列表加缓存'), ccAnswer(),
    ...(ended ? [{ type: 'session_end', timestamp: start }] : []), user(tag, at)]
    : [codexMeta(), user('给商品列表加缓存'), codexEvent({ type: 'task_complete', last_agent_message: '已完成缓存修改' }),
      ...(ended ? [codexEvent({ type: 'session_end' })] : []), user(tag, at)];
  const record = (isCC ? cc : codex).parse(rows.map(row => JSON.stringify(row)).join('\n'), { path: '/synthetic/injected.jsonl', fingerprint: 'synthetic' })!;
  assert.equal(record.intent.initial, '给商品列表加缓存'); assert.deepEqual(record.intent.additions, []);
  assert.equal(record.assistantFinished, true, '纯注入不能被当作新输入清掉答完事实');
  assert.equal(record.sessionEnded, ended, '纯注入不能清掉会话结束事实');
});

for (const kind of ['body', 'image', 'image-with-body'] as const) test(`评审返修2：标签后${kind}仍是真人新输入，不把去媒体的意图文本用于真人判空`, () => {
  const tag = '<environment_context>构造环境</environment_context>';
  const caption = kind === 'body' ? '给商品列表加缓存' : '[Image: source: /synthetic/screenshot.png]';
  const text = `${tag}\n${caption}${kind === 'image-with-body' ? '\n给商品列表加缓存' : ''}`;
  const content = kind === 'body' ? text : [{ type: 'image', source: { type: 'base64', data: 'SYNTHETIC_IMAGE' } }, { type: 'text', text }];
  const at = '2026-10-20T10:00:30.000Z';
  assert.equal(isHuman(text, { origin: { kind: 'human' } }), true);
  const ccRows = [ccUser('原任务'), ccAnswer(), { ...ccUser('', at), message: { role: 'user', content } }];
  const codexRows = [codexMeta(), codexEvent({ type: 'user_message', message: '旧格式重复副本' }), codexEvent({ type: 'task_complete' }),
    codexEvent({ type: 'item_completed', item: { type: 'UserMessage', content } }, 'event_msg', at)];
  for (const [component, rows] of [[cc, ccRows], [codex, codexRows]] as const) {
    const record = component.parse(rows.map(row => JSON.stringify(row)).join('\n'), { path: '/synthetic/genuine-input.jsonl', fingerprint: 'synthetic' })!;
    assert.equal(record.assistantFinished, false, '真正的文字/图片新输入仍重开本轮');
    assert.equal(record.sessionEnded, false);
    if (component.tool === 'codex') assert.deepEqual(record.intent, { initial: kind === 'image' ? null : '给商品列表加缓存', additions: [] }, '真实新版输入仍优先，不重复取旧副本');
    else assert.deepEqual(record.intent, { initial: '原任务', additions: kind === 'image' ? [] : ['给商品列表加缓存'] });
    assert.ok(!JSON.stringify(record.intent).includes('SYNTHETIC_IMAGE'));
  }
});

test('评审返修2：纯注入即使标为 human 也不是真人文字，媒体占位与元数据权限保持分开', () => {
  for (const text of ['<environment_context>环境</environment_context>', '<ide_selection>选择内容</ide_selection>', '<system-reminder>提醒</system-reminder>', '<environment_context>尚未闭合的环境']) {
    assert.equal(isHuman(text), false); assert.equal(isHuman(text, { origin: { kind: 'human' } }), false);
  }
  for (const text of ['[Image: source: /synthetic/image.png]', '[Attachment: /synthetic/file.pdf]']) {
    assert.equal(isHuman(text), true, '媒体输入能重开本轮，但占位不充当任务意图');
    assert.equal(intentText(text), '');
    assert.equal(isHuman(text, { origin: { kind: 'task-notification' } }), false);
  }
});

for (const origin of ['human', 'legacy'] as const) for (const withTag of [false, true]) test(`评审返修3：CC ${origin} 无文本占位图片${withTag ? '加纯IDE标签' : '单独输入'}重开本轮，无回复超过30分钟提醒停滞`, async t => {
  const f = await fixture(t); f.config.judge = null;
  const path = join(f.config.sources.cc!, 'image.jsonl');
  await put(path, [ccUser('给商品列表加缓存'), ccAnswer()]);
  assert.equal((await detect(f.config, now)).records[0]!.status, '已完成');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'SYNTHETIC_IMAGE_NO_PLACEHOLDER' } };
  const content = [image, ...(withTag ? [{ type: 'text', text: '<ide_opened_file>构造的编辑器自动内容</ide_opened_file>' }] : [])];
  assert.ok(!JSON.stringify(content).includes('[Image'), '回归样本不能给图片补文本占位');
  const user = { ...ccUser('', '2026-10-20T10:02:00Z'), ...(origin === 'legacy' ? { origin: undefined } : {}), message: { role: 'user', content } };
  await appendFile(path, JSON.stringify(user) + '\n');
  const active = await detect(f.config, '2026-10-20T10:03:00Z');
  assert.equal(active.records[0]!.status, '进行中', '真实图片不能因文字判空而留在已完成');
  assert.equal(active.records[0]!.assistantFinished, false);
  assert.deepEqual(active.records[0]!.intent, { initial: '给商品列表加缓存', additions: [] });
  const stalled = await detect(f.config, '2026-10-20T10:33:00Z');
  assert.equal(stalled.records[0]!.status, '停滞');
  const notices = await readOutbox(f.config.dataDir);
  assert.equal(notices.filter(notice => notice.kind === 'stalled').length, 1);
  assert.match(notices[0]!.content.situation!, /给商品列表加缓存/);
  assert.doesNotMatch(JSON.stringify([active.records, await readEvents(f.config.dataDir), notices]), /SYNTHETIC_IMAGE_NO_PLACEHOLDER|\[Image/);
});

for (const format of ['new', 'legacy'] as const) test(`评审返修3：Codex ${format} 无占位图片加纯环境标签仍是真输入，图片不进意图`, () => {
  const user = (content: unknown, at = start) => codexEvent(format === 'new' ? { type: 'item_completed', item: { type: 'UserMessage', content } } : { type: 'user_message', message: content }, 'event_msg', at);
  const content = [{ type: format === 'new' ? 'input_image' : 'image', image_url: 'SYNTHETIC_IMAGE_NO_PLACEHOLDER' },
    { type: 'text', text: '<environment_context>自动环境内容</environment_context>' }];
  const record = codex.parse([codexMeta(), user('原任务'), codexEvent({ type: 'task_complete', last_agent_message: '已完成' }),
    user(content, '2026-10-20T10:02:00Z')].map(row => JSON.stringify(row)).join('\n'), { path: '/synthetic/image-input.jsonl', fingerprint: 'synthetic' })!;
  assert.equal(record.assistantFinished, false);
  assert.equal(record.sessionEnded, false);
  assert.deepEqual(record.intent, { initial: '原任务', additions: [] });
  assert.doesNotMatch(JSON.stringify(record), /SYNTHETIC_IMAGE_NO_PLACEHOLDER/);
});

test('评审返修3：Codex 新版只有无占位图片时重开状态，但不遮蔽兼容旧格式的文字意图和跑偏检查', async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.codex = join(f.root, 'codex');
  await put(join(f.config.sources.codex, 'image.jsonl'), [codexMeta(), codexEvent({ type: 'user_message', message: '只改 A 文件' }),
    codexEvent({ type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'input_image', image_url: 'SYNTHETIC_IMAGE_NO_PLACEHOLDER' },
      { type: 'text', text: '<environment_context>构造环境</environment_context>' }] } }),
    codexEvent({ type: 'function_call', name: 'shell', call_id: 'b', arguments: JSON.stringify({ command: '修改 B 模块' }) }, 'response_item'),
  ]);
  const calls: JudgmentRequest[] = [];
  const view = await detect(f.config, now, { judge: { async judge(request) {
    calls.push(request); return { answer: '是', reason: '修改超出范围', intentQuote: '只改 A 文件', stepQuote: '修改 B 模块' };
  } } });
  assert.equal(view.records[0]!.intent.initial, '只改 A 文件', '媒体可重开状态，但没有可提取文字时不能让旧文字要求消失');
  assert.deepEqual(calls.map(request => request.task), ['drift']);
  assert.equal(view.records[0]!.status, '疑似跑偏');
});

test('评审返修3：真实图片不能绕过系统元数据拒绝；工具结果里的图片和未知块不冒充真人输入', () => {
  const tag = '<ide_selection>自动选择内容</ide_selection>';
  const image = { type: 'image', source: { type: 'base64', data: 'SYNTHETIC_IMAGE_NO_PLACEHOLDER' } };
  const message = { role: 'user', content: [image, { type: 'text', text: tag }] };
  for (const denied of [{ origin: { kind: 'task-notification' } }, { source: 'system' }, { source: 'extension' }, { source: 'loop' },
    { promptSource: 'system' }, { isSynthetic: true }, { is_meta: true }]) {
    assert.equal(isHuman(tag, { origin: { kind: 'human' } }, message, denied), false);
    const row = { ...ccUser('', '2026-10-20T10:02:00Z'), ...denied, message };
    const record = cc.parse([ccUser('原任务'), ccAnswer(), row].map(row => JSON.stringify(row)).join('\n'), { path: '/synthetic/system-image.jsonl', fingerprint: 'synthetic' })!;
    assert.equal(record.assistantFinished, true);
    assert.deepEqual(record.intent, { initial: '原任务', additions: [] });
  }
  for (const content of [[{ type: 'tool_result', content: [image] }], [{ type: 'future_noncore', content: [image] }]]) {
    assert.equal(isHuman('', { origin: { kind: 'human' } }, { content }), false, '只认用户顶层已知图片块，不递归扫描工具输出或未知块');
  }
  assert.equal(isHuman(tag, { origin: { kind: 'human' } }, { content: [{ type: 'text', text: tag }] }), false, '只有注入块仍不算真人输入');
});

test('A9：loop交代有项目/批次/结论、还欠3项，验收原文只在证据；长文溢出仍保留', async t => {
  const f = await fixture(t); f.config.judge = null; f.config.sources.cc = null; f.config.sources.loop = join(f.root, 'loop');
  const needs = Array.from({ length: 3 }, (_, i) => `- A${i + 1}. [人工] 操作：验收标准原文${i + 1}${'超长细节'.repeat(25)}`).join('\n');
  await put(join(f.config.sources.loop, 'shop/00000000-0000-4000-8000-000000000001.md'), loopSummary('完成', '/demo/shop', needs).replace('- 状态：', '- 批次：商品缓存第七批\n- 状态：'));
  await detect(f.config, now);
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'loop_completed')!;
  assert.match(notice.content.situation!, /shop.*商品缓存第七批.*完成/); assert.match(notice.content.action!, /还欠 3 项/);
  assert.doesNotMatch(front(noticeCard(notice)), /验收标准原文|超长细节|A1|A2|A3/);
  assert.match(JSON.stringify(noticeCard(notice)), /验收标准原文3/); assert.equal(notice.content.evidence.needs!.length, 3);
  const request: JudgmentRequest = { task: 'waiting', format: 'binary', context: { intentOriginal: '缓存任务', additionalRequirements: [], previousSummary: '', newSteps: [], assistantReply: '继续吗？' } };
  const result = validateJudgment({ answer: '是', reason: '构造', situation: '任务概述'.repeat(50), action: '需要动作'.repeat(50) }, request);
  const content = { ...notice.content, situation: result.situation!, action: result.action! };
  const card = noticeCard({ ...notice, content });
  for (const block of card.body.elements.slice(0, 2) as { content: string }[]) assert.ok([...block.content].length < 80);
  assert.match(judgmentPrompt(request), /situation.*action/);
});

test('误报晚于开轮时刻：模型等待中收到反馈，返回后同会话的新等待不投递、不必再等一轮', async t => {
  const f = await fixture(t), file = join(f.config.sources.cc!, 'sample.jsonl');
  const answer = ccAnswer(); answer.message.content[0]!.text = '缓存保留多久？'; await put(file, [ccUser('商品缓存'), answer]);
  await detect(f.config, now, { judge: { async judge(request) { return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造' }; } } });
  const old = (await readOutbox(f.config.dataDir))[0]!;
  const next = ccAnswer('2026-10-20T10:03:00Z'); next.message.content[0]!.text = '旧缓存现在删除吗？'; await appendFile(file, JSON.stringify(next) + '\n');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const pending = detect(f.config, '2026-10-20T10:04:00Z', { judge: { async judge(request) {
    if (request.task === 'waiting') { entered(); await gate; }
    return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造新等待' };
  } } });
  await started;
  try {
    await receiveFeedback(f.config.dataDir, 'local', { noticeId: old.id, content: '误报 不用再叫我', at: '2026-10-20T10:04:30Z' });
  } finally { release(); }
  const view = await pending;
  assert.equal(view.noticesAdded, 0); assert.equal(view.records[0]!.notice, '因你的误报没提醒');
  assert.equal((await readOutbox(f.config.dataDir)).length, 1);
});

test('升级兼容：旧版误收的正确问题/经验只留原日志，不再进入问题、复盘和导出；正确反馈不调用归因模型', async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.learning = true;
  const problem = { id: 'old-correct-problem', source: 'feedback:old', at: start, type: '正确:waiting', tool: 'cc', project: '/demo/shop',
    fact: '正确；整张旧卡片正文', locations: [], layer: '归因未定', reason: '旧记录', countermeasure: '', experienceId: 'old-correct-experience' };
  const experience = { id: problem.experienceId, type: problem.type, tool: 'cc', project: problem.project, layer: problem.layer, reason: '旧记录', countermeasure: '',
    status: '待确认', sources: [problem.source], createdAt: start, updatedAt: start, lastUsedAt: start, note: '' };
  const path = join(f.config.dataDir, 'learning.jsonl');
  await withStoreLock(f.config.dataDir, () => appendJsonl(path, [{ version: 1, at: start, kind: 'problem', problem }, { version: 1, at: start, kind: 'experience', experience }]));
  const before = await readFile(path, 'utf8'), notice = syntheticNotice('correct-card');
  await appendJsonl(join(f.config.dataDir, 'outbox.jsonl'), [notice]);
  await receiveFeedback(f.config.dataDir, 'local', { noticeId: notice.id, content: '正确', at: now });
  let calls = 0;
  await detect(f.config, '2026-10-20T10:02:00Z', { experienceModel: { async draft() { calls++; throw new Error('不该归因'); }, async same() { calls++; return false; } } });
  const state = await readLearning(f.config.dataDir); assert.equal(calls, 0); assert.equal(state.problems.length, 0); assert.equal(state.experiences.size, 0);
  assert.equal(state.events.length, 2); assert.equal(await readFile(path, 'utf8'), before);
  assert.ok(!(await readOutbox(f.config.dataDir)).some(n => n.kind === 'recurrence'));
});

test('收件与轮询短锁争用：capture有界等入站短锁，不立即失败，不等待检测锁', async t => {
  const f = await fixture(t); f.config.judge = null;
  f.config.feishu = { mode: 'fake', receiverId: 'ou_test', timeoutMs: 1000 };
  const channel = feishuChannel(f.config), release = await acquireLock(f.config.dataDir, '.feishu-inbound.lock');
  let finished = false;
  const saved = channel.capture({ id: 'contended-inbound', at: now, type: 'text', actor: 'ou_test', messageId: 'om_contended', chatType: 'p2p', text: '漏了 构造入站争用' })
    .then(value => { finished = true; return value; }, error => { finished = true; return { error }; });
  try { await delay(60); assert.equal(finished, false); }
  finally { await release(); }
  assert.deepEqual(await saved, {}); await channel.drain(now);
  assert.equal((await readFeedback(f.config.dataDir)).length, 1);
  assert.equal((await readFeedback(f.config.dataDir))[0]!.comment, '构造入站争用');
  await channel.stop();
});
