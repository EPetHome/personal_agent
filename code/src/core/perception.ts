import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { cc } from '../sources/cc/index.ts';
import { codex } from '../sources/codex/index.ts';
import { pi } from '../sources/pi/index.ts';
import { loop } from '../sources/loop/index.ts';
import { errorMessage, hash, iso, object, requiredString } from './utils.ts';
import type { Config, EventPayload, HealthReport, HealthSource, PushRecord, SessionRecord, SourceComponent } from './types.ts';

const components: SourceComponent[] = [cc, codex, pi, loop];
export interface Perception {
  records: SessionRecord[];
  pushes: PushRecord[];
  health: HealthReport[];
  cursors: EventPayload[];
}
async function walk(path: string, extension: string, errors: string[], isRoot = false): Promise<string[]> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('不跟随来源符号链接');
    if (isRoot && !stat.isDirectory()) throw new Error('配置的来源不是目录');
    if (stat.isDirectory()) {
      const result: string[] = [];
      for (const entry of (await readdir(path)).sort()) result.push(...await walk(join(path, entry), extension, errors));
      return result;
    }
    return stat.isFile() && extname(path) === extension ? [path] : [];
  } catch (error) {
    errors.push(`${path}：${errorMessage(error)}`);
    return [];
  }
}
async function readSource(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
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
  const result: Perception = { records: [], pushes: [], health: [], cursors: [] };
  const reports = new Map<HealthSource, HealthReport>();
  function report(source: HealthSource): HealthReport {
    if (!reports.has(source)) reports.set(source, { source, errors: [], paths: [] });
    return reports.get(source)!;
  }
  for (const component of components) {
    const root = config.sources[component.tool];
    if (root === null) continue;
    const health = report(component.tool);
    health.paths.push(root);
    const files = await walk(root, component.extension, health.errors, true);
    for (const path of files) {
      try {
        const text = await readSource(path);
        const record = component.parse(text, { path, fingerprint: hash(text) });
        if (record) result.records.push(record);
      } catch (error) { health.errors.push(`${path}：${errorMessage(error)}`); }
    }
  }
  if (config.inboxDir !== null) {
    const inboxHealth = report('inbox');
    inboxHealth.paths.push(config.inboxDir);
    const files = await walk(config.inboxDir, '.jsonl', inboxHealth.errors, true);
    for (const path of files) {
      const name = basename(path, '.jsonl');
      const source: HealthSource = ['cc', 'codex', 'pi'].includes(name) ? name as HealthSource : 'inbox';
      if (source !== 'inbox' && config.sources[source] === null) continue;
      const health = report(source);
      if (!health.paths.includes(config.inboxDir)) health.paths.push(config.inboxDir);
      try {
        const text = await readSource(path);
        const lines = text.split('\n');
        let consumed = 0;
        let broken = false;
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!;
          if (!line.trim()) { if (!broken && index < lines.length - 1) consumed = index + 1; continue; }
          try {
            result.pushes.push(parsePush(JSON.parse(line), path, index + 1, hash(line)));
            if (!broken) consumed = index + 1;
          } catch {
            broken = true;
            health.errors.push(`${path}：第 ${index + 1} 行推送无法解析/不符合事件格式`);
          }
        }
        result.cursors.push({ kind: 'push_cursor', path, lines: consumed, fingerprint: hash(text) });
      } catch (error) { health.errors.push(`${path}：${errorMessage(error)}`); }
    }
  }
  result.health = [...reports.values()];
  return result;
}
