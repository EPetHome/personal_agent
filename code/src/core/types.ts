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
  loop?: LoopFacts;
  /** 归并会话保留每个成员自己的事实，不能用聚合时间/原件替代子会话身份。 */
  members?: SessionMember[];
}
export type SessionMember = Pick<SessionRecord,
  'sessionId' | 'project' | 'originals' | 'lastActivityAt' | 'recentSteps' |
  'pendingTools' | 'assistantFinished' | 'sessionEnded'>;
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
export interface HealthReport { source: HealthSource; errors: string[]; paths: string[] }
export interface SourceComponent {
  tool: Tool;
  extension: string;
  parse(text: string, original: Original): SessionRecord | null;
}
export type Status = '进行中' | '在等我' | '已完成' | '停滞' | '看不见了';
export interface JudgedRecord extends SessionRecord {
  status: Status;
  reason: string;
  waiting?: PushRecord;
  notice?: '待写发件记录' | '已提醒，本轮去重';
}
export interface HealthState extends HealthReport { since: string | null; episodeId: string | null }
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
  };
}
export interface Notice {
  version: 1;
  id: string;
  dedupeKey: string;
  at: string;
  tool: HealthSource;
  kind: 'waiting' | 'stalled' | 'blind' | 'loop_paused' | 'loop_completed';
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
  | { kind: 'notices_delivered'; ids: string[] };
export type AgentEvent = EventPayload & { version: 1; id: string; at: string };
export interface Projection {
  sessions: Map<string, SessionRecord>;
  pushes: ValidatedPushRecord[];
  health: Map<HealthSource, HealthState>;
  notices: Notice[];
  deliveredNoticeIds: Set<string>;
  lastScanAt: string | null;
}
export interface Channel {
  name: string;
  send(notices: Notice[]): Promise<number>;
}
