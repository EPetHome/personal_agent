import { join } from 'node:path';
import { appendJsonl, readJsonl, readOutbox } from './store.ts';
import { acquireLock } from './locks.ts';
import { OperationFailure } from './failures.ts';
import { iso } from './utils.ts';
import type { ChannelReply, Feedback, Notice } from './types.ts';

const nonJudgment = ['weekly', 'recurrence', 'service_restart'];
/** 成员会话隔离；会话无法定位时绝不退化为整种工具/项目的屏蔽。 */
export function feedbackSuppressionKey(notice: Pick<Notice, 'tool' | 'kind' | 'sessionKey' | 'memberSessionId' | 'feedbackScope'>): string | undefined {
  const scope = notice.feedbackScope ?? (notice.memberSessionId ? `${notice.tool}:${notice.memberSessionId}` : notice.sessionKey);
  return scope ? `${scope}:${notice.kind}` : undefined;
}
export function feedbackSuppressions(rows: Feedback[], notices: Notice[], now: string): Set<string> {
  const lookup = new Map(notices.map(n => [n.id, n]));
  return new Set(rows.flatMap(row => {
    if (row.verdict !== '误报' || row.at > now || !row.noticeId) return [];
    const notice = lookup.get(row.noticeId), key = notice && feedbackSuppressionKey(notice);
    return key ? [key] : [];
  }));
}
export function isFeedbackSuppressed(notice: Notice, suppressions: Set<string>): boolean {
  const key = feedbackSuppressionKey(notice);
  return !!key && suppressions.has(key);
}
function confirmation(feedback: Feedback, notice?: Notice): string {
  if (feedback.verdict === '正确') return '已记下：这次提醒对你有用，不会记成问题。';
  if (feedback.verdict === '误报' && notice && feedbackSuppressionKey(notice)) {
    const reasons: Partial<Record<Notice['kind'], string>> = { waiting: '等你回复或授权', drift: '可能跑偏', stalled: '停滞', blind: '看不见了', unreadable: '会话读不了', loop_paused: 'loop 暂停', loop_completed: 'loop 完成' };
    return `已记下：这个会话之后不会再因为${reasons[notice.kind] ?? '同一种原因'}叫你；这条进了本周的问题汇总。`;
  }
  return `已记下：这条进了本周的问题汇总。${feedback.verdict === '误报' ? '这张提醒未定位到具体会话，不会压住其他会话。' : ''}`;
}

/** 只锁反馈的短读写，不和整轮检测共用数据锁。所有读取也须经此锁，不能读到追加中的半行。 */
async function withFeedbackLock<T>(dataDir: string, operation: () => Promise<T>, waitMs = 30000): Promise<T> {
  const release = await acquireLock(dataDir, '.feedback.lock', waitMs);
  try { return await operation(); } finally { await release(); }
}
async function readFeedbackUnlocked(dataDir: string): Promise<Feedback[]> {
  const rows = await readJsonl<Feedback>(join(dataDir, 'feedback.jsonl'));
  if (rows.some(row => !row || row.version !== 1 || !['正确', '误报', '漏了', '看不懂'].includes(row.verdict)
    || !Number.isFinite(Date.parse(row.at)) || typeof row.comment !== 'string'
    || (row.noticeId !== null && typeof row.noticeId !== 'string'))) throw new OperationFailure('data_corrupt', 'feedback.jsonl 结构损坏；保留现场，请先备份再恢复');
  return rows;
}
export async function readFeedback(dataDir: string): Promise<Feedback[]> {
  return withFeedbackLock(dataDir, () => readFeedbackUnlocked(dataDir));
}
/** 所有渠道共用的收件落盘入口。短锁内保存原卡片和原话；行为从该事实现算，绝不转发给 AI。 */
export async function receiveFeedback(dataDir: string, channel: string, reply: ChannelReply, waitMs = 30000): Promise<string> {
  const at = iso(reply.at);
  const match = /^(正确|误报|漏了|看不懂)(?:\s+([\s\S]*))?$/.exec(reply.content.trim());
  if (!match) throw new OperationFailure('invalid_feedback', '反馈请用「正确 / 误报 / 漏了 / 看不懂」，后面可附一句话');
  return withFeedbackLock(dataDir, async () => {
    const previous = await readFeedbackUnlocked(dataDir); // 损坏/半行先报错，不继续追加事实。
    const all = await readOutbox(dataDir);
    const duplicate = reply.replyId && previous.find(row => row.channel === channel && row.replyId === reply.replyId);
    if (duplicate) return confirmation(duplicate, all.find(n => n.id === duplicate.noticeId));
    const verdict = match[1] as Feedback['verdict'];
    const notices = verdict === '看不懂' ? all : all.filter(n => !nonJudgment.includes(n.kind));
    if (reply.noticeId === null && verdict !== '漏了') throw new OperationFailure('invalid_feedback', '只有「漏了」可以不关联提醒');
    const notice = reply.noticeId === null ? undefined : reply.noticeId ? notices.find(n => n.id === reply.noticeId) : notices.at(-1);
    if (reply.noticeId && !notice) throw new OperationFailure('notice_not_found', '未找到指定提醒，未记录反馈');
    if (!notice && verdict !== '漏了') throw new OperationFailure('notice_not_found', '还没有提醒；漏报可直接回「漏了」');
    const feedback: Feedback = { version: 1, at, date: at.slice(0, 10), channel,
      noticeId: notice?.id ?? null, verdict, comment: match[2]?.trim() ?? '', originalText: reply.content,
      ...(notice ? { card: { title: notice.content.title, firstScreen: notice.content.summary, returnCommand: notice.content.returnCommand, at: notice.at } } : {}),
      ...(reply.replyId ? { replyId: reply.replyId } : {}) };
    await appendJsonl(join(dataDir, 'feedback.jsonl'), [feedback]);
    return confirmation(feedback, notice);
  }, waitMs);
}
