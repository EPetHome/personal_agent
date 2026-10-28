import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, lstat, mkdir, readFile, readdir, rm, symlink, link, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { validateConfig } from '../src/core/config.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { renderOverview } from '../src/core/judge.ts';
import { hash } from '../src/core/utils.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, later, loopSummary, piHeader, piMessage, pushed, put, sandbox, start } from './fixtures.ts';

const cli = resolve(import.meta.dirname, '../src/cli/main.ts');
async function fixture(t: TestContext) {
  const f = await sandbox();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  return { ...f, transcript: join(f.config.sources.cc!, 'session.jsonl') };
}
test('停滞：29/30 分钟不发，31 分钟发，40 分钟及恢复后再次停滞都不重复', async t => {
  const { config, transcript } = await fixture(t);
  await put(transcript, [ccUser(), ccCall()]);
  for (const time of ['10:29', '10:30']) {
    const view = await detect(config, `2026-10-20T${time}:00Z`);
    assert.equal(view.records[0]?.status, '进行中');
    assert.equal(view.noticesAdded, 0);
  }
  const first = await detect(config, later);
  assert.equal(first.records[0]?.status, '停滞');
  assert.equal(first.noticesAdded, 1);
  const notices = await readOutbox(config.dataDir);
  assert.equal(notices[0]?.level, '有空看');
  assert.match(notices[0]!.text, /npm test.*31 分钟/);
  const before = await readFile(join(config.dataDir, 'events.jsonl'), 'utf8');
  assert.equal((await detect(config, '2026-10-20T10:40:00Z')).noticesAdded, 0);
  assert.ok((await readFile(join(config.dataDir, 'events.jsonl'), 'utf8')).startsWith(before));
  await appendFile(transcript, JSON.stringify(ccUser('再补一条要求', '2026-10-20T10:41:00Z')) + '\n');
  assert.equal((await detect(config, '2026-10-20T11:20:00Z')).noticesAdded, 0);
});

test('等授权：回看命令和原文齐全；重复推送只发一次；之后有新动静就解除等待', async t => {
  const { config, transcript } = await fixture(t);
  await put(transcript, [ccUser('请保留这个完整原文\n第二行'), ccCall()]);
  const p = pushed(transcript); // 五分钟窗口后才发件。
  await put(join(config.inboxDir!, 'cc.jsonl'), [p, p]);
  const view = await detect(config, '2026-10-20T10:06:00Z');
  assert.equal(view.noticesAdded, 1);
  assert.equal(view.records[0]?.status, '在等我');
  const [notice] = await readOutbox(config.dataDir);
  assert.equal(notice?.level, '现在就要你');
  assert.equal(notice?.content.evidence.intentOriginal, '请保留这个完整原文\n第二行');
  assert.match(notice!.text, /Claude Code[\s\S]*npm test[\s\S]*claude --resume demo-cc/);
  assert.ok(!notice!.text.includes(notice!.id));
  assert.ok(!notice!.text.includes('cc:demo-cc'));
  assert.equal((await detect(config, later)).noticesAdded, 0);
  assert.equal((await readEvents(config.dataDir)).filter(e => e.kind === 'push_observed').length, 1);
  await appendFile(transcript, JSON.stringify(ccUser('授权后继续', '2026-10-20T10:02:00Z')) + '\n');
  assert.equal((await detect(config, '2026-10-20T10:03:00Z')).records[0]?.status, '进行中');
});

test('会话结束/本轮结束不会变成停滞；旧的 turn_end 不覆盖新工作', async t => {
  const { config, transcript } = await fixture(t);
  await put(transcript, [ccUser(), ccCall()]);
  await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript, 'session_end')]);
  const view = await detect(config, later);
  assert.equal(view.records[0]?.status, '已完成');
  assert.equal(view.noticesAdded, 0);
  await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(transcript, 'turn_end')]);
  await appendFile(transcript, JSON.stringify(ccUser('继续修改', '2026-10-20T10:30:00Z')) + '\n');
  assert.equal((await detect(config, later)).records[0]?.status, '进行中');
});

