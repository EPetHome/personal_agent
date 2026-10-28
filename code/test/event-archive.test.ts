// 乙段：只使用构造数据、独立临时目录，不连接真实模型/通知/个人工具目录。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { acquireLock } from '../src/core/locks.ts';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import { event, packProjection, project } from '../src/core/events.ts';
import { modelEvidenceKey } from '../src/core/evidence.ts';
import { prepareEventLog, restoreEventLog } from '../src/core/event-archive.ts';
import type { ArchiveStage } from '../src/core/event-archive.ts';
import { receiveFeedback } from '../src/core/feedback.ts';
import { maintain, weeklySlot } from '../src/core/maintenance.ts';
import { readLearning } from '../src/core/learning.ts';
import { normalize } from '../src/core/normalize.ts';
import { perceive } from '../src/core/perception.ts';
import { applySessionDelta, sessionDelta } from '../src/core/session-delta.ts';
import { statistics } from '../src/core/statistics.ts';
import { appendJsonl, readEvents, readOutbox, withStoreLock } from '../src/core/store.ts';
import { renderOverview } from '../src/core/judge.ts';
import type { AgentEvent, Judge, JudgmentRequest, SessionRecord } from '../src/core/types.ts';
import { ccAnswer, ccCall, ccUser, codexEvent, codexMeta, put, sandbox, start } from './fixtures.ts';

const DAY = 86400000;
const now = new Date(2026, 9, 30, 19, 0, 0).toISOString(); // 本机周五晚，小结已到期。
const ago = (days: number) => new Date(Date.parse(now) - days * DAY).toISOString();
async function fixture(t: TestContext) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.learning = false;
  const transcript = join(f.config.sources.cc!, 'session.jsonl');
  await put(transcript, [ccUser(), ccCall()]);
  return { ...f, transcript };
}
async function prepare(dataDir: string, at = now, onStage?: (stage: ArchiveStage) => Promise<void>) {
  return withStoreLock(dataDir, () => prepareEventLog(dataDir, at, { onStage }));
}
async function recordOf(f: Awaited<ReturnType<typeof fixture>>): Promise<SessionRecord> {
  return normalize(await perceive(f.config), [], f.config).records[0]!;
}
async function legacy(t: TestContext) {
  const f = await fixture(t), record = await recordOf(f);
  const rows = [event({ kind: 'session_observed', record }, ago(8)), event({ kind: 'scan_completed' }, ago(8)),
    event({ kind: 'session_seen', tool: 'cc', sessionId: 'old-empty' }, ago(7.5)),
    event({ kind: 'scan_completed' }, ago(7)), event({ kind: 'scan_completed' }, ago(1))];
  // 非标准空白/CRLF 也必须逐字保留，不能 JSON.parse/stringify 后冒充原始归档。
  const raw = rows.map((row, i) => `${i % 2 ? '  ' : ''}${JSON.stringify(row)}\r\n`).join('');
  await put(join(f.config.dataDir, 'events.jsonl'), raw);
  await put(join(f.config.dataDir, 'outbox.jsonl'), '');
  await put(join(f.config.dataDir, 'feedback.jsonl'), '');
  return { ...f, rows, raw };
}
async function memberFaultFixture(t: TestContext, bad: 'parent' | 'child' = 'parent') {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.codex = join(f.root, 'codex');
  f.config.judge = { executable: '/synthetic/no-model', model: 'test/fake', dailyLimit: 20, timeoutMs: 1000 };
  const parentId = 'family-parent', childId = 'family-child', parent = join(f.config.sources.codex, 'parent.jsonl'), child = join(f.config.sources.codex, 'child.jsonl');
  const question = '请你选择构造接口使用蓝色还是绿色方案？';
  for (const role of ['parent', 'child'] as const) {
    const id = role === 'parent' ? parentId : childId, path = role === 'parent' ? parent : child;
    await put(path, [codexMeta(id, role === 'child' ? parentId : undefined),
      codexEvent({ type: 'user_message', message: '仅检查构造接口，不得修改无关模块' }),
      ...(role === bad ? [codexEvent({ type: 'function_call', call_id: 'bad-call', name: 'shell', arguments: '{"command":"BROKEN_MEMBER_ONLY：只属于故障成员的动作"}' }, 'response_item')] : []),
      codexEvent({ type: 'task_complete', last_agent_message: role === bad ? 'BROKEN_MEMBER_ONLY：故障成员的问句？' : question })]);
  }
  const badId = bad === 'parent' ? parentId : childId, healthyId = bad === 'parent' ? childId : parentId;
  const inbox = join(f.config.inboxDir!, 'codex.jsonl');
  const push = (id: string, path: string) => ({ tool: 'codex', event: 'turn_end', session_id: id, cwd: '/sample/codex', transcript_path: path,
    at: start, detail: 'BROKEN_MEMBER_ONLY：错配报信，不能用来判断健康成员' });
  await put(inbox, [push(badId, bad === 'parent' ? child : parent)]);
  return { ...f, parent, child, parentId, childId, badId, healthyId, question, inbox, push, at: '2026-10-20T10:06:00.000Z' };
}

test('乙 A1：1000 步与 10 步各变化一次，新增事件相差不超过两倍，完整会话可重放', async t => {
  const sizes: number[] = [];
  for (const count of [1000, 10]) {
    const f = await fixture(t), rows = [];
    for (let i = 0; i < count; i++) rows.push(ccUser(`构造要求 ${i}：检查接口，不访问外部账号`), ccCall(start, `call-${i}`));
    await put(f.transcript, rows);
    await detect(f.config, start);
    const before = await readFile(join(f.config.dataDir, 'events.jsonl'));
    await appendFile(f.transcript, [ccUser('追加一条等长要求：只改构造测试', '2026-10-20T10:01:00Z'), ccCall('2026-10-20T10:01:01Z', 'next-call')]
      .map(row => JSON.stringify(row) + '\n').join(''));
    await detect(f.config, '2026-10-20T10:01:02Z');
    const after = await readFile(join(f.config.dataDir, 'events.jsonl'));
    assert.ok(after.subarray(0, before.length).equals(before));
    const added = after.subarray(before.length).toString('utf8');
    assert.match(added, /session_delta/); assert.doesNotMatch(added, /session_observed/);
    sizes.push(Buffer.byteLength(added));
    assert.deepEqual(project(await readEvents(f.config.dataDir)).sessions.get('cc:demo-cc'), await recordOf(f));
  }
  assert.ok(Math.max(...sizes) / Math.min(...sizes) <= 2, `新增事件字节：${sizes.join(' / ')}`);
  t.diagnostic(`1000 步 / 10 步新增字节：${sizes.join(' / ')}`);
});

