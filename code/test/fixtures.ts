// 全部内容为测试编造。实际来源文件只写到系统临时目录，不访问真实工具目录。
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from '../src/core/types.ts';

export const start = '2026-10-20T10:00:00.000Z';
export const later = '2026-10-20T10:31:00.000Z';
// 旧回归主要检查版式、存储、渠道等，显式固定原来的5分钟测试时钟；产品默认值由
// waiting-presence.test.ts 用 sandbox(null) 单独验，不把真实20/25分钟默认值改成测试值。
export async function sandbox(waiting: Config['waiting'] | null = { awayMinutes: 5, otherSessionMinutes: 5 }) {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-test-'));
  const config: Config = {
    dataDir: join(root, 'data'), sources: { cc: join(root, 'cc'), codex: null, pi: null, loop: null },
    inboxDir: join(root, 'inbox'), commands: { cc: 'claude', codex: '/sample tools/codex', pi: 'pi' },
    ...(waiting ? { waiting } : {}),
    // 旧回归只测原判断/版式/渠道；工具分析由 intelligence.test.ts 显式开启并注入替身。
    intelligence: { enabled: false },
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
export function loopSummary(status = '完成', project = '/sample/real-project', needs = '- A2 需人工确认文案', at = start) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `# 自动评审总结\n- 项目：${project}\n- 开发会话：loop-demo\n- 状态：${status}\n- 评审 3 次，返修 2 次\n## 需要你做的事\n${needs}\n## 各轮\n### 第 1 轮（${local}，耗时 120 秒）\n- 无\n`;
}