test('正常完成只进总览；当前状态丢失或损坏都可从事件重建；原件指纹不变', async t => {
  const { config, transcript } = await fixture(t);
  await put(transcript, [ccUser(), ccAnswer()]);
  const fingerprint = hash(await readFile(transcript, 'utf8'));
  const result = await detect(config, later);
  assert.equal(result.noticesAdded, 0);
  assert.equal(result.records[0]?.status, '已完成');
  assert.deepEqual((await readdir(config.dataDir)).sort(), ['events.jsonl', 'feedback.jsonl', 'outbox.jsonl', 'state.json']);
  await rm(join(config.dataDir, 'state.json'));
  const view = await overview(config);
  assert.equal(view.records[0]?.status, '已完成');
  assert.match(renderOverview(view.records, view.projection), /Claude Code.*\/sample\/project.*只修改测试用的 A 文件.*已完成/);
  await rebuild(config);
  const rebuilt = await readFile(join(config.dataDir, 'state.json'), 'utf8');
  await writeFile(join(config.dataDir, 'state.json'), 'not json');
  await rebuild(config);
  assert.equal(await readFile(join(config.dataDir, 'state.json'), 'utf8'), rebuilt);
  assert.equal(hash(await readFile(transcript, 'utf8')), fingerprint);
});

test('来源损坏按工具合并报警，恢复后再次失败开启新一轮；其他工具仍出总览', async t => {
  const { root, config, transcript } = await fixture(t);
  config.sources.codex = join(root, 'codex');
  await put(transcript, [ccUser(), ccAnswer()]);
  await put(join(config.sources.codex, 'bad.jsonl'), 'not json\n');
  await put(join(config.sources.codex, 'also-bad.jsonl'), '{"future": 1}\n');
  assert.equal((await detect(config, later)).noticesAdded, 1);
  const [notice] = await readOutbox(config.dataDir);
  assert.equal(notice?.tool, 'codex');
  assert.equal(notice?.kind, 'blind');
  assert.match(notice!.content.summary, /这件事：会话记录暂时读不了；Codex/);
  assert.match(notice!.text, /时间 \/ 回去看：.*\d\d:\d\d/);
  assert.doesNotMatch(notice!.content.summary, /\d{4}-\d\d-\d\dT/);
  assert.equal((await detect(config, '2026-10-20T10:32:00Z')).noticesAdded, 0);
  await put(join(config.sources.codex, 'bad.jsonl'), 'another broken line\n');
  assert.equal((await detect(config, '2026-10-20T10:33:00Z')).noticesAdded, 0);
  await rm(config.sources.codex, { recursive: true });
  await mkdir(config.sources.codex);
  await detect(config, '2026-10-20T10:34:00Z');
  await put(join(config.sources.codex, 'bad.jsonl'), 'broken\n');
  assert.equal((await detect(config, '2026-10-20T10:35:00Z')).noticesAdded, 1);
  assert.equal((await overview(config)).records[0]?.status, '已完成');
});

test('已配置目录不存在也报看不见；null 是显式停用而非回退默认目录', async t => {
  const { root, config } = await fixture(t);
  config.sources.cc = join(root, 'missing');
  assert.equal((await detect(config, later)).noticesAdded, 1);
  assert.equal((await readOutbox(config.dataDir))[0]?.tool, 'cc');
});

