import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readLedger } from '../../core/ledger.ts';
import { recordManagedAction } from '../../core/managed-actions.ts';
import { guardCard } from '../../core/guard.ts';
import { hash } from '../../core/utils.ts';
import { managedControls } from '../feishu/card.ts';
import { sidebarHtml } from './page.ts';
import type { Config } from '../../core/types.ts';
import type { LedgerState, ManagedCard } from '../../core/managed-types.ts';

export const sidebarGroups = ['在跑', '等你', '卡住', '做完待推送'] as const;
export function sidebarSnapshot(state: LedgerState) {
  const groups = sidebarGroups.map(name => ({ name, items: [] as { id: string; name: string; status: string; card?: ManagedCard; controls: ReturnType<typeof managedControls>; reasons: string[] }[] }));
  for (const ticket of Object.values(state.tables.tickets)) {
    if (ticket.closure || ['merged', 'stopped'].includes(ticket.status)) continue;
    const card = state.tables.cards[ticket.id], attentions = Object.values(state.tables.attentions).filter(row => row.ticketId === ticket.id && row.status !== 'resolved');
    const blocked = ['needs_verification', 'pending_verification', 'blocked'].includes(ticket.status)
      || attentions.some(row => /^(?:session:|stale:)/.test(row.id))
      || Object.values(state.tables.assignments).some(row => row.ticketId === ticket.id && !row.endedAt && ['paused', 'failed', 'repair_limit'].includes(row.state));
    const index = ticket.status === 'done_pending_actions' ? 3 : blocked ? 2 : ticket.status === 'running' ? 0 : 1;
    groups[index]!.items.push({ id: ticket.id, name: ticket.batch, status: ticket.status,
      ...(card && guardCard(state, card) ? { card } : {}), controls: card && guardCard(state, card) ? managedControls(card) : [], reasons: attentions.map(row => row.reason) });
  }
  for (const card of Object.values(state.tables.cards)) {
    if (card.ticketId && state.tables.tickets[card.ticketId] || !guardCard(state, card)) continue;
    if (card.id.startsWith('health:') && !Object.values(state.tables.health).some(row => !row.ok && row.episode === card.eventId)) continue;
    const index = card.id.startsWith('health:') ? 2 : 1;
    groups[index]!.items.push({ id: card.id, name: card.title, status: '陈列', card, controls: managedControls(card), reasons: [] });
  }
  const candidates = [...groups[1]!.items, ...groups[2]!.items, ...groups[3]!.items, ...groups[0]!.items].filter(item => !item.card?.deferred);
  const rank = (item: typeof candidates[number]) => item.id.startsWith('health:') ? 0 : item.card?.urgency === 'completion' ? 3 : item.card?.redline ? 1 : item.card?.question ? 2 : 4;
  candidates.sort((a, b) => rank(a) - rank(b));
  const today = candidates[0] ? { id: candidates[0].id, name: candidates[0].name,
    reason: candidates[0].card?.question || candidates[0].reasons[0] || candidates[0].card?.suggestion || '先看这件的当前进度；只是陈列，不自动推进。' } : null;
  return { sequence: state.seq, viewVersion: hash(JSON.stringify([groups, today])), groups, today };
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > 16384) throw new Error('请求太大'); chunks.push(data); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** 本机channel：只读账本；动作写统一待写入口，绝不从HTTP回调调用worker。 */
export async function startSidebar(config: Config, options: { now?: () => string; onAction?: () => void } = {}) {
  if (!config.sidebar) throw new Error('未配置 sidebar');
  const token = randomBytes(32).toString('base64url'); let origin = '';
  const server = createServer((request, response) => { void handle(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: '本机账本/请求无法安全处理；没有直接执行动作，请检查服务日志。' }));
  }); });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${token}'; style-src 'nonce-${token}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    if (request.headers.host !== origin.slice('http://'.length) || request.headers.origin && request.headers.origin !== origin
      || request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: '仅限127.0.0.1本机同源访问' });
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(sidebarHtml(token, config.sidebar!.refreshMs)); return;
    }
    if (request.headers['x-pa-token'] !== token) return send(403, { error: '本机页面凭据无效；请重新打开页面' });
    if (request.method === 'GET' && request.url === '/api/state') return send(200, sidebarSnapshot(await readLedger(config.dataDir)));
    if (request.method !== 'POST' || request.url !== '/api/action') return send(404, { error: '没有这个入口' });
    if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return send(403, { error: '动作必须由本机同源页面发出' });
    let input: any; try { input = await body(request); } catch { return send(400, { error: '动作请求格式不合法或太大' }); }
    if (!input || typeof input.id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(input.id) || typeof input.cardId !== 'string' || !Number.isSafeInteger(input.revision)
      || typeof input.action !== 'string' || input.option !== undefined && !Number.isSafeInteger(input.option)
      || input.text !== undefined && (typeof input.text !== 'string' || Array.from(input.text).length > 4000)) return send(400, { error: '动作请求字段不合法' });
    const message = await recordManagedAction(config, { id: `sidebar:${input.id}`, actor: config.feishu?.receiverId ?? 'local:owner', at: options.now?.() ?? new Date().toISOString(),
      messageId: `sidebar:${input.cardId}`, cardId: input.cardId, revision: input.revision, action: input.action,
      ...(input.option === undefined ? {} : { option: input.option }), ...(input.text === undefined ? {} : { text: input.text }) }, 'sidebar');
    options.onAction?.(); send(200, { message });
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.sidebar!.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('本机监听失败');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
