import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, symlink, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseEnv } from 'node:util';
import * as sdk from '@larksuiteoapi/node-sdk';
import type { Attachment, Config, Input } from './types.js';
import { canonical, hash, inside, localUrl, post, safeName } from './util.js';
import { DeliveryUncertain, SdkRequests, withDeadline } from './channel-http.js';
import type { Store } from './store.js';
import { imageType } from './image.js';
import { nameDenied, readBytes } from './file-policy.js';
import { failure } from './errors.js';

export interface MessageCard {
  title: string; text: string;
  buttons: { label: string; value: Record<string, string>; disabled?: boolean }[];
}
function interactive(card: MessageCard) {
  return JSON.stringify({ config: { wide_screen_mode: true, update_multi: true }, header: { title: { tag: 'plain_text', content: card.title } }, elements: [
    { tag: 'div', text: { tag: 'plain_text', content: card.text } },
    ...card.buttons.filter(b => b.disabled).map(b => ({ tag: 'div', text: { tag: 'plain_text', content: `${b.label}：当前不可用，请回电脑操作` } })),
    ...(card.buttons.some(b => !b.disabled) ? [{ tag: 'action', actions: card.buttons.filter(b => !b.disabled).map(b => ({ tag: 'button', text: { tag: 'plain_text', content: b.label }, value: b.value })) }] : []),
  ] });
}
export interface Channel {
  sendCard?(card: MessageCard, key: string, signal?: AbortSignal): Promise<string>;
  updateCard?(id: string, card: MessageCard, signal?: AbortSignal): Promise<void>;
  send(text: string, key: string, signal?: AbortSignal): Promise<string>;
  update(id: string, text: string, signal?: AbortSignal): Promise<void>;
  download(input: Input, attachment: Attachment, target: string, signal?: AbortSignal): Promise<void>;
  start(receive: (raw: unknown) => void, connection: (connected: boolean) => void): Promise<void>;
  stop(): Promise<void>;
}
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error(..._args: unknown[]) {} };
export async function makeChannel(c: Pick<Config, 'feishu' | 'intake'>, store?: Store, dependencies: { credentials?: { appId: string; appSecret: string }; domain?: string } = {}): Promise<Channel> {
  if (dependencies.domain && !localUrl(dependencies.domain)) throw new Error('测试渠道域名只允许本地 HTTP 替身');
  const io = new SdkRequests(c.feishu.timeoutMs);
  if (c.feishu.mode === 'fake') {
    let timer: NodeJS.Timeout | undefined, stopped = false, running: Promise<void> | undefined;
    let controller: AbortController | undefined;
    return {
      async sendCard(card, key, signal) {
        try { return await io.run(signal, async active => (await post(`${c.feishu.url}/send`, { text: card.text, card, key, userId: c.feishu.userId }, c.feishu.timeoutMs, active)).id); }
        catch { throw new DeliveryUncertain(); }
      },
      async updateCard(id, card, signal) { await io.run(signal, async active => { await post(`${c.feishu.url}/update`, { id, text: card.text, card, userId: c.feishu.userId }, c.feishu.timeoutMs, active); }); },
      async send(text, key, signal) {
        try { return await io.run(signal, async active => (await post(`${c.feishu.url}/send`, { text, key, userId: c.feishu.userId }, c.feishu.timeoutMs, active)).id); }
        catch { throw new DeliveryUncertain(); }
      },
      async update(id, text, signal) { await io.run(signal, async active => { await post(`${c.feishu.url}/update`, { id, text, userId: c.feishu.userId }, c.feishu.timeoutMs, active); }); },
      async download(_input, attachment, target, signal) {
        await io.run(signal, async active => {
          const response = await fetch(`${c.feishu.url}/assets/${encodeURIComponent(attachment.key ?? '')}`, { signal: active });
          if (!response.ok || !response.body) throw new Error('附件下载失败');
          await saveStream(Readable.fromWeb(response.body as any), target, c.intake.maxFileBytes, active);
        });
      },
      async start(receive, connection) {
        const tick = async () => {
          if (stopped) return;
          controller = new AbortController();
          try {
            const cursor = store?.get('feishuCursor', 0) ?? 0;
            const response = await fetch(`${c.feishu.url}/events?after=${cursor}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(c.feishu.timeoutMs)]) });
            if (!response.ok) throw new Error('接收失败');
            const body = await response.json() as { events: { seq: number; event: unknown }[] };
            connection(true);
            for (const event of body.events) { if (stopped) break; receive(event.event); store?.set('feishuCursor', event.seq); }
          } catch { if (!stopped) connection(false); }
          finally { if (!stopped) timer = setTimeout(() => { running = tick(); }, c.feishu.pollMs); }
        };
        running = tick(); await running;
      },
      async stop() { stopped = true; clearTimeout(timer); controller?.abort(); await running; },
    };
  }
  const env = !dependencies.credentials && c.feishu.envFile ? parseEnv(await readFile(c.feishu.envFile, 'utf8')) : {};
  const appId = dependencies.credentials?.appId ?? process.env.FEISHU_APP_ID ?? env.FEISHU_APP_ID;
  const appSecret = dependencies.credentials?.appSecret ?? process.env.FEISHU_APP_SECRET ?? env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error('飞书凭证未配置（不记录凭证）');
  const client = new sdk.Client({ appId, appSecret, logger: quiet, domain: dependencies.domain, httpInstance: io.http });
  let ws: sdk.WSClient | undefined;
  return {
    async sendCard(card, key, signal) {
      try {
        return await io.run(signal, async () => {
          const r = await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: c.feishu.userId, msg_type: 'interactive', content: interactive(card), uuid: hash(key).slice(0, 32) } });
          if (r.code !== 0 || !r.data?.message_id) throw new Error('飞书卡片发送失败');
          return r.data.message_id;
        });
      } catch { throw new DeliveryUncertain(); }
    },
    async updateCard(id, card, signal) {
      await io.run(signal, async () => {
        const r = await client.im.message.patch({ path: { message_id: id }, data: { content: interactive(card) } });
        if (r.code !== 0) throw new Error('飞书卡片更新失败');
      });
    },
    async send(text, key, signal) {
      try {
        return await io.run(signal, async () => {
          const r = await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: c.feishu.userId, msg_type: 'text', content: JSON.stringify({ text }), uuid: hash(key).slice(0, 32) } });
          if (r.code !== 0 || !r.data?.message_id) throw new Error('飞书发送失败（原始响应不记录）');
          return r.data.message_id;
        });
      } catch { throw new DeliveryUncertain(); }
    },
    async update(id, text, signal) {
      await io.run(signal, async () => {
        const r = await client.im.message.update({ path: { message_id: id }, data: { msg_type: 'text', content: JSON.stringify({ text }) } });
        if (r.code !== 0) throw new Error('飞书更新失败（原始响应不记录）');
      });
    },
    async download(input, attachment, target, signal) {
      await io.run(signal, async active => {
        const r = await client.im.messageResource.get({ path: { message_id: input.messageId!, file_key: attachment.key! }, params: { type: attachment.kind === 'image' ? 'image' : 'file' } });
        await saveStream(r.getReadableStream(), target, c.intake.maxFileBytes, active);
      });
    },
    async start(receive, connection) {
      ws = new sdk.WSClient({ appId, appSecret, handshakeTimeoutMs: c.feishu.timeoutMs, domain: dependencies.domain, httpInstance: io.http,
        logger: { ...quiet, error(..._args: unknown[]) { connection(false); } },
        onReady: () => connection(true), onReconnected: () => connection(true), onReconnecting: () => connection(false), onError: () => connection(false) });
      void ws.start({ eventDispatcher: new sdk.EventDispatcher({ logger: quiet }).register({
        'im.message.receive_v1': async raw => { receive(raw); },
        'card.action.trigger': async (raw: unknown) => { receive(raw); return {}; },
      }) }).catch(() => connection(false));
    },
    async stop() { io.stopBackground(); ws?.close({ force: true }); },
  };
}
async function saveStream(stream: Readable, target: string, limit: number, signal: AbortSignal) {
  let bytes = 0;
  const temp = `${target}.download`;
  const bounded = new Transform({ transform(chunk: Buffer, _enc, callback) { bytes += chunk.length; callback(bytes > limit ? new Error('附件超过大小上限') : null, chunk); } });
  try { await pipeline(stream, bounded, createWriteStream(temp, { flags: 'w', mode: 0o600 }), { signal }); signal.throwIfAborted(); await rename(temp, target); }
  finally { await unlink(temp).catch(() => {}); }
}
function postBody(parsed: any) {
  const value = parsed?.post ?? parsed;
  const post = Array.isArray(value?.content) || Array.isArray(value?.content_v2) ? value
    : Object.values(value ?? {}).find((v: any) => Array.isArray(v?.content) || Array.isArray(v?.content_v2)) as any;
  if (!post) return { text: '', images: [] as { key: string; name: string }[] };
  // content_v2 is an alternate representation, not another message.
  const rows = post.content?.length ? post.content : post.content_v2;
  const images = new Map<string, { key: string; name: string }>(), lines: string[] = [];
  if (typeof post.title === 'string' && post.title) lines.push(post.title);
  for (const row of rows ?? []) {
    if (!Array.isArray(row)) continue;
    let line = '';
    for (const node of row) {
      if (['text', 'a'].includes(node?.tag) && typeof node.text === 'string') line += node.text;
      if (node?.tag === 'img' && typeof node.image_key === 'string' && !images.has(node.image_key)) images.set(node.image_key, { key: node.image_key, name: typeof node.file_name === 'string' ? node.file_name : `${node.image_key}.image` });
    }
    if (line) lines.push(line);
  }
  return { text: lines.join('\n'), images: [...images.values()] };
}
export function normalizeFeishu(raw: unknown, c: Config, store: Store): Input | undefined {
  if (!raw || typeof raw !== 'object') throw new Error('无效飞书输入');
  const r = raw as any, event = r.event ?? r, m = event.message;
  const button = event.action;
  const who = m ? event.sender?.sender_id?.open_id : event.operator?.open_id ?? event.operator?.operator_id?.open_id;
  const messageId = m?.message_id ?? event.context?.open_message_id;
  const chatType = m?.chat_type ?? event.context?.chat_type;
  const knownPrivate = button && messageId && store.db.prepare("SELECT 1 FROM outbox WHERE message_id=? AND state='sent'").get(messageId);
  if (who !== c.feishu.userId || (chatType !== 'p2p' && !(button && !chatType && knownPrivate))) {
    store.log('ignored_input', { reason: who !== c.feishu.userId ? '来源不是本人，已忽略' : '不是本人私聊，已忽略', who: typeof who === 'string' ? who : 'unknown', chatType: chatType ?? 'unknown', messageId });
    return;
  }
  const content = m?.content ?? '';
  let parsed: any = {}; try { parsed = typeof content === 'string' ? JSON.parse(content) : content; } catch { /* raw non-JSON text is kept */ }
  const attachments: Attachment[] = [];
  if (m?.message_type === 'image' && parsed.image_key) attachments.push({ kind: 'image', name: `${parsed.image_key}.image`, key: parsed.image_key });
  const post = m?.message_type === 'post' ? postBody(parsed) : undefined;
  for (const image of post?.images ?? []) attachments.push({ kind: 'image', name: image.name, key: image.key });
  if (m?.message_type === 'file' && parsed.file_key) attachments.push({ kind: 'file', name: parsed.file_name ?? 'file', key: parsed.file_key });
  const id = r.header?.event_id ?? r.event_id ?? (m ? messageId : hash(JSON.stringify(r)));
  if (!id || typeof id !== 'string') throw new Error('输入缺少稳定编号');
  const timestamp = Number(m?.create_time ?? r.header?.create_time);
  return { id: `feishu:${id}`, source: 'feishu', who, at: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString() : new Date().toISOString(),
    text: post ? post.text : typeof parsed.text === 'string' ? parsed.text : typeof content === 'string' ? content : JSON.stringify(content), messageId,
    quoteId: m?.parent_id ?? (button ? messageId : undefined), chatType: 'p2p', button, attachments,
    // Retain user-authored payloads, not SDK transport headers (which can contain verification tokens).
    raw: m ? { messageType: m.message_type, content } : { action: button } };
}
export async function prepareAttachments(input: Input, c: Config, channel: Channel, store: Store, signal?: AbortSignal) {
  await mkdir(c.attachmentDir, { recursive: true, mode: 0o700 });
  for (const attachment of input.attachments) {
    if (input.source !== 'feishu') continue;
    const receiptKey = `attachment-received:${hash(`${input.id}:${attachment.key}`)}`;
    const receipt = store.get<{ path: string; originalName: string } | null>(receiptKey, null);
    const original = attachment.originalName ?? receipt?.originalName ?? attachment.name;
    attachment.originalName = original;
    let target = attachment.path ?? receipt?.path ?? join(c.attachmentDir, `${hash(`${input.id}:${attachment.key}`).slice(0, 24)}-${safeName(original)}`);
    const checkTarget = async () => {
      const actual = await canonical(target);
      if (!inside(c.attachmentDir, actual)) throw new Error('附件目标越出已加载的附件目录');
      return actual;
    };
    let actual = await checkTarget();
    store.set(`attachment-origin:${actual}`, { name: original });
    if (!attachment.path) {
      signal?.throwIfAborted();
      try { await stat(target); } catch { await withDeadline(c.feishu.timeoutMs, signal, active => channel.download(input, attachment, target, active)); }
    }
    if (attachment.kind === 'image') {
      try {
        if (nameDenied(original)) throw new Error('blocked_origin');
        const { data } = await readBytes(target, checkTarget, c.intake.maxFileBytes);
        const type = imageType(data), corrected = actual.slice(0, actual.length - extname(actual).length) + type.extension;
        store.set(`attachment-origin:${await canonical(corrected)}`, { name: original });
        if (corrected !== actual) {
          const prior = actual;
          await rename(prior, corrected);
          // Old persisted quotes/checkpoints may still name the old extension.
          // Keep a local alias to the same checked content, never a new read grant.
          if (attachment.path) await symlink(basename(corrected), prior);
        }
        target = corrected; actual = await checkTarget();
        attachment.mime = type.mime; attachment.name = basename(target).replace(/^[a-f0-9]{24}-/, ''); attachment.error = undefined;
      } catch (error) {
        signal?.throwIfAborted(); attachment.mime = undefined;
        attachment.error = nameDenied(original) ? '原始附件名命中黑名单，不读取图片。' : failure(error).error;
      }
    }
    attachment.path = target;
    store.set(`attachment-origin:${actual}`, { name: original });
    store.set(receiptKey, { path: target, originalName: original });
  }
  return input;
}
export async function deliver(store: Store, channel: Channel, inputId: string, key: string, text: string, signal?: AbortSignal) {
  const old = store.db.prepare('SELECT * FROM outbox WHERE id=?').get(key);
  if (old) {
    if (old.state === 'sent') return { status: 'sent', id: old.message_id };
    return { status: 'uncertain', reason: '上次发送结果不确定，不重复发送。' };
  }
  store.db.prepare('INSERT INTO outbox(id,input_id,text,state) VALUES(?,?,?,?)').run(key, inputId, text, 'sending');
  try {
    const id = await withDeadline(store.config.feishu.timeoutMs, signal, active => channel.send(text, key, active));
    store.db.prepare("UPDATE outbox SET state='sent',message_id=? WHERE id=?").run(id, key);
    store.log('reply', { inputId, key, id, text, outcome: '已发给本人' });
    return { status: 'sent', id };
  } catch {
    store.log('delivery_uncertain', { inputId, key, outcome: '发送结果不确定，不重发；请检查飞书连接' });
    return { status: 'uncertain', reason: '发送结果不确定，不重复发送。' };
  }
}
