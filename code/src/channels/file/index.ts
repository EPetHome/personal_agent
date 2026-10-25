import { join } from 'node:path';
import { appendJsonl, readOutbox } from '../../core/store.ts';
import type { Channel, Notice } from '../../core/types.ts';

/** 假渠道：不执行命令、不调用系统通知/网络；写入成功才算交付。 */
export function fileChannel(dataDir: string): Channel {
  return {
    name: 'file',
    async send(notices: Notice[]) {
      const known = new Set((await readOutbox(dataDir)).map(notice => notice.id));
      const missing: Notice[] = [];
      for (const notice of notices) {
        if (known.has(notice.id)) continue;
        missing.push(notice);
        known.add(notice.id);
      }
      await appendJsonl(join(dataDir, 'outbox.jsonl'), missing);
      return missing.length;
    },
  };
}
