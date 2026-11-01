// 显式运行：node code/deploy/check-intelligence-pi.ts /绝对路径/pi
// 真Pi宿主 + 仅127.0.0.1的假模型，隔离HOME/agentDir；不读取真实账号、会话或项目。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, lstat, chmod, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { detect } from '../src/core/agent.ts';
import { project } from '../src/core/events.ts';
import { readEvents } from '../src/core/store.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { INTENT_FIELDS } from '../src/core/intelligence-types.ts';
import { ordinaryProject } from '../test/fixtures.ts';
import type { AnalysisResult } from '../src/core/intelligence-types.ts';
import type { Config } from '../src/core/types.ts';

const executable = process.argv[2];
if (!executable || !isAbsolute(executable)) throw new Error('请显式传入Pi绝对路径；此检查不会使用默认账号');
const root = await realpath(await mkdtemp(join(tmpdir(), 'pa-intelligence-pi-')));
const home = join(root, 'home'), agentDir = join(home, 'isolated-pi'), source = join(root, 'source');
const projectDir = await ordinaryProject();
const transcript = join(source, 'sample.jsonl'), dataDir = join(root, 'data');
for (const path of [agentDir, source, projectDir, join(projectDir, '.bak')]) await mkdir(path, { recursive: true });
const now = new Date().toISOString(), humanAt = new Date(Date.parse(now) - 60000).toISOString();
const rows = [
  { type: 'user', sessionId: 'sample', cwd: projectDir, timestamp: humanAt, origin: { kind: 'human' }, message: { role: 'user', content: '实现缓存。' + '完整构造任务材料。'.repeat(1600) + '长行末尾依据' } },
  { type: 'assistant', sessionId: 'sample', cwd: projectDir, timestamp: now, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '缓存已经实现。有效期需要多久？' }] } },
];
await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
await writeFile(join(projectDir, 'README.md'), '缓存实现完成，有效期待确认\n');
await writeFile(join(projectDir, '.env'), 'NEVER-SEND-ENV');
await writeFile(join(projectDir, 'id_rsa'), 'NEVER-SEND-KEY');
await writeFile(join(projectDir, '.bak', 'saved.txt'), 'NEVER-SEND-BACKUP');
const answer = { situation: '样例应用的缓存已经实现，有效期还需要用户决定。', debt: '欠', reason: '最后询问有效期', confidence: '有把握',
  suggestedReply: '保留十分钟', redline: false, actionType: '回答问题',
  intent: Object.fromEntries(INTENT_FIELDS.map(key => [key, { value: '待确认', basis: `${transcript}:1，实现缓存`, confidence: '拿不准' }])) };
const batches = [
  [ ['read', { path: transcript }], ['read', { path: join(projectDir, 'README.md') }], ['read', { path: join(projectDir, '.env') }],
    ['read', { path: join(projectDir, 'id_rsa') }], ['read', { path: join(projectDir, '.bak', 'saved.txt') }], ['read', { path: '~/.ssh/config' }],
    ['read', { path: join(dataDir, 'config.json') }] ],
  [ ['grep', { path: projectDir, pattern: 'NEVER' }], ['find', { path: projectDir, pattern: '**' }], ['ls', { path: projectDir }] ],
];
let requests = 0, releaseModel!: () => void, enteredModel!: () => void;
const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
const modelEntered = new Promise<void>(resolve => { enteredModel = resolve; });
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  try {
    const payload = JSON.parse(body); requests++;
    assert.equal(req.url, '/v1/chat/completions');
    assert.deepEqual(payload.tools.map((tool: any) => tool.function.name).sort(), ['find', 'grep', 'ls', 'read']);
    const messages = JSON.stringify(payload.messages);
    assert.doesNotMatch(messages, /NEVER-SEND-ENV|NEVER-SEND-KEY|NEVER-SEND-BACKUP/);
    if (requests > 1) assert.match(messages, /拒绝读取/);
    if (requests === 1) { enteredModel(); await modelGate; }
    const batch = batches[requests - 1];
    if (requests === 2) {
      const firstRead = payload.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_1_0');
      const page = JSON.parse(firstRead.content);
      assert.ok(page.next?.column > 1, '长会话行必须提供续读位置');
      batch!.push(['read', { path: transcript, ...page.next }]);
    }
    const delta = batch ? { role: 'assistant', tool_calls: batch.map(([name, args], i) => ({ index: i, id: `call_${requests}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }
      : { role: 'assistant', content: JSON.stringify(answer) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const value of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: batch ? 'tool_calls' : 'stop' }] }])
      res.write(`data: ${JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', ...value })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch { res.writeHead(500); res.end('fixture assertion failed'); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
try {
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'pa-local-fixture': {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-dummy-not-a-credential', models: [{ id: 'fixture', contextWindow: 32000, maxTokens: 4000 }],
  } } }));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' }));
  const wrapper = join(root, 'isolated-pi');
  const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', NO_PROXY: '127.0.0.1,localhost' };
  const diagnostics = join(root, 'isolated-stderr.txt');
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawn}=require('node:child_process');const fs=require('node:fs');\nconst child=spawn(${JSON.stringify(executable)},process.argv.slice(2),{stdio:['inherit','inherit','pipe'],env:${JSON.stringify(env)}});\nchild.stderr.on('data',chunk=>fs.appendFileSync(${JSON.stringify(diagnostics)},chunk));child.on('exit',code=>{process.exitCode=code??1});child.on('error',()=>{process.exitCode=1});\n`);
  await chmod(wrapper, 0o700);
  const config: Config = { dataDir, sources: { cc: source, pi: null, codex: null, loop: null }, inboxDir: null, commands: { cc: 'fake', codex: 'fake', pi: 'fake' },
    learning: false, judge: { executable: wrapper, model: 'pa-local-fixture/fixture', timeoutMs: 20000 }, intelligence: { timeoutMs: 20000, maxToolCalls: 24 } };
  // 假模型先不返回；真实detect必须先结束，随后才能由此处解除屏障。
  await detect(config, now, { channels: [] });
  let enterTimer: ReturnType<typeof setTimeout> | undefined;
  const entered = await Promise.race([modelEntered.then(() => true), new Promise<boolean>(resolve => { enterTimer = setTimeout(() => resolve(false), 15000); })]);
  clearTimeout(enterTimer);
  assert.ok(entered, '后台子进程未调用本机假模型');
  assert.equal(project(await readEvents(dataDir)).analysisResults.size, 0);
  releaseModel();
  let result: AnalysisResult | undefined;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { result = [...project(await readEvents(dataDir)).analysisResults.values()][0]; } catch { /* 等待短暂追加完成 */ }
    const locked = await lstat(join(dataDir, '.analysis.lock')).then(() => true, () => false);
    if (result && !locked) break;
    await delay(20);
  }
  assert.ok(result?.output, JSON.stringify({ failure: result?.failure, isolatedDiagnostics: await readFile(diagnostics, 'utf8').catch(() => '') }));
  assert.equal(result.toolCalls, 11); assert.ok(result.reads.some(read => read.path === transcript));
  assert.ok(result.blockedReads.length >= 5); assert.equal(requests, 3);
  console.log(JSON.stringify({ verified: '真实detect+独立后台进程+Pi扩展+本机假模型（屏障验证检测不等分析）', modelRequests: requests, durationMs: result.durationMs,
    toolCalls: result.toolCalls, blockedReads: result.blockedReads.length, reads: result.reads.length }));
} finally {
  releaseModel();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.all([rm(root, { recursive: true, force: true }), rm(projectDir, { recursive: true, force: true })]);
}
