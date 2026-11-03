import type { ReadAudit } from './intelligence-types.ts';

export const LOOP_STATES = ['started', 'needs_decision', 'paused', 'repair_limit', 'completed', 'failed', 'resumed', 'queue'] as const;
export type LoopState = typeof LOOP_STATES[number];
export interface LoopEvent {
  schema: 1; id: string; seq: number; at: string; project: string; batch: string; batchFile?: string; stage: string; state: LoopState;
  reason: { category: string; text: string }; evidence: string[]; detail: Record<string, unknown>;
  /** 官方原事件保真；schema/state仅是PA内部视图。 */
  native?: { v: 1; id: string; seq: number; at: string; project: string; batch: { file: string; name: string; recipe: string };
    stage: string | null; status: string; reason: { category: string; text: string }; evidence: Record<string, string>; detail: Record<string, unknown> };
}
export interface LoopStatus {
  schema: 1; batch: string; updatedAt: string; lastActivityAt?: string; batchFile?: string;
  native?: Record<string, unknown>;
  /** 当前真实执行端能力缺口；不可显示成可执行发布按钮。 */
  executionBlock?: string;
  stages: { name: string; state: string; reason?: { category: string; text: string }; detail?: Record<string, unknown>; evidence?: string[]; sessionPresent?: boolean; sessionId?: string }[];
  branch?: string; commit?: string; candidateRef?: string; queue?: { status: string; returns: number; candidateRef?: string };
  pushTarget?: { remote: string; visibility: 'public' | 'private' | 'unknown' };
}
export interface IntentVersion {
  version: number; at: string; source: string; confirmed: boolean; replaces?: number;
  goal: string; result: string; stage: string; nonGoals: string; done: string; askFirst: string;
  boundaries: { read: string[]; write: string[]; execute: string[]; realDevice: boolean; outbound: string[]; prohibitedChanges?: string[] };
  executionApproval?: { inputId: string; assignmentId: string; eventId: string; target: ExecutionTarget };
  /** 用户收紧要求持续生效；按钮、worker事件和模型不能重新放宽。 */
  pausedActions?: string[];
  change?: { inputId: string; text: string; fields: string[]; affectedWrites: string[] };
}
export interface Ticket {
  id: string; project: string; batch: string; batchFile?: string; threadId: string; parentId?: string; intents: IntentVersion[];
  status: string; reportedState?: LoopState; lastEventId: string; updatedAt: string;
  closure?: { kind: 'merged' | 'stopped'; requestId: string; at: string; commit?: string };
}
export interface Thread { id: string; ticketId: string; source: 'loop' | 'feishu' | 'workspace' | 'minutes'; project: string; batch: string }
export interface Assignment {
  id: string; ticketId: string; worker: 'loop' | 'pi'; project: string; batch: string; batchFile?: string; stage: string;
  origin: 'registered' | 'dispatched'; proposalId?: string; startRequestId?: string; purpose?: 'task' | 'supplement' | 'cc'; state: LoopState; lastEventId: string; seq: number; updatedAt: string;
  dueAt?: string; assessedEventId?: string; lastActivityAt?: string;
  session?: { present: boolean; id?: string; at: string }; endedAt?: string;
}
export interface Assessment {
  id: string; ticketId: string; assignmentId: string; eventId: string; at: string;
  fact: string; question: string; options: string[]; suggestion: string; basis: string;
  redline: boolean; mismatch: boolean; suppressed: boolean; status?: LoopStatus; statusFailure?: string;
  commit?: { result: 'branch' | 'candidate' | 'missing'; branch: string; reported: string; resolved?: string; ref?: string };
  memoryDrafts?: MemoryDraft[];
  reads: ReadAudit[]; queryMs: number; model?: { used: boolean; failure?: string; model: string; usage?: import('./model.ts').PiReadUsage };
}
export interface Attention {
  id: string; ticketId: string; assignmentId: string; eventId: string; assessmentId?: string;
  status: 'pending' | 'waiting' | 'notified' | 'resolved'; reason: string;
}
export interface ManagedCard {
  id: string; ticketId: string; assignmentId: string; eventId: string; assessmentId?: string; revision: number; at: string;
  title: string; fact: string; question: string; suggestion: string; basis: string; options: string[];
  redline: boolean; actionMode: 'reply' | 'repair' | 'none'; deferred?: boolean;
  input?: boolean; deliveryText?: string; lastRequestId?: string; notifyChannels?: string[]; interrupt?: boolean;
  executions?: ExecutionTarget[]; suspendedExecutions?: ExecutionTarget[];
  proposalId?: string;
  taskAction?: 'query' | 'dispatch' | 'dispatch_confirm';
  modeScopeId?: string; modeControl?: { scopeId: string; version: number; canAuto: boolean };
  memoryCandidateId?: string;
  materialId?: string;
  materialOptions?: { kind: MaterialOption; label: string }[];
  urgency?: 'decision' | 'completion' | 'redline' | 'fault' | 'display';
  automaticRequestId?: string;
}
export type ExecutionAction = 'push' | 'merge' | 'stop';
export interface ExecutionTarget {
  action: ExecutionAction; branch?: string; commit?: string; remote?: string; visibility?: 'public' | 'private' | 'unknown';
  /** 仅候选合入使用；来自只读核实的白名单ref，不是worker或模型自授的执行范围。 */
  candidateRef?: string;
}
export interface Handoff {
  id: string; ticketId: string; assignmentId: string; eventId: string; at: string; trigger: 'repair_limit' | 'stopped';
  goal: string; progress: string; decisions: string[]; unresolved: string[]; codeLocation: string[];
}
export type WriteState = 'pending' | 'sending' | 'delivered' | 'consumed' | 'uncertain' | 'failed' | 'blocked' | 'revoked';
export interface ManagedWrite {
  id: string; ticketId: string; assignmentId: string; cardId: string; cardRevision: number; eventId: string; intentVersion: number;
  actor: string; inputId: string; at: string; dispatchedAt?: string; text: string; action: string; state: WriteState;
  redline: boolean; explicitConfirmation: boolean; basis: string; reason?: string; withdrawnAt?: string;
  execution?: ExecutionTarget; dispatch?: DispatchRequest; outcome?: WorkerReceipt['outcome']; commit?: string; code?: string; failure?: boolean;
  automation?: AutomaticApproval;
  choice?: Omit<DecisionSample, 'id' | 'at' | 'requestId' | 'ticketId'>;
}
export interface CardDelivery {
  id: string; cardId: string; revision: number; channel: string; state: 'pending' | 'sending' | 'sent' | 'uncertain' | 'failed';
  messageId?: string; failures: number; reason?: string; eventId?: string;
  /** 开始这次渠道尝试的账本事务号；旧的在途成功不能覆盖后来的失败。 */
  attemptSeq?: number;
}
export interface ManagedInput {
  id: string; actor: string; at: string; messageId: string; cardId: string; revision: number;
  action: string; option?: number; text?: string; source?: 'sidebar';
}
export interface LedgerTables {
  threads: Thread; tickets: Ticket; assignments: Assignment; assessments: Assessment; attentions: Attention; cards: ManagedCard;
  writes: ManagedWrite; deliveries: CardDelivery; handoffs: Handoff;
  inputs: ManagedInput;
  proposals: TaskProposal;
  materials: SourceMaterial; materialAssessments: MaterialAssessment;
  calendars: CalendarSnapshot;
  choices: DecisionSample; memoryCandidates: MemoryCandidate; memories: ConfirmedMemory;
  conversations: { id: string; ticketId?: string; turns: { inputId: string; text: string; at: string; ticketId?: string }[] };
  receipts: { id: string; response: string; at: string };
  cursors: { id: string; bytes: number; dev: number; ino: number };
  health: { id: string; ok: boolean; reason: string; episode: string; at: string; kind?: 'source' | 'delivery' | 'service';
    lastFailureSeq?: number; deliveryId?: string; attemptSeq?: number };
  connections: { id: string; state: string; failure?: { category: string; message: string }; at: string };
  modes: ActionMode;
}
export type LedgerTable = keyof LedgerTables;
export type LedgerPut = { [K in LedgerTable]: { kind: 'put'; table: K; value: LedgerTables[K] } }[LedgerTable];
export interface Observation {
  kind: 'called' | 'attention_ready' | 'not_called' | 'suggestion' | 'loop_misreport' | 'query' | 'guard' | 'write' | 'withdrawal' | 'invalid_event' | 'feedback' | 'mode' | 'memory' | 'serious_error';
  scopeId?: string;
  ticketId?: string; eventId?: string; requestId?: string; actor?: string; detail: string; value?: number;
}
export type LedgerChange = LedgerPut | { kind: 'loop_event'; event: LoopEvent; source: string } | { kind: 'observation'; observation: Observation };
export interface LedgerTransaction { schema: 1; id: string; seq: number; at: string; previous: string; changes: LedgerChange[]; checksum: string }
export interface LedgerState {
  tables: { [K in LedgerTable]: Record<string, LedgerTables[K]> };
  events: Record<string, LoopEvent>; observations: (Observation & { at: string })[];
  transactionIds: Set<string>; seq: number; checksum: string;
}
export interface WorkerReceipt {
  requestId: string; status: 'delivered' | 'consumed' | 'uncertain' | 'failed'; reason?: string;
  outcome?: 'pushed' | 'merged' | 'stopped' | 'blocked'; commit?: string; code?: string; failure?: boolean;
}
export interface ExecutionRequest extends ExecutionTarget {
  requestId: string; project: string; batch: string; batchFile?: string; stage: string; source: 'user_via_pa';
  force: false; checkSecrets: true; protectedBranches: string[];
}
export interface LoopWorker {
  status(batch: string, project: string, batchFile?: string): Promise<LoopStatus>;
  send(input: { requestId: string; project?: string; batch: string; batchFile?: string; stage: string; text: string; source: 'user_via_pa' | 'pa_auto' }): Promise<WorkerReceipt>;
  execute?(input: ExecutionRequest): Promise<WorkerReceipt>;
  start?(input: DispatchRequest): Promise<DispatchReceipt>;
}

