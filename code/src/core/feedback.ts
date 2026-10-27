import { join } from 'node:path';
import { appendJsonl, readJsonl, readOutbox, withStoreLock } from './store.ts';
import { iso } from './utils.ts';
import type { ChannelReply, Feedback } from './types.ts';

/** 所有渠道共用的收件落盘入口。只记反馈，绝不转发给 AI。 */
export async function readFeedback(dataDir: string): Promise<Feedback[]> {
  const rows = await readJsonl<Feedback>(join(dataDir, 'feedback.jsonl'));
  if (rows.some(row => !row || row.version !== 1 || !['正确', '误报', '漏了'].includes(row.verdict)
    || !Number.isFinite(Date.parse(row.at)) || typeof row.comment !== 'string'
    || (row.noticeId !== null && typeof row.noticeId !== 'string'))) throw new Error('feedback.jsonl 结构损坏；保留现场，请先备份再恢复');
  return rows;
}
export async function receiveFeedback(dataDir: string, channel: string, reply: ChannelReply, waitMs = 30000): Promise<'已记下'> {
  const at = iso(reply.at);
  const match = /^(正确|误报|漏了)(?:\s+([\s\S]*))?$/.exec(reply.content.trim());
  if (!match) throw new Error('反馈请用「正确 / 误报 / 漏了」，后面可附一句话');
  return withStoreLock<'已记下'>(dataDir, async () => {
    const notices = (await readOutbox(dataDir)).filter(n => !['weekly', 'recurrence', 'service_restart'].includes(n.kind));
    const verdict = match[1] as Feedback['verdict'];
    if (reply.noticeId === null && verdict !== '漏了') throw new Error('只有「漏了」可以不关联提醒');
    const notice = reply.noticeId === null ? undefined : reply.noticeId ? notices.find(n => n.id === reply.noticeId) : notices.at(-1);
    if (reply.noticeId && !notice) throw new Error('未找到指定提醒，未记录反馈');
    if (!notice && verdict !== '漏了') throw new Error('还没有提醒；漏报可直接回「漏了」');
    const feedback: Feedback = { version: 1, at, date: at.slice(0, 10), channel,
      noticeId: notice?.id ?? null, verdict, comment: match[2]?.trim() ?? '', ...(reply.replyId ? { replyId: reply.replyId } : {}) };
    const previous = await readFeedback(dataDir); // 损坏/半行先报错，不继续追加事实。
    if (reply.replyId && previous.some(row => row.channel === channel && row.replyId === reply.replyId)) return '已记下';
    await appendJsonl(join(dataDir, 'feedback.jsonl'), [feedback]);
    return '已记下';
  }, waitMs);
}
