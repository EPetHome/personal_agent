import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { assertRegularFile } from '../../core/config.ts';
import type { FeishuConfig, FeishuConnection, FeishuFailureCategory } from '../../core/types.ts';

export interface FeishuTransport {
  send(type: 'interactive' | 'text', content: string, key: string): Promise<string>;
  start?(handlers: Record<string, (raw: unknown) => unknown>, connection?: (state: FeishuConnection) => void): void | Promise<void>;
  stop?(): void;
}
const descriptions: Record<FeishuFailureCategory, string> = {
  credentials: '凭证不正确或缺失，请检查应用 ID 和密钥',
  permission: '应用权限不足或未获准使用长连接，请检查应用发布与权限',
  network: '网络连接失败，请检查网络、DNS 或代理后等待重连',
  configuration: '长连接配置不可用，请检查应用类型与连接配置',
  unknown: '连接失败，现有信息无法确定原因，请检查应用配置与网络',
};
export function feishuFailure(category: FeishuFailureCategory): NonNullable<FeishuConnection['failure']> {
  const safe = Object.hasOwn(descriptions, category) ? category : 'unknown';
  return { category: safe, message: descriptions[safe] };
}
class ConnectionFailure extends Error {
  readonly failure: NonNullable<FeishuConnection['failure']>;
  constructor(category: FeishuFailureCategory) { const failure = feishuFailure(category); super(failure.message); this.failure = failure; }
}
/** 上游内容只参与内存中的类别识别；返回值全部来自固定白名单，不复制报文/URL/凭证。 */
export function safeFeishuFailure(error: unknown): NonNullable<FeishuConnection['failure']> {
  if (error instanceof ConnectionFailure) return error.failure;
  const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const data = obj(error), response = obj(data.response), body = obj(response.data);
  const text = [typeof error === 'string' ? error : '', data.message, body.msg, body.message].filter(v => typeof v === 'string').join(' ');
  const code = String(body.code ?? data.code ?? /code\s*[:=]\s*(\d+)/i.exec(text)?.[1] ?? '');
  const status = Number(response.status ?? data.status);
  // SDK 的网络异常只留 message 时，明确错误码优先于报文中的泛化凭证词。
  if (/^(?:EAI_AGAIN|E[A-Z]*(?:CONN|NET|HOST)[A-Z]*|ENOTFOUND|ETIMEDOUT)$/.test(code)
    || /\b(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b/.test(text)) return feishuFailure('network');
  if (status === 403 || code === '403' || /permission|forbidden|access denied|权限|无权/i.test(text)) return feishuFailure('permission');
  if (status === 401 || ['514', '99991661', '99991663', '99991664'].includes(code)
    || /credential|auth(?:entication)?[_ ]?fail|invalid.*(?:app.?id|secret|token)|(?:app.?id|secret|token).*(?:invalid|incorrect|missing)|凭证|密钥/i.test(text)) return feishuFailure('credentials');
  if (/network|socket|websocket.*(?:error|failed|exhausted)|connect(?:ion)? (?:failed|refused)|handshake timeout|timeout|timed out|dns|网络/i.test(text)) return feishuFailure('network');
  if (data.name === 'ConnectionConfigError' || /configuration|config.*invalid|invalid.*config|应用类型|连接配置/i.test(text)) return feishuFailure('configuration');
  return feishuFailure('unknown');
}
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error(..._args: unknown[]) {} };
type Sdk = typeof import('@larksuiteoapi/node-sdk');
/** 替身入口只供离线验证；正常运行仅从显式 .env/进程环境取凭证，假渠道永不调用。 */
export async function realTransport(config: FeishuConfig, dependencies: {
  credentials?: { appId: string; appSecret: string };
  loadSdk?: () => Promise<Sdk>;
} = {}): Promise<FeishuTransport> {
  try {
    let credentials = dependencies.credentials;
    if (!credentials) {
      let file: NodeJS.Dict<string> = {};
      if (config.envFile) { await assertRegularFile(config.envFile); file = parseEnv(await readFile(config.envFile, 'utf8')); }
      credentials = { appId: process.env.FEISHU_APP_ID ?? file.FEISHU_APP_ID ?? '', appSecret: process.env.FEISHU_APP_SECRET ?? file.FEISHU_APP_SECRET ?? '' };
    }
    const { appId, appSecret } = credentials;
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId) || !appSecret) throw new ConnectionFailure('credentials');
    const sdk = await (dependencies.loadSdk?.() ?? import('@larksuiteoapi/node-sdk'));
    const client = new sdk.Client({ appId, appSecret, appType: sdk.AppType.SelfBuild, logger: quiet });
    let ws: InstanceType<Sdk['WSClient']> | undefined;
    let stopped = false;
    return {
      async send(type, content, key) {
        const result = await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: config.receiverId, msg_type: type, content, uuid: key.slice(0, 32) } });
        if (result.code !== 0 || !result.data?.message_id) throw new Error('飞书投递失败');
        return result.data.message_id;
      },
      start(handlers, connection = () => {}) {
        stopped = false;
        const report = (state: FeishuConnection) => { if (!stopped) connection(state); };
        const failed = (error: unknown) => report({ state: 'failed', failure: safeFeishuFailure(error) });
        // SDK 的一部分启动/重连失败只记 logger、不 reject 或触发 onError；也必须记录。
        const logger = { ...quiet, error(...args: unknown[]) {
          // 锁定 SDK 的 LoggerProxy.error 会把变参包装成单个数组；也兼容直接调用。
          const messages: unknown[] = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
          if (messages[0] !== '[ws]' || messages.some(arg => typeof arg === 'string' && /invoke event|send data|merge event/.test(arg))) return;
          failed(messages.filter(arg => typeof arg === 'string').join(' '));
        } };
        try {
          ws = new sdk.WSClient({ appId, appSecret, logger, handshakeTimeoutMs: config.timeoutMs,
            onReady: () => report({ state: 'connected' }), onReconnected: () => report({ state: 'connected' }),
            onReconnecting: () => report({ state: 'reconnecting', failure: feishuFailure('network') }), onError: failed,
          });
          const dispatcher = new sdk.EventDispatcher({ logger: quiet }).register(handlers);
          return Promise.resolve().then(() => ws!.start({ eventDispatcher: dispatcher })).catch(failed);
        } catch (error) { failed(error); }
      },
      stop() { stopped = true; ws?.close({ force: true }); },
    };
  } catch (error) { throw new ConnectionFailure(safeFeishuFailure(error).category); }
}
