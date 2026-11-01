export const tools = ['cc', 'codex', 'pi', 'loop'] as const;
export type Tool = typeof tools[number];
export type HealthSource = Tool | 'inbox';
export const toolNames: Record<HealthSource, string> = {
  cc: 'Claude Code', codex: 'Codex', pi: 'Pi', loop: 'loop', inbox: '推送事件',
};
export interface Config {
  sources: Record<Tool, string | null>;
  inboxDir: string | null;
  dataDir: string;
  commands: Record<'cc' | 'codex' | 'pi', string>;
  /** 词法目录边界匹配，不读取项目本身；未配置时不忽略。 */
  ignoreProjectPrefixes?: string[];
  /** 省略/null 保持纯规则模式，不启动任何模型或通知进程。 */
  judge?: JudgeConfig | null;
  localChannel?: { executable: string; timeoutMs: number } | null;
  feishu?: FeishuConfig | null;
  /** IM 原话转达；缺省关闭，目录必须显式配置，绝不推导真实主目录。 */
  relay?: { enabled: boolean; ccSessionsDir?: string; timeoutMs?: number };
  service?: { intervalMs: number; restartWindowMs: number; restartThreshold: number };
  learning?: boolean;
}
export interface FeishuConfig {
  mode: 'fake' | 'real';
  /** 同时是唯一收件人和允许反馈的操作者，使用 open_id。 */
  receiverId: string;
  envFile?: string;
  timeoutMs: number;
}
export type FeishuFailureCategory = 'credentials' | 'permission' | 'network' | 'configuration' | 'unknown';
export interface FeishuConnection {
  state: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'stopped' | 'fake';
  failure?: { category: FeishuFailureCategory; message: string };
}
export interface JudgeConfig {
  executable: string;
  model: string;
  /** 缺省不限次数；显式 0 仍为纯规则。 */
  dailyLimit?: number;
  timeoutMs: number;
  /** 单轮模型阶段总时限；缺省 60 秒，不包括来源读取/渠道投递。 */
  cycleTimeoutMs?: number;
}
export interface JudgmentContext {
  intentOriginal: string | null;
  additionalRequirements: string[];
  previousSummary: string;
  newSteps: Step[];
  assistantReply: string;
}
export type JudgmentTask = 'drift' | 'waiting';
export interface JudgmentRequest {
  task: JudgmentTask;
  context: JudgmentContext;
  format: 'binary' | 'confidence';
  /** 等待起草只读这四项；跑偏正常检测用下方按步骤对齐的材料。 */
  snapshotInput?: TaskSnapshotInput;
  /** 跑偏同一次调用先选核验步骤，再仅用该索引的四项材料起草；最多8项。 */
  snapshotInputsByStep?: TaskSnapshotInput[];
  /** 已发卡片后的原判断失败重试，不再起草或改旧文案。 */
  draftSnapshot?: boolean;
}
export interface JudgmentResult {
  answer: '是' | '否';
  reason: string;
  intentQuote?: string;
  stepQuote?: string;
  /** 与本次判断同一次调用顺带起草；缺失/不可用时规则兜底。 */
  situation?: string;
  action?: string;
  actionType?: TaskActionType;
  actionItems?: TaskActionItem[];
  confidence?: '高' | '中' | '低';
}
export type TaskActionType = '回答问题' | '做个决定' | '去看一眼' | '不用管';
export type TaskActionLabel = '回复会话' | '你去做' | '要你定·红线' | '不用管';
export interface TaskActionItem { text: string; label: TaskActionLabel; suggestion?: string }
export interface TaskSnapshotInput {
  goal: string | null;
  currentTask: string | null;
  lastOutput: string;
  factualStatus: '在等你' | '跑偏' | '停滞' | 'loop 完成' | 'loop 暂停' | '看不见了';
}
export interface TaskSnapshotDraft {
  situation: string;
  action: string;
  actionType: TaskActionType;
  /** 旧快照可缺省；新快照至少一件。 */
  actionItems?: TaskActionItem[];
}
export interface TaskSnapshot extends TaskSnapshotInput, TaskSnapshotDraft {
  source: '模型' | '规则';
  /** 追加事件关联的下一句真人输入，只存引用，不复制正文。 */
  nextHumanReply?: RequestRef;
}
export interface Judge {
  judge(request: JudgmentRequest, options?: { signal?: AbortSignal }): Promise<JudgmentResult>;
  /** 替身省略此方法即只做规则兜底，不偷偷调用真实模型。 */
  writeSnapshot?(input: TaskSnapshotInput, options?: { signal?: AbortSignal }): Promise<TaskSnapshotDraft>;
}
export interface CodeVersion {
  /** 启动本进程时从代码所在仓库取得；打包副本没有 Git 时明确为 null。 */
  commit: string | null;
  dirty: boolean | null;
}
export interface ModelReplay {
  model: string;
  promptVersion: string;
  templateSha256: string;
  /** SHA-256(JSON.stringify(input))，UTF-8；包含系统指令和完整 stdin。 */
  inputSha256: string;
  input: { systemPrompt: string; prompt: string };
  /** 外部材料全部引用已有记录，offset 按 JSON 字符串编码后的 UTF-16 索引；兼容旧的局部引用。 */
  references?: { placeholder: string; source: { kind: 'session' | 'model_check' | 'notice_snapshot' | 'push'; key: string;
    path: (string | number)[]; valueSha256: string }; start: number; end: number }[];
  unavailable?: 'credential_reference_unavailable' | 'input_reference_unavailable';
}
export type SuppressionReason = 'duplicate_notice' | 'waiting_interval' | 'user_replied' | 'model_daily_limit'
  | 'first_connection_history' | 'recovered_push' | 'feedback_false_positive' | 'model_cycle_timeout'
  | 'drift_cooldown' | 'missing_trigger_member' | 'loop_resumed' | 'model_evidence_24h';
