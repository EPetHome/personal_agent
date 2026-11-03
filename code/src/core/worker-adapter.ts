import { runCommand } from './process.ts';
import { object } from './utils.ts';
import { parseDispatchReceipt } from './task-adapter.ts';
import type { Config } from './types.ts';
import type { LoopStatus, LoopWorker, WorkerReceipt } from './managed-types.ts';

export function parseLoopStatus(raw: unknown, batch: string): LoopStatus {
  const value = object(raw, 'loop 状态');
  if (value.schema !== 1 || value.batch !== batch || !Number.isFinite(Date.parse(value.updatedAt)) || !Array.isArray(value.stages)
    || value.stages.some((stage: any) => !stage || typeof stage.name !== 'string' || typeof stage.state !== 'string'
      || stage.sessionPresent !== undefined && typeof stage.sessionPresent !== 'boolean'
      || stage.sessionId !== undefined && (typeof stage.sessionId !== 'string' || stage.sessionId.length > 200))
    || value.pushTarget !== undefined && (!value.pushTarget || typeof value.pushTarget.remote !== 'string' || !['public', 'private', 'unknown'].includes(value.pushTarget.visibility))) throw new Error('loop 状态字段不合法');
  return value as LoopStatus;
}
/** 接入层唯一的 worker 写口；不能接受模型提供的命令或动作。 */
export function commandWorker(config: Config): LoopWorker | undefined {
  if (!config.worker) return undefined;
  const worker = config.worker;
  async function request(action: 'status' | 'send' | 'push' | 'merge' | 'stop' | 'start', input: unknown): Promise<unknown> {
    return JSON.parse(await runCommand(worker.executable, [...worker.args, action], worker.timeoutMs, JSON.stringify(input)));
  }
  return {
    async status(batch, project) { return parseLoopStatus(await request('status', { schema: 1, batch, project, readOnly: true }), batch); },
    async execute(input) {
      if (input.candidateRef !== undefined) {
        if (input.action !== 'merge') return { requestId: input.requestId, status: 'failed', outcome: 'blocked', code: 'candidate_not_pushable', reason: '候选只允许合入，不能推送' };
        if (!worker.candidateRefs.includes(input.candidateRef)) return { requestId: input.requestId, status: 'failed', outcome: 'blocked', code: 'candidate_not_allowed', reason: '候选ref不在当前配置白名单，未执行' };
      }
      // 发送前再读目标；worker仍须在执行时原子核对，不能把预检当成跳过扫描/目标校验的许可。
      if (input.action !== 'stop') {
        const status = parseLoopStatus(await request('status', { schema: 1, batch: input.batch, project: input.project, readOnly: true }), input.batch);
        const currentCandidate = status.candidateRef ?? status.queue?.candidateRef;
        if (input.candidateRef && currentCandidate !== undefined && currentCandidate !== input.candidateRef)
          return { requestId: input.requestId, status: 'failed', outcome: 'blocked', code: 'target_changed', reason: 'loop 当前候选ref与确认的核实依据不同，未执行' };
        if (status.branch?.replace(/^refs\/heads\//, '') !== input.branch?.replace(/^refs\/heads\//, '')
          || !/^[a-f0-9]{7,64}$/i.test(status.commit ?? '') || !input.commit?.startsWith(status.commit!)
          || input.action === 'push' && (status.pushTarget?.remote !== input.remote || status.pushTarget?.visibility !== input.visibility))
          return { requestId: input.requestId, status: 'failed', outcome: 'blocked', code: 'target_changed', reason: 'loop 目标或远端可见性已变化，请重新核实卡片后确认' };
      }
      return receipt(await request(input.action, input), input.requestId);
    },
    async send(input) { return receipt(await request('send', input), input.requestId); },
    async start(input) { return parseDispatchReceipt(await request('start', input), input.requestId); },
  };
}
function receipt(raw: unknown, requestId: string): WorkerReceipt {
  const value = object(raw, 'loop 回执');
  if (value.requestId !== requestId || !['delivered', 'consumed', 'uncertain', 'failed'].includes(value.status))
    return { requestId, status: 'uncertain', reason: '回执不能对应请求号或状态不合法，未重发', failure: true };
  return { requestId, status: value.status,
    ...(typeof value.reason === 'string' ? { reason: value.code === 'suspected_secret' ? '发现疑似密钥，没推' : value.reason.slice(0, 1000) } : {}),
    ...(['pushed', 'merged', 'stopped', 'blocked'].includes(value.outcome) ? { outcome: value.outcome } : {}),
    ...(typeof value.commit === 'string' && /^[a-f0-9]{40,64}$/i.test(value.commit) ? { commit: value.commit } : {}),
    ...(typeof value.code === 'string' && /^[a-z_]{1,60}$/.test(value.code) ? { code: value.code } : {}),
  } as WorkerReceipt;
}
