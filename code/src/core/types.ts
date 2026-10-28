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
  dailyLimit: number;
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
  result?: JudgmentResult;
  snapshot?: TaskSnapshot;
  /** 区分旧版判断，升级不重试已交代的旧事实。 */
  snapshotVersion?: 1;
  error?: '调用失败，仅规则判断' | '每日额度用完，仅规则判断' | '本轮模型时限用完，仅规则判断';
  failure?: { category: import('./process.ts').FailureCategory; detail: string };
}
export interface ModelFinding extends ModelCheck { result: JudgmentResult }
export interface Original { path: string; fingerprint: string }
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
  id: string;
  dedupeKey: string;
  at: string;
  tool: HealthSource | 'agent';
  kind: 'waiting' | 'drift' | 'stalled' | 'blind' | 'unreadable' | 'loop_paused' | 'loop_completed' | 'weekly' | 'recurrence' | 'service_restart';
  level: '现在就要你' | '有空看';
  sessionKey?: string;
  memberSessionId?: string;
  /** 事实发生时间，独立于提醒生成时间与展示文字；旧日志可由模型判断追溯。 */
  evidenceAt?: string;
  /** 健康提醒能定位会话时的反馈作用域；未知会话不得压住整个来源。 */
  feedbackScope?: string;
  snapshot?: TaskSnapshot;
  /** 发卡时确定并保留，重试不因人在场与否变化而改走另一出口。旧卡仍按级别。 */
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
export type EventPayload =
  | { kind: 'session_observed'; record: SessionRecord }
  | { kind: 'session_seen'; tool: Tool; sessionId: string }
  | { kind: 'push_observed'; push: PushRecord }
  | { kind: 'push_validated'; pushId: string; recordKey: string; recovered?: boolean }
  | { kind: 'push_empty'; pushId: string; reason: string }
  | { kind: 'push_deferred'; pushId: string; rounds: number }
  | { kind: 'push_cursor'; path: string; lines: number; fingerprint: string }
  | { kind: 'source_health'; report: HealthReport }
  | { kind: 'scan_completed' }
  | { kind: 'notice_planned'; notice: Notice }
  | { kind: 'notice_suppressed'; dedupeKey: string; evidenceAt: string }
  | { kind: 'notices_delivered'; ids: string[] }
  | { kind: 'model_call_started'; task: JudgmentTask | 'snapshot' | 'attribution' | 'same_problem'; key: string }
  | { kind: 'notice_snapshot_written'; key: string; snapshot: TaskSnapshot }
  | { kind: 'notice_reply_observed'; noticeId: string; reply: RequestRef }
  | { kind: 'model_checked'; check: ModelCheck }
  | { kind: 'channel_delivery'; channel: string; noticeId: string; ok: boolean }
  | { kind: 'feishu_connection'; connection: FeishuConnection };
export type AgentEvent = EventPayload & { version: 1; id: string; at: string };
export interface Projection {
  sessions: Map<string, SessionRecord>;
  /** 内存中的最后可见事实，供读取故障卡片使用，不复活成当前正常会话。 */
  snapshotSessions?: ReadonlyMap<string, SessionRecord>;
  seenSessions: Set<string>;
  feishuConnection?: FeishuConnection & { at: string };
  pushes: ValidatedPushRecord[];
  health: Map<HealthSource, HealthState>;
  notices: Notice[];
  deliveredNoticeIds: Set<string>;
  lastScanAt: string | null;
  startedAt: string | null;
  suppressedNotices: Map<string, string>;
  modelChecks: Map<string, ModelCheck>;
  /** 所有历史证据的判断索引；由旧/新事件重建，不改写日志。 */
  modelEvidence: Map<string, ModelCheck>;
  noticeSnapshots: Map<string, TaskSnapshot>;
  noticeReplies: Map<string, RequestRef>;
  /** 从只追加反馈现算，非事件事实，也不持久化为跨会话规则。 */
  feedbackSuppressions: Set<string>;
  modelCalls: Map<string, number>;
  channelDeliveries: Map<string, boolean>;
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
}
/** 渠道只发给用户本人，不替用户回复来源工具。编号只在结构化参数内。 */
export interface Channel {
  name: string;
  /** 省略时兼容段 1：只投「现在就要你」。 */
  levels?: readonly Notice['level'][];
  send(notice: Notice): Promise<void>;
  receive(reply: ChannelReply): Promise<string>;
}