test('乙 差量：数组缩短、可选字段删除、父子成员/嵌套变化均可重放；坏基底拒绝且不改原对象', async t => {
  const f = await fixture(t), initial = await recordOf(f), before = structuredClone(initial);
  const expanded = { ...initial, intent: { ...initial.intent, additions: ['甲', '乙'] }, cwdHistory: [{ path: '/synthetic/a', cwds: ['/a', '/b'] }],
    humanRequestRefs: [{ index: 0, at: start }], members: [{ ...initial, sessionId: 'child', lastActivityAt: start }] };
  const first = sessionDelta(initial, expanded)!;
  assert.deepEqual(applySessionDelta(initial, first), expanded);
  assert.deepEqual(initial, before);
  const second = sessionDelta(expanded, initial)!;
  assert.deepEqual(applySessionDelta(expanded, second), initial);
  assert.equal(sessionDelta(initial, structuredClone(initial)), null);
  assert.throws(() => applySessionDelta(undefined, first), /基底/);
  assert.throws(() => applySessionDelta(initial, { ...first, changes: [{ path: ['__proto__', 'polluted'], value: true }] }), /损坏/);
});

test('乙 A2/A5：7 天前逐字压缩封存，边界/近期留在日志；先整目录备份，旧格式升级可恢复', async t => {
  const f = await legacy(t);
  await put(join(f.config.dataDir, 'learning.jsonl'), '');
  await put(join(f.config.dataDir, 'nested', 'other.txt'), '构造的其他持久文件\n');
  await put(join(f.config.dataDir, 'state.json'), '{"legacy":true}\n');
  const before = packProjection(project(f.rows));
  const rows = await prepare(f.config.dataDir);
  assert.deepEqual(packProjection(project(rows)), before);
  const checkpoint = rows[0]!; assert.equal(checkpoint.kind, 'store_checkpoint');
  if (checkpoint.kind !== 'store_checkpoint') throw new Error('缺检查点');
  const files = await readdir(join(f.config.dataDir, 'archives'));
  assert.deepEqual(files, [checkpoint.archive]);
  const archived = gunzipSync(await readFile(join(f.config.dataDir, 'archives', checkpoint.archive))).toString('utf8');
  assert.equal(archived, f.raw.split(/(?<=\n)/).slice(0, 3).join(''));
  assert.deepEqual(archived.trim().split('\n').map(line => JSON.parse(line)), f.rows.slice(0, 3));
  assert.deepEqual(rows.filter(e => e.kind === 'scan_completed').map(e => e.at), [ago(7), ago(1)]);
  assert.ok(!rows.some(e => f.rows.slice(0, 3).some(old => old.id === e.id)));
  const marker = rows.find(e => e.kind === 'store_format'); assert.ok(marker?.backup);
  assert.equal(await readFile(join(marker.backup!, 'events.jsonl'), 'utf8'), f.raw);
  assert.equal(await readFile(join(marker.backup!, 'nested', 'other.txt'), 'utf8'), '构造的其他持久文件\n');
  assert.equal(await readFile(join(marker.backup!, 'state.json'), 'utf8'), '{"legacy":true}\n');
  const restoredDir = join(f.root, 'rollback-copy'); await cp(marker.backup!, restoredDir, { recursive: true });
  assert.deepEqual((await overview({ ...f.config, dataDir: restoredDir })).records, (await overview(f.config)).records);
  const output = join(f.root, 'full-events.jsonl');
  await withStoreLock(f.config.dataDir, () => restoreEventLog(f.config.dataDir, output));
  assert.ok((await readFile(output, 'utf8')).startsWith(f.raw));
  await prepare(f.config.dataDir);
  assert.equal((await readdir(f.root)).filter(name => name.startsWith('backup-before-')).length, 1, '只迁移一次，不重复备份');
});

test('乙 A2：迟到/时间回退事件按原追加前缀封存，不重排事件、不漏过期事件', async t => {
  const f = await legacy(t);
  const late = event({ kind: 'scan_completed' }, ago(9));
  await appendJsonl(join(f.config.dataDir, 'events.jsonl'), [late]);
  const expected = packProjection(project([...f.rows, late]));
  const rows = await prepare(f.config.dataDir);
  assert.deepEqual(packProjection(project(rows)), expected);
  assert.ok(rows.slice(1).every(e => Date.parse(e.at) >= Date.parse(ago(7))));
});

for (const stage of ['migration_synced', 'migration_published'] as const) {
  test(`乙 A5：首次升级在 ${stage} 中断，旧事件完整，重试保留状态及可用整目录备份`, async t => {
    const f = await legacy(t), expected = packProjection(project(f.rows));
    const module = new URL('../src/core/event-archive.ts', import.meta.url).href;
    await withStoreLock(f.config.dataDir, async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `import {prepareEventLog} from ${JSON.stringify(module)};
        await prepareEventLog(${JSON.stringify(f.config.dataDir)}, ${JSON.stringify(now)}, {onStage: async s => {
          if(s === ${JSON.stringify(stage)}) process.kill(process.pid, 'SIGKILL');
        }});`], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', data => { stderr += data; });
      const [code, signal] = await once(child, 'close'); assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    });
    assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(f.raw));
    assert.deepEqual(packProjection(project(await readEvents(f.config.dataDir))), expected);
    await prepare(f.config.dataDir);
    assert.deepEqual(packProjection(project(await readEvents(f.config.dataDir))), expected);
    const backupNames = (await readdir(f.root)).filter(name => name.startsWith('backup-before-'));
    assert.ok(backupNames.length >= 1);
    for (const name of backupNames) assert.equal(await readFile(join(f.root, name, 'events.jsonl'), 'utf8'), f.raw);
  });
}

