// D32：所有原件、模型、渠道和升级目录均为构造，不读真实个人工具目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { appendFile, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { event, project } from '../src/core/events.ts';
import { planNotices, judgeRecords } from '../src/core/judge.ts';
import { judgmentPrompt, piJudge, snapshotPrompt } from '../src/core/model.ts';
import { checkSnapshotModels } from '../src/core/snapshot-model.ts';
import { appendJsonl, readEvents, readOutbox, withModelLock, withStoreLock } from '../src/core/store.ts';
import { localNoticeText } from '../src/core/notice-text.ts';
import { noticeCard } from '../src/channels/feishu/card.ts';
import type { AgentEvent, Judge, JudgmentRequest, TaskSnapshotDraft } from '../src/core/types.ts';
import { cc } from '../src/sources/cc/index.ts';
import { codex } from '../src/sources/codex/index.ts';
import { pi } from '../src/sources/pi/index.ts';
import { loop } from '../src/sources/loop/index.ts';
import { modelSnapshot, noticeSnapshotKey, ruleSnapshot, snapshotInput, stepSnapshotInput } from '../src/core/task-snapshot.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, loopSummary, piHeader, piMessage, put, pushed, sandbox } from './fixtures.ts';

const at = (minute: number) => `2026-10-20T10:${String(minute).padStart(2, '0')}:00.000Z`;
const original = { path: '/synthetic/session.jsonl', fingerprint: 'synthetic' };
const goal = '任务甲：给商店做库存管理';
const current = '任务乙：先给商品列表加缓存';
const reply = '缓存保留五分钟还是十分钟？';
function transcript(tool: 'cc' | 'codex' | 'pi', extra = 0) {
  const users = ['[Image: /synthetic/image.png]', '<file name="/synthetic/injected.md">系统提供的编辑器内容，不是真人要求</file>', '继续', goal,
    ...Array.from({ length: extra }, () => '继续'), current, '继续'];
  if (tool === 'cc') {
    const answer = ccAnswer(at(5)); answer.message.content[0]!.text = reply;
    return [...users.map((text, n) => ccUser(text, at(n < 4 ? n : 4))), answer, ccUser('任务丙：明天再做报表', at(6))];
  }
  if (tool === 'codex') return [codexMeta(), ...users.map((message, n) => codexEvent({ type: 'user_message', message }, 'event_msg', at(n < 4 ? n : 4))),
    codexEvent({ type: 'task_complete', last_agent_message: reply }, 'event_msg', at(5)), codexEvent({ type: 'user_message', message: '任务丙：明天再做报表' }, 'event_msg', at(6))];
  return [piHeader(), ...users.map((text, n) => piMessage(`u${n}`, n ? `u${n - 1}` : null, 'user', text, at(n < 4 ? n : 4))),
    piMessage('a', `u${users.length - 1}`, 'assistant', reply, at(5)), piMessage('new', 'a', 'user', '任务丙：明天再做报表', at(6))];
}
for (const source of [cc, codex, pi]) test(`D32 输入索引：${source.tool} 跳过注入/占位/操作词，只加固定时间索引，取最后回复之前的要求`, () => {
  const parse = (extra = 0) => source.parse(transcript(source.tool as 'cc' | 'codex' | 'pi', extra).map(row => JSON.stringify(row)).join('\n'), original)!;
  const record = parse();
  assert.ok(record.requestRefs);
  const input = snapshotInput(record, reply, '在等你', at(5), 'reply');
  assert.deepEqual(input, { goal, currentTask: current, lastOutput: reply, factualStatus: '在等你' });
  const large = parse(3000);
  assert.ok(JSON.stringify(large.requestRefs).length < 400);
  assert.equal(JSON.stringify(large.requestRefs).includes('任务'), false, '索引不得复制全文');
  assert.ok(Object.keys(large.requestRefs!).length === 4);
  assert.deepEqual(snapshotInput(large, reply, '在等你', at(5), 'reply'), input);
});

