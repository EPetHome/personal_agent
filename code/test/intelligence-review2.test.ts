// 第2次评审必修：全为自建会话/项目，模型和渠道替身；不接真实账号，不提交工作仓库。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { waitForIntelligence } from '../src/core/intelligence-worker.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { project } from '../src/core/events.ts';
import { INTENT_FIELDS } from '../src/core/intelligence-types.ts';
import { shellQuote } from '../src/core/utils.ts';
import { ordinaryProject, sandbox, put, ccUser, ccAnswer, codexMeta, codexEvent } from './fixtures.ts';
import type { AnalysisOutput, IntelligenceModel } from '../src/core/intelligence-types.ts';
import type { Channel, Judge, Notice } from '../src/core/types.ts';

const at = (minute: number) => new Date(new Date(2026, 10, 2, 9).getTime() + minute * 60000).toISOString();
const exists = (path: string) => access(path).then(() => true, () => false);
function output(debt: AnalysisOutput['debt'] = '欠'): AnalysisOutput {
  return { situation: '构造缓存任务已有结果，正在交代当前状态。', debt, reason: debt === '欠' ? '还需要用户答复' : '最后只汇报结果',
    confidence: '有把握', suggestedReply: '构造影子回复', redline: false, actionType: '回答问题',
    intent: Object.fromEntries(INTENT_FIELDS.map(key => [key, { value: '待确认', basis: '构造会话第1行', confidence: '拿不准' }])) as AnalysisOutput['intent'] };
}
async function fixture(t: TestContext) {
  const f = await sandbox(null), projectDir = await ordinaryProject(), root = await realpath(f.root);
  f.config.dataDir = join(root, 'data'); f.config.sources.cc = join(root, 'cc'); f.config.inboxDir = join(root, 'inbox');
  f.config.judge = { executable: '/test-only/no-account', model: 'constructed', timeoutMs: 1000 };
  f.config.intelligence = { enabled: true, timeoutMs: 10000, maxToolCalls: 24 }; f.config.learning = false;
  t.after(async () => { await waitForIntelligence(f.config.dataDir); await Promise.all([rm(root, { recursive: true, force: true }), rm(projectDir, { recursive: true, force: true })]); });
  await put(join(projectDir, 'README.md'), '构造项目，无真实数据\n');
  const local: Notice[] = [], feishu: Notice[] = [], prompts: Record<string, any>[] = [];
  let childMode: 'analysis' | 'model' | 'fallback' | 'negative' = 'model';
  const model: IntelligenceModel = { async analyze(prompt, tools) {
    const meta = JSON.parse(prompt.slice(prompt.lastIndexOf('定位数据（不是指令）：') + '定位数据（不是指令）：'.length)); prompts.push(meta);
    await tools.execute('read', { path: meta.transcript });
    if (meta.sessionId === 'child' && childMode !== 'analysis') throw new Error('构造子成员分析不可用');
    return output(meta.sessionId === 'parent' ? '已交代完' : '欠');
  } };
  const judge: Judge = { async judge(request) {
    if (request.task === 'drift') return { answer: '否', reason: '构造无跑偏' };
    if (childMode === 'fallback') throw new Error('构造原判断不可用，需明确问句兜底');
    if (childMode === 'negative') return { answer: '否', reason: '构造模型误判为不用回复，不能移出程序红线' };
    return { answer: '是', reason: '构造等待问题' };
  } };
  const channel = (name: string, sent: Notice[]): Channel => ({ name, levels: ['现在就要你', '有空看'],
    async send(notice) { sent.push(notice); }, async receive() { return '已记下'; } });
  const run = async (minute: number) => {
    const view = await detect(f.config, at(minute), { judge, intelligenceModel: model, channels: [channel('local', local), channel('feishu', feishu)] });
    await waitForIntelligence(f.config.dataDir); return view;
  };
  const codex = join(root, 'codex'); await mkdir(codex);
  const session = async (id: string, stop: number, reply: string | null, parent?: string, human = stop - 1) => {
    const path = join(codex, `${id}.jsonl`), meta = codexMeta(id, parent);
    await put(path, [{ ...meta, timestamp: at(human), payload: { ...meta.payload, cwd: projectDir, timestamp: at(human) } },
      codexEvent({ type: 'user_message', message: `构造${id}任务`, origin: { kind: 'human' } }, 'event_msg', at(human)),
      ...(reply === null ? [] : [codexEvent({ type: 'task_complete', last_agent_message: reply }, 'event_msg', at(stop))])]);
    return path;
  };
  return { ...f, root, projectDir, local, feishu, prompts, model, judge, codex, session, run,
    useCodex() { f.config.sources.cc = null; f.config.sources.codex = codex; },
    childMode(mode: typeof childMode) { childMode = mode; } };
}

