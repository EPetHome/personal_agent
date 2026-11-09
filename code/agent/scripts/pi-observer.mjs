// Optional read-only Pi extension. No imports from PA, no transcript/file-content export.
import { constants } from 'node:fs';
import { lstat, realpath, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_BYTES = 64 * 1024;
export const HEARTBEAT_MS = 30_000;
export const SHUTDOWN_MS = 1_000;
const MAX_RECORDS = 512, MAX_PENDING = 128, MAX_NODES = 4096;
const uid = process.getuid?.();
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('observer_scope_or_file_invalid'); };
export function decodeJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(); }
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => { if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);
const secretPath = path => /(?:^|[/\\])(?:\.env[^/\\]*|\.ssh(?:[/\\]|$)|\.aws(?:[/\\]|$)|\.gnupg(?:[/\\]|$)|\.git(?:[/\\]|$)|\.npmrc$|\.netrc$|\.git-credentials$)|(?:auth|credential|cookie|token|secret|password|keychain)[^/\\]*\.(?:json|db|sqlite)$|\.(?:pem|key|p12|pfx)$/i.test(path);
const cleanPath = value => { if (typeof value !== 'string' || !isAbsolute(value) || value !== resolve(value) || value.includes('\0') || secretPath(value)) fail(); return value; };

