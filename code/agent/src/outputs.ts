import { basename, dirname, extname, join, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import type { Config, Input } from './types.js';
import type { WorkerRequest, Workers } from './worker.js';
import type { Store } from './store.js';
import { ScopedFiles, readBytes, noLinkedParents, nameDenied } from './file-policy.js';
import { extract, READ_CAPABILITY } from './documents.js';
import { imageType } from './image.js';
import { SafeError, failure } from './errors.js';
import { hash, inside, parseJson } from './util.js';
import { ownerInstruction, requestHash } from './confirmation.js';
import { turns } from './context.js';
import { deliver } from './channel.js';

export interface OutputOptions { kind: 'docx-txt' | 'image'; source: string; fileName?: string; placement?: 'project' | 'other' }
export interface Artifact { path: string; sha256: string; bytes: number }
export interface OutputPlan {
  kind: OutputOptions['kind']; source: string; sourceSha256: string; target: string; companion?: string;
  originalName: string; sourceRef: string; at: string; action: string; otherReason?: string;
}
export interface OutputResult { ok: boolean; status: 'saved' | 'incomplete' | 'failed'; files: Artifact[]; expected: string[]; category?: string; error?: string }
export function outputOptions(raw: unknown): OutputOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SafeError('invalid_arguments', 'output 必须是产出参数对象。');
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some(k => !['kind', 'source', 'fileName', 'placement'].includes(k)) || !['docx-txt', 'image'].includes(String(o.kind)) || typeof o.source !== 'string' || !o.source.startsWith('/') || o.source.includes('\0')
    || o.fileName !== undefined && (typeof o.fileName !== 'string' || o.fileName.length > 1000) || o.placement !== undefined && !['project', 'other'].includes(String(o.placement))) throw new SafeError('invalid_arguments', '产出类型、源路径或文件名无效。');
  return o as unknown as OutputOptions;
}
// A filename, never a path. Bound UTF-8 bytes as well as characters on macOS.
export function outputName(value: string, maxBytes = 140) {
  let name = basename(value.replaceAll('\\', '/')).normalize('NFC').replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '').replace(/\.{2,}/g, '_') || 'attachment';
  while (Buffer.byteLength(name) > maxBytes) name = [...name].slice(0, -1).join('');
  return name;
}
const owner = (c: Config, input: Input | undefined): input is Input => !!input && input.source === 'feishu' && input.who === c.feishu.userId && input.chatType === 'p2p' && !input.button && !!input.messageId;
// Attribution is a fact, not consent. Only a complete, single-fact answer may
// inherit the original directive; extra clauses always need a fresh decision.
const otherAttribution = (text: string) => /(?:仍无|没有|无|不属于任何).*项目|项目.*(?:无归属|不确定)|(?:放|存|归入|保存|用)\s*other\b/i.test(text);
const answerText = (text: string) => text.trim().replace(/[。.!！]+$/u, '').trim();
const onlyOtherAttribution = (text: string) => /^(?:(?:仍(?:然)?(?:没有|无)|没有|无)\s*项目(?:归属)?|不属于(?:任何)?项目|项目(?:无归属|不确定)|(?:放|存|归入|保存|用)\s*other)$/i.test(answerText(text));
function onlyProjectAttribution(text: string, project: Config['projects'][number]) {
  const answer = answerText(text);
  return [project.id, project.root].some(name => {
    const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^(?:(?:属于|归属(?:于|到)?|(?:所属)?项目\\s*(?:是|为|[:：]))\\s*)?${literal}(?:\\s*项目)?$`, 'u').test(answer);
  });
}
const saveAction = String.raw`(?:保存|存(?:下|起来)?|写入|写出|处理|执行)`;
const saveTarget = String.raw`(?:\s*(?:(?:这(?:个|份|张|项)?|该|原|本次)?(?:文件|图片|材料|产物|结果|操作|任务)|\[材料\]))?(?:了|吧)?`;
const declineSave = new RegExp(String.raw`^(?:(?:我们|我|请|麻烦|先|现在|这次|本次|暂时|暂且)\s*)*(?:不要|不用|不必|不需要|不想|不打算|不准备|不|别|勿|暂缓|暂停|取消)(?:\s*(?:再|继续|进行|执行|帮我|替我|给我|去|予以))*\s*${saveAction}${saveTarget}$`, 'u');
const delaySave = new RegExp(String.raw`^(?:(?:请|麻烦|先)\s*)?(?:等我(?:确认|决定|答复|想好|回复)(?:之后|以后|后|完)?|稍后|以后|晚点|回头)(?:\s*(?:再|才|帮我|替我|给我))*\s*${saveAction}${saveTarget}$`, 'u');
function savingDeferred(text: string, sourceNames: string[]) {
  // Filenames and quoted material are operands, not execution decisions. Only
  // complete action clauses below can create a durable hold; uncertain prose
  // stays on the original confirmation path instead of becoming a refusal fact.
  for (const name of sourceNames) if (/\.(?:docx?|txt|pdf|png|jpe?g|gif|webp)$/i.test(name)) text = text.replaceAll(name, '[材料]');
  const speech = text.replace(/《[^》]*》|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, '[材料]');
  return speech.split(/[，,。；;！!\r\n]+/u).map(answerText).some(clause => declineSave.test(clause) || delaySave.test(clause)
    || /^(?:(?:这次|本次|现在|先|暂时)\s*)*(?:取消|暂停|暂缓|算了|回电脑再说)(?:了|吧)?$/u.test(clause));
}
interface Draft { inputId: string; argsHash: string; direct: boolean; heldBy?: string }
const draftKey = (id: string) => `worker:clarify:${id}`;
function draft(store: Store, id: string) { return store.get<{ outputDraft?: Draft; cancelled?: boolean } | null>(draftKey(id), null); }
function dispatchOutput(args: Record<string, unknown>) {
  if (args.worker !== 'pi' || typeof args.options !== 'string') return;
  const options = parseJson<Record<string, unknown>>(args.options);
  if (!options.output) return;
  return { options, output: outputOptions(options.output) };
}
function draftHash(args: Record<string, unknown>) {
  const parsed = dispatchOutput(args)!;
  return hash(JSON.stringify({ taskId: args.taskId, title: args.title, goal: args.goal, completion: args.completion, boundary: args.boundary, prompt: args.prompt, redLine: args.redLine === true,
    options: { ...parsed.options, output: { ...parsed.output, placement: 'project' } } }));
}
/** Only the output missing-project seam; all actual execution remains Workers/Pi. */
export class OutputRequests {
  constructor(readonly workers: Workers) {}
  private ownerInput() {
    const input = turns.getStore()?.input;
    return owner(this.workers.config, input) && this.workers.store.row(input.id)?.input.text === input.text ? input : undefined;
  }
  private savingDeferred(input: Input, output: OutputOptions) {
    const origin = this.workers.store.get<{ name: string } | null>(`attachment-origin:${output.source}`, null);
    return savingDeferred(input.text, [basename(output.source), origin?.name ?? '', ...input.attachments.map(a => a.originalName ?? a.name)]);
  }
  private supplement(args: Record<string, unknown>) {
    const w = this.workers, record = draft(w.store, String(args.taskId)), d = record?.outputDraft, input = this.ownerInput();
    if (!d || record.cancelled || d.argsHash !== draftHash(args) || !input || input.id === d.inputId) return;
    const project = w.config.projects.find(p => p.id === args.project || p.root === args.project), o = dispatchOutput(args)!.output;
    if (!project || o.placement === 'other' && project.id !== w.config.outputs?.otherProject) return;
    const source = w.store.row(d.inputId)?.input;
    if (!source || d.direct && !ownerInstruction(w.config, source, { instructionInput: source.id, instruction: source.text })) return;
    return { d, source, input, attributionOnly: o.placement === 'other' ? onlyOtherAttribution(input.text) : onlyProjectAttribution(input.text, project) };
  }
  needsApproval(args: Record<string, unknown>) {
    try {
      const parsed = dispatchOutput(args);
      if (!parsed) return this.workers.needsApproval('worker_dispatch', args);
      const input = this.ownerInput();
      if (input && this.savingDeferred(input, parsed.output) || !args.project) return false; // Reject/ask without preparing an execution or a new approval card.
      if (draft(this.workers.store, String(args.taskId))?.outputDraft) {
        const supplement = this.supplement(args);
        if (!supplement) return false; // Invalid identity/scope is reported by execute, not sent for approval.
        return !(supplement.d.direct && !supplement.d.heldBy && supplement.attributionOnly && !parsed.options.commands && !parsed.options.network && !(parsed.options.editFiles as unknown[] | undefined)?.length && args.redLine !== true);
      }
      return this.workers.needsApproval('worker_dispatch', args);
    } catch { return true; }
  }
  async execute(thread: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const w = this.workers, parsed = dispatchOutput(args);
    if (!parsed) return w.execute(thread, 'worker_dispatch', args, signal);
    const input = turns.getStore()?.input, currentOwner = this.ownerInput();
    if (currentOwner && this.savingDeferred(currentOwner, parsed.output)) {
      const id = String(args.taskId), record = draft(w.store, id), card = w.store.task(id);
      if (record?.outputDraft) w.store.set(draftKey(id), { ...record, outputDraft: { ...record.outputDraft, heldBy: currentOwner.id } });
      const pendingId = w.store.get<string | null>(`worker:pending:${id}`, null), pending = pendingId ? w.operation(pendingId) : null;
      if (pending && ['planned', 'approved'].includes(pending.state)) {
        pending.state = 'rejected'; pending.by = currentOwner.id; pending.reason = '本人已拒绝或暂缓保存，旧确认作废；不执行、不重提'; w.journal.write(pending);
        if (w.decisions(pending.thread)) w.store.ready(pending.thread);
      }
      if (card && !card.worker?.batchFile && !['cancelled', 'closed', 'reconciled'].includes(card.status)) { card.waiting = '本人已拒绝或暂缓保存；归属补充不等于执行同意，不催第二遍'; w.store.putTask(card); }
      w.store.log('output_deferred', { taskId: id, inputId: currentOwner.id });
      return { ok: false, category: 'deferred', reason: '本人拒绝或暂缓保存，本轮未派工；不能用原委托覆盖新的拒绝。' };
    }
    if (!args.project) {
      const id = String(args.taskId);
      if (!/^[\w\p{L}.:@-]{1,160}$/u.test(id) || !input) throw new SafeError('invalid_arguments', '缺少稳定的产出任务身份。');
      const previous = draft(w.store, id);
      if (previous) return { ok: false, category: 'awaiting_project', reason: '原材料留在原处；没有有效项目答复，不写、不催第二遍。' };
      const source = await w.files.check(parsed.output.source, true);
      const sourceKey = `output:pending-source:${hash(JSON.stringify([source, parsed.output.kind]))}`;
      const originalTask = w.store.get<string | null>(sourceKey, null);
      if (originalTask && w.store.task(originalTask)?.status === 'waiting-project') return { ok: false, category: 'awaiting_project', taskId: originalTask, reason: '同一材料已问过项目；用 get_task 读取原事项，未答不写、不换编号催第二遍。' };
      if (w.store.task(id)) throw new SafeError('already_exists', '此编号已有任务，不能以产出缺项覆盖原事项。');
      const direct = args.redLine !== true && !!ownerInstruction(w.config, input, args);
      w.store.set(draftKey(id), { outputDraft: { inputId: input.id, argsHash: draftHash(args), direct } satisfies Draft });
      // A real delegated task awaiting one fact, not an execution. Its index and
      // get_task reference survive window eviction/restart without flattening context.
      w.store.putTask({ id, title: String(args.title), goal: String(args.goal), completion: String(args.completion), boundary: String(args.boundary), status: 'waiting-project', waiting: '只缺项目；未答不写、不催第二遍', dispatches: [], conclusion: '', updated: input.at,
        subscriptions: input.messageId ? [{ kind: 'message', value: input.messageId }] : [], outputDraft: { sourceInput: input.id, arguments: args } });
      w.store.set(sourceKey, id);
      const question = await deliver(w.store, w.channel, input.id, `output-project:${id}`, '这份材料属于哪个项目？只需补项目；若仍无项目归属请说明。未答复前不保存，也不会再次催问。', signal);
      const card = w.store.task(id)!;
      if (question.status === 'sent' && typeof question.id === 'string') { card.subscriptions.push({ kind: 'message', value: question.id }); w.store.putTask(card); }
      return { ok: false, category: 'missing_project', questionSent: question.status === 'sent', delivery: question.status, reason: '只缺项目，保留原 taskId、目标、边界和源文件；发送不确定也不重复提问。' };
    }
    const record = draft(w.store, String(args.taskId));
    if (record?.outputDraft) {
      const supplemented = this.supplement(args);
      if (!supplemented) throw new SafeError('missing_project', '原产出的本人来源或任务范围不匹配；未执行，不重复催问。');
      if (supplemented.d.heldBy && (w.store.row(supplemented.input.id)?.seq ?? 0) <= (w.store.row(supplemented.d.heldBy)?.seq ?? Infinity)) throw new SafeError('deferred', '这条原输入早于本人暂缓决定，不能恢复旧委托。');
      // Look up the frozen operation before considering implicit consent. A real
      // approved HITL operation does not depend on the wording of its project reply.
      const op = await w.prepare(thread, 'worker_dispatch', args, signal);
      const inherit = supplemented.d.direct && !supplemented.d.heldBy && supplemented.attributionOnly && !op.request.redLine;
      if (!inherit) { op.needsApproval = true; w.journal.write(op); }
      if (op.state === 'planned' && inherit) {
        // This is a one-operation owner confirmation, not a configuration switch.
        // Workers still rechecks definition, cancellation, frozen plan and exactly-once claim.
        op.state = 'approved'; op.by = supplemented.input.id;
        const confirmation = { kind: 'output-project-clarification', inputId: supplemented.source.id, sourceHash: hash(supplemented.source.text),
          clarifiedBy: supplemented.input.id, answerHash: hash(supplemented.input.text), taskId: op.request.taskId, requestHash: requestHash(op.request), scopeFingerprint: op.basis.fingerprint };
        w.store.set(`output:confirmation:${op.id}`, confirmation); w.journal.write(op);
        w.store.log('output_confirmation', confirmation);
      }
    }
    return w.execute(thread, 'worker_dispatch', args, signal);
  }
}

/** Called at every plan/recheck. The model cannot manufacture other consent or provenance. */
export async function planOutput(c: Config, store: Store, request: WorkerRequest, files: ScopedFiles, o: OutputOptions): Promise<OutputPlan> {
  const project = c.projects.find(p => p.id === request.project || p.root === request.project)!;
  const root = join(project.root, 'PA产出');
  if (!project.pi?.writeDirs.includes(root) || files.policy.write.length !== 1 || files.policy.write[0] !== root) throw new SafeError('outside_scope', '尚未启用该项目 PA产出 子目录写权限；不能借项目根或其他写目录代替。');
  if ([...c.inboxDirs, ...c.loop.eventDirs, c.attachmentDir, c.dataDir].some(p => inside(p, root) || inside(root, p))) throw new SafeError('scope_conflict', '产出与输入监听、附件或数据目录重叠，未写入。');
  await noLinkedParents(root);
  const { actual, data } = await readBytes(o.source, () => files.check(o.source), Math.min(c.intake.maxFileBytes, READ_CAPABILITY.maxSourceBytes));
  const originalName = files.policy.origins[actual] ?? basename(actual);
  if (nameDenied(originalName)) throw new SafeError('blacklist', '原始材料名命中黑名单，未产出。');
  let extension: string;
  if (o.kind === 'image') extension = imageType(data).extension;
  else {
    // Format is checked again at execution; reuse the existing parser, not a chunk.
    if (extname(originalName).toLowerCase() === '.doc') throw new SafeError('unsupported_format', '不支持旧 DOC，未生成 TXT。');
    const parsed = await extract(data, actual); if (parsed.format !== 'docx') throw new SafeError('unsupported_format', '此入口只将 DOCX 正文写为 TXT。');
    extension = '.txt';
  }
  const originKey = `output:origin:${request.id}`;
  let origin = store.get<{ inputId: string } | null>(originKey, null);
  if (!origin) { const input = turns.getStore()?.input; if (input) { origin = { inputId: input.id }; store.set(originKey, origin); } }
  const input = origin ? store.row(origin.inputId)?.input : undefined;
  const pending = draft(store, request.taskId);
  if (pending?.cancelled) throw new SafeError('cancelled', '原产出已取消，未写入。');
  const other = o.placement === 'other';
  if (owner(c, input) && savingDeferred(input.text, [originalName, basename(actual)])) throw new SafeError('deferred', '本人拒绝或暂缓保存，归属说明不是执行同意。');
  if (other && (c.outputs?.otherProject !== project.id || !owner(c, input) || !otherAttribution(input.text))) throw new SafeError('missing_project', '没有本人明确仍无项目归属的答复，不能放入 other。');
  let sourceRef = `文件:${actual}`, at = input?.at ?? '未知时间';
  // Provenance comes from received inputs, never model-provided strings.
  const row = store.db.prepare("SELECT body FROM inputs WHERE EXISTS (SELECT 1 FROM json_each(inputs.body,'$.attachments') a WHERE json_extract(a.value,'$.path')=?) ORDER BY seq LIMIT 1").get(actual);
  if (row) { const received = parseJson<Input>(String(row.body)); sourceRef = `${received.source}:${received.messageId ?? received.id}；文件:${actual}`; at = received.at; }
  else if (pending?.outputDraft) { const source = store.row(pending.outputDraft.inputId)?.input; if (source) { sourceRef = `${source.source}:${source.messageId ?? source.id}；文件:${actual}`; at = source.at; } }
  if (!Number.isFinite(Date.parse(at))) at = new Date(0).toISOString();
  const requestedName = outputName(o.fileName ?? originalName), stem = requestedName.slice(0, requestedName.length - extname(requestedName).length) || 'attachment';
  const name = other ? `${at.slice(0, 10)}_${outputName(sourceRef.split('；')[0]!, 48)}_${outputName(originalName)}${extension}` : `${stem}${extension}`;
  const target = join(root, ...(other ? ['other'] : []), name);
  await files.check(target, 'write'); await noLinkedParents(dirname(target));
  return { kind: o.kind, source: actual, sourceSha256: hash(data), target, ...(other ? { companion: `${target}.说明.txt`, otherReason: input!.text.trim() } : {}), originalName, sourceRef, at,
    action: o.kind === 'image' ? '受限二进制复制图片，保持字节' : '提取完整 DOCX 正文并写 UTF-8 TXT' };
}
const expectedPaths = (plan: OutputPlan) => [plan.target, ...(plan.companion ? [plan.companion] : [])];
const companionBytes = (plan: OutputPlan) => Buffer.from(JSON.stringify({ 来源: plan.sourceRef, 时间: plan.at, 原文件名: plan.originalName, 处理动作: plan.action, 归入other原因: plan.otherReason }, null, 2) + '\n');
export async function produceOutput(files: ScopedFiles, plan: OutputPlan): Promise<OutputResult> {
  const result: OutputResult = { ok: false, status: 'failed', files: [], expected: expectedPaths(plan) };
  try {
    for (const path of result.expected) {
      await files.check(path, 'write'); await noLinkedParents(dirname(path));
      try { await lstat(path); throw new SafeError('output_exists', '目标或同名说明已存在，整项未写入；不覆盖，请另存新名。'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const { data } = await readBytes(plan.source, () => files.check(plan.source), Math.min(files.policy.maxReadBytes ?? READ_CAPABILITY.maxSourceBytes, READ_CAPABILITY.maxSourceBytes));
    if (hash(data) !== plan.sourceSha256) throw new SafeError('file_changed', '原材料版本已变化，未写入。');
    let content: Buffer;
    if (plan.kind === 'image') { imageType(data); content = data; }
    else { const parsed = await extract(data, plan.source); if (parsed.format !== 'docx') throw new SafeError('unsupported_format', '不是可提取的 DOCX。');
      if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/.test(parsed.text)) throw new SafeError('blacklist', '正文命中秘密标记，未写入。'); content = Buffer.from(parsed.text, 'utf8'); }
    result.status = 'incomplete';
    result.files.push(await files.create(plan.target, content));
    if (plan.companion) result.files.push(await files.create(plan.companion, companionBytes(plan)));
    for (const artifact of result.files) await verifyArtifact(files, artifact);
    result.ok = true; result.status = 'saved';
  } catch (error) { Object.assign(result, failure(error)); if (result.status === 'incomplete') result.error = `交付不完整，不能称已保存齐全。${result.error} 保留现场，不覆盖、不删除。`; }
  return result;
}
async function verifyArtifact(files: ScopedFiles, artifact: Artifact) {
  const { actual, data } = await readBytes(artifact.path, () => files.check(artifact.path, 'write'), READ_CAPABILITY.maxSourceBytes);
  await noLinkedParents(dirname(actual));
  if (actual !== resolve(artifact.path) || hash(data) !== artifact.sha256 || data.length !== artifact.bytes) throw new SafeError('output_incomplete', '产物实际路径、大小或摘要核对失败。');
}
/** Never accept the worker's final prose as proof of a file. */
export async function verifyOutput(files: ScopedFiles, plan: OutputPlan, result: OutputResult | undefined) {
  if (!result?.ok || result.status !== 'saved' || JSON.stringify(result.expected) !== JSON.stringify(expectedPaths(plan)) || result.files.length !== result.expected.length || result.files.some((a, i) => a.path !== result.expected[i] || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.bytes))) throw new SafeError('output_incomplete', '没有完整且匹配的真实产物回执，未确认保存成功。');
  for (const artifact of result.files) await verifyArtifact(files, artifact);
  // Recompute expected content, not only a model-supplied digest.
  const { data } = await readBytes(plan.source, () => files.check(plan.source), Math.min(files.policy.maxReadBytes ?? READ_CAPABILITY.maxSourceBytes, READ_CAPABILITY.maxSourceBytes));
  if (hash(data) !== plan.sourceSha256) throw new SafeError('output_incomplete', '源文件已变化，产物尚未核实。');
  const content = plan.kind === 'image' ? (imageType(data), data) : Buffer.from((await extract(data, plan.source)).text);
  if (hash(content) !== result.files[0]!.sha256 || plan.companion && hash(companionBytes(plan)) !== result.files[1]!.sha256) throw new SafeError('output_incomplete', '产物或说明与完整源内容/处理依据不一致。');
  return result.files;
}