test('CC 意图只认 human：工具结果、后台任务通知和返修消息都不是追加要求', async t => {
  const { config, transcript } = await fixture(t);
  await put(transcript, [
    ccUser(), ccUser('顺便修改 B', start), ccUser('系统任务通知', start, 'task-notification'),
    ccUser('loop 要求返修', start, 'loop'), ccCall(),
    { ...ccUser('工具结果'), origin: undefined, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-other', content: '输出' }] } },
  ]);
  await detect(config, later);
  assert.deepEqual((await readOutbox(config.dataDir))[0]?.content.evidence.additionalRequirements, ['顺便修改 B']);
});

test('Pi 沿当前分支读意图和工具调用，不把废弃分支/custom 消息当成要求', async t => {
  const { root, config } = await fixture(t);
  config.sources.cc = null;
  config.sources.pi = join(root, 'pi');
  await put(join(config.sources.pi, 'session.jsonl'), [
    piHeader(), piMessage('a', null, 'user', '只改 A'),
    piMessage('abandoned', 'a', 'user', '废弃的要求 C'),
    piMessage('abandoned-tool', 'abandoned', 'assistant', [{ type: 'toolCall', id: 'old', name: 'bash', arguments: { command: 'old-command' } }]),
    { type: 'branch_summary', id: 'b', parentId: 'a', fromId: 'abandoned-tool', timestamp: start, summary: '废弃分支摘要' },
    piMessage('c', 'b', 'user', '追加 B'),
    { type: 'custom_message', id: 'system', parentId: 'c', timestamp: start, content: '自动返修，不是本人输入' },
    piMessage('d', 'system', 'custom', '更多系统消息'),
    piMessage('e', 'd', 'assistant', [{ type: 'toolCall', id: 'current', name: 'bash', arguments: { command: 'npm run build' } }]),
  ]);
  const view = await detect(config, later);
  assert.equal(view.records[0]?.status, '停滞');
  assert.deepEqual(view.records[0]?.intent, { initial: '只改 A', additions: ['追加 B'] });
  assert.equal(view.records[0]?.pendingTools.length, 1);
  assert.match((await readOutbox(config.dataDir))[0]!.text, /pi --session demo-pi/);
});

test('Pi 树断链/成环会报看不见，不平铺出一个假会话', async t => {
  const { root, config } = await fixture(t);
  config.sources.cc = null;
  config.sources.pi = join(root, 'pi');
  await put(join(config.sources.pi, 'bad.jsonl'), [piHeader(), piMessage('a', 'missing', 'user', '编的内容')]);
  const view = await detect(config, later);
  assert.equal(view.records.length, 0);
  assert.equal(view.noticesAdded, 1);
  assert.equal((await readOutbox(config.dataDir))[0]?.tool, 'pi');
});

test('Codex user_message 去掉 response_item 重复；commentary 不是收尾，输出必须按调用 id 配对', async t => {
  const { root, config } = await fixture(t);
  config.sources.cc = null;
  config.sources.codex = join(root, 'codex');
  const path = join(config.sources.codex, 'session.jsonl');
  await put(path, [codexMeta(),
    codexEvent({ type: 'user_message', message: '修改邮箱校验' }),
    codexEvent({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '修改邮箱校验' }] }, 'response_item'),
    codexEvent({ type: 'user_message', message: '系统追加', origin: { kind: 'loop' } }),
    codexEvent({ type: 'function_call', call_id: 'a', name: 'shell', arguments: '{"command":["npm","test"]}', status: 'completed' }, 'response_item'),
    codexEvent({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '还在测试' }], phase: 'commentary' }, 'response_item'),
    codexEvent({ type: 'function_call_output', call_id: 'other', output: '无关输出' }, 'response_item'),
  ]);
  const first = await detect(config, later);
  assert.equal(first.records[0]?.status, '停滞');
  assert.deepEqual(first.records[0]?.intent, { initial: '修改邮箱校验', additions: [] });
  await appendFile(path, JSON.stringify(codexEvent({ type: 'task_complete', last_agent_message: '完成' }, 'event_msg', '2026-10-20T10:32:00Z')) + '\n');
  assert.equal((await detect(config, '2026-10-20T10:33:00Z')).records[0]?.status, '已完成');
});

test('Codex 子代理并入父会话，系统派活不冒充用户意图', async t => {
  const { root, config } = await fixture(t);
  config.sources.cc = null;
  config.sources.codex = join(root, 'codex');
  await put(join(config.sources.codex, 'parent.jsonl'), [codexMeta(), codexEvent({ type: 'user_message', message: '父任务' })]);
  await put(join(config.sources.codex, 'child.jsonl'), [codexMeta('child', 'demo-codex'), codexEvent({ type: 'user_message', message: '子代理系统任务' }), codexEvent({ type: 'function_call', name: 'shell', call_id: 'call-child', arguments: '{"command":"npm test"}' }, 'response_item')]);
  const view = await detect(config, later);
  assert.equal(view.records.length, 1);
  assert.deepEqual(view.records[0]?.intent, { initial: '父任务', additions: [] });
  assert.equal(view.records[0]?.originals.length, 2);
  assert.equal(view.records[0]?.pendingTools.length, 1);
});

