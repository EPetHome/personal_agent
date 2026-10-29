// 本批只使用构造会话/在跑登记、飞书替身与临时 CC 可执行程序。绝不调用真实 claude。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { feishuChannel, normalizeIncoming } from '../src/channels/feishu/index.ts';
import type { SentMessage } from '../src/channels/feishu/index.ts';
import { noticeCard } from '../src/channels/feishu/card.ts';
import { realTransport } from '../src/channels/feishu/transport.ts';
import type { FeishuTransport } from '../src/channels/feishu/transport.ts';
import type { RelayView } from '../src/core/relay.ts';
import { validateConfig } from '../src/core/config.ts';
import { detect } from '../src/core/agent.ts';
import { readFeedback } from '../src/core/feedback.ts';
import { assertRelayIdle, readRelayTranscript } from '../src/core/cc-relay.ts';
import { acquireLock } from '../src/core/locks.ts';
import { isInternalSession } from '../src/core/sessions.ts';
import { appendOutbox, readJsonl } from '../src/core/store.ts';
import { hash } from '../src/core/utils.ts';
import type { Notice, TaskActionItem } from '../src/core/types.ts';
import { sandbox, put } from './fixtures.ts';

const advice = ' 是，按第二个方案继续。 \n保留这一行。';
const reply = '替身的 AI 原话：\n  不改写 **标记** <tag>\n末尾空格  ';
function values(value: any): { text: string; value: Record<string, string> }[] {
  if (!value || typeof value !== 'object') return [];
  const current = value.tag === 'button' && value.value ? [{ text: value.text.content, value: value.value }] : [];
  return [...current, ...Object.values(value).flatMap(values)];
}
// 依据官方 JSON 2.0 普通文本规范，而不是把 div 误判为 1.0 专属：
// https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/plain-text
// 这是本项目所用层级/文本/输入的离线契约，不冒充完整飞书服务端 Schema 或真机验证。
function assertCardV2(card: unknown): Record<string, unknown>[] {
  function object(value: unknown): Record<string, unknown> {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), '卡片节点必须是对象');
    return value as Record<string, unknown>;
  }
  function list(value: unknown): unknown[] { assert.ok(Array.isArray(value), '组件集合必须是数组'); return value; }
  function text(value: unknown): void {
    const node = object(value);
    assert.equal(node.tag, 'plain_text', '字面文本不能进入 Markdown 解释器');
    assert.equal(typeof node.content, 'string');
  }
  const root = object(card), nodes: Record<string, unknown>[] = [];
  assert.equal(root.schema, '2.0');
  assert.equal('elements' in root || 'i18n_elements' in root, false, '2.0 正文必须放在 body.elements');
  if (root.config) assert.equal(object(root.config).update_multi, true);
  if (root.header) text(object(root.header).title);
  function visit(value: unknown, parent: string): void {
    const node = object(value); nodes.push(node);
    switch (node.tag) {
      case 'div':
        text(node.text);
        assert.equal('fields' in node || 'extra' in node, false, '不接受 1.0 内容模块的 fields/extra');
        assert.equal('lines' in object(node.text), false, '不能按行数悄悄截掉转达原文');
        break;
      case 'markdown': assert.equal(typeof node.content, 'string'); break;
      case 'column_set': for (const column of list(node.columns)) visit(column, 'column_set'); break;
      case 'column':
        assert.equal(parent, 'column_set');
        for (const element of list(node.elements)) visit(element, 'column');
        break;
      case 'collapsible_panel':
        text(object(node.header).title);
        for (const element of list(node.elements)) visit(element, 'collapsible_panel');
        break;
      case 'form':
        assert.equal(typeof node.name, 'string');
        for (const element of list(node.elements)) visit(element, 'form');
        break;
      case 'input':
        assert.equal(parent, 'form'); assert.equal(typeof node.name, 'string');
        assert.equal(node.input_type, 'multiline_text'); assert.equal(node.max_length, 4000);
        text(node.placeholder); assert.equal('default_value' in node, false, '手动输入不能预填建议');
        break;
      case 'button': text(node.text); break;
      default: assert.fail(`本项目不支持的 2.0 正文组件：${String(node.tag)}`);
    }
  }
  for (const element of list(object(root.body).elements)) visit(element, 'body');
  return nodes;
}
function literalTexts(card: unknown): string[] {
  return assertCardV2(card).filter(node => node.tag === 'div').map(node => (node.text as { content: string }).content);
}
async function fixture(t: TestContext, options: { finished?: boolean; items?: TaskActionItem[]; enabled?: boolean; transport?: FeishuTransport } = {}) {
  const f = await sandbox();
  // 证据仍遵循 TMPDIR；业务 cwd 不能位于流水线内部目录，否则会被正常过滤。
  // loop 把 TMPDIR 放在 .pi-autoreview 下时，仅空的构造项目另建在系统临时目录。
  const projectTemp = tmpdir().split('/').includes('.pi-autoreview') ? '/tmp' : tmpdir();
  const cwd = await mkdtemp(join(projectTemp, 'personal-agent-relay-project with spaces-'));
  const registry = join(f.root, 'running'), transcript = join(f.config.sources.cc!, 'session.jsonl');
  const log = join(f.root, 'cc-calls.jsonl'), control = join(f.root, 'control.json'), executable = join(f.root, 'cc-stub');
  await mkdir(registry); await mkdir(f.config.dataDir);
  const sessionId = randomUUID(), now = Date.now();
  function turn(text: string, finished = true) {
    const common = { sessionId, cwd, timestamp: new Date(now - 12 * 60000).toISOString() };
    return [
      { ...common, uuid: randomUUID(), type: 'user', message: { role: 'user', content: text } },
      { ...common, uuid: randomUUID(), type: 'assistant', message: { role: 'assistant', stop_reason: finished ? 'end_turn' : 'tool_use',
        content: finished ? [{ type: 'text', text: '使用第二种方案吗？建议：是' }] : [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'synthetic' } }] } },
      ...(finished ? [{ ...common, uuid: randomUUID(), type: 'system', subtype: 'stop_hook_summary' }] : []),
    ];
  }
  await put(transcript, turn('只用构造数据', options.finished ?? true));
  const registration = join(registry, `${process.pid}.json`);
  await put(registration, JSON.stringify({ pid: process.pid, sessionId, status: 'idle', cwd, agent: 'claude-vscode' }));
  await put(control, JSON.stringify({ reply }));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const text = fs.readFileSync(0, 'utf8');
