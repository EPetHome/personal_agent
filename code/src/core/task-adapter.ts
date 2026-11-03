import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ReadSandbox, within } from './read-sandbox.ts';
import { readLedger, updateLedger } from './ledger.ts';
import { assertRelayIdle, RelayFailure, relayFailureReason, resumeCC } from './cc-relay.ts';
import { recoverDeadLock, withNamedLock } from './locks.ts';
import { runCommand } from './process.ts';
import { hash, object } from './utils.ts';
import { verifyMaterialFile } from './source-intake.ts';
import type { Config } from './types.ts';
import type { DispatchReceipt, DispatchRequest, LoopWorker } from './managed-types.ts';

export async function taskSandbox(config: Config, project: string, at: string) {
  return ReadSandbox.create({ project, transcript: resolve(config.dataDir, '.no-task-transcript'), home: homedir(), dataDir: config.dataDir,
    sourceDirs: Object.entries(config.sources).filter(([key]) => key !== 'loop').map(([, value]) => value).filter((value): value is string => !!value), maxToolCalls: 40 }, async audit => {
    await updateLedger(config.dataDir, at, (_state, add) => add({ kind: 'observation', observation: { kind: 'guard', detail: `派工读取审计：${JSON.stringify(audit)}` } }));
  });
}
/** Pi命令是受信任的接入配置，不接受模型/材料提供的命令。查询只给受围栏预读的材料，无写工具。 */
export async function dispatchTask(config: Config, request: DispatchRequest, worker?: LoopWorker, signal?: AbortSignal): Promise<DispatchReceipt> {
  const began = performance.now();
  const fail = (reason: string): DispatchReceipt => ({ requestId: request.requestId, status: 'failed', reason });
  if (request.kind === 'cc') {
    if (!request.target || !config.relay?.enabled) return fail('转达总开关已关闭');
    const name = `.relay-session-${hash(request.target.sessionId)}.lock`;
    try {
      await recoverDeadLock(config.dataDir, name);
      return await withNamedLock(config.dataDir, name, async () => {
        const current = await assertRelayIdle(config, request.target!);
        if (current.cursor !== request.target!.cursor) return fail('CC 会话已经往下走，请重新发明确的转达要求；未发送');
        const result = await resumeCC(config, request.target!, request.text!, signal ?? new AbortController().signal);
        return { requestId: request.requestId, status: 'consumed', result: `原话已核实。${result.denied.length ? `操作被拦：${result.denied.join('、')}；请回电脑处理。` : ''}窗口看不到时请重开这个会话。` };
      });
    } catch (error) { return { requestId: request.requestId, status: error instanceof RelayFailure ? 'failed' : 'uncertain', reason: relayFailureReason(error) }; }
  }
  const project = config.dispatch?.projects.find(project => project.path === request.project);
  if (!project) return fail('项目没有经本人配置的派工默认范围，未派出');
  const box = await taskSandbox(config, project.path, new Date().toISOString());
  try {
    await box.authorize(project.path, true);
    const sourceMaterial = request.materialId ? (await readLedger(config.dataDir)).tables.materials[request.materialId] : undefined;
    if (request.materialId && !sourceMaterial) return fail('材料来源已失效');
    if (sourceMaterial?.source === 'workspace') await verifyMaterialFile(config, sourceMaterial, new Date().toISOString());
    for (const path of request.definition.boundaries.read) {
      if (sourceMaterial?.source === 'workspace' && path === sourceMaterial.ref) continue;
      await box.authorize(path, 'either');
    }
    const writeBox = await taskSandbox(config, project.workspace, new Date().toISOString());
    await writeBox.authorize(project.workspace, true);
    for (const path of request.definition.boundaries.write) {
      if (!within(project.workspace, path)) return fail('写范围不在配置的开发空间内');
      // 写根必须已存在且可信；实际产物写入由受信任worker继续强制范围/不许读名单。
      await writeBox.authorize(path, 'either');
    }
    if (request.definition.boundaries.realDevice || request.definition.boundaries.outbound.some(value => value !== 'loop_reply')) return fail('本段派工不允许真机或对外发布');
    if (request.kind === 'loop') return worker?.start ? worker.start(request) : fail('未配置 loop 开批次接口');
    const pi = config.piWorker; if (!pi) return fail('未配置 Pi 派工命令');
    if (request.kind === 'skill') {
      const allowed = Object.values(config.dispatch?.skills ?? {});
      if (!request.skills?.length || request.skills.some(skill => !allowed.includes(skill))) return fail('skill不在本人配置的映射内');
      return parseDispatchReceipt(JSON.parse(await runCommand(pi.executable, [...pi.args, 'skill'], pi.timeoutMs,
        JSON.stringify({ ...request, materialsAreUntrusted: true, constraints: { readOnly: false, scope: request.definition.boundaries, noExternalMessages: true, noMergeOrPush: true, ...(sourceMaterial?.source === 'workspace' ? { readOnlyFiles: [sourceMaterial.ref], noMoveOrDeleteOriginals: true } : {}) } }), signal)), request.requestId);
    }
    const sheet = request.sheet;
    if (!sheet) return fail('缺少提问单');
    for (const path of sheet.boundary.read) await box.authorize(path, 'either');
    // 预读索引和少量原件，Pi没有shell/自由读写工具，不能读提问单之外的真实数据。
    const index = await box.execute('find', { path: project.path, limit: 100 });
    const material: { path: string; text: string }[] = [];
    for (const line of index.split('\n').filter(line => /\.(?:ts|js|json|md|txt|py|go|rs)$/.test(line) && !line.includes('node_modules/')).slice(0, 20)) {
      try { const path = join(project.path, line); material.push({ path, text: (await box.text(path, 1, 150, 8192)).text }); } catch { /* 不换路径绕过围栏。 */ }
    }
    const state = await readLedger(config.dataDir);
    const context = Object.values(state.tables.tickets).filter(ticket => ticket.project === project.path).slice(-20).map(ticket => ({ id: ticket.id, batch: ticket.batch, result: ticket.intents.at(-1)?.result, status: ticket.status }));
    const timeout = Math.floor(Math.min(pi.timeoutMs, sheet.budget.timeoutMs - (performance.now() - began), 1200000 - (performance.now() - began)));
    if (timeout <= 0) return fail('补查已到20分钟预算，不再启动Pi；只列缺项');
    const receipt = parseDispatchReceipt(JSON.parse(await runCommand(pi.executable, [...pi.args, 'query'], timeout,
      JSON.stringify({ ...request, materialsAreUntrusted: true, constraints: { readOnly: true, tools: [], noSession: true, maxRounds: 1 }, index, material, context }), signal)), request.requestId);
    // 依据须能回到本次授权的原件或账本；不能把无来源/秘密路径当作事实凭据。
    if (receipt.status === 'consumed') for (const fact of receipt.facts ?? []) {
      if (performance.now() - began >= Math.min(sheet.budget.timeoutMs, 1200000)) return fail('已到补查预算，未核实完事实依据，不追查第二轮');
      if (fact.basis === `index:${project.path}` || context.some(ticket => fact.basis === `账本:${ticket.id}`)) continue;
      const match = /^(.+?):([1-9]\d*)(?:[-:]\d+)?(?:$|[；\s])/.exec(fact.basis);
      if (!match) return fail('查询事实没有可定位的文件行号或账本依据，不追查第二轮');
      try { await box.text(match[1]!, Number(match[2]), 1, 8192); }
      catch { return fail('查询事实的依据不在允许读取范围或原件中，不追查第二轮'); }
    }
    return receipt;
  } catch { return { requestId: request.requestId, status: 'uncertain', reason: '范围检查或执行器调用未得到可靠结果，不重派' }; }
}
export function parseDispatchReceipt(raw: unknown, requestId: string): DispatchReceipt {
  const value = object(raw, '派工回执');
  if (value.requestId !== requestId || !['consumed', 'uncertain', 'failed'].includes(value.status)) return { requestId, status: 'uncertain', reason: '派工回执身份/状态不符，不重派' };
  const valid = (text: unknown): text is string => typeof text === 'string' && text.length <= 8000 && !text.includes('\0');
  if (value.facts !== undefined && (!Array.isArray(value.facts) || value.facts.length > 30 || value.facts.some((row: any) => !row || !valid(row.text) || !valid(row.basis)))
    || value.questions !== undefined && (!Array.isArray(value.questions) || value.questions.some((row: unknown) => !valid(row)))) return { requestId, status: 'failed', reason: '查询交回格式不合法，不进行第二轮' };
  return { requestId, status: value.status, ...(valid(value.reason) ? { reason: value.reason } : {}), ...(valid(value.result) ? { result: value.result } : {}),
    ...(value.facts ? { facts: value.facts } : {}), ...(value.questions ? { questions: value.questions.slice(0, 3) } : {}) };
}