const draft: TaskSnapshotDraft = { situation: '商店库存管理正在改进商品列表缓存；实现已完成，现在卡在缓存保留时长的选择。', action: '请选缓存保留五分钟还是十分钟', actionType: '做个决定' };
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.learning = false;
  f.config.judge = { executable: '/test-only/no-real-model', model: 'fake', timeoutMs: 1000, cycleTimeoutMs: 5000, dailyLimit: 100 };
  return f;
}
function front(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(front).join('\n');
  if (!value || typeof value !== 'object' || ('tag' in value && value.tag === 'collapsible_panel')) return '';
  return Object.entries(value).filter(([key]) => key !== 'value').map(([, child]) => front(child)).join('\n');
}
for (const tool of ['cc', 'codex', 'pi'] as const) test(`D32 A1/A2/A3/A7：${tool} 长会话四项起草、与判断合并调用，卡片和本机一致`, async t => {
  const f = await fixture(t);
  f.config.sources = { cc: null, codex: null, pi: null, loop: null }; f.config.sources[tool] = join(f.root, tool);
  const rows = transcript(tool, 300).slice(0, -1);
  await put(join(f.config.sources[tool]!, 'sample.jsonl'), rows);
  const requests: JudgmentRequest[] = [];
  const judge: Judge = { async judge(request) { requests.push(request); return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造分类', ...draft }; },
    async writeSnapshot() { assert.fail('等待卡片不得再调用独立起草'); } };
  const result = await detect(f.config, at(6), { judge, channels: [] });
  assert.equal(result.noticesAdded, 1);
  assert.equal(result.projection.modelCalls.get('2026-10-20'), 2);
  assert.deepEqual(requests.map(r => r.task), ['waiting', 'drift'], '旧版该样本就是一次等待判断和一次跑偏判断');
  const request = requests[0]!;
  assert.deepEqual(request.snapshotInput, { goal, currentTask: current, lastOutput: reply, factualStatus: '在等你' });
  assert.deepEqual(Object.keys(request.snapshotInput!).sort(), ['currentTask', 'factualStatus', 'goal', 'lastOutput']);
  assert.deepEqual(request.context.newSteps, []); assert.equal(request.context.previousSummary, '');
  const payload = JSON.parse(judgmentPrompt(request).split('材料：\n')[1]!);
  assert.deepEqual(payload.snapshotInput, request.snapshotInput); assert.deepEqual(payload.newSteps, []);
  const notice = (await readOutbox(f.config.dataDir))[0]!;
  assert.deepEqual(notice.snapshot, { ...request.snapshotInput, ...draft, source: '模型' });
  assert.equal(notice.content.situation, draft.situation); assert.equal(notice.content.action, draft.action);
  assert.match(front(noticeCard(notice)), /商店库存管理/);
  assert.ok(localNoticeText(notice).includes(notice.content.summary));
  await detect(f.config, at(7), { judge, channels: [] }); await overview(f.config); await rebuild(f.config);
  assert.equal(requests.length, 2); assert.equal((await readOutbox(f.config.dataDir)).length, 1);
});

test('D32 A4/A5：停滞单卡增加一次起草，之后同一事实不新增提醒和调用', async t => {
  const f = await fixture(t);
  await put(join(f.config.sources.cc!, 'sample.jsonl'), [ccUser(goal), ccUser(current, at(1)), ccCall(at(2), 'cache', '实现商品缓存')]);
  let judgments = 0, drafts = 0;
  const judge: Judge = { async judge() { judgments++; return { answer: '否', reason: '构造未偏离' }; }, async writeSnapshot(input) {
    drafts++; assert.equal(input.goal, goal); assert.equal(input.currentTask, current); assert.match(input.lastOutput, /实现商品缓存.*已 38 分钟没动静/);
    assert.equal(input.factualStatus, '停滞');
    // 替身在等待期间真正获取数据锁，证明起草调用不在数据锁内。
    await withStoreLock(f.config.dataDir, async () => { assert.ok((await readEvents(f.config.dataDir)).some(e => e.kind === 'scan_completed')); });
    return draft;
  } };
  const first = await detect(f.config, at(40), { judge, channels: [] });
  assert.equal(first.noticesAdded, 1); assert.equal(judgments, 1); assert.equal(drafts, 1);
  const notice = (await readOutbox(f.config.dataDir))[0]!;
  assert.equal(notice.kind, 'stalled'); assert.equal(notice.content.situation, draft.situation); assert.equal(notice.snapshot!.source, '模型');
  assert.equal(noticeSnapshotKey(notice), noticeSnapshotKey({ ...notice, dedupeKey: 'different-extraction-wording', content: { ...notice.content, title: '展示变化' } }));
  await detect(f.config, at(41), { judge, channels: [] });
  assert.equal(judgments, 1); assert.equal(drafts, 1); assert.equal((await readOutbox(f.config.dataDir)).length, 1);
});

for (const copy of ['model', 'rule'] as const) test(`返修1-1：同轮先发停滞再判跑偏（${copy}），不同类别不复用快照`, async t => {
  const f = await fixture(t);
  await put(join(f.config.sources.cc!, 'sample.jsonl'), [ccUser(goal), ccUser('只改 A 模块', at(1)), ccCall(at(2), 'b', '修改 B 模块')]);
  const stalledDraft: TaskSnapshotDraft = { situation: '库存管理任务已 38 分钟没有动静', action: '请有空查看是否卡住', actionType: '去看一眼' };
  const driftDraft: TaskSnapshotDraft = { situation: '库存管理要求只改 A 模块，实际却修改了 B 模块', action: '请决定是否撤销 B 模块修改', actionType: '做个决定' };
  const requests: JudgmentRequest[] = [];
  let writes = 0;
  const judge: Judge = { async judge(request) {
    requests.push(request);
    return { answer: '是', reason: 'B 超出 A 范围', intentQuote: '只改 A 模块', stepQuote: '修改 B 模块', ...(copy === 'model' ? driftDraft : {}) };
  }, async writeSnapshot() { writes++; return stalledDraft; } };
  await detect(f.config, at(40), { judge, channels: [] });
  const notices = await readOutbox(f.config.dataDir);
  assert.deepEqual(notices.map(n => n.kind), ['stalled', 'drift']);
  const stalled = notices[0]!, drift = notices[1]!;
  assert.equal(stalled.snapshot!.factualStatus, '停滞'); assert.equal(stalled.content.situation, stalledDraft.situation);
  assert.equal(drift.snapshot!.factualStatus, '跑偏');
  assert.equal(drift.snapshot!.source, copy === 'model' ? '模型' : '规则');
  assert.match(drift.content.situation!, /修改.*B 模块/); assert.doesNotMatch(drift.content.summary, /38 分钟|是否卡住/);
  if (copy === 'model') { assert.equal(drift.content.situation, driftDraft.situation); assert.equal(drift.content.action, driftDraft.action); }
  assert.equal(requests[0]!.draftSnapshot, true); assert.equal(writes, 1); assert.equal(requests.length, 1);
  const persisted = (await readEvents(f.config.dataDir)).find(e => e.kind === 'model_checked' && e.check.task === 'drift');
  assert.ok(persisted?.kind === 'model_checked'); assert.deepEqual(persisted.check.snapshot, drift.snapshot);
  await detect(f.config, at(41), { judge, channels: [] });
  assert.equal(writes, 1); assert.equal(requests.length, 1); assert.equal((await readOutbox(f.config.dataDir)).length, 2);
});

async function fiveKinds(t: TestContext) {
  const f = await fixture(t);
  const waiting = ccAnswer(at(39)); waiting.message.content[0]!.text = '<file name="/synthetic/a.md">注入内容</file>\n[Attachment: /synthetic/a.pdf]\n请确认 code/src/cache.ts:95 第 95 行的缓存保留多久？';
  const withId = (id: string, rows: ReturnType<typeof ccUser | typeof ccAnswer | typeof ccCall>[]) => rows.map(row => ({ ...row, sessionId: id }));
  await put(join(f.config.sources.cc!, 'waiting.jsonl'), withId('waiting', [ccUser('<file name="/synthetic/task.md">不是真人要求</file>\n[Image: /synthetic/a.png]'), ccUser(goal, at(1)), ccUser(current, at(2)), ccUser('继续', at(38)), waiting]));
  await put(join(f.config.sources.cc!, 'drift.jsonl'), withId('drift', [ccUser('只改 A 模块', at(38)), ccCall(at(39), 'b', '修改 B 模块')]));
  await put(join(f.config.sources.cc!, 'stalled.jsonl'), withId('stalled', [ccUser(goal), ccCall(at(1))]));
  f.config.sources.codex = join(f.root, 'missing-codex');
  f.config.sources.loop = join(f.root, 'loop');
  await put(join(f.config.sources.loop, 'shop/00000000-0000-4000-8000-000000000001.md'), loopSummary('完成', '/demo/shop', '- A1 验收标准原文第一项\n- A2 验收标准原文第二项\n- A3 验收标准原文第三项', at(39)).replace('- 状态：', '- 批次：库存管理缓存第八批\n- 状态：'));
  const judge: Judge = { async judge(request) {
    if (request.task === 'drift' && request.context.intentOriginal === '只改 A 模块') return { answer: '是', reason: '明确越界', intentQuote: '只改 A 模块', stepQuote: '修改 B 模块' };
    throw new Error('构造模型不可用');
  }, async writeSnapshot() { throw new Error('构造起草不可用'); } };
  await detect(f.config, at(40), { judge, channels: [] });
  return { ...f, judge };
}
test('D32 A6/A7/A8：五类卡片失败仍发、八项快照完整、注入/占位/路径行号不进第一屏', async t => {
  const f = await fiveKinds(t), notices = await readOutbox(f.config.dataDir);
  assert.deepEqual(notices.map(n => n.kind).sort(), ['blind', 'drift', 'loop_completed', 'stalled', 'waiting']);
  for (const notice of notices) {
    assert.ok(notice.content.situation); assert.ok(notice.content.action);
    assert.deepEqual(Object.keys(notice.snapshot!).sort(), ['action', 'actionType', 'currentTask', 'factualStatus', 'goal', 'lastOutput', 'situation', 'source']);
    assert.equal(notice.snapshot!.source, '规则');
    assert.doesNotMatch(notice.content.summary, /<file|<ide|\[Image|\[Attachment|\/synthetic|code\/src|cache\.ts|第\s*\d+\s*行|:95\b/);
    assert.ok(localNoticeText(notice).includes(notice.content.summary));
  }
  const loopNotice = notices.find(n => n.kind === 'loop_completed')!;
  assert.match(loopNotice.content.situation!, /shop.*库存管理缓存第八批.*完成/);
  assert.match(loopNotice.content.action!, /还欠 3 项/);
  assert.doesNotMatch(front(noticeCard(loopNotice)), /验收标准原文|A1|A2|A3/);
  assert.match(JSON.stringify(noticeCard(loopNotice)), /验收标准原文第三项/);
});

test('D32 A9：构造旧目录缺新字段、已有五类卡片和失败判断；升级只追加，不补发/重调', async t => {
  const f = await fiveKinds(t);
  const events = (await readEvents(f.config.dataDir)).filter(e => e.kind !== 'notice_snapshot_written').map(e => {
    if (e.kind === 'session_observed') { delete e.record.requestRefs; if (e.record.loop) delete e.record.loop.summary; }
    if (e.kind === 'notice_planned') delete e.notice.snapshot;
    if (e.kind === 'model_checked') { delete e.check.snapshot; delete e.check.snapshotVersion; }
    return e;
  });
  const outbox = (await readOutbox(f.config.dataDir)).map(n => { delete n.snapshot; return n; });
  await put(join(f.config.dataDir, 'events.jsonl'), events); await put(join(f.config.dataDir, 'outbox.jsonl'), outbox);
  const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  const beforeOutbox = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8');
  const judge: Judge = { async judge() { assert.fail('已发事实不得因升级重调判断'); }, async writeSnapshot() { assert.fail('已发事实不得因升级补写快照'); } };
  const result = await detect(f.config, at(41), { judge, channels: [] });
  assert.equal(result.noticesAdded, 0);
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(before));
  assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), beforeOutbox);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'model_call_started').length, events.filter(e => e.kind === 'model_call_started').length);
});