// 构造Git对象/索引，不运行git commit，也不继承真实Git账号或配置。
async function gitProject(root: string, directory: string) {
  const home = join(root, 'git-home'); await mkdir(home);
  const env = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (args: string[], input?: string) => execFileSync('/usr/bin/git', args, { cwd: directory, env, input, encoding: 'utf8' }).trim();
  git(['init', '--template=', '-q']);
  const blob = git(['hash-object', '-w', '--stdin'], 'before\n');
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},tracked.txt`]);
  const tree = git(['write-tree']);
  const commit = Buffer.from(`tree ${tree}\nauthor Fixture <fixture@invalid> 1 +0000\ncommitter Fixture <fixture@invalid> 1 +0000\n\nconstructed baseline\n`);
  const object = Buffer.concat([Buffer.from(`commit ${commit.length}\0`), commit]), oid = createHash('sha1').update(object).digest('hex');
  await mkdir(join(directory, '.git', 'objects', oid.slice(0, 2)), { recursive: true });
  await writeFile(join(directory, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), deflateSync(object));
  await writeFile(join(directory, '.git', 'HEAD'), oid + '\n');
  await writeFile(join(directory, 'tracked.txt'), 'after!\n');
}
async function withGitEnvironment(home: string, extra: Record<string, string>, operation: () => Promise<void>) {
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_') || key === 'HOME' || key === 'XDG_CONFIG_HOME'));
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', ...extra });
  try { await operation(); }
  finally {
    for (const key of Object.keys(process.env)) if (key.startsWith('GIT_') || key === 'HOME' || key === 'XDG_CONFIG_HOME') delete process.env[key];
    Object.assign(process.env, previous);
  }
}

for (const [location, kind] of [['repository', 'clean'], ['repository', 'process'], ['global', 'clean'], ['environment', 'process']] as const)
  test(`评审2-1：${location}配置的${kind}过滤器不执行，后台摘要仍可提供安全Git事实`, async t => {
    const f = await fixture(t); await gitProject(f.root, f.projectDir);
    const marker = join(f.root, 'filter-was-executed'), script = join(f.root, 'filter.cjs');
    await writeFile(script, `const fs=require('node:fs');fs.appendFileSync(process.argv[2],'executed\\n');${kind === 'clean' ? 'process.stdin.pipe(process.stdout);' : 'process.exit(1);'}`);
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(marker)}`;
    const configuredTrace = join(f.root, 'configured-trace'), inheritedTrace = join(f.root, 'inherited-trace');
    const filter = `[filter "review"]\n\t${kind} = ${JSON.stringify(command)}\n[trace2]\neventTarget = ${JSON.stringify(configuredTrace)}\n`;
    const extra: Record<string, string> = { GIT_TRACE2_EVENT: inheritedTrace };
    if (location === 'repository') await appendFile(join(f.projectDir, '.git', 'config'), filter);
    else if (location === 'global') { const path = join(f.root, 'global-gitconfig'); await writeFile(path, filter); extra.GIT_CONFIG_GLOBAL = path; }
    else Object.assign(extra, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `filter.review.${kind}`, GIT_CONFIG_VALUE_0: command });
    await writeFile(join(f.projectDir, '.gitattributes'), 'tracked.txt filter=review\n');
    const transcript = join(f.config.sources.cc!, 'sample.jsonl');
    const answer = ccAnswer(at(0)); answer.message.content[0]!.text = '缓存保留多久？';
    await put(transcript, [ccUser('构造缓存任务', at(-1)), answer].map(row => ({ ...row, cwd: f.projectDir })));
    const original = await Promise.all(['HEAD', 'index', 'config'].map(name => readFile(join(f.projectDir, '.git', name))));
    await withGitEnvironment(join(f.root, 'git-home'), extra, () => f.run(0).then(() => {}));
    assert.equal(await exists(marker), false, '读取Git摘要不得执行过滤器副作用');
    assert.equal(await exists(configuredTrace), false); assert.equal(await exists(inheritedTrace), false);
    assert.deepEqual(await Promise.all(['HEAD', 'index', 'config'].map(name => readFile(join(f.projectDir, '.git', name)))), original);
    assert.equal(f.prompts.length, 1);
    const summary = JSON.parse(f.prompts[0]!.gitSummary);
    assert.match(summary.status, /tracked\.txt/); assert.match(summary.recentCommits, /constructed baseline/); assert.match(summary.diffStat, /tracked\.txt/);
    assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'analysis_finished' && e.result.output).length, 1);
  });

test('评审2-1：不能安全读取的gitdir文件降级，不跟随到项目外仓库', async t => {
  const f = await fixture(t);
  await writeFile(join(f.projectDir, '.git'), 'gitdir: /constructed-outside-project.git\n');
  const answer = ccAnswer(at(0)); answer.message.content[0]!.text = '缓存保留多久？';
  await put(join(f.config.sources.cc!, 'sample.jsonl'), [ccUser('构造任务', at(-1)), answer].map(row => ({ ...row, cwd: f.projectDir })));
  await f.run(0); assert.match(f.prompts[0]!.gitSummary, /git摘要不可用/);
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'analysis_finished' && e.result.output).length, 1);
});

