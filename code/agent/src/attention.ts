import type { Config, Input, TaskCard } from './types.js';
import type { Store } from './store.js';
import { hash, parseJson } from './util.js';
import { SafeError } from './errors.js';
import { ownerSource, workRecord } from './work-tracking.js';

export interface AttentionRule {
  id: string; revision: number; kind: 'loop' | 'pi-observation'; project?: string; sourceId?: string;
  startAt: string; expiresAt: string | null; timeZone: string | null; end: 'until-cancelled' | 'expires';
  notify: 'important' | 'changes' | 'none'; state: 'active' | 'paused' | 'expired';
  instruction: ReturnType<typeof ownerSource>; updated: string;
  intervals: { from: string; to: string | null; reason?: string }[];
}
const prefix = 'attention:rule:';
export const validTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
export class Attention {
  constructor(readonly c: Config, readonly store: Store) {}
  private permitted(rule: Pick<AttentionRule, 'kind' | 'project' | 'sourceId'>) {
    return rule.kind === 'loop' ? !!this.c.projects.find(p => p.id === rule.project)
      : !!this.c.piObservation?.sources.find(s => s.id === rule.sourceId && s.enabled);
  }
  rules(visible = true) {
    const rows = this.store.db.prepare("SELECT value FROM kv WHERE key GLOB 'attention:rule:*' ORDER BY key").all().map(row => parseJson<AttentionRule>(String(row.value)));
    return rows.filter(r => !visible || this.permitted(r)).map(r => this.expire(r));
  }
  private expire(rule: AttentionRule, now = Date.now()) {
    if (rule.state === 'active' && rule.expiresAt && Date.parse(rule.expiresAt) <= now) {
      this.store.set(`attention:history:${rule.id}:${rule.revision}`, rule);
      rule.state = 'expired'; rule.updated = new Date(now).toISOString(); rule.revision++;
      const interval = rule.intervals.at(-1); if (interval && !interval.to) { interval.to = rule.expiresAt; interval.reason = 'expired'; }
      this.store.set(prefix + rule.id, rule);
    }
    return rule;
  }
  async save(args: Record<string, unknown>, input: Input) {
    const instruction = ownerSource(this.c, this.store, input, args), now = new Date().toISOString();
    const kind = String(args.kind), project = typeof args.project === 'string' && args.project ? args.project : undefined, sourceId = typeof args.sourceId === 'string' && args.sourceId ? args.sourceId : undefined;
    if (!['loop', 'pi-observation'].includes(kind) || kind === 'loop' && (!project || sourceId) || kind === 'pi-observation' && (!sourceId || project)) throw new SafeError('invalid_arguments', '持续关注只支持明确的 Loop 项目或已登记 Pi 观察来源；缺哪项只补哪项');
    if (!this.permitted({ kind: kind as AttentionRule['kind'], project, sourceId })) throw new SafeError('outside_scope', '关注不能建立新来源/项目权限');
    const expiresAt = args.expiresAt || null;
    if (expiresAt && (!validTime(expiresAt) || Date.parse(expiresAt) <= Date.now() || !this.c.timeZone)) throw new SafeError('invalid_arguments', '期限须为带偏移的将来时间，并先配置本人 timeZone；不采用开发机器时区');
    if (!['important', 'changes', 'none'].includes(String(args.notify))) throw new SafeError('invalid_arguments', '缺少独立的提醒约定：important / changes / none');
    const same = this.rules(false).find(r => r.kind === kind && r.project === project && r.sourceId === sourceId);
    const id = typeof args.id === 'string' && args.id ? args.id : same?.id ?? `attention-${hash(JSON.stringify([kind, project, sourceId])).slice(0, 24)}`;
    if (!/^[\w.@-]{1,160}$/.test(id)) throw new SafeError('invalid_arguments', '规则 ID 无效');
    const old = this.store.get<AttentionRule | null>(prefix + id, null);
    if (!old && same && same.id !== id) throw new SafeError('duplicate', '已有同范围规则，请修订原 ID，不重复建立');
    if (old && (old.kind !== kind || old.project !== project || old.sourceId !== sourceId)) throw new SafeError('identity_mismatch', '不能把旧规则 ID 转成另一来源；只修订原范围');
    const end = expiresAt ? 'expires' : 'until-cancelled';
    if (old?.state === 'active' && old.expiresAt === expiresAt && old.notify === args.notify) return this.receipt(old, true);
    if (old) this.store.set(`attention:history:${old.id}:${old.revision}`, old);
    const intervals = old?.intervals ?? [];
    if (old?.state === 'active' && intervals.at(-1)?.to === null) intervals[intervals.length - 1]!.to = now;
    intervals.push({ from: now, to: null });
    const rule: AttentionRule = { id, revision: (old?.revision ?? 0) + 1, kind: kind as AttentionRule['kind'], project, sourceId, startAt: now, expiresAt: expiresAt as string | null, timeZone: this.c.timeZone ?? null, end, notify: args.notify as AttentionRule['notify'], state: 'active', instruction, updated: now, intervals };
    this.store.set(prefix + id, rule); return this.receipt(rule);
  }
  private receipt(rule: AttentionRule, duplicate = false) {
    const coverage = rule.kind === 'loop' ? this.store.get<{ ok?: boolean }>(`discovery:coverage:${rule.project}`, {}) : this.store.get<{ ok?: boolean }>(`pi-observation:coverage:${rule.sourceId}`, {});
    const ready = coverage.ok === true && (rule.kind !== 'loop' || !!this.c.projects.find(p => p.id === rule.project)?.loopRunDirs.length);
    return { ok: true, duplicate, rule, ready, receipt: `${ready ? '已生效' : '已保存，尚未接通/核实来源'}；${rule.kind}:${rule.project ?? rule.sourceId}；${rule.expiresAt ? `至 ${new Intl.DateTimeFormat('zh-CN', { timeZone: rule.timeZone!, dateStyle: 'short', timeStyle: 'long' }).format(new Date(rule.expiresAt))}（${rule.timeZone}）` : '直到本人取消'}；提醒：${rule.notify}。关注不授予执行、写入或停止权限。` };
  }
  pause(id: string, input: Input, args: Record<string, unknown>) {
    ownerSource(this.c, this.store, input, args);
    const rule = this.store.get<AttentionRule | null>(prefix + id, null);
    if (!rule || !this.permitted(rule)) throw new SafeError('outside_scope', '没有当前获准的原规则');
    if (rule.state === 'active') {
      this.store.set(`attention:history:${rule.id}:${rule.revision}`, rule);
      rule.state = 'paused'; rule.revision++; rule.updated = new Date().toISOString();
      const interval = rule.intervals.at(-1); if (interval && !interval.to) { interval.to = rule.updated; interval.reason = 'paused'; }
      this.store.set(prefix + id, rule);
    }
    const retained = this.store.db.prepare("SELECT id FROM tasks WHERE json_extract(body,'$.work.tracking.state')='active' AND EXISTS (SELECT 1 FROM json_each(json_extract(tasks.body,'$.work.attentionIds')) WHERE value=?)").all(id).map(r => String(r.id));
    return { ok: true, rule, retainedOneShots: retained, receipt: '已暂停接收该规则下的新工作；未撤销的一次性委托仍回收结果并回报，不停止外部执行。' };
  }
  matching(kind: AttentionRule['kind'], identity: string) { return this.rules(false).filter(r => r.kind === kind && (kind === 'loop' ? r.project : r.sourceId) === identity); }
  admission(kind: AttentionRule['kind'], identity: string, observedAt: string) {
    const rules = this.matching(kind, identity);
    return { accept: !rules.length || rules.some(r => r.state === 'active' && Date.parse(observedAt) >= Date.parse(r.startAt)), ids: rules.filter(r => r.state === 'active' && Date.parse(observedAt) >= Date.parse(r.startAt)).map(r => r.id) };
  }
  attach(card: TaskCard, ids: string[]) {
    const work = workRecord(card); card.work = { ...work, attentionIds: [...new Set([...(work.attentionIds ?? []), ...ids])] }; this.store.putTask(card);
  }
  mayNotify(card: TaskCard, important: boolean) {
    const owner = this.store.workTask(this.store.taskTarget(card.id));
    if (owner && owner.id !== card.id) card = { ...owner, work: { ...workRecord(owner), tracking: card.work?.tracking ?? owner.work?.tracking } };
    if (card.status === 'cancelled' || card.deferred) return false;
    const once = card.work?.tracking?.state === 'active';
    if (once && important) return true;
    const ids = card.work?.attentionIds;
    if (!ids?.length) return !card.work?.tracking; // Legacy tasks keep their old behavior; a reported one-shot is not future attention.
    return this.rules().some(r => ids.includes(r.id) && r.state === 'active' && (r.notify === 'changes' || r.notify === 'important' && important));
  }
}