export interface WaitingWindow {
  dedupeKey: string;
  evidenceAt: string;
  sessionKey: string;
  memberSessionId: string;
  scope: 'notice' | 'model_check';
  intervalMs: number;
}
export interface RuleDecision {
  id: 'active_unfinished' | 'source_unavailable' | 'push_mismatch' | 'inactive_24h' | 'loop_paused'
    | 'loop_completed' | 'permission_waiting' | 'member_unavailable' | 'all_members_completed' | 'unfinished_30m'
    | 'fallback_explicit_question' | 'model_fact_inactive_24h';
  facts: {
    lastActivityAt: string;
    thresholdMs?: number;
    loopStatus?: LoopFacts['status'];
    loopPausedAt?: string;
    members: { sessionId: string; lastActivityAt: string | null; sessionEnded: boolean; assistantFinished: boolean;
      pendingTools: number; unavailable: boolean; completed: boolean; pushEvent?: PushRecord['event']; pushAt?: string }[];
  };
}
export interface RuleObservation { recordKey: string; status: Status; rule: RuleDecision }
export interface ModelCheck {
  key: string;
  recordKey: string;
  sessionId: string;
  task: JudgmentTask;
  at: string;
  evidenceAt: string;
  fingerprint: string;
  stepIds: string[];
  summary: string;
  /** 仅实际调用才有；额度/时限阻止调用的记录不伪造输入。 */
  replay?: ModelReplay;
  originals?: Original[];
  result?: JudgmentResult;
  snapshot?: TaskSnapshot;
  /** 区分旧版判断，升级不重试已交代的旧事实。 */
  snapshotVersion?: 1;
  /** 跑偏核验步骤的时间和实际成员；不改变既有 evidenceAt/去重身份。 */
  triggerStep?: { at: string; sessionId: string };
  error?: '调用失败，仅规则判断' | '每日额度用完，仅规则判断' | '本轮模型时限用完，仅规则判断';
  failure?: { category: import('./process.ts').FailureCategory; detail: string };
}
export interface ModelFinding extends ModelCheck { result: JudgmentResult }
export interface Original {
  path: string;
  fingerprint: string;
  /** 本次解析完整读取的范围；原始字节含换行，SHA-256 复用已有 fingerprint，不重复存哈希。 */
  span?: { startLine: number; endLine: number; byteLength: number };
}
export interface Step {
  at: string;
  text: string;
  /** 来源明确标注步骤性质；旧记录缺省时不以时间相等猜成收尾。 */
  kind?: 'assistant' | 'tool' | 'tool_result';
  /** 仅有界的最近8步保存当时要求索引，不复制正文，也不送入判断步骤。 */
  requestRef?: RequestRef | null;
}
export interface PendingTool extends Step { id: string }
export interface LoopFacts {
  conclusion: string;
  /** 最后总结结论，只用于快照，不参与旧版事实去重。 */
  summary?: string;
  status: '完成' | '暂停' | '进行中';
  reviews: number;
  repairs: number;
  needs: string[];
  needsProvided?: boolean;
  batch?: string;
  phase?: string;
  sessions?: { development: string; review: string; acceptance: string[] };
}
/** 指向已有 intent 字符串；只加固定数量的时间/索引，不复制真人要求正文。 */
export interface RequestRef {
  index: number;
  at: string;
  sessionId?: string;
  /** 子代理中的真人活动必须有消息级明确 human 标记，旧记录缺省不算。 */
  explicitHuman?: true;
}
export interface RequestRefs {
  goal: RequestRef | null;
  latest: RequestRef | null;
  beforeStep: RequestRef | null;
  beforeReply: RequestRef | null;
}
/** 来源组件和后续步骤唯一的会话交换格式。不保存整份会话/工具返回正文。 */
export interface SessionRecord {
  key: string;
  tool: Tool;
  sessionId: string;
  type: 'ai_session' | 'loop_run';
  originals: Original[];
  project: string;
  /** 每份原件实际出现过的目录；只用于推送对账，不改变起始项目。旧记录可省略。 */
  cwdHistory?: { path: string; cwds: string[] }[];
  intent: { initial: string | null; additions: string[] };
  requestRefs?: RequestRefs;
  /** 真人输入的时间/原文索引，含「继续」等短回复；不复制正文。index=-1 为纯媒体。 */
  humanRequestRefs?: RequestRef[];
  lastActivityAt: string;
  recentSteps: Step[];
  pendingTools: PendingTool[];
  assistantFinished: boolean;
  sessionEnded: boolean;
  assistantReply?: Step;
  parentSessionId?: string;
  /** 本轮原件/归并失败，仅保留已知关联或历史事实，不得据此确认完成。 */
  unavailable?: boolean;
  loop?: LoopFacts;
  /** 明确的暂停时间；来源未提供时，检测首次看到暂停的时间，持续暂停不重置。 */
  loopPausedAt?: string;
  /** 归并会话保留每个成员自己的事实，不能用聚合时间/原件替代子会话身份。 */
  members?: SessionMember[];
}
export type SessionIdentity = Pick<SessionRecord, 'sessionId' | 'project' | 'parentSessionId'>;
/** 失败原件的身份线索，不是可供正常状态/推送对账使用的会话记录。 */
export type FailedSessionIdentity = SessionIdentity & { tool: Tool; original: Original };
export type SessionMember = Pick<SessionRecord,
  'sessionId' | 'project' | 'cwdHistory' | 'originals' | 'recentSteps' | 'requestRefs' | 'humanRequestRefs' |
  'pendingTools' | 'assistantFinished' | 'sessionEnded' | 'assistantReply' | 'parentSessionId' | 'unavailable'> & {
    /** 只有失败身份、没有已读取活动事实时为 null，不捏造子成员时间。 */
    lastActivityAt: string | null;
  };