// Reject aliases at every component (including directory links). No recursive discovery.
export async function safePath(path, { directory = false, missing = false, privateMode = false } = {}) {
  path = cleanPath(path);
  for (let p = dirname(path); ; p = dirname(p)) {
    const s = await lstat(p);
    if (!s.isDirectory() || s.isSymbolicLink()) fail();
    if (dirname(p) === p) break;
  }
  let s;
  try { s = await lstat(path); } catch (error) { if (missing && error.code === 'ENOENT') return undefined; throw error; }
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) || s.uid !== uid) fail();
  if (privateMode && (s.mode & 0o077) !== 0 || !directory && s.size > MAX_BYTES) fail();
  if (await realpath(path) !== path) fail();
  return s;
}
export async function readPrivate(path, { optional = false, privateMode = true } = {}) {
  const before = await safePath(path, { missing: optional, privateMode });
  if (!before) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== uid || s.size > MAX_BYTES || s.ino !== before.ino || s.dev !== before.dev || privateMode && (s.mode & 0o077) !== 0) fail();
    const buffer = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) fail();
    const after = await file.stat(), current = await lstat(path);
    if (after.size !== s.size || after.mtimeMs !== s.mtimeMs || current.ino !== s.ino || current.dev !== s.dev || after.nlink !== 1) fail();
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}
export async function atomicWrite(path, bytes, mode = 0o600) {
  if (bytes.length > MAX_BYTES) fail();
  await safePath(path, { missing: true });
  const temp = join(dirname(path), `.pa-observer-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
    await file.writeFile(bytes); await file.chmod(mode); await file.sync(); await file.close(); file = undefined;
    await safePath(path, { missing: true });
    await rename(temp, path);
  } finally { await file?.close(); await unlink(temp).catch(() => {}); }
}

export async function validateConfig(value, { allowMissingRoot = false } = {}) {
  keys(value, ['version', 'enabled', 'sourceId', 'exportRoot', 'sources', 'fields', 'referencePaths']);
  if (value.version !== 1 || typeof value.enabled !== 'boolean' || !id(value.sourceId)) fail();
  cleanPath(value.exportRoot);
  if (value.exportRoot === parse(value.exportRoot).root) fail();
  await safePath(value.exportRoot, { directory: true, missing: allowMissingRoot, privateMode: true });
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 32) fail();
  for (const source of value.sources) {
    keys(source, ['cwd', 'sessionIds']);
    await safePath(source.cwd, { directory: true });
    if (!Array.isArray(source.sessionIds) || !source.sessionIds.length || source.sessionIds.length > 128 || source.sessionIds.some(s => s !== '*' && !id(s)) || source.sessionIds.includes('*') && source.sessionIds.length !== 1) fail();
  }
  if (new Set(value.sources.map(s => s.cwd)).size !== value.sources.length) fail();
  if (!Array.isArray(value.fields) || !value.fields.includes('runtime') || new Set(value.fields).size !== value.fields.length || value.fields.some(s => !['runtime', 'subject', 'result'].includes(s))) fail();
  if (value.referencePaths !== undefined && (!Array.isArray(value.referencePaths) || value.referencePaths.length > 32)) fail();
  // References are exact, operator-selected paths, NOT read grants. Never open their bytes.
  for (const path of value.referencePaths ?? []) cleanPath(path);
  return value;
}
export function recordName(record) {
  return `${record.kind}-${digest(JSON.stringify([record.sourceId, record.sessionId, record.instanceId, record.executionId]))}.json`;
}
function permitted(config, snapshot) {
  return config.enabled && config.sources.some(s => s.cwd === snapshot.cwd && (s.sessionIds.includes('*') || s.sessionIds.includes(snapshot.sessionId)));
}
function snapshot(ctx) {
  const sm = ctx.sessionManager;
  return { cwd: ctx.cwd, sessionId: sm.getSessionId(), leafId: sm.getLeafId(), sm };
}
function userEntry(snap) {
  let entryId = snap.leafId;
  // Metadata only, from the already-loaded SessionManager. No getEntries/getBranch/log reads.
  for (let n = 0; entryId && n < 512; n++) {
    const entry = snap.sm.getEntry(entryId);
    if (!entry) break;
    if (entry.type === 'message' && entry.message.role === 'user') return entry.id;
    entryId = entry.parentId;
  }
  return null;
}
const safeText = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || value.includes('\0') || /-----BEGIN .*PRIVATE KEY-----|\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|password|access[_-]?token)\s*[:=])/i.test(value)) fail();
  return value;
};
function publication(value, config, executionId) {
  keys(value, ['executionId', 'subject', 'result']);
  if (value.executionId !== executionId || !executionId || !value.subject && !value.result) fail();
  const result = {};
  if (value.subject !== undefined) {
    if (!config.fields.includes('subject')) fail();
    keys(value.subject, ['title', 'goal']);
    result.subject = { title: safeText(value.subject.title, 256), goal: safeText(value.subject.goal, 4096) };
  }
  if (value.result !== undefined) {
    if (!config.fields.includes('result')) fail();
    keys(value.result, ['summary', 'refs']);
    if (!Array.isArray(value.result.refs) || value.result.refs.length > 16) fail();
    result.result = { summary: safeText(value.result.summary, 4096), refs: value.result.refs.map(ref => {
      keys(ref, ['path', 'sha256']); cleanPath(ref.path);
      if (!config.referencePaths?.includes(ref.path) || !/^[a-f0-9]{64}$/.test(ref.sha256)) fail();
      return { path: ref.path, sha256: ref.sha256 };
    }) };
  }
  return result;
}

export default function observer(pi, options = {}) {
  pi.registerFlag('pa-observer-config', { description: 'Explicit private PA observer grant file; absent means disconnected', type: 'string' });
  let config, configBytes, configPath, timer, session, execution, instanceId, lastOutcome, rootStamp, cwdStamp;
  let stopped = false, pending = 0, chain = Promise.resolve(), warning = false, ready = false, closing = false, shutdownPromise;
  let running = false, waiting = false, linkInput = false, previousState = 'unknown', recordCount = 0;
  let latestContext;
  const records = new Map(), nodeExecutions = new Map();
  const rememberNode = nodeId => {
    if (!execution || !running || !id(nodeId)) return;
    // Only IDs observed during this exact activity; never infer from user ancestors.
    // Conflicting evidence stays unknown. Evicted entries are unknown too.
    const previous = nodeExecutions.get(nodeId);
    nodeExecutions.set(nodeId, previous === undefined || previous === execution ? execution : null);
    if (nodeExecutions.size > MAX_NODES) nodeExecutions.delete(nodeExecutions.keys().next().value);
  };
  const warn = () => {
    if (warning) return; warning = true;
    try { latestContext?.ui.notify('PA 观察导出未核实/已停用；原 Pi 工作不受影响。', 'warning'); } catch { /* no UI in print mode */ }
  };
  const stopLease = () => { clearInterval(timer); timer = undefined; };
  const enqueue = work => {
    if (pending >= MAX_PENDING) { stopped = true; stopLease(); warn(); return; }
    pending++;
    chain = chain.then(work).catch(() => { stopped = true; stopLease(); warn(); }).finally(() => { pending--; });
  };
  const record = (kind, snap, executionId = null, state = 'unknown') => ({
    version: 1, kind, sourceId: config.sourceId, sessionId: snap.sessionId, instanceId,
    executionId, revision: 0, observedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), cwd: snap.cwd, state,
  });
  const check = async () => {
    if (stopped || !config) return false;
    // Any scope edit (including revocation/disable) invalidates this instance. Reload explicitly.
    const current = await readPrivate(configPath);
    if (!current?.equals(configBytes)) { stopped = true; stopLease(); warn(); return false; }
    const root = await safePath(config.exportRoot, { directory: true, privateMode: true });
    const cwd = await safePath(session.cwd, { directory: true });
    if (root.ino !== rootStamp.ino || root.dev !== rootStamp.dev || cwd.ino !== cwdStamp.ino || cwd.dev !== cwdStamp.dev) fail();
    return !stopped;
  };
  const save = async (items, heartbeat = false) => {
    if (!await check()) return;
    const now = new Date().toISOString();
    for (const item of items.filter(Boolean)) {
      if (stopped) return;
      if (heartbeat) item.heartbeatAt = now; else item.observedAt = item.heartbeatAt = now;
      const name = recordName(item);
      if (!records.has(name)) {
        if (recordCount >= MAX_RECORDS) { stopped = true; stopLease(); warn(); return; }
        recordCount++;
      }
      const previous = records.get(name);
      item.revision = Math.max(item.revision, previous?.revision ?? 0) + 1;
      records.set(name, item);
      // Only own instance filenames; never read or rewrite another instance's record.
      await atomicWrite(join(config.exportRoot, name), Buffer.from(JSON.stringify(item) + '\n'));
    }
  };
  const state = value => { session.state = waiting ? 'waiting' : value; if (execution) execution.state = session.state; };
  const handle = (name, ctx, work) => {
    if (closing && name !== 'shutdown') return;
    latestContext = ctx;
    let snap;
    try { snap = snapshot(ctx); } catch { warn(); return; }
    enqueue(async () => {
      if (!ready || !await check() || !permitted(config, snap) || session.sessionId !== snap.sessionId) return;
      await work(snap);
    });
  };
  pi.on('session_start', (event, ctx) => {
    latestContext = ctx;
    let snap, path;
    try { snap = snapshot(ctx); path = options.configPath ?? pi.getFlag('pa-observer-config'); } catch { warn(); return; }
    const reason = event.reason;
    enqueue(async () => {
      if (typeof path !== 'string' || !path) return;
      configPath = path; configBytes = await readPrivate(path);
      config = await validateConfig(decodeJson(configBytes));
      if (!permitted(config, snap) || !id(snap.sessionId)) return;
      rootStamp = await safePath(config.exportRoot, { directory: true, privateMode: true });
      cwdStamp = await safePath(snap.cwd, { directory: true });
      if (stopped) return; // Do not revive an initialization that exceeded shutdown's deadline.
      instanceId = randomUUID(); ready = true;
      const origin = userEntry(snap);
      // Startup/reload/resume of an existing run has no evidence of its previous settlement.
      session = record('session', snap, null, origin || ['reload', 'resume', 'fork'].includes(reason) ? 'unknown' : 'idle');
      // Do not guess a resumed activity from the last user entry: it may be steering or
      // an automatic follow-up. Old execution snapshots remain intact under their identities.
      execution = undefined;
      await save([session]);
      if (!stopped && !closing) { timer = setInterval(() => enqueue(() => save([session, execution], true)), HEARTBEAT_MS); timer.unref(); }
    });
  });
  pi.on('before_agent_start', (event, ctx) => {
    const isUser = event.messageType === 'user';
    handle('input-kind', ctx, async () => { if (!running) linkInput = isUser; });
  });
  pi.on('agent_start', (_event, ctx) => handle('start', ctx, async () => {
    if (!running) { execution = undefined; lastOutcome = undefined; running = true; }
    state('running'); await save([session, execution]);
  }));
  // turn_start precedes persistence of the starting user message in Pi 1.3.0.
  // context is after persistence, even before a slow/failed provider responds.
  // The event's messages are deliberately NEVER read, transformed, or returned.
  pi.on('context', (_event, ctx) => handle('turn', ctx, async snap => {
    if (!execution) {
      const origin = linkInput ? userEntry(snap) : null;
      execution = record('execution', snap, origin ? `input-${origin}` : `unlinked-${randomUUID()}`, origin ? 'running' : 'unknown');
      rememberNode(origin);
    }
    // This finalized context leaf, including automatic follow-up inputs, belongs to
    // the still-active execution. No message text or ancestor-based navigation lookup.
    rememberNode(snap.leafId);
    await save([session, execution]);
  }));
  pi.on('turn_end', (event, ctx) => {
    // Pi persists these assistant/tool-result entry IDs before dispatching turn_end.
    const nodes = [event.messageEntryId, ...event.toolResultEntryIds.slice(0, MAX_NODES - 1)];
    handle('nodes', ctx, async () => { for (const nodeId of nodes) rememberNode(nodeId); });
  });
  pi.on('ui_prompt_start', (_event, ctx) => handle('waiting', ctx, async () => {
    if (!waiting) previousState = session.state;
    waiting = true; state('waiting'); await save([session, execution]);
  }));
  pi.on('ui_prompt_end', (_event, ctx) => handle('resume', ctx, async () => {
    waiting = false; state(previousState); await save([session, execution]);
  }));
  // No agent_end handler: it is NOT a completion boundary and exposes whole messages.
  pi.on('agent_before_settle', (event, ctx) => {
    const outcome = event.outcome;
    handle('outcome', ctx, async () => { lastOutcome = ['completed', 'aborted', 'error'].includes(outcome) ? outcome : undefined; });
  });
  pi.on('agent_settled', (event, ctx) => handle('settled', ctx, async () => {
    running = false; waiting = false; state('settled');
    if (execution) execution.outcome = event.aborted ? 'aborted' : lastOutcome;
    await save([session, execution]);
  }));
  pi.on('session_tree', (_event, ctx) => handle('tree', ctx, async snap => {
    running = false; waiting = false; session.state = 'unknown';
    // Exact observed node -> execution evidence only. A custom or continuation
    // assistant may have an unrelated user ancestor; never walk past that boundary.
    execution = nodeExecutions.get(snap.leafId) ?? undefined;
    if (execution) { execution.state = 'unknown'; delete execution.outcome; }
    await save([session, execution]);
  }));
  pi.on('session_shutdown', (_event, ctx) => {
    if (shutdownPromise) return shutdownPromise;
    closing = true; stopLease();
    handle('shutdown', ctx, async () => {
      stopLease(); waiting = false; session.state = 'closed';
      // A quit/switch while active is not proof of execution success or failure.
      if (execution && running) { execution.state = 'unknown'; delete execution.outcome; }
      await save([session, execution]); ready = false; stopped = true;
    });
    let deadline;
    // Unlike normal observations, Pi MUST await this bounded drain before its
    // TUI can call process.exit. The deadline is ref'd so it also works without UI.
    shutdownPromise = Promise.race([
      chain.then(() => true),
      new Promise(accept => { deadline = setTimeout(() => accept(false), SHUTDOWN_MS); }),
    ]).then(drained => {
      if (!drained) { stopped = true; ready = false; stopLease(); warn(); }
    }).finally(() => clearTimeout(deadline));
    return shutdownPromise;
  });
  pi.registerCommand('pa-observer-status', { description: 'Show observation identity only; never queries history', handler: async (_args, ctx) => {
    await Promise.race([chain, new Promise(accept => { const deadline = setTimeout(accept, 250); deadline.unref(); })]);
    ctx.ui.notify(ready && !stopped ? `PA 运行观察：${session.sessionId} / ${instanceId} / ${execution?.executionId ?? '无当前回合'}；业务完成未知。` : 'PA 观察未接通/已停用；不代表没有工作。', 'info');
  } });
  pi.registerCommand('pa-observer-off', { description: 'Stop this exporter only, never stop Pi', handler: async (_args, ctx) => {
    stopLease();
    handle('off', ctx, async () => { stopLease(); waiting = false; state('unknown'); await save([session, execution]); stopped = true; });
  } });
  pi.registerCommand('pa-observer-publish', { description: 'Explicit bounded JSON subject/result for the named current execution; requires separate field grants', handler: async (args, ctx) => {
    if (Buffer.byteLength(args) > MAX_BYTES) { warn(); return; }
    handle('publish', ctx, async () => {
      try {
        const data = publication(JSON.parse(args), config, execution?.executionId);
        Object.assign(execution, data); await save([execution]);
      } catch { warn(); } // A rejected publication must not kill observation or the original task.
    });
  } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('可选 Pi 只读观察扩展，不是独立服务。用原 Pi 入口追加 -e <本文件> --pa-observer-config <明确私有授权JSON>；无授权文件默认未接通。准备/停用/恢复用 prepare-pi-observer.mjs --help；本命令不加载扩展、不读取会话。');
}
