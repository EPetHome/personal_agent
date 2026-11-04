import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { jsonFile, atomicJson, parseJson } from '../util.js';

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 30 * 1024 * 1024) throw new Error('body too large'); chunks.push(chunk); }
  return parseJson(Buffer.concat(chunks).toString('utf8') || '{}');
}
function send(res: ServerResponse, data: unknown, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, port = 0) {
  const server = createServer((req, res) => { void handler(req, res).catch(() => { if (!res.headersSent) send(res, { error: 'stub request failed' }, 500); else res.end(); }); });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}
export async function fakeFeishu(port = 0, statePath?: string) {
  const state = statePath ? await jsonFile<any>(statePath).catch(() => undefined) : undefined;
  const events: { seq: number; event: unknown }[] = state?.events ?? [];
  const messages: { id: string; key: string; text: string; userId: string; updates?: string[] }[] = state?.messages ?? [];
  const notifications: any[] = state?.notifications ?? [];
  const assets: Record<string, string> = state?.assets ?? {};
  let connected = true, save = Promise.resolve();
  const persist = () => { if (statePath) save = save.then(() => atomicJson(statePath, { events, messages, notifications, assets })); return save; };
  const api = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost'), path = url.pathname;
    if (req.method === 'GET' && path === '/events') { send(res, { events: events.filter(e => e.seq > Number(url.searchParams.get('after') ?? 0)) }, connected ? 200 : 503); return; }
    if (req.method === 'GET' && path === '/messages') { send(res, messages); return; }
    if (req.method === 'GET' && path === '/notifications') { send(res, notifications); return; }
    if (req.method === 'GET' && path.startsWith('/assets/')) {
      const value = assets[decodeURIComponent(path.slice(8))]; if (value === undefined) { send(res, {}, 404); return; }
      res.writeHead(200); res.end(Buffer.from(value, 'base64')); return;
    }
    if (req.method !== 'POST') { send(res, { ready: true }); return; }
    const value = await body(req);
    if (path === '/connection') { connected = value.connected; send(res, { connected }); return; }
    if (path === '/inject') {
      let event = value;
      if (!value.event && !value.message && !value.action) {
        const id = value.id ?? randomUUID(), attachment = value.attachment;
        if (attachment) assets[attachment.key ?? id] = attachment.contentBase64 ?? Buffer.from(attachment.content ?? 'synthetic attachment').toString('base64');
        event = value.button ? { event_id: id, operator: { open_id: value.who ?? 'owner' }, context: { open_message_id: value.quoteId ?? 'card', chat_type: value.chatType ?? 'p2p' }, action: value.button } : {
          event_id: id, sender: { sender_id: { open_id: value.who ?? 'owner' } }, message: { message_id: id, chat_type: value.chatType ?? 'p2p', create_time: String(Date.now()), parent_id: value.quoteId,
            message_type: attachment?.kind === 'image' ? 'image' : attachment ? 'file' : 'text', content: JSON.stringify(attachment ? attachment.kind === 'image' ? { image_key: attachment.key ?? id } : { file_key: attachment.key ?? id, file_name: attachment.name ?? 'note.txt' } : { text: value.text ?? '' }) } };
      }
      events.push({ seq: (events.at(-1)?.seq ?? 0) + 1, event }); await persist(); send(res, { id: events.at(-1)?.seq }); return;
    }
    if (path === '/send') {
      let message = messages.find(m => m.key === value.key);
      if (!message) { message = { id: `om_${randomUUID()}`, ...value }; messages.push(message!); await persist(); }
      send(res, { id: message!.id }); return;
    }
    if (path === '/update') {
      const message = messages.find(m => m.id === value.id); if (!message) { send(res, { error: 'unknown message' }, 404); return; }
      (message.updates ??= []).push(value.text); message.text = value.text; await persist(); send(res, { id: message.id }); return;
    }
    if (path === '/notify') { if (!notifications.some(n => n.key === value.key)) notifications.push(value); await persist(); send(res, { id: value.id }); return; }
    send(res, { error: 'unknown path' }, 404);
  }, port);
  return { ...api, events, messages, notifications, assets };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function textBlock(value: unknown) { return record(value) && value.type === 'text' && typeof value.text === 'string'; }