for (const stage of ['archive_synced', 'archive_published', 'log_synced', 'log_replaced'] as const) {
  test(`乙 A4：真实 SIGKILL 于 ${stage}，原事件不丢，重启后幂等封存成功`, async t => {
    const f = await legacy(t);
    // 先完成升级标记，单独中断封存提交；真实迁移中断另测。
    await prepare(f.config.dataDir, ago(6));
    const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
    const expected = packProjection(project(await readEvents(f.config.dataDir)));
    const module = new URL('../src/core/event-archive.ts', import.meta.url).href;
    const script = `import {prepareEventLog} from ${JSON.stringify(module)};
      await prepareEventLog(${JSON.stringify(f.config.dataDir)}, ${JSON.stringify(now)}, {onStage: async stage => {
        if(stage === ${JSON.stringify(stage)}) process.kill(process.pid, 'SIGKILL');
      }});`;
    // 子进程不另持锁：父进程持真实数据锁，构造单个写者中断，无需篡改/删除未知锁。
    await withStoreLock(f.config.dataDir, async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; child.stderr.on('data', data => { stderr += data; });
      const [code, signal] = await once(child, 'close');
      assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    });
    if (stage !== 'log_replaced') assert.equal(await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8'), before);
    assert.deepEqual(packProjection(project(await readEvents(f.config.dataDir))), expected);
    await prepare(f.config.dataDir);
    assert.equal((await readEvents(f.config.dataDir))[0]?.kind, 'store_checkpoint');
    const output = join(f.root, 'recovered.jsonl');
    await withStoreLock(f.config.dataDir, () => restoreEventLog(f.config.dataDir, output));
    assert.equal(await readFile(output, 'utf8'), before);
  });
}

