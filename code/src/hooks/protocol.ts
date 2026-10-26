import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type HookTool = 'cc' | 'codex' | 'pi';
export interface HookPayload {
  hook_event_name?: string;
  notification_type?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  at?: string;
  detail?: string;
  message?: string;
  last_assistant_message?: string;
}
/** 通知专用：只读取事件参数，只向显式目录追加，不读会话、不连网。所有错误吞掉。 */
export function emitPush(tool: HookTool, payload: HookPayload, inboxDir: string): void {
  let fd: number | undefined;
  try {
    const name = payload.hook_event_name;
    const event = ((tool === 'cc' && name === 'Notification' && payload.notification_type === 'permission_prompt')
      || (tool === 'codex' && name === 'PermissionRequest') || (tool === 'pi' && name === 'permissions:ui_prompt')) ? 'waiting_permission'
      : name === 'Stop' || (tool === 'pi' && name === 'agent_settled') ? 'turn_end'
      : name === 'SessionEnd' || (tool === 'pi' && name === 'session_shutdown') ? 'session_end' : null;
    if (!event || !isAbsolute(inboxDir) || typeof payload.session_id !== 'string' || !payload.session_id.trim()
      || typeof payload.cwd !== 'string' || typeof payload.transcript_path !== 'string') return;
    if (!isAbsolute(payload.cwd) || !isAbsolute(payload.transcript_path)) return;
    const at = typeof payload.at === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(payload.at) && Number.isFinite(Date.parse(payload.at))
      ? new Date(payload.at).toISOString() : new Date().toISOString();
    const detail = event === 'turn_end' ? payload.last_assistant_message ?? payload.detail ?? '' : payload.detail ?? payload.message ?? '';
    const row = { tool, event, session_id: payload.session_id, cwd: payload.cwd, transcript_path: payload.transcript_path, at,
      detail: typeof detail === 'string' ? [...detail].slice(0, 4000).join('') : '' };
    mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(inboxDir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || !(dir.mode & 0o222)) return;
    const path = join(inboxDir, `${tool}.jsonl`);
    try {
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) return;
    writeSync(fd, JSON.stringify(row) + '\n');
  } catch { /* 中枢/目录不可用不能影响宿主工具。 */ }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}
