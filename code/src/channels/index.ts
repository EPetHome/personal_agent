import { feishuChannel } from './feishu/index.ts';
import { localChannel } from './local/index.ts';
import type { Channel, Config, Notice } from '../core/types.ts';

export function configuredChannels(config: Config, managed = false): Channel[] {
  return [...(config.localChannel ? [localChannel(config.dataDir, config.localChannel)] : []), ...(config.feishu ? [feishuChannel(config, undefined, { managed })] : [])];
}
export function accepts(channel: Channel, notice: Notice): boolean {
  return (channel.levels ?? ['现在就要你']).includes(notice.level)
    && (!notice.delivery || !['local', 'feishu'].includes(channel.name)
      || notice.delivery.channels.some(name => name === channel.name));
}