test('乙 A4：归档不能落盘时不替换日志；故障消除后首次封存重试成功', async t => {
  const f = await legacy(t); await prepare(f.config.dataDir, ago(6));
  const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  await put(join(f.config.dataDir, 'archives'), '构造的路径冲突');
  await assert.rejects(prepare(f.config.dataDir));
  assert.equal(await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8'), before);
  await rm(join(f.config.dataDir, 'archives'));
  await prepare(f.config.dataDir);
  assert.equal((await readEvents(f.config.dataDir))[0]?.kind, 'store_checkpoint');
});

test('乙 连续封存：每日至多一次、跨轮差量可重放；恢复仅选已提交归档，不重复孤儿前缀', async t => {
  const f = await legacy(t); await prepare(f.config.dataDir, ago(6));
  await assert.rejects(prepare(f.config.dataDir, now, async stage => { if (stage === 'archive_published') throw new Error('构造中断'); }));
  const late = event({ kind: 'scan_completed' }, ago(9));
  await appendJsonl(join(f.config.dataDir, 'events.jsonl'), [late]);
  const firstRaw = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  await prepare(f.config.dataDir);
  assert.equal((await readdir(join(f.config.dataDir, 'archives'))).length, 2, '旧的未提交归档永久保留，不当作已提交数据');
  const previous = project(await readEvents(f.config.dataDir)).sessions.get('cc:demo-cc')!;
  const changed = { ...previous, intent: { ...previous.intent, additions: ['封存后的构造新要求'] } };
  const delta = event({ kind: 'session_delta', delta: sessionDelta(previous, changed)! }, new Date(Date.parse(now) + 60000).toISOString());
  await appendJsonl(join(f.config.dataDir, 'events.jsonl'), [delta]);
  const afterFirst = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  await prepare(f.config.dataDir, new Date(Date.parse(now) + 3600000).toISOString());
  assert.equal(await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8'), afterFirst, '同一天不重写检查点');
  const expected = packProjection(project(await readEvents(f.config.dataDir)));
  await prepare(f.config.dataDir, new Date(Date.parse(now) + 9 * DAY).toISOString());
  const rows = await readEvents(f.config.dataDir), header = rows[0]!;
  assert.equal(header.kind, 'store_checkpoint');
  if (header.kind !== 'store_checkpoint') throw new Error('缺检查点');
  assert.equal(header.sequence, 2); assert.equal(header.archives.length, 2);
  assert.deepEqual(packProjection(project(rows)), expected);
  const output = join(f.root, 'two-rounds.jsonl');
  await withStoreLock(f.config.dataDir, () => restoreEventLog(f.config.dataDir, output));
  assert.equal(await readFile(output, 'utf8'), firstRaw + JSON.stringify(delta) + '\n');
  await assert.rejects(withStoreLock(f.config.dataDir, () => restoreEventLog(f.config.dataDir, output)), /EEXIST/);
  assert.equal(await readFile(output, 'utf8'), firstRaw + JSON.stringify(delta) + '\n');
  const configPath = join(f.root, 'config.json'), cliOutput = join(f.root, 'cli-restored.jsonl');
  await put(configPath, JSON.stringify(f.config));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli/main.ts', import.meta.url)), 'restore-events', '--config', configPath, '--output', cliOutput, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const [code] = await once(child, 'close'); assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { output: cliOutput });
  assert.equal(await readFile(cliOutput, 'utf8'), await readFile(output, 'utf8'));
});

test('乙 迁移保护：已有反馈写者时不等锁、不改旧日志，释放后可重试备份和封存', async t => {
  const f = await legacy(t), release = await acquireLock(f.config.dataDir, '.feedback.lock');
  try { await assert.rejects(prepare(f.config.dataDir), /正被占用/); }
  finally { await release(); }
  assert.equal(await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8'), f.raw);
  await prepare(f.config.dataDir);
  assert.equal((await readEvents(f.config.dataDir))[0]?.kind, 'store_checkpoint');
});

test('乙 恢复保护：归档缺失/损坏时拒绝恢复，不保留半份输出，不修改活动日志', async t => {
  const f = await legacy(t); await prepare(f.config.dataDir);
  const header = (await readEvents(f.config.dataDir))[0]!;
  if (header.kind !== 'store_checkpoint') throw new Error('缺检查点');
  const before = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  const archive = join(f.config.dataDir, 'archives', header.archive), output = join(f.root, 'not-complete.jsonl');
  const original = await readFile(archive);
  for (const corrupt of [false, true]) {
    if (corrupt) await put(archive, '构造的坏压缩数据'); else await rm(archive);
    await assert.rejects(withStoreLock(f.config.dataDir, () => restoreEventLog(f.config.dataDir, output)));
    await assert.rejects(lstat(output), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8'), before);
    await writeFile(archive, original);
  }
});

test('乙 A6：启动清理状态残留；备份先于清理，其他文件/目录/链接及人工备份不动', async t => {
  const f = await legacy(t), dir = f.config.dataDir;
  await put(join(dir, '.state-left-1.tmp'), '半份状态'); await put(join(dir, '.state-left-2.tmp'), '另一半');
  await put(join(dir, '.other.tmp'), '保留');
  // 人工备份在数据目录之外，代码不删除也不遍历。
  const manual = join(f.root, 'backup-before-manual-data'); await put(join(manual, 'proof'), '不碰');
  await detect(f.config, ago(6));
  const names = await readdir(dir);
  assert.ok(!names.includes('.state-left-1.tmp') && !names.includes('.state-left-2.tmp'));
  assert.equal(await readFile(join(dir, '.other.tmp'), 'utf8'), '保留');
  assert.equal(await readFile(join(manual, 'proof'), 'utf8'), '不碰');
  const marker = (await readEvents(dir)).find(e => e.kind === 'store_format')!;
  assert.equal(await readFile(join(marker.backup!, '.state-left-1.tmp'), 'utf8'), '半份状态');
  await mkdir(join(dir, '.state-directory.tmp'));
  const target = join(f.root, 'external-proof'); await put(target, '不读不删目标');
  await symlink(target, join(dir, '.state-link.tmp'));
  await detect(f.config, ago(6));
  assert.ok((await lstat(join(dir, '.state-directory.tmp'))).isDirectory());
  assert.ok((await lstat(join(dir, '.state-link.tmp'))).isSymbolicLink());
  assert.equal(await readFile(target, 'utf8'), '不读不删目标');
});

test('乙 A3：封存前后检测/总览/统计/每周小结/复盘/误报压制一致，正常运行不读归档', async t => {
  const f = await fixture(t);
  f.config.learning = false; // 先只产生事实，小结稍后在相同输入上比较。
  await put(f.transcript, [ccUser('构造的配色任务', ago(8)), { ...ccAnswer(ago(8)), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '请你选蓝色还是绿色？' }] } }]);
  const judge: Judge = { async judge(request) { return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造答案' }; } };
  f.config.judge = { executable: '/synthetic/no-model', model: 'test/fake', dailyLimit: 20, timeoutMs: 1000 };
  await detect(f.config, ago(8), { judge });
  const waitingAt = new Date(Date.parse(now) - 6 * 60000).toISOString();
  await appendFile(f.transcript, [ccUser('接着检查同一任务', waitingAt), { ...ccAnswer(waitingAt), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '请你选蓝色还是绿色？' }] } }]
    .map(row => JSON.stringify(row) + '\n').join(''));
  await detect(f.config, now, { judge });
  const notice = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'waiting')!; assert.ok(notice);
  await receiveFeedback(f.config.dataDir, 'local', { noticeId: notice.id, content: '误报 构造的反馈', at: now });
  // 显式还原原始日志，比较相同事实、相同时刻的封存前后，而不是拿删事件后的两份状态相比较。
  const full = join(f.root, 'before-archive.jsonl');
  await withStoreLock(f.config.dataDir, () => restoreEventLog(f.config.dataDir, full));
  await cp(full, join(f.config.dataDir, 'events.jsonl'));
  f.config.learning = true;
  const experienceModel = { async draft() { return { layer: '归因未定' as const, reason: '构造归因', countermeasure: '构造对策' }; }, async same() { return true; } };
  const before = await overview(f.config, now), stats = await statistics(f.config.dataDir, now);
  const weekly = await maintain(f.config, now, experienceModel);
  assert.equal(weekly.filter(n => n.kind === 'weekly').length, 1);
  assert.ok(weeklySlot(now).toISOString() <= now);
  const learning = await readLearning(f.config.dataDir);
  const raw = packProjection(project(await readEvents(f.config.dataDir)));
  await prepare(f.config.dataDir);
  assert.deepEqual(packProjection(project(await readEvents(f.config.dataDir))), raw);
  assert.deepEqual((await overview(f.config, now)).records, before.records);
  assert.deepEqual(await statistics(f.config.dataDir, now), stats);
  assert.deepEqual(await maintain(f.config, now, experienceModel), weekly);
  assert.deepEqual(await readLearning(f.config.dataDir), learning);
  // 把归档移开，正常检测、查询、重建仍成功；恢复功能才需要归档。
  await rm(join(f.config.dataDir, 'archives'), { recursive: true });
  assert.deepEqual((await overview(f.config, now)).records, before.records);
  assert.deepEqual((await rebuild(f.config, now)).records, before.records);
  let calls = 0;
  const repeated = await detect(f.config, now, { judge: { async judge() { calls++; throw new Error('不得调用真实模型'); } } });
  assert.deepEqual(repeated.records, before.records); assert.equal(calls, 0);
  assert.equal((await readOutbox(f.config.dataDir)).filter(n => n.kind === 'weekly').length, 1);
  assert.equal((await readOutbox(f.config.dataDir)).filter(n => n.kind === 'waiting').length, 1);
});

