import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isLoopSummary, loop } from '../sources/loop/index.ts';
import { isIgnoredProject } from './config.ts';
import { coreUnavailable, unreadable } from './health.ts';
import { SourceReader } from './source-reader.ts';
import { errorMessage } from './utils.ts';
import type { Config, EventPayload, FailedSessionIdentity, HealthReport, Original, PushRecord, SessionRecord, Tool } from './types.ts';

export interface Perception {
  records: SessionRecord[];
  pushes: PushRecord[];
  health: HealthReport[];
  cursors: EventPayload[];
  failedSessions: FailedSessionIdentity[];
  failedPaths: Set<string>;
  unwrittenPaths: Set<string>;
  emptyPaths: Set<string>;
  presentPaths: Set<string>;
  seenSessions: { tool: Tool; sessionId: string }[];
}
/** 本段仍按轮读取 loop 总结。聊天目录、hook 收件目录完全不打开、不校验、不报错。 */
export async function perceive(config: Config): Promise<Perception> {
  const result: Perception = { records: [], pushes: [], health: [], cursors: [], failedSessions: [], failedPaths: new Set(),
    unwrittenPaths: new Set(), emptyPaths: new Set(), presentPaths: new Set(), seenSessions: [] };
  const root = config.sources.loop;
  if (root === null) return result;
  const health: HealthReport = { source: 'loop', paths: [root], errors: [], fileStats: { total: 0, skipped: 0 }, fileStatsProfile: 'exclude_internal_v2' };
  result.health.push(health);
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('loop 来源必须是普通目录，不跟随链接');
    if (!(stat.mode & 0o444) || !(stat.mode & 0o111)) throw new Error('loop 来源目录没有读取权限');
    const projects = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const project of projects) {
      if (!project.isDirectory() || ['resources', 'projects', 'pipelines'].includes(project.name)) continue;
      const dir = join(root, project.name);
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (error) {
        if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) unreadable(health, `${dir}：${errorMessage(error)}`);
        continue;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !isLoopSummary(entry.name)) continue;
        const path = join(dir, entry.name);
        result.presentPaths.add(`loop:${path}`); health.fileStats!.total++;
        try {
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await handle.stat();
            // 既有规则：单份总结无权限不拖垮可见的其他批次。
            if (!(stat.mode & 0o444)) { health.fileStats!.total--; continue; }
            const original: Original = { path, fingerprint: '' }, reader = new SourceReader(handle, loop);
            let record: SessionRecord | null = null, failure: unknown;
            try { record = loop.parseLines!(reader.lines(), original, { modifiedAt: stat.mtime.toISOString() }); }
            catch (error) { failure = error; }
            reader.finish();
            if (reader.identity && isIgnoredProject(reader.identity.project, config)) continue;
            if (reader.error || failure) throw reader.error ?? failure;
            original.fingerprint = reader.fingerprint;
            if (reader.lineCount) original.span = { startLine: 1, endLine: reader.lineCount, byteLength: reader.byteLength };
            if (!record) { health.fileStats!.skipped++; continue; }
            if (!isIgnoredProject(record.project, config)) result.records.push(record);
          } finally { await handle.close(); }
        } catch (error) {
          if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { health.fileStats!.total--; continue; }
          result.failedPaths.add(`loop:${path}`); unreadable(health, `${path}：${errorMessage(error)}`);
        }
      }
    }
    if (!result.records.length && health.fileFailures?.count) coreUnavailable(health);
  } catch (error) {
    result.failedPaths.add(`loop:${root}`);
    health.errors.push(`来源目录读不了：${root}：${errorMessage(error)}`);
  }
  return result;
}
