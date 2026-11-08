// Constructed Loop only. No real Loop, account, model or network calls.
import { readFile, appendFile, mkdir, copyFile, writeFile, rename, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const hash = s => createHash('sha256').update(s).digest('hex');
// A producer publishes only actual byte changes. Repeated read-only queries do
// not generate artificial filesystem notifications or endlessly wake Intake.
const publish = async (path, content) => {
  if (await readFile(path, 'utf8').catch(() => undefined) === content) return;
  const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, content); await rename(temp, path);
};
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
async function kernelSnapshot(b) {
  const common = realpathSync(execFileSync('git', ['-C', b.repo ?? test.project, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
  const dir = join(test.run, 'runs', hash(common), hash(b.batch.file)), ledger = join(dir, 'ledger.json');
  const revision = b.events?.lastSeq ?? 1, commit = b.commit ?? git('rev-parse', 'HEAD').toString().trim(), tree = git('rev-parse', 'HEAD^{tree}').toString().trim();
  const definitions = b.tasks ?? [{ id: '开发', name: '开发', state: b.state, stages: b.stages, release: b.release, launch: b.launch, supervisor: b.supervisor, worker: b.worker }];
  const nativeState = s => ['running', 'started', 'resumed'].includes(s) ? '进行中' : s === 'done' ? '可合入' : s === 'merged' ? '已合入' : s === 'abandoned' ? '已放弃' : '等你决定';
  const records = definitions.map(t => {
    const stage = t.stages?.[0], live = stage?.session?.alive === true;
    return { id: t.id, name: t.name, dir: definitions.length > 1 ? join(dir, 'tasks', t.id) : dir, epoch: t.epoch ?? 0, session: stage?.session,
      launch: t.launch ?? (stage?.session ? { pid: stage.session.pid, processStarted: stage.session.started, token: `synthetic-${t.id}` } : undefined), supervisor: t.supervisor, worker: t.worker,
      activity: live || t.active ? { id: t.attempt ?? `attempt-${t.id}`, node: t.node ?? '开发评审', kind: t.waiting ? 'waiting' : 'developing', ...(live ? { session: stage.session.id, pid: stage.session.pid, started: stage.session.started } : {}) } : undefined };
  });
  const cardText = await readFile(b.batch.file, 'utf8'), card = JSON.parse(cardText);
  const raw = { v: 1, id: b.runId, revision, repo: b.repo ?? test.project, common, file: b.batch.file, dir, cardHash: hash(cardText), card: { ...card, flow: b.flow ?? card.flow, tasks: definitions.map(t => ({ ...card.tasks?.find(definition => definition.name === t.name), name: t.name })) },
    pendingCard: b.pendingCard, changes: b.changes, publication: b.publication, stopped: b.stopped ?? b.state === 'failed', abandoned: b.state === 'abandoned',
    ...(definitions.length > 1 ? { taskRecords: records } : { ...records[0], id: b.runId }), results: b.results ?? [], userFileVersions: b.userFileVersions, userInputs: ['SYNTHETIC_PRIVATE_INPUT_NOT_FOR_MODEL'] };
  await mkdir(dir, { recursive: true }); await publish(join(dir, 'frozen-card.json'), cardText); await publish(join(dir, 'summary.md'), 'Constructed summary; not business acceptance.\n'); await publish(ledger, JSON.stringify(raw));
  const attempts = [];
  for (const base of [dir, ...(definitions.length > 1 ? records.map(r => r.dir) : [])]) {
    const root = join(base, 'attempts');
    const entries = await readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.filter(e => e.isDirectory() && /^[a-f0-9-]{36}$/.test(e.name))) {
      const evidence = join(root, entry.name, 'attempt.json'), result = (b.results ?? []).find(r => r.id === entry.name);
      try { attempts.push({ ...JSON.parse(await readFile(evidence, 'utf8')), status: result?.status ?? '结果未确认', evidence }); }
      catch { attempts.push({ id: entry.name, status: '尝试记录无法读取', evidence }); }
    }
  }
  return { attempts, ok: true, kernel: 1, id: b.runId, card: b.batch.file, name: b.batch.name, ledger, summary: join(dir, 'summary.md'), status: nativeState(b.state), reason: b.reason ?? '构造查询', node: '开发评审',
    tasks: definitions.map((t, i) => ({ id: t.id, name: t.name, status: records[i].activity && !t.waiting ? '进行中' : '等你决定', reason: t.reason ?? '构造任务', node: t.node ?? '开发评审', activity: records[i].activity ?? null, processIdentity: records[i].activity ? '存活' : '无活动', session: records[i].session,
      integrated: t.state === 'done' || b.state === 'done', candidate: { commit, tree }, release: t.release ?? b.release ?? { status: '未释放', details: [] } })),
    candidate: { commit, tree }, checks: b.checks ?? ['评审：没验证（尚未执行）', '测试：没验证（本次未安排）', '验收：没验证（尚未执行）'], missing: b.missing ?? ['验收未执行'], results: b.results ?? [], acceptanceItems: b.acceptanceItems ?? [], publication: b.publication ?? null,
    release: b.release ?? { status: '未释放', details: [] } };
}
if (verb === '查询') {
  if (test.queryFailure === 'timeout') await new Promise(() => { setInterval(() => {}, 10000); });
  if (test.queryFailure === 'bad-receipt') { console.log('{}'); process.exit(0); }
  if (rest[0] === '--all') console.log(JSON.stringify({ ...state, test: undefined, batches: await Promise.all(state.batches.map(b => b.kernel ? kernelSnapshot(b) : b)) }));
  else {
    const batch = state.batches.find(b => b.kernel && b.batch.file === rest[0]);
    const result = batch ? await kernelSnapshot(batch) : { v: 1, batches: state.batches.filter(b => !b.kernel && b.batch.file === rest[0]) };
    if (batch && test.queryRace > 0) {
      test.queryRace--; batch.events.lastSeq++;
      batch.checks = [`构造新修订 ${batch.events.lastSeq}：验收通过`]; batch.publication = { local: 'merged', push: '失败', reason: '构造发布缺项' };
      await kernelSnapshot(batch); await save();
    }
    console.log(JSON.stringify(result));
  }
  process.exit(0);
}
if (test.unknown === verb) { console.log('{}'); process.exit(0); }
if (test.hang === verb) { await new Promise(() => { setInterval(() => {}, 10000); }); }
const file = rest[0], id = rest[rest.indexOf('--id') + 1];
if (verb === '启动' && !state.batches.some(b => b.batch.file === file)) {
  const plan = JSON.parse(await readFile(file, 'utf8'));
  if (plan.version !== 1 || plan.stages || !file.startsWith(test.project + '/')) throw new Error('only version:1 startup in synthetic project');
  state.batches.push({ kernel: true, runId: randomUUID(), project: test.project, batch: { name: plan.name, file }, branch: 'synthetic-original', state: 'prepared', stages: [], evidence: {}, events: { lastSeq: 1 } });
  await save();
}
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
    const session = spawn(process.execPath, ['-e', "const fs=require('node:fs'); const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);process.exit(0)}},20)", test.livePauseExit], { detached: true, stdio: 'ignore' });
    const finished = new Promise((accept, reject) => { session.once('error', reject); session.once('close', accept); });
    await new Promise((accept, reject) => { session.once('spawn', accept); session.once('error', reject); });
    const sessionId = `synthetic-session-${b.batch.name}`;
    b.state = 'running'; b.next = null; b.events = { lastSeq: 1 };
    b.stages = [{ stage: '开发', state: 'paused', next: 'send', round: 1, repairs: 0, session: { host: 'pi', id: sessionId, alive: true, pid: session.pid, started: execFileSync('/bin/ps', ['-p', String(session.pid), '-o', 'lstart='], { encoding: 'utf8', env: { LC_ALL: 'C' } }).trim() }, pause: { since: new Date().toISOString() }, evidence: {} }];
    await save(); if (b.kernel) await kernelSnapshot(b);
    await appendFile(calls, JSON.stringify({ verb: 'session-start', id: sessionId, pid: session.pid, cliPid: process.pid }) + '\n');
    await finished;
    const latest = JSON.parse(await readFile(statePath, 'utf8')), ended = latest.batches.find(row => row.batch.file === file);
    ended.state = 'done'; ended.commit = git('rev-parse', 'HEAD').toString('utf8').trim();
    ended.stages = ended.stages.map(stage => ({ ...stage, state: 'done', session: { ...stage.session, alive: false } }));
    const temp = `${statePath}.${process.pid}.ended.tmp`; await writeFile(temp, JSON.stringify(latest)); await rename(temp, statePath);
    console.log(JSON.stringify(b.kernel ? { ...await kernelSnapshot(ended), command: verb } : { v: 1, ok: true, command: verb, action: verb, state: 'done' })); process.exit(0);
  }
  if (verb === '送话' && test.livePauseExit) {
    const stage = b.stages.find(stage => stage.stage === rest[rest.indexOf('--stage') + 1]);
    if (!stage?.session?.alive || !['paused', 'done'].includes(stage.state)) { console.log(JSON.stringify({ v: 1, ok: false, command: verb, id, state: 'rejected' })); process.exit(0); }
    stage.state = 'running'; stage.pause = null; stage.paRelays = [{ id, at: new Date().toISOString() }];
    b.events.lastSeq++;
  }
  if (b.kernel && verb === '送话') throw new Error('new kernel has no send interface');
  if (verb === '启动' || verb === '续跑' || verb === '送话') { b.state = 'running'; b.next = null; }
  if (verb === '停止') {
    if (rest.includes('--task') && b.tasks) {
      const task = b.tasks.find(t => t.name === rest[rest.indexOf('--task') + 1]);
      if (!task) throw new Error('unknown original task'); task.active = false; task.state = 'paused';
    } else b.state = 'failed';
  }
  if (b.kernel && verb !== '启动') b.events = { lastSeq: (b.events?.lastSeq ?? 1) + 1 };
  await save();
  if (verb === '启动' && Number.isSafeInteger(test.afterStartMs) && test.afterStartMs > 0) await new Promise(resolve => setTimeout(resolve, test.afterStartMs));
  let text = '';
  if (verb === '送话') for await (const part of process.stdin) text += part;
  if (text) await appendFile(calls, JSON.stringify({ verb: '原文', text, id }) + '\n');
  console.log(JSON.stringify(b.kernel ? { ...await kernelSnapshot(b), command: verb } : { v: 1, ok: true, command: verb, action: verb, id, state: verb === '送话' ? 'read' : 'started' }));
}
