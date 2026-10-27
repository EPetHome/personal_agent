import { appendOutbox, readOutbox } from '../../core/store.ts';
import { receiveFeedback } from '../../core/feedback.ts';
import type { Channel, Notice } from '../../core/types.ts';

/** 假渠道：不执行命令、不调用系统通知/网络；写入成功才算交付。 */
export function fileChannel(dataDir: string): Channel {
  let known: Set<string> | undefined;
  return {
    name: 'file',
    async send(notice: Notice) {
      known ??= new Set((await readOutbox(dataDir)).map(row => row.id));
      if (!known.has(notice.id)) {
        await appendOutbox(dataDir, notice);
        known.add(notice.id);
      }
    },
    receive: reply => receiveFeedback(dataDir, 'file', reply),
  };
}
