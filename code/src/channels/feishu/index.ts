import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { managedCard, noticeCard } from './card.ts';
import { readLedger, updateLedger } from '../../core/ledger.ts';
import { recordManagedAction, recordManagedFeedback } from '../../core/managed-actions.ts';
import { recordManagedText } from '../../core/task-intake.ts';
import type { ManagedCard } from '../../core/managed-types.ts';
import { feishuFailure, realTransport, safeFeishuDeliveryFailure, safeFeishuFailure } from './transport.ts';
import type { FeishuTransport } from './transport.ts';
import { receiveFeedback } from '../../core/feedback.ts';
import { relayController } from '../../core/relay.ts';
import { OperationFailure, safeProcessingFailure } from '../../core/failures.ts';
import { reportStorageFailure } from '../../core/alerts.ts';
import { changeExperience } from '../../core/learning.ts';
import { event } from '../../core/events.ts';
import { withNamedLock } from '../../core/locks.ts';
import { appendJsonl, readEvents, readJsonl, readJsonlSnapshot, readOutbox, withStoreLock } from '../../core/store.ts';
import { hash, iso } from '../../core/utils.ts';
import type { Channel, Config, FeishuConnection } from '../../core/types.ts';

export interface Incoming {
  id: string; at: string; actor: string; type: 'text' | 'action'; messageId: string;
  ref?: string; text?: string; value?: Record<string, string>; chatType?: string;
  timeNote?: string;
  /** 仅卡片表单的这一个输入；保留空白，不复制其余表单或平台 token。 */
  relayText?: string;
}
interface Receipt {
  id: string; at: string; status?: 'processed' | 'failed'; category?: string;
  response?: string; reply?: 'sent' | 'pending'; replyCategory?: 'reply_delivery'; timeNote?: string;
}
interface InboxBoundary { rows: number; bytes: number; dev?: number; ino?: number; sentRows: number; prefixSha256?: string }
type InboxSnapshot = Awaited<ReturnType<typeof readJsonlSnapshot>>;
const prefixHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function parseInboxBoundary(response: string): InboxBoundary {
  let boundary: InboxBoundary;
  try { boundary = JSON.parse(response) as InboxBoundary; }
  catch { throw new OperationFailure('data_corrupt', '收件边界元数据损坏，保留现场'); }
  if (!boundary || typeof boundary !== 'object' || ![boundary.rows, boundary.bytes, boundary.sentRows].every(value => Number.isSafeInteger(value) && value >= 0)
    || boundary.prefixSha256 !== undefined && (typeof boundary.prefixSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(boundary.prefixSha256)))
    throw new OperationFailure('data_corrupt', '收件边界元数据不受支持，保留现场');
  return boundary;
}
/** 校验原字节前缀，不把设备/inode当跨备份的永久身份，也不只按长度认副本。 */
function verifyInboxPrefix(snapshot: InboxSnapshot, boundary: InboxBoundary): string {
  if (snapshot.content.length < boundary.bytes || snapshot.rows.length < boundary.rows) throw new OperationFailure('data_corrupt', '旧收件前缀被截断，保留现场');
  const prefix = snapshot.content.subarray(0, boundary.bytes);
  if ((boundary.bytes > 0 && prefix[prefix.length - 1] !== 10) || prefix.toString('utf8').split('\n').filter(line => line.trim()).length !== boundary.rows)
    throw new OperationFailure('data_corrupt', '收件字节边界与历史行数不符，保留现场');
  const digest = prefixHash(prefix);
  if (boundary.prefixSha256 !== undefined && boundary.prefixSha256 !== digest) throw new OperationFailure('data_corrupt', '旧收件前缀内容校验失败，未处理新输入');
  return digest;
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
  operation?: 'update';
}
// 动态 JSON 仅停留在 I/O 边界；逐个字段校验后才构成领域 Incoming。
function obj(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function relayText(raw: unknown): string | undefined {
  return typeof raw === 'string' && Array.from(raw).length <= 4000 ? raw : undefined;
}
function actionValue(raw: unknown): Record<string, string> {
  const input = obj(raw), value: Record<string, string> = {};
  for (const name of ['action', 'verdict', 'noticeId', 'experienceId', 'experienceRevision', 'draftId', 'revision', 'option']) { const text = str(input[name]); if (text && text.length < 200) value[name] = text; }
  return value;
}
/** 同时接受官方原始 envelope 和 SDK 展平事件。只持久化所需字段，不保存 token。 */
export function normalizeIncoming(raw: unknown, type?: string, now = new Date().toISOString()): Incoming | null {
  const envelope = obj(raw), data = obj(envelope.event ?? raw), header = obj(envelope.header);
  const storedType = envelope.type;
  if (storedType === 'text' || storedType === 'action') {
    const id = str(envelope.id), actor = str(envelope.actor), messageId = str(envelope.messageId), at = str(envelope.at);
    if (!id || !actor || !messageId || !at) return null;
    return { id, actor, messageId, ...incomingTime(at, now, true), ...(envelope.timeNote === TIME_FALLBACK ? { timeNote: TIME_FALLBACK } : {}), type: storedType, text: str(envelope.text), ref: str(envelope.ref), chatType: str(envelope.chatType), value: actionValue(envelope.value), relayText: relayText(envelope.relayText) };
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
    result = { type: 'action', actor: str(obj(data.operator).open_id) ?? '', messageId: str(context.open_message_id) ?? str(data.open_message_id) ?? '', value: actionValue(action.value), relayText: relayText(obj(action.form_value).relay_text) };
  } else return null;
  if (!result.actor || !result.messageId) return null;
  const timestamp = header.create_time ?? envelope.create_time ?? obj(data.message).create_time;
  const id = str(header.event_id) || str(envelope.event_id) || hash(JSON.stringify([str(data.token) ?? '', result, timestamp ?? '']));
  return { ...result, ...incomingTime(timestamp, now), id };
}
export interface FeishuChannel extends Channel {
  deliverManaged(card: ManagedCard, key: string, messageId?: string): Promise<string>;
  capture(raw: unknown, eventType?: string): Promise<Record<string, never>>;
  drain(now?: string): Promise<number>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 仅一次性 CLI/离线测试等待后台转达；检测与收件不调用。 */
  settled(): Promise<void>;
}
export function feishuChannel(config: Config, injected?: FeishuTransport, runtime: { managed?: boolean } = {}): FeishuChannel {
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
          if (runtime.managed) {
            const at = new Date().toISOString();
            await updateLedger(dir, at, (_state, add) => add({ kind: 'put', table: 'connections', value: { id: 'feishu', at, ...connection } }));
            await appendJsonl(join(dir, 'service.log.jsonl'), [{ at, kind: connection.state === 'failed' ? 'feishu_connection_failed' : 'feishu_connection', state: connection.state, ...(connection.failure ?? {}) }]);
          } else await withStoreLock(dir, async () => {
            const at = new Date().toISOString(), logPath = join(dir, 'service.log.jsonl');
            await readJsonl(logPath);
            // 首笔连接事件也先完成格式准备，避免全新目录被下一轮误认成需迁移的旧库。
            await readEvents(dir);
            await appendJsonl(join(dir, 'events.jsonl'), [event({ kind: 'feishu_connection', connection }, at)]);
            await appendJsonl(logPath, [{ at, kind: connection.state === 'failed' ? 'feishu_connection_failed' : 'feishu_connection',
              state: connection.state, ...(connection.failure ?? {}) }]);
          });
          connectionSignature = signature;
        } catch (error) { await reportStorageFailure(config, error); break; } // 状态仍独立重试，不拖垮检测/收件。
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
  const boundaryId = 'upgrade:feishu-inbox';
  let boundaryReady: Promise<InboxBoundary> | undefined;
  /** 只记新旧收件边界，不迁移旧处理结果。启动/首个接入动作必须先于新输入建立边界。 */
  function prepareManagedInbox(): Promise<InboxBoundary> {
    return boundaryReady ??= withNamedLock(dir, '.feishu-inbound.lock', async () => {
      const state = await readLedger(dir), saved = state.tables.receipts[boundaryId];
      const snapshot = await readJsonlSnapshot<unknown>(inbox);
      let boundary: InboxBoundary;
      if (saved) {
        boundary = parseInboxBoundary(saved.response);
        const digest = verifyInboxPrefix(snapshot, boundary);
        if (boundary.prefixSha256 !== undefined) return boundary;
        // 旧开发格式没有内容锚点：仅在原文件身份仍可证时补记；异地旧副本不能猜着放行。
        if (boundary.bytes > 0 && (!snapshot.identity || snapshot.identity.dev !== boundary.dev || snapshot.identity.ino !== boundary.ino))
          throw new OperationFailure('data_corrupt', '旧收件边界缺少内容指纹，请先在原目录补记校验再完整备份；未重设边界');
        boundary = { ...boundary, prefixSha256: digest };
      } else {
        const history = await readSent();
        // 不根据旧回执是否齐全猜年代：首次managed接入前已有的整个前缀都不重放。
        boundary = { rows: snapshot.rows.length, bytes: snapshot.content.length, sentRows: history.length,
          prefixSha256: prefixHash(snapshot.content), ...(snapshot.identity ?? {}) };
      }
      await updateLedger(dir, new Date().toISOString(), (_current, add) => add({ kind: 'put', table: 'receipts', value: { id: boundaryId,
        at: new Date().toISOString(), response: JSON.stringify(boundary) } }));
      return boundary;
    }, 2000).catch(error => { boundaryReady = undefined; throw error; });
  }
  async function send(type: 'interactive' | 'text', content: unknown, key: string, noticeId?: string) {
    if (runtime.managed) await prepareManagedInbox();
    // 卡片 API 慢时，反馈确认不排在它后面；共享映射仅在落盘时短锁保护。
    await withNamedLock(dir, type === 'text' ? '.feishu-reply-send.lock' : '.feishu-send.lock', async () => {
      // 旧确认/已落发送审计但回执缺口同样是禁止重发的证据；只读、不搬成新状态。
      if ((await readSent()).some(row => row.key === key)) return;
      if (runtime.managed) {
        const receipt = (await readLedger(dir)).tables.receipts[`sent:${key}`];
        if (receipt) {
          if (JSON.parse(receipt.response).state === 'sent') return;
          throw new OperationFailure('channel_timeout', '确认消息的发送结果不确定，未重发');
        }
        await updateLedger(dir, new Date().toISOString(), (_state, add) => add({ kind: 'put', table: 'receipts', value: { id: `sent:${key}`, at: new Date().toISOString(), response: JSON.stringify({ state: 'sending' }) } }));
      }
      const requestKey = hash(key);
      let messageId: string;
      if (options!.mode === 'fake' && !injected) messageId = `om_fake_${requestKey.slice(0, 24)}`;
      else {
        let timer: NodeJS.Timeout | undefined;
        try { messageId = await Promise.race([getTransport().then(transport => transport.send(type, JSON.stringify(content), requestKey)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OperationFailure('channel_timeout', '飞书投递超时')), options!.timeoutMs); })]); }
        catch (error) { const failure = safeFeishuDeliveryFailure(error); throw new OperationFailure(failure.category, failure.reason); }
        finally { clearTimeout(timer); }
      }
      await withNamedLock(dir, '.feishu-sent.lock', async () => {
        await readJsonl(sentPath);
        await appendJsonl(sentPath, [{ key, messageId, at: new Date().toISOString(), type, ...(noticeId ? { noticeId } : {}), ...(options!.mode === 'fake' ? { content } : {}) } satisfies SentMessage]);
      }, 30000);
      if (runtime.managed) await updateLedger(dir, new Date().toISOString(), (_state, add) => add({ kind: 'put', table: 'receipts', value: { id: `sent:${key}`, at: new Date().toISOString(), response: JSON.stringify({ state: 'sent', messageId }) } }));
    });
  }
  const relay = relayController(config, async row => {
    const key = `relay-view:${row.id}`;
    if ((await readSent()).some(message => message.key === key)) return;
    const notice = (await readOutbox(dir)).find(notice => notice.id === row.noticeId);
    if (!notice) throw new IncomingFailure('notice_not_found', '转达卡片对应的提醒已无法找到');
    const view = config.relay?.enabled || row.view.stage === 'done' ? row.view : { stage: 'done' as const, message: '没送到：转达总开关已关闭' };
    const card = noticeCard(notice, view);
    let timer: NodeJS.Timeout | undefined;
    try {
      if (options.mode === 'real' || injected) {
        await Promise.race([getTransport().then(transport => {
          if (!transport.update) throw new OperationFailure('channel_configuration', '飞书替身未提供卡片更新');
          return transport.update(row.messageId, JSON.stringify(card));
        }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OperationFailure('channel_timeout', '飞书卡片更新超时')), options.timeoutMs); })]);
      }
      await withNamedLock(dir, '.feishu-sent.lock', async () => {
        await readJsonl(sentPath);
        await appendJsonl(sentPath, [{ key, messageId: row.messageId, at: new Date().toISOString(), type: 'interactive', noticeId: row.noticeId,
          operation: 'update', ...(options.mode === 'fake' ? { content: card } : {}) } satisfies SentMessage]);
      }, 30000);
    } catch (error) {
      // 只补一条状态说明，不重发 CC，也不让坏预览看起来已经确认。
      const failure = safeFeishuDeliveryFailure(error);
      await send('text', { text: `卡片更新失败：${failure.reason}。${view.message ?? '尚未完成预览确认，不会发送；请回电脑核对。'}` }, `relay-update-failed:${row.id}`);
      throw error;
    } finally { clearTimeout(timer); }
  }, error => reportStorageFailure(config, error));
  async function handle(input: Incoming, receivedAt: string) {
    if (input.actor !== options!.receiverId || (input.type === 'text' && input.chatType !== 'p2p')) return;
    if (input.type === 'action' && input.value?.action?.startsWith('managed_')) {
      const value = input.value;
      const revision = Number(value.revision), option = value.option === undefined ? undefined : Number(value.option);
      if (!Number.isSafeInteger(revision) || revision < 1 || option !== undefined && (!Number.isSafeInteger(option) || option < 0)) return '按钮字段不合法，没有送话。';
      return recordManagedAction(config, { id: input.id, actor: input.actor, at: receivedAt, messageId: input.messageId,
        cardId: value.noticeId ?? '', revision, action: value.action!.slice('managed_'.length), ...(option === undefined ? {} : { option }), ...(input.relayText === undefined ? {} : { text: input.relayText }) });
    }
    if (runtime.managed && input.type === 'text' && /^(正确|误报|漏了|看不懂|严重错误)(?:\s|$)/.test(input.text ?? '')) {
      if (input.text!.startsWith('漏了') && !input.ref) return recordManagedFeedback(config, { id: input.id, actor: input.actor, at: input.at, content: input.text!, cardId: null });
      const state = await readLedger(dir), delivery = Object.values(state.tables.deliveries).find(row => row.channel === 'feishu' && row.messageId === input.ref);
      const card = delivery ? state.tables.cards[delivery.cardId] : undefined;
      if (card) {
        const [verdict, ...comment] = input.text!.split(/\s+/);
        return recordManagedAction(config, { id: input.id, actor: input.actor, at: input.at, messageId: input.ref!, cardId: card.id,
          revision: card.revision, action: `feedback_${verdict}`, text: comment.join(' ') });
      }
    }
    if (runtime.managed && input.type === 'text' && !/^(正确|误报|漏了|看不懂|严重错误)(?:\s|$)/.test(input.text ?? '')) {
      return recordManagedText(config, { id: input.id, actor: input.actor, at: receivedAt, messageId: input.messageId, text: input.text ?? '', ...(input.ref ? { ref: input.ref } : {}) });
    }
    const sent = await readSent();
    const mapped = sent.find(row => row.messageId === (input.type === 'action' ? input.messageId : input.ref));
    let response = '已记下';
    if (input.type === 'action') {
      const value = input.value ?? {};
      if (!mapped?.noticeId) throw new IncomingFailure('notice_not_found', '找不到这张卡片对应的提醒，请打开最新卡片再试。');
      const notice = (await readOutbox(dir)).find(n => n.id === mapped.noticeId);
      if (!notice) throw new IncomingFailure('notice_not_found', '这条提醒已无法找到，请打开最新卡片再试。');
      if (value.action?.startsWith('relay_')) return relay.handle(input, notice);
      if (value.action === 'feedback' && value.noticeId === notice.id && ['正确', '误报', '看不懂'].includes(value.verdict ?? '') && (value.verdict === '看不懂' || !['weekly', 'recurrence', 'service_restart', 'daily'].includes(notice.kind))) {
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
      else if (!input.text!.startsWith('看不懂') && ['weekly', 'recurrence', 'service_restart', 'daily'].includes((await readOutbox(dir)).find(n => n.id === mapped.noticeId)?.kind ?? '')) response = '这条不是盯防提醒，请使用「看不懂」按钮或本机 experience 命令。';
      else response = await receiveFeedback(dir, 'feishu', { noticeId: mapped.noticeId, content: input.text!, at: input.at, replyId: input.id });
    }
    return response;
  }
  const channel: FeishuChannel = {
    name: 'feishu', levels: ['现在就要你', '有空看'],
    async deliverManaged(card, key, previousMessageId) {
      await prepareManagedInbox();
      const content = managedCard(card), requestKey = hash(key);
      let messageId = previousMessageId ?? `om_fake_${hash(card.id).slice(0, 24)}`;
      let timer: NodeJS.Timeout | undefined;
      try {
        if (options.mode === 'real' || injected) {
          await Promise.race([(async () => {
            const transport = await getTransport();
            if (previousMessageId) {
              if (!transport.update) throw new OperationFailure('channel_configuration', '渠道不支持更新原卡');
              await transport.update(previousMessageId, JSON.stringify(content));
            } else messageId = await transport.send('interactive', JSON.stringify(content), requestKey);
          })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OperationFailure('channel_timeout', '原卡投递超时，结果不确定')), options.timeoutMs); })]);
        }
        await withNamedLock(dir, '.feishu-sent.lock', async () => {
          await readJsonl(sentPath);
          await appendJsonl(sentPath, [{ key, messageId, at: new Date().toISOString(), type: 'interactive', noticeId: card.id,
            ...(previousMessageId ? { operation: 'update' as const } : {}), ...(options.mode === 'fake' ? { content } : {}) } satisfies SentMessage]);
        }, 30000);
        return messageId;
      } finally { clearTimeout(timer); }
    },
    async send(notice) {
      let view;
      try { view = await relay.card(notice); }
      catch (error) {
        await reportStorageFailure(config, error);
        view = { stage: 'done' as const, message: '没送到：转达记录暂不可用，未开放发送；盯防与反馈照常。请回电脑检查。' };
      }
      await send('interactive', noticeCard(notice, view), `notice:${notice.id}`, notice.id);
    },
    receive: reply => receiveFeedback(dir, 'feishu', reply),
    async capture(raw, type) {
      if (stopped) return {};
      const input = normalizeIncoming(raw, type);
      if (!input || input.actor !== options.receiverId || (input.type === 'text' && input.chatType !== 'p2p')) return {};
      // 先仅持久化最小入站事实；不等反馈处理、模型或发送 API。
      // 2.5 秒内不能持久化就拒绝处理器，让 SDK/平台重投，不能先成功确认再丢反馈。
      const saved = ingress.catch(() => {}).then(async () => {
        if (runtime.managed) await prepareManagedInbox();
        return withNamedLock(dir, '.feishu-inbound.lock', async () => {
          await readJsonl(inbox); await appendJsonl(inbox, [input]);
        }, 2000);
      });
      ingress = saved;
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([saved, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('入站暂未持久化，请重试')), 2500); })]); }
      catch (error) { await reportStorageFailure(config, error); throw error; }
      finally { clearTimeout(timer); }
      setImmediate(() => { if (!stopped) void channel.drain().catch(() => {}); });
      return {};
    },
    drain(now) {
      // detect.finish 在数据锁释放后也调用收件；利用这个空档独立重试，
      // 避免固定整秒重试与连续检测同相而长期抢不到锁。这里只唤醒，不等待写入。
      if (!stopped && desiredConnection && JSON.stringify(desiredConnection) !== connectionSignature) void flushConnection();
      if (draining) return draining;
      draining = withNamedLock(dir, '.feishu-receive.lock', async () => {
        const boundary = runtime.managed ? await prepareManagedInbox() : undefined;
        const { inputs, legacyIds } = await withNamedLock(dir, '.feishu-inbound.lock', async () => {
          const legacyIds = new Set<string>();
          if (!boundary) return { inputs: await readJsonl<unknown>(inbox), legacyIds };
          const snapshot = await readJsonlSnapshot<unknown>(inbox), all = snapshot.rows;
          verifyInboxPrefix(snapshot, boundary);
          for (const raw of all.slice(0, boundary.rows)) {
            const envelope = obj(raw), id = str(envelope.id) ?? str(obj(envelope.header).event_id) ?? normalizeIncoming(raw, undefined, now)?.id;
            if (id) legacyIds.add(id);
          }
          for (const row of await readJsonl<Receipt>(join(dir, 'feishu-receipts.jsonl'))) if (typeof row?.id === 'string') legacyIds.add(row.id);
          const sent = await readSent();
          if (sent.length < boundary.sentRows) throw new OperationFailure('data_corrupt', '旧发送证据被截断，不能安全重放收件');
          for (const row of sent.slice(0, boundary.sentRows)) if (row.key.startsWith('reply:')) legacyIds.add(row.key.slice('reply:'.length));
          return { inputs: all.slice(boundary.rows), legacyIds };
        }, 2000);
        // 先核实历史前缀再登记fake可用；坏副本不得因本次轮询而追加任何状态。
        // 真实连接状态仍独立重试，一次性假渠道无需建立长连接。
        if (!stopped && runtime.managed && options.mode === 'fake' && !injected) await reportConnection({ state: 'fake' });
        const receiptsPath = join(dir, 'feishu-receipts.jsonl');
        const receipts = new Map<string, Receipt>();
        if (runtime.managed) {
          for (const row of Object.values((await readLedger(dir)).tables.receipts)) if (row.id.startsWith('feishu:')) {
            const stored = JSON.parse(row.response) as Receipt; receipts.set(stored.id, stored);
          }
        } else for (const row of await readJsonl<Receipt>(receiptsPath)) receipts.set(row.id, { ...receipts.get(row.id), ...row });
        async function saveReceipt(receipt: Receipt) {
          if (runtime.managed) await updateLedger(dir, receipt.at, (_state, add) => add({ kind: 'put', table: 'receipts', value: { id: `feishu:${receipt.id}`, at: receipt.at, response: JSON.stringify(receipt) } }));
          else await appendJsonl(receiptsPath, [receipt]);
        }
        let count = 0;
        for (const raw of inputs) {
          const input = normalizeIncoming(raw, undefined, now);
          if (!input || legacyIds.has(input.id)) continue;
          let receipt = receipts.get(input.id);
          if (!receipt) {
            const at = now ?? new Date().toISOString();
            try { receipt = { id: input.id, at, status: 'processed', response: await handle(input, at) }; }
            catch (error) {
              await reportStorageFailure(config, error);
              const { category, reason } = error instanceof IncomingFailure ? { category: error.category, reason: error.message } : safeProcessingFailure(error);
              receipt = { id: input.id, at, status: 'failed', category, response: `这条没处理成，原因：${reason}` };
            }
            if (input.timeNote) receipt.timeNote = input.timeNote;
            // 先追加处理结果。确认投递失败只重试确认，不能再处理/重复记反馈。
            await saveReceipt(receipt);
            receipts.set(input.id, receipt); count++;
          }
          // 兼容已有仅含 id 的处理记录（包括人工核销的旧点击），绝不重新处理或补反馈。
          if (!receipt.response || receipt.reply === 'sent') continue;
          try {
            await send('text', { text: receipt.response }, `reply:${input.id}`);
            receipt = { ...receipt, reply: 'sent' };
            await saveReceipt({ ...receipt, at: now ?? new Date().toISOString(), reply: 'sent' });
          } catch (error) {
            await reportStorageFailure(config, error);
            if (receipt.reply !== 'pending') await saveReceipt({ ...receipt, at: now ?? new Date().toISOString(), reply: 'pending', replyCategory: 'reply_delivery' });
            receipt = { ...receipt, reply: 'pending' };
          }
          receipts.set(input.id, receipt);
        }
        // UI 更新和 CC 续话都不等待；轮询只做独立短记录，不能卡住检测/反馈。
        if (!runtime.managed) void relay.poll();
        return count;
      }).finally(() => { draining = undefined; });
      return draining;
    },
    async start() {
      stopped = false;
      if (runtime.managed) await prepareManagedInbox();
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
    settled: () => relay.settled(),
    async stop() {
      stopped = true;
      await relay.stop();
      clearTimeout(connectionRetry); connectionRetry = undefined;
      if (transport) { const ready = await transport.catch(() => undefined); ready?.stop?.(); }
      await ingress; if (draining) await draining; await channel.drain();
      await relay.settled();
      await reportConnection({ state: 'stopped' });
    },
  };
  return channel;
}
