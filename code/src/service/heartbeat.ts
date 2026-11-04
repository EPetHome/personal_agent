import { notifyLocal } from '../channels/local/index.ts';
import { recoverDeadLock, withNamedLock } from '../core/locks.ts';
import { hash } from '../core/utils.ts';
import { OperationFailure } from '../core/failures.ts';
import { heartbeatAlertPath, readRuntimeFile, readRuntimeState, recordRuntimeProgress, writeRuntimeFile } from '../core/runtime-state.ts';
import type { Config } from '../core/types.ts';

/** 只在主流程实际完成一轮后覆盖写；启动和旁路计时器不能伪造进展。 */
export async function recordHeartbeat(config: Config, at: string, runId: string) {
  await recordRuntimeProgress(config.dataDir, { completedAt: at, runId });
}
/** launchd独立进程：只读小状态，不等待账本锁、不连接飞书、不查询worker。 */
export async function checkHeartbeat(config: Config, at: string, notify = (title: string, text: string) =>
  notifyLocal(config.heartbeat?.executable ?? '/usr/bin/osascript', config.heartbeat?.notifyTimeoutMs ?? 3000, title, text)) {
  let attempted = false;
  const once = async (title: string, text: string) => { attempted = true; await notify(title, text); };
  try { return await checkRuntimeHeartbeat(config, at, once); }
  catch (error) {
    if (error instanceof OperationFailure && error.category === 'lock_busy') return { status: 'busy' };
    // 小状态坏了/写满也不能让最后一道独立报警失声；不改坏文件。
    if (attempted) return { status: 'unavailable_uncertain' };
    try { await once('personal agent 心跳无法核实', 'PA 心跳状态不可用，无法确认主流程是否停了；请检查本机服务。'); return { status: 'unavailable_notified' }; }
    catch { return { status: 'unavailable_uncertain' }; }
  }
}
interface HeartbeatAlert { schema: 1; key: string; status: string }
async function checkRuntimeHeartbeat(config: Config, at: string, notify: (title: string, text: string) => Promise<void>) {
  await recoverDeadLock(config.dataDir, '.heartbeat.lock');
  return withNamedLock(config.dataDir, '.heartbeat.lock', async () => {
    const pulse = await readRuntimeState(config.dataDir);
    const lastProgressAt = pulse?.completedAt ?? pulse?.startedAt;
    if (!pulse || !lastProgressAt) return { status: 'not_started' };
    if (Date.parse(at) - Date.parse(lastProgressAt) <= (config.heartbeat?.timeoutMs ?? 180000)) return { status: 'healthy', lastHeartbeatAt: pulse.completedAt };
    const key = hash(JSON.stringify([pulse.runId, lastProgressAt])), path = heartbeatAlertPath(config.dataDir);
    const old = await readRuntimeFile<HeartbeatAlert>(path);
    if (old && (old.schema !== 1 || typeof old.key !== 'string' || !['sending', 'notified', 'uncertain'].includes(old.status))) throw new OperationFailure('data_corrupt', '独立心跳通知状态损坏；保留现场');
    if (old?.key === key) return { status: 'already_notified', lastHeartbeatAt: pulse.completedAt };
    // 在通知前再读一次主流程信号。先记尝试，崩溃/超时也不重复弹。
    const current = await readRuntimeState(config.dataDir);
    if (current?.runId !== pulse.runId || current?.completedAt !== pulse.completedAt || current?.startedAt !== pulse.startedAt) return { status: 'healthy', lastHeartbeatAt: current?.completedAt };
    await writeRuntimeFile(path, { schema: 1, key, status: 'sending' } satisfies HeartbeatAlert);
    let status = 'notified';
    try { await notify('personal agent 停了', 'personal agent 停了：主流程超过设定时长没有完成一轮，请检查本机服务。'); }
    catch { status = 'uncertain'; }
    await writeRuntimeFile(path, { schema: 1, key, status } satisfies HeartbeatAlert);
    return { status, lastHeartbeatAt: pulse.completedAt };
  });
}
