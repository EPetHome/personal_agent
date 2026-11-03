import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { piJudge, snapshotPrompt } from '../src/core/model.ts';
import { validateConfig } from '../src/core/config.ts';
import { ccUser, ccCall, ccAnswer, sandbox, unmanaged } from './fixtures.ts';
for (const mode of ['waiting', 'drift', 'permission', 'finished']) test(`旧聊天判断已删除：${mode}不发卡且不调用判断器`, async t => {
  const answer = ccAnswer(); answer.message.content[0]!.text = '需要选择方案？';
  await unmanaged(t, 'cc', [ccUser(), mode === 'drift' ? ccCall(undefined, 'b', '修改不相关 B') : answer],
    { pushes: mode === 'permission' ? [{ tool: 'cc', event: 'waiting_permission', session_id: 'demo-cc', cwd: '/sample/project', transcript_path: '/constructed', at: '2026-10-20T10:00:00Z' }] : [] });
});
test('保留 loop 快照起草器：真实子进程边界用替身，固定无工具参数和四项输入', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const log = join(f.root, 'args.jsonl'), model = join(f.root, 'snapshot-answer.json'), executable = join(import.meta.dirname, 'pi-stub.ts');
  const result = { situation: '测试批次已完成', action: '查看剩余人工项', actionType: '去看一眼' };
  // 复用已有Pi替身与产品默认调用预算：本条验真实argv/stdin/JSON，不另加并发启动性能标准。
  // 2000ms硬超时另用真实挂起进程单独验证；不改产品默认值或门禁并发度。
  await writeFile(model, JSON.stringify({ answer: result, capture: log }));
  const config = await validateConfig({ ...f.config, judge: { executable, model } });
  assert.equal(config.judge!.timeoutMs, 30000);
  const input = { goal: '构造批次', currentTask: null, lastOutput: '完成', factualStatus: 'loop 完成' as const };
  const began = performance.now();
  let snapshot;
  try { snapshot = await piJudge(config.judge!).writeSnapshot!(input); }
  catch (error) {
    const captured = await readFile(log, 'utf8').then(value => JSON.parse(value.trim())).catch(() => null);
    t.diagnostic(JSON.stringify({ fixture: 'snapshot-process', elapsedMs: Math.round(performance.now() - began), captured: !!captured,
      stdinMatches: captured?.prompt === snapshotPrompt(input) }));
    throw error;
  }
  assert.equal(snapshot.situation, result.situation);
  const captured = (await readFile(log, 'utf8')).trim().split('\n'); assert.equal(captured.length, 1);
  const row = JSON.parse(captured[0]!);
  for (const arg of ['--no-tools', '--no-session', '--no-extensions', '--no-context-files', '--no-skills', '--no-approve', '--offline']) assert.ok(row.args.includes(arg));
  assert.equal(row.prompt, snapshotPrompt(input)); assert.equal(row.args.includes('--dangerously-skip-permissions'), false);
});
test('快照起草器真实执行超时：仍按2000ms终止挂起进程，不把超时当成功', async t => {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const executable = join(import.meta.dirname, 'pi-stub.ts'), model = join(f.root, 'hanging-answer.json'), log = join(f.root, 'pid.jsonl');
  await writeFile(model, JSON.stringify({ delayMs: 10000, capture: log }));
  const original = childProcess.execFile; let pid: number | undefined;
  // 只记录真实子进程PID，透传所有参数/回调，不替换执行结果；启动排队也仍受2000ms限制。
  const tracked = t.mock.method(childProcess, 'execFile', (...args: Parameters<typeof original>) => {
    const child = Reflect.apply(original, childProcess, args) as ReturnType<typeof original>; pid = child.pid; return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(piJudge({ executable, model, timeoutMs: 2000 }).writeSnapshot!({
      goal: '构造超时', currentTask: null, lastOutput: '未交回', factualStatus: 'loop 完成',
    }), { category: 'timeout' });
    assert.equal(tracked.mock.callCount(), 1, '超时不能靠重试凑成功');
    const options = tracked.mock.calls[0]!.arguments[2] as { timeout?: number; killSignal?: string };
    assert.equal(options.timeout, 2000); assert.equal(options.killSignal, 'SIGKILL');
    const childPid = pid;
    assert.ok(typeof childPid === 'number' && childPid > 0 && Number.isSafeInteger(childPid));
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally { tracked.mock.restore(); syncBuiltinESMExports(); }
});
