import { join } from 'node:path';
import { appendJsonl, readJsonl, readOutbox, withStoreLock } from './store.ts';
import { iso } from './utils.ts';
import type { ChannelReply, Feedback } from './types.ts';

/** 所有渠道共用的收件落盘入口。只记反馈，绝不转发给 AI。 */
export async function receiveFeedback(dataDir: string, channel: string, reply: ChannelReply): Promise<'已记下'> {
  const at = iso(reply.at);
  const match = /^(正确|误报|漏了)(?:\s+([\s\S]*))?$/.exec(reply.content.trim());
  if (!match) throw new Error('反馈请用「正确 / 误报 / 漏了」，后面可附一句话');
  return withStoreLock<'已记下'>(dataDir, async () => {
    const notices = await readOutbox(dataDir);
    const verdict = match[1] as Feedback['verdict'];
    if (reply.noticeId === null && verdict !== '漏了') throw new Error('只有「漏了」可以不关联提醒');
    const notice = reply.noticeId === null ? undefined : reply.noticeId ? notices.find(n => n.id === reply.noticeId) : notices.at(-1);
    if (reply.noticeId && !notice) throw new Error('未找到指定提醒，未记录反馈');
    if (!notice && verdict !== '漏了') throw new Error('还没有提醒；漏报可直接回「漏了」');
    const feedback: Feedback = { version: 1, at, date: at.slice(0, 10), channel,
      noticeId: notice?.id ?? null, verdict, comment: match[2]?.trim() ?? '' };
    await readJsonl<Feedback>(join(dataDir, 'feedback.jsonl')); // 损坏/半行先报错，不继续追加事实。
    await appendJsonl(join(dataDir, 'feedback.jsonl'), [feedback]);
    return '已记下';
  });
}