test('乙 复盘：已发复现提醒被封存后不重建、不重发；原问题/经验/反馈与计数不变', async t => {
  const f = await fixture(t); f.config.learning = true;
  await detect(f.config, start);
  await receiveFeedback(f.config.dataDir, 'local', { noticeId: null, content: '漏了 构造同一问题', at: '2026-10-20T10:01:00Z' });
  await receiveFeedback(f.config.dataDir, 'local', { noticeId: null, content: '漏了 构造同一问题', at: '2026-10-20T10:02:00Z' });
  const at = '2026-10-20T10:03:00Z';
  await detect(f.config, at);
  const outbox = await readOutbox(f.config.dataDir), learning = await readLearning(f.config.dataDir);
  assert.equal(outbox.filter(n => n.kind === 'recurrence').length, 1);
  assert.equal(learning.problems.length, 2);
  assert.deepEqual(await maintain(f.config, at), []);
  await prepare(f.config.dataDir, new Date(Date.parse(at) + 8 * DAY).toISOString());
  assert.equal((await readEvents(f.config.dataDir)).filter(e => e.kind === 'notice_planned').length, 0);
  assert.deepEqual(await maintain(f.config, at), []);
  assert.deepEqual(await readOutbox(f.config.dataDir), outbox);
  assert.deepEqual(await readLearning(f.config.dataDir), learning);
});

