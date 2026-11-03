import type { LedgerState, ManagedCard, ManagedWrite } from './managed-types.ts';
import { actionScope, automaticPermission, completeQuestionSheet, waitingForAutomaticCard } from './autonomy-policy.ts';

export interface WriteDecision { allowed: boolean; reason: string; redline: boolean; waitFor?: 'card_delivery' }

/** 程序判据是下限；研判只能加红线，不能用否定/解释把命中的判据撤掉。 */
export function majorConsequences(text: string): boolean {
  return /删除|删掉|清空|覆盖|强推|改历史|重写历史|迁移|推(?:到|送到)?远端|推送|推到仓库|上仓库|停(?:止|掉).{0,8}(?:这批|批次|派工)|停批次|发(?:消息|邮件|短信)|发布|对外(?:发言|发送)|合入|上线|转账|付款|扣费|支付|动钱|账号|账户|权限|授权|密钥|密码|秘密|验收标准|改需求|改目标|改变完成条件|扩大.{0,8}(?:范围|权限)|跳过.{0,8}(?:门禁|评审|验收)|忽略.{0,8}(?:任务|边界|要求)|红线|(?:修改|改变|放宽).{0,8}(?:规则|配置)|\b(?:delete|remove|overwrite|force.?push|rebase|reset|migrat\w*|publish|deploy|merge|push|send\s+(?:mail|email|message)|payment|secret|password|credential|permission)\b|\bstop\s+(?:(?:this|the)\s+)?(?:batch|assignment)\b|\brm\s+-|git\s+(?:push|reset|rebase)/i.test(text);
}
/** 授权视图忽略引文；任务视图仅为纯文件对象保留类型，不从路径名称提取动作。
 * 两种视图都保留原位置/换行，完整原话仍独立保存。 */