for (const mode of ['missing-field', 'timeout', 'daily-limit'] as const) test(`D32 规则兜底并记住同一事实：${mode}`, async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.loop = join(f.root, 'loop');
  if (mode === 'timeout') { f.config.judge!.timeoutMs = 15; f.config.judge!.cycleTimeoutMs = 5000; }
  if (mode === 'daily-limit') f.config.judge!.dailyLimit = 0;
  await put(join(f.config.sources.loop, 'shop/00000000-0000-4000-8000-000000000001.md'), loopSummary('暂停，待决定下一步', '/demo/shop', '- [人工] 体验卡片', at(5)).replace('- 状态：', '- 批次：缓存改进\n- 状态：'));
  let calls = 0;
  const judge: Judge = { async judge() { assert.fail('loop 不做额外状态判断'); }, async writeSnapshot() {
    calls++; return mode === 'timeout' ? new Promise(() => {}) : { situation: '缺少动作字段' } as TaskSnapshotDraft;
  } };
  await detect(f.config, at(6), { judge, channels: [] });
  const notice = (await readOutbox(f.config.dataDir))[0]!;
  assert.equal(notice.snapshot!.source, '规则'); assert.equal(notice.kind, 'loop_paused');
  await detect(f.config, at(7), { judge, channels: [] });
  assert.equal(calls, mode === 'daily-limit' ? 0 : 1); assert.equal((await readOutbox(f.config.dataDir)).length, 1);
});

