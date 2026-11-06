// Constructed Loop only. No real Loop, account, model or network calls.
import { readFile, appendFile, mkdir, copyFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法：node scripts/loop-worker-stub.mjs --state <构造快照JSON> --calls <调用JSONL> <查询|开工|启动|送话|续跑|停止> [批次文件] --json [--all] [--id <编号>] [--stage <原段>]
参数：--state/--calls 仅限临时夹具；送话从 stdin 读原文到 EOF；快照 test 支持 delay、unknown、hang、afterStartMs、livePauseReady/livePauseExit；--help/-h 只显示帮助。
常驻：通常执行一次后退出；test.hang 会挂起，启动的 livePause 模式会等待标记/构造会话结束。会操作构造 Git 仓库，但不调用真实 Loop。
停止：前台 Ctrl-C / SIGTERM；livePause 会话按夹具记录停止，或创建 livePauseExit 标记让它自然结束，不按进程名批杀。
帮助立即以退出码 0 结束，不读取快照/stdin，不建目录、不起子进程、不写文件。`);
  process.exit(0);
}
const statePath = args[args.indexOf('--state') + 1], calls = args[args.indexOf('--calls') + 1];
const verbs = ['查询', '开工', '启动', '送话', '续跑', '停止'];
const index = args.findIndex(a => verbs.includes(a)), verb = args[index], rest = args.slice(index + 1);
if (!statePath || !calls || index < 0 || !rest.includes('--json')) process.exit(2);
const state = JSON.parse(await readFile(statePath, 'utf8'));
const test = state.test;
if (!test?.root || !test.workspace || !statePath.startsWith(test.root + '/') || !calls.startsWith(test.root + '/')) throw new Error('Only isolated stub fixture paths allowed');
await appendFile(calls, JSON.stringify({ verb, args: rest, at: Date.now(), env: { stage: process.env.AUTOREVIEW_STAGE ?? null, pipeline: process.env.AUTOREVIEW_PIPELINE_DIR ?? null } }) + '\n');
const save = async () => { const tmp = `${statePath}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(state)); await rename(tmp, statePath); };
if (Number.isSafeInteger(test.delay?.[verb]) && test.delay[verb] > 0) await new Promise(resolve => setTimeout(resolve, test.delay[verb]));
const git = (...a) => execFileSync('git', ['-C', test.workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=PA Stub', '-c', 'user.email=stub@example.invalid', ...a], { stdio: 'pipe' });
if (verb === '查询') { console.log(JSON.stringify(state)); process.exit(0); }
if (test.unknown === verb) { console.log('{}'); process.exit(0); }
if (test.hang === verb) { await new Promise(() => { setInterval(() => {}, 10000); }); }
const file = rest[0], id = rest[rest.indexOf('--id') + 1];
if (verb === '开工') {
  if (!file.startsWith(test.project + '/')) throw new Error('outside synthetic project');
  const plan = JSON.parse(await readFile(file, 'utf8'));
  const target = join(test.workspace, relative(test.project, file));
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, target);
  await copyFile(join(dirname(file), '提示词.md'), join(dirname(target), '提示词.md'));
  git('checkout', '-b', plan.branch); git('add', '--', relative(test.project, dirname(file))); git('commit', '-m', 'synthetic Loop open');
  state.batches.push({ project: test.project, batch: { name: plan.name, file: target }, state: 'prepared', branch: plan.branch, stages: [], evidence: {} });
  await save(); console.log(JSON.stringify({ ok: true, batch: plan.name, branch: plan.branch, batchDocs: { workspace: test.workspace } }));
} else {
  const b = state.batches.find(b => b.batch.file === file);
  if (!b) { console.log(JSON.stringify({ v: 1, ok: false, command: verb, id, state: 'failed' })); process.exit(0); }
  if (verb === '启动' && typeof test.livePauseExit === 'string') {
    if (!test.livePauseExit.startsWith(test.root + '/') || typeof test.livePauseReady !== 'string' || !test.livePauseReady.startsWith(test.root + '/')) throw new Error('live pause markers must belong to the isolated fixture');
    const deadline = Date.now() + 10000;
    while (!existsSync(test.livePauseReady)) { if (Date.now() > deadline) throw new Error('fixture startup gate timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
    // A real child models the developer session. The original startup CLI waits
    // for it, including while the session is paused and after PA sends its reply.
    const session = spawn(process.execPath, ['-e', "const fs=require('node:fs'); const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);process.exit(0)}},20)", test.livePauseExit], { stdio: 'ignore' });
    const finished = new Promise((accept, reject) => { session.once('error', reject); session.once('close', accept); });
    await new Promise((accept, reject) => { session.once('spawn', accept); session.once('error', reject); });
    const sessionId = `synthetic-session-${b.batch.name}`;
    b.state = 'running'; b.next = null; b.events = { lastSeq: 1 };
    b.stages = [{ stage: '开发', state: 'paused', next: 'send', round: 1, repairs: 0, session: { host: 'pi', id: sessionId, alive: true }, pause: { since: new Date().toISOString() }, evidence: {} }];
    await save(); await appendFile(calls, JSON.stringify({ verb: 'session-start', id: sessionId, pid: session.pid, cliPid: process.pid }) + '\n');
    await finished;
    const latest = JSON.parse(await readFile(statePath, 'utf8')), ended = latest.batches.find(row => row.batch.file === file);
    ended.state = 'done'; ended.commit = git('rev-parse', 'HEAD').toString('utf8').trim();
    ended.stages = ended.stages.map(stage => ({ ...stage, state: 'done', session: { ...stage.session, alive: false } }));
    const temp = `${statePath}.${process.pid}.ended.tmp`; await writeFile(temp, JSON.stringify(latest)); await rename(temp, statePath);
    console.log(JSON.stringify({ v: 1, ok: true, command: verb, action: verb, state: 'done' })); process.exit(0);
  }
  if (verb === '送话' && test.livePauseExit) {
    const stage = b.stages.find(stage => stage.stage === rest[rest.indexOf('--stage') + 1]);
    if (!stage?.session?.alive || !['paused', 'done'].includes(stage.state)) { console.log(JSON.stringify({ v: 1, ok: false, command: verb, id, state: 'rejected' })); process.exit(0); }
    stage.state = 'running'; stage.pause = null; stage.paRelays = [{ id, at: new Date().toISOString() }];
    b.events.lastSeq++;
  }
  if (verb === '启动' || verb === '续跑' || verb === '送话') { b.state = 'running'; b.next = null; }
  if (verb === '停止') b.state = 'failed';
  await save();
  if (verb === '启动' && Number.isSafeInteger(test.afterStartMs) && test.afterStartMs > 0) await new Promise(resolve => setTimeout(resolve, test.afterStartMs));
  let text = '';
  if (verb === '送话') for await (const part of process.stdin) text += part;
  if (text) await appendFile(calls, JSON.stringify({ verb: '原文', text, id }) + '\n');
  console.log(JSON.stringify({ v: 1, ok: true, command: verb, action: verb, id, state: verb === '送话' ? 'read' : 'started' }));
}