export function instructionText(text: string, keepFileObjects = false): string {
  return text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`|「[^」]*(?:」|$)|『[^』]*(?:』|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, quote => {
    const blank = quote.replace(/[^\n]/g, ' '), object = quote.slice(1, -1).trim();
    const close = ({ '`': '`', '"': '"', "'": "'", '「': '」', '『': '』', '“': '”', '‘': '’' } as Record<string, string>)[quote[0]!];
    if (keepFileObjects && close && quote.endsWith(close) && !quote.startsWith('```')
      && /^\/?(?:[\p{L}\p{N}_.-]+\/)*(?:[\p{L}\p{N}_-]+\.[A-Za-z0-9]{1,12}|\.[A-Za-z][A-Za-z0-9_.-]*)$/u.test(object)) {
      const extension = /\.([A-Za-z0-9]{1,12})$/.exec(object)?.[1];
      if (extension) { const marker = `f.${extension}`; return marker + blank.slice(marker.length); }
    }
    return blank;
  });
}
/** 正向任务与局部禁改分别建模；禁改对象不能改变执行配方，材料不能新增动作/边界。 */
export function taskMeaning(text: string): { activeText: string; prohibitedChanges: string[] } {
  const projected = instructionText(text, true), active: string[] = [], prohibited: string[] = [];
  const separators = /[，,。；;！!\n]|但是|不过|但|(?:并且|并|且|和|同时|然后)(?=\s*(?:把|给|为|不|别|禁|补|修|改|开发|实现|编写|添加|新增|优化|调整|删除|重构|转写|转录|摘要|总结|沉淀|整理|只|仅))/g;
  const prohibition = /(?:不(?:要|能|准|许|允许|可以|需(?:要)?|必)?|别|禁止|无需|不用)\s*(?:再|去|进行)?\s*(?:修改|修复|修|重构|开发|编写|更改|覆盖|改|写|动)/;
  let start = 0;
  const part = (end: number) => {
    const clause = projected.slice(start, end), negative = prohibition.exec(clause);
    active.push(negative ? clause.slice(0, negative.index) : clause);
    if (negative) prohibited.push(text.slice(start + negative.index, end).trim());
  };
  for (const separator of projected.matchAll(separators)) { part(separator.index); start = separator.index + separator[0].length; }
  part(projected.length);
  return { activeText: active.join('\n'), prohibitedChanges: [...new Set(prohibited.filter(Boolean))] };
}
/** 配方只从正向任务选择；明确只评审/只验收仍是硬只读下限。 */
export function codeRecipe(text: string): 'develop' | 'review_only' | 'acceptance_only' | undefined {
  const { activeText } = taskMeaning(text);
  const affirmative = (pattern: RegExp) => [...activeText.matchAll(pattern)].some(match =>
    !/(?:不是|并非|不允许|不可以|禁止|不需要|不要|无需|不用)\s*$/.test(activeText.slice(0, match.index)));
  if (affirmative(/只(?:做)?验收|仅(?:做)?验收/g)) return 'acceptance_only';
  if (affirmative(/只(?:做)?评审|仅(?:做)?评审|只审查/g)) return 'review_only';
  const development = /补(?:全|齐|完|充)?\s*测试|测试.{0,12}补(?:全|齐|完|充)|改代码|写代码|重构|(?:修改|修复|开发|实现|编写|新增|添加|优化|调整|删除).{0,30}(?:代码|测试|模块|功能|接口|页面|组件|脚本|\.(?:tsx?|jsx?|py|go|rs)\b)|(?:代码|测试|\.(?:tsx?|jsx?|py|go|rs)\b).{0,12}(?:修改|修复|重构)|\b(?:refactor|implement|fix\s+(?:code|tests?|bugs?))\b/i;
  if (activeText.split('\n').some(clause => development.test(clause)
    || /\.[A-Za-z0-9]{1,12}\b/.test(clause) && /修改|修复|重构|开发|编写|更改|改成|改为|改到|调整|新增|添加|删除/.test(clause))) return 'develop';
  if (affirmative(/验收(?!结果|结论|报告|记录|情况|材料|标准|要求)/g)) return 'acceptance_only';
  if (affirmative(/评审(?!结果|结论|报告|记录|情况|材料|标准|要求)|审查(?!结果|结论|报告|记录|情况|材料|标准|要求)/g)) return 'review_only';
  return undefined;
}
export function guardWrite(state: LedgerState, write: ManagedWrite): WriteDecision {
  if (write.dispatch) return guardDispatch(state, write);
  const ticket = state.tables.tickets[write.ticketId], assignment = state.tables.assignments[write.assignmentId], card = state.tables.cards[write.cardId];
  const intent = ticket?.intents.at(-1), input = state.tables.inputs[write.inputId];
  const redline = !!write.execution || write.redline || !!card?.redline || majorConsequences([write.text, card?.question, ...(card?.options ?? [])].join('\n'));
  const deny = (reason: string) => ({ allowed: false, reason, redline });
  if (!ticket || !assignment || !card || assignment.ticketId !== ticket.id || card.ticketId !== ticket.id || card.assignmentId !== assignment.id)
    return deny('不能指向明确的那条派工');
  if (!assignment.stage || assignment.worker !== 'loop' || assignment.project !== ticket.project || assignment.batch !== ticket.batch || assignment.batchFile && assignment.batchFile !== ticket.batchFile)
    return deny('派工身份缺失或不一致');
  if (Object.values(state.tables.assignments).some(other => other.id !== assignment.id && other.worker === assignment.worker && other.batch === assignment.batch && other.stage === assignment.stage && (other.state === 'queue') === (assignment.state === 'queue')
    && (!assignment.batchFile || other.project === assignment.project && other.batchFile === assignment.batchFile)))
    return deny('相同批次名和段对应多条派工，当前loop接口不能唯一定位；请先澄清批次身份');
  if (!intent?.confirmed || intent.version !== write.intentVersion) return deny('没有当前有效的授权；不能跨意图卡借权限');
  if (intent.pausedActions?.includes(write.action)
    || !write.execution && intent.pausedActions?.some(action => action === 'merge' && /合入|上线|\bmerge\b/i.test(write.text) || action === 'push' && /推送|推到仓库|\bpush\b/i.test(write.text))) return deny('用户已收紧要求，相关动作暂停；不能用卡片或送话绕过');
  if (ticket.closure || assignment.endedAt) return deny('批次已合入或已停，不能再次执行');
  if (assignment.lastEventId !== write.eventId || card.eventId !== write.eventId || card.revision !== write.cardRevision) return deny('卡片/派工已变化，旧确认失效');
  if (write.automation) {
    if (redline || !automaticPermission(state, card, write)) return deny('自动授权已失效、不能及时发现或涉及红线；须本人确认');
  } else if (!input || input.actor !== write.actor || input.cardId !== card.id || input.revision !== write.cardRevision) return deny('缺少本人对这条请求的确认');
  if (write.execution) {
    const target = write.execution, approval = intent.executionApproval;
    if (!input || !['push', 'merge', 'stop'].includes(target.action) || input.action !== target.action || write.action !== target.action || !write.explicitConfirmation)
      return deny('执行必须由本人点明确的推送、合入或停批次按钮，不能进自动档');
    if (!approval || approval.inputId !== input.id || approval.assignmentId !== assignment.id || approval.eventId !== write.eventId
      || JSON.stringify(approval.target) !== JSON.stringify(target) || !intent.boundaries.execute.includes(`loop_${target.action}`)) return deny('缺少这一个执行对象的逐条授权');
    if (!card.executions?.some(allowed => JSON.stringify(allowed) === JSON.stringify(target))) return deny('该动作不属于当前卡片');
    if (target.action === 'push' || target.action === 'merge') {
      if (Object.values(state.tables.assignments).some(row => row.ticketId === ticket.id && row.state === 'queue' && !row.endedAt && state.events[row.lastEventId]?.detail.status !== 'ready')) return deny('合入队列尚未就绪或已退回，旧完成卡不能放行发布；请先重新核实');
      const assessment = card.assessmentId ? state.tables.assessments[card.assessmentId] : undefined;
      if (assignment.state !== 'completed' || !assessment?.commit || assessment.commit.result === 'missing' || assessment.commit.resolved !== target.commit)
        return deny('完成提交尚未核实，不能推送或合入');
      if (!target.branch || !validBatchBranch(target.branch) || !/^[a-f0-9]{40,64}$/i.test(target.commit ?? '')) return deny('只能操作明确的批次分支和已核实提交，不操作 main');
      if (assessment.commit.result === 'candidate') {
        if (target.action !== 'merge' || !target.candidateRef || target.candidateRef !== assessment.commit.ref) return deny('候选身份与核实依据不一致，且候选只允许合入、不能推送');
      } else if (target.candidateRef !== undefined) return deny('批次分支核实不能借用未核实的候选身份');
      if (target.action === 'push' && (assessment.commit.result !== 'branch' || !target.remote || !/^[A-Za-z0-9_.-]+$/.test(target.remote) || target.remote.startsWith('-')))
        return deny('推送目标未核实，或候选还没提交到批次分支');
    } else if (!['paused', 'repair_limit', 'failed', 'queue', 'needs_decision'].includes(assignment.state)) return deny('只能停掉当前卡住的批次');
    if (write.withdrawnAt || write.state === 'revoked') return deny('请求已撤回');
    return { allowed: true, redline: true, reason: `本人明确确认 ${target.action}；仅限此批次/提交；不授予自动执行权限` };
  }
  const scope = actionScope(state, card);
  if (!redline && scope && state.tables.modes[scope.id]?.mode === 'shadow') return deny('这一类在影子档，只记录、不发送');
  if (!intent.boundaries.outbound.includes('loop_reply')) return deny('没有当前有效的送话授权；不能跨意图卡借权限');
  if (card.actionMode === 'none') return deny('卡片/派工已变化，旧确认失效');
  if (!write.text.trim() || Array.from(write.text).length > 4000) return deny('送话不能为空或超过4000字');
  if (redline && (!write.explicitConfirmation || input?.action !== 'confirm')) return deny('重大后果须明确确认送出的这一句话，不给按建议一键');
  if (write.withdrawnAt || write.state === 'revoked') return deny('请求已撤回');
  return { allowed: true, redline, reason: write.automation ? '自动档：本人已明确授权这一类；非红线、原卡交代、可撤回自动授权' : '建议档：本人只确认紧跟的这一条；范围限定到此 loop 派工' };
}
function guardDispatch(state: LedgerState, write: ManagedWrite): WriteDecision {
  const request = write.dispatch!, ticket = state.tables.tickets[write.ticketId], intent = ticket?.intents.at(-1);
  const card = state.tables.cards[write.cardId], proposal = state.tables.proposals[request.proposalId], input = state.tables.inputs[write.inputId];
  const assignment = state.tables.assignments[write.assignmentId];
  const redline = write.redline || !!card?.redline || !['supplement', 'query'].includes(request.kind) && majorConsequences(request.definition.result);
  const deny = (reason: string) => ({ allowed: false, reason, redline });
  if (!ticket || !proposal || !card || !assignment || proposal.ticketId !== ticket.id || assignment.ticketId !== ticket.id
    || card.proposalId !== proposal.id || card.ticketId !== ticket.id || card.assignmentId !== assignment.id || assignment.proposalId !== proposal.id
    || request.requestId !== write.id || request.ticketId !== ticket.id || request.project !== ticket.project || request.batch !== ticket.batch)
    return deny('派工必须指向明确的事情、建议和这一次派工');
  if (!intent?.confirmed || intent.version !== write.intentVersion || JSON.stringify(request.definition) !== JSON.stringify(intent)
    || intent.pausedActions?.includes('dispatch') || card.revision !== write.cardRevision || card.eventId !== write.eventId)
    return deny('派工定义/意图版本已变或用户暂停了派工，旧确认失效');
  const waiting = !!write.automation && waitingForAutomaticCard(state, card, write);
  if (write.automation) {
    if (redline || request.mode !== 'auto' || request.source !== 'pa_auto' || !automaticPermission(state, card, write) && !waiting) return deny('自动派工授权已失效或涉及红线，须本人确认');
  } else if (!input || input.actor !== write.actor || input.cardId !== card.id || input.revision !== card.revision
    || request.mode !== 'suggest' || request.source !== 'user_via_pa' || !write.explicitConfirmation)
    return deny('建议档缺少本人对这一次派工的确认');
  const scope = actionScope(state, card);
  if (!redline && scope && state.tables.modes[scope.id]?.mode === 'shadow') return deny('这一类在影子档，只记录、不派出');
  const expected = proposal.kind === 'supplement' ? 'query' : proposal.kind === 'cc' ? redline ? 'dispatch_confirm' : 'relay_cc' : redline ? 'dispatch_confirm' : 'dispatch';
  if ((!write.automation && input?.action !== expected) || request.kind !== proposal.kind || request.recipe !== proposal.recipe
    || JSON.stringify(request.skills) !== JSON.stringify(proposal.skills) || JSON.stringify(request.sheet) !== JSON.stringify(proposal.sheet)
    || JSON.stringify(request.target) !== JSON.stringify(proposal.target) || JSON.stringify(request.contextFacts) !== JSON.stringify(proposal.facts) || intent.result !== proposal.definition.result
    || intent.done !== proposal.definition.done || JSON.stringify(intent.boundaries) !== JSON.stringify(proposal.definition.boundaries)
    || !intent.boundaries.execute.includes(`dispatch:${proposal.id}`)) return deny('只批准卡片展示的配方、定义和范围，不能借用其他权限');
  if (proposal.status !== 'pending' || write.state === 'revoked' || write.withdrawnAt) return deny('这次派工不在待发状态');
  const origin = state.tables.threads[ticket.threadId]?.source;
  if ((origin === 'workspace' || origin === 'minutes') && (!proposal.materialId || state.tables.materials[proposal.materialId]?.source !== origin)) return deny('原材料身份/来源缺失，不能转换为本人授权');
  if (request.materialId !== proposal.materialId) return deny('材料来源与本次建议不一致');
  if (proposal.materialId) {
    const material = state.tables.materials[proposal.materialId];
    if (!material || write.automation) return deny('材料本身不是授权；只能由本人确认本次建议');
    if (material.source === 'workspace' && (!material.choice || !intent.boundaries.read.includes(material.ref)
      || !intent.boundaries.prohibitedChanges?.includes(`不得移动、删除、覆盖收件箱原件：${JSON.stringify(material.ref)}`))) return deny('收件箱原件只读边界缺失，不能派出');
  }
  // CC是本人明确要求的原话转达，不是PA选择执行器；仍过本函数其余目标/原话/确认围栏。
  const workflow = request.kind === 'cc' ? undefined : codeRecipe(intent.result);
  if (workflow && request.kind !== 'supplement' && (request.kind !== 'loop' || request.recipe !== workflow)) return deny('代码修改/只评审/只验收必须走对应loop配方，不能被附带总结或skill绕过');
  if (workflow && workflow !== 'develop' && intent.boundaries.write.length) return deny('明确只读要求不能授予产品写权限');
  if (request.kind !== 'cc' && intent.boundaries.write.length
    && taskMeaning(intent.result).prohibitedChanges.some(rule => !intent.boundaries.prohibitedChanges?.includes(rule))) return deny('局部禁改边界必须完整随派工保留，不能丢失或放宽');
  if (request.kind === 'loop' && (!request.recipe || proposal.missing.length)) return deny('开批次缺配方或对象尚未明确');
  if ((request.kind === 'supplement' || request.kind === 'query') && !completeQuestionSheet(request.sheet))
    return deny('提问单缺目标、问题、只读边界、到位标准或预算');
  if (request.kind === 'skill' && (!request.skills?.length || proposal.missing.length)) return deny('skill或对象未配置/不明确');
  if (request.kind === 'cc' && (!request.target || request.text !== proposal.definition.result || input?.text !== request.text)) return deny('CC仅转发明确要求的原话给固定会话');
  // 所有身份、定义、边界检查完成后才给等待结论；不能把真实拒绝伪装成可重试。
  if (waiting) return { allowed: false, waitFor: 'card_delivery', reason: '原卡正在投递，等待回执后重新复核；尚未派工', redline };
  return { allowed: true, reason: write.automation ? '自动档：本人已明确授权该类派工；定义和范围完整，原卡交代、一次派一次交' : '建议档：本人已明确确认这一次派工；仅在意图卡范围内，一次派一次交', redline };
}
export function validBatchBranch(branch: string): boolean {
  const name = branch.replace(/^refs\/heads\//, '');
  return !['main', 'master', 'HEAD'].includes(name) && /^[A-Za-z0-9_\u0080-\uffff][A-Za-z0-9_./\u0080-\uffff-]*$/.test(name)
    && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock') && !name.startsWith('refs/');
}
/** 所有用户待发在接入层发出前核对目标；材料中的地址/模型输出不能改收件人。 */
export function guardCard(state: LedgerState, card: ManagedCard): boolean {
  if (card.id.startsWith('health:')) return true;
  if (card.materialId) return card.id === `material-card:${card.materialId}` && !!state.tables.materials[card.materialId] && !!state.tables.materialAssessments[card.materialId];
  if (card.modeControl) return card.id.startsWith('mode:') && !!state.tables.modes[card.modeControl.scopeId];
  if (card.memoryCandidateId) return card.id === card.memoryCandidateId && !!state.tables.memoryCandidates[card.memoryCandidateId];
  const ticket = state.tables.tickets[card.ticketId], assignment = state.tables.assignments[card.assignmentId];
  if (card.proposalId) return !!ticket && state.tables.proposals[card.proposalId]?.ticketId === ticket.id && card.id === ticket.id;
  return !!ticket && !!assignment && assignment.ticketId === ticket.id && card.id === ticket.id;
}
