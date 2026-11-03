import type { ModelReplay, RequestRef, TaskActionType, Tool, WaitingDecision } from './types.ts';

export const INTENT_FIELDS = ['goal', 'result', 'stage', 'nonGoals', 'boundaries', 'done', 'askFirst'] as const;
export const CONFIDENCES = ['有把握', '拿不准', '不知道'] as const;
export type Confidence = typeof CONFIDENCES[number];
export const AGREEMENTS = ['一致', '部分一致', '不一致', '无法判断'] as const;
export type Agreement = typeof AGREEMENTS[number];
// 保留旧事件的只读 schema 与读沙箱审计类型，不保留后台分析配置或执行器。
export interface ReadTrace { path: string; startLine: number; endLine: number; startColumn?: number; endColumn?: number; contentSha256: string }
export interface BlockedRead { path: string; reason: string }
export type ReadAudit = { kind: 'read'; read: ReadTrace } | { kind: 'blocked'; blocked: BlockedRead }
  | { kind: 'call' } | { kind: 'limit' };
export interface ReadScope {
  transcript: string; project: string; home: string; dataDir: string; sourceDirs: string[]; maxToolCalls: number;
  /** loop 只读核实的显式原件；仍过不许读名单，不获得会话的敏感文件例外。 */
  evidenceFiles?: string[];
}
export interface AnalysisRequest {
  id: string; recordKey: string; sessionId: string; tool: Exclude<Tool, 'loop'>; project: string;
  transcript: string; evidenceAt: string; replyAt: string; outputFingerprint: string; ruleRedline: boolean;
  requestedAt: string; actionType: TaskActionType;
}
export interface AnalysisOutput {
  situation: string; debt: '欠' | '已交代完' | '拿不准'; reason: string; confidence: Confidence;
  suggestedReply: string; redline: boolean; actionType: TaskActionType;
  /** 只是草稿，任何模型输出都不能把它改成已确认。 */
  intentConfirmed?: false;
  intent: Record<typeof INTENT_FIELDS[number], { value: string; basis: string; confidence: Confidence }>;
}
export interface AnalysisResult {
  id: string; at: string; output?: AnalysisOutput; replay?: ModelReplay;
  reads: ReadTrace[]; blockedReads: BlockedRead[]; toolCalls: number; durationMs: number;
  failure?: { category: string; detail: string };
}
export interface ShadowDecision {
  analysisId: string; at: string; mode: 'blocked' | 'could_skip' | 'shadow_only' | 'reminded';
  waitingDecision: WaitingDecision; noticeId?: string;
}
export interface ShadowReply { analysisId: string; reply: RequestRef; actualReply: string | null; unavailable?: string }
export interface ShadowComparison {
  analysisId: string; at: string; agreement: Agreement; reason: string; suggestedReply: string; actualReply: string | null;
  replay?: ModelReplay; failure?: { category: string; detail: string };
}
export interface ShadowLabel { analysisId: string; at: string; debt: '当时欠你' | '聊完了' | '无法判断'; correct?: boolean }
export interface ShadowGuard { category: string; week: string; paused: boolean }
export type IntelligenceEvent =
  | { kind: 'analysis_requested'; request: AnalysisRequest }
  | { kind: 'analysis_finished'; result: AnalysisResult }
  | { kind: 'shadow_decided'; decision: ShadowDecision }
  | { kind: 'shadow_reply_observed'; reply: ShadowReply }
  | { kind: 'shadow_compared'; comparison: ShadowComparison }
  | { kind: 'shadow_labeled'; label: ShadowLabel }
  | { kind: 'shadow_guard'; guard: ShadowGuard };
export interface IntelligenceState {
  analysisRequests: Map<string, AnalysisRequest>; analysisResults: Map<string, AnalysisResult>;
  shadowDecisions: Map<string, ShadowDecision>; shadowReplies: Map<string, ShadowReply>;
  shadowComparisons: Map<string, ShadowComparison>; shadowLabels: Map<string, ShadowLabel>;
  shadowGuards: Map<string, ShadowGuard>;
}
/** 注入替身与生产实现共用同一只读执行器和审计，不存在无护栏的测试专用分析通道。 */
export const INTELLIGENCE_KINDS = ['analysis_requested', 'analysis_finished', 'shadow_decided', 'shadow_reply_observed', 'shadow_compared', 'shadow_labeled', 'shadow_guard'] as const;
export function validateIntelligenceEvent(event: IntelligenceEvent): void {
  const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const text = (value: unknown) => typeof value === 'string' && !!value;
  let valid = true;
  switch (event.kind) {
    case 'analysis_requested': { const r = event.request; valid = !!r && text(r.id) && text(r.recordKey) && text(r.sessionId)
      && ['cc', 'codex', 'pi'].includes(r.tool) && text(r.transcript) && text(r.project) && time(r.evidenceAt) && time(r.replyAt)
      && time(r.requestedAt) && text(r.outputFingerprint) && typeof r.ruleRedline === 'boolean'; break; }
    case 'analysis_finished': { const r = event.result; valid = !!r && text(r.id) && time(r.at) && Array.isArray(r.reads)
      && r.reads.every(read => text(read.path) && Number.isInteger(read.startLine) && read.startLine > 0 && Number.isInteger(read.endLine)
        && read.endLine >= read.startLine && (read.startColumn === undefined || Number.isInteger(read.startColumn) && read.startColumn >= 1)
        && (read.endColumn === undefined || Number.isInteger(read.endColumn) && read.endColumn >= 1) && /^[a-f0-9]{64}$/.test(read.contentSha256)) && Array.isArray(r.blockedReads)
      && r.blockedReads.every(read => text(read.path) && text(read.reason)) && Number.isInteger(r.toolCalls) && r.toolCalls >= 0
      && Number.isFinite(r.durationMs) && r.durationMs >= 0 && (!!r.output || !!r.failure); break; }
    case 'shadow_decided': { const d = event.decision; valid = !!d && text(d.analysisId) && time(d.at)
      && ['blocked', 'could_skip', 'shadow_only', 'reminded'].includes(d.mode) && !!d.waitingDecision; break; }
    case 'shadow_reply_observed': { const r = event.reply; valid = !!r && text(r.analysisId) && !!r.reply && time(r.reply.at)
      && Number.isInteger(r.reply.index) && (r.actualReply === null || typeof r.actualReply === 'string'); break; }
    case 'shadow_compared': { const c = event.comparison; valid = !!c && text(c.analysisId) && time(c.at)
      && AGREEMENTS.includes(c.agreement) && typeof c.reason === 'string' && typeof c.suggestedReply === 'string'
      && (c.actualReply === null || typeof c.actualReply === 'string'); break; }
    case 'shadow_labeled': { const l = event.label; valid = !!l && text(l.analysisId) && time(l.at)
      && ['当时欠你', '聊完了', '无法判断'].includes(l.debt) && (l.correct === undefined || typeof l.correct === 'boolean'); break; }
    case 'shadow_guard': { const g = event.guard; valid = !!g && text(g.category) && text(g.week) && typeof g.paused === 'boolean'; break; }
  }
  if (!valid) throw new Error('智能分析事件结构损坏，保留现场');
}
