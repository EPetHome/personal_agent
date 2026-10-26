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
}
export interface Original { path: string; fingerprint: string }
export interface Step { at: string; text: string }
export interface PendingTool extends Step { id: string }
export interface LoopFacts {
  conclusion: string;
  status: '完成' | '暂停' | '进行中';
  reviews: number;
  repairs: number;
  needs: string[];
  needsProvided?: boolean;
}
/** 来源组件和后续步骤唯一的会话交换格式。不保存整份会话/工具返回正文。 */
export interface SessionRecord {
  key: string;
  tool: Tool;
  sessionId: string;
  type: 'ai_session' | 'loop_run';
  originals: Original[];
  project: string;
  intent: { initial: string | null; additions: string[] };
  lastActivityAt: string;
  recentSteps: Step[];
  pendingTools: PendingTool[];
  assistantFinished: boolean;
  sessionEnded: boolean;
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
  'sessionId' | 'project' | 'originals' | 'recentSteps' |
  'pendingTools' | 'assistantFinished' | 'sessionEnded' | 'parentSessionId' | 'unavailable'> & {
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
export interface ValidatedPushRecord extends PushRecord { recordKey: string }
export interface HealthReport {
  source: HealthSource;
  /** 仅整体来源/推送故障会令会话状态无法确认。 */
  errors: string[];
  paths: string[];
  fileFailures?: { count: number; examples: string[] };
  fileStats?: { total: number; skipped: number };
  /** 最近一次可见会话清单；旧日志缺此字段时保留旧行为。 */
  sessionKeys?: string[];
}
export interface SourceReadContext { modifiedAt: string }
export interface SourceComponent {
  tool: Tool;
  extension: string;
  /** 失败文件的核心身份，仅用于忽略/不可用关联，不能证明正常状态或授权新推送对账。 */
  identify?(text: string): SessionIdentity | null;
  identifyRow?(row: Record<string, any>): SessionIdentity | null;
  /** 来源读取使用可重复遍历的惰性行流，不加载整份原件。 */
  parseRows?(rows: Iterable<Record<string, any>>, original: Original): SessionRecord | null;
  parseLines?(lines: Iterable<string>, original: Original, context: SourceReadContext): SessionRecord | null;
  /** 构造测试/调用方已有文本时的兼容入口。 */
  parse(text: string, original: Original, context?: SourceReadContext): SessionRecord | null;
}
export type Status = '进行中' | '在等我' | '已完成' | '停滞' | '已搁置' | '看不见了';
export interface JudgedRecord extends SessionRecord {
  status: Status;
  reason: string;
  waiting?: PushRecord;
  notice?: '待写发件记录' | '已提醒，本轮去重' | '首次接入历史记录，不补发';
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
  };
}
export interface Notice {
  version: 1;
  id: string;
  dedupeKey: string;
  at: string;
  tool: HealthSource;
  kind: 'waiting' | 'stalled' | 'blind' | 'unreadable' | 'loop_paused' | 'loop_completed';
  level: '现在就要你' | '有空看';
  sessionKey?: string;
  content: NoticeContent;
  text: string;
}
export type EventPayload =
  | { kind: 'session_observed'; record: SessionRecord }
  | { kind: 'push_observed'; push: PushRecord }
  | { kind: 'push_validated'; pushId: string; recordKey: string }
  | { kind: 'push_cursor'; path: string; lines: number; fingerprint: string }
  | { kind: 'source_health'; report: HealthReport }
  | { kind: 'scan_completed' }
  | { kind: 'notice_planned'; notice: Notice }
  | { kind: 'notice_suppressed'; dedupeKey: string; evidenceAt: string }
  | { kind: 'notices_delivered'; ids: string[] };
export type AgentEvent = EventPayload & { version: 1; id: string; at: string };
export interface Projection {
  sessions: Map<string, SessionRecord>;
  pushes: ValidatedPushRecord[];
  health: Map<HealthSource, HealthState>;
  notices: Notice[];
  deliveredNoticeIds: Set<string>;
  lastScanAt: string | null;
  startedAt: string | null;
  suppressedNotices: Map<string, string>;
}
export interface Channel {
  name: string;
  send(notices: Notice[]): Promise<number>;
}