test('D32 跑偏起草与判定分开材料、仍核对原句，不拿模型重判事实状态', async t => {
  const f = await fixture(t);
  await put(join(f.config.sources.cc!, 'sample.jsonl'), [ccUser(goal), ccUser('只改 A 模块', at(1)), ccCall(at(2), 'b', '修改 B 模块')]);
  const view = await detect(f.config, at(3), { channels: [], judge: { async judge(request) {
    assert.equal(request.task, 'drift'); assert.match(request.context.newSteps[0]!.text, /B 模块/);
    assert.deepEqual(request.snapshotInputsByStep?.[0], { goal, currentTask: '只改 A 模块', lastOutput: 'Bash：修改 B 模块', factualStatus: '跑偏' });
    assert.equal(request.snapshotInput, undefined);
    return { answer: '是', reason: 'B 不在 A 的范围内', intentQuote: '只改 A 模块', stepQuote: '修改 B 模块', ...draft };
  }, async writeSnapshot() { assert.fail('跑偏不得单独再起草'); } } });
  assert.equal(view.records[0]!.status, '疑似跑偏');
  const notice = (await readOutbox(f.config.dataDir))[0]!;
  assert.equal(notice.snapshot!.factualStatus, '跑偏'); assert.equal(notice.snapshot!.source, '模型');
});