export interface PushRecord {
  tool: Exclude<Tool, 'loop'>;
  event: 'waiting_permission' | 'turn_end' | 'session_end';
  sessionId: string;
  project: string;
  transcriptPath: string;
  at: string;
  detail: string;
  original: Original & { line: number };
}
/** 只有显式通过对账的推送才进入判断，保留实际发出事件的成员身份。 */
export interface ValidatedPushRecord extends PushRecord { recordKey: string; recovered?: boolean }
export interface HealthReport {
  source: HealthSource;
  /** 仅整体来源/推送故障会令会话状态无法确认。 */
  errors: string[];
  paths: string[];
  fileFailures?: { count: number; examples: string[] };
  fileStats?: { total: number; skipped: number };
  /** 缺省是旧的全部候选口径；新口径排除内部会话，基线只能在同口径内比较/学习。 */
  fileStatsProfile?: 'exclude_internal_v1' | 'exclude_internal_v2';
  /** 最近一次可见会话清单；旧日志缺此字段时保留旧行为。 */
  sessionKeys?: string[];
  /** 只保留有限的故障身份，供卡片定位会话，不把单条报信说成整种工具失效。 */
  affectedSessions?: (SessionIdentity & { intentOriginal?: string | null })[];
}
export interface SourceReadContext { modifiedAt: string }
export interface SourceComponent {
  tool: Tool;
  extension: string;
  /** 失败文件的核心身份，仅用于忽略/不可用关联，不能证明正常状态或授权新推送对账。 */
  identify?(text: string): SessionIdentity | null;
  identifyRow?(row: Record<string, any>): SessionIdentity | null;
  /** 记住身份曾在文件中出现，保护文件缺失时的判空；不证明正文/项目可读。 */
  sessionIdOf?(row: Record<string, any>): string | null;
  /** 不依赖身份识别核心消息/动作，区分无内容文件与有对话但无法生成会话的文件。 */
  isCoreRow?(row: Record<string, any>): boolean;
  /** 来源读取使用可重复遍历的惰性行流，不加载整份原件。 */
  parseRows?(rows: Iterable<Record<string, any>>, original: Original): SessionRecord | null;
  parseLines?(lines: Iterable<string>, original: Original, context: SourceReadContext): SessionRecord | null;
  /** 构造测试/调用方已有文本时的兼容入口。 */
  parse(text: string, original: Original, context?: SourceReadContext): SessionRecord | null;
}
export type Status = '进行中' | '在等我' | '已完成' | '停滞' | '已搁置' | '看不见了' | '疑似跑偏';
export interface JudgedRecord extends SessionRecord {
  status: Status;
  reason: string;
  rule?: RuleDecision;
  waiting?: PushRecord;
  modelWaiting?: ModelFinding;
  ruleWaiting?: { sessionId: string; evidenceAt: string; reply: string };
  drift?: ModelFinding;
  modelNotes?: string[];
  notice?: '待写发件记录' | '已提醒，本轮去重' | '首次接入历史记录，不补发' | '因你的误报没提醒';
}
export interface HealthState extends HealthReport {
  since: string | null;
  episodeId: string | null;
  fileFailureSince?: string | null;
  fileFailureEpisodeId?: string | null;
  skipBaseline?: number;
}
export interface NoticeContent {
  title: string;
  summary: string;
  situation?: string;
  action?: string;
  actionItems?: TaskActionItem[];
  returnCommand: string;
  evidence: {
    project: string | null;
    intentOriginal: string | null;
    additionalRequirements: string[];
    recentSteps: Step[];
    reason: string;
    originals: Original[];
    needs?: string[];
    needsProvided?: boolean;
    assistantReply?: string;
    presentation?: { situation: string; action: string };
  };
}
export interface Notice {
  version: 1;
  codeVersion?: CodeVersion;
  /** 仅当判断原件不同于最新所见、或读取故障只剩历史原件时补充，旧 evidence.originals 不改义。 */
  sourceEvidence?: Original[];
  id: string;
  dedupeKey: string;
  at: string;
  tool: HealthSource | 'agent';
  kind: 'waiting' | 'drift' | 'stalled' | 'blind' | 'unreadable' | 'loop_paused' | 'loop_completed' | 'weekly' | 'recurrence' | 'service_restart' | 'delivery_failed' | 'storage_full';
  level: '现在就要你' | '有空看';
  sessionKey?: string;
  memberSessionId?: string;
  /** 事实发生时间，独立于提醒生成时间与展示文字；旧日志可由模型判断追溯。 */
  evidenceAt?: string;
  /** 健康提醒能定位会话时的反馈作用域；未知会话不得压住整个来源。 */
  feedbackScope?: string;
  snapshot?: TaskSnapshot;
  /** 新卡按级别选出口，在场仅留痕；旧决定/重试不改出口，缺字段的旧卡仍按级别。 */
  delivery?: { presence: '在场' | '不在场'; channels: ('local' | 'feishu')[]; decidedAt: string; lastHumanAt?: string };
  content: NoticeContent;
  text: string;
  reviews?: ReviewItem[];
}
export interface ReviewItem {
  experienceId: string;
  /** 与卡片所示经验绑定的审阅版本；旧日志缺此字段时回调拒绝写入。 */
  experienceRevision?: string;
  title: string;
  count: number;
  previousAt: string | null;
  previousCountermeasure: string;
  layer: string;
  countermeasure: string;
  status: string;
}
export interface PushMismatch {
  pushId: string;
  recordKey?: string;
  reason: string;
  push: PushRecord;
  since: string;
  episodeId: string;
}
export interface ChannelDeliveryState {
  /** historyUnknown 时仅为已知后缀次数，不是完整历史的总数。 */
  failures: number;
  failure?: import('./failures.ts').SafeFailure;
  historyUnknown?: true;
}
export type ProjectionState = { [K in keyof Omit<Projection, 'snapshotSessions'>]:
  Projection[K] extends Map<infer A, infer B> ? [A, B][] : Projection[K] extends Set<infer V> ? V[] : Projection[K] };