const control = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
const common = { sessionId: ${JSON.stringify(sessionId)}, cwd: process.cwd(), timestamp: new Date().toISOString() };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ text, args: process.argv.slice(2), cwd: process.cwd(), hasFeishuSecret: !!process.env.FEISHU_APP_SECRET }) + '\\n');
async function main() {
  if (control.waitFor) while (!fs.existsSync(control.waitFor)) await new Promise(r => setTimeout(r, 20));
  if (control.exit) process.exit(control.exit);
  const rows = [
    { ...common, uuid: require('node:crypto').randomUUID(), type: 'user', message: { role: 'user', content: text } },
    { ...common, uuid: require('node:crypto').randomUUID(), type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: control.reply }] } },
    { ...common, uuid: require('node:crypto').randomUUID(), type: 'system', subtype: 'stop_hook_summary' }
  ];
  fs.appendFileSync(${JSON.stringify(transcript)}, rows.map(row => JSON.stringify(row) + '\\n').join(''));
  console.log(JSON.stringify({ type: 'result', session_id: control.wrongSession ? 'wrong-session' : common.sessionId, result: control.reply,
    is_error: false, permission_denials: control.denied ? [{ tool_name: 'Bash', tool_input: { secret: 'NEVER_SAVE_DENIAL_INPUT' } }] : [] }));
}
main();
`); await chmod(executable, 0o700);
  f.config.commands.cc = executable;
  f.config.feishu = { mode: 'fake', receiverId: 'ou_synthetic', timeoutMs: 1000 };
  f.config.learning = false;
  if (options.enabled !== false) f.config.relay = { enabled: true, ccSessionsDir: registry, timeoutMs: 5000 };
  await validateConfig(f.config);
  const id = randomUUID();
  const items = options.items ?? [{ label: '回复会话' as const, text: '使用第二种方案吗？', suggestion: advice }];
  const notice: Notice = { version: 1, id, dedupeKey: id, at: new Date().toISOString(), tool: 'cc', kind: 'waiting', level: '现在就要你',
    sessionKey: `cc:${sessionId}`, memberSessionId: sessionId, text: '构造在等你卡片',
    content: { title: '构造项目的 CC 在等你', summary: '构造交代', situation: '正在做构造任务', action: '请回复会话', actionItems: items,
      returnCommand: `${executable} --resume ${sessionId}`, evidence: { project: cwd, intentOriginal: '构造目标', additionalRequirements: [], recentSteps: [], reason: '构造等待', originals: [{ path: transcript, fingerprint: hash(await readFile(transcript, 'utf8')) }] } } };
  await appendOutbox(f.config.dataDir, notice);
  const channel = feishuChannel(f.config, options.transport);
  await channel.send(notice);
  const sent = () => readJsonl<SentMessage>(join(f.config.dataDir, 'feishu-sent.jsonl'));
  const messageId = (await sent())[0]!.messageId;
  async function card() { return (await sent()).filter(row => row.messageId === messageId && row.type === 'interactive').at(-1)!.content; }
  let sequence = 0;
  function envelope(value: Record<string, string>, text?: string, actor = 'ou_synthetic', eventId = `event-${++sequence}`) {
    return { header: { event_id: eventId, event_type: 'card.action.trigger', create_time: String(Date.now() * 1000) }, event: {
      operator: { open_id: actor }, context: { open_message_id: messageId },
      action: { value, ...(text === undefined ? {} : { form_value: { relay_text: text, ignored_secret_field: 'DO_NOT_PERSIST_FORM' } }) },
    } };
  }
  async function push(raw: unknown, wait = true) { await channel.capture(raw); await channel.drain(); if (wait) await channel.settled(); }
  async function click(label: string, text?: string, wait = true) {
    const button = values(await card()).find(button => button.text === label);
    assert.ok(button, `卡片缺按钮 ${label}：${JSON.stringify(await card())}`);
    const raw = envelope(button.value, text); await push(raw, wait); return raw;
  }
  const calls = () => readJsonl<{ text: string; args: string[]; cwd: string; hasFeishuSecret: boolean }>(log);
  const journal = () => readJsonl<any>(join(f.config.dataDir, 'relay.jsonl'));
  t.after(async () => { await channel.stop(); await rm(f.root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); });
  return { ...f, cwd, registry, transcript, registration, control, notice, channel, sent, messageId, card, envelope, push, click, calls, journal, sessionId, turn };
}
async function waitFor(check: () => Promise<boolean>, ms = 3000) {
  const until = performance.now() + ms;
  while (performance.now() < until) { if (await check()) return; await delay(10); }
  throw new Error('替身未在期限内完成');
}

test('转达 A1：窗口内闲置 CC，建议逐字续同号会话，原回复回卡片、双处提醒重开并留记录', async t => {
  const f = await fixture(t);
  await f.click('按建议回');
  const preview = JSON.stringify(await f.card());
  assert.ok(preview.includes(JSON.stringify(advice).slice(1, -1))); assert.match(preview, /将发给.*CC 会话/); assert.match(preview, /窗口里看不到.*先重开/);
  assert.equal((await f.calls()).length, 0);
  await f.click('确认发送');
  const [call] = await f.calls(); assert.equal(call!.text, advice); assert.equal(call!.cwd, await realpath(f.cwd));
  assert.deepEqual(call!.args, ['--resume', f.sessionId, '-p', '--output-format', 'json']);
  const transcript = await readJsonl<any>(f.transcript);
  assert.equal(transcript.filter(row => row.type === 'user' && row.message.content === advice).length, 1);
  assert.ok(transcript.every(row => row.sessionId === f.sessionId));
  const receipt = JSON.stringify(await f.card()); assert.match(receipt, /已送到，.*它回了/); assert.ok(receipt.includes(JSON.stringify(reply).slice(1, -1))); assert.match(receipt, /窗口里看不到.*先重开/);
  const result = (await f.journal()).find(row => row.type === 'result');
  assert.equal(result.outcome, 'sent'); assert.equal(result.text, advice); assert.equal(result.sessionId, f.sessionId); assert.ok(result.at); assert.equal(result.actor, 'ou_synthetic');
});

test('转达 A2：手动输入框空白，保留空白/换行/引号，完全替换建议，不保存其余表单字段', async t => {
  const f = await fixture(t); await f.click('手动输入');
  const form = JSON.stringify(await f.card()); assert.match(form, /multiline_text/); assert.doesNotMatch(form, /default_value/);
  assert.equal(values(await f.card()).some(button => button.text === '确认发送'), false);
  const text = '  不同的原话\n"引号"；$(不是 shell)\n最后一行  ';
  await f.click('预览原话', text); assert.equal((await f.calls()).length, 0);
  await f.click('确认发送'); assert.equal((await f.calls())[0]!.text, text); assert.notEqual((await f.calls())[0]!.text, advice);
  assert.doesNotMatch(await readFile(join(f.config.dataDir, 'feishu-inbox.jsonl'), 'utf8'), /DO_NOT_PERSIST_FORM/);
});

test('转达 A3：AI未回完、登记忙/缺失/损坏/未知状态/死进程均不送，源文件字节不变', async t => {
  for (const mode of ['unfinished', 'busy', 'missing', 'corrupt', 'unknown', 'dead', 'no_end_record', 'partial'] as const) {
    const f = await fixture(t, { finished: mode !== 'unfinished' });
    if (mode === 'busy' || mode === 'unknown') await put(f.registration, JSON.stringify({ sessionId: f.sessionId, status: mode }));
    if (mode === 'missing') await rm(f.registry, { recursive: true });
    if (mode === 'corrupt') await put(f.registration, '{broken');
    if (mode === 'dead') {
      await rm(f.registration); await put(join(f.registry, '2147483647.json'), JSON.stringify({ sessionId: f.sessionId, status: 'idle' }));
    }
    // 末行结束信号缺失时，在发卡快照后先按新文件重新建一张卡。
    if (mode === 'no_end_record' || mode === 'partial') {
      const text = await readFile(f.transcript, 'utf8');
      await put(f.transcript, mode === 'partial' ? text.slice(0, -1) : text.split('\n').slice(0, -2).join('\n') + '\n');
    }
    const before = await readFile(f.transcript, 'utf8');
    await f.click('按建议回'); await f.click('确认发送');
    if (values(await f.card()).some(button => button.text === '仍然发送')) await f.click('仍然发送');
    assert.equal((await f.calls()).length, 0, mode); assert.equal(await readFile(f.transcript, 'utf8'), before, mode);
    assert.match(JSON.stringify(await f.card()), /没送到：.*(?:忙|闲着|读不|格式|写入|进程|完整)/, mode);
  }
});

test('转达 A4：过时卡片先问，取消不送，仍送只发一次；再次推进须再次确认', async t => {
  for (const cancel of [true, false]) {
    const f = await fixture(t); await appendFile(f.transcript, f.turn('电脑上后来的一轮').map(row => JSON.stringify(row) + '\n').join(''));
    await f.click('按建议回'); await f.click('确认发送');
    assert.match(JSON.stringify(await f.card()), /会话已经往下走了，还送吗/); assert.equal((await f.calls()).length, 0);
    if (cancel) { await f.click('取消'); assert.equal((await f.calls()).length, 0); }
    else {
      await appendFile(f.transcript, f.turn('又推进一轮').map(row => JSON.stringify(row) + '\n').join(''));
      await f.click('仍然发送'); assert.equal((await f.calls()).length, 0);
      await f.click('仍然发送'); assert.equal((await f.calls()).length, 1);
    }
  }
});

test('转达 A5：同事件重投、不同事件重复点同一确认、实例重启均不会重复发送', async t => {
  const f = await fixture(t); await f.click('按建议回');
  const value = values(await f.card()).find(button => button.text === '确认发送')!.value;
  const raw = f.envelope(value);
  await Promise.all([f.channel.capture(raw), f.channel.capture(raw), f.channel.capture(f.envelope(value))]);
  await f.channel.drain(); await f.channel.settled();
  assert.equal((await f.calls()).length, 1);
  const fresh = feishuChannel(f.config); await fresh.drain(); await fresh.settled(); await fresh.stop();
  assert.equal((await f.calls()).length, 1);
  assert.equal((await f.journal()).filter(row => row.type === 'result').length, 1);
});

test('转达 A6/A7：红线建议不带上、要二次确认，参数不抬权，拒绝授权在回执列出且不存 tool_input', async t => {
  const f = await fixture(t, { items: [
    { label: '回复会话', text: '使用第二种方案？', suggestion: advice },
    { label: '要你定·红线', text: '删除目录并合入吗？', suggestion: '删除并合入' },
    { label: '回复会话', text: '推到远端？', suggestion: '推到远端' },
  ] });
  await put(f.control, JSON.stringify({ reply, denied: true }));
  await f.click('按建议回'); await f.click('确认发送');
  assert.equal((await f.calls()).length, 0); assert.match(JSON.stringify(await f.card()), /再确认一次/);
  await f.click('红线再次确认发送');
  const [call] = await f.calls(); assert.equal(call!.text, advice); assert.equal(call!.args.some(arg => /dangerously|skip|permission|model/.test(arg)), false);
  assert.match(JSON.stringify(await f.card()), /这一步被拦、要授权：Bash/);
  for (const file of await readdir(f.config.dataDir)) if (file.endsWith('.jsonl')) assert.doesNotMatch(await readFile(join(f.config.dataDir, file), 'utf8'), /NEVER_SAVE_DENIAL_INPUT/);
});

test('手动原话含高风险内容也要额外确认，伪造跳过预览/红线的按钮不发', async t => {
  const f = await fixture(t);
  await f.push(f.envelope({ action: 'relay_confirm', noticeId: f.notice.id, draftId: 'forged' })); assert.equal((await f.calls()).length, 0);
  await f.click('手动输入'); await f.click('预览原话', '请删除构造目录');
  const draftId = values(await f.card()).find(button => button.text === '确认发送')!.value.draftId!;
  await f.push(f.envelope({ action: 'relay_red_confirm', noticeId: f.notice.id, draftId })); assert.equal((await f.calls()).length, 0);
  await f.click('确认发送'); assert.equal((await f.calls()).length, 0); await f.click('取消'); assert.equal((await f.calls()).length, 0);
});

test('转达 A8：文件消失、续话命令出错、返回错误会话号明确失败，轮询/重启不重试', async t => {
  for (const problem of ['deleted', 'exit', 'wrongSession'] as const) {
    const f = await fixture(t); await f.click('按建议回');
    if (problem === 'deleted') await rm(f.transcript);
    else await put(f.control, JSON.stringify({ reply, ...(problem === 'exit' ? { exit: 7 } : { wrongSession: true }) }));
    await f.click('确认发送'); assert.match(JSON.stringify(await f.card()), /没送到：/);
    const count = (await f.calls()).length; assert.equal(count, problem === 'deleted' ? 0 : 1);
    await f.channel.drain(); const fresh = feishuChannel(f.config); await fresh.drain(); await fresh.settled(); await fresh.stop();
    assert.equal((await f.calls()).length, count);
  }
});

test('转达 A9：缺省关闭无入口，旧卡关开关后不送；Pi/Codex/非等待卡及非本人不开放', async t => {
  const off = await fixture(t, { enabled: false }); assert.equal(values(await off.card()).some(button => button.value.action?.startsWith('relay_')), false);
  await off.push(off.envelope({ action: 'relay_confirm', noticeId: off.notice.id, draftId: 'old' })); assert.equal((await off.calls()).length, 0);
  const f = await fixture(t); await f.click('按建议回'); f.config.relay!.enabled = false; await f.click('确认发送');
  assert.equal((await f.calls()).length, 0); assert.match(JSON.stringify(await f.card()), /总开关已关闭/);
  f.config.relay!.enabled = true;
  for (const changed of [{ tool: 'pi' }, { tool: 'codex' }, { kind: 'drift' }] as const) {
    const notice = { ...f.notice, ...changed, id: randomUUID() }; await f.channel.send(notice);
    const message = (await f.sent()).find(row => row.noticeId === notice.id)!;
    assert.equal(values(message.content).some(button => button.value.action?.startsWith('relay_')), false);
  }
  const before = await f.journal(); await f.push(f.envelope({ action: 'relay_suggest', noticeId: f.notice.id }, undefined, 'ou_alien'));
  assert.deepEqual(await f.journal(), before); assert.equal((await f.calls()).length, 0);
});

test('长转达不持检测/收件/反馈锁：CC等闸门时继续检测、接收与确认按钮反馈', async t => {
  const f = await fixture(t), release = join(f.root, 'release');
  await put(f.control, JSON.stringify({ reply, waitFor: release }));
  await f.click('按建议回'); const began = performance.now(); await f.click('确认发送', undefined, false);
  await waitFor(async () => (await f.calls()).length === 1);
  try {
    const detection = await detect(f.config, new Date().toISOString(), { channels: [f.channel] }); assert.ok(detection.records.length);
    const detectRelease = await acquireLock(f.config.dataDir, '.detect.lock');
    try { await f.push(f.envelope({ action: 'feedback', verdict: '正确', noticeId: f.notice.id }), false); }
    finally { await detectRelease(); }
    assert.equal((await readFeedback(f.config.dataDir)).length, 1);
    assert.ok((await f.sent()).some(row => row.type === 'text' && JSON.stringify(row.content).includes('已记下')));
    assert.ok(performance.now() - began < 3000);
    assert.equal((await f.journal()).some(row => row.type === 'result'), false, '闸门未放行，CC仍在运行');
  } finally { await put(release, 'go'); await f.channel.settled(); }
  assert.match(JSON.stringify(await f.card()), /已送到/);
});

test('输入不截断、超长回复只取原文前段并说明全文在会话；未知登记、路径链接均失败关闭', async t => {
  const f = await fixture(t); await f.click('手动输入'); await f.click('预览原话', '字'.repeat(4001));
  assert.equal(values(await f.card()).some(button => button.text === '确认发送'), false);
  await put(f.control, JSON.stringify({ reply: '原文😀'.repeat(2500) }));
  await f.click('预览原话', '短原话'); await f.click('确认发送');
  assert.match(JSON.stringify(await f.card()), /已截断；全文在会话里/);
  assert.equal((await f.calls())[0]!.text, '短原话');
  const target = await readRelayTranscript(f.config, f.transcript);
  await put(join(f.registry, 'unknown.json'), '{}'); await assert.rejects(assertRelayIdle(f.config, target), /登记格式/);
  await rm(join(f.registry, 'unknown.json'));
  const link = join(f.config.sources.cc!, 'alias.jsonl'); await symlink(f.transcript, link);
  await assert.rejects(readRelayTranscript(f.config, link), /读不到|格式/);
  // 会话号不能伪装成 CLI 选项，即使原件 JSON 其余结构合法也不得送出。
  const forged = (await readJsonl<any>(f.transcript)).map(row => ({ ...row, sessionId: '--dangerously-skip-permissions' }));
  await put(f.transcript, forged);
  await assert.rejects(readRelayTranscript(f.config, f.transcript), /身份/);
});

test('旧记录原样保留；失去处理者的未决确认记为不确定，不重放 CC', async t => {
  const f = await fixture(t); await f.click('按建议回');
  const before = await readFile(join(f.config.dataDir, 'relay.jsonl'), 'utf8');
  const draft = (await f.journal()).findLast(row => row.view?.draft)?.view.draft;
  const abandoned = { type: 'action', id: 'abandoned', at: new Date().toISOString(), noticeId: f.notice.id, messageId: f.messageId,
    view: { stage: 'sending' }, attempt: { id: 'abandoned-attempt', at: new Date().toISOString(), noticeId: f.notice.id, messageId: f.messageId,
      actor: 'ou_synthetic', target: draft.target, text: draft.text, draft, ownerPid: 2147483647 } };
  await appendFile(join(f.config.dataDir, 'relay.jsonl'), JSON.stringify(abandoned) + '\n');
  const fresh = feishuChannel(f.config); await fresh.drain(); await fresh.settled(); await fresh.stop();
  assert.equal((await f.calls()).length, 0); assert.match(JSON.stringify(await f.card()), /上次转达中断，送达情况未确认/);
  assert.ok((await readFile(join(f.config.dataDir, 'relay.jsonl'), 'utf8')).startsWith(before));
});

test('续话超时仅一笔失败、不重试；慢卡片更新不阻塞按钮反馈', async t => {
  const f = await fixture(t); f.config.relay!.timeoutMs = 600;
  await put(f.control, JSON.stringify({ reply, waitFor: join(f.root, 'never-open') }));
  await f.click('按建议回'); await f.click('确认发送');
  assert.match(JSON.stringify(await f.card()), /没送到：.*超时/);
  const count = (await f.calls()).length;
  assert.ok(count <= 1); await f.channel.drain(); assert.equal((await f.calls()).length, count);
  assert.equal((await f.journal()).filter(row => row.type === 'started').length, 1);

  const slow = await fixture(t);
  let release!: () => void, holding = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const channel = feishuChannel(slow.config, {
    async send() { return `om_${randomUUID()}`; },
    async update() { holding = true; await gate; },
  });
  try {
    await channel.capture(slow.envelope({ action: 'relay_suggest', noticeId: slow.notice.id })); await channel.drain();
    await waitFor(async () => holding);
    const began = performance.now();
    await channel.capture(slow.envelope({ action: 'feedback', verdict: '正确', noticeId: slow.notice.id })); await channel.drain();
    assert.equal((await readFeedback(slow.config.dataDir)).length, 1); assert.ok(performance.now() - began < 900);
  } finally { release(); await channel.settled(); await channel.stop(); }
});

test('预览更新失败不能拿隐藏值确认发送，只留失败与一次说明，不重试卡片或 CC', async t => {
  const f = await fixture(t); let updates = 0;
  const channel = feishuChannel(f.config, { async send() { return `om_${randomUUID()}`; }, async update() { updates++; throw new Error('PRIVATE_UPSTREAM_ERROR'); } });
  try {
    await channel.capture(f.envelope({ action: 'relay_suggest', noticeId: f.notice.id })); await channel.drain(); await channel.settled();
    const draftId = (await f.journal()).findLast(row => row.view?.draft).view.draft.id;
    await channel.capture(f.envelope({ action: 'relay_confirm', noticeId: f.notice.id, draftId })); await channel.drain(); await channel.settled();
    await channel.drain(); await channel.settled();
    assert.equal((await f.calls()).length, 0); assert.equal(updates, 1);
    assert.ok((await f.journal()).some(row => row.type === 'ui_done' && row.ok === false));
    assert.doesNotMatch(await readFile(join(f.config.dataDir, 'feishu-sent.jsonl'), 'utf8'), /PRIVATE_UPSTREAM_ERROR/);
  } finally { await channel.stop(); }
});

test('完整检测链：构造会话→判断等待→飞书新卡→建议预览→同会话续话→原回复回卡', async t => {
  const f = await fixture(t);
  const config = { ...f.config, dataDir: join(f.root, 'detected-data'), judge: { executable: '/not-called', model: 'synthetic', timeoutMs: 1000 } };
  const channel = feishuChannel(config);
  try {
    await detect(config, new Date().toISOString(), { channels: [channel], judge: { async judge(request) {
      return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造等待', situation: '构造任务已回完', action: '请回答第二种方案是否继续', actionType: '回答问题',
        actionItems: [{ label: '回复会话', text: '第二种方案继续吗？', suggestion: '是' }] };
    } } });
    const sent = () => readJsonl<SentMessage>(join(config.dataDir, 'feishu-sent.jsonl'));
    const message = (await sent()).find(row => row.type === 'interactive')!; assert.ok(message);
    const latest = async () => (await sent()).filter(row => row.messageId === message.messageId).at(-1)!.content;
    for (const label of ['按建议回', '确认发送']) {
      const button = values(await latest()).find(button => button.text === label)!; assert.ok(button, JSON.stringify(await latest()));
      const raw: any = f.envelope(button.value); raw.event.context.open_message_id = message.messageId;
      await channel.capture(raw); await channel.drain(); await channel.settled();
    }
    assert.equal((await f.calls()).length, 1); assert.equal((await f.calls())[0]!.text, '是');
    assert.match(JSON.stringify(await latest()), /已送到/);
  } finally { await channel.stop(); }
});

test('转达日志损坏只关闭转达，不拖垮盯防检测/后续反馈，既有记录原样保留', async t => {
  const f = await fixture(t), path = join(f.config.dataDir, 'relay.jsonl');
  const original = await readFile(path, 'utf8'); await appendFile(path, '{BROKEN_RELAY_ONLY');
  await f.push(f.envelope({ action: 'relay_suggest', noticeId: f.notice.id }), false);
  await f.push(f.envelope({ action: 'feedback', verdict: '正确', noticeId: f.notice.id }), false);
  await f.channel.settled();
  assert.equal((await readFeedback(f.config.dataDir)).length, 1); assert.equal((await f.calls()).length, 0);
  const detection = await detect(f.config, new Date().toISOString(), { channels: [f.channel] }); assert.ok(detection.records.length);
  assert.equal(await readFile(path, 'utf8'), original + '{BROKEN_RELAY_ONLY');
});

test('末条字节恰好相同但又追加了一轮也先问；同会话另一张卡不得并发续话', async t => {
  const f = await fixture(t), original = await readFile(f.transcript, 'utf8');
  await appendFile(f.transcript, original);
  await f.click('按建议回'); await f.click('确认发送');
  assert.match(JSON.stringify(await f.card()), /会话已经往下走了，还送吗/); assert.equal((await f.calls()).length, 0);
  const release = await acquireLock(f.config.dataDir, `.relay-session-${hash(f.sessionId)}.lock`);
  try { await f.click('仍然发送'); assert.equal((await f.calls()).length, 0); assert.match(JSON.stringify(await f.card()), /没送到：.*已有一笔转达/); }
  finally { await release(); }
});

test('JSON 2.0 文本契约接受官方 div/plain_text，拒绝旧根结构、旧正文标签和错误文本模式', () => {
  const official = { schema: '2.0', body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: '这是示例文本。' } }] } };
  assert.deepEqual(literalTexts(official), ['这是示例文本。']);
  assert.throws(() => assertCardV2({ ...official, elements: official.body.elements }), /body.elements/);
  for (const tag of ['note', 'action', 'plain_text'])
    assert.throws(() => assertCardV2({ schema: '2.0', body: { elements: [{ tag }] } }), /不支持的 2.0 正文组件/);
  assert.throws(() => assertCardV2({ schema: '2.0', body: { elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**原话**' } }] } }), /Markdown/);
  assert.throws(() => assertCardV2({ schema: '2.0', body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: '原话' }, fields: [] }] } }), /fields\/extra/);
});

test('JSON 2.0 转达卡片契约覆盖入口、空白输入、预览、两类二次确认、发送中及成败回执', async t => {
  const f = await fixture(t), target = await readRelayTranscript(f.config, f.transcript);
  const original = '  **字面粗体** _下划线_ [链接](https://example.invalid) `代码`\n<at id="all">不提醒所有人</at> & <font color="red">不变色</font>\n```\n保留行尾  ';
  const draft = { id: 'contract-draft', text: original, target, redline: true, redlineConfirmed: false };
  const states: RelayView[] = [
    { stage: 'entry', target, suggestion: advice }, { stage: 'input', target },
    { stage: 'preview', draft }, { stage: 'stale', draft, message: '会话已经往下走了，还送吗？' },
    { stage: 'redline', draft, message: '请再确认一次。' }, { stage: 'sending', message: '正在转达。' },
    { stage: 'done', message: `已送到，它回了：\n${original}` }, { stage: 'done', message: '没送到：会话正忙' },
  ];
  for (const state of states) {
    const card = noticeCard(f.notice, state), nodes = assertCardV2(card), plain = literalTexts(card);
    if (state.draft) assert.ok(plain.includes(`将发给 ${f.cwd.split('/').at(-1)} 的 CC 会话 ${f.sessionId}：\n${original}`), state.stage);
    if (state.message) assert.ok(plain.includes(state.message), state.stage);
    if (state.stage === 'input') assert.equal(nodes.filter(node => node.tag === 'input').length, 1);
    const action = { preview: 'relay_confirm', stale: 'relay_stale_confirm', redline: 'relay_red_confirm' }[state.stage as 'preview' | 'stale' | 'redline'];
    if (action) assert.ok(values(card).some(button => button.value.action === action), state.stage);
  }
});