for (const tail of ['tool-result', 'normal-step'] as const) for (const copy of ['model', 'rule'] as const)
  test(`返修1-2：越界后还有${tail}，${copy}快照绑定已核验步骤及当时要求，仍只调用一次`, async t => {
    const f = await fixture(t);
    const requirement = '只改 A 模块', nextRequirement = '接下来只读检查 A 模块测试报告';
    const toolResult = { ...ccUser('', at(4)), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '构造结果' }] } };
    await put(join(f.config.sources.cc!, 'sample.jsonl'), [ccUser(goal), ccUser(requirement, at(1)), ccCall(at(2), 'b', '修改 B 模块'),
      ccUser(nextRequirement, at(3)), tail === 'tool-result' ? toolResult : ccCall(at(4), 'normal', '检查 A 模块测试报告')]);
    const requests: JudgmentRequest[] = [];
    let writes = 0;
    const judge: Judge = { async judge(request) {
      requests.push(request);
      const index = request.context.newSteps.findIndex(step => step.text.includes('修改 B 模块'));
      const input = request.snapshotInputsByStep?.[index] ?? request.snapshotInput!;
      return { answer: '是', reason: 'B 越过 A 范围', intentQuote: requirement, stepQuote: '修改 B 模块', ...(copy === 'model' ? {
        situation: `${input.currentTask}：实际在做「${input.lastOutput}」，疑似越界`, action: '请决定是否撤销 B 模块修改', actionType: '做个决定' as const,
      } : {}) };
    }, async writeSnapshot() { writes++; return draft; } };
    const result = await detect(f.config, at(5), { judge, channels: [] });
    const notice = (await readOutbox(f.config.dataDir))[0]!;
    assert.equal(notice.kind, 'drift');
    assert.deepEqual({ goal: notice.snapshot!.goal, currentTask: notice.snapshot!.currentTask, lastOutput: notice.snapshot!.lastOutput, factualStatus: notice.snapshot!.factualStatus },
      { goal, currentTask: requirement, lastOutput: 'Bash：修改 B 模块', factualStatus: '跑偏' });
    assert.equal(notice.snapshot!.source, copy === 'model' ? '模型' : '规则');
    assert.match(notice.content.situation!, /修改.*B 模块/); assert.doesNotMatch(notice.content.summary, /工具结果已返回|检查 A 模块测试报告/);
    const request = requests[0]!, index = request.context.newSteps.findIndex(step => step.text.includes('修改 B 模块'));
    assert.equal(request.context.newSteps.at(-1)!.text, tail === 'tool-result' ? '工具结果已返回' : 'Bash：检查 A 模块测试报告');
    const input = request.snapshotInputsByStep![index]!;
    assert.equal(input.currentTask, requirement); assert.equal(input.lastOutput, 'Bash：修改 B 模块');
    assert.deepEqual(Object.keys(input).sort(), ['currentTask', 'factualStatus', 'goal', 'lastOutput']);
    const material = JSON.parse(judgmentPrompt(request).split('材料：\n')[1]!);
    assert.deepEqual(material.snapshotInputsByStep[index], input);
    assert.equal(material.snapshotInput, undefined, '跑偏起草不再提供容易误用的末步默认材料');
    const persisted = (await readEvents(f.config.dataDir)).find(e => e.kind === 'model_checked' && e.check.task === 'drift');
    assert.ok(persisted?.kind === 'model_checked'); assert.deepEqual(persisted.check.snapshot, notice.snapshot);
    assert.equal(result.projection.modelCalls.get('2026-10-20'), 1); assert.equal(writes, 0); assert.equal(requests.length, 1);
    await detect(f.config, at(6), { judge, channels: [] });
    assert.equal(requests.length, 1); assert.equal((await readOutbox(f.config.dataDir)).length, 1);
  });

for (const source of [cc, codex, pi]) test(`返修1-2：${source.tool} 检测时记住越界步骤对应的真人要求，不倒用后来的要求`, () => {
  const requirement = '只改 A 模块', nextRequirement = '接下来只读检查 A 模块测试报告';
  const rows = source.tool === 'cc' ? [ccUser(goal), ccUser(requirement, at(1)), ccCall(at(2), 'b', '修改 B 模块'), ccUser(nextRequirement, at(3)), ccCall(at(4), 'normal', '检查 A 模块测试报告')]
    : source.tool === 'codex' ? [codexMeta(), codexEvent({ type: 'user_message', message: goal }), codexEvent({ type: 'user_message', message: requirement }, 'event_msg', at(1)),
      codexEvent({ type: 'function_call', name: 'shell', call_id: 'b', arguments: JSON.stringify({ command: '修改 B 模块' }) }, 'response_item', at(2)),
      codexEvent({ type: 'user_message', message: nextRequirement }, 'event_msg', at(3)),
      codexEvent({ type: 'function_call', name: 'shell', call_id: 'normal', arguments: JSON.stringify({ command: '检查 A 模块测试报告' }) }, 'response_item', at(4))]
      : [piHeader(), piMessage('goal', null, 'user', goal), piMessage('u', 'goal', 'user', requirement, at(1)),
        piMessage('b', 'u', 'assistant', [{ type: 'toolCall', id: 'b', name: 'bash', arguments: { command: '修改 B 模块' } }], at(2)),
        piMessage('later', 'b', 'user', nextRequirement, at(3)),
        piMessage('normal', 'later', 'assistant', [{ type: 'toolCall', id: 'normal', name: 'bash', arguments: { command: '检查 A 模块测试报告' } }], at(4))];
  const record = source.parse(rows.map(row => JSON.stringify(row)).join('\n'), original)!;
  const step = record.recentSteps.find(s => s.text.includes('修改 B 模块'))!;
  assert.deepEqual(step.requestRef, { index: 1, at: at(1), sessionId: record.sessionId });
  assert.equal(record.requestRefs!.latest!.at, at(3));
  assert.deepEqual(stepSnapshotInput(record, step), { goal, currentTask: requirement, lastOutput: step.text, factualStatus: '跑偏' });
});

