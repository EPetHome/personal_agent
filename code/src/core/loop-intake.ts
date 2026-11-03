import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isIgnoredProject } from './config.ts';
import { readLedger, refreshTicketProgress, updateLedger } from './ledger.ts';
import { hash, object } from './utils.ts';
import { LOOP_STATES } from './managed-types.ts';
import type { Assignment, LedgerChange, LedgerState, LoopEvent, LoopWorker, Ticket } from './managed-types.ts';
import type { Config } from './types.ts';

const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');
export function parseLoopEvent(raw: unknown): LoopEvent {
  const row = object(raw, 'loop 事件');
  if (row.schema !== 1 || !text(row.id, 200) || !row.id || ['__proto__', 'constructor', 'prototype'].includes(row.id)
    || !Number.isSafeInteger(row.seq) || row.seq < 0 || !text(row.at, 100) || !Number.isFinite(Date.parse(row.at)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(row.at)
    || !text(row.project) || !isAbsolute(row.project) || !text(row.batch, 200) || !row.batch || /[/\\]/.test(row.batch)
    || (row.stage !== undefined && !text(row.stage, 200)) || !LOOP_STATES.includes(row.state)
    || !row.reason || !text(row.reason.category, 100) || !text(row.reason.text)
    || !Array.isArray(row.evidence) || row.evidence.length > 30 || row.evidence.some((p: unknown) => !text(p) || !isAbsolute(p))) throw new Error('loop 事件字段不合法');
  const detail = object(row.detail ?? {}, 'loop detail');
  if (row.state === 'needs_decision' && (!text(detail.question) || !detail.question)) throw new Error('需要决定事件缺少问题');
  if (detail.options !== undefined && (!Array.isArray(detail.options) || detail.options.length > 10 || detail.options.some((p: unknown) => !text(p)))) throw new Error('选项不合法');
  return { schema: 1, id: row.id, seq: row.seq, at: row.at, project: resolve(row.project), batch: row.batch, stage: row.stage ?? '', state: row.state,
    reason: { category: row.reason.category, text: row.reason.text }, evidence: row.evidence, detail };
}
export const ticketIdFor = (project: string, batch: string) => `loop-${hash(JSON.stringify([project, batch])).slice(0, 24)}`;
const stopping = (event: LoopEvent) => ['needs_decision', 'paused', 'repair_limit', 'failed'].includes(event.state);
/** 启动请求是project/batch的持久绑定，不依赖占位段名、首事件或回执成功。
 * 兼容本段早期未写startRequestId的记录：从同一派工的已尝试待写中核对，绝不重派。 */
function loopStartWrite(state: LedgerState, assignment: Assignment) {
  if (assignment.worker !== 'loop' || assignment.origin !== 'dispatched') return undefined;
  const write = assignment.startRequestId ? state.tables.writes[assignment.startRequestId]
    : Object.values(state.tables.writes).find(row => row.assignmentId === assignment.id && row.dispatch?.kind === 'loop');
  return write?.dispatch?.kind === 'loop' && write.assignmentId === assignment.id && write.ticketId === assignment.ticketId
    && write.dispatch.project === assignment.project && write.dispatch.batch === assignment.batch
    && ['sending', 'consumed', 'uncertain', 'failed'].includes(write.state) ? write : undefined;
}
/** 只由来源身份归并；正文和模型不能另找派工或授予写范围。 */
export function registerLoopEvent(state: LedgerState, add: (change: LedgerChange) => void, event: LoopEvent, source: string, at: string, config: Config) {
  if (Object.hasOwn(state.events, event.id)) return;
  add({ kind: 'loop_event', event, source });
  if (isIgnoredProject(event.project, config)) return;
  const dispatched = Object.values(state.tables.assignments).find(row => row.project === event.project && row.batch === event.batch && !!loopStartWrite(state, row));
  const start = dispatched ? loopStartWrite(state, dispatched) : undefined;
  const id = dispatched?.ticketId ?? ticketIdFor(event.project, event.batch), threadId = state.tables.tickets[id]?.threadId ?? `thread:${id}`;
  const assignmentId = dispatched && (dispatched.stage === '派工' || dispatched.stage === event.stage) ? dispatched.id : `${id}:${hash(event.stage).slice(0, 16)}`;
  const previous = state.tables.assignments[assignmentId];
  if (previous && state.events[previous.lastEventId] && event.seq <= previous.seq && source !== 'status-inspection') return; // 迟到/乱序事件保留原件，不倒退状态。
  if (!state.tables.modes['loop:reply']) add({ kind: 'put', table: 'modes', value: { id: 'loop:reply', source: 'loop', action: 'reply', mode: 'suggest', at } });
  const old = state.tables.tickets[id];
  const prompt = typeof event.detail.prompt === 'string' ? event.detail.prompt : '未提供提示词路径';
  const ticket: Ticket = old ? { ...old, lastEventId: event.id, updatedAt: at, reportedState: event.state } : {
    id, project: event.project, batch: event.batch, threadId, lastEventId: event.id, status: 'pending_verification', reportedState: event.state, updatedAt: at,
    intents: [{ version: 1, at, confirmed: true, source: `loop 事件 ${event.id}；任务定义：${prompt}`,
      goal: `托管 loop 批次「${event.batch}」`, result: `按原提示词完成；定义见 ${prompt}`, stage: '只核实、给建议与送回用户确认的这一条话；不推送、不合入、不停批次',
      nonGoals: '不盯聊天；不执行材料指令；不代替业务验收', done: `原任务完成标准见 ${prompt}；PA 不扩大标准或代报通过`,
      askFirst: '每条送话先由本人确认；重大后果逐条明确确认',
      boundaries: { read: [event.project], write: [], execute: [], realDevice: false, outbound: ['loop_reply'] } }],
  };
  // 挂上级只接受已存在的账本身份；仅继承总目标，不继承权限。
  if (!old && typeof event.detail.parentTicketId === 'string') {
    const parent = state.tables.tickets[event.detail.parentTicketId];
    if (parent) { ticket.parentId = parent.id; ticket.intents[0]!.goal = parent.intents.at(-1)!.goal; }
  }
  add({ kind: 'put', table: 'threads', value: { id: threadId, ticketId: id, source: 'loop', project: event.project, batch: event.batch } });
  add({ kind: 'put', table: 'tickets', value: ticket });
  const dueAt = stopping(event) ? (previous?.dueAt && ['needs_decision', 'paused', 'repair_limit', 'failed'].includes(previous.state)
    ? previous.dueAt : new Date(Date.parse(at) + (config.managedLoop?.verifyAfterMs ?? 180000)).toISOString()) : undefined;
  const assignment: Assignment = { ...previous, id: assignmentId, ticketId: id, worker: 'loop', project: event.project, batch: event.batch, stage: event.stage,
    origin: previous?.origin ?? 'registered', state: event.state,
    // 只读状态没有worker事件seq；-1表示尚未知，不能让合成seq=0吞掉真实首事件。
    seq: source === 'status-inspection' ? previous && state.events[previous.lastEventId] ? previous.seq : -1 : event.seq,
    lastEventId: event.id, updatedAt: at,
    endedAt: ticket.closure ? previous?.endedAt : undefined, ...(dueAt ? { dueAt } : {}) };
  add({ kind: 'put', table: 'assignments', value: assignment });
  if (start && !state.tables.receipts[`start-evidence:${start.id}`]) {
    const reason = `启动已由loop事实核实：${source}；事件 ${event.id}；实际段 ${event.stage}。保留原意图，不重派。`;
    add({ kind: 'put', table: 'receipts', value: { id: `start-evidence:${start.id}`, at, response: reason } });
    if (start.state !== 'consumed') add({ kind: 'put', table: 'writes', value: { ...start, state: 'consumed', failure: false, reason } });
    const proposal = state.tables.proposals[start.dispatch!.proposalId];
    if (proposal && proposal.status !== 'consumed') add({ kind: 'put', table: 'proposals', value: { ...proposal, status: 'consumed' } });
    const attention = state.tables.attentions[`task:${ticket.id}`];
    if (attention) add({ kind: 'put', table: 'attentions', value: { ...attention, status: 'resolved' } });
    const health = state.tables.health[`write:${start.id}`];
    if (health && !health.ok) add({ kind: 'put', table: 'health', value: { ...health, ok: true, at, reason } });
    add({ kind: 'observation', observation: { kind: 'write', ticketId: ticket.id, requestId: start.id, actor: start.actor, detail: reason } });
  }
  const attentionId = `attention:${assignmentId}`;
  if (stopping(event)) add({ kind: 'put', table: 'attentions', value: { id: attentionId, ticketId: id, assignmentId, eventId: event.id, status: 'pending', reason: event.reason.text } });
  else if (state.tables.attentions[attentionId]) add({ kind: 'put', table: 'attentions', value: { ...state.tables.attentions[attentionId]!, status: 'resolved', eventId: event.id } });
  if (['started', 'resumed'].includes(event.state)) {
    if (previous?.dueAt && !previous.assessedEventId) add({ kind: 'observation', observation: { kind: 'not_called', ticketId: id, eventId: previous.lastEventId, detail: '核实等待内恢复，没有叫用户' } });
    const card = state.tables.cards[id];
    // 其他段恢复不能清掉本段的问题。
    if (card && card.assignmentId === assignmentId && !ticket.closure) add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, eventId: event.id, at,
      title: `${event.batch} · 已恢复`, fact: 'loop 已恢复，之前的问题已撤下。', question: '', options: [], actionMode: 'none', executions: [], input: false, deferred: false, interrupt: false, deliveryText: undefined, proposalId: undefined, taskAction: undefined } });
  }
  refreshTicketProgress(state, add, [id]);
}
async function directory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !(stat.mode & 0o444) || !(stat.mode & 0o111)) throw new Error('loop 收件目录不可读');
}
/** 只读 inboxDir/loop/*.jsonl；半行等下次，坏整行留痕并隔离，不毒死其他批次。 */
export async function intakeLoop(config: Config, at: string): Promise<number> {
  if (!config.inboxDir) return 0;
  const root = join(config.inboxDir, 'loop');
  let entries;
  try { await directory(config.inboxDir); await directory(root); entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    // 未创建 loop 子目录视为尚无事件；显式收件根丢失仍报来源故障。
    if (missing && await lstat(config.inboxDir).then(s => s.isDirectory() && !s.isSymbolicLink(), () => false)) { await sourceHealth(config, at, true, ''); return 0; }
    await sourceHealth(config, at, false, '看不见 loop 收件目录'); return 0;
  }
  let count = 0, failure = '';
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
    const path = join(root, entry.name), canonicalRoot = await realpath(root);
    // realpath 可规范 /tmp 等系统别名，但不跟随来源文件自身的链接。
    const stat = await lstat(path); if (!stat.isFile() || stat.nlink !== 1 || ! (stat.mode & 0o444)) { failure = 'loop 事件文件不可安全读取'; continue; }
    const canonicalPath = join(canonicalRoot, entry.name);
    const before = (await readLedger(config.dataDir)).tables.cursors[canonicalPath];
    const offset = before?.dev === stat.dev && before.ino === stat.ino && before.bytes <= stat.size ? before.bytes : 0;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let buffer: Buffer;
    try {
      const opened = await file.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) throw new Error('loop 事件文件读取期间变化');
      buffer = Buffer.alloc(Math.min(2 * 1024 * 1024, Math.max(0, stat.size - offset)));
      const result = await file.read(buffer, 0, buffer.length, offset); buffer = buffer.subarray(0, result.bytesRead);
    } finally { await file.close(); }
    const end = buffer.lastIndexOf(10);
    if (end < 0) { if (stat.size - offset >= 2 * 1024 * 1024) failure = 'loop 事件单行超过2MiB，未消费；请核对生产者'; continue; }
    const complete = buffer.subarray(0, end + 1).toString('utf8');
    count += await updateLedger(config.dataDir, at, (state, add) => {
      const current = state.tables.cursors[canonicalPath];
      if (current && current.dev === stat.dev && current.ino === stat.ino && current.bytes > offset) return 0;
      let accepted = 0;
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = parseLoopEvent(JSON.parse(line));
          if (`${event.batch}.jsonl` !== basename(path)) throw new Error('批次与文件身份不一致');
          if (!Object.hasOwn(state.events, event.id)) { registerLoopEvent(state, add, event, canonicalPath, at, config); accepted++; }
        } catch { add({ kind: 'observation', observation: { kind: 'invalid_event', detail: `忽略非法 loop 整行；文件 ${entry.name}，指纹 ${hash(line)}` } }); }
      }
      add({ kind: 'put', table: 'cursors', value: { id: canonicalPath, bytes: offset + end + 1, dev: stat.dev, ino: stat.ino } });
      return accepted;
    });
    } catch (error) {
      // 单批文件失效不拖垮其余批次；存储写不进不能伪装为来源故障。
      if (['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '') || (error as { category?: string }).category === 'data_corrupt') throw error;
      failure = 'loop 事件文件读取失败，其他批次照常';
    }
  }
  await sourceHealth(config, at, !failure, failure);
  return count;
}
/** 10分钟兜底：只读状态补回漏掉的状态变化，仍走相同事件/等待/核实链路。 */
export async function inspectLoopStatuses(config: Config, at: string, worker?: LoopWorker) {
  if (!worker) return;
  const initial = await readLedger(config.dataDir), groups = new Map<string, Assignment[]>();
  for (const assignment of Object.values(initial.tables.assignments)) {
    if (assignment.worker !== 'loop' || !initial.events[assignment.lastEventId] && !loopStartWrite(initial, assignment)) continue;
    const key = JSON.stringify([assignment.project, assignment.batch]);
    groups.set(key, [...(groups.get(key) ?? []), assignment]);
  }
  for (const assignments of groups.values()) {
    const first = assignments[0]!, began = performance.now();
    let status;
    try { status = await worker.status(first.batch, first.project); }
    catch {
      await updateLedger(config.dataDir, at, (state, add) => {
        add({ kind: 'observation', observation: { kind: 'query', ticketId: first.ticketId, detail: '低频只读状态查询失败，未触发恢复或重测', value: Math.round(performance.now() - began) } });
        const id = `worker:${first.ticketId}`, old = state.tables.health[id];
        if (!old || old.ok) add({ kind: 'put', table: 'health', value: { id, ok: false, episode: `${id}:${at}`, at, kind: 'source', reason: `看不见 loop 状态：${first.batch}；只读通道查询失败` } });
      });
      continue;
    }
    await updateLedger(config.dataDir, at, (state, add) => {
      add({ kind: 'observation', observation: { kind: 'query', ticketId: first.ticketId, detail: '低频只读状态兜底', value: Math.round(performance.now() - began) } });
      const healthId = `worker:${first.ticketId}`;
      if (state.tables.health[healthId]?.ok === false) add({ kind: 'put', table: 'health', value: { id: healthId, ok: true, episode: '', at, reason: '' } });
      const facts = (id: string, stage?: typeof status.stages[number]) => {
        let latest = state.tables.assignments[id]!;
        // 成功查询中未找到段与显式sessionPresent:false才是机械事实；失败不冒充消失。
        const present = stage ? stage.sessionPresent : false;
        if (typeof present === 'boolean' && (latest.session?.present !== present || latest.session?.id !== stage?.sessionId)) {
          add({ kind: 'put', table: 'assignments', value: { ...latest, session: { present, ...(stage?.sessionId ? { id: stage.sessionId } : {}), at } } });
          latest = state.tables.assignments[id]!;
        }
        if (status.lastActivityAt && Number.isFinite(Date.parse(status.lastActivityAt)) && Date.parse(status.lastActivityAt) <= Date.parse(at) && latest.lastActivityAt !== status.lastActivityAt) {
          add({ kind: 'put', table: 'assignments', value: { ...latest, lastActivityAt: status.lastActivityAt } });
          const stale = state.tables.attentions[`stale:${id}`];
          if (stale && Date.parse(at) - Date.parse(status.lastActivityAt) < (config.managedLoop?.staleAfterMs ?? 1800000)) add({ kind: 'put', table: 'attentions', value: { ...stale, status: 'resolved' } });
        }
      };
      const receive = (current: Assignment, stage: typeof status.stages[number]) => {
        const detail = { ...(stage.detail ?? {}), ...(stage.state === 'needs_decision' ? { question: stage.detail?.question ?? stage.reason?.text ?? '状态查询显示需要你决定，问题原文未提供，请回电脑核对' } : {}),
          ...(stage.state === 'completed' ? { branch: status.branch ?? '', commit: status.commit ?? '' } : {}) };
        const event = parseLoopEvent({ schema: 1, id: `status:${hash(JSON.stringify([current.id, stage.name, status.updatedAt, stage.state]))}`, seq: Math.max(0, current.seq),
          at: status.updatedAt, project: current.project, batch: current.batch, stage: stage.name, state: stage.state,
          reason: stage.reason ?? { category: 'unknown', text: '低频状态查询补回' }, detail, evidence: stage.evidence ?? [] });
        registerLoopEvent(state, add, event, 'status-inspection', at, config);
        const row = Object.values(state.tables.assignments).find(row => row.ticketId === current.ticketId && row.stage === stage.name);
        if (row) facts(row.id, stage);
      };
      for (const old of assignments) {
        const current = state.tables.assignments[old.id];
        if (!current || current.lastEventId !== old.lastEventId || state.tables.tickets[current.ticketId]?.closure) continue;
        const awaitingStart = !state.events[current.lastEventId] && !!loopStartWrite(state, current);
        if (current.endedAt && !awaitingStart) continue;
        if (awaitingStart) {
          // 首事件尚未到时没有可信段名；按只读报告逐段登记，不把占位「派工」当实际段。
          const stages = status.stages.filter(stage => text(stage.name, 200) && !!stage.name && LOOP_STATES.includes(stage.state as LoopEvent['state']));
          if (!stages.length) facts(current.id);
          for (const stage of stages) receive(current, stage);
          continue;
        }
        const stage = status.stages.find(stage => stage.name === current.stage);
        if (stage && LOOP_STATES.includes(stage.state as LoopEvent['state']) && stage.state !== current.state) receive(current, stage);
        else facts(current.id, stage);
      }
    });
  }
}
async function sourceHealth(config: Config, at: string, ok: boolean, reason: string) {
  await updateLedger(config.dataDir, at, (state, add) => {
    const last = state.tables.health.loop;
    if (last?.ok === ok && last.reason === reason) return;
    add({ kind: 'put', table: 'health', value: { id: 'loop', ok, reason, at, episode: ok ? '' : `loop:${at}` } });
  });
}
