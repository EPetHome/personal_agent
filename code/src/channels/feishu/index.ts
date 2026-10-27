import { join } from 'node:path';
import { noticeCard } from './card.ts';
import { feishuFailure, realTransport, safeFeishuFailure } from './transport.ts';
import type { FeishuTransport } from './transport.ts';
import { receiveFeedback } from '../../core/feedback.ts';
import { changeExperience } from '../../core/learning.ts';
import { event } from '../../core/events.ts';
import { withNamedLock } from '../../core/locks.ts';
import { appendJsonl, readJsonl, readOutbox, withStoreLock } from '../../core/store.ts';
import { hash, iso } from '../../core/utils.ts';
import type { Channel, Config, FeishuConnection } from '../../core/types.ts';

export interface Incoming {
  id: string; at: string; actor: string; type: 'text' | 'action'; messageId: string;
  ref?: string; text?: string; value?: Record<string, string>; chatType?: string;
}
export interface SentMessage {
  key: string; messageId: string; at: string; noticeId?: string; type: 'interactive' | 'text';
  /** 只有假渠道保留完整发出内容。 */
  content?: unknown;
}
// 动态 JSON 仅停留在 I/O 边界；逐个字段校验后才构成领域 Incoming。
function obj(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function actionValue(raw: unknown): Record<string, string> {
  const input = obj(raw), value: Record<string, string> = {};
  for (const name of ['action', 'verdict', 'noticeId', 'experienceId', 'experienceRevision']) { const text = str(input[name]); if (text && text.length < 200) value[name] = text; }
  return value;
}
/** 同时接受官方原始 envelope 和 SDK 展平事件。只持久化所需字段，不保存 token。 */
export function normalizeIncoming(raw: unknown, type?: string, now = new Date().toISOString()): Incoming | null {
  const envelope = obj(raw), data = obj(envelope.event ?? raw), header = obj(envelope.header);
  const storedType = envelope.type;
  if (storedType === 'text' || storedType === 'action') {
    const id = str(envelope.id), actor = str(envelope.actor), messageId = str(envelope.messageId), at = str(envelope.at);
    if (!id || !actor || !messageId || !at || !Number.isFinite(Date.parse(at))) return null;
    let normalizedAt: string;
    try { normalizedAt = iso(at); } catch { return null; }
    return { id, actor, messageId, at: normalizedAt, type: storedType, text: str(envelope.text), ref: str(envelope.ref), chatType: str(envelope.chatType), value: actionValue(envelope.value) };
  }
  const eventType = type ?? header.event_type ?? envelope.event_type;
  let result: Omit<Incoming, 'id' | 'at'>;
  if (eventType === 'im.message.receive_v1') {
    const message = obj(data.message), sender = obj(data.sender), content = str(message.content);
    if (message.message_type !== 'text' || sender.sender_type !== 'user' || !content || content.length > 20000) return null;
    let text: unknown;
    try { text = obj(JSON.parse(content)).text; } catch { return null; }
    if (typeof text !== 'string' || text.length > 4000) return null;
    result = { type: 'text', actor: str(obj(sender.sender_id).open_id) ?? '', messageId: str(message.message_id) ?? '', chatType: str(message.chat_type), text, ref: str(message.parent_id) || str(message.root_id) };
  } else if (eventType === 'card.action.trigger') {
    const action = obj(data.action), context = obj(data.context);
    result = { type: 'action', actor: str(obj(data.operator).open_id) ?? '', messageId: str(context.open_message_id) ?? str(data.open_message_id) ?? '', value: actionValue(action.value) };
  } else return null;
  if (!result.actor || !result.messageId) return null;
  const timestamp = header.create_time ?? envelope.create_time ?? obj(data.message).create_time;
  const numeric = typeof timestamp === 'string' || typeof timestamp === 'number' ? Number(timestamp) : NaN;
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  const id = str(header.event_id) || str(envelope.event_id) || hash(JSON.stringify([str(data.token) ?? '', result, timestamp ?? '']));
  return { ...result, at: date.toISOString(), id };
}
export interface FeishuChannel extends Channel {
  capture(raw: unknown, eventType?: string): Promise<Record<string, never>>;
  drain(now?: string): Promise<number>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export function feishuChannel(config: Config, injected?: FeishuTransport): FeishuChannel {
  const options = config.feishu;
  if (!options) throw new Error('请先配置 feishu');
  const dir = config.dataDir, sentPath = join(dir, 'feishu-sent.jsonl'), inbox = join(dir, 'feishu-inbox.jsonl');
  let transport: Promise<FeishuTransport> | undefined;
  const getTransport = () => transport ??= injected ? Promise.resolve(injected) : realTransport(options);
  let ingress: Promise<unknown> = Promise.resolve();
  let draining: Promise<number> | undefined;
  let stopped = false;
  let connectionWrites: Promise<void> = Promise.resolve();
  let connectionSignature: string | undefined;
  function reportConnection(input: FeishuConnection): Promise<void> {
    if (stopped && input.state !== 'stopped') return connectionWrites;
    const state = ['connecting', 'connected', 'reconnecting', 'failed', 'stopped', 'fake'].includes(input.state) ? input.state : 'failed';
    const connection: FeishuConnection = { state, ...(input.failure ? { failure: feishuFailure(input.failure.category) } : {}) };
    const signature = JSON.stringify(connection);
    if (signature === connectionSignature) return connectionWrites;
    connectionSignature = signature;
    connectionWrites = connectionWrites.catch(() => {}).then(() => withStoreLock(dir, async () => {
      const at = new Date().toISOString(), logPath = join(dir, 'service.log.jsonl');
      await readJsonl(logPath);
      await appendJsonl(join(dir, 'events.jsonl'), [event({ kind: 'feishu_connection', connection }, at)]);
      await appendJsonl(logPath, [{ at, kind: connection.state === 'failed' ? 'feishu_connection_failed' : 'feishu_connection',
        state: connection.state, ...(connection.failure ?? {}) }]);
    }, 30000));
    void connectionWrites.catch(() => { if (connectionSignature === signature) connectionSignature = undefined; });
    return connectionWrites;
  }
  async function send(type: 'interactive' | 'text', content: unknown, key: string, noticeId?: string) {
    await withNamedLock(dir, '.feishu-send.lock', async () => {
      const history = await readJsonl<SentMessage>(sentPath);
      if (history.some(row => row.key === key)) return;
      const requestKey = hash(key);
      let messageId: string;
      if (options!.mode === 'fake' && !injected) messageId = `om_fake_${requestKey.slice(0, 24)}`;
      else {
        let timer: NodeJS.Timeout | undefined;
        try { messageId = await Promise.race([(await getTransport()).send(type, JSON.stringify(content), requestKey), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('飞书投递超时')), options!.timeoutMs); })]); }
        catch { throw new Error('飞书投递失败或超时（凭证不输出）'); }
        finally { clearTimeout(timer); }
      }
      await appendJsonl(sentPath, [{ key, messageId, at: new Date().toISOString(), type, ...(noticeId ? { noticeId } : {}), ...(options!.mode === 'fake' ? { content } : {}) } satisfies SentMessage]);
    });
  }
  async function handle(input: Incoming) {
    if (input.actor !== options!.receiverId || (input.type === 'text' && input.chatType !== 'p2p')) return;
    const sent = await readJsonl<SentMessage>(sentPath);
    const mapped = sent.find(row => row.messageId === (input.type === 'action' ? input.messageId : input.ref));
    let response = '已记下';
    if (input.type === 'action') {
      const value = input.value ?? {};
      if (!mapped?.noticeId) return;
      const notice = (await readOutbox(dir)).find(n => n.id === mapped.noticeId);
      if (!notice) return;
      if (value.action === 'feedback' && value.noticeId === notice.id && ['正确', '误报'].includes(value.verdict ?? '') && !['weekly', 'recurrence', 'service_restart'].includes(notice.kind)) {
        await receiveFeedback(dir, 'feishu', { noticeId: notice.id, content: value.verdict!, at: input.at, replyId: input.id });
      } else if (['agree', 'revise'].includes(value.action ?? '')) {
        const review = notice.reviews?.find(item => item.experienceId === value.experienceId);
        if (!review) return;
        if (!review.experienceRevision || value.experienceRevision !== review.experienceRevision) response = '这张复盘卡片已过期，未修改经验。请查看最新复盘或使用本机 experience 命令。';
        else {
          const result = await changeExperience(dir, review.experienceId, value.action === 'agree' ? '已确认' : '待确认', undefined, input.at, `feishu:${input.id}`, review.experienceRevision);
          if (result === 'stale') response = '这张复盘卡片已过期，未修改经验。请查看最新复盘或使用本机 experience 命令。';
          else if (result === 'inactive') response = '这条经验已过时或撤销，未修改经验。';
          else if (value.action === 'revise') response = '已记下，已退回待确认。请用本机 experience 命令修改归因或对策后确认。';
        }
      } else return;
    } else {
      if (!/^(正确|误报|漏了)(?:\s|$)/.test(input.text ?? '')) response = '请引用提醒回复「正确 / 误报」，或直接发「漏了 + 一句话」。';
      else if (input.text!.startsWith('漏了') && !input.ref) await receiveFeedback(dir, 'feishu', { noticeId: null, content: input.text!, at: input.at, replyId: input.id });
      else if (!mapped?.noticeId) response = '没有找到被引用的提醒，请引用机器人发出的提醒再回复。';
      else if (['weekly', 'recurrence', 'service_restart'].includes((await readOutbox(dir)).find(n => n.id === mapped.noticeId)?.kind ?? '')) response = '这条不是盯防提醒，请使用卡片按钮或本机 experience 命令。';
      else await receiveFeedback(dir, 'feishu', { noticeId: mapped.noticeId, content: input.text!, at: input.at, replyId: input.id });
    }
    await send('text', { text: response }, `reply:${input.id}`);
  }
  const channel: FeishuChannel = {
    name: 'feishu', levels: ['现在就要你', '有空看'],
    send: notice => send('interactive', noticeCard(notice), `notice:${notice.id}`, notice.id),
    receive: reply => receiveFeedback(dir, 'feishu', reply),
    async capture(raw, type) {
      if (stopped) return {};
      const input = normalizeIncoming(raw, type);
      if (!input || input.actor !== options.receiverId || (input.type === 'text' && input.chatType !== 'p2p')) return {};
      // 先仅持久化最小入站事实；不等反馈处理、模型或发送 API。
      // 2.5 秒内不能持久化就拒绝处理器，让 SDK/平台重投，不能先成功确认再丢反馈。
      const saved = ingress.catch(() => {}).then(() => withNamedLock(dir, '.feishu-inbound.lock', async () => {
        await readJsonl(inbox); await appendJsonl(inbox, [input]);
      }));
      ingress = saved;
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([saved, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('入站暂未持久化，请重试')), 2500); })]); }
      finally { clearTimeout(timer); }
      setImmediate(() => { void channel.drain().catch(() => {}); });
      return {};
    },
    drain(now) {
      if (draining) return draining;
      draining = withNamedLock(dir, '.feishu-receive.lock', async () => {
        await connectionWrites;
        const inputs = await withNamedLock(dir, '.feishu-inbound.lock', () => readJsonl<unknown>(inbox));
        const receiptsPath = join(dir, 'feishu-receipts.jsonl');
        const receipts = new Set((await readJsonl<{ id: string }>(receiptsPath)).map(row => row.id));
        let count = 0;
        for (const raw of inputs) {
          const input = normalizeIncoming(raw, undefined, now);
          if (!input || receipts.has(input.id)) continue;
          await handle(input);
          await appendJsonl(receiptsPath, [{ id: input.id, at: now ?? new Date().toISOString() }]);
          receipts.add(input.id); count++;
        }
        return count;
      }).finally(() => { draining = undefined; });
      return draining;
    },
    async start() {
      stopped = false;
      await reportConnection({ state: options.mode === 'fake' && !injected ? 'fake' : 'connecting' });
      if (options.mode === 'real' || injected) {
        try {
          await (await getTransport()).start?.({
            'im.message.receive_v1': raw => channel.capture(raw, 'im.message.receive_v1'),
            'card.action.trigger': raw => channel.capture(raw, 'card.action.trigger'),
          }, state => { void reportConnection(state); });
        } catch (error) { await reportConnection({ state: 'failed', failure: safeFeishuFailure(error) }); }
      }
      await connectionWrites;
    },
    async stop() {
      stopped = true;
      if (transport) { const ready = await transport.catch(() => undefined); ready?.stop?.(); }
      await ingress; if (draining) await draining; await channel.drain();
      await reportConnection({ state: 'stopped' });
    },
  };
  return channel;
}