test('loop 用总结内项目路径，暂停叫你，完成附次数和未完事项；相同总结不重复', async t => {
  const { root, config } = await fixture(t);
  config.sources.cc = null;
  config.sources.loop = join(root, 'loop');
  const path = join(config.sources.loop, 'wrong-directory-name', '11111111-1111-4111-8111-111111111111.md');
  await put(path, loopSummary('暂停（开发方需要你决定）'));
  assert.equal((await detect(config, later)).noticesAdded, 1);
  const paused = (await readOutbox(config.dataDir))[0]!;
  assert.equal(paused.level, '现在就要你');
  assert.match(paused.text, /\/sample\/real-project[\s\S]*开发方需要你决定/);
  assert.ok(paused.text.includes(path));
  await put(path, loopSummary());
  assert.equal((await detect(config, '2026-10-20T10:32:00Z')).noticesAdded, 1);
  const completed = (await readOutbox(config.dataDir))[1]!;
  assert.equal(completed.level, '有空看');
  assert.match(completed.text, /完成；评审 3 次，返修 2 次[\s\S]*A2 需人工/);
  assert.equal((await detect(config, '2026-10-20T10:33:00Z')).noticesAdded, 0);
});

test('JSONL 事件事实持久化：删除发件索引后可从已提交决策补齐，状态重建不重复发', async t => {
  const { config, transcript } = await fixture(t);
  await put(transcript, [ccUser(), ccCall()]);
  await detect(config, later);
  const notices = await readOutbox(config.dataDir);
  const state = await readFile(join(config.dataDir, 'state.json'), 'utf8');
  await rebuild(config);
  assert.equal(await readFile(join(config.dataDir, 'state.json'), 'utf8'), state);
  await rm(join(config.dataDir, 'outbox.jsonl'));
  assert.equal((await detect(config, '2026-10-20T10:32:00Z')).noticesAdded, 1);
  assert.deepEqual(await readOutbox(config.dataDir), notices);
  await rebuild(config);
  assert.equal((await detect(config, '2026-10-20T10:33:00Z')).noticesAdded, 0);
});