test('返修1-2：步骤要求索引仅随最近8步保留，不复制要求正文', () => {
  const rows = [ccUser(goal), ...Array.from({ length: 1000 }, (_, i) => [ccUser(`构造要求${i}`, at(1)), ccCall(at(2), `tool-${i}`, `构造步骤${i}`)]).flat()];
  const record = cc.parse(rows.map(row => JSON.stringify(row)).join('\n'), original)!;
  assert.equal(record.recentSteps.length, 8);
  const refs = record.recentSteps.map(step => step.requestRef);
  assert.ok(JSON.stringify(refs).length < 1000); assert.doesNotMatch(JSON.stringify(refs), /构造要求|构造步骤/);
  assert.ok(refs.every(ref => ref && Object.keys(ref).length === 3));
});

test('返修1-2：旧判断尚未发卡且缺快照时，规则展示也按引文步骤取材料，不重新调用', async t => {
  const f = await fixture(t);
  const rows = [ccUser(goal), ccUser('只改 A 模块', at(1)), ccCall(at(2), 'b', '修改 B 模块'), ccUser('接下来只读检查 A 模块测试报告', at(3)), ccCall(at(4), 'normal', '检查 A 模块测试报告')];
  const path = join(f.config.sources.cc!, 'sample.jsonl'); await put(path, rows);
  const record = cc.parse(rows.map(row => JSON.stringify(row)).join('\n'), { path, fingerprint: 'synthetic' })!;
  await withStoreLock(f.config.dataDir, () => appendJsonl(join(f.config.dataDir, 'events.jsonl'), [
    event({ kind: 'session_observed', record }, at(5)), event({ kind: 'scan_completed' }, at(5)),
    event({ kind: 'model_checked', check: { key: `drift:${record.key}`, recordKey: record.key, sessionId: record.sessionId, task: 'drift', at: at(5), evidenceAt: record.lastActivityAt,
      fingerprint: 'synthetic-old', stepIds: [], summary: '', result: { answer: '是', reason: '旧版核验出越界', intentQuote: '只改 A 模块', stepQuote: '修改 B 模块' } } }, at(5)),
  ]));
  let calls = 0;
  const result = await detect(f.config, at(6), { channels: [], judge: { async judge() { calls++; return { answer: '否', reason: '不应重调' }; } } });
  assert.equal(result.noticesAdded, 1); assert.equal(calls, 0);
  const snapshot = (await readOutbox(f.config.dataDir))[0]!.snapshot!;
  assert.equal(snapshot.currentTask, '只改 A 模块'); assert.equal(snapshot.lastOutput, 'Bash：修改 B 模块'); assert.equal(snapshot.source, '规则');
});

test('D32 卡片起草真实子进程边界只用替身，输入只有四项、固定无工具参数', async t => {
  const f = await fixture(t), executable = join(f.root, 'fake-pi'), capture = join(f.root, 'captured.json');
  await writeFile(executable, `#!${process.execPath}\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),input}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(${JSON.stringify(draft)})}]}}));});\n`);
  await chmod(executable, 0o700); f.config.judge!.executable = executable; f.config.judge!.timeoutMs = 5000;
  const input = { goal, currentTask: current, lastOutput: reply, factualStatus: '停滞' as const };
  assert.deepEqual(await piJudge(f.config.judge!).writeSnapshot!(input), draft);
  const captured = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(JSON.parse(captured.input.split('卡片材料：\n')[1]), input);
  for (const flag of ['--no-tools', '--no-session', '--no-extensions', '--no-context-files', '--offline']) assert.ok(captured.args.includes(flag));
  assert.equal(snapshotPrompt(input), captured.input.trimEnd());
});

