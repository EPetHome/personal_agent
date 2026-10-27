import { timedModel } from './model-checks.ts';
import { piJudge } from './model.ts';
import { modelSnapshot, noticeSnapshotKey, standaloneSnapshot } from './task-snapshot.ts';
import type { Config, EventPayload, Judge, Notice, Projection, TaskSnapshotInput } from './types.ts';

/** 仅处理尚未计划过的新卡片。调用者持模型锁，persist 短持数据锁；模型等待绝不持数据锁。 */
export async function checkSnapshotModels(notices: Notice[], projection: Projection, config: Config, now: string,
  persist: (payload: EventPayload) => Promise<boolean | void>, injected?: Judge, deadline = Infinity): Promise<number> {
  if (!config.judge) return 0;
  const judge = injected ?? piJudge(config.judge);
  if (!judge.writeSnapshot) return 0;
  let written = 0;
  const day = now.slice(0, 10);
  for (const notice of notices.filter(standaloneSnapshot)) {
    const key = noticeSnapshotKey(notice);
    if (!notice.snapshot || projection.noticeSnapshots.has(key)) continue;
    const { goal, currentTask, lastOutput, factualStatus } = notice.snapshot;
    const input: TaskSnapshotInput = { goal, currentTask, lastOutput, factualStatus };
    let snapshot = notice.snapshot;
    const used = projection.modelCalls.get(day) ?? 0;
    if (used < config.judge.dailyLimit && Date.now() < deadline
      && await persist({ kind: 'model_call_started', task: 'snapshot', key }) !== false) {
      projection.modelCalls.set(day, used + 1);
      try {
        const result = await timedModel(signal => judge.writeSnapshot!(input, { signal }), Math.min(config.judge.timeoutMs, deadline - Date.now()));
        snapshot = modelSnapshot(input, result, notice.content.evidence.project ?? '', now) ?? snapshot;
      } catch { /* 不可用/超时/坏答案都照发规则卡片；同一事实不重花调用。 */ }
    }
    await persist({ kind: 'notice_snapshot_written', key, snapshot });
    projection.noticeSnapshots.set(key, snapshot);
    written++;
  }
  return written;
}
