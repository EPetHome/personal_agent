import { receiveFeedback } from '../../core/feedback.ts';
import { runCommand } from '../../core/process.ts';
import type { Channel, Config } from '../../core/types.ts';

/** 固定 AppleScript，标题/正文通过 argv 传入，材料不能变成可执行脚本。 */
const script = 'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run';
export function localChannel(dataDir: string, config: NonNullable<Config['localChannel']>): Channel {
  return {
    name: 'local',
    async send(notice) {
      if (notice.level !== '现在就要你') return;
      await runCommand(config.executable, ['-e', script, '--', notice.content.title, notice.content.summary], config.timeoutMs);
    },
    receive: reply => receiveFeedback(dataDir, 'local', reply),
  };
}