test('D32 独立起草共享每日原子额度：其他消费者并发预留后不超额，未调用的卡片仍规则发出', async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.loop = join(f.root, 'loop'); f.config.judge!.dailyLimit = 2;
  for (const n of [1, 2, 3]) await put(join(f.config.sources.loop, `shop/00000000-0000-4000-8000-00000000000${n}.md`),
    loopSummary('完成', '/demo/shop', '- 待体验', at(5)).replace('loop-demo', `loop-${n}`));
  let calls = 0;
  const judge: Judge = { async judge() { assert.fail('loop 不重判'); }, async writeSnapshot() {
    calls++;
    await withStoreLock(f.config.dataDir, () => appendJsonl(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'model_call_started', task: 'attribution', key: 'synthetic-concurrent-consumer' }, at(6))]));
    return draft;
  } };
  const result = await detect(f.config, at(6), { judge, channels: [] });
  assert.equal(calls, 1); assert.equal(result.projection.modelCalls.get('2026-10-20'), 2);
  const notices = await readOutbox(f.config.dataDir);
  assert.equal(notices.length, 3); assert.equal(notices.filter(n => n.snapshot!.source === '模型').length, 1);
  await detect(f.config, at(7), { judge, channels: [] }); assert.equal(calls, 1);
});

test('D32 独立起草共享单轮总时限：忽略取消的替身也有界结束，其余卡片兜底不丢', async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.loop = join(f.root, 'loop');
  f.config.judge!.cycleTimeoutMs = 1000; f.config.judge!.timeoutMs = 30000;
  for (const n of [1, 2]) await put(join(f.config.sources.loop, `shop/00000000-0000-4000-8000-00000000000${n}.md`),
    loopSummary('完成', '/demo/shop', '- 待体验', at(5)).replace('loop-demo', `loop-${n}`));
  let calls = 0, aborted = 0;
  const judge: Judge = { async judge() { assert.fail('loop 不重判'); }, writeSnapshot(_input, options) {
    calls++; options!.signal!.addEventListener('abort', () => { aborted++; }); return new Promise(() => {});
  } };
  const began = performance.now();
  const result = await detect(f.config, at(6), { judge, channels: [] });
  assert.ok(performance.now() - began < 5000); assert.equal(result.noticesAdded, 2); assert.equal(calls, 1); assert.equal(aborted, 1);
  assert.ok((await readOutbox(f.config.dataDir)).every(n => n.snapshot!.source === '规则'));
  await detect(f.config, at(7), { judge, channels: [] }); assert.equal(calls, 1);
});

test('D32 起草后、发卡前中断：追加记录可恢复，下一轮复用输入和文案不重调', async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.loop = join(f.root, 'loop');
  const path = join(f.config.sources.loop, 'shop/00000000-0000-4000-8000-000000000001.md');
  const summary = loopSummary('完成', '/demo/shop', '- 待体验', at(5)); await put(path, summary);
  const record = loop.parse(summary, { path, fingerprint: 'synthetic' })!;
  const events: AgentEvent[] = [event({ kind: 'session_observed', record }, at(6)), event({ kind: 'scan_completed' }, at(6))];
  await withStoreLock(f.config.dataDir, () => appendJsonl(join(f.config.dataDir, 'events.jsonl'), events));
  const projection = project(events), planned = planNotices(judgeRecords(projection, at(6)), projection, f.config, at(6));
  let calls = 0;
  const judge: Judge = { async judge() { assert.fail('loop 不重判'); }, async writeSnapshot() { calls++; return draft; } };
  await withModelLock(f.config.dataDir, () => checkSnapshotModels(planned, projection, f.config, at(6), async payload => {
    await withStoreLock(f.config.dataDir, () => appendJsonl(join(f.config.dataDir, 'events.jsonl'), [event(payload, at(6))])); return true;
  }, judge, Date.now() + 5000));
  assert.equal((await readOutbox(f.config.dataDir)).length, 0); assert.equal(calls, 1);
  const result = await detect(f.config, at(7), { judge, channels: [] });
  assert.equal(result.noticesAdded, 1); assert.equal(calls, 1);
  assert.equal((await readOutbox(f.config.dataDir))[0]!.snapshot!.situation, draft.situation);
});

test('D32 起草等待中有新事实：另一轮仍能感知，迟到文案不覆盖新状态；新证据不用旧缓存', async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.loop = join(f.root, 'loop');
  const path = join(f.config.sources.loop, 'shop/00000000-0000-4000-8000-000000000001.md');
  await put(path, loopSummary('完成', '/demo/shop', '- 待体验', at(5)));
  let entered!: () => void, release!: (value: TaskSnapshotDraft) => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), answer = new Promise<TaskSnapshotDraft>(resolve => { release = resolve; });
  let calls = 0;
  const judge: Judge = { async judge() { assert.fail('loop 不重判'); }, async writeSnapshot() { calls++; entered(); return answer; } };
  const running = detect(f.config, at(6), { judge, channels: [] });
  await started;
  try {
    await put(path, loopSummary('进行中', '/demo/shop', '- 待体验', at(7)));
    const newer = await detect(f.config, at(8), { judge, channels: [] });
    assert.equal(newer.records[0]!.status, '进行中'); assert.equal(calls, 1);
  } finally { release(draft); }
  const result = await running;
  assert.equal(result.at, at(8)); assert.equal(result.records[0]!.status, '进行中'); assert.equal((await readOutbox(f.config.dataDir)).length, 0);
  await put(path, loopSummary('完成', '/demo/shop', '- 待体验', at(9)));
  await detect(f.config, at(10), { judge: { ...judge, async writeSnapshot() { calls++; return { ...draft, situation: '这是新证据写的快照' }; } }, channels: [] });
  assert.equal(calls, 2); assert.equal((await readOutbox(f.config.dataDir))[0]!.snapshot!.situation, '这是新证据写的快照');
});