test('乙 A7：一条 Codex 推送对不上只影响那个会话，另一个等你照常发；恢复/重建不重发', async t => {
  const f = await fixture(t); f.config.sources.cc = null; f.config.sources.codex = join(f.root, 'codex');
  const bad = join(f.config.sources.codex, 'bad.jsonl'), good = join(f.config.sources.codex, 'good.jsonl');
  const at = new Date(Date.parse(now) - 6 * 60000).toISOString();
  await put(bad, [codexMeta('bad'), codexEvent({ type: 'task_started' }, 'event_msg', at)]);
  await put(good, [codexMeta('good'), codexEvent({ type: 'user_message', message: '构造配色任务' }, 'event_msg', at),
    codexEvent({ type: 'task_complete', last_agent_message: '请你确认用蓝色还是绿色？' }, 'event_msg', at)]);
  const inbox = join(f.config.inboxDir!, 'codex.jsonl');
  const push = (session: string, path: string) => ({ tool: 'codex', event: 'turn_end', session_id: session, cwd: '/sample/codex', transcript_path: path, at, detail: '请你确认用蓝色还是绿色？' });
  await put(inbox, [push('bad', good), push('good', good)]);
  f.config.judge = { executable: '/synthetic/no-model', model: 'test/fake', dailyLimit: 20, timeoutMs: 1000 };
  const judge: Judge = { async judge(request) { return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造判断' }; } };
  const sent: string[] = [];
  const channels = [{ name: 'local', async send(n: { kind: string }) { sent.push(n.kind); }, async receive() { return '已记下'; } }];
  const view = await detect(f.config, now, { judge, channels });
  assert.equal(view.records.find(r => r.sessionId === 'bad')?.status, '看不见了');
  assert.equal(view.records.find(r => r.sessionId === 'good')?.status, '在等我');
  assert.equal(view.projection.health.get('codex')?.since, null); assert.deepEqual(view.projection.health.get('codex')?.errors, []);
  assert.deepEqual(sent.sort(), ['blind', 'waiting']);
  const blind = (await readOutbox(f.config.dataDir)).find(n => n.kind === 'blind')!;
  assert.match(blind.content.evidence.reason, /只影响这一个会话/); assert.equal(blind.feedbackScope, 'codex:bad');
  assert.match(renderOverview(view.records, view.projection), /其他会话照常/);
  assert.deepEqual((await rebuild(f.config, now)).records, view.records);
  const raw = packProjection(project(await readEvents(f.config.dataDir)));
  await prepare(f.config.dataDir, new Date(Date.parse(now) + 8 * DAY).toISOString());
  assert.deepEqual(packProjection(project(await readEvents(f.config.dataDir))), raw, '对账索引、判断缓存和渠道去重均进入检查点');
  assert.equal((await detect(f.config, now, { judge, channels })).noticesAdded, 0);
  assert.deepEqual(sent.sort(), ['blind', 'waiting'], '封存后旧告警和旧等待不重发');
  await put(inbox, [push('bad', bad), push('good', good)]);
  const recovered = await detect(f.config, now, { judge, channels });
  assert.equal(recovered.projection.pushMismatches.size, 0);
  assert.notEqual(recovered.records.find(r => r.sessionId === 'bad')?.status, '看不见了');
});

for (const scenario of ['parent', 'child', 'fallback'] as const) {
  test(`乙 返修1：${scenario} 成员错配不阻断同组健康成员无授权推送的回复等待`, async t => {
    const f = await memberFaultFixture(t, scenario === 'child' ? 'child' : 'parent');
    if (scenario === 'child') {
      const oldAt = '2026-10-20T09:50:00Z';
      await withStoreLock(f.config.dataDir, () => appendJsonl(join(f.config.dataDir, 'events.jsonl'), [event({ kind: 'model_checked', check: {
        key: `drift:codex:${f.parentId}`, recordKey: `codex:${f.parentId}`, sessionId: f.parentId, task: 'drift', at: oldAt, evidenceAt: oldAt,
        fingerprint: 'synthetic-legacy-group-check', stepIds: [], summary: 'BROKEN_MEMBER_ONLY：旧组级摘要里的故障子成员动作', result: { answer: '否', reason: '构造的旧结论' },
      } }, oldAt)]));
    }
    const calls: JudgmentRequest[] = [], sent: string[] = [];
    const judge: Judge = { async judge(request) {
      calls.push(request);
      if (scenario === 'fallback') throw new Error('构造的模型不可用');
      return { answer: request.task === 'waiting' ? '是' : '否', reason: '健康成员需要选择方案' };
    } };
    const channels = [{ name: 'local', async send(n: { kind: string }) { sent.push(n.kind); }, async receive() { return '已记下'; } }];
    const view = await detect(f.config, f.at, { judge, channels });
    assert.equal(view.records.length, 1, '父子组仍聚合展示');
    assert.equal(view.records[0]?.members?.length, 2);
    assert.equal(view.records[0]?.status, '在等我');
    assert.equal((view.records[0]?.modelWaiting ?? view.records[0]?.ruleWaiting)?.sessionId, f.healthyId);
    assert.ok(calls.some(call => call.task === 'waiting')); assert.equal(view.projection.pushMismatches.size, 1);
    for (const request of calls) assert.doesNotMatch(JSON.stringify(request.context), /BROKEN_MEMBER_ONLY/);
    if (scenario === 'fallback') assert.equal(view.records[0]?.ruleWaiting?.sessionId, f.healthyId);
    else assert.equal(view.records[0]?.modelWaiting?.sessionId, f.healthyId);
    assert.ok(view.projection.modelChecks.has(`drift:codex:${f.parentId}:${f.healthyId}`), '局部故障用成员级跑偏缓存，不混用旧组级摘要');
    assert.deepEqual(view.projection.health.get('codex')?.errors, []);
    const notices = await readOutbox(f.config.dataDir), waiting = notices.find(n => n.kind === 'waiting')!, blind = notices.find(n => n.kind === 'blind')!;
    assert.equal(waiting.memberSessionId, f.healthyId); assert.match(waiting.content.returnCommand, new RegExp(`resume ${f.healthyId}$`));
    assert.match(waiting.content.summary, /蓝色还是绿色/);
    assert.equal(blind.memberSessionId, f.badId); assert.equal(blind.feedbackScope, `codex:${f.badId}`);
    assert.deepEqual(sent.sort(), ['blind', 'waiting']);
    const count = calls.length;
    assert.deepEqual((await overview(f.config, f.at)).records, view.records);
    assert.deepEqual((await rebuild(f.config, f.at)).records, view.records);
    assert.equal(calls.length, count, '查询/重建只用健康成员的缓存');
    if (scenario !== 'fallback') {
      await prepare(f.config.dataDir, '2026-10-28T10:06:00Z');
      assert.deepEqual((await overview(f.config, f.at)).records, view.records);
      assert.equal((await detect(f.config, f.at, { judge, channels })).noticesAdded, 0);
      assert.equal(calls.length, count, '封存后成功判断不重调');
      assert.deepEqual(sent.sort(), ['blind', 'waiting'], '故障及等待均不重发');
      const aged = await detect(f.config, '2026-10-21T10:07:00Z', { judge, channels });
      assert.equal(aged.records[0]?.status, '看不见了', '健康成员等待过期不能把仍失明的组冒充已搁置');
      assert.equal(calls.length, count);
    }
  });
}

test('乙 返修1：健康子成员的实际步骤继续即时判断跑偏，不混入故障父成员或定位到它', async t => {
  const f = await memberFaultFixture(t);
  await put(f.child, [codexMeta(f.childId, f.parentId), codexEvent({ type: 'user_message', message: '仅检查构造接口，不得修改无关模块' }),
    codexEvent({ type: 'function_call', call_id: 'healthy-action', name: 'shell', arguments: '{"command":"HEALTHY_MEMBER_ACTION：修改无关模块"}' }, 'response_item', '2026-10-20T10:01:00Z')]);
  const requests: JudgmentRequest[] = [];
  const judge: Judge = { async judge(request) {
    requests.push(request);
    return { answer: '是', reason: '构造的超范围动作', intentQuote: '仅检查构造接口', stepQuote: request.context.newSteps.at(-1)!.text };
  } };
  const view = await detect(f.config, '2026-10-20T10:02:00Z', { judge });
  assert.deepEqual(requests.map(request => request.task), ['drift']); assert.equal(view.records[0]?.status, '疑似跑偏');
  assert.doesNotMatch(JSON.stringify(requests[0]!.context), /BROKEN_MEMBER_ONLY/);
  assert.match(JSON.stringify(requests[0]!.context.newSteps), /HEALTHY_MEMBER_ACTION/);
  assert.equal(view.records[0]?.drift?.sessionId, f.childId);
  const notices = await readOutbox(f.config.dataDir), drift = notices.find(n => n.kind === 'drift')!;
  assert.equal(drift.memberSessionId, f.childId); assert.match(drift.content.returnCommand, /resume family-child$/);
  assert.equal(notices.find(n => n.kind === 'blind')?.memberSessionId, f.parentId);
});

for (const failure of ['source', 'inbox'] as const) {
  test(`乙 返修1 D29：${failure} 整体故障仍阻断整组，不能用健康成员的旧等待缓存覆盖失明`, async t => {
    const f = await memberFaultFixture(t); let calls = 0;
    const judge: Judge = { async judge(request) { calls++; return { answer: request.task === 'waiting' ? '是' : '否', reason: '构造等待' }; } };
    assert.equal((await detect(f.config, f.at, { judge })).records[0]?.status, '在等我');
    const count = calls;
    if (failure === 'source') await rename(f.config.sources.codex!, join(f.root, 'saved-codex'));
    else await put(join(f.config.inboxDir!, 'unreadable.jsonl'), '{"broken":\n');
    const view = await detect(f.config, '2026-10-20T10:07:00Z', { judge });
    assert.equal(view.records[0]?.status, '看不见了');
    assert.ok(view.projection.health.get(failure === 'source' ? 'codex' : 'inbox')?.since);
    if (failure === 'inbox') assert.equal(view.projection.pushMismatches.size, 1, '整体故障与成员错配同时存在');
    assert.equal(calls, count, '整体故障不得新调模型');
    assert.equal((await overview(f.config)).records[0]?.status, '看不见了');
    assert.equal((await rebuild(f.config)).records[0]?.status, '看不见了');
    assert.equal(calls, count);
  });
}

test('乙 返修1：父子成员均错配时只保留各自失明提醒，不调用模型或假冒完成', async t => {
  const f = await memberFaultFixture(t);
  await put(f.inbox, [f.push(f.parentId, f.child), f.push(f.childId, f.parent)]);
  let calls = 0;
  const view = await detect(f.config, f.at, { judge: { async judge() { calls++; throw new Error('不可调用'); } } });
  assert.equal(view.records[0]?.status, '看不见了'); assert.equal(calls, 0);
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => [n.kind, n.memberSessionId]).sort(), [['blind', f.childId], ['blind', f.parentId]].sort());
});