test('损坏事件/半行不覆盖也不继续追加，保留原始现场', async t => {
  const { config, transcript } = await fixture(t);
  await put(transcript, [ccUser(), ccAnswer()]);
  await detect(config, later);
  const path = join(config.dataDir, 'events.jsonl');
  await appendFile(path, '{broken');
  const before = await readFile(path, 'utf8');
  await assert.rejects(detect(config, later), /损坏/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('推送损坏隔离为对应工具的失明；恶意 transcript_path 仅作为引用，不会打开', async t => {
  const { root, config, transcript } = await fixture(t);
  await put(transcript, [ccUser(), ccAnswer()]);
  const forbidden = join(root, 'unconfigured.jsonl');
  await put(forbidden, '不应该被解析的文件\n');
  await put(join(config.inboxDir!, 'cc.jsonl'), [pushed(forbidden)]);
  assert.equal((await detect(config, later)).noticesAdded, 1);
  assert.equal((await readOutbox(config.dataDir))[0]?.kind, 'blind');
  assert.equal(await readFile(forbidden, 'utf8'), '不应该被解析的文件\n');
});

test('数据目录不能与来源重叠，包括未创建目录和符号链接；不生成数据文件', async t => {
  const { root, config } = await fixture(t);
  const source = config.sources.cc!;
  for (const dataDir of [source, join(source, 'nested', 'not-created'), root]) {
    await assert.rejects(validateConfig({ ...config, dataDir }), /不能重叠/);
  }
  const alias = join(root, 'alias');
  await symlink(source, alias);
  await assert.rejects(validateConfig({ ...config, dataDir: join(alias, 'nested') }), /不能重叠/);
  assert.deepEqual(await readdir(source), []);
});

test('来源中的符号链接不跟随，数据文件符号链接/硬链接不写入原件', async t => {
  const { root, config, transcript } = await fixture(t);
  const target = join(root, 'target.jsonl');
  await put(target, [ccUser(), ccAnswer()]);
  const before = await readFile(target, 'utf8');
  await symlink(target, transcript);
  assert.equal((await detect(config, later)).noticesAdded, 1);
  assert.equal((await readOutbox(config.dataDir))[0]?.kind, 'blind');
  const outbox = join(config.dataDir, 'outbox.jsonl');
  await rm(outbox);
  await symlink(target, outbox);
  await assert.rejects(detect(config, later), /拒绝访问/);
  assert.equal(await readFile(target, 'utf8'), before);
  await rm(outbox);
  await link(target, outbox);
  await assert.rejects(detect(config, later), /拒绝访问/);
  assert.equal(await readFile(target, 'utf8'), before);
});

test('并发锁不绕过，不覆盖；未提供配置的 CLI 非 0 且不会生成数据文件', async t => {
  const { root, config } = await fixture(t);
  await mkdir(join(config.dataDir, '.detect.lock'), { recursive: true });
  await assert.rejects(detect(config, later), /正被占用/);
  assert.deepEqual(await readdir(config.dataDir), ['.detect.lock']);
  const result = spawnSync(process.execPath, [cli, 'detect'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /请先配置/);
  assert.deepEqual((await readdir(root)).sort(), ['cc', 'data', 'inbox']);
  assert.equal((await lstat(join(root, 'data'))).isDirectory(), true);
});

test('CLI 配置缺字段/相对路径/非法时间均报错，不创建数据目录', async t => {
  const { root, config } = await fixture(t);
  const path = join(root, 'config.json');
  for (const value of [{ dataDir: config.dataDir }, { ...config, dataDir: 'relative' }]) {
    await put(path, JSON.stringify(value));
    const result = spawnSync(process.execPath, [cli, 'detect', '--config', path], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
  }
  await put(path, JSON.stringify(config));
  const invalid = spawnSync(process.execPath, [cli, 'detect', '--config', path, '--now', '2026-10-20'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /带时区的 ISO 时间/);
  await assert.rejects(lstat(config.dataDir), { code: 'ENOENT' });
});

test('父目录没有访问权限时仍按来源报警，不在配置阶段中断其他工具', { skip: process.getuid?.() === 0 ? 'root 会绕过权限位' : false }, async t => {
  const { root, config } = await fixture(t);
  const locked = join(root, 'locked');
  config.sources.cc = join(locked, 'sessions');
  await mkdir(config.sources.cc, { recursive: true });
  config.sources.codex = join(root, 'codex');
  await put(join(config.sources.codex, 'normal.jsonl'), [codexMeta(), codexEvent({ type: 'task_complete' })]);
  await chmod(locked, 0);
  try {
    const view = await detect(config, later);
    assert.equal(view.noticesAdded, 1);
    assert.equal(view.records[0]?.tool, 'codex');
    assert.equal(view.records[0]?.status, '已完成');
    assert.equal((await readOutbox(config.dataDir))[0]?.tool, 'cc');
  } finally { await chmod(locked, 0o700); }
});

test('把文件误配为来源目录不能假装来源为空', async t => {
  const { config, transcript } = await fixture(t);
  await put(transcript, [ccUser(), ccAnswer()]);
  config.sources.cc = transcript;
  assert.equal((await detect(config, later)).noticesAdded, 1);
  assert.match((await readOutbox(config.dataDir))[0]!.text, /不是目录/);
});

test('loop 合法总结文件完全损坏仍报整体核心不可见，根目录总表不读取', async t => {
  const { root, config } = await fixture(t);
  config.sources.cc = null;
  config.sources.loop = join(root, 'loop');
  await put(join(config.sources.loop, '交付记录.md'), '这是总表，不是某次总结');
  await put(join(config.sources.loop, 'project', '22222222-2222-4222-8222-222222222222.md'), '未知格式');
  assert.equal((await detect(config, later)).noticesAdded, 1);
  assert.match((await readOutbox(config.dataDir))[0]!.text, /loop[\s\S]*无法识别 loop 总结格式/);
});

test('Codex 不带 task_complete 时也能识别完整答复，同时不把 commentary 当完成', async t => {
  const { root, config } = await fixture(t);
  config.sources.cc = null;
  config.sources.codex = join(root, 'codex');
  const path = join(config.sources.codex, 'session.jsonl');
  await put(path, [codexMeta(), codexEvent({ type: 'user_message', message: '编造的任务' }),
    codexEvent({ type: 'agent_message', message: '先看看', phase: 'commentary' }),
    codexEvent({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先看看' }] }, 'response_item')]);
  assert.equal((await detect(config, '2026-10-20T10:01:00Z')).records[0]?.status, '进行中');
  await appendFile(path, JSON.stringify(codexEvent({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已经做好了' }] }, 'response_item', '2026-10-20T10:02:00Z')) + '\n');
  assert.equal((await detect(config, later)).records[0]?.status, '已完成');
  assert.equal((await readOutbox(config.dataDir)).length, 0);
});

test('CC 明确标为 human 的引用文本仍保留原文，不凭内容猜成系统通知', async t => {
  const { config, transcript } = await fixture(t);
  const text = '<task-notification>这是我本人引用的样例，请分析它';
  await put(transcript, [ccUser(text), ccCall()]);
  const view = await detect(config, later);
  assert.equal(view.records[0]?.intent.initial, text);
});

test('停用来源后不继续判断旧记录或重读该工具推送，历史事件保留', async t => {
  const { config, transcript } = await fixture(t);
  await put(transcript, [ccUser(), ccCall()]);
  await detect(config, '2026-10-20T10:01:00Z');
  const eventsBefore = await readFile(join(config.dataDir, 'events.jsonl'), 'utf8');
  config.sources.cc = null;
  await put(join(config.inboxDir!, 'cc.jsonl'), '坏推送，停用后不应读取\n');
  const view = await detect(config, later);
  assert.equal(view.records.length, 0);
  assert.equal(view.noticesAdded, 0);
  assert.ok((await readFile(join(config.dataDir, 'events.jsonl'), 'utf8')).startsWith(eventsBefore));
});

test('停用推送后不沿用旧的推送读取故障来掩盖正常来源状态', async t => {
  const { root, config, transcript } = await fixture(t);
  await put(transcript, [ccUser(), ccAnswer()]);
  config.inboxDir = join(root, 'missing-inbox');
  assert.equal((await detect(config, later)).records[0]?.status, '看不见了');
  config.inboxDir = null;
  const view = await detect(config, '2026-10-20T10:32:00Z');
  assert.equal(view.records[0]?.status, '已完成');
  assert.equal(view.noticesAdded, 0);
});

test('样本配置生成器也不能通过目录别名把配置写回只读样本树', async t => {
  const { root } = await fixture(t);
  const sampleRoot = join(root, 'samples');
  const scene = join(sampleRoot, '01-demo');
  await put(join(scene, '卡片.md'), '编造的样本卡片');
  const alias = join(root, 'alias-to-samples');
  await symlink(sampleRoot, alias);
  const output = join(alias, '01-demo', 'config.json');
  const generator = resolve(import.meta.dirname, '../deploy/sample-config.ts');
  const result = spawnSync(process.execPath, [generator, scene, join(root, 'new-data'), output], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不能重叠/);
  assert.deepEqual(await readdir(scene), ['卡片.md']);
});

test('决策已提交而假渠道未交付时总览明确待写，不把计划当成已提醒；下轮补齐并确认', async t => {
  const { root, config, transcript } = await fixture(t);
  await put(transcript, [ccUser(), ccCall()]);
  await detect(config, later);
  const events = await readEvents(config.dataDir);
  // 在新目录构造中断现场：只写已提交事件前缀，不改已有事实文件。
  const interrupted = { ...config, dataDir: join(root, 'interrupted-data') };
  await put(join(interrupted.dataDir, 'events.jsonl'), events.filter(e => e.kind !== 'notices_delivered'));
  const before = await overview(interrupted);
  assert.equal(before.records[0]?.notice, '待写发件记录');
  assert.ok(!renderOverview(before.records, before.projection).includes('已提醒'));
  assert.equal((await detect(interrupted, '2026-10-20T10:32:00Z')).noticesAdded, 1);
  const after = await overview(interrupted);
  assert.equal(after.records[0]?.notice, '已提醒，本轮去重');
  assert.equal((await readEvents(interrupted.dataDir)).filter(e => e.kind === 'notices_delivered').length, 1);
  assert.equal((await detect(interrupted, '2026-10-20T10:33:00Z')).noticesAdded, 0);
});
