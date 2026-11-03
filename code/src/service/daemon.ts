import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { configuredChannels } from '../channels/index.ts';
import { reportStorageFailure, withStorageAlerts } from '../core/alerts.ts';
import { OperationFailure, safeProcessingFailure } from '../core/failures.ts';
import type { SafeFailure } from '../core/failures.ts';
import { validateConfig } from '../core/config.ts';
import { acquireLock, recoverDeadLock } from '../core/locks.ts';
import { appendJsonl, measureStoreLocks, readJsonl } from '../core/store.ts';
import { readLedger, updateLedger } from '../core/ledger.ts';
import { intakeLoop } from '../core/loop-intake.ts';
import { deliverManagedHealth, nextManagedDue, processManagedLoop } from '../core/managed-loop.ts';
import { recordHeartbeat } from './heartbeat.ts';
import { dispatchTasks } from '../core/task-actions.ts';
import { commandWorker } from '../core/worker-adapter.ts';
import { codeVersion } from '../core/runtime-version.ts';
import { startSidebar } from '../channels/sidebar/index.ts';
import { intakeConfiguredSources } from '../core/source-intake.ts';
import type { ScheduleReader } from '../channels/feishu/schedule.ts';
import type { Channel, CodeVersion, Config } from '../core/types.ts';
import type { LoopWorker } from '../core/managed-types.ts';

