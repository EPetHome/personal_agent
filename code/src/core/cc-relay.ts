import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertRegularFile, isIgnoredProject } from './config.ts';
import { ComponentFailure, runCommand } from './process.ts';
import { contentText } from './utils.ts';
import type { Config, Notice } from './types.ts';

export interface RelayTarget { sessionId: string; path: string; cwd: string; cursor: string }
export interface Transcript extends RelayTarget { idle: boolean; lastUser: string }
export class RelayFailure extends Error {}
function fail(reason: string): never { throw new RelayFailure(reason); }

/** 只走显式 CC 来源里的普通文件；不沿会话里的路径、符号链接或卡片回看命令读取。 */
async function sourceFile(root: string, path: string): Promise<void> {
  const diff = relative(root, path);
  if (!diff || diff === '..' || diff.startsWith('../') || isAbsolute(diff) || !path.endsWith('.jsonl')) fail('会话文件不在配置的 CC 来源内');
  let current = resolve(root);
  for (const part of ['', ...diff.split('/').slice(0, -1)]) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('会话目录不是可信普通目录');
  }
  await assertRegularFile(path);
}
/** 异步逐行读完整文件。只保留末段信号与原始行指纹，不把整份会话复制进转达日志。 */
export async function readRelayTranscript(config: Config, path: string): Promise<Transcript> {
  if (!config.sources.cc) fail('CC 来源未开启');
  try {
    await sourceFile(config.sources.cc, path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1) fail('会话文件不可信，不能确认闲着');
      let sessionId = '', cwd = '', lastUser = '', finished = false, ended = false, sawDialogue = false;
      let last = '', finalDialogue = '', endRecord = '', recordCount = 0;
      const pending = new Set<string>();
      for await (const line of file.readLines({ autoClose: false })) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (!row || typeof row !== 'object' || Array.isArray(row)) fail('会话记录格式无法识别');
        if (row.isSidechain === true) fail('侧链会话暂不支持转达');
        if (row.sessionId && sessionId && row.sessionId !== sessionId) fail('会话文件里有不同的会话号');
        last = line; recordCount++;
        if (row.type === 'user' || row.type === 'assistant') {
          if (typeof row.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(row.sessionId) || typeof row.cwd !== 'string' || !isAbsolute(row.cwd)
            || row.message?.role !== row.type) fail('会话身份或工作目录无法识别');
          sessionId ||= row.sessionId; cwd ||= row.cwd; sawDialogue = true;
          finalDialogue = line; endRecord = ''; ended = false;
          const message = row.message, blocks = Array.isArray(message.content) ? message.content : [];
          if (row.type === 'user') {
            for (const block of blocks) if (block?.type === 'tool_result') pending.delete(block.tool_use_id);
            if (typeof message.content === 'string' || blocks.some((b: any) => b?.type === 'text')) lastUser = contentText(message.content);
            finished = false;
          } else {
            for (const block of blocks) if (block?.type === 'tool_use') pending.add(block.id);
            finished = message.stop_reason === 'end_turn' && !blocks.some((b: any) => b?.type === 'tool_use');
          }
        } else if (row.type === 'system' && ['stop_hook_summary', 'turn_duration'].includes(row.subtype)) {
          endRecord = line;
        } else if (row.type === 'session_end' || row.subtype === 'session_end') ended = true;
      }
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('读取时会话正在变化，不能确认闲着');
      // 文件半行即使恰好是合法 JSON，也不能当成已提交的回合结束。
      const tail = Buffer.alloc(1);
      if (!after.size || (await file.read(tail, 0, 1, after.size - 1)).bytesRead !== 1 || tail[0] !== 10) fail('会话末行尚未完整写入');
      if (!sawDialogue || !sessionId || !cwd || isIgnoredProject(cwd, config)) fail('会话身份无法确认或已被忽略');
      const cursor = createHash('sha256').update(`${recordCount}\n${finalDialogue}\n${last}`).digest('hex');
      return { sessionId, cwd, path, cursor, lastUser, idle: finished && !pending.size && !ended && !!endRecord && last === endRecord };
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof RelayFailure) throw error;
    fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? '会话文件已经不在了' : '会话文件读不到、未写完或格式无法识别');
  }
}
/** 仅显式「转给 CC」时查找；不由常驻感知调用，不会退到更旧的闲会话。 */
export async function latestRelayTarget(config: Config): Promise<RelayTarget> {
  if (!config.relay?.enabled || !config.sources.cc) fail('转达总开关已关闭或未配置 CC 来源');
  const root = config.sources.cc, files: { path: string; mtime: number }[] = [];
  try {
    const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CC 来源不可信');
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (files.length >= 2000) fail('CC 会话目录过大，无法可靠定位最近会话');
      const path = join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ path, mtime: (await lstat(path)).mtimeMs });
      else if (entry.isDirectory()) for (const child of await readdir(path, { withFileTypes: true })) {
        if (files.length >= 2000) fail('CC 会话目录过大，无法可靠定位最近会话');
        if (child.isFile() && child.name.endsWith('.jsonl')) {
          const file = join(path, child.name); files.push({ path: file, mtime: (await lstat(file)).mtimeMs });
        }
      }
    }
    const latest = files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))[0];
    if (!latest) fail('没找到最近的 CC 会话');
    const { sessionId, path, cwd, cursor } = await readRelayTranscript(config, latest.path);
    return { sessionId, path, cwd, cursor };
  } catch (error) { if (error instanceof RelayFailure) throw error; fail('CC 会话目录无法安全读取'); }
}
export async function relayTarget(config: Config, notice: Notice): Promise<RelayTarget> {
  if (notice.tool !== 'cc' || notice.kind !== 'waiting') fail('只支持 CC 的「在等你」卡片');
  const id = notice.memberSessionId ?? (notice.sessionKey?.startsWith('cc:') ? notice.sessionKey.slice(3) : undefined);
  if (!id) fail('卡片未绑定具体 CC 会话，请查看新卡片');
  const matches: Transcript[] = [];
  for (const path of new Set(notice.content.evidence.originals.map(o => o.path))) {
    const transcript = await readRelayTranscript(config, path);
    if (transcript.sessionId === id) matches.push(transcript);
  }
  if (matches.length !== 1 || matches[0]!.cwd !== notice.content.evidence.project) fail('卡片与会话或工作目录对不上');
  const { sessionId, path, cwd, cursor } = matches[0]!;
  return { sessionId, path, cwd, cursor };
}
/** CC 内部登记没有公开协议。只认两种明确的会话号字段；未知/坏文件一律阻止转达。 */
async function assertRegisteredIdle(config: Config, sessionId: string): Promise<void> {
  const root = config.relay?.ccSessionsDir;
  if (!root) fail('未配置 CC 在跑登记目录，不能确认闲着');
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('在跑登记目录不可信，不能确认闲着');
    let live = 0;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      if (!/^[1-9]\d*\.json$/.test(entry.name) || !entry.isFile()) fail('在跑登记格式无法识别，不能确认闲着');
      const path = join(root, entry.name); await assertRegularFile(path);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let row: any;
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) fail('在跑登记文件不可信');
        row = JSON.parse(await file.readFile('utf8'));
        const after = await file.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('在跑登记正在变化，不能确认闲着');
      } finally { await file.close(); }
      const id = row?.sessionId ?? row?.session_id;
      if (typeof id !== 'string' || !id || (row.sessionId && row.session_id && row.sessionId !== row.session_id)) fail('在跑登记会话号无法识别');
      if (id !== sessionId) continue;
      const pid = Number(entry.name.slice(0, -5));
      if (!Number.isSafeInteger(pid) || (row.pid !== undefined && row.pid !== pid)) fail('在跑登记进程号无法识别');
      try { process.kill(pid, 0); } catch { fail('会话登记的进程已退出或无法核实，不能确认闲着'); }
      live++;
      if (row.status !== 'idle') fail(row.status === 'busy' ? '在跑登记显示会话正忙，不送' : '在跑登记状态读不懂，不能确认闲着');
    }
    if (live !== 1) fail(live ? '有多个进程打开同一会话，不能安全续话' : '没有这个会话的在跑登记，不能确认闲着');
  } catch (error) {
    if (error instanceof RelayFailure) throw error;
    fail('CC 在跑登记读不到或读不懂，不能确认闲着');
  }
}
export async function assertRelayIdle(config: Config, target: RelayTarget): Promise<Transcript> {
  if (!config.relay?.enabled) fail('转达总开关已关闭');
  await assertRegisteredIdle(config, target.sessionId);
  const transcript = await readRelayTranscript(config, target.path);
  if (transcript.sessionId !== target.sessionId || transcript.cwd !== target.cwd) fail('会话身份或工作目录变了，不送');
  if (!transcript.idle) fail('会话文件没有「AI 回完 + 回合结束」证据，不能确认闲着');
  // 文件检查期间登记也可能已切为 busy。
  await assertRegisteredIdle(config, target.sessionId);
  return transcript;
}
export function relayFailureReason(error: unknown): string {
  if (error instanceof RelayFailure) return error.message;
  if (error instanceof ComponentFailure) return `${error.message}；可能已写入，请回电脑核对，不会自动重发`;
  return '转达未完成，送达情况无法确认；请回电脑核对，不会自动重发';
}
export async function resumeCC(config: Config, target: RelayTarget, text: string, signal: AbortSignal): Promise<{ reply: string; denied: string[] }> {
  // 原话走 stdin，不拼 shell、不解析为参数；不指定模型、不改变 permission mode。
  const output = await runCommand(config.commands.cc, ['--resume', target.sessionId, '-p', '--output-format', 'json'],
    config.relay?.timeoutMs ?? 600000, text, signal, target.cwd);
  let result: any;
  try { result = JSON.parse(output); } catch { fail('续话返回格式无法识别，可能已写入；不会自动重发，请回电脑核对'); }
  if (result?.type !== 'result' || result.session_id !== target.sessionId || typeof result.result !== 'string'
    || !Array.isArray(result.permission_denials) || (result.is_error === true && !result.permission_denials.length)) fail('续话未正常完成或返回会话号不符；不会自动重发，请回电脑核对');
  const after = await readRelayTranscript(config, target.path);
  if (after.sessionId !== target.sessionId || after.cursor === target.cursor || after.lastUser !== text)
    fail('续话返回了，但原会话中的原话未能核实；不会自动重发，请回电脑核对');
  // 不保存 tool_input（可能带密钥/凭证），只记录受限的工具名。
  const denied = result.permission_denials.map((d: any) => typeof d?.tool_name === 'string' && /^[\w.-]{1,60}$/.test(d.tool_name) ? d.tool_name : '操作');
  return { reply: result.result, denied };
}
