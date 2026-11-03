import { notifyLocal } from '../channels/local/index.ts';
import { readLedger, updateLedger } from '../core/ledger.ts';
import { recoverDeadLock, withNamedLock } from '../core/locks.ts';
import { hash } from '../core/utils.ts';
import { OperationFailure } from '../core/failures.ts';
import type { Config } from '../core/types.ts';

/** 主进程只在处理循环有实际进展时更新；不以另一个永不阻塞的计时器掩盖主循环卡死。 */
export async function recordHeartbeat(config: Config, at: string, runId: string) {
  await updateLedger(config.dataDir, at, (state, add) => {
    const old = state.tables.receipts['heartbeat:main'];
    if (old?.response === runId && Date.parse(at) - Date.parse(old.at) < (config.heartbeat?.everyMs ?? 30000)) return;
    add({ kind: 'put', table: 'receipts', value: { id: 'heartbeat:main', at, response: runId } });
  });
}
/** launchd独立进程：只看账本心跳年龄，不启动PA、不连接飞书、不查询worker。 */
export async function checkHeartbeat(config: Config, at: string, notify = (title: string, text: string) =>
  notifyLocal(config.heartbeat?.executable ?? '/usr/bin/osascript', config.heartbeat?.notifyTimeoutMs ?? 3000, title, text)) {
  let attempted = false;
  const once = async (title: string, text: string) => { attempted = true; await notify(title, text); };
  try { return await checkLedgerHeartbeat(config, at, once); }
  catch (error) {
    if (error instanceof OperationFailure && error.category === 'lock_busy') return { status: 'busy' };
    // 账本坏了/满了本来就不能写去重；不能因此让最后一道独立报警也失声。
    // 不改坏账本，不另造状态文件；同次调用至多一次。下一次调度可能再次提示，直到修复。
    if (attempted) return { status: 'unavailable_uncertain' };
    try { await once('personal agent 心跳无法核实', 'PA 账本或心跳检查不可用，无法确认主进程是否停了；请检查本机服务。'); return { status: 'unavailable_notified' }; }
    catch { return { status: 'unavailable_uncertain' }; }
  }
}
async function checkLedgerHeartbeat(config: Config, at: string, notify: (title: string, text: string) => Promise<void>) {
  await recoverDeadLock(config.dataDir, '.heartbeat.lock');
  await recoverDeadLock(config.dataDir, '.ledger.lock');
  return withNamedLock(config.dataDir, '.heartbeat.lock', async () => {
    const state = await readLedger(config.dataDir), pulse = state.tables.receipts['heartbeat:main'];
    if (!pulse) return { status: 'not_started' };
    if (Date.parse(at) - Date.parse(pulse.at) <= (config.heartbeat?.timeoutMs ?? 180000)) return { status: 'healthy', lastHeartbeatAt: pulse.at };
    const id = `heartbeat-alert:${hash(JSON.stringify([pulse.response, pulse.at])).slice(0, 32)}`;
    const claimed = await updateLedger(config.dataDir, at, (current, add) => {
      if (current.tables.receipts[id]) return false;
      // 核对刚才的心跳没有在锁外被主进程刷新。先记尝试，超时也不重复弹。
      if (current.tables.receipts['heartbeat:main']?.at !== pulse.at || current.tables.receipts['heartbeat:main']?.response !== pulse.response) return false;
      add({ kind: 'put', table: 'receipts', value: { id, at, response: 'sending' } });
      add({ kind: 'observation', observation: { kind: 'guard', actor: 'independent_heartbeat', detail: '独立心跳：超过阈值，仅向本机本人发固定故障通知' } });
      return true;
    });
    if (!claimed) return { status: 'already_notified', lastHeartbeatAt: pulse.at };
    let status = 'notified';
    try { await notify('personal agent 停了', 'personal agent 停了：主进程心跳超过设定时长没有更新，请检查本机服务。'); }
    catch { status = 'uncertain'; }
    await updateLedger(config.dataDir, at, (_current, add) => add({ kind: 'put', table: 'receipts', value: { id, at, response: status } }));
    return { status, lastHeartbeatAt: pulse.at };
  });
}