interface RunEvent { kind: 'start' | 'stop' | 'alerted' | 'failed'; at: string; runId: string; pid?: number; failure?: SafeFailure; codeVersion?: CodeVersion }
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true });
  });
}
/** 事件接入独立于研判；按核实到期唤醒，10分钟巡检兜底，不再串行大扫描。 */
export async function runService(configInput: Config, signal: AbortSignal, components: { channels?: Channel[]; now?: () => string; worker?: LoopWorker; scheduleReader?: ScheduleReader } = {}): Promise<void> {
  const config = await validateConfig(configInput), channels = components.channels ?? configuredChannels(config, true);
  return withStorageAlerts(config, channels, () => serve(config, signal, channels, components.now ?? (() => new Date().toISOString()), components.worker, components.scheduleReader), false);
}
async function serve(config: Config, signal: AbortSignal, channels: Channel[], now: () => string, worker?: LoopWorker, scheduleReader?: ScheduleReader): Promise<void> {
  const dir = config.dataDir;
  await recoverDeadLock(dir, '.service.lock');
  const release = await acquireLock(dir, '.service.lock');
  const runId = randomUUID(), runsPath = join(dir, 'service-runs.jsonl'), logPath = join(dir, 'service.log.jsonl');
  const inspectEveryMs = config.managedLoop?.inspectEveryMs ?? 600000, intakeEveryMs = config.managedLoop?.intakeEveryMs ?? 500;
  let pendingStorageLog: Record<string, unknown> | undefined;
  async function log(kind: string, extra: Record<string, unknown> = {}) {
    try {
      await readJsonl(logPath);
      await appendJsonl(logPath, [...(pendingStorageLog ? [pendingStorageLog] : []), { at: now(), kind, ...extra, codeVersion }]);
      pendingStorageLog = undefined;
    } catch (error) {
      const failure = safeProcessingFailure(error);
      if (failure.category !== 'storage_full') throw error;
      pendingStorageLog ??= { at: now(), kind: 'storage_full', ...failure, codeVersion };
      await reportStorageFailure(config, error, channels);
    }
  }
  async function health(id: string, ok: boolean, reason: string, kind: 'source' | 'service') {
    await updateLedger(dir, now(), (state, add) => {
      const old = state.tables.health[id];
      if (old?.ok === ok || !old && ok) return;
      add({ kind: 'put', table: 'health', value: { id, ok, reason, at: now(), kind, episode: ok ? '' : `${id}:${now()}` } });
    });
  }
  let poll: Promise<void> | undefined, tasks: Promise<void> | undefined, sources: Promise<void> | undefined, normalExit = false;
  let sidebar: Awaited<ReturnType<typeof startSidebar>> | undefined;
  const receivers: Promise<void>[] = [], receiveHealthy = new Map<Channel, boolean>();
  const shutdown = new AbortController();
  let pending = true, intakeHealthy = true, wake: (() => void) | undefined;
  const notify = () => { pending = true; wake?.(); };
  const abort = () => { shutdown.abort(); notify(); };
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  async function untilWork(ms: number) {
    if (pending || shutdown.signal.aborted) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); wake = undefined; resolve(); };
      const timer = setTimeout(finish, Math.max(1, ms)); wake = finish;
    });
  }
  try {
    for (const name of ['.detect.lock', '.ledger.lock', '.managed-work.lock', '.task-work.lock', '.source-intake.lock', '.model.lock', '.learning.lock', '.feedback.lock', '.outbox.lock', '.feishu-send.lock', '.feishu-reply-send.lock', '.feishu-sent.lock', '.feishu-receive.lock', '.feishu-inbound.lock', '.relay.lock', '.relay-ui.lock']) await recoverDeadLock(dir, name);
    const history = await readJsonl<RunEvent>(runsPath), at = now();
    await appendJsonl(runsPath, [{ kind: 'start', at, runId, pid: process.pid, codeVersion } satisfies RunEvent]);
    const windowStart = Date.parse(at) - (config.service?.restartWindowMs ?? 300000);
    const stopped = new Set(history.filter(e => e.kind === 'stop').map(e => e.runId));
    const lastRun = history.filter(e => e.kind === 'start').at(-1);
    if (lastRun && !stopped.has(lastRun.runId)) {
      const failed = history.findLast(e => e.runId === lastRun.runId && e.kind === 'failed');
      await log('previous_abnormal_exit', { message: '上次没有正常停止', previousRunId: lastRun.runId,
        ...(failed?.failure ? safeProcessingFailure(new OperationFailure(failed.failure.category, '')) : {}) });
    }
    const crashes = history.filter(e => e.kind === 'start' && Date.parse(e.at) >= windowStart && !stopped.has(e.runId));
    if (crashes.length >= (config.service?.restartThreshold ?? 3) && !history.some(e => e.kind === 'alerted' && Date.parse(e.at) >= windowStart)) {
      await updateLedger(dir, at, (_state, add) => add({ kind: 'put', table: 'health', value: { id: 'service', ok: false, episode: `restarts:${crashes[0]!.runId}`, at,
        reason: `personal agent 短时间内反复重启；异常退出 ${crashes.length} 次。运行日志：${logPath}` } }));
      await appendJsonl(runsPath, [{ kind: 'alerted', at, runId, codeVersion } satisfies RunEvent]);
    }
    try { await recordHeartbeat(config, at, runId); }
    catch (error) {
      // 启动时账本损坏/写满也仍进入原有的失败留痕循环，不能让新增心跳把常驻提前打退。
      await reportStorageFailure(config, error, channels);
      await log('heartbeat_pending', { message: '启动心跳暂未写入，保留现场；独立任务可报告无法核实', ...safeProcessingFailure(error) });
    }
    for (const channel of channels) if ('start' in channel && typeof channel.start === 'function') await channel.start();
    if (config.sidebar) {
      sidebar = await startSidebar(config, { now, onAction: notify });
      await log('sidebar_started', { url: sidebar.url }); console.log(`PA 侧边栏：${sidebar.url}`);
    }
    await log('started', { mode: 'loop_events', inspectEveryMs, intakeEveryMs });
    if (config.workspace || config.schedule?.calendarIds.length || config.schedule?.minuteTokens.length || config.schedule?.minuteOwnerIds?.length) {
      sources = (async () => {
        while (!shutdown.signal.aborted) {
          try { await intakeConfiguredSources(config, now(), scheduleReader); }
          catch (error) { await reportStorageFailure(config, error, channels); await log('source_receive_pending', { ...safeProcessingFailure(error) }); }
          await pause(Math.min(config.workspace?.pollEveryMs ?? Infinity, config.schedule?.pollEveryMs ?? Infinity, 1000), shutdown.signal);
        }
      })();
      void sources.catch(() => abort());
    }
    poll = (async () => {
      let sequence = -1, previousClock = now();
      while (!shutdown.signal.aborted) {
        try {
          await intakeLoop(config, now()); intakeHealthy = true;
          await health('intake', true, '', 'source');
          const current = await readLedger(dir), clock = now();
          // 时钟注入也能唤醒核实/巡检，不改系统时间。
          if (sequence !== current.seq || Math.abs(Date.parse(clock) - Date.parse(previousClock)) > intakeEveryMs * 2) notify();
          sequence = current.seq; previousClock = clock;
        } catch (error) {
          intakeHealthy = false;
          await health('intake', false, '来源收件失败；保留原件，未执行材料里的指令', 'source').catch(() => {});
          notify();
          await reportStorageFailure(config, error, channels);
          await log('receive_pending', { message: '收件暂未完成，保留原件并独立重试', ...safeProcessingFailure(error) });
        }
        await pause(intakeEveryMs, shutdown.signal);
      }
    })();
    void poll.catch(() => abort());
    // 渠道drain可能逐条等文字确认超时；不能占住loop接入/账本变更唤醒的调度。
    for (const channel of channels) if ('drain' in channel && typeof channel.drain === 'function') {
      receiveHealthy.set(channel, true);
      const drain = channel.drain.bind(channel);
      const receiver = (async () => {
        while (!shutdown.signal.aborted) {
          try { await drain(now()); receiveHealthy.set(channel, true); await health(`receive:${channel.name}`, true, '', 'source'); }
          catch (error) {
            receiveHealthy.set(channel, false);
            await health(`receive:${channel.name}`, false, `看不见 ${channel.name} 收件：渠道接入实际失败`, 'source').catch(() => {});
            notify();
            await reportStorageFailure(config, error, channels);
            await log('receive_pending', { message: '渠道收件暂未完成，独立重试；loop接入不等待渠道回复', ...safeProcessingFailure(error) });
          }
          await pause(intakeEveryMs, shutdown.signal);
        }
      })();
      receivers.push(receiver); void receiver.catch(() => abort());
    }
    // 最长20分钟的补查/skill独立消费待写，不能占住loop核实和主心跳。
    tasks = (async () => {
      while (!shutdown.signal.aborted) {
        try { await dispatchTasks(config, now(), worker ?? commandWorker(config), shutdown.signal, now); await health('tasks', true, '', 'service'); }
        catch (error) {
          await reportStorageFailure(config, error, channels);
          await health('tasks', false, 'PA 派工处理失败，保留待写和原回执；不盲目重派', 'service').catch(() => {});
          await log('dispatch_failed', { ...safeProcessingFailure(error) });
        }
        await pause(intakeEveryMs, shutdown.signal);
      }
    })();
    void tasks.catch(() => abort());
    let inspectAt = Date.parse(now());
    while (!shutdown.signal.aborted) {
      const clock = now(), inspect = Date.parse(clock) >= inspectAt;
      if (inspect) inspectAt = Date.parse(clock) + inspectEveryMs;
      pending = false;
      const began = performance.now(), timing = { heldMs: 0 };
      await withStorageAlerts(config, channels, async () => {
        let kind = 'scan_completed', result: Record<string, unknown>;
        try {
          const state = await measureStoreLocks(() => processManagedLoop(config, clock, { channels, worker, intake: false, inspect, dispatch: false, now }), timing);
          await health('processing', true, '', 'service');
          await recordHeartbeat(config, now(), runId);
          result = { ledgerSequence: state.seq, inspect };
        } catch (error) {
          await reportStorageFailure(config, error, channels);
          kind = 'scan_failed'; result = { message: '事件处理未完成，保留现场；来源收件仍独立运行', ...safeProcessingFailure(error) };
          if (!['data_corrupt', 'storage_full', 'unsafe_file'].includes(safeProcessingFailure(error).category)) {
            await health('processing', false, `PA 事件处理失败：${safeProcessingFailure(error).category}；请检查运行日志`, 'service').catch(() => {});
            await deliverManagedHealth(config, now(), channels, false, now).catch(() => {});
          }
        }
        await log(kind, { ...result, durationMs: Math.round(performance.now() - began), storeLockHeldMs: Math.round(timing.heldMs) });
        return kind;
      }, kind => kind === 'scan_completed' && intakeHealthy && [...receiveHealthy.values()].every(Boolean));
      let due: number | undefined;
      try { due = await nextManagedDue(dir, now(), config.schedule?.calendarIds ?? []); }
      catch { due = Date.parse(now()) + Math.min(1000, inspectEveryMs); }
      await untilWork(Math.max(50, Math.min(config.heartbeat?.everyMs ?? 30000, Math.min(inspectAt, due ?? Infinity) - Date.parse(now()))));
    }
    await poll; await tasks; await sources; await Promise.all(receivers); normalExit = true;
  } catch (error) {
    const failure = safeProcessingFailure(error);
    await reportStorageFailure(config, error, channels);
    await health('service', false, `PA 自身故障：${failure.category}；服务已退出`, 'service').catch(() => {});
    await deliverManagedHealth(config, now(), channels, false, now).catch(() => {});
    await log('service_failed', { ...failure }).catch(() => {});
    await appendJsonl(runsPath, [{ kind: 'failed', at: now(), runId, failure, codeVersion } satisfies RunEvent]).catch(() => {});
    throw error;
  } finally {
    abort(); signal.removeEventListener('abort', abort);
    if (poll) await poll.catch(() => {});
    if (tasks) await tasks.catch(() => {});
    if (sources) await sources.catch(() => {});
    if (sidebar) await sidebar.close();
    await Promise.allSettled(receivers);
    try {
      for (const channel of channels) if ('stop' in channel && typeof channel.stop === 'function') await channel.stop();
      if (normalExit) {
        await log('stopped'); await appendJsonl(runsPath, [{ kind: 'stop', at: now(), runId, codeVersion } satisfies RunEvent]);
      }
    } finally { await release(); }
  }
}
