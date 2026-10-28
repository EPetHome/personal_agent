import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { cc } from '../sources/cc/index.ts';
import { codex } from '../sources/codex/index.ts';
import { pi } from '../sources/pi/index.ts';
import { isLoopSummary, loop } from '../sources/loop/index.ts';
import { isIgnoredProject } from './config.ts';
import { coreUnavailable, unreadable } from './health.ts';
import { isIgnoredMember, isInternalSession } from './sessions.ts';
import { SourceReader } from './source-reader.ts';
import { errorMessage, hash, iso, object, requiredString } from './utils.ts';
import type { Config, EventPayload, FailedSessionIdentity, HealthReport, HealthSource, Original, PushRecord, SessionIdentity, SessionRecord, SourceComponent, Tool } from './types.ts';

const components: SourceComponent[] = [cc, codex, pi, loop];
const loopInfrastructure = new Set(['resources', 'projects', 'pipelines']);
export interface Perception {
  records: SessionRecord[];
  pushes: PushRecord[];
  health: HealthReport[];
  cursors: EventPayload[];
  failedSessions: FailedSessionIdentity[];
  /** 本轮读取/归并失败的原件或目录，供推送保守隔离；只在内存中使用。 */
  failedPaths: Set<string>;
  /** 已列到但尚无会话内容的文件，与真正解析失败分开，推送对账有界等待。 */
  unwrittenPaths: Set<string>;
  /** 完整读取且校验成功、没有核心消息的非会话文件；不能用通用跳过集合代替。 */
  emptyPaths: Set<string>;
  presentPaths: Set<string>;
  seenSessions: { tool: Tool; sessionId: string }[];
}
function permissionDenied(error: unknown): boolean {
  return ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
}
async function walk(path: string, extension: string, health: HealthReport, depth = 0, loopOnly = false, failedPaths?: Set<string>, presentPaths?: Set<string>): Promise<string[]> {
  try {
    const stat = await lstat(path);
    presentPaths?.add(`${health.source}:${path}`);
    if (stat.isSymbolicLink()) {
      if (loopOnly && depth > 0) return [];
      throw new Error('不跟随来源符号链接');
    }
    if (depth === 0 && !stat.isDirectory()) throw new Error('配置的来源不是目录');
    if (stat.isDirectory()) {
      const result: string[] = [];
      const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (loopOnly) {
          // 只列根下项目及项目内的一层名字，绝不进入 resources/验收材料等深层目录。
          if (depth === 0 && (!entry.isDirectory() || loopInfrastructure.has(entry.name))) continue;
          if (depth === 1 && (!entry.isFile() || !isLoopSummary(entry.name))) continue;
        }
        result.push(...await walk(join(path, entry.name), extension, health, depth + 1, loopOnly, failedPaths, presentPaths));
      }
      return result;
    }
    return stat.isFile() && extname(path) === extension ? [path] : [];
  } catch (error) {
    if (!(loopOnly && depth > 0 && permissionDenied(error))) {
      failedPaths?.add(`${health.source}:${path}`);
      if (depth === 0) health.errors.push(`来源目录读不了：${path}：${errorMessage(error)}`);
      else unreadable(health, `${path}：${errorMessage(error)}`);
    }
    return [];
  }
}
async function readComponent(path: string, component: SourceComponent) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (component.tool === 'loop' && !(stat.mode & 0o444)) throw Object.assign(new Error('没有读权限'), { code: 'EACCES' });
    const original: Original = { path, fingerprint: '' };
    const reader = new SourceReader(handle, component);
    let record: SessionRecord | null = null;
    let error: unknown;
    try {
      if (component.parseRows) record = component.parseRows(reader.rows(), original);
      else if (component.parseLines) record = component.parseLines(reader.lines(), original, { modifiedAt: stat.mtime.toISOString() });
      else throw new Error('来源组件缺少逐行解析入口');
    } catch (cause) { error = cause; }
    try { reader.finish(); } catch (cause) { error ??= cause; }
    original.fingerprint = reader.fingerprint;
    return { record, original, identity: reader.identity, sessionIds: reader.sessionIds, hasCoreRows: reader.hasCoreRows,
      lastRecordAt: reader.lastRecordAt, modifiedAt: stat.mtime.toISOString(), error: reader.error ?? error };
  } finally { await handle.close(); }
}
function parsePush(value: unknown, path: string, line: number, fingerprint: string): PushRecord {
  const data = object(value);
  if (!['cc', 'codex', 'pi'].includes(data.tool) || basename(path) !== `${data.tool}.jsonl`) throw new Error('推送工具与文件名不一致');
  if (!['waiting_permission', 'turn_end', 'session_end'].includes(data.event)) throw new Error('未知推送事件');
  if (data.detail !== undefined && typeof data.detail !== 'string') throw new Error('推送 detail 不是文字');
  return {
    tool: data.tool, event: data.event, sessionId: requiredString(data.session_id, 'session_id'),
    project: requiredString(data.cwd, 'cwd'), transcriptPath: requiredString(data.transcript_path, 'transcript_path'),
    at: iso(data.at), detail: data.detail ?? '', original: { path, line, fingerprint },
  };
}
export async function perceive(config: Config): Promise<Perception> {
  const result: Perception = { records: [], pushes: [], health: [], cursors: [], failedSessions: [], failedPaths: new Set(), unwrittenPaths: new Set(), emptyPaths: new Set(), presentPaths: new Set(), seenSessions: [] };
  const reports = new Map<HealthSource, HealthReport>();
  const ignoredSessions = new Set<string>();
  const activity = new Map<string, { at: string; intent: string | null; record: SessionRecord | null }>();
  const summaryWrites = new Map<string, string>();
  function report(source: HealthSource): HealthReport {
    if (!reports.has(source)) reports.set(source, { source, errors: [], paths: [] });
    return reports.get(source)!;
  }
  for (const component of components) {
    const root = config.sources[component.tool];
    if (root === null) continue;
    const health = report(component.tool);
    health.paths.push(root);
    const files = await walk(root, component.extension, health, 0, component.tool === 'loop', result.failedPaths, result.presentPaths);
    const records: SessionRecord[] = [];
    const identities: SessionIdentity[] = [];
    const failures: { path: string; description: string; identity?: SessionIdentity | null; original?: Original }[] = [];
    health.fileStats = { total: files.length, skipped: 0 };
    health.fileStatsProfile = 'exclude_internal_v2';
    for (const path of files) {
      try {
        const observed = await readComponent(path, component);
        for (const sessionId of observed.sessionIds) result.seenSessions.push({ tool: component.tool, sessionId });
        if (observed.identity) identities.push(observed.identity);
        if (!observed.error && observed.identity && observed.lastRecordAt) {
          const previous = activity.get(observed.identity.sessionId);
          if (!previous || observed.lastRecordAt > previous.at) activity.set(observed.identity.sessionId, { at: observed.lastRecordAt, intent: observed.record?.intent.initial ?? null, record: observed.record });
        }
        if ((observed.identity && isInternalSession(component.tool, observed.identity.sessionId, observed.identity.project))
          || (observed.sessionIds.size && [...observed.sessionIds].every(id => isInternalSession(component.tool, id)))) { health.fileStats.total--; continue; }
        if (observed.error) {
          failures.push({ path, description: `${path}：${errorMessage(observed.error)}`, identity: observed.identity, original: observed.original });
        } else if (observed.record) {
          records.push(observed.record);
          if (component.tool === 'loop') summaryWrites.set(observed.record.key, observed.modifiedAt);
        }
        else {
          health.fileStats.skipped++;
          // 空/非会话记录不能给推送对账，也不能把过去已知子任务误当完成。
          result.failedPaths.add(`${component.tool}:${path}`);
          result.unwrittenPaths.add(`${component.tool}:${path}`);
          if (component.isCoreRow && !observed.hasCoreRows) result.emptyPaths.add(`${component.tool}:${path}`);
        }
      } catch (error) {
        if (component.tool === 'loop' && permissionDenied(error)) continue;
        failures.push({ path, description: `${path}：${errorMessage(error)}` });
      }
    }
    const peers = [...records, ...identities];
    for (const failure of failures) {
      // 无法读到身份时，只用工具固定会话文件命名识别内部会话；不据此创建正常记录。
      const name = basename(failure.path, component.extension);
      if (!failure.identity && (isInternalSession(component.tool, name)
        || (component.tool === 'pi' && name.includes('_autoreview-')))) { health.fileStats.total--; continue; }
      if (failure.identity && isIgnoredMember(failure.identity, peers, config, component.tool)) ignoredSessions.add(`${component.tool}:${failure.identity.sessionId}`);
      else {
        unreadable(health, failure.description);
        if (failure.identity && (health.affectedSessions?.length ?? 0) < 3) (health.affectedSessions ??= []).push(failure.identity);
        result.failedPaths.add(`${component.tool}:${failure.path}`);
        if (failure.original && typeof failure.identity?.parentSessionId === 'string' && failure.identity.parentSessionId.trim()) {
          result.failedSessions.push({ ...failure.identity, tool: component.tool, original: failure.original });
        }
      }
    }
    if (!records.length && health.fileFailures?.count) coreUnavailable(health);
    for (const record of records) {
      if (isIgnoredMember(record, peers, config, component.tool)) ignoredSessions.add(record.key);
      else {
        if (record.loop?.sessions) {
          const sessions = record.loop.sessions, summaryAt = record.lastActivityAt;
          const roles: [string, string][] = [[sessions.development, '开发'], [sessions.review, `评审第 ${Math.max(1, record.loop.reviews + 1)} 轮`], ...sessions.acceptance.map((id): [string, string] => [id, '验收'])];
          if (record.loop.status === '进行中') for (const [id, phase] of roles) {
            const observed = activity.get(id);
            if (observed && observed.at > record.lastActivityAt) {
              record.lastActivityAt = observed.at;
              // 总结的轮次时间是「开始」，不是「结束」。只有总结写成后又有评审记录才是下一轮。
              if (id !== sessions.review || observed.at > (summaryWrites.get(record.key) ?? summaryAt)) record.loop.phase = phase;
            }
          }
          const development = activity.get(sessions.development);
          const intent = development?.intent;
          if (development?.record) {
            record.intent = development.record.intent;
            record.requestRefs = development.record.requestRefs;
          }
          // 总结不带批名时，只取开发任务明确写出的批名/提示词标题，不读它提到的文件。
          record.loop.batch ??= intent?.match(/批次[：:]\s*([^\n<]+)/)?.[1]?.trim()
            ?? intent?.match(/(?:提示词[-：:]\s*)([^\n<>"/]+?)(?:\.md|（|\(|\n|$)/)?.[1]?.trim();
          if (record.lastActivityAt > summaryAt) record.recentSteps.unshift({ at: record.lastActivityAt, text: record.loop.phase ?? '开发' });
        }
        result.records.push(record);
      }
    }
  }
  if (config.inboxDir !== null) {
    const inboxHealth = report('inbox');
    inboxHealth.paths.push(config.inboxDir);
    const files = await walk(config.inboxDir, '.jsonl', inboxHealth);
    // 推送的读取/对账故障保留第一批的安全规则，不把它当普通会话文件降级。
    if (inboxHealth.fileFailures) inboxHealth.errors.push(...inboxHealth.fileFailures.examples);
    for (const path of files) {
      const name = basename(path, '.jsonl');
      const source: HealthSource = ['cc', 'codex', 'pi'].includes(name) ? name as HealthSource : 'inbox';
      if (source !== 'inbox' && config.sources[source] === null) continue;
      const health = report(source);
      if (!health.paths.includes(config.inboxDir)) health.paths.push(config.inboxDir);
      try {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const reader = new SourceReader(handle, cc);
          let consumed = 0;
          let broken = false;
          let lineNumber = 0;
          for (const line of reader.lines()) {
            lineNumber++;
            if (!line.trim()) { if (!broken) consumed = lineNumber; continue; }
            try {
              const value = JSON.parse(line);
              if (!(typeof value?.session_id === 'string' && isInternalSession(value.tool, value.session_id, typeof value.cwd === 'string' ? value.cwd : ''))
                && !ignoredSessions.has(`${value?.tool}:${value?.session_id}`)
                && !(typeof value?.cwd === 'string' && isIgnoredProject(value.cwd, config))) {
                result.pushes.push(parsePush(value, path, lineNumber, hash(line)));
              }
              if (!broken) consumed = lineNumber;
            } catch {
              broken = true;
              health.errors.push(`${path}：第 ${lineNumber} 行推送无法解析/不符合事件格式`);
            }
          }
          result.cursors.push({ kind: 'push_cursor', path, lines: consumed, fingerprint: reader.fingerprint });
        } finally { await handle.close(); }
      } catch (error) { health.errors.push(`${path}：${errorMessage(error)}`); }
    }
  }
  result.health = [...reports.values()];
  return result;
}