export interface QuestionSheet {
  goal: string; questions: string[];
  boundary: { read: string[]; write: string[]; tools: string[]; outbound: false; realDevice: false };
  arrival: string; budget: { timeoutMs: number; maxRounds: 1 };
}
export interface TaskProposal {
  id: string; ticketId: string; at: string; sourceInputId: string;
  kind: 'loop' | 'query' | 'skill' | 'supplement' | 'cc';
  definition: IntentVersion; recipe?: 'develop' | 'review_only' | 'acceptance_only'; skills?: string[];
  missing: string[]; sheet?: QuestionSheet;
  target?: import('./cc-relay.ts').RelayTarget;
  materialId?: string;
  status: 'proposed' | 'pending' | 'consumed' | 'uncertain' | 'failed' | 'blocked';
  queryOffered?: boolean; facts?: { text: string; basis: string }[]; questions?: string[];
}
export interface DispatchRequest {
  schema: 1; requestId: string; proposalId: string; ticketId: string; project: string; batch: string;
  kind: TaskProposal['kind']; recipe?: TaskProposal['recipe']; skills?: string[];
  definition: IntentVersion; sheet?: QuestionSheet; target?: TaskProposal['target']; text?: string;
  contextFacts?: { text: string; basis: string }[];
  handoff?: Handoff; materialId?: string; source: 'user_via_pa' | 'pa_auto'; mode: 'suggest' | 'auto';
}
export interface ActionScope { id: string; source: string; action: string }
export interface ActionMode extends ActionScope {
  mode: 'shadow' | 'suggest' | 'auto'; at: string; version?: number; epoch?: number;
  actor?: string; inputId?: string;
}
export interface AutomaticApproval { scopeId: string; version: number; inputId: string }
export interface DecisionSample {
  id: string; at: string; requestId: string; ticketId: string; scopeId: string; epoch: number;
  eventId: string; selected: string; suggested: string; agreed: boolean; eligible: boolean;
  ruleKey?: string; question?: string; options?: string[];
}
export type MemoryKind = 'rule' | 'person' | 'preference' | 'focus';
export interface MemoryDraft {
  kind: MemoryKind; subject: string; content: string; terms: string[]; basis: string[];
  rule?: { key: string; choice: string; question: string; options: string[] };
}
export interface MemoryCandidate extends MemoryDraft {
  id: string; memoryId: string; expectedVersion: number; at: string;
  status: 'pending' | 'confirmed' | 'dismissed'; ticketId?: string;
}
export interface MemoryVersion extends MemoryDraft {
  version: number; at: string; actor: string; inputId: string; candidateId: string;
}
export interface ConfirmedMemory { id: string; kind: MemoryKind; versions: MemoryVersion[] }
export type MaterialOption = 'transcribe_summary' | 'transcribe' | 'summary' | 'wiki';
export interface SourceMaterial {
  id: string; source: 'workspace' | 'minutes'; ref: string; at: string; title: string;
  text: string; fingerprint: string; media: 'audio' | 'video' | 'image' | 'text' | 'file';
  file?: { root: string; size: number; mtimeMs: number; dev: number; ino: number; birthtimeMs: number };
  todos?: string[];
  choice?: { kind: MaterialOption; inputId: string; actor: string; at: string };
}
export interface MaterialAssessment {
  id: string; materialId: string; at: string; what: string; related: string[]; basis: string;
  options: { kind: MaterialOption; label: string }[]; todos: string[];
  model?: { used: boolean; failure?: string; usage?: import('./model.ts').PiReadUsage };
}
export interface CalendarMeeting { id: string; calendarId: string; title: string; start: string; end: string }
export interface CalendarSnapshot { id: string; calendarId: string; at: string; from: string; to: string; meetings: CalendarMeeting[] }
export interface DispatchReceipt {
  requestId: string; status: 'consumed' | 'uncertain' | 'failed'; reason?: string;
  facts?: { text: string; basis: string }[]; questions?: string[]; result?: string;
}