export type EventPayload =
  | { kind: 'store_format'; format: 2; backup?: string }
  | { kind: 'store_checkpoint'; format: 2; sequence: number; archive: string; archives: string[]; state: ProjectionState }
  | { kind: 'session_delta'; delta: import('./session-delta.ts').SessionDelta }
  | { kind: 'push_mismatches'; mismatches: Pick<PushMismatch, 'pushId' | 'recordKey' | 'reason'>[] }
  | { kind: 'session_observed'; record: SessionRecord }
  | { kind: 'session_seen'; tool: Tool; sessionId: string }
  | { kind: 'push_observed'; push: PushRecord }
  | { kind: 'push_validated'; pushId: string; recordKey: string; recovered?: boolean }
  | { kind: 'push_empty'; pushId: string; reason: string }
  | { kind: 'push_deferred'; pushId: string; rounds: number }
  | { kind: 'push_cursor'; path: string; lines: number; fingerprint: string }
  | { kind: 'source_health'; report: HealthReport }
  | { kind: 'scan_completed'; ruleDecisions?: RuleObservation[] }
  | { kind: 'notice_planned'; notice: Notice }
  | { kind: 'notice_suppressed'; dedupeKey: string; evidenceAt: string; reason?: SuppressionReason;
      scope?: 'notice' | 'model_check'; decisionKey?: string; sessionKey?: string; memberSessionId?: string;
      reply?: RequestRef; intervalMs?: number }
  | { kind: 'notices_delivered'; ids: string[] }
  | { kind: 'model_call_started'; task: JudgmentTask | 'snapshot' | 'attribution' | 'same_problem'; key: string }
  | { kind: 'notice_snapshot_written'; key: string; snapshot: TaskSnapshot; replay?: ModelReplay }
  | { kind: 'notice_reply_observed'; noticeId: string; reply: RequestRef }
  | { kind: 'model_checked'; check: ModelCheck }
  | { kind: 'channel_delivery'; channel: string; noticeId: string; ok: boolean; phase?: 'queued' | 'attempted'; failure?: import('./failures.ts').SafeFailure }
  | { kind: 'notice_delivery_alerted'; noticeId: string; ok?: boolean; failure?: import('./failures.ts').SafeFailure }
  | { kind: 'channel_delivery_history_restored'; checkpointId: string; states: [string, ChannelDeliveryState][]; backup: string }
  | { kind: 'feishu_connection'; connection: FeishuConnection };
