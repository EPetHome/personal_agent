import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { configuredChannels } from '../channels/index.ts';
import { detect, publishNotices } from '../core/agent.ts';
import { reportStorageFailure, withStorageAlerts } from '../core/alerts.ts';
import { OperationFailure, safeProcessingFailure } from '../core/failures.ts';
import type { SafeFailure } from '../core/failures.ts';
import { validateConfig } from '../core/config.ts';
import { acquireLock, recoverDeadLock } from '../core/locks.ts';
import { agentNotice } from '../core/learning.ts';
import { appendJsonl, measureStoreLocks, readJsonl } from '../core/store.ts';
import { firstScreen } from '../core/notice-text.ts';
import { renderNotice } from '../core/judge.ts';
import type { Channel, Config } from '../core/types.ts';

interface RunEvent { kind: 'start' | 'stop' | 'alerted' | 'failed'; at: string; runId: string; pid?: number; failure?: SafeFailure }
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true });
  });
}
/** 前台常驻与 launchd 使用同一个入口；不 fork，不读取默认个人目录。 */
export async function runService(configInput: Config, signal: AbortSignal, components: { channels?: Channel[] } = {}): Promise<void> {
  const config = await validateConfig(configInput), channels = components.channels ?? configuredChannels(config);
  // 启动建锁、运行记录以及退出写入也在保护内，不只保护 detect 的主体。
  return withStorageAlerts(config, channels, () => serve(config, signal, channels), false);
}
async function serve(config: Config, signal: AbortSignal, channels: Channel[]): Promise<void> {
  const dir = config.dataDir;
  await recoverDeadLock(dir, '.service.lock');
  const release = await acquireLock(dir, '.service.lock');
  const runId = randomUUID(), runsPath = join(dir, 'service-runs.jsonl'), logPath = join(dir, 'service.log.jsonl');
  const interval = config.service?.intervalMs ?? 60000;
  let pendingStorageLog: Record<string, unknown> | undefined;
  async function log(kind: string, extra: Record<string, unknown> = {}) {
    try {
      await readJsonl(logPath);
      await appendJsonl(logPath, [...(pendingStorageLog ? [pendingStorageLog] : []), { at: new Date().toISOString(), kind, ...extra }]);
      pendingStorageLog = undefined;
    } catch (error) {
      const failure = safeProcessingFailure(error);
      if (failure.category !== 'storage_full') throw error;
      // 日志也写不进时先告警，不反复崩溃；空间恢复后补记一条安全类别。
      pendingStorageLog ??= { at: new Date().toISOString(), kind: 'storage_full', ...failure };
      await reportStorageFailure(config, error, channels);
    }
  }
  let poll: Promise<void> | undefined;
  let normalExit = false;
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (const name of ['.detect.lock', '.model.lock', '.learning.lock', '.feedback.lock', '.outbox.lock', '.feishu-send.lock', '.feishu-reply-send.lock', '.feishu-sent.lock', '.feishu-receive.lock', '.feishu-inbound.lock', '.relay.lock', '.relay-ui.lock']) await recoverDeadLock(dir, name);
    const history = await readJsonl<RunEvent>(runsPath);
    const at = new Date().toISOString();
    await appendJsonl(runsPath, [{ kind: 'start', at, runId, pid: process.pid } satisfies RunEvent]);
    const windowStart = Date.parse(at) - (config.service?.restartWindowMs ?? 300000);
    const stopped = new Set(history.filter(e => e.kind === 'stop').map(e => e.runId));
    const lastRun = history.filter(e => e.kind === 'start').at(-1);
    if (lastRun && !stopped.has(lastRun.runId)) {
      const failed = history.findLast(e => e.runId === lastRun.runId && e.kind === 'failed');
      await log('previous_abnormal_exit', { message: '上次没有正常停止', previousRunId: lastRun.runId,
        ...(failed?.failure ? safeProcessingFailure(new OperationFailure(failed.failure.category, '')) : {}) });
    }
    const crashes = history.filter(e => e.kind === 'start' && Date.parse(e.at) >= windowStart && !stopped.has(e.runId));
    const alerted = history.some(e => e.kind === 'alerted' && Date.parse(e.at) >= windowStart);
    if (crashes.length >= (config.service?.restartThreshold ?? 3) && !alerted) {
      const notice = agentNotice('service_restart', `restarts:${crashes[0]!.runId}`, at, 'personal agent 短时间内反复重启',
        firstScreen(`盯住 AI 的值班程序短时间内 ${crashes.length} 次异常退出后重启，盯防可能不连续`, '请检查本机值班程序是否稳定；不会替你停止或启动任何 AI'),
        'node code/src/cli/main.ts overview --config <你运行时使用的配置文件>');
      notice.content.evidence.reason = `异常重启记录：${runsPath}；运行日志：${logPath}`;
      notice.text = renderNotice(notice.content, at);
      await publishNotices(config, [notice], at, channels);
      await appendJsonl(runsPath, [{ kind: 'alerted', at, runId } satisfies RunEvent]);
    }
    for (const channel of channels) if ('start' in channel && typeof channel.start === 'function') await channel.start();
    await log('started', { intervalMs: interval });
    poll = (async () => {
      while (!shutdown.signal.aborted) {
        for (const channel of channels) if ('drain' in channel && typeof channel.drain === 'function') {
          try { await channel.drain(); }
          catch (error) {
            await reportStorageFailure(config, error, channels);
            await log('receive_pending', { message: '收件暂未完成，下次重试；未输出事件或上游错误', ...safeProcessingFailure(error) });
          }
        }
        await pause(Math.min(interval, 1000), shutdown.signal);
      }
    })();
    // 为异步轮询安装拒绝处理器，错误由下面 await 统一处理，不留 unhandled rejection。
    void poll.catch(() => shutdown.abort());
    while (!shutdown.signal.aborted) {
      const began = performance.now(), timing = { heldMs: 0 };
      await withStorageAlerts(config, channels, async () => {
        let kind = 'scan_completed', result: Record<string, unknown>;
        try {
          const view = await measureStoreLocks(() => detect(config, new Date().toISOString(), { channels }), timing);
          result = { noticesAdded: view.noticesAdded };
        } catch (error) {
          await reportStorageFailure(config, error, channels);
          kind = 'scan_failed'; result = { message: '检测未完成，保留事实与现场；下轮重试', ...safeProcessingFailure(error) };
        }
        await log(kind, { ...result, durationMs: Math.round(performance.now() - began), storeLockHeldMs: Math.round(timing.heldMs) });
        return kind;
      }, kind => kind === 'scan_completed');
      await pause(Math.max(1, interval - (performance.now() - began)), shutdown.signal);
    }
    await poll;
    normalExit = true;
  } catch (error) {
    const failure = safeProcessingFailure(error);
    await reportStorageFailure(config, error, channels);
    await log('service_failed', { ...failure }).catch(() => {});
    await appendJsonl(runsPath, [{ kind: 'failed', at: new Date().toISOString(), runId, failure } satisfies RunEvent]).catch(() => {});
    throw error;
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
