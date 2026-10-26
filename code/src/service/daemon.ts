import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { configuredChannels } from '../channels/index.ts';
import { detect, publishNotices } from '../core/agent.ts';
import { validateConfig } from '../core/config.ts';
import { acquireLock, recoverDeadLock } from '../core/locks.ts';
import { agentNotice } from '../core/learning.ts';
import { appendJsonl, readJsonl } from '../core/store.ts';
import { shellQuote } from '../core/utils.ts';
import type { Config } from '../core/types.ts';

interface RunEvent { kind: 'start' | 'stop' | 'alerted'; at: string; runId: string; pid?: number }
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true });
  });
}
/** 前台常驻与 launchd 使用同一个入口；不 fork，不读取默认个人目录。 */
export async function runService(configInput: Config, signal: AbortSignal): Promise<void> {
  const config = await validateConfig(configInput), dir = config.dataDir;
  await recoverDeadLock(dir, '.service.lock');
  const release = await acquireLock(dir, '.service.lock');
  const channels = configuredChannels(config);
  const runId = randomUUID(), runsPath = join(dir, 'service-runs.jsonl'), logPath = join(dir, 'service.log.jsonl');
  const interval = config.service?.intervalMs ?? 60000;
  async function log(kind: string, extra: Record<string, unknown> = {}) {
    await readJsonl(logPath);
    await appendJsonl(logPath, [{ at: new Date().toISOString(), kind, ...extra }]);
  }
  let poll: Promise<void> | undefined;
  let normalExit = false;
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (const name of ['.detect.lock', '.model.lock', '.learning.lock', '.feishu-send.lock', '.feishu-receive.lock', '.feishu-inbound.lock']) await recoverDeadLock(dir, name);
    const history = await readJsonl<RunEvent>(runsPath);
    const at = new Date().toISOString();
    await appendJsonl(runsPath, [{ kind: 'start', at, runId, pid: process.pid } satisfies RunEvent]);
    const windowStart = Date.parse(at) - (config.service?.restartWindowMs ?? 300000);
    const stopped = new Set(history.filter(e => e.kind === 'stop').map(e => e.runId));
    const crashes = history.filter(e => e.kind === 'start' && Date.parse(e.at) >= windowStart && !stopped.has(e.runId));
    const alerted = history.some(e => e.kind === 'alerted' && Date.parse(e.at) >= windowStart);
    if (crashes.length >= (config.service?.restartThreshold ?? 3) && !alerted) {
      const notice = agentNotice('service_restart', `restarts:${crashes[0]!.runId}`, at, 'personal agent 短时间内反复重启', `短时间内 ${crashes.length} 次异常退出后重新启动。日志：${logPath}`, `open ${shellQuote(logPath)}`);
      await publishNotices(config, [notice], at, channels);
      await appendJsonl(runsPath, [{ kind: 'alerted', at, runId } satisfies RunEvent]);
    }
    for (const channel of channels) if ('start' in channel && typeof channel.start === 'function') await channel.start();
    await log('started', { intervalMs: interval });
    poll = (async () => {
      while (!shutdown.signal.aborted) {
        for (const channel of channels) if ('drain' in channel && typeof channel.drain === 'function') {
          try { await channel.drain(); } catch { await log('receive_pending', { message: '收件暂未完成，下次重试；未输出事件或上游错误' }); }
        }
        await pause(Math.min(interval, 1000), shutdown.signal);
      }
    })();
    // 为异步轮询安装拒绝处理器，错误由下面 await 统一处理，不留 unhandled rejection。
    void poll.catch(() => shutdown.abort());
    while (!shutdown.signal.aborted) {
      const began = Date.now();
      try {
        const view = await detect(config, new Date().toISOString(), { channels });
        await log('scan_completed', { noticesAdded: view.noticesAdded });
      } catch { await log('scan_failed', { message: '检测未完成，保留事实与现场；下轮重试' }); }
      await pause(Math.max(1, interval - (Date.now() - began)), shutdown.signal);
    }
    await poll;
    normalExit = true;
  } finally {
    shutdown.abort(); signal.removeEventListener('abort', abort);
    if (poll) await poll.catch(() => {});
    try {
      for (const channel of channels) if ('stop' in channel && typeof channel.stop === 'function') await channel.stop();
      if (normalExit) {
        await log('stopped');
        await appendJsonl(runsPath, [{ kind: 'stop', at: new Date().toISOString(), runId } satisfies RunEvent]);
      }
    } finally { await release(); }
  }
}
