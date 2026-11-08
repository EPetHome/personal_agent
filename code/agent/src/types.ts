export interface Project {
  id: string; root: string; loopRunDirs: string[];
  loop?: { batchDir: string; workspace?: string; workspaceName?: string; base?: string; allow: string[]; deny: string[] };
  pi?: { writeDirs: string[]; skills: Record<string, string> };
}
export interface Config {
  dataDir: string; attachmentDir: string; inboxDirs: string[]; projects: Project[];
  readAllow: string[]; readDeny: string[]; configPath: string;
  outputs?: { otherProject: string };
  model: { url: string; name: string; auth: { type: 'pi' | 'env' | 'none'; path: string; provider: string; variable: string }; headers: Record<string, string>; timeoutMs: number; maxOutputTokens: number; dailyTokenLimit: number };
  feishu: { mode: 'fake' | 'real'; userId: string; url: string; envFile: string; pollMs: number; timeoutMs: number };
  loop: { command: string; args: string[]; eventDirs: string[]; timeoutMs: number; actionTimeoutMs: number };
  pi: { command: string; args: string[]; timeoutMs: number; pollMs: number; startupMs: number; maxTurns: number; model?: { url: string; name: string } };
  windowTokens: number; checkpointKeep: number; maxToolRounds: number;
  queue: { busyMs: number; inputTimeoutMs: number; stopMs: number };
  intake: { watch: boolean; fallbackMs: number; maxFileBytes: number };
  concurrency: { router: 1; read: number; skill: number; writePerDirectory: number };
  approval: { readPi: boolean; send: boolean; dispatch: boolean; stop: boolean; redLine: true };
  watchdog: { pollMs: number; heartbeatMs: number; heartbeatStaleMs: number; inputStaleMs: number; modelFailures: number; feishuStaleMs: number; minDiskBytes: number; local: { mode: 'fake' | 'native'; url: string } };
}
export interface Attachment { name: string; originalName?: string; kind: 'image' | 'file'; key?: string; path?: string; mime?: string; error?: string }
export interface Input {
  id: string; source: 'feishu' | 'inbox' | 'loop' | 'pi'; who: string; at: string; text: string;
  messageId?: string; chatType?: string; quoteId?: string; button?: unknown;
  attachments: Attachment[]; project?: string; batchFile?: string; workerId?: string;
  status?: string; evidence?: Record<string, string>; raw?: unknown;
}
export interface QueueRow { id: string; seq: number; state: string; input: Input; prepared: boolean; started: number | null }
export interface LoopBinding {
  protocol: 'kernel:1'; repository: string; runId: string; cardFile: string; ledger: string; taskId: string | null;
}
export interface TaskCard {
  id: string; title: string; goal: string; completion: string; boundary: string; status: string;
  waiting: string; dispatches: unknown[]; conclusion: string; updated: string;
  subscriptions: { kind: 'loop' | 'pi' | 'message'; value: string }[];
  worker?: { kind: string; project: string; batchFile: string; loop?: LoopBinding; operation?: string; origin?: 'pa' | 'owner-loop' };
  sourceRevision?: number; sourceFingerprint?: string; lastVerifiedAt?: string; control?: string;
  sourceDefinition?: { state: 'pending' | 'read'; prompt?: string; sha256?: string };
  sourceHealth?: { checkedAt: string; ok: boolean; reason?: string };
  sourceCurrent?: { worker: string; state: string; checkedAt: string; active: boolean; next?: string; reason?: string;
    stages?: { name: string; state: string; alive: boolean }[]; stageCount?: number;
    result?: { state: string; summary: string; question?: string; cleaned: boolean } };
  verified?: { event: string; state: string; stage: string | null; branch?: string; commit?: string; layers: unknown; manual: unknown; evidence: Record<string, string>; snapshot: unknown };
  presentation?: { cause: string; assessment: string; suggestion: string };
  notice?: string; deferred?: boolean;
  outputDraft?: { sourceInput: string; arguments: Record<string, unknown> };
}
export interface Material { path: string; sha256: string; bytes?: number }
export interface Turn { input: Input; materials: Material[]; replied: boolean; call: number; signal: AbortSignal; approvalThread?: string; taskId?: string }
