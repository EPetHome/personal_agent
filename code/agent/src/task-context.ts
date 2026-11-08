import { dirname, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config, Input, Material, Project, TaskCard } from './types.js';
import type { Store } from './store.js';
import type { Files } from './files.js';
import type { Workers, WorkerSnapshot } from './worker.js';
import { loopReferences, readLoopReference, type LoopReference } from './loop.js';
import { kernelSource, repository } from './loop-kernel.js';
import { readBytes } from './file-policy.js';
import { hash, parseJson } from './util.js';
import { SafeError, failure } from './errors.js';

export const SOURCE_GAPS = ['未登记的 Loop 单会话未接通', '独立 Pi 未接通（PA 已派 Pi 沿原任务查询）', '未知协议未接通', '办公/搜索新来源及完整长期关注管理未接通'];
const short = (v: string | undefined, n = 240) => (v ?? '').slice(0, n);

/** Model-facing projections only. Full task bodies/snapshots remain in the
 * existing Store; index/detail/evidence all recheck the current grants. */
export class TaskContext {
  private readonly loopQueries = new Map<string, { scope: string; created: number; refs: LoopReference[]; errors: string[]; checked: Map<number, { current: boolean; ok: boolean }> }>();
  constructor(readonly c: Config, readonly store: Store, readonly files: Files, readonly workers: Workers) {}
  private async projects() {
    const allowed: Project[] = [];
    for (const p of this.c.projects) try { await this.files.protocolPath(p.root, p.root); allowed.push(p); } catch { /* Counts must not expose denied projects either. */ }
    return allowed;
  }
  private async authorize(card: TaskCard) {
    if (!card.worker || !card.worker.project && !['loop', 'pi'].includes(card.worker.kind)) return;
    const p = (await this.projects()).find(p => [p.id, p.root].includes(card.worker!.project));
    if (!p) throw new SafeError('outside_scope', '原事项当前不在获准读取范围');
    const b = card.worker.loop;
    if (!b && card.worker.kind === 'loop' && card.worker.batchFile) await this.files.protocolPath(p.root, card.worker.batchFile, true);
    if (b) {
      await this.files.protocolPath(p.root, b.ledger);
      if ((await repository(this.c, p.root)).common !== b.repository) throw new SafeError('outside_scope', '原仓库身份已变化');
    }
  }
  async visibleSummary(card: TaskCard) {
    try { await this.authorize(card); return this.summary(card); }
    catch { return { id: card.id, unavailable: true, reason: '原事项当前不在获准读取范围' }; }
  }
  summary(card: TaskCard) {
    return { id: card.id, title: short(card.title, 160), project: card.worker?.project, status: card.status, localTaskState: card.status,
      sourceState: card.sourceCurrent?.state ?? card.verified?.state,
      goal: card.sourceDefinition?.state === 'pending' ? '任务定义待读取' : short(card.goal) || '任务定义按需读取',
      definitionState: card.sourceDefinition?.state, lastVerifiedAt: card.lastVerifiedAt ?? null, updated: card.updated,
      freshness: card.sourceHealth?.ok === false ? '当前未核实；保留最后可靠事实' : '最后已知事实；问当前状态须先查询来源',
      ...(card.sourceHealth ? { sourceHealth: card.sourceHealth } : {}),
      decision: !!card.waiting || !!card.deferred, waiting: short(card.waiting, 120), origin: card.worker?.origin,
      ...(card.worker?.loop ? { source: { repository: card.worker.loop.repository, runId: card.worker.loop.runId, taskId: card.worker.loop.taskId }, sourceRevision: card.sourceRevision } : {}) };
  }
  async context(input: Input) {
    const projects = await this.projects(), names = projects.flatMap(p => [p.id, p.root]);
    const page = this.store.taskPage(names, { limit: 5 }), decisions = this.store.taskPage(names, { limit: 3, decisionOnly: true });
    const visible = [], pending = [];
    for (const row of page.rows) {
      const card = this.store.task(row.id)!;
      try { await this.authorize(card); visible.push(row); } catch { /* Withhold cached source bodies after a grant changes. */ }
    }
    for (const row of decisions.rows) {
      try { await this.authorize(this.store.task(row.id)!); pending.push({ id: row.id, title: row.title, status: row.status, attention: '保留待决定；无关问答不催办，详情按需读取' }); } catch { /* Same gate for hints. */ }
    }
    const matched: ReturnType<TaskContext['summary']>[] = [];
    for (const card of this.store.match(input).slice(0, 5)) {
      try {
        await this.authorize(card);
        matched.push({ ...this.summary(card), completion: short(card.completion, 180), boundary: short(card.boundary, 180), worker: card.worker ? { kind: card.worker.kind, project: card.worker.project, batchFile: card.worker.batchFile } : undefined,
          verified: card.verified ? { state: card.verified.state, event: card.verified.event } : undefined,
          dispatches: card.dispatches.slice(-1).map(value => { const event = value as { event?: string; status?: string }; return { event: event.event, status: event.status }; }) } as ReturnType<TaskContext['summary']>);
      } catch { /* Old quote IDs are not grants. */ }
    }
    return { type: '任务表', rows: visible, total: page.total, count: visible.length, withheld: page.count - visible.length, partial: page.hasMore || visible.length !== page.count, totalKind: '已登记的当前事项索引；历史用 includeClosed，索引计数不等于实时全来源总量', hasMore: page.hasMore, nextCursor: page.nextCursor,
      matchedCards: matched, decisions: { total: decisions.total, count: pending.length, hasMore: decisions.hasMore, rows: pending }, detail: '这里只含摘要。list_projects/list_tasks 分页；get_task 按需读原定义、事实及证据。问现在先查来源；不把部分/失败说成无任务。',
      coverage: this.coverage(projects), projects: projects.slice(0, 5).map(p => ({ id: p.id })), projectIndex: { total: projects.length, count: Math.min(5, projects.length), hasMore: projects.length > 5 } };
  }
  coverage(projects: Project[]) {
    return { scope: '获准项目正式新版 Loop 单/多任务记录；旧 v1 保留兼容。不是全来源、全过程恢复',
      projects: projects.slice(0, 10).map(p => ({ id: p.id, ...this.store.get<Record<string, unknown>>(`discovery:coverage:${p.id}`, { ok: false, partial: true, checkedAt: null, reason: '尚未完成来源核对' }) })),
      totalProjects: projects.length, count: Math.min(10, projects.length), hasMore: projects.length > 10, gaps: SOURCE_GAPS };
  }
  async projectPage(cursor = '', limit = 10) {
    const projects = (await this.projects()).sort((a, b) => a.id.localeCompare(b.id));
    const scope = hash(JSON.stringify(projects.map(p => [p.id, p.root])));
    let after = '';
    if (cursor) { const value = parseJson<{ scope: string; after: string }>(Buffer.from(cursor, 'base64url').toString()); if (value.scope !== scope || typeof value.after !== 'string') throw new SafeError('invalid_arguments', '项目分页范围已变，请从第一页重新查'); after = value.after; }
    const rest = projects.filter(p => !after || p.id.localeCompare(after) > 0), page = rest.slice(0, Math.min(50, Math.max(1, limit)));
    return { total: projects.length, count: page.length, hasMore: rest.length > page.length,
      nextCursor: rest.length > page.length ? Buffer.from(JSON.stringify({ scope, after: page.at(-1)!.id })).toString('base64url') : null,
      rows: page.map(p => ({ id: p.id, root: p.root, tasks: this.store.taskPage([p.id, p.root], { project: [p.id, p.root], limit: 1 }).total, coverage: this.store.get(`discovery:coverage:${p.id}`, { ok: false, partial: true, checkedAt: null }) })), gaps: SOURCE_GAPS };
  }
  async taskPage(options: { project?: string; cursor?: string; limit?: number; includeClosed?: boolean } = {}, signal?: AbortSignal) {
    const projects = await this.projects(), names = projects.flatMap(p => [p.id, p.root]);
    const project = options.project ? projects.find(p => [p.id, p.root].includes(options.project!)) : undefined;
    if (options.project && !project) throw new SafeError('outside_scope', '不是当前获准项目');
    const page = this.store.taskPage(names, { ...options, project: project ? [project.id, project.root] : undefined });
    const rows = [];
    let withheld = 0;
    for (const row of page.rows) {
      try { rows.push(await this.detail(String(row.id), [], signal, false)); }
      catch (error) { signal?.throwIfAborted(); withheld++; }
    }
    return { ...page, rows, count: rows.length, withheld, partial: page.hasMore || withheld > 0 || rows.some(row => !row.ok), coverage: this.coverage(project ? [project] : projects), checkedAt: new Date().toISOString(), note: '仅核对此页，未读完不代表完整实时全貌；查询不建立任务或永久关注' };
  }
  private async pendingDefinition(card: TaskCard) {
    // Optional consumer metadata is not part of default context. Preserve the
    // original arguments on demand without importing an execution adapter.
    const value = (card as TaskCard & { outputDraft?: unknown }).outputDraft;
    if (!value || typeof value !== 'object') return undefined;
    const draft = value as { sourceInput?: unknown; arguments?: unknown };
    if (typeof draft.sourceInput !== 'string' || !draft.arguments || typeof draft.arguments !== 'object' || Array.isArray(draft.arguments)) return undefined;
    const args = draft.arguments as Record<string, unknown>, origin = this.store.row(draft.sourceInput)?.input;
    if (args.taskId !== card.id || args.worker !== 'pi' || typeof args.options !== 'string' || origin?.source !== 'feishu' || origin.who !== this.c.feishu.userId) return undefined;
    try {
      const options = parseJson<{ output?: { source?: unknown } }>(args.options);
      if (typeof options.output?.source !== 'string') return undefined;
      await this.files.check(options.output.source, true);
      return { sourceInput: draft.sourceInput, arguments: args };
    } catch (error) { return { unavailable: true, reason: failure(error).error }; }
  }
  private sourceView(card: TaskCard, snapshot: WorkerSnapshot): NonNullable<TaskCard['sourceCurrent']> {
    const data = snapshot.data && typeof snapshot.data === 'object' ? snapshot.data as Record<string, unknown> : {};
    const view: NonNullable<TaskCard['sourceCurrent']> = { worker: card.worker!.kind, state: short(snapshot.state, 80), active: snapshot.active === true, checkedAt: new Date().toISOString(), next: short(snapshot.next, 80) || undefined };
    if (card.worker?.kind === 'loop') {
      const stages = Array.isArray(data.stages) ? data.stages : [];
      view.stageCount = stages.length;
      view.stages = stages.slice(0, 10).map(s => ({ name: short(s.stage, 120), state: short(s.state, 80), alive: s.session?.alive === true }));
      if (typeof data.next === 'string') view.next = short(data.next, 80);
    } else if (card.worker?.kind === 'pi') {
      if (data.operation !== card.worker.batchFile) throw new SafeError('identity_mismatch', 'Pi 当前查询不是原派工');
      const result = data.result as { state?: string; answer?: { summary?: string; question?: string }; cleaned?: boolean } | undefined;
      if (result) view.result = { state: short(result.state, 80), summary: short(result.answer?.summary, 2000), question: short(result.answer?.question, 600) || undefined, cleaned: result.cleaned === true };
    }
    return view;
  }
  async detail(id: string, materials: Material[], signal?: AbortSignal, expand = true) {
    let card = this.store.task(id);
    if (!card) return { ok: false, reason: '未找到任务；不据此断言来源没有任务' };
    await this.authorize(card); signal?.throwIfAborted();
    let ok = true, reason: string | undefined;
    if (card.worker?.batchFile) {
      try {
        const result = await this.workers.status(id, signal);
        if (!result.ok) throw new SafeError('unverified', result.reason ?? '原来源当前未核实');
        card = this.store.task(id)!;
        if (result.snapshot && !result.snapshot.loopBinding) {
          await this.authorize(card);
          const view = this.sourceView(card, result.snapshot);
          const current = this.store.task(id)!;
          current.sourceCurrent = view; current.lastVerifiedAt = view.checkedAt;
          current.sourceHealth = { ok: true, checkedAt: view.checkedAt }; this.store.putTask(current); card = current;
        }
      } catch (error) {
        signal?.throwIfAborted(); ok = false; reason = failure(error).error;
        card = this.store.task(id)!;
        card.sourceHealth = { ok: false, checkedAt: new Date().toISOString(), reason }; this.store.putTask(card);
      }
    }
    await this.authorize(card);
    const summary = this.summary(card);
    if (!expand) return { ok, ...summary, ...(reason ? { reason } : {}) };
    const layers = card.verified?.layers as Record<string, unknown> | undefined;
    const result = { ok, ...summary, ...(reason ? { reason } : {}), completion: short(card.completion, 600), boundary: short(card.boundary, 600), conclusion: short(card.conclusion, 2000),
      worker: card.worker ? { kind: card.worker.kind, project: card.worker.project, batchFile: card.worker.batchFile, loop: card.worker.loop } : undefined,
      layers: card.worker?.loop ? { execution: layers?.execution, checks: layers?.checks, results: Array.isArray(layers?.results) ? layers.results.filter(r => { const value = r as { task?: string }; return [card!.worker!.loop!.taskId, card!.worker!.loop!.runId].includes(value.task ?? ''); }).slice(-10) : [], publication: layers?.publication, businessAcceptance: '未验证' }
        : { execution: card.sourceCurrent ?? { state: card.verified?.state ?? card.status, checkedAt: card.lastVerifiedAt ?? null }, gate: layers?.gate ?? '未核实', review: layers?.review ?? '未核实', acceptance: layers?.acceptance ?? '未核实', businessAcceptance: '未验证' },
      outputDraft: await this.pendingDefinition(card),
      evidence: '用 read_task_evidence 按当前权限读取；这里不注入原日志或完整 snapshot',
      definition: card.sourceDefinition ? await this.definition(card, materials) : { state: 'read', goal: card.goal, completion: card.completion, boundary: card.boundary } };
    materials.push({ path: `task://${id}`, sha256: hash(JSON.stringify(result)) }); return result;
  }
  private async definition(card: TaskCard, materials: Material[]) {
    const binding = card.worker?.loop;
    if (!binding) return { state: 'pending', reason: '任务定义待读取' };
    const pending = (reason: string, scope?: unknown) => {
      const current = this.store.task(card.id);
      if (current?.worker?.loop?.runId === binding.runId && current.sourceDefinition) { current.sourceDefinition.state = 'pending'; this.store.putTask(current); }
      return { state: 'pending', reason, ...(scope ? { scope } : {}) };
    };
    try {
      await this.authorize(card);
      const project = this.c.projects.find(p => [p.id, p.root].includes(card.worker!.project))!;
      const source = await kernelSource(this.c, this.files, project, binding.ledger);
      if (source.id !== binding.runId) throw new SafeError('identity_mismatch', '原运行已变化');
      const { data } = await readBytes(binding.ledger, () => this.files.protocolPath(project.root, binding.ledger), this.c.intake.maxFileBytes);
      const raw = parseJson<any>(data.toString());
      if (raw.id !== binding.runId || raw.common !== binding.repository || raw.file !== binding.cardFile || raw.revision !== source.revision) throw new SafeError('identity_mismatch', '定义读取期间原运行身份或修订变化');
      const record = raw.taskRecords?.find((r: any) => r.id === binding.taskId);
      const task = record ? raw.card.tasks.find((t: any) => t.name === record.name) ?? record.definition
        : raw.card.tasks.find((t: any) => t.name === binding.taskId) ?? (binding.taskId === null && raw.card.tasks.length === 1 ? raw.card.tasks[0] : undefined);
      if (!task || typeof task.prompt !== 'string') throw new Error('冻结任务定义缺少提示词');
      const original = resolve(dirname(binding.cardFile), task.prompt), rel = relative(raw.repo, original);
      if (rel.startsWith('../') || rel === '..') throw new Error('冻结定义越过原仓库');
      const worktree = record?.worktree ?? raw.worktree;
      const copied = typeof worktree === 'string' ? resolve(worktree, rel) : original;
      const versions = record?.userFileVersions ?? raw.userFileVersions ?? {};
      const expected = versions[original] ?? versions[copied];
      if (typeof expected !== 'string') return pending('任务定义待读取：缺少冻结正文版本，不用基线或当前可变文本冒充原目标', task.scope);
      let path = '', content = '';
      for (const candidate of new Set([original, copied])) {
        try {
          const prompt = await readBytes(candidate, () => this.files.protocolPath(project.root, candidate), 200 * 1024);
          if (hash(prompt.data) === expected) { path = candidate; content = prompt.data.toString('utf8'); break; }
        } catch { /* Try only the other pre-gated copy of this exact frozen definition. */ }
      }
      if (!path) throw new SafeError('unverified', '冻结任务正文缺失、已变化或当前无读取权限');
      await this.authorize(card); await this.files.protocolPath(project.root, path);
      if (!data.equals((await readBytes(binding.ledger, () => this.files.protocolPath(project.root, binding.ledger), this.c.intake.maxFileBytes)).data)) throw new SafeError('file_changed', '定义读取期间来源再次变化');
      const current = this.store.task(card.id)!;
      if (current.worker?.loop?.runId !== binding.runId || (current.sourceRevision ?? -1) > raw.revision) throw new SafeError('file_changed', '原任务已更新，保留新事实');
      current.sourceDefinition = { state: 'read', prompt: path, sha256: expected }; this.store.putTask(current);
      materials.push({ path, sha256: expected });
      return { state: 'read', path, sha256: expected, content: content.slice(0, 16000), truncated: content.length > 16000, scope: task.scope };
    } catch (error) { return pending(`任务定义待读取：${failure(error).error}`); }
  }
  async eventPage(after: number, limit: number) {
    const rows = [], page = this.store.events(after, limit);
    for (const row of page) {
      const event = parseJson<any>(row.event), data = event.data;
      const id = typeof data?.task === 'string' ? data.task : typeof data?.arguments?.taskId === 'string' ? data.arguments.taskId : undefined;
      if (id) { const card = this.store.task(id); if (card) { try { await this.authorize(card); } catch { continue; } } }
      // Audit logs contain historical snapshots and tool/file bodies. They are
      // not an alternate permission-free path to those source records.
      rows.push({ seq: row.seq, at: event.at, kind: event.kind, taskId: id, inputId: data?.inputId, tool: data?.tool,
        ...(event.kind === 'input' && data?.source === 'feishu' && data.who === this.c.feishu.userId ? { text: short(data.text, 2000) } : {}),
        detail: '仅审计入口摘要；原任务/定义/证据请按当前权限查询' });
    }
    return { rows, count: rows.length, withheld: page.length - rows.length, nextAfter: page.at(-1)?.seq ?? after, hasMore: page.length === limit };
  }
  async evidence(id: string, key: string, materials: Material[], signal?: AbortSignal, offset = 0, length = 16000) {
    const card = this.store.task(id); if (!card) throw new SafeError('not_found', '未找到原事项');
    await this.authorize(card);
    const paths = card.verified?.evidence ?? {};
    if (!key) {
      const rows = [];
      for (const [name, path] of Object.entries(paths).slice(0, 20)) {
        try { await this.files.check(path, true); rows.push({ key: name, path }); } catch { /* Not a grant. */ }
      }
      return { total: Object.keys(paths).length, count: rows.length, hasMore: Object.keys(paths).length > 20, rows };
    }
    const path = paths[key]; if (!path) throw new SafeError('not_found', '该原事项没有此证据引用');
    return this.files.read(path, materials, true, offset, Math.min(64000, length), false, signal);
  }
  private async lastConfirmed(reference: LoopReference, signal?: AbortSignal) {
    const project = this.c.projects.find(p => p.root === reference.project);
    if (!project) return null;
    try {
      let row;
      if (reference.protocol === 'kernel:1') {
        if (!reference.ledger) return null;
        // The path alone is not a run identity: a card may now point at another
        // run. Resolve the still-readable formal header before linking old facts.
        const source = await kernelSource(this.c, this.files, project, reference.ledger, signal);
        row = this.store.db.prepare("SELECT id FROM tasks WHERE json_extract(body,'$.worker.kind')='loop' AND json_extract(body,'$.worker.project') IN (?,?) AND json_extract(body,'$.worker.loop.protocol')='kernel:1' AND json_extract(body,'$.worker.loop.repository')=? AND json_extract(body,'$.worker.loop.runId')=? AND json_extract(body,'$.worker.loop.cardFile')=? AND json_extract(body,'$.worker.loop.ledger')=? AND json_extract(body,'$.worker.batchFile')=? ORDER BY updated DESC,id LIMIT 1")
          .get(project.id, project.root, source.repository, source.id, source.card, reference.ledger, source.card);
      } else {
        if (!reference.file) return null;
        row = this.store.db.prepare("SELECT id FROM tasks WHERE json_extract(body,'$.worker.kind')='loop' AND json_extract(body,'$.worker.project') IN (?,?) AND json_extract(body,'$.worker.loop') IS NULL AND json_extract(body,'$.worker.batchFile')=? AND json_extract(body,'$.worker.batchFile')<>'' ORDER BY updated DESC,id LIMIT 1")
          .get(project.id, project.root, reference.file);
      }
      const card = row ? this.store.task(String(row.id)) : undefined;
      if (!card) return null;
      await this.authorize(card); return this.summary(card);
    } catch { signal?.throwIfAborted(); return null; }
  }
  async loopPage(materials: Material[], signal?: AbortSignal, offset = 0, limit = 10, cursor = '') {
    try {
      const projects = await this.projects(), scope = hash(JSON.stringify([projects, this.c.readAllow, this.c.readDeny, this.c.loop]));
      let id: string, position = Math.max(0, Math.floor(offset));
      if (cursor) {
        const value = parseJson<{ id: string; position: number; scope: string }>(Buffer.from(cursor, 'base64url').toString());
        if (value.scope !== scope || !Number.isSafeInteger(value.position) || value.position < 0) throw new SafeError('invalid_arguments', '来源分页范围已变，请重新查询');
        id = value.id; position = value.position;
      } else {
        const index = await loopReferences(this.c, this.files, projects, signal); id = randomUUID();
        for (const [key, query] of this.loopQueries) if (query.created < Date.now() - 300_000) this.loopQueries.delete(key);
        if (this.loopQueries.size >= 8) this.loopQueries.delete(this.loopQueries.keys().next().value!);
        this.loopQueries.set(id, { scope, created: Date.now(), refs: index.references, errors: index.errors, checked: new Map() });
      }
      const query = this.loopQueries.get(id);
      if (!query || query.scope !== scope || query.created < Date.now() - 300_000 || position > query.refs.length) throw new SafeError('invalid_arguments', '临时来源分页已失效，请从第一页重新查询');
      const token = (at: number) => Buffer.from(JSON.stringify({ id, position: at, scope })).toString('base64url');
      const batches: unknown[] = []; let reads = 0;
      // Metadata references are frozen per query; only this bounded page reads
      // source facts. No task card, subscription or durable attention is created.
      while (position < query.refs.length && reads++ < 24 && batches.length < Math.min(50, Math.max(1, limit))) {
        const at = position++, reference = query.refs[at]!;
        try {
          const batch = await readLoopReference(this.c, this.files, reference, signal, true);
          const current = !!batch && (batch.kernel ? !batch.kernel.executionEnded || !['已合入', '已放弃'].includes(batch.state) : !['done', 'closed', 'cancelled'].includes(batch.state) || batch.stages.some(s => s.session?.alive));
          query.checked.set(at, { current, ok: true });
          if (!batch || !current) continue;
          batches.push({ ok: true, project: batch.project, batch: batch.batch, state: batch.state, protocol: reference.protocol, lastVerifiedAt: batch.kernel?.verifiedAt ?? new Date().toISOString(),
            ...(batch.kernel ? { runId: batch.kernel.binding.runId, tasks: { total: batch.kernel.tasks.length, count: Math.min(5, batch.kernel.tasks.length), hasMore: batch.kernel.tasks.length > 5,
              rows: batch.kernel.tasks.slice(0, 5).map(t => ({ id: t.id, name: t.name, state: t.state })) } } : {}), businessAcceptance: '未验证' });
        } catch (error) {
          signal?.throwIfAborted(); query.checked.set(at, { current: false, ok: false });
          const lastConfirmed = await this.lastConfirmed(reference, signal);
          batches.push({ ok: false, project: reference.project, reason: failure(error).error, lastConfirmed,
            lastConfirmedScope: lastConfirmed ? '仅同项目、同原执行的事项最后记录；不是来源当前全貌' : '没有可核对的同项目原执行记录；不据此断言没有任务' });
        }
      }
      const failed = [...query.checked].filter(([, v]) => !v.ok).map(([at]) => at), knownCurrent = [...query.checked.values()].filter(v => v.current).length;
      const hasMore = position < query.refs.length, complete = query.checked.size === query.refs.length && !failed.length && !query.errors.length;
      const partial = !complete || hasMore;
      const result = { v: 1, at: new Date().toISOString(), total: complete ? knownCurrent : null, knownCurrent, count: batches.length, indexedSources: query.refs.length,
        registeredTasks: partial ? null : this.store.taskPage(projects.flatMap(p => [p.id, p.root]), { includeClosed: true, limit: 1 }).total,
        hasMore, nextCursor: hasMore ? token(position) : null, retryCursor: failed.length ? token(failed[0]!) : null, partial, batches,
        coverage: { ...this.coverage(projects), partial, checkedSources: query.checked.size, indexedSources: query.refs.length, failures: failed.length, errors: query.errors },
        note: '新旧来源均可查询；登记数量不是当前来源数量。未读完/失败时 total 未知，不能据空页称无任务；本次查询不建任务或永久关注' };
      materials.push({ path: 'loop://查询/source-page', sha256: hash(JSON.stringify(result)) }); return result;
    } catch (error) {
      signal?.throwIfAborted();
      return { ok: false, reason: failure(error).error, partial: true, total: null, coverage: this.coverage(await this.projects()), note: '来源查询失败；最后已确认任务请 list_tasks/get_task，不把失败当无任务' };
    }
  }
}