test('JSON 2.0 契约替身校验实际 send/update 调用边界，建议和手动输入经预览、二次确认到原文回执', async t => {
  const original = '  **原话不是格式** [也不是链接](https://example.invalid)\n`代码` <at id="all">字面标签</at>\n最后一行  ';
  const aiReply = '  **AI 原话**\n<font color="red">字面标签</font> & `原样`  ';
  for (const manual of [false, true]) {
    const updates: unknown[] = [], creates: unknown[] = [];
    const transport: FeishuTransport = {
      async send(type, content, key) {
        if (type === 'interactive') { const card: unknown = JSON.parse(content); assertCardV2(card); creates.push(card); }
        return `om_contract_${key}`;
      },
      async update(_messageId, content) { const card: unknown = JSON.parse(content); assertCardV2(card); updates.push(card); },
    };
    const f = await fixture(t, { transport, items: [
      { label: '回复会话', text: '使用第二个方案吗？', suggestion: advice },
      { label: '要你定·红线', text: '后续是否删除构造文件？' },
    ] });
    await put(f.control, JSON.stringify({ reply: aiReply }));
    if (manual) { await f.click('手动输入'); await f.click('预览原话', original); }
    else await f.click('按建议回');
    await appendFile(f.transcript, f.turn('本地又推进一轮').map(row => JSON.stringify(row) + '\n').join(''));
    await f.click('确认发送'); await f.click('仍然发送'); await f.click('红线再次确认发送');
    assert.equal(creates.length, 1);
    for (const label of ['确认发送', '仍然发送', '红线再次确认发送'])
      assert.ok(updates.some(card => values(card).some(button => button.text === label)), label);
    const text = manual ? original : advice;
    assert.equal((await f.calls())[0]!.text, text);
    assert.ok(updates.some(card => literalTexts(card).some(content => content.endsWith(`：\n${text}`))));
    assert.ok(literalTexts(await f.card()).some(content => content.startsWith('已送到，') && content.includes(aiReply)));
    assert.ok((await f.journal()).filter(row => row.type === 'ui_done').every(row => row.ok === true));
    if (manual) assert.ok(updates.some(card => assertCardV2(card).some(node => node.tag === 'input')));
  }
});