/** Strict Chat Completions subset used by PA, including tool acknowledgement order. */
export function chatContractError(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || !messages.length) return 'messages must be a nonempty array';
  const pending = new Set<string>();
  for (const m of messages) {
    if (!record(m) || !['system', 'user', 'assistant', 'tool'].includes(String(m.role))) return 'invalid message role';
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !pending.delete(m.tool_call_id)) return 'unmatched tool_call_id';
      if (typeof m.content !== 'string' && !(Array.isArray(m.content) && m.content.every(textBlock))) return 'tool content must be text-only';
    } else {
      if (pending.size) return 'all tool responses must precede another message';
      const validBlock = (v: unknown) => textBlock(v) || m.role === 'user' && record(v) && v.type === 'image_url' && record(v.image_url) && typeof v.image_url.url === 'string' && v.image_url.url.length > 0;
      if (typeof m.content !== 'string' && !(m.role === 'assistant' && m.content === null) && !(Array.isArray(m.content) && m.content.every(validBlock))) return 'invalid content for role';
      if (m.role === 'assistant' && m.tool_calls !== undefined) {
        if (!Array.isArray(m.tool_calls)) return 'invalid tool_calls';
        for (const call of m.tool_calls) {
          if (!record(call) || typeof call.id !== 'string' || !call.id || pending.has(call.id) || call.type !== 'function' || !record(call.function) || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') return 'invalid tool call';
          pending.add(call.id);
        }
      }
    }
  }
  return pending.size ? 'missing tool responses' : undefined;
}
export interface Step { tools?: { name: string; arguments?: Record<string, unknown> }[]; text?: string; reasoning_content?: string; delayMs?: number; status?: number; hang?: boolean }
export interface Script { flow?: Step[]; turns?: Step[][]; requireReasoning?: boolean }
export async function scriptModel(initial: Script = {}, port = 0, statePath?: string) {
  let script = initial;
  const requests: any[] = [], sessions = new Map<string, { turn: number; round: number }>();
  const timers = new Set<NodeJS.Timeout>();
  const api = await listen(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/requests') { send(res, requests); return; }
    if (req.method !== 'POST') { send(res, { ready: true }); return; }
    if (path === '/script') { script = await body(req); send(res, { ok: true }); return; }
    const request = await body(req);
    const session = String(req.headers['x-opencode-session'] ?? 'default');
    let run = sessions.get(session); if (!run) { run = { turn: sessions.size, round: 0 }; sessions.set(session, run); }
    const round = run.round++, flow = script.turns?.[run.turn] ?? script.flow;
    const step = flow?.[round] ?? { text: 'done', reasoning_content: 'synthetic reasoning' };
    requests.push({ session, round, body: request, at: Date.now() });
    if (statePath) await atomicJson(statePath, requests);
    const contractError = chatContractError(request.messages);
    if (contractError) { send(res, { error: { message: contractError } }, 400); return; }
    if (script.requireReasoning && request.messages.some((m: any) => m.role === 'assistant' && m.tool_calls?.length && !Object.hasOwn(m, 'reasoning_content'))) { send(res, { error: { message: 'reasoning_content missing' } }, 400); return; }
    if (step.hang) return; // Keep the socket open until client aborts. No timer busy loop.
    if (step.delayMs) await new Promise<void>(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, step.delayMs); timers.add(timer); });
    if (step.status) { send(res, { error: { message: 'synthetic failure' } }, step.status); return; }
    let incoming: any = {};
    for (const message of request.messages.toReversed()) {
      if (message.role !== 'user' || typeof message.content !== 'string') continue;
      try { const value = JSON.parse(message.content); if (value.type === '新输入') { incoming = value; break; } }
      catch { /* Plain chat and lifted visual materials are not the input envelope. */ }
    }
    let lastTool: any; try { lastTool = JSON.parse(request.messages.filter((m: any) => m.role === 'tool').at(-1)?.content ?? '{}'); } catch { lastTool = undefined; }
    const expand = (value: unknown): any => {
      if (typeof value === 'string') return value.replaceAll('{{attachment0}}', incoming.attachments?.[0]?.path ?? '').replaceAll('{{text}}', incoming.text ?? '').replaceAll('{{loopCount}}', String(lastTool?.batches?.length ?? 0));
      if (Array.isArray(value)) return value.map(expand);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
      return value;
    };
    const tools = step.tools?.map((t, i) => ({ id: `call_${run!.turn}_${round}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify({ reason: '构造脚本的判断依据', plan: '按测试脚本执行', ...expand(t.arguments ?? {}) }) } }));
    send(res, { id: `chat_${requests.length}`, object: 'chat.completion', model: request.model, choices: [{ index: 0, finish_reason: tools?.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: expand(step.text ?? ''), reasoning_content: step.reasoning_content ?? 'synthetic reasoning', ...(tools?.length ? { tool_calls: tools } : {}) } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
  }, port);
  return { ...api, requests, async close() { for (const t of timers) clearTimeout(t); await api.close(); } };
}
