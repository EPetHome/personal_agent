import { randomUUID } from 'node:crypto';
import type { Config, Input, TaskCard, Turn, Verification } from './types.js';
import type { Store } from './store.js';
import type { Channel } from './channel.js';
import type { TaskContext } from './task-context.js';
import type { Workers } from './worker.js';
import { deliver } from './channel.js';
import { Attention } from './attention.js';
import { observationGrant } from './pi-observation.js';
import { hash, parseJson } from './util.js';
import { SafeError } from './errors.js';
import { readBytes } from './file-policy.js';
import { executionOrigin } from './work-tracking.js';
import { retainObservationGrants } from './context.js';

interface Fact {
  id: string; inputId: string; issuedAt: string; checkedAt: string | null; basis: Verification['basis']; indexComplete: boolean; scope: 'task' | 'overview' | 'action' | 'material';
  tasks: { id: string; version: string }[]; rules: { id: string; revision: number }[]; sources: Record<string, string>; authorization: string;
  current: boolean; complete: boolean; coverage: unknown; version: string;
}
export interface ReplyFragment {
  kind: 'text' | 'task' | 'overview' | 'decision' | 'delivery' | 'notice' | 'action' | 'material'; text: string;
  factId?: string; taskId?: string; certainty?: 'current' | 'last-known' | 'unknown'; coverage?: 'complete' | 'partial';
}
export const taskFactVersion = (card: TaskCard) => hash(JSON.stringify([card.id, card.goal, card.completion, card.boundary, card.status, card.waiting, card.conclusion, card.deferred, card.worker, card.sourceRevision, card.sourceFingerprint, card.sourceCurrent, card.lastVerifiedAt, card.sourceHealth, card.work, card.observation]));
export const FACT_FRESH_MS = 60_000;
const actionTools = new Set(['worker_dispatch', 'worker_reply', 'worker_stop', 'track_work', 'organize_work', 'link_work', 'attention_save', 'attention_pause', 'list_attention']);
const factTools = new Set(['get_task', 'list_tasks', 'list_projects', 'query_loop', 'query_pi_observations', 'list_executions', 'worker_status', 'worker_dispatch', 'worker_reply', 'worker_stop', 'record_local_work', 'track_work', 'organize_work', 'link_work', 'attention_save', 'attention_pause', 'list_attention', 'read_file', 'read_task_evidence', 'search_files', 'verify_observed_result']);
export class ReplyFacts {
  constructor(readonly c: Config, readonly store: Store, readonly channel: Channel, readonly tasks: TaskContext, readonly workers: Workers) {}
  private authorization() { return hash(JSON.stringify([this.c.projects, this.c.readAllow, this.c.readDeny, this.c.piObservation, this.c.timeZone])); }
  disclosureScope() { return hash(JSON.stringify([this.c.projects, this.c.readAllow, this.c.readDeny])); }
  saveDisclosure(t: Turn) {
    retainObservationGrants(this.store, t.input.id, {}, this.disclosureScope(), t);
  }
  private verification(tool: string, result: Record<string, any>, cards: TaskCard[], issuedAt: string): Verification {
    if (result.verification) return result.verification as Verification; // Program-owned read adapters, never model reply arguments.
    const times = cards.flatMap(card => card.lastVerifiedAt ? [card.lastVerifiedAt] : []).sort();
    if (actionTools.has(tool)) return { basis: 'action', checkedAt: issuedAt, current: result.ok === true || tool === 'list_attention', indexComplete: !result.hasMore, sourceComplete: false };
    if (['record_local_work', 'verify_observed_result'].includes(tool)) return { basis: 'action', checkedAt: result.ok === true ? issuedAt : times[0] ?? null, current: result.ok === true, indexComplete: true, sourceComplete: result.ok === true };
    if (['read_file', 'read_task_evidence', 'search_files'].includes(tool) && result.ok === true && typeof result.sha256 === 'string') return { basis: 'material', checkedAt: issuedAt, current: true, indexComplete: !result.truncated, sourceComplete: !result.truncated };
    if (tool === 'query_loop') {
      const rows = Array.isArray(result.batches) ? result.batches : [], coverage = result.coverage ?? {};
      const complete = result.v === 1 && !result.partial && !result.hasMore && result.total !== null && coverage.totalProjects > 0 && this.c.projects.some(p => p.loopRunDirs.length) && coverage.checkedSources === coverage.indexedSources && coverage.failures === 0;
      const checked = rows.flatMap((row: any) => row.ok && row.lastVerifiedAt ? [String(row.lastVerifiedAt)] : []).sort();
      return { basis: 'source', checkedAt: checked[0] ?? (complete ? result.at : null), current: result.ok !== false && (complete || rows.length > 0 && rows.every((row: any) => row.ok === true)), indexComplete: !result.hasMore, sourceComplete: complete };
    }
    // Listings of cached records, projects or evidence references do not query
    // every source. Empty arrays and absence of an error cannot prove freshness.
    return { basis: 'cache', checkedAt: times[0] ?? null, current: false, indexComplete: !result.hasMore, sourceComplete: false };
  }
  /** Called only on actual tool results, never on model-supplied fact metadata. */
  issue(tool: string, args: Record<string, unknown>, value: unknown, t: Turn) {
    if (!factTools.has(tool) || !value || typeof value !== 'object' || Array.isArray(value)) return value;
    const result = value as Record<string, any>, ids = new Set<string>();
    if (result.card?.id) ids.add(result.card.id);
    if (result.id && this.store.task(result.id)) ids.add(result.id);
    if (result.taskId && this.store.task(result.taskId)) ids.add(result.taskId);
    if (['get_task', 'worker_status', 'read_task_evidence', 'list_executions'].includes(tool) && typeof args.id === 'string' && this.store.task(args.id)) ids.add(args.id);
    for (const row of Array.isArray(result.rows) ? result.rows : []) if (typeof row?.id === 'string' && this.store.task(row.id)) ids.add(row.id);
    const cards = [...ids].flatMap(id => { const card = this.store.task(id); return card ? [card] : []; });
    const sourceIds = new Set(cards.flatMap(card => [...(card.observation ? [card.observation.sourceId] : []), ...(card.work?.executions.filter(e => e.kind === 'pi-observation').map(e => e.sourceId) ?? [])]));
    if (tool === 'query_pi_observations') for (const s of this.c.piObservation?.sources.filter(s => s.enabled) ?? []) sourceIds.add(s.id);
    const sources = Object.fromEntries([...sourceIds].map(id => [id, observationGrant(this.tasks.observations.source(id))]));
    t.observationGrants = { ...t.observationGrants, ...sources };
    this.saveDisclosure(t);
    const issuedAt = new Date().toISOString(), verification = this.verification(tool, result, cards, issuedAt);
    const current = verification.current && !!verification.checkedAt && Date.now() - Date.parse(verification.checkedAt) <= FACT_FRESH_MS && result.ok !== false;
    const fact: Fact = { id: randomUUID(), inputId: t.input.id, issuedAt, checkedAt: verification.checkedAt, basis: verification.basis, indexComplete: verification.indexComplete, scope: verification.basis === 'material' ? 'material' : actionTools.has(tool) ? 'action' : ['list_tasks', 'list_projects', 'query_loop', 'query_pi_observations'].includes(tool) ? 'overview' : cards.length ? 'task' : tool.startsWith('read_') || tool === 'search_files' ? 'material' : 'action',
      tasks: cards.map(card => ({ id: card.id, version: taskFactVersion(card) })), rules: [...(result.rule ? [result.rule] : []), ...(tool === 'list_attention' && Array.isArray(result.rows) ? result.rows : [])].map(r => ({ id: r.id, revision: r.revision })), sources, authorization: this.authorization(), current, complete: current && verification.sourceComplete && !result.partial && !result.hasMore,
      coverage: result.coverage ?? { scope: tool, count: result.count ?? 1, partial: result.ok === false }, version: hash(JSON.stringify(value)) };
    this.store.set(`reply:fact:${t.input.id}:${fact.id}`, fact);
    return { ...result, fact: { id: fact.id, issuedAt: fact.issuedAt, checkedAt: fact.checkedAt, basis: fact.basis, scope: fact.scope, current: fact.current, indexComplete: fact.indexComplete, complete: fact.complete, coverage: fact.coverage, version: fact.version, rule: '仅本轮可用；声明事项/总量/催办/交付须引用本 fact，未知/部分不能标完整当前事实' } };
  }
  disclosure(t: Turn) {
    this.saveDisclosure(t); // Include program publications, even outside this async Turn's immediate call stack.
    if (Object.keys(t.observationGrants ?? {}).length && this.store.get(`reply:access:${t.input.id}`, this.disclosureScope()) !== this.disclosureScope()) throw new SafeError('outside_scope', '观察资源授权已变，本轮旧内容不再披露');
    for (const [id, grant] of Object.entries(t.observationGrants ?? {})) if (observationGrant(this.tasks.observations.source(id)) !== grant) throw new SafeError('outside_scope', '观察来源已撤销/变更，本轮旧正文不得继续提交模型');
  }
  private relevant(card: TaskCard, input: Input) {
    if (this.workers.relevant(card, input)) return true;
    if (card.work?.instruction?.inputId === input.id || card.work?.tracking?.inputId === input.id) return true;
    return !!this.store.db.prepare("SELECT 1 FROM kv WHERE key GLOB 'worker:op:*' AND json_extract(value,'$.thread')=? AND json_extract(value,'$.request.taskId')=?").get(input.id, card.id);
  }
  async validate(args: Record<string, unknown>, t: Turn) {
    this.disclosure(t);
    let fragments: ReplyFragment[];
    if (typeof args.fragments === 'string' && args.fragments) {
      const parsed = parseJson<unknown>(args.fragments);
      if (!Array.isArray(parsed) || parsed.length > 30) throw new SafeError('invalid_arguments', '回复片段须为有界 JSON 数组');
      fragments = parsed;
      if (typeof args.text === 'string' && args.text.trim()) throw new SafeError('invalid_arguments', '不能在核对片段之外夹带未核对的 text');
    } else fragments = [{ kind: typeof args.taskId === 'string' || typeof args.factId === 'string' ? 'task' : 'text', text: String(args.text ?? ''), taskId: typeof args.taskId === 'string' ? args.taskId : undefined, factId: typeof args.factId === 'string' ? args.factId : undefined, certainty: args.certainty as ReplyFragment['certainty'] }];
    if (!fragments.length) throw new SafeError('invalid_arguments', '回复不能为空');
    const delivered: string[] = [], sourceGrants: Record<string, string> = {};
    for (const fragment of fragments) {
      if (!fragment || typeof fragment !== 'object' || !['text', 'task', 'overview', 'decision', 'delivery', 'notice', 'action', 'material'].includes(fragment.kind) || typeof fragment.text !== 'string' || !fragment.text.trim() || fragment.text.length > 16000) throw new SafeError('invalid_arguments', '回复片段类型/长度无效');
      if (fragment.kind === 'text') {
        if (fragment.taskId || fragment.factId) throw new SafeError('missing_evidence', '带事项身份的文字不能声明为普通片段绕过核对');
        continue; // Natural-language correctness is a separate semantic check, not a keyword filter.
      }
      const fact = typeof fragment.factId === 'string' ? this.store.get<Fact | null>(`reply:fact:${t.input.id}:${fragment.factId}`, null) : null;
      if (!fact || !fact.basis || !fact.issuedAt || fact.inputId !== t.input.id || Date.now() - Date.parse(fact.issuedAt) > 300_000 || fact.authorization !== this.authorization()) throw new SafeError('stale_fact', '事项片段缺少本轮有效依据，或依据/权限已过期；请查询原来源或说明未知');
      if (!['current', 'last-known', 'unknown'].includes(fragment.certainty ?? 'current') || (fragment.certainty ?? 'current') === 'current' && (!fact.current || !fact.checkedAt || Date.now() - Date.parse(fact.checkedAt) > FACT_FRESH_MS)) throw new SafeError('unverified', '当前依据未核实，只能说明最后已知或未知');
      if (fragment.kind === 'material' ? fact.scope !== 'material' : fact.scope === 'material') throw new SafeError('missing_evidence', '材料票据只证明材料读取/版本，不能证明事项状态；材料片段用 material');
      if (fragment.kind === 'action' ? fact.scope !== 'action' : fact.scope === 'action') throw new SafeError('missing_evidence', '动作回执不证明来源当前状态；动作片段用 action，事项状态另核对来源');
      if (fact.rules?.length) new Attention(this.c, this.store).rules();
      for (const rule of fact.rules ?? []) if (this.store.get<{ revision: number } | null>(`attention:rule:${rule.id}`, null)?.revision !== rule.revision) throw new SafeError('stale_fact', '原关注规则已变更，不能用旧回执宣称生效');
      for (const [id, grant] of Object.entries(fact.sources)) {
        if (observationGrant(this.tasks.observations.source(id)) !== grant) throw new SafeError('outside_scope', '原观察来源已撤销或字段权限已变');
        sourceGrants[id] = grant;
      }
      if (fragment.kind === 'overview') {
        if (fact.scope !== 'overview' || fragment.coverage !== (fact.complete ? 'complete' : 'partial')) throw new SafeError('partial_coverage', '总量片段须如实绑定本轮覆盖；部分/失败不等于全局无任务');
      } else if (!['action', 'material'].includes(fragment.kind) && !fact.tasks.length) throw new SafeError('missing_evidence', '事项片段没有原事项身份；省略 taskId 不能绕过');
      if (fragment.taskId && !fact.tasks.some(ref => ref.id === fragment.taskId)) throw new SafeError('identity_mismatch', '回复引用不属于该事项');
      for (const ref of fact.tasks.filter(ref => !fragment.taskId || ref.id === fragment.taskId)) {
        const card = this.store.workTask(ref.id); if (!card) throw new SafeError('not_found', '原事项不存在');
        await this.tasks.authorize(card);
        if (card.observation && !this.tasks.observations.current(card) && (fragment.certainty ?? 'current') === 'current') throw new SafeError('unverified', '导出租约未核实，只能说明最后已知或未知');
        if (taskFactVersion(this.store.task(card.id)!) !== ref.version) throw new SafeError('stale_fact', '原事项在查询后已变化，不能使用旧版本回复');
        const event = !!this.store.db.prepare('SELECT 1 FROM task_events WHERE task=? AND event=?').get(card.id, t.input.id);
        const related = this.relevant(card, t.input);
        if (fragment.kind === 'notice') {
          if (!event || !new Attention(this.c, this.store).mayNotify(card, ['done', 'delivered', 'settled', 'closed', 'waiting', 'paused', 'repair-limit', 'needs-decision', 'failed', 'incomplete', '等你决定', '可合入', '已合入', '已放弃'].includes(card.sourceCurrent?.state ?? card.status) || card.sourceHealth?.ok === false)) throw new SafeError('notice_cancelled', '该来源变化不满足当前提醒约定或已取消');
        } else if (fragment.kind !== 'overview' && (!related || this.workers.quietTask(card, t.input))) throw new SafeError('no_new_decision', '无关旧事项不附带催办；请仅回答本轮问题');
        if (fragment.kind === 'delivery') {
          const current = card.work?.executions.find(e => e.key === card.work?.currentExecution);
          const observed = card.observation || current?.kind === 'pi-observation';
          const worker = executionOrigin(this.store, card).worker;
          const loopLayers = card.verified?.layers as { results?: unknown[] } | undefined;
          const loopReturned = worker?.kind === 'loop' && card.sourceDefinition?.state !== 'pending' && (['done', '已合入'].includes(card.verified?.state ?? '') || card.verified?.state === '可合入' && (card.verified.snapshot as { executionEnded?: boolean }).executionEnded && !!loopLayers?.results?.length);
          const verified = observed ? card.status === 'delivered' && current?.result?.verified : card.status === 'delivered' || worker?.kind === 'pi' && card.verified?.state === 'done' && (!card.sourceCurrent || card.sourceCurrent.state === 'done') || loopReturned;
          if (observed && verified) for (const material of current!.result!.refs) {
            const { data } = await readBytes(material.path, () => this.tasks.files.check(material.path, true), this.c.intake.maxFileBytes);
            if (hash(data) !== material.sha256) throw new SafeError('file_changed', '交付前原结果材料版本已变');
          }
          if (!verified || !fact.current || ['cancelled', 'closed', 'reconciled'].includes(card.status)) throw new SafeError('unverified_delivery', '运行停稳/退出或来源自述不是已核实交付；一次性责任保留');
          delivered.push(card.id);
        }
      }
    }
    this.disclosure(t);
    const text = fragments.map(f => f.text).join('\n\n');
    if (text.length > 64000) throw new SafeError('invalid_arguments', '回复总长度超过本次上限');
    return { text, delivered, sourceGrants };
  }
  async send(args: Record<string, unknown>, t: Turn) {
    const checked = await this.validate(args, t);
    const result = await deliver(this.store, this.channel, t.input.id, `${t.input.id}:reply:${hash(checked.text)}`, checked.text, t.signal);
    t.replied = result.status === 'sent' || t.replied;
    t.observationGrants = { ...t.observationGrants, ...checked.sourceGrants };
    this.saveDisclosure(t);
    if (result.status === 'sent') {
      for (const id of checked.delivered) {
        const card = this.store.task(id); if (!card?.work?.tracking || card.work.tracking.state !== 'active') continue;
        card.work.tracking = { ...card.work.tracking, state: 'reported', reportedBy: t.input.id }; this.store.putTask(card);
      }
      const id = typeof args.taskId === 'string' ? args.taskId : t.taskId, card = id ? this.store.task(id) : undefined;
      if (card && typeof result.id === 'string' && !card.subscriptions.some(s => s.kind === 'message' && s.value === result.id)) { card.subscriptions.push({ kind: 'message', value: result.id }); this.store.putTask(card); }
    }
    return result;
  }
}
