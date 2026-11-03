import { hash } from './utils.ts';
import type { LedgerChange, LedgerState, ManagedInput, MemoryCandidate, MemoryDraft, MemoryKind, MemoryVersion } from './managed-types.ts';

type Add = (change: LedgerChange) => void;
export const confirmedMemories = (state: LedgerState): (MemoryVersion & { id: string })[] => Object.values(state.tables.memories)
  .flatMap(memory => memory.versions.at(-1) ? [{ ...memory.versions.at(-1)!, id: memory.id }] : []);
const labels: Record<MemoryKind, string> = { rule: '规则', person: '人物', preference: '偏好', focus: '在忙什么' };
/** 候选单独存，永不混进全局记忆表。版本以本人确认时为准，旧候选不能覆盖新版本。 */
export function draftMemory(state: LedgerState, add: Add, draft: MemoryDraft, at: string, ticketId?: string): MemoryCandidate | undefined {
  if (!['rule', 'person', 'preference', 'focus'].includes(draft.kind) || !draft.subject.trim() || draft.subject.length > 100 || !draft.content.trim()
    || draft.content.length > 2000 || !draft.basis.length || draft.basis.some(basis => !basis.trim()) || draft.terms.length > 10
    || draft.terms.some(term => !term.trim() || term.length > 100) || draft.kind === 'rule' && (!draft.rule || !draft.rule.options.includes(draft.rule.choice))) return;
  const memoryId = `memory:${hash(JSON.stringify([draft.kind, draft.kind === 'rule' ? draft.rule!.key : draft.subject])).slice(0, 24)}`;
  const latest = state.tables.memories[memoryId]?.versions.at(-1), expectedVersion = latest?.version ?? 0;
  if (latest?.content === draft.content) return;
  const id = `candidate:${hash(JSON.stringify([memoryId, draft.content, draft.terms, expectedVersion])).slice(0, 24)}`;
  if (state.tables.memoryCandidates[id]) return state.tables.memoryCandidates[id];
  const candidate: MemoryCandidate = { ...draft, id, memoryId, expectedVersion, at, status: 'pending', ...(ticketId ? { ticketId } : {}) };
  add({ kind: 'put', table: 'memoryCandidates', value: candidate });
  add({ kind: 'put', table: 'cards', value: { id, ticketId: ticketId ?? '', assignmentId: '', eventId: id, revision: 1, at,
    title: `${labels[draft.kind]}候选 · 待你确认`, fact: `${draft.subject}：${draft.content}${draft.terms.length ? `\n关联词：${draft.terms.join('、')}` : ''}`,
    question: `确认后才写入全局记忆 v${expectedVersion + 1}；不确认就不用。`, suggestion: '只确认这一条记忆，不扩大任何任务或权限。',
    basis: draft.basis.join('\n'), options: [], redline: false, actionMode: 'none', notifyChannels: ['feishu'], memoryCandidateId: id } });
  add({ kind: 'observation', observation: { kind: 'memory', ticketId, detail: `起草 ${id}，尚未进记忆；依据 ${draft.basis.join('；')}` } });
  return candidate;
}
export function handleMemoryAction(state: LedgerState, add: Add, input: ManagedInput): string {
  const card = state.tables.cards[input.cardId]!, candidate = card.memoryCandidateId ? state.tables.memoryCandidates[card.memoryCandidateId] : undefined;
  if (!candidate || candidate.id !== card.id || candidate.status !== 'pending') return '候选已处理或不存在，没有改记忆。';
  if (input.action === 'memory_dismiss') {
    add({ kind: 'put', table: 'memoryCandidates', value: { ...candidate, status: 'dismissed' } });
    add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, interrupt: false, deliveryText: '已略过，没有写入记忆。' } });
    return '已略过，没有写入记忆。';
  }
  if (input.action !== 'memory_confirm') return '这个按钮不能确认记忆。';
  const memory = state.tables.memories[candidate.memoryId], previous = memory?.versions.at(-1)?.version ?? 0;
  if (previous !== candidate.expectedVersion) return '记忆已有更新版本，旧候选失效；没有覆盖。';
  const { id: _id, memoryId: _memoryId, expectedVersion: _expected, at: _at, status: _status, ticketId: _ticket, ...draft } = candidate;
  const version: MemoryVersion = { ...draft, version: previous + 1, at: input.at, actor: input.actor, inputId: input.id, candidateId: candidate.id };
  add({ kind: 'put', table: 'memories', value: { id: candidate.memoryId, kind: candidate.kind, versions: [...(memory?.versions ?? []), version] } });
  add({ kind: 'put', table: 'memoryCandidates', value: { ...candidate, status: 'confirmed' } });
  add({ kind: 'put', table: 'cards', value: { ...card, revision: card.revision + 1, interrupt: false, deliveryText: `已确认，写入 ${candidate.memoryId} v${version.version}；不授予任何执行权限。` } });
  add({ kind: 'observation', observation: { kind: 'memory', ticketId: candidate.ticketId, actor: input.actor, detail: `本人确认 ${candidate.id} → ${candidate.memoryId} v${version.version}；输入 ${input.id}` } });
  return `已确认${labels[candidate.kind]}记忆 v${version.version}；之后问答和研判可引用，权限不变。`;
}
/** 用户连续五次的同类选法只起草候选，不从意图卡或自动结果学习权限。 */
export function learnRuleCandidates(state: LedgerState, add: Add, at: string) {
  const keys = new Set(Object.values(state.tables.choices).map(row => row.ruleKey).filter((key): key is string => !!key));
  for (const key of keys) {
    const choices = Object.values(state.tables.choices).filter(row => row.ruleKey === key).slice(-5), last = choices.at(-1)!;
    if (choices.length < 5 || !choices.every(row => row.selected === last.selected) || !last.options?.includes(last.selected)) continue;
    draftMemory(state, add, { kind: 'rule', subject: last.question!, content: `同类问题优先选「${last.selected}」；仍按当前意图和红线核对。`, terms: [],
      rule: { key, choice: last.selected, question: last.question!, options: last.options }, basis: choices.map(row => `本人选择 ${row.requestId}；事件 ${row.eventId}；选 ${row.selected}`) }, at, last.ticketId);
  }
}
/** 可确定的本人陈述先起草；普通材料不会在此入口自行写长期记忆。 */
export function memoryStatement(text: string, inputId: string): MemoryDraft | undefined {
  let kind: MemoryKind, subject: string, content: string;
  const explicit = /^(?:记忆候选[：:]\s*)?(人物|偏好|在忙什么)[：:]\s*([^：:\n]{1,100})[：:]\s*(.{1,2000})$/s.exec(text.trim());
  if (explicit) {
    kind = ({ 人物: 'person', 偏好: 'preference', 在忙什么: 'focus' } as const)[explicit[1] as '人物']; subject = explicit[2]!.trim(); content = explicit[3]!.trim();
  } else {
    const person = /^([\p{L}\p{N}_· -]{1,40})[：:]\s*(.{1,500}(?:负责人|经理|同事|联系人|设计师|工程师))。?$/u.exec(text.trim());
    const preference = /^(?:记住[：:]?\s*)?我(?:偏好|喜欢|习惯)[：:]?\s*(.{1,1000})$/s.exec(text.trim());
    const focus = /^我(?:最近|现在|目前)?(?:在忙|正在做)[：:]?\s*(.{1,1000})$/s.exec(text.trim());
    if (person) { kind = 'person'; subject = person[1]!.trim(); content = person[2]!.trim(); }
    else if (preference) { kind = 'preference'; subject = '我的偏好'; content = preference[1]!.trim(); }
    else if (focus) { kind = 'focus'; subject = '我在忙什么'; content = focus[1]!.trim(); }
    else return;
  }
  const org = /^([\p{L}\p{N}_. -]{1,80}?)(?:\s*的\s*|\s+)(?:产品|技术|设计|项目|业务)?(?:负责人|经理|同事|联系人)/u.exec(content)?.[1]?.trim();
  return { kind, subject, content, terms: org ? [org] : [], basis: [`飞书本人陈述 ${inputId}；待本人确认，不是既有记忆`] };
}
/** 问答只检索事情和已确认版本；完全不读取候选/观测/飞书上下文来补人物关系。 */
export function memoryAnswer(state: LedgerState, text: string): string | undefined {
  const memories = confirmedMemories(state);
  const related = /^(.+?)(?:相关的事|相关事项)[？?。]?$/.exec(text.trim());
  if (related) {
    const subject = related[1]!.trim(), people = memories.filter(row => row.kind === 'person' && row.subject === subject);
    const terms = [...new Set([subject, ...people.flatMap(row => row.terms)])];
    const tickets = Object.values(state.tables.tickets).filter(ticket => {
      const intent = ticket.intents.at(-1), card = state.tables.cards[ticket.id];
      const material = [ticket.batch, intent?.result, intent?.goal, card?.fact, card?.question].join('\n');
      return terms.some(term => material.includes(term));
    });
    return `${people.map(row => `${row.subject}：${row.content}（已确认 ${row.id} v${row.version}）\n`).join('')}${tickets.length ? tickets.map(ticket => `${ticket.batch}：${ticket.intents.at(-1)?.result}（账本 ${ticket.id}）`).join('\n') : '账本里没有找到直接相关的事项。'}${people.length ? '' : '\n没有已确认的人物关系，只按原名字查账本，不推断关联。'}`;
  }
  const kind = /^(?:我的|已确认的)?偏好[？?]?$/.test(text.trim()) ? 'preference' : /^(?:我(?:现在|最近)?在忙什么|在忙什么)[？?]?$/.test(text.trim()) ? 'focus'
    : /^(?:已确认的)?规则参照[？?]?$/.test(text.trim()) ? 'rule' : undefined;
  if (!kind) return;
  const rows = memories.filter(row => row.kind === kind);
  return rows.length ? rows.map(row => `${row.subject}：${row.content}（已确认 ${row.id} v${row.version}）`).join('\n') : '没有已确认的这类记忆；未确认的候选不使用。';
}
