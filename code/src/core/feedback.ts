import { join } from 'node:path';
import { appendJsonl, readJsonl, readOutbox } from './store.ts';
import { acquireLock } from './locks.ts';
import { OperationFailure } from './failures.ts';
import { iso } from './utils.ts';
import type { ChannelReply, Feedback } from './types.ts';

/** 只锁反馈的短读写，不和整轮检测共用数据锁。所有读取也须经此锁，不能读到追加中的半行。 */
async function withFeedbackLock<T>(dataDir: string, operation: () => Promise<T>, waitMs = 30000): Promise<T> {
  const release = await acquireLock(dataDir, '.feedback.lock', waitMs);
  try { return await operation(); } finally { await release(); }
}
async function readFeedbackUnlocked(dataDir: string): Promise<Feedback[]> {
  const rows = await readJsonl<Feedback>(join(dataDir, 'feedback.jsonl'));
  if (rows.some(row => !row || row.version !== 1 || !['正确', '误报', '漏了'].includes(row.verdict)
    || !Number.isFinite(Date.parse(row.at)) || typeof row.comment !== 'string'
    || (row.noticeId !== null && typeof row.noticeId !== 'string'))) throw new OperationFailure('data_corrupt', 'feedback.jsonl 结构损坏；保留现场，请先备份再恢复');
  return rows;
}
export async function readFeedback(dataDir: string): Promise<Feedback[]> {
  return withFeedbackLock(dataDir, () => readFeedbackUnlocked(dataDir));
}
/** 所有渠道共用的收件落盘入口。只记反馈，绝不转发给 AI。 */
export async function receiveFeedback(dataDir: string, channel: string, reply: ChannelReply, waitMs = 30000): Promise<'已记下'> {
  const at = iso(reply.at);
  const match = /^(正确|误报|漏了)(?:\s+([\s\S]*))?$/.exec(reply.content.trim());
  if (!match) throw new OperationFailure('invalid_feedback', '反馈请用「正确 / 误报 / 漏了」，后面可附一句话');
  return withFeedbackLock<'已记下'>(dataDir, async () => {
    const previous = await readFeedbackUnlocked(dataDir); // 损坏/半行先报错，不继续追加事实。
    if (reply.replyId && previous.some(row => row.channel === channel && row.replyId === reply.replyId)) return '已记下';
    const notices = (await readOutbox(dataDir)).filter(n => !['weekly', 'recurrence', 'service_restart'].includes(n.kind));
    const verdict = match[1] as Feedback['verdict'];
    if (reply.noticeId === null && verdict !== '漏了') throw new OperationFailure('invalid_feedback', '只有「漏了」可以不关联提醒');
    const notice = reply.noticeId === null ? undefined : reply.noticeId ? notices.find(n => n.id === reply.noticeId) : notices.at(-1);
    if (reply.noticeId && !notice) throw new OperationFailure('notice_not_found', '未找到指定提醒，未记录反馈');
    if (!notice && verdict !== '漏了') throw new OperationFailure('notice_not_found', '还没有提醒；漏报可直接回「漏了」');
    const feedback: Feedback = { version: 1, at, date: at.slice(0, 10), channel,
      noticeId: notice?.id ?? null, verdict, comment: match[2]?.trim() ?? '', ...(reply.replyId ? { replyId: reply.replyId } : {}) };
    await appendJsonl(join(dataDir, 'feedback.jsonl'), [feedback]);
    return '已记下';
  }, waitMs);
}