test('D32 模型坏文案整份兜底；模型/规则均滤file注入、路径行号和占位，事情最多两句约100字', () => {
  const input = { goal: '<file name="/synthetic/a.md">注入内容</file>\n[Image: /synthetic/a.png]\n商店库存管理。', currentTask: '先改商品缓存。',
    lastOutput: '请确认 code/src/cache.ts:95 第 95 行的缓存保留多久？', factualStatus: '在等你' as const };
  const stalled = ruleSnapshot({ ...input, lastOutput: `最后在做 ${'很长的构造步骤'.repeat(100)}；已 38 分钟没动静`, factualStatus: '停滞' }, '/demo/shop', at(6));
  assert.match(stalled.situation, /已 38 分钟没动静$/);
  for (const value of [{ ...draft, actionType: undefined }, { ...draft, action: undefined }, { ...draft, situation: '[Image: /synthetic/a.png]' }]) assert.equal(modelSnapshot(input, value, '/demo/shop', at(6)), null);
  for (const snapshot of [ruleSnapshot(input, '/demo/shop', at(6)), modelSnapshot(input, { ...draft,
    situation: '<file name="/synthetic/a.md">注入</file>\n[Image: /synthetic/a.png]\n库存缓存完成。现在等确认。第三句话不得出现。', action: input.lastOutput }, '/demo/shop', at(6))!]) {
    assert.doesNotMatch(snapshot.situation + snapshot.action, /<file|注入|\[Image|\/synthetic|code\/|cache\.ts|第\s*95\s*行|第三句话/);
    assert.ok([...snapshot.situation].length <= 101); assert.ok(snapshot.situation.split(/[。！？!?]/).filter(Boolean).length <= 2);
    assert.match(snapshot.action, /缓存保留多久/);
  }
});

test('D32 读取故障快照保留最后可见的总目标/当前这件/输出与原因，不把历史事实当正常状态', async t => {
  const f = await fixture(t); f.config.sources.codex = join(f.root, 'codex');
  const path = join(f.config.sources.cc!, 'known.jsonl');
  const answer = ccAnswer(at(5)); answer.message.content[0]!.text = reply;
  await put(path, [ccUser(goal), ccUser(current, at(4)), answer]);
  await put(join(f.config.sources.codex, 'other.jsonl'), [codexMeta(), codexEvent({ type: 'user_message', message: '构造另一工具任务' }, 'event_msg', at(5))]);
  const inputs: unknown[] = [];
  const judge: Judge = { async judge() { return { answer: '否', reason: '构造否' }; }, async writeSnapshot(input) { inputs.push(input); return draft; } };
  await detect(f.config, at(6), { judge, channels: [] });
  await appendFile(path, 'BROKEN_SYNTHETIC_ROW\n');
  const result = await detect(f.config, at(7), { judge, channels: [] });
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'blind')!;
  assert.ok(notice); assert.equal(notice.snapshot!.goal, goal); assert.equal(notice.snapshot!.currentTask, current);
  assert.match(notice.snapshot!.lastOutput, /缓存保留五分钟还是十分钟/); assert.match(notice.snapshot!.lastOutput, /无法解析/);
  assert.equal(inputs.length, 1); assert.equal(result.records.some(r => r.tool === 'cc' && r.status !== '看不见了'), false);
  assert.equal(result.records.find(r => r.tool === 'codex')!.status, '进行中');
});

test('D32 保留原判断失败的状态重试，但已发规则卡片不再起草或改文案', async t => {
  const f = await fixture(t), answer = ccAnswer(at(5)); answer.message.content[0]!.text = reply;
  await put(join(f.config.sources.cc!, 'sample.jsonl'), [ccUser(goal), answer]);
  let waitingCalls = 0;
  const judge: Judge = { async judge(request) {
    if (request.task !== 'waiting') return { answer: '否', reason: '构造未偏离' };
    if (++waitingCalls === 1) throw new Error('构造状态判断失败');
    assert.equal(request.draftSnapshot, false); assert.doesNotMatch(judgmentPrompt(request), /写卡片只读四项/);
    return { answer: '是', reason: '状态重试成功', ...draft };
  } };
  await detect(f.config, at(6), { judge, channels: [] });
  const before = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8');
  await detect(f.config, at(7), { judge, channels: [] }); await detect(f.config, at(8), { judge, channels: [] });
  assert.equal(waitingCalls, 2); assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), before);
  assert.equal((await readOutbox(f.config.dataDir))[0]!.snapshot!.source, '规则');
});