export type AgentEvent = EventPayload & { version: 1; id: string; at: string; codeVersion?: CodeVersion };
export interface Projection {
  sessions: Map<string, SessionRecord>;
  /** 内存中的最后可见事实，供读取故障卡片使用，不复活成当前正常会话。 */
  snapshotSessions?: ReadonlyMap<string, SessionRecord>;
  seenSessions: Set<string>;
  feishuConnection?: FeishuConnection & { at: string };
  pushes: ValidatedPushRecord[];
  /** 对账/去重所需的紧凑索引也进封存检查点，不再依赖归档原件。 */
  rawPushes: Map<string, PushRecord>;
  validatedPushIds: Set<string>;
  emptyPushIds: Set<string>;
  deferredPushes: Map<string, number>;
  pushCursors: Map<string, Extract<EventPayload, { kind: 'push_cursor' }>>;
  pushMismatches: Map<string, PushMismatch>;
  legacyChecks: Map<string, ModelCheck>;
  health: Map<HealthSource, HealthState>;
  notices: Notice[];
  deliveredNoticeIds: Set<string>;
  lastScanAt: string | null;
  startedAt: string | null;
  suppressedNotices: Map<string, string>;
  /** 新埋点去重与旧「首次接入不补发」索引隔离。 */
  telemetrySuppressions: Set<string>;
  /** 已观察、尚未结算的等待事实；只供埋点，不参与推送或模型候选决策。 */
  waitingWindows: Map<string, WaitingWindow>;
  ruleDecisions: Map<string, RuleObservation>;
  modelChecks: Map<string, ModelCheck>;
  /** 所有历史证据的判断索引；由旧/新事件重建，不改写日志。 */
  modelEvidence: Map<string, ModelCheck>;
  noticeSnapshots: Map<string, TaskSnapshot>;
  noticeReplies: Map<string, RequestRef>;
  /** 从只追加反馈现算，非事件事实，也不持久化为跨会话规则。 */
  feedbackSuppressions: Set<string>;
  modelCalls: Map<string, number>;
  channelDeliveries: Map<string, boolean>;
  /** 按卡片和渠道累计实际连续失败；不把排队算成一次尝试。 */
  channelDeliveryStates: Map<string, ChannelDeliveryState>;
  /** 本机停发告警按卡片去重，不因另一渠道停发或重启重复弹。 */
  deliveryAlerted: Set<string>;
}
export interface ChannelReply {
  /** undefined 指最近一条；null 仅供「漏了」明确不关联提醒。 */
  noticeId?: string | null;
  content: string;
  at: string;
  /** 渠道事件去重键，仅内部使用。 */
  replyId?: string;
}
export interface Feedback {
  version: 1;
  at: string;
  date: string;
  channel: string;
  noticeId: string | null;
  verdict: '正确' | '误报' | '漏了' | '看不懂';
  comment: string;
  replyId?: string;
  originalText?: string;
  card?: { title: string; firstScreen: string; returnCommand: string; at?: string };
  codeVersion?: CodeVersion;
  /** 漏报当时最近一次已提交的检测视图，不猜测用户指的是哪一个会话。 */
  context?: { asOf: string | null; eventId: string | null; capturedAt?: string; unavailable?: 'no_completed_scan' | 'state_unavailable';
    sessions: { key: string; tool: Tool; sessionId: string; status: Status; lastActivityAt: string;
      originals: Original[]; ruleId?: RuleDecision['id']; modelCheckKey?: string }[] };
}
/** 渠道只发给用户本人，不替用户回复来源工具。编号只在结构化参数内。 */
export interface Channel {
  name: string;
  /** 省略时兼容段 1：只投「现在就要你」。 */
  levels?: readonly Notice['level'][];
  send(notice: Notice): Promise<void>;
  receive(reply: ChannelReply): Promise<string>;
}
