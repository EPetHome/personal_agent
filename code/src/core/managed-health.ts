import { hash } from './utils.ts';
import type { LedgerChange, LedgerState, LedgerTables, ManagedCard, ManagedWrite } from './managed-types.ts';

type Health = LedgerTables['health'];
export const writeHealthId = (write: ManagedWrite) => `write:${write.dispatch ? 'dispatch' : write.execution ? 'execution' : 'message'}`;
/** 只由实际结果核销故障；旧的在途成功不能盖过之后的新失败。 */
export function recordWriteHealth(state: LedgerState, add: (change: LedgerChange) => void, write: ManagedWrite, at: string, ok: boolean, reason: string) {
  const id = writeHealthId(write), old = state.tables.health[id];
  // 每个请求的失败事实仍保留，兼容原有核销/回执入口；合并的是可见故障卡。
  const receiptId = `write:${write.id}`;
  if (!ok && !state.tables.health[receiptId]) add({ kind: 'put', table: 'health', value: { id: receiptId, ok: false, kind: 'delivery', at,
    episode: receiptId, reason: `${write.execution ? '执行' : '话'}没送到/未确认：请求 ${write.id}；${reason}。不自动重发。` } });
  if (!old && ok || old?.ok === ok && old.deliveryId === write.id && old.reason === reason) return;
  if (ok && (old?.ok || old && old.deliveryId !== write.id && (write.attemptSeq ?? -1) < (old.lastFailureSeq ?? Infinity))) return;
  add({ kind: 'put', table: 'health', value: { id, ok, kind: 'delivery', at, reason, deliveryId: write.id,
    episode: ok ? '' : old?.ok === false ? old.episode : `${id}:${state.seq + 1}`,
    ...(ok ? { lastFailureSeq: old?.lastFailureSeq } : { lastFailureSeq: state.seq + 1 }) } });
}
function faultClass(state: LedgerState, health: Health): string {
  const id = health.id;
  if (id.startsWith('write:')) return state.tables.writes[id.slice(6)] ? writeHealthId(state.tables.writes[id.slice(6)]!) : id;
  if (id === 'intake' || id === 'loop' || id === 'loop:legacy') return 'source:loop';
  if (id.startsWith('worker:')) return 'source:worker';
  if (id.startsWith('connection:')) return `receive:${id.slice(11)}`;
  if (id.startsWith('source:calendar:')) return 'source:calendar';
  if (id.startsWith('source:minute:') || id === 'source:minute-discovery') return 'source:minutes';
  return id;
}
function wording(key: string, rows: Health[]) {
  if (key === 'processing') return { label: 'PA 消息处理', problem: 'PA 这一轮没有处理完，新材料和工作进展可能暂时不能更新。', action: '需要你回电脑检查运行日志；已有记录保留，不会盲目重发。' };
  if (key === 'tasks' || key === 'write:dispatch') return { label: 'PA 派工', problem: 'PA 没能确认工作已派出或交回，这项工作可能还没有开始或完成。', action: '需要你核对原任务和执行器回执；结果不确定时不会重新派出。' };
  if (key === 'write:execution') return { label: 'PA 执行', problem: 'PA 没能确认你批准的动作执行成功，这项动作的结果暂时不能确定。', action: '需要你核对原卡和执行器回执；不会自动重做。' };
  if (key.startsWith('write:')) return { label: 'PA 送话', problem: 'PA 没能确认你的话已送到，原来的工作可能仍在等你。', action: '需要你核对原卡和工作回执；不会盲目重发。' };
  if (key.startsWith('card-channel:')) return { label: '卡片送达', problem: 'PA 没能确认提醒卡片已送到，你可能暂时收不到新的工作提醒。', action: '需要你检查通知渠道并核对原卡；结果不确定不重发，明确失败最多尝试五次。' };
  if (key.startsWith('receive:')) return { label: key.includes('feishu') ? '飞书收件' : '通知渠道收件', problem: 'PA 暂时收不到这个渠道的消息，你的回复可能延后处理。', action: '需要你检查网络和接入授权；已收到的记录保留。' };
  if (key === 'source:worker') return { label: 'Loop 工作进展读取', problem: 'PA 暂时读不到 Loop 的工作进展，不能确认这批工作现在做到哪了。', action: '需要你检查 Loop 是否正常运行及读取权限；不会把读取失败当作工作会话消失。' };
  if (key === 'source:loop') return { label: 'Loop 新进展收件', problem: 'PA 暂时收不到 Loop 的新进展，新的问题和完成结果可能不能及时通知你。', action: '需要你检查事件目录和读取权限；已有工作记录保留。' };
  if (key === 'source:workspace') return { label: '收件箱读取', problem: 'PA 暂时读不到你指定的收件箱，新放进去的材料可能还没处理。', action: '需要你检查目录和读取权限；原材料不会被改动。' };
  if (key.startsWith('source:schedule') || key === 'source:calendar') return { label: '日程读取', problem: 'PA 暂时读不到日程，不能确认你是否在开会；需要会后发送的提醒会继续等。', action: '需要你检查网络和日历读取授权；已经知道的会议保留。' };
  if (key === 'source:minutes') return { label: '会议纪要读取', problem: 'PA 暂时读不到会议纪要，新的会议材料可能延后处理。', action: '需要你检查网络和纪要读取授权；原材料保留。' };
  if (key === 'service' || rows.some(row => row.kind === 'service')) {
    const restarts = rows.find(row => row.reason.startsWith('personal agent 短时间内反复重启；'));
    return { label: 'PA 常驻服务', problem: restarts ? restarts.reason : 'PA 常驻服务没有正常运行，工作进展和你的消息可能不能及时处理。', action: '需要你回电脑检查服务和运行日志；已有记录保留，不盲目重发。' };
  }
  return { label: '工作来源读取', problem: 'PA 暂时看不到工作来源，新的进展可能不能及时更新。', action: '需要你检查来源和读取权限；已有记录保留，不猜测工作已结束。' };
}
function existingFaultCards(state: LedgerState, key: string) {
  const aliases = Object.values(state.tables.health).filter(row => faultClass(state, row) === key).map(row => row.id);
  return Object.values(state.tables.cards).filter(card => card.id === `health:${key}` || aliases.some(id => card.id.startsWith(`health:${id}:`))
    || key.startsWith('card-channel:') && card.id.startsWith(`health:delivery:${key.slice(13)}:`));
}
function currentFaultCard(state: LedgerState, key: string, cards = existingFaultCards(state, key)) {
  const delivered = new Set(Object.values(state.tables.deliveries).filter(row => row.channel === 'feishu' && row.messageId).map(row => row.cardId));
  return state.tables.cards[`health:${key}`] ?? cards.sort((a, b) => Number(delivered.has(b.id)) - Number(delivered.has(a.id)) || b.at.localeCompare(a.at))[0];
}
/** 旧episode只保留为历史；不能因尚未送达而在升级后重新打扰。只做内存筛选，不迁移旧行/旧卡。 */
export function supersededFaultCards(state: LedgerState): Set<string> {
  const skipped = new Set<string>();
  for (const key of new Set(Object.values(state.tables.health).map(row => faultClass(state, row)))) {
    const cards = existingFaultCards(state, key), current = currentFaultCard(state, key, cards);
    for (const card of cards) if (card.id !== current?.id) skipped.add(card.id);
  }
  return skipped;
}
function faultGroups(state: LedgerState) {
  const groups = new Map<string, Health[]>();
  for (const health of Object.values(state.tables.health)) {
    const key = faultClass(state, health);
    // 新的类别回执已接管同源旧请求；历史失败不能永远压住实际恢复。
    if (health.id.startsWith('write:') && health.id !== key && state.tables.health[key]) continue;
    const rows = groups.get(key) ?? []; rows.push(health); groups.set(key, rows);
  }
  return groups;
}
function faultEventId(rows: Health[]) {
  return `health-status:${hash(JSON.stringify(rows.map(row => [row.id, row.ok, row.episode, row.at, row.reason]))).slice(0, 32)}`;
}
/** 展示与发卡共用类别、当前卡选择和状态身份；旧episode只兼容当前选中的那张。 */
export function activeFaultCards(state: LedgerState): Set<string> {
  const active = new Set<string>();
  for (const [key, rows] of faultGroups(state)) {
    const failed = rows.filter(row => !row.ok); if (!failed.length) continue;
    const card = currentFaultCard(state, key);
    if (card && (card.eventId === faultEventId(rows) || failed.some(row => row.episode === card.eventId))) active.add(card.id);
  }
  return active;
}
/** 同类只有一张可更新的卡。恢复也只更新一次；旧版历史行和旧卡身份不迁移。 */
export function healthCards(state: LedgerState, add: (change: LedgerChange) => void, at: string) {
  for (const [key, rows] of faultGroups(state)) {
    const failed = rows.filter(row => !row.ok), ok = !failed.length;
    const stableId = `health:${key}`;
    // 兼容旧版episode/逐请求卡：沿用最近一张的身份，不为升级另发同源卡。
    const old = currentFaultCard(state, key);
    if (ok && !old) continue;
    if (!ok && key.startsWith('card-channel:') && !old && !failed.some(row => {
      const delivery = state.tables.deliveries[row.deliveryId ?? ''];
      return delivery?.state === 'uncertain' || (delivery?.failures ?? 0) >= 5;
    })) continue;
    const eventId = faultEventId(rows);
    if (old?.eventId === eventId) continue;
    const text = wording(key, failed), id = old?.id ?? stableId;
    // 卡已入账不等于本机已通知：多条回执可在首次发出前更新它，不能因此吞掉首告。
    // sending/uncertain仍由投递历史拦下，不把未知结果当成重发授权。
    const locallyNotified = Object.values(state.tables.deliveries).some(row => row.cardId === id && row.channel === 'local' && row.state === 'sent');
    const card: ManagedCard = { id, ticketId: '', assignmentId: '', eventId, revision: (old?.revision ?? 0) + 1, at,
      title: `personal agent · ${text.label}${ok ? '已恢复' : '出了问题'}`,
      fact: ok ? `${text.label}已恢复，PA 已重新核实这个来源或动作能够正常工作。你不用处理这次故障；新的工作仍按原规则通知。` : text.problem + text.action,
      question: '', suggestion: ok ? '这次故障不用你管。' : text.action,
      basis: rows.map(row => `${row.id}：${row.reason || (row.ok ? '实际检查已恢复' : '实际检查失败')}；${row.at}`).join('\n'),
      options: [], redline: false, actionMode: 'none', urgency: 'fault', interrupt: ok || !locallyNotified,
      ...(!ok && key.startsWith('card-channel:') ? { notifyChannels: ['local'] } : {}) };
    add({ kind: 'put', table: 'cards', value: card });
  }
}
