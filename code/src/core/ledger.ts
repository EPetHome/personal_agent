import { join } from 'node:path';
import { appendJsonl, measureHeldStoreLock, readJsonl } from './store.ts';
import { withNamedLock } from './locks.ts';
import { hash } from './utils.ts';
import { randomUUID } from 'node:crypto';
import { OperationFailure } from './failures.ts';
import type { LedgerChange, LedgerState, LedgerTable, LedgerTransaction } from './managed-types.ts';

const TABLES: LedgerTable[] = ['threads', 'tickets', 'assignments', 'assessments', 'attentions', 'cards', 'writes', 'deliveries', 'inputs', 'receipts', 'cursors', 'health', 'connections', 'modes', 'handoffs', 'proposals', 'conversations', 'choices', 'memoryCandidates', 'memories', 'materials', 'materialAssessments', 'calendars'];
export const ledgerPath = (dataDir: string) => join(dataDir, 'ledger.jsonl');
export function emptyLedger(): LedgerState {
  return { tables: Object.fromEntries(TABLES.map(table => [table, Object.create(null)])) as LedgerState['tables'], events: Object.create(null), observations: [], transactionIds: new Set(), seq: 0, checksum: '' };
}
function apply(state: LedgerState, change: LedgerChange, at: string) {
  if (change.kind === 'put') {
    if (!TABLES.includes(change.table) || !change.value || typeof change.value.id !== 'string' || !change.value.id
      || ['__proto__', 'prototype', 'constructor'].includes(change.value.id)) throw new OperationFailure('data_corrupt', '账本实体结构损坏；保留现场');
    (state.tables[change.table] as Record<string, unknown>)[change.value.id] = structuredClone(change.value);
  } else if (change.kind === 'loop_event') {
    if (!change.event || typeof change.event.id !== 'string' || !change.event.id || Object.hasOwn(state.events, change.event.id)) throw new OperationFailure('data_corrupt', '账本事件结构损坏或身份重复');
    state.events[change.event.id] = structuredClone(change.event);
  } else if (change.kind === 'observation') state.observations.push({ ...change.observation, at });
  else throw new OperationFailure('data_corrupt', '不支持的账本变更；未改写');
}
/** 唯一状态来源。不读取/迁移旧 events、state、outbox 或个人目录。 */
export async function readLedger(dataDir: string): Promise<LedgerState> {
  return withNamedLock(dataDir, '.ledger.lock', () => measureHeldStoreLock(() => readLedgerUnlocked(dataDir)), 30000);
}
async function readLedgerUnlocked(dataDir: string): Promise<LedgerState> {
  const state = emptyLedger();
  for (const row of await readJsonl<LedgerTransaction>(ledgerPath(dataDir))) {
    if (!row || row.schema !== 1 || row.seq !== state.seq + 1 || row.previous !== state.checksum || !Array.isArray(row.changes)
      || typeof row.id !== 'string' || !row.id || state.transactionIds.has(row.id) || !Number.isFinite(Date.parse(row.at))) throw new OperationFailure('data_corrupt', '账本事务结构/顺序损坏；先备份，未覆盖');
    const { checksum, ...body } = row;
    if (checksum !== hash(JSON.stringify(body))) throw new OperationFailure('data_corrupt', '账本校验失败；保留现场，不截断恢复');
    for (const change of row.changes) apply(state, change, row.at);
    state.seq = row.seq; state.checksum = checksum; state.transactionIds.add(row.id);
  }
  return state;
}
/** 短事务：不得在回调内访问模型、渠道或 worker。整批变更一行 fsync 后才可产生副作用。 */
export async function updateLedger<T>(dataDir: string, at: string, operation: (state: LedgerState, add: (change: LedgerChange) => void) => T, id = randomUUID()): Promise<T> {
  return withNamedLock(dataDir, '.ledger.lock', () => measureHeldStoreLock(async () => {
    const state = await readLedgerUnlocked(dataDir), changes: LedgerChange[] = [];
    const result = operation(state, change => { apply(state, change, at); changes.push(structuredClone(change)); });
    if (changes.length && !state.transactionIds.has(id)) {
      const body = { schema: 1 as const, id, seq: state.seq + 1, at, previous: state.checksum, changes };
      await appendJsonl(ledgerPath(dataDir), [{ ...body, checksum: hash(JSON.stringify(body)) }]);
    }
    return result;
  }), 30000);
}
/** worker交回结果不等于事情结束；只有后段经用户确认的动作才能真正收尾。 */
export function refreshTicketProgress(state: LedgerState, add: (change: LedgerChange) => void, ids = Object.keys(state.tables.tickets)) {
  for (const id of ids) {
    const ticket = state.tables.tickets[id]; if (!ticket) continue;
    // 飞书起草/查询/skill的进度由单次派工回执推进，不套用loop完成提交核实。
    if (state.tables.threads[ticket.threadId]?.source !== 'loop') continue;
    if (ticket.closure) {
      if (ticket.status !== ticket.closure.kind) add({ kind: 'put', table: 'tickets', value: { ...ticket, status: ticket.closure.kind } });
      continue;
    }
    // 已交回的补查只是历史派工；失败/完成都不能压住后来的干活派工。
    const assignments = Object.values(state.tables.assignments).filter(row => row.ticketId === id && !row.endedAt);
    const assessment = (eventId: string) => state.tables.assessments[`assessment:${eventId}`];
    const stops = assignments.filter(row => ['needs_decision', 'paused', 'repair_limit', 'failed'].includes(row.state) && !assessment(row.lastEventId)?.suppressed);
    const status = stops.length ? stops.some(row => !!assessment(row.lastEventId)) ? 'waiting_user' : 'pending_verification'
      : assignments.some(row => ['started', 'resumed'].includes(row.state) || assessment(row.lastEventId)?.suppressed) ? 'running'
        : assignments.some(row => row.state === 'queue') ? 'waiting'
          : assignments.length && assignments.every(row => row.state === 'completed')
            ? assignments.every(row => {
              if (row.worker === 'pi') return Object.values(state.tables.writes).some(write => write.assignmentId === row.id && !!write.dispatch && write.state === 'consumed');
              const result = assessment(row.lastEventId)?.commit?.result;
              return result === 'branch' || result === 'candidate';
            }) ? 'done_pending_actions' : 'needs_verification'
            : 'pending_verification';
    if (ticket.status !== status) add({ kind: 'put', table: 'tickets', value: { ...ticket, status } });
  }
}
export function ledgerSummary(state: LedgerState) {
  const counts = (kind: string) => state.observations.filter(row => row.kind === kind).length;
  const choices = state.observations.filter(row => row.kind === 'suggestion');
  const models = [...Object.values(state.tables.assessments), ...Object.values(state.tables.materialAssessments)].filter(row => row.model?.used);
  return { schema: 1, transactions: state.seq, ...state.tables,
    observations: { called: counts('called'), notCalled: counts('not_called'), loopMisreports: counts('loop_misreport'),
      suggestionChoices: choices.length, suggestionRatio: choices.length ? choices.filter(row => row.value === 1).length / choices.length : null,
      modelCalls: models.length, unknownUsageCalls: models.filter(row => row.model?.usage?.totalTokens === undefined).length,
      knownTokens: models.reduce((sum, row) => sum + (row.model?.usage?.totalTokens ?? 0), 0),
      knownCostUSD: models.reduce((sum, row) => sum + (row.model?.usage?.costUSD ?? 0), 0),
      unknownCostCalls: models.filter(row => row.model?.usage?.costUSD === undefined).length,
      queries: counts('query'), queryMs: state.observations.filter(row => row.kind === 'query').reduce((sum, row) => sum + (row.value ?? 0), 0) } };
}