async function collidingEvidenceFixture(t: TestContext, parentDrifts = false) {
  const f = await memberFaultFixture(t, 'child');
  const parentAt = '2026-10-20T10:02:00Z', childAt = '2026-10-20T10:01:00Z';
  await put(f.parent, [codexMeta(f.parentId), codexEvent({ type: 'user_message', message: '仅检查构造接口，不得修改无关模块' }),
    codexEvent({ type: 'function_call', call_id: 'parent-call', name: 'shell', arguments: JSON.stringify({ command: parentDrifts
      ? 'HEALTHY_PARENT_STEP：修改另一个无关模块' : 'HEALTHY_PARENT_STEP：只读检查接口状态' }) }, 'response_item', parentAt)]);
  await put(f.child, [codexMeta(f.childId, f.parentId), codexEvent({ type: 'user_message', message: '构造的子代理任务' }),
    codexEvent({ type: 'function_call', call_id: 'child-call', name: 'shell', arguments: '{"command":"BROKEN_CHILD_STEP：修改无关模块"}' }, 'response_item', childAt)]);
  await put(f.inbox, []);
  const sent: string[] = []; let fail = true;
  const channel = { name: 'local', async send(notice: { id: string }) { sent.push(notice.id); if (fail) throw new Error('构造旧卡渠道失败'); }, async receive() { return '已记下'; } };
  const warm = await detect(f.config, '2026-10-20T10:03:00Z', { channels: [channel], judge: { async judge(request) {
    const step = request.context.newSteps.find(step => step.text.includes('BROKEN_CHILD_STEP'))!;
    return { answer: '是', reason: '旧组级判断实际引用子成员', intentQuote: '仅检查构造接口', stepQuote: step.text };
  } } });
  const groupKey = `drift:codex:${f.parentId}`, groupCheck = warm.projection.modelChecks.get(groupKey)!;
  assert.ok(groupCheck); assert.equal(groupCheck.key, groupKey); assert.equal(groupCheck.sessionId, f.parentId);
  assert.equal(Date.parse(groupCheck.evidenceAt), Date.parse(parentAt), '父成员是最后活动者，旧组级事实时间与新父成员事实相同');
  assert.match(groupCheck.result!.stepQuote!, /BROKEN_CHILD_STEP/);
  const parent = warm.records[0]!.members!.find(member => member.sessionId === f.parentId)!;
  assert.equal(Date.parse(parent.lastActivityAt!), Date.parse(groupCheck.evidenceAt));
  const oldNotice = (await readOutbox(f.config.dataDir)).find(notice => notice.kind === 'drift')!;
  assert.ok(oldNotice); assert.match(oldNotice.snapshot!.lastOutput, /BROKEN_CHILD_STEP/);
  fail = false; sent.length = 0;
  const bytes = await readFile(f.parent, 'utf8');
  await put(f.inbox, [f.push(f.childId, f.parent)]);
  // 留下与实际规则阶段一致的局部故障事实，单独核对 overview/rebuild 的缓存投影路径。
  const push = (await perceive(f.config)).pushes[0]!, observed = event({ kind: 'push_observed', push }, f.at);
  await withStoreLock(f.config.dataDir, () => appendJsonl(join(f.config.dataDir, 'events.jsonl'), [observed,
    event({ kind: 'push_mismatches', mismatches: [{ pushId: observed.id, recordKey: `codex:${f.parentId}`, reason: '构造的子成员推送错配' }] }, f.at)]));
  return { ...f, parentBefore: parent, parentBytes: bytes, groupCheck, oldNotice, sent, channel };
}

test('乙 返修2：相同父成员/事实时间的旧组级子成员跑偏不得进入只读投影或封存后重建', async t => {
  const f = await collidingEvidenceFixture(t);
  const history = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
  const view = await overview(f.config, f.at);
  assert.equal(view.records[0]?.status, '看不见了'); assert.equal(view.records[0]?.drift, undefined);
  assert.deepEqual(view.records[0]?.members?.find(member => member.sessionId === f.parentId), f.parentBefore);
  assert.equal((await rebuild(f.config, f.at)).records[0]?.drift, undefined);
  assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(history));
  await prepare(f.config.dataDir, '2026-10-28T10:06:00Z');
  assert.equal((await overview(f.config, f.at)).records[0]?.status, '看不见了');
  assert.equal((await rebuild(f.config, f.at)).records[0]?.drift, undefined);
  assert.equal(await readFile(f.parent, 'utf8'), f.parentBytes, '父成员记录没有变化');
});