test('配置显式隔离目录、官方回调仅提取原始输入、SDK更新卡片走 message.patch', async t => {
  const f = await fixture(t);
  assert.equal(isInternalSession('cc', f.sessionId, f.cwd), false, '构造业务 cwd 必须独立于流水线证据目录');
  assert.equal(isInternalSession('cc', f.sessionId, join(f.root, '.pi-autoreview', 'internal-project')), true, '内部会话过滤规则保持不变');
  await assert.rejects(validateConfig({ ...f.config, relay: { enabled: true } }), /ccSessionsDir/);
  await assert.rejects(validateConfig({ ...f.config, relay: { enabled: true, ccSessionsDir: f.config.dataDir } }), /不能重叠/);
  const original = '  第一行\n第二行  ';
  assert.equal(normalizeIncoming(f.envelope({ action: 'relay_input' }, original))!.relayText, original);
  assert.equal(values(noticeCard(f.notice)).some(button => button.value.action?.startsWith('relay_')), false);
  let patched: any;
  const transport = await realTransport(f.config.feishu!, { credentials: { appId: 'cli_1234567890abcdef', appSecret: 'synthetic-only' }, loadSdk: async () => ({
    AppType: { SelfBuild: 0 }, Client: class { im = { message: { async patch(payload: unknown) { patched = payload; return { code: 0 }; } } }; },
  } as any) });
  await transport.update!('om_synthetic', '{"schema":"2.0"}'); assert.equal(patched.path.message_id, 'om_synthetic'); assert.equal(patched.data.content, '{"schema":"2.0"}');
});
