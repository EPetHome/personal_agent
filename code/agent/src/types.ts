export interface Project { id: string; root: string; loopRunDirs: string[] }
export interface Config {
  dataDir: string; attachmentDir: string; inboxDirs: string[]; projects: Project[];
  readAllow: string[]; readDeny: string[]; configPath: string;
  model: { url: string; name: string; auth: { type: 'pi' | 'env' | 'none'; path: string; provider: string; variable: string }; headers: Record<string, string>; timeoutMs: number; maxOutputTokens: number; dailyTokenLimit: number };
  feishu: { mode: 'fake' | 'real'; userId: string; url: string; envFile: string; pollMs: number; timeoutMs: number };
  loop: { command: string; args: string[]; eventDirs: string[]; timeoutMs: number };
  windowTokens: number; checkpointKeep: number; maxToolRounds: number;
  queue: { busyMs: number; inputTimeoutMs: number; stopMs: number };
  intake: { watch: boolean; fallbackMs: number; maxFileBytes: number };
  concurrency: { router: 1; read: number; skill: number; writePerDirectory: number };
  approval: { readPi: boolean; send: boolean; dispatch: boolean; stop: boolean; redLine: true };
  watchdog: { pollMs: number; heartbeatMs: number; heartbeatStaleMs: number; inputStaleMs: number; modelFailures: number; feishuStaleMs: number; minDiskBytes: number; local: { mode: 'fake' | 'native'; url: string } };
}
export interface Attachment { name: string; kind: 'image' | 'file'; key?: string; path?: string; mime?: string }
export interface Input {
  id: string; source: 'feishu' | 'inbox' | 'loop'; who: string; at: string; text: string;
  messageId?: string; chatType?: string; quoteId?: string; button?: unknown;
  attachments: Attachment[]; project?: string; batchFile?: string; workerId?: string;
  status?: string; evidence?: Record<string, string>; raw?: unknown;
}
export interface QueueRow { id: string; seq: number; state: string; input: Input; prepared: boolean; started: number | null }
export interface TaskCard {
  id: string; title: string; goal: string; completion: string; boundary: string; status: string;
  waiting: string; dispatches: unknown[]; conclusion: string; updated: string;
  subscriptions: { kind: 'loop' | 'pi' | 'message'; value: string }[];
}
export interface Material { path: string; sha256: string; bytes?: number }
export interface Turn { input: Input; materials: Material[]; replied: boolean; call: number; signal: AbortSignal }
