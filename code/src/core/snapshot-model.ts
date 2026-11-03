import { ComponentFailure } from './process.ts';
import { piJudge, snapshotReplay } from './model.ts';
import { protectReplay } from './replay.ts';
import { modelSnapshot, noticeSnapshotKey, standaloneSnapshot } from './task-snapshot.ts';
import type { Config, EventPayload, Judge, ModelReplay, Notice, Projection, TaskSnapshotInput } from './types.ts';

async function timedModel<T>(call: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => call(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new ComponentFailure('timeout', '卡片起草超时')); controller.abort(); }, Math.max(1, milliseconds));
    })]);
  } finally { clearTimeout(timer); }
}
/** 只处理 loop 新卡片。调用者持模型锁，persist 短持数据锁；模型等待绝不持数据锁。 */
export async function checkSnapshotModels(notices: Notice[], projection: Projection, config: Config, now: string,
  persist: (payload: EventPayload) => Promise<boolean | void>, injected?: Judge, deadline = Infinity): Promise<number> {
  if (!config.judge) return 0;
  const judge = injected ?? piJudge(config.judge);
  if (!judge.writeSnapshot) return 0;
  let written = 0;
  const day = now.slice(0, 10);
  for (const notice of notices.filter(notice => notice.tool === 'loop' && standaloneSnapshot(notice))) {
    const key = noticeSnapshotKey(notice);
    if (!notice.snapshot || projection.noticeSnapshots.has(key)) continue;
    const { goal, currentTask, lastOutput, factualStatus } = notice.snapshot;
    const input: TaskSnapshotInput = { goal, currentTask, lastOutput, factualStatus };
    let snapshot = notice.snapshot;
    let replay: ModelReplay | undefined;
    const used = projection.modelCalls.get(day) ?? 0;
    if (used < (config.judge.dailyLimit ?? Infinity) && Date.now() < deadline
      && await persist({ kind: 'model_call_started', task: 'snapshot', key }) !== false) {
      projection.modelCalls.set(day, used + 1);
      replay = protectReplay(snapshotReplay(config.judge, input), [{ kind: 'notice_snapshot', key, data: input }]);
      try {
        const result = await timedModel(signal => judge.writeSnapshot!(input, { signal }), Math.min(config.judge.timeoutMs, deadline - Date.now()));
        snapshot = modelSnapshot(input, result, notice.content.evidence.project ?? '', now) ?? snapshot;
      } catch { /* 不可用/超时/坏答案都照发规则卡片；同一事实不重花调用。 */ }
    }
    await persist({ kind: 'notice_snapshot_written', key, snapshot, ...(replay ? { replay } : {}) });
    projection.noticeSnapshots.set(key, snapshot);
    written++;
  }
  return written;
}
