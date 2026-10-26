import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { assertRegularFile } from '../../core/config.ts';
import type { FeishuConfig } from '../../core/types.ts';

export interface FeishuTransport {
  send(type: 'interactive' | 'text', content: string, key: string): Promise<string>;
  start?(handlers: Record<string, (raw: unknown) => unknown>): void;
  stop?(): void;
}
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
/** 不改 process.env，不把凭证传给模型子进程或输出 SDK 错误。假渠道永不调用。 */
export async function realTransport(config: FeishuConfig): Promise<FeishuTransport> {
  let file: NodeJS.Dict<string> = {};
  try {
    if (config.envFile) { await assertRegularFile(config.envFile); file = parseEnv(await readFile(config.envFile, 'utf8')); }
    const appId = process.env.FEISHU_APP_ID ?? file.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET ?? file.FEISHU_APP_SECRET;
    if (!appId || !appSecret) throw new Error();
    const sdk = await import('@larksuiteoapi/node-sdk');
    const client = new sdk.Client({ appId, appSecret, appType: sdk.AppType.SelfBuild, logger: quiet });
    const ws = new sdk.WSClient({ appId, appSecret, logger: quiet, handshakeTimeoutMs: config.timeoutMs });
    return {
      async send(type, content, key) {
        const result = await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: config.receiverId, msg_type: type, content, uuid: key.slice(0, 32) } });
        if (result.code !== 0 || !result.data?.message_id) throw new Error('飞书投递失败');
        return result.data.message_id;
      },
      start(handlers) {
        const dispatcher = new sdk.EventDispatcher({ logger: quiet }).register(handlers);
        void ws.start({ eventDispatcher: dispatcher }).catch(() => {});
      },
      stop() { ws.close({ force: true }); },
    };
  } catch { throw new Error('飞书初始化失败；请检查环境变量或已忽略的 .env、应用配置与网络（凭证不输出）'); }
}
