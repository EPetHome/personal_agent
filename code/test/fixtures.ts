// 全部内容为测试编造。实际来源文件只写到系统临时目录，不访问真实工具目录。
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config, PushRecord } from '../src/core/types.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { detect, overview, rebuild } from '../src/core/agent.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';

export const start = '2026-10-20T10:00:00.000Z';
export const later = '2026-10-20T10:31:00.000Z';
// 保留旧调用参数的位置便于回放样例；聊天等待设置已删除，不进入有效配置。
export async function sandbox(_legacyWaiting?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-test-'));
  const config: Config = {
    dataDir: join(root, 'data'), sources: { cc: join(root, 'cc'), codex: null, pi: null, loop: null },
    inboxDir: join(root, 'inbox'), commands: { cc: 'claude' },
  };
  await mkdir(config.sources.cc!);
  await mkdir(config.inboxDir!);
  return { root, config };
}
// 普通样例项目与门禁证据目录分开：Loop的TMPDIR可能位于.pi-autoreview，
// 那里作为会话cwd应被产品正确过滤。此处只建新的POSIX系统临时项目，调用方负责清理。
export async function ordinaryProject(): Promise<string> {
  return realpath(await mkdtemp('/tmp/personal-agent-sample-project-'));
}
export async function put(path: string, content: string | unknown[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : content.map(row => JSON.stringify(row)).join('\n') + '\n');
}
export function ccUser(text = '只修改测试用的 A 文件', at = start, origin = 'human') {
  return { type: 'user', sessionId: 'demo-cc', cwd: '/sample/project', timestamp: at, origin: { kind: origin }, message: { role: 'user', content: text } };
}
export function ccCall(at = start, id = 'tool-1', command = 'npm test') {
  return { type: 'assistant', sessionId: 'demo-cc', cwd: '/sample/project', timestamp: at, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } };
}
export function ccAnswer(at = start) {
  return { type: 'assistant', sessionId: 'demo-cc', cwd: '/sample/project', timestamp: at, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '已完成测试任务' }] } };
}
export function pushed(transcript: string, event = 'waiting_permission', at = '2026-10-20T10:00:01Z') {
  return { tool: 'cc', event, session_id: 'demo-cc', cwd: '/sample/project', transcript_path: transcript, at, detail: '允许执行 npm test 吗' };
}
export function piHeader() { return { type: 'session', version: 3, id: 'demo-pi', cwd: '/sample/pi', timestamp: start }; }
export function piMessage(id: string, parentId: string | null, role: string, content: unknown, at = start, extra = {}) {
  return { type: 'message', id, parentId, timestamp: at, message: { role, content, ...(role === 'assistant' ? { stopReason: 'stop' } : {}), ...extra } };
}
export function codexMeta(id = 'demo-codex', parent?: string) {
  return { timestamp: start, type: 'session_meta', payload: { id, cwd: '/sample/codex', timestamp: start, ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}) } };
}
export function codexEvent(payload: Record<string, unknown>, type = 'event_msg', at = start) { return { timestamp: at, type, payload }; }
/** 被删除的聊天检测共用负向契约；各回归仍传自己的构造会话和钩子。 */
export async function unmanaged(t: TestContext, tool: PushRecord['tool'], rows: unknown[] | string, options: { pushes?: unknown[] | string; now?: string } = {}) {
  const f = await sandbox(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const root = join(f.root, tool); f.config.sources[tool] = root;
  f.config.feishu = { mode: 'fake', receiverId: 'ou_constructed', timeoutMs: 1000 };
  f.config.judge = { executable: '/constructed/must-not-run', model: 'fake', timeoutMs: 100 };
  const path = join(root, 'session.jsonl'); await put(path, rows); const before = await readFile(path);
  const inbox = join(f.config.inboxDir!, `${tool}.jsonl`);
  if (options.pushes !== undefined) await put(inbox, options.pushes);
  let calls = 0;
  const components = { judge: { async judge() { calls++; throw new Error('不再分析聊天'); }, async writeSnapshot() { calls++; throw new Error('不再为聊天起草'); } } };
  for (const now of [start, options.now ?? later, '2026-10-21T12:00:00Z']) {
    const view = await detect(f.config, now, components); assert.deepEqual(view.records, []); assert.equal(view.projection.health.size, 0);
  }
  assert.deepEqual((await overview(f.config)).records, []); await rebuild(f.config);
  assert.equal(calls, 0); assert.deepEqual(await readOutbox(f.config.dataDir), []);
  const events = await readEvents(f.config.dataDir);
  assert.equal(events.some(e => e.kind === 'model_call_started' || e.kind.startsWith('analysis_') || e.kind.startsWith('push_') || e.kind.startsWith('shadow_') || e.kind === 'session_delta'), false);
  assert.deepEqual(await readFile(path), before);
  return { ...f, path, inbox, events };
}
export async function putLoop(config: Config, root: string, status = '暂停', at = '2026-10-20T09:55:00Z', id = '11111111-1111-4111-8111-111111111111') {
  config.sources.loop ??= join(root, 'loop');
  const path = join(config.sources.loop, 'project', `${id}.md`);
  await put(path, loopSummary(status, '/sample/project', '- 构造人工项', at).replace('- 状态：', `- 暂停时间：${at}\n- 状态：`).replace('loop-demo', id));
  return path;
}
/** 新常驻/CLI构造入口；旧总结样本仅供历史解析与兼容测试。 */
export async function putManagedLoop(config: Config, root: string, state: 'started' | 'paused' | 'completed' = 'paused', at = start) {
  config.inboxDir ??= join(root, 'managed-inbox');
  const path = join(config.inboxDir, 'loop', '构造服务批次.jsonl');
  await put(path, [{ schema: 1, id: `managed-${state}`, seq: 1, at, project: root, batch: '构造服务批次', stage: '甲', state,
    reason: { category: 'unknown', text: state }, evidence: [], detail: state === 'completed' ? { branch: 'feat/fake', commit: 'deadbeef' } : {} }]);
  return path;
}
export function loopSummary(status = '完成', project = '/sample/real-project', needs = '- A2 需人工确认文案', at = start) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `# 自动评审总结\n- 项目：${project}\n- 开发会话：loop-demo\n- 状态：${status}\n- 评审 3 次，返修 2 次\n## 需要你做的事\n${needs}\n## 各轮\n### 第 1 轮（${local}，耗时 120 秒）\n- 无\n`;
}
