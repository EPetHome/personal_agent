// Isolated acceptance sandbox: local stubs only, no credentials, no real Loop/launchd.
import { mkdir, mkdtemp, readdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeFeishu, scriptModel } from '../dist/src/stubs/servers.js';
const args = process.argv.slice(2), i = args.indexOf('--dir');
const root = i < 0 ? await mkdtemp(join(tmpdir(), 'pa-v2-sandbox-')) : resolve(args[i + 1]);
await mkdir(root, { recursive: true, mode: 0o700 });
if ((await readdir(root)).length) throw new Error('沙盒目录必须为空，拒绝覆盖已有文件');
for (const dir of ['project', 'inbox', 'events', 'loop-run', 'data', 'attachments']) await mkdir(join(root, dir), { mode: 0o700 });
const feishu = await fakeFeishu(0, join(root, 'fake-feishu-state.json'));
const model = await scriptModel({ requireReasoning: true, flow: [{ tools: [{ name: 'query_loop' }] }, { tools: [{ name: 'reply', arguments: { text: '授权项目里当前有 {{loopCount}} 个 Loop 批次；详情以只读查询为准。' } }] }, { text: 'done' }] }, 0, join(root, 'model-requests.json'));
const project = await realpath(join(root, 'project')), snapshot = join(root, 'loop.json');
const workers = args.includes('--workers'), workspace = join(await realpath(root), 'workspace');
if (workers) {
  const git = (...a) => execFileSync('git', ['-C', project, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=PA Stub', '-c', 'user.email=stub@example.invalid', ...a], { stdio: 'pipe' });
  await mkdir(join(project, 'code')); await writeFile(join(project, 'code/README.md'), '# Synthetic project\n');
  await writeFile(join(project, '.autoreview.json'), JSON.stringify({ workspaces: { dev: workspace } }));
  git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'synthetic sandbox'); git('worktree', 'add', '--detach', workspace);
}
await writeFile(snapshot, JSON.stringify({ v: 1, at: new Date().toISOString(), batches: workers ? [] : [1, 2, 3].map(n => ({ project, batch: { name: `fixture-${n}`, file: join(project, `batch-${n}.json`), recipe: 'develop' }, state: 'running', stages: [], evidence: {} })), ...(workers ? { test: { root, project, workspace } } : {}) }, null, 2));
const config = {
  dataDir: join(root, 'data'), attachmentDir: join(root, 'attachments'), inboxDirs: [join(root, 'inbox')],
  projects: [{ id: 'fixture', root: project, loopRunDirs: [join(root, 'loop-run')], ...(workers ? { loop: { batchDir: join(project, 'docs/batches'), workspace, workspaceName: 'dev', allow: ['code/'], deny: ['code/private/'] } } : {}) }], readAllow: [], readDeny: [],
  model: { url: `${model.url}/v1`, name: 'script-model', auth: { type: 'none' }, timeoutMs: 60000, maxOutputTokens: 8192, dailyTokenLimit: 0 },
  feishu: { mode: 'fake', userId: 'owner', url: feishu.url, pollMs: 250, timeoutMs: 10000 },
  loop: { command: process.execPath, args: [fileURLToPath(new URL(workers ? './loop-worker-stub.mjs' : './loop-stub.mjs', import.meta.url)), '--state', snapshot, '--calls', join(root, 'loop-calls.jsonl')], eventDirs: [join(root, 'events')], timeoutMs: 15000 },
  windowTokens: 100000, checkpointKeep: 8, maxToolRounds: 30,
  intake: { watch: true, fallbackMs: 60000, maxFileBytes: 20971520 },
  queue: { busyMs: 10000, inputTimeoutMs: 300000, stopMs: 30000 },
  concurrency: { router: 1, read: 3, skill: 1, writePerDirectory: 1 },
  approval: { readPi: true, send: true, dispatch: true, stop: true, redLine: true },
  watchdog: { heartbeatMs: 60000, heartbeatStaleMs: 120000, inputStaleMs: 300000, modelFailures: 3, feishuStaleMs: 300000, minDiskBytes: 1073741824, pollMs: 1000, local: { mode: 'fake', url: feishu.url } },
};
const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const ready = { root, config: configPath, feishu: feishu.url, model: model.url, pid: process.pid };
await writeFile(join(root, 'ready.json'), JSON.stringify(ready, null, 2)); console.log(JSON.stringify(ready, null, 2));
console.log(`替身已运行，主进程/看门狗未启动。另开终端，在 code/agent/ 运行：\nnode dist/src/main.js --config ${JSON.stringify(configPath)}\nnode dist/src/watchdog-main.js --config ${JSON.stringify(configPath)}`);
let stopped = false;
const stop = async () => { if (stopped) return; stopped = true; await Promise.all([feishu.close(), model.close()]); process.exit(0); };
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
