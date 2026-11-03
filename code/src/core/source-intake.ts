import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { readLedger, updateLedger } from './ledger.ts';
import { recoverDeadLock, withNamedLock } from './locks.ts';
import { taskSandbox } from './task-adapter.ts';
import { hash, object } from './utils.ts';
import { decodeJson } from './protocol-json.ts';
import { feishuScheduleReader, ScheduleAuthorizationMissing } from '../channels/feishu/schedule.ts';
import type { ScheduleReader, MinuteMaterial } from '../channels/feishu/schedule.ts';
import type { Config } from './types.ts';
import type { CalendarMeeting, SourceMaterial } from './managed-types.ts';

async function health(config: Config, id: string, at: string, ok: boolean, detail?: string) {
  await updateLedger(config.dataDir, at, (state, add) => {
    const reason = ok ? '来源已恢复' : detail ?? '配置的收件箱/日历/妙记读取失败；保留已读事实，请检查路径、权限、网络或用户授权（不保存上游报文）';
    const old = state.tables.health[id]; if (old?.ok === ok && old.reason === reason || !old && ok) return;
    add({ kind: 'put', table: 'health', value: { id, at, ok, kind: 'source', episode: ok ? '' : `${id}:${state.seq + 1}`, reason } });
  });
}
function media(path: string): SourceMaterial['media'] {
  const extension = extname(path).toLowerCase();
  return /\.(?:wav|mp3|m4a|aac|flac|ogg)$/.test(extension) ? 'audio' : /\.(?:mp4|mov|webm|mkv)$/.test(extension) ? 'video'
    : /\.(?:png|jpe?g|gif|webp)$/.test(extension) ? 'image' : /\.(?:md|txt|csv|json|log|srt|vtt)$/.test(extension) ? 'text' : 'file';
}
async function workspaceIntake(config: Config, at: string) {
  const source = config.workspace; if (!source) return;
  const box = await taskSandbox(config, source.inboxDir, at);
  await box.authorize(source.inboxDir, true);
  const known = await readLedger(config.dataDir);
  for (const entry of await readdir(source.inboxDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const path = join(source.inboxDir, entry.name), stat = await lstat(path);
    const id = `material:workspace:${hash(JSON.stringify([path, stat.dev, stat.ino, stat.birthtimeMs])).slice(0, 32)}`;
    if (known.tables.materials[id] || Date.now() - stat.mtimeMs < source.settleMs) continue;
    try { await box.authorize(path); } catch { continue; } // 原读取围栏拒绝的东西不成为材料。
    const kind = media(path); let text = '';
    if (kind === 'text') { try { text = (await box.text(path, 1, 300, 32768)).text; } catch { continue; } }
    const after = await lstat(path);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1) continue;
    const file = { root: source.inboxDir, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs };
    const material: SourceMaterial = { id, source: 'workspace', ref: path, at, title: basename(path), text, media: kind, file, fingerprint: hash(JSON.stringify([file, text])) };
    await updateLedger(config.dataDir, at, (state, add) => { if (!state.tables.materials[id]) add({ kind: 'put', table: 'materials', value: material }); });
  }
}
async function fakeReader(config: Config, at: string): Promise<ScheduleReader> {
  const path = config.schedule!.fakeFile!, box = await taskSandbox(config, dirname(path), at);
  const page = await box.text(path, 1, 1000, 524288);
  if (!page.eof) throw new Error('假日程超过读取上限');
  const raw = object(decodeJson(page.text), '假日程快照');
  if (!Array.isArray(raw.meetings ?? []) || !Array.isArray(raw.minutes ?? [])) throw new Error('假日程格式不合法');
  return { async calendar(calendarId) {
    return (raw.meetings ?? []).filter((row: any) => row?.calendarId === calendarId && row.cancelled !== true && row.busy !== false).map((row: any) => {
      if (typeof row.id !== 'string' || !Number.isFinite(Date.parse(row.start)) || !Number.isFinite(Date.parse(row.end)) || Date.parse(row.end) <= Date.parse(row.start)) throw new Error('假会议时间不合法');
      return { id: row.id, calendarId, title: typeof row.title === 'string' ? row.title.slice(0, 500) : '构造会议', start: new Date(row.start).toISOString(), end: new Date(row.end).toISOString() };
    });
  }, async discoverMinutes(ownerIds) {
    return (raw.minutes ?? []).filter((row: any) => row && ownerIds.includes(row.ownerId) && typeof row.id === 'string').map((row: any) => row.id).slice(0, 1000);
  }, async minute(token) {
    const row = (raw.minutes ?? []).find((row: any) => row?.id === token);
    if (!row) throw new Error('没找到配置的假妙记');
    if (typeof row.text !== 'string' || row.text.length > 32768 || row.todos !== undefined && (!Array.isArray(row.todos) || row.todos.some((todo: unknown) => typeof todo !== 'string' || todo.length > 4000))) throw new Error('假妙记格式不合法');
    return { id: token, title: typeof row.title === 'string' ? row.title.slice(0, 500) : '构造会议纪要', text: row.text, ...(row.todos ? { todos: row.todos.slice(0, 20) } : {}) };
  } };
}
async function saveMinute(config: Config, minute: MinuteMaterial, at: string) {
  if (!minute.text.trim() && !minute.todos?.length) return; // 转写尚未完成，后续继续读。
  const fingerprint = hash(JSON.stringify([minute.text, minute.todos])), id = `material:minutes:${hash(JSON.stringify([minute.id, fingerprint])).slice(0, 32)}`;
  await updateLedger(config.dataDir, at, (state, add) => {
    if (state.tables.materials[id]) return;
    add({ kind: 'put', table: 'materials', value: { id, source: 'minutes', ref: minute.id, at, title: minute.title, media: 'text', text: minute.text, fingerprint, ...(minute.todos ? { todos: minute.todos } : {}) } });
  });
}
/** 只有intake碰目录/官方SDK；各来源失败隔离，未配置的来源既不读也不落账。 */
export async function intakeConfiguredSources(config: Config, at: string, injected?: ScheduleReader) {
  const schedule = config.schedule;
  if (!config.workspace && !schedule?.calendarIds.length && !schedule?.minuteTokens.length && !schedule?.minuteOwnerIds?.length) return;
  await recoverDeadLock(config.dataDir, '.source-intake.lock');
  await withNamedLock(config.dataDir, '.source-intake.lock', async () => {
    const state = await readLedger(config.dataDir);
    const due = (id: string, interval: number) => !state.tables.receipts[id] || Date.parse(at) - Date.parse(state.tables.receipts[id]!.at) >= interval;
    const polled = (id: string) => updateLedger(config.dataDir, at, (_state, add) => add({ kind: 'put', table: 'receipts', value: { id, at, response: '只读接入轮询已尝试' } }));
    if (config.workspace && due('poll:workspace', config.workspace.pollEveryMs)) {
      await polled('poll:workspace');
      try { await workspaceIntake(config, at); await health(config, 'source:workspace', at, true); }
      catch { await health(config, 'source:workspace', at, false); }
    }
    if (!schedule || !schedule.calendarIds.length && !schedule.minuteTokens.length && !schedule.minuteOwnerIds?.length || !due('poll:schedule', schedule.pollEveryMs)) return;
    await polled('poll:schedule');
    let reader: ScheduleReader;
    try { reader = injected ?? (schedule.mode === 'fake' ? await fakeReader(config, at) : await feishuScheduleReader(config)); }
    catch (error) { await health(config, 'source:schedule', at, false, error instanceof ScheduleAuthorizationMissing ? error.message : undefined); return; }
    await health(config, 'source:schedule', at, true);
    const from = new Date(Date.parse(at) - 86400000).toISOString(), to = new Date(Date.parse(at) + 7 * 86400000).toISOString();
    for (const calendarId of schedule.calendarIds) {
      const id = `source:calendar:${hash(calendarId).slice(0, 16)}`;
      try {
        const meetings: CalendarMeeting[] = await reader.calendar(calendarId, from, to);
        if (meetings.some(row => row.calendarId !== calendarId || !Number.isFinite(Date.parse(row.start)) || !Number.isFinite(Date.parse(row.end)) || Date.parse(row.end) <= Date.parse(row.start))) throw new Error('日程格式错误');
        await updateLedger(config.dataDir, at, (_state, add) => add({ kind: 'put', table: 'calendars', value: { id: `calendar:${calendarId}`, calendarId, at, from, to, meetings } }));
        await health(config, id, at, true);
      } catch { await health(config, id, at, false); } // 不以失败清空先前已知的会。
    }
    const tokens = new Set(schedule.minuteTokens);
    if (schedule.minuteOwnerIds?.length) {
      try {
        if (!reader.discoverMinutes) throw new Error('接入器没有妙记发现接口');
        const discovered = await reader.discoverMinutes(schedule.minuteOwnerIds, new Date(Date.parse(at) - 7 * 86400000).toISOString(), at);
        if (discovered.length > 1000 || discovered.some(token => typeof token !== 'string' || !/^[A-Za-z0-9_.@-]{1,256}$/.test(token))) throw new Error('妙记发现格式/数量不合法');
        for (const token of discovered) tokens.add(token);
        await health(config, 'source:minute-discovery', at, true);
      } catch { await health(config, 'source:minute-discovery', at, false); }
    }
    for (const token of tokens) {
      const id = `source:minute:${hash(token).slice(0, 16)}`;
      try { const minute = await reader.minute(token); if (minute.id !== token) throw new Error('妙记身份错误'); await saveMinute(config, minute, at); await health(config, id, at, true); }
      catch { await health(config, id, at, false); }
    }
  }, 30000);
}
/** 派出前重新核实同一份原件；材料中的路径/指令永远不能改变读取范围。 */
export async function verifyMaterialFile(config: Config, material: SourceMaterial, at: string) {
  if (material.source !== 'workspace' || !material.file || config.workspace?.inboxDir !== material.file.root || dirname(material.ref) !== material.file.root) throw new Error('材料不属于当前指定收件箱');
  const box = await taskSandbox(config, material.file.root, at); await box.authorize(material.ref);
  const stat = await lstat(material.ref), file = material.file;
  if (stat.dev !== file.dev || stat.ino !== file.ino || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs || stat.birthtimeMs !== file.birthtimeMs) throw new Error('原件已经变化，请重新核对；未派出');
}