for (const answer of ['否', '是', 'failure'] as const) {
  test(`乙 返修2：执行路径不能命中同身份旧组级结果，健康父成员的新 ${answer} 结论独立缓存`, async t => {
    const f = await collidingEvidenceFixture(t, answer === '是'), requests: JudgmentRequest[] = [];
    const judge: Judge = { async judge(request) {
      requests.push(request);
      if (answer === 'failure' && requests.length === 1) throw new Error('构造的成员判断失败');
      return answer === '是' ? { answer: '是', reason: '仅父成员自身动作', intentQuote: '仅检查构造接口', stepQuote: request.context.newSteps.at(-1)!.text }
        : { answer: '否', reason: '父成员自身没有跑偏' };
    } };
    let view = await detect(f.config, f.at, { judge, channels: [f.channel] });
    assert.equal(requests.length, 1, '必须判断新成员上下文，不能因旧组级成功结果跳过');
    assert.deepEqual(requests.map(request => request.task), ['drift']);
    for (const request of requests) { assert.match(JSON.stringify(request.context.newSteps), /HEALTHY_PARENT_STEP/); assert.doesNotMatch(JSON.stringify(request.context), /BROKEN_CHILD_STEP/); }
    assert.deepEqual(view.records[0]?.members?.find(member => member.sessionId === f.parentId), f.parentBefore);
    assert.equal(await readFile(f.parent, 'utf8'), f.parentBytes);
    assert.equal(view.records[0]?.status, answer === '是' ? '疑似跑偏' : '看不见了');
    if (answer === '是') {
      assert.match(view.records[0]!.drift!.result.stepQuote!, /HEALTHY_PARENT_STEP/);
      assert.doesNotMatch(JSON.stringify(view.records[0]!.drift), /BROKEN_CHILD_STEP/);
    } else assert.equal(view.records[0]?.drift, undefined);
    assert.ok(!f.sent.includes(f.oldNotice.id), '局部故障时不重试引用错误子成员的旧组级卡');
    const memberCheck = view.projection.modelChecks.get(`drift:codex:${f.parentId}:${f.parentId}`)!;
    assert.ok(memberCheck); assert.notEqual(modelEvidenceKey(memberCheck), modelEvidenceKey(f.groupCheck));
    assert.deepEqual(view.projection.modelEvidence.get(modelEvidenceKey(memberCheck)), memberCheck);
    assert.deepEqual(view.projection.modelEvidence.get(modelEvidenceKey(f.groupCheck)), f.groupCheck);
    const localDrift = (await readOutbox(f.config.dataDir)).filter(notice => notice.kind === 'drift' && notice.id !== f.oldNotice.id);
    assert.equal(localDrift.length, answer === '是' ? 1 : 0);
    if (answer === '是') { assert.match(localDrift[0]!.snapshot!.lastOutput, /HEALTHY_PARENT_STEP/); assert.doesNotMatch(JSON.stringify(localDrift[0]!.snapshot), /BROKEN_CHILD_STEP/); }
    if (answer === 'failure') {
      view = await detect(f.config, f.at, { judge, channels: [f.channel] });
      assert.equal(requests.length, 2, '成员失败不能被旧组级成功遮住，下轮仍重试');
      assert.equal(view.records[0]?.drift, undefined);
    }
    const count = requests.length, outbox = await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8');
    assert.deepEqual((await overview(f.config, f.at)).records, view.records);
    assert.deepEqual((await rebuild(f.config, f.at)).records, view.records);
    await prepare(f.config.dataDir, '2026-10-28T10:06:00Z');
    assert.deepEqual((await overview(f.config, f.at)).records, view.records);
    assert.equal((await detect(f.config, f.at, { judge, channels: [f.channel] })).noticesAdded, 0);
    assert.equal(requests.length, count); assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), outbox);
    // 故障消失、重回完整组上下文时，旧组级事实仍在，不能被成员结果覆盖或要求重调。
    await put(f.inbox, []);
    const normal = await detect(f.config, f.at, { judge, channels: [f.channel] });
    assert.equal(normal.projection.pushMismatches.size, 0);
    assert.equal(normal.records[0]?.status, '疑似跑偏'); assert.match(normal.records[0]!.drift!.result.stepQuote!, /BROKEN_CHILD_STEP/);
    assert.equal(requests.length, count, '正常组级既有事实不重调'); assert.equal(normal.noticesAdded, 0, '正常组级旧提醒不重发');
    assert.equal(await readFile(join(f.config.dataDir, 'outbox.jsonl'), 'utf8'), outbox);
  });
}

for (const retainedScope of ['group', 'member'] as const) {
  test(`乙 返修2：旧检查点只剩 ${retainedScope} 证据时在内存重建，两种作用域都保留`, async t => {
    const f = await collidingEvidenceFixture(t); let calls = 0;
    const judge: Judge = { async judge() { calls++; return { answer: '否', reason: '父成员自身正常' }; } };
    await detect(f.config, f.at, { judge, channels: [f.channel] });
    const member = (await overview(f.config, f.at)).projection.modelChecks.get(`drift:codex:${f.parentId}:${f.parentId}`)!;
    assert.ok(member); const count = calls;
    await prepare(f.config.dataDir, '2026-10-28T10:06:00Z');
    const rows = await readEvents(f.config.dataDir), header = rows[0]!;
    if (header.kind !== 'store_checkpoint') throw new Error('缺检查点');
    // 模拟返修前的索引：同一旧身份只留下一个结果，完整判断及按键缓存仍在检查点中。
    const retained = retainedScope === 'group' ? f.groupCheck : member;
    const old = { ...header, state: { ...header.state, modelEvidence: [[modelEvidenceKey(f.groupCheck), retained]] as [string, typeof member][] } };
    await put(join(f.config.dataDir, 'events.jsonl'), [old, ...rows.slice(1)]);
    const current = await overview(f.config, f.at);
    assert.equal(current.records[0]?.drift, undefined);
    assert.deepEqual(current.projection.modelEvidence.get(modelEvidenceKey(member)), member);
    assert.deepEqual(current.projection.modelEvidence.get(modelEvidenceKey(f.groupCheck)), f.groupCheck);
    assert.equal((await detect(f.config, f.at, { judge, channels: [f.channel] })).records[0]?.status, '看不见了');
    assert.equal(calls, count);
    await put(f.inbox, []);
    const normal = await detect(f.config, f.at, { judge, channels: [f.channel] });
    assert.equal(normal.records[0]?.status, '疑似跑偏'); assert.match(normal.records[0]!.drift!.result.stepQuote!, /BROKEN_CHILD_STEP/);
    assert.equal(calls, count, '不读归档也能恢复旧组级已有答案');
  });
}

test('乙 启动衔接：第一笔飞书连接先准备格式，并行收件不会令新库误走旧库备份而检测失败', async t => {
  const f = await fixture(t); f.config.feishu = { mode: 'fake', receiverId: 'ou_synthetic', timeoutMs: 1000 };
  const channel = feishuChannel(f.config);
  await channel.start();
  try {
    const rows = await readEvents(f.config.dataDir);
    assert.equal(rows[0]?.kind, 'store_format');
    assert.equal(rows.at(-1)?.kind, 'feishu_connection');
    const release = await acquireLock(f.config.dataDir, '.feishu-receive.lock');
    try { await detect(f.config, start, { channels: [] }); }
    finally { await release(); }
    assert.equal((await readdir(f.root)).filter(name => name.startsWith('backup-before-')).length, 0);
  } finally { await channel.stop(); }
});

test('乙 D29：目录真读不了仍判整个来源看不见，另一个工具不受影响', async t => {
  const f = await fixture(t); f.config.sources.codex = join(f.root, 'missing-source');
  const view = await detect(f.config, start);
  assert.ok(view.projection.health.get('codex')?.since);
  assert.equal(view.records[0]?.tool, 'cc'); assert.equal(view.records[0]?.status, '进行中');
  assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => [n.kind, n.tool]), [['blind', 'codex']]);
});
