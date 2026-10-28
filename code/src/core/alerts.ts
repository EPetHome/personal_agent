import { AsyncLocalStorage } from 'node:async_hooks';
import { localChannel } from '../channels/local/index.ts';
import { safeProcessingFailure } from './failures.ts';
import { firstScreen } from './notice-text.ts';
import { hash } from './utils.ts';
import type { Channel, Config, Notice } from './types.ts';

/** 紧急告警不走发件/数据锁：磁盘满时也能尝试本机通知，绝不递归发到故障渠道。 */
export function localAlert(kind: 'delivery_failed' | 'storage_full', key: string, at: string, title: string, situation: string, action: string): Notice {
  return { version: 1, id: hash(key), dedupeKey: key, at, tool: 'agent', kind, level: '现在就要你',
    content: { title, situation, action, summary: firstScreen(situation, action), returnCommand: '请查看本机总览和服务日志。',
      evidence: { project: null, intentOriginal: null, additionalRequirements: [], recentSteps: [], reason: action, originals: [] } },
    text: firstScreen(situation, action) };
}
interface StorageEpisode { active: boolean; revision: number; channels?: Channel[] }
const episodes = new Map<string, StorageEpisode>();
const guarded = new AsyncLocalStorage<ReadonlySet<string>>();
function episode(config: Config): StorageEpisode {
  let state = episodes.get(config.dataDir);
  if (!state) { state = { active: false, revision: 0 }; episodes.set(config.dataDir, state); }
  return state;
}
export async function reportStorageFailure(config: Config, error: unknown, channels?: Channel[]): Promise<void> {
  if (safeProcessingFailure(error).category !== 'storage_full') return;
  const state = episode(config); state.revision++;
  if (state.active) return;
  // 显式注入的渠道是完整替身边界，绝不绕回配置启动未注入的真实命令。
  const available = channels ?? state.channels;
  const local = available ? available.find(channel => channel.name === 'local')
    : config.localChannel ? localChannel(config.dataDir, config.localChannel) : undefined;
  if (!local) return;
  state.active = true; // 先占一次尝试，通知自己失败时也不递归/无限弹窗。
  const notice = localAlert('storage_full', `storage-full:${config.dataDir}`, new Date().toISOString(),
    '磁盘已满，盯防可能停了', '本机磁盘已满，检测或写入未完成，盯防可能停了', '请清理磁盘空间，然后检查 personal agent 服务和总览。');
  try { await local.send(notice); } catch { /* 磁盘满时不依赖持久化，也不让告警失败覆盖原错误。 */ }
}
/** 只有调用方确认完整一轮成功才解除；捕获错误后写日志成功、嵌套局部成功均不算恢复。 */
export async function withStorageAlerts<T>(config: Config, channels: Channel[], operation: () => Promise<T>, recover: boolean | ((result: T) => boolean) = true): Promise<T> {
  const state = episode(config); state.channels = channels;
  const parents = guarded.getStore() ?? new Set<string>(), nested = parents.has(config.dataDir), revision = state.revision;
  try {
    const result = await guarded.run(recover === false ? parents : new Set([...parents, config.dataDir]), operation);
    if (!nested && state.revision === revision && (recover === true || typeof recover === 'function' && recover(result))) state.active = false;
    return result;
  } catch (error) { await reportStorageFailure(config, error, channels); throw error; }
}
