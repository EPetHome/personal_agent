import { join } from 'node:path';
import { noticeCard } from './card.ts';
import { feishuFailure, realTransport, safeFeishuFailure } from './transport.ts';
import type { FeishuTransport } from './transport.ts';
import { receiveFeedback } from '../../core/feedback.ts';
import { safeProcessingFailure } from '../../core/failures.ts';
import { changeExperience } from '../../core/learning.ts';
import { event } from '../../core/events.ts';
import { prepareEventLog } from '../../core/event-archive.ts';
import { withNamedLock } from '../../core/locks.ts';
import { appendJsonl, readJsonl, readOutbox, withStoreLock } from '../../core/store.ts';
import { hash, iso } from '../../core/utils.ts';
import type { Channel, Config, FeishuConnection } from '../../core/types.ts';

export interface Incoming {
  id: string; at: string; actor: string; type: 'text' | 'action'; messageId: string;
  ref?: string; text?: string; value?: Record<string, string>; chatType?: string;
  timeNote?: string;
}
interface Receipt {
  id: string; at: string; status?: 'processed' | 'failed'; category?: string;
  response?: string; reply?: 'sent' | 'pending'; replyCategory?: 'reply_delivery'; timeNote?: string;
}
class IncomingFailure extends Error {
  readonly category: string;
  constructor(category: string, reason: string) { super(reason); this.category = category; }
}
const TIME_FALLBACK = '事件时间缺失或明显不合理，已改用收到的时间。';
function incomingTime(value: unknown, now: string, stored = false): { at: string; timeNote?: string } {
  const numeric = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  const milliseconds = stored ? Date.parse(String(value)) : numeric < 1e11 ? numeric * 1000 : numeric < 1e14 ? numeric : numeric / 1000;
  // 飞书可能使用秒、毫秒或微秒。过远的未来和早于服务存在的年代都不能进入反馈日期。
  if (!Number.isFinite(milliseconds) || milliseconds < Date.UTC(2000, 0, 1) || milliseconds > Date.parse(now) + 86400000)
    return { at: iso(now), timeNote: TIME_FALLBACK };
  return { at: iso(new Date(milliseconds).toISOString()) };
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
    if (!id || !actor || !messageId || !at) return null;
    return { id, actor, messageId, ...incomingTime(at, now, true), ...(envelope.timeNote === TIME_FALLBACK ? { timeNote: TIME_FALLBACK } : {}), type: storedType, text: str(envelope.text), ref: str(envelope.ref), chatType: str(envelope.chatType), value: actionValue(envelope.value) };
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
  const id = str(header.event_id) || str(envelope.event_id) || hash(JSON.stringify([str(data.token) ?? '', result, timestamp ?? '']));
  return { ...result, ...incomingTime(timestamp, now), id };
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
  let connectionWrite: Promise<void> | undefined;
  let connectionSignature: string | undefined;
  let desiredConnection: FeishuConnection | undefined;
  let connectionRetry: NodeJS.Timeout | undefined;
  // 展示状态另行重试：不排在收件前面，也不等检测持有的数据锁。
  function flushConnection(): Promise<void> {
    if (connectionWrite) return connectionWrite;
    connectionWrite = (async () => {
      while (desiredConnection && JSON.stringify(desiredConnection) !== connectionSignature) {
        const connection = desiredConnection, signature = JSON.stringify(connection);
        try {
          await withStoreLock(dir, async () => {
            const at = new Date().toISOString(), logPath = join(dir, 'service.log.jsonl');
            await readJsonl(logPath);
            // 首笔连接事件也先完成格式准备，避免全新目录被下一轮误认成需迁移的旧库。
            await prepareEventLog(dir, at);
            await appendJsonl(join(dir, 'events.jsonl'), [event({ kind: 'feishu_connection', connection }, at)]);
            await appendJsonl(logPath, [{ at, kind: connection.state === 'failed' ? 'feishu_connection_failed' : 'feishu_connection',
              state: connection.state, ...(connection.failure ?? {}) }]);
          });
          connectionSignature = signature;
        } catch { break; } // 只保留最新待写状态；失败的 Promise 绝不留给检测/收件。
      }
    })().finally(() => {
      connectionWrite = undefined;
      if (!stopped && desiredConnection && JSON.stringify(desiredConnection) !== connectionSignature && !connectionRetry) {
        connectionRetry = setTimeout(() => { connectionRetry = undefined; void flushConnection(); }, 1000);
        connectionRetry.unref();
      }
    });
    return connectionWrite;
  }
  function reportConnection(input: FeishuConnection): Promise<void> {
    if (stopped && input.state !== 'stopped') return Promise.resolve();
    const state = ['connecting', 'connected', 'reconnecting', 'failed', 'stopped', 'fake'].includes(input.state) ? input.state : 'failed';
    desiredConnection = { state, ...(input.failure ? { failure: feishuFailure(input.failure.category) } : {}) };
    return flushConnection();
  }
  const readSent = () => withNamedLock(dir, '.feishu-sent.lock', () => readJsonl<SentMessage>(sentPath), 30000);
  async function send(type: 'interactive' | 'text', content: unknown, key: string, noticeId?: string) {
    // 卡片 API 慢时，反馈确认不排在它后面；共享映射仅在落盘时短锁保护。
    await withNamedLock(dir, type === 'text' ? '.feishu-reply-send.lock' : '.feishu-send.lock', async () => {
      const history = await readSent();
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
      await withNamedLock(dir, '.feishu-sent.lock', async () => {
        await readJsonl(sentPath);
        await appendJsonl(sentPath, [{ key, messageId, at: new Date().toISOString(), type, ...(noticeId ? { noticeId } : {}), ...(options!.mode === 'fake' ? { content } : {}) } satisfies SentMessage]);
      }, 30000);
    });
  }
  async function handle(input: Incoming) {
    if (input.actor !== options!.receiverId || (input.type === 'text' && input.chatType !== 'p2p')) return;
    const sent = await readSent();
    const mapped = sent.find(row => row.messageId === (input.type === 'action' ? input.messageId : input.ref));
    let response = '已记下';
    if (input.type === 'action') {
      const value = input.value ?? {};
      if (!mapped?.noticeId) throw new IncomingFailure('notice_not_found', '找不到这张卡片对应的提醒，请打开最新卡片再试。');
      const notice = (await readOutbox(dir)).find(n => n.id === mapped.noticeId);
      if (!notice) throw new IncomingFailure('notice_not_found', '这条提醒已无法找到，请打开最新卡片再试。');
      if (value.action === 'feedback' && value.noticeId === notice.id && ['正确', '误报', '看不懂'].includes(value.verdict ?? '') && (value.verdict === '看不懂' || !['weekly', 'recurrence', 'service_restart'].includes(notice.kind))) {
        response = await receiveFeedback(dir, 'feishu', { noticeId: notice.id, content: value.verdict!, at: input.at, replyId: input.id });
      } else if (['agree', 'revise'].includes(value.action ?? '')) {
        const review = notice.reviews?.find(item => item.experienceId === value.experienceId);
        if (!review) throw new IncomingFailure('experience_not_found', '这张卡片没有对应的经验，请打开最新复盘再试。');
        if (!review.experienceRevision || value.experienceRevision !== review.experienceRevision) response = '这张复盘卡片已过期，未修改经验。请查看最新复盘或使用本机 experience 命令。';
        else {
          const result = await changeExperience(dir, review.experienceId, value.action === 'agree' ? '已确认' : '待确认', undefined, input.at, `feishu:${input.id}`, review.experienceRevision);
          if (result === 'stale') response = '这张复盘卡片已过期，未修改经验。请查看最新复盘或使用本机 experience 命令。';
          else if (result === 'inactive') response = '这条经验已过时或撤销，未修改经验。';
          else if (value.action === 'revise') response = '已记下，已退回待确认。请用本机 experience 命令修改归因或对策后确认。';
        }
      } else throw new IncomingFailure('invalid_action', '按钮与这张卡片不匹配，请打开最新卡片再试。');
    } else {
      if (!/^(正确|误报|漏了|看不懂)(?:\s|$)/.test(input.text ?? '')) response = '请引用卡片回复「正确 / 误报 / 看不懂 + 一句话」，或直接发「漏了 + 一句话」。';
      else if (input.text!.startsWith('漏了') && !input.ref) response = await receiveFeedback(dir, 'feishu', { noticeId: null, content: input.text!, at: input.at, replyId: input.id });
      else if (!mapped?.noticeId) response = '没有找到被引用的提醒，请引用机器人发出的提醒再回复。';
      else if (!input.text!.startsWith('看不懂') && ['weekly', 'recurrence', 'service_restart'].includes((await readOutbox(dir)).find(n => n.id === mapped.noticeId)?.kind ?? '')) response = '这条不是盯防提醒，请使用「看不懂」按钮或本机 experience 命令。';
      else response = await receiveFeedback(dir, 'feishu', { noticeId: mapped.noticeId, content: input.text!, at: input.at, replyId: input.id });
    }
    return response;
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
      }, 2000));
      ingress = saved;
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([saved, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('入站暂未持久化，请重试')), 2500); })]); }
      finally { clearTimeout(timer); }
      setImmediate(() => { void channel.drain().catch(() => {}); });
      return {};
    },
    drain(now) {
      // detect.finish 在数据锁释放后也调用收件；利用这个空档独立重试，
      // 避免固定整秒重试与连续检测同相而长期抢不到锁。这里只唤醒，不等待写入。
      if (!stopped && desiredConnection && JSON.stringify(desiredConnection) !== connectionSignature) void flushConnection();
      if (draining) return draining;
      draining = withNamedLock(dir, '.feishu-receive.lock', async () => {
        // 不等待连接状态写入；即使它仍待重试，收件也独立工作。
        const inputs = await withNamedLock(dir, '.feishu-inbound.lock', () => readJsonl<unknown>(inbox), 2000);
        const receiptsPath = join(dir, 'feishu-receipts.jsonl');
        const receipts = new Map<string, Receipt>();
        for (const row of await readJsonl<Receipt>(receiptsPath)) receipts.set(row.id, { ...receipts.get(row.id), ...row });
        let count = 0;
        for (const raw of inputs) {
          const input = normalizeIncoming(raw, undefined, now);
          if (!input) continue;
          let receipt = receipts.get(input.id);
          if (!receipt) {
            const at = now ?? new Date().toISOString();
            try { receipt = { id: input.id, at, status: 'processed', response: await handle(input) }; }
            catch (error) {
              const { category, reason } = error instanceof IncomingFailure ? { category: error.category, reason: error.message } : safeProcessingFailure(error);
              receipt = { id: input.id, at, status: 'failed', category, response: `这条没处理成，原因：${reason}` };
            }
            if (input.timeNote) receipt.timeNote = input.timeNote;
            // 先追加处理结果。确认投递失败只重试确认，不能再处理/重复记反馈。
            await appendJsonl(receiptsPath, [receipt]);
            receipts.set(input.id, receipt); count++;
          }
          // 兼容已有仅含 id 的处理记录（包括人工核销的旧点击），绝不重新处理或补反馈。
          if (!receipt.response || receipt.reply === 'sent') continue;
          try {
            await send('text', { text: receipt.response }, `reply:${input.id}`);
            receipt = { ...receipt, reply: 'sent' };
            await appendJsonl(receiptsPath, [{ id: input.id, at: now ?? new Date().toISOString(), reply: 'sent' }]);
          } catch {
            if (receipt.reply !== 'pending') await appendJsonl(receiptsPath, [{ id: input.id, at: now ?? new Date().toISOString(), reply: 'pending', replyCategory: 'reply_delivery' }]);
            receipt = { ...receipt, reply: 'pending' };
          }
          receipts.set(input.id, receipt);
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
      await flushConnection();
    },
    async stop() {
      stopped = true;
      clearTimeout(connectionRetry); connectionRetry = undefined;
      if (transport) { const ready = await transport.catch(() => undefined); ready?.stop?.(); }
      await ingress; if (draining) await draining; await channel.drain();
      await reportConnection({ state: 'stopped' });
    },
  };
  return channel;
}