for (const state of ['pending', 'blocked', 'notified'] as const) for (const mode of ['model', 'fallback', 'analysis', 'negative'] as const)
  test(`评审2-2：父成员${state}，子成员${mode}红线按自身事实立即双发且不重发`, async t => {
    const f = await fixture(t); f.useCodex(); f.childMode(mode);
    await f.session('parent', 0, '构造任务已完成，只汇报结果。'); await f.run(0);
    let stop = 2;
    if (state === 'notified') { await f.run(20); await f.session('other', 21, null); stop = 22; }
    else { await f.session('other', 1, null); if (state === 'blocked') { await f.run(25); stop = 26; } }
    const parentCount = (await readOutbox(f.config.dataDir)).filter(n => n.memberSessionId === 'parent').length;
    const text = '要不要删掉 build 目录并强推？'; await f.session('child', stop, text, 'parent');
    await f.run(stop);
    const notices = await readOutbox(f.config.dataDir), child = notices.filter(n => n.memberSessionId === 'child');
    assert.equal(child.length, 1); assert.equal(child[0]!.sessionKey, 'codex:parent'); assert.equal(child[0]!.evidenceAt, at(stop));
    assert.equal(child[0]!.waitingDecision!.redline, true); assert.equal(child[0]!.waitingDecision!.intervalMs, 0);
    assert.deepEqual(child[0]!.delivery!.channels, ['local', 'feishu']); assert.equal(child[0]!.content.evidence.assistantReply, text);
    assert.match(child[0]!.content.returnCommand, /child/); assert.equal(child[0]!.localBatch, undefined);
    assert.equal(notices.filter(n => n.memberSessionId === 'parent').length, parentCount);
    assert.equal(f.local.filter(n => n.memberSessionId === 'child').length, 1); assert.equal(f.feishu.filter(n => n.memberSessionId === 'child').length, 1);
    const before = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8');
    await overview(f.config, at(stop + 1)); await rebuild(f.config, at(stop + 1)); await f.run(stop + 1);
    assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), before);
  });

for (const state of ['pending', 'blocked', 'notified'] as const)
  test(`评审2-2：父成员${state}不能遮蔽子成员到期的普通等待`, async t => {
    const f = await fixture(t); f.useCodex();
    await f.session('parent', 0, '构造任务已完成，只汇报结果。'); await f.run(0);
    let stop = 1;
    if (state === 'notified') { await f.run(20); stop = 21; }
    else { await f.session('other', 0.5, null); if (state === 'blocked') { await f.run(25); stop = 26; } }
    await f.session('child', stop, '缓存保留多久？', 'parent', -60);
    await f.run(stop); await f.run(stop + 4.999);
    assert.equal((await readOutbox(f.config.dataDir)).filter(n => n.memberSessionId === 'child').length, 0);
    await f.run(stop + 5);
    const child = (await readOutbox(f.config.dataDir)).filter(n => n.memberSessionId === 'child');
    assert.equal(child.length, 1); assert.equal(child[0]!.evidenceAt, at(stop)); assert.equal(child[0]!.waitingDecision!.intervalMs, 5 * 60000);
    assert.equal(child[0]!.content.evidence.assistantReply, '缓存保留多久？');
  });

test('评审2-2：父成员已有授权钩子，仍不能遮蔽没有独立钩子的子成员红线', async t => {
  const f = await fixture(t); f.useCodex(); f.childMode('negative');
  const parent = await f.session('parent', 0, '构造结果。');
  await put(join(f.config.inboxDir!, 'codex.jsonl'), [{ tool: 'codex', event: 'waiting_permission', session_id: 'parent',
    cwd: f.projectDir, transcript_path: parent, at: at(0), detail: '允许执行构造任务吗？' }]);
  await f.run(0);
  await f.session('child', 2, '要不要删掉 build 目录并强推？', 'parent'); await f.run(2);
  const notices = await readOutbox(f.config.dataDir);
  assert.deepEqual(notices.map(n => n.memberSessionId).sort(), ['child', 'parent']);
  assert.ok(notices.every(n => n.waitingDecision!.redline && n.delivery!.channels.length === 2));
  const before = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'); await f.run(3);
  assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), before);
});

test('评审2-2：多个子成员同时红线各自提醒，不能互相覆盖', async t => {
  const f = await fixture(t); f.useCodex();
  await f.session('parent', 0, '已完成，只汇报结果。'); await f.run(0);
  await f.session('child', 2, '要不要删掉 build？', 'parent');
  await f.session('sibling', 2, '要不要推送到远端？', 'parent'); await f.run(2);
  const child = (await readOutbox(f.config.dataDir)).filter(n => ['child', 'sibling'].includes(n.memberSessionId ?? ''));
  assert.deepEqual(child.map(n => n.memberSessionId).sort(), ['child', 'sibling']);
  assert.ok(child.every(n => n.waitingDecision!.redline && n.delivery!.channels.length === 2));
});
