import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { canonical, inside, jsonFile, localUrl, parseUrl } from './util.js';
import type { Config } from './types.js';

export async function loadConfig(path: string): Promise<Config> {
  const raw = await jsonFile<Partial<Config>>(path);
  const home = homedir();
  const c: Config = {
    dataDir: `${home}/.personal-agent-v2`, attachmentDir: `${home}/.personal-agent-附件`, inboxDirs: [], projects: [], readAllow: [], readDeny: [],
    configPath: resolve(path), windowTokens: 100000, checkpointKeep: 8, maxToolRounds: 30,
    ...raw,
    model: { url: 'https://opencode.ai/inference/go/openai/v1', name: 'deepseek-v4.1-flash', timeoutMs: 60000, maxOutputTokens: 8192, dailyTokenLimit: 0, headers: {}, ...raw.model,
      auth: { type: 'pi', path: `${home}/.pi/agent/auth.json`, provider: 'opencode-go', variable: 'PA_MODEL_KEY', ...raw.model?.auth } },
    feishu: { mode: 'fake', userId: '', url: '', envFile: '', pollMs: 1000, timeoutMs: 10000, ...raw.feishu },
    loop: { command: '', args: [], eventDirs: [], timeoutMs: 15000, actionTimeoutMs: 300000, ...raw.loop },
    pi: { command: 'pi', args: [], timeoutMs: 1200000, pollMs: 1000, startupMs: 10000, maxTurns: 30, ...raw.pi },
    queue: { busyMs: 10000, inputTimeoutMs: 300000, stopMs: 30000, ...raw.queue },
    intake: { watch: true, fallbackMs: 60000, maxFileBytes: 20 * 1024 * 1024, ...raw.intake },
    concurrency: { router: 1, read: 3, skill: 1, writePerDirectory: 1, ...raw.concurrency },
    approval: { readPi: true, send: true, dispatch: true, stop: true, ...raw.approval, redLine: true },
    watchdog: { pollMs: 10000, heartbeatMs: 60000, heartbeatStaleMs: 120000, inputStaleMs: 300000, modelFailures: 3, feishuStaleMs: 300000, minDiskBytes: 1024 ** 3, ...raw.watchdog,
      local: { mode: 'native', url: '', ...raw.watchdog?.local } },
  };
  const paths = [c.dataDir, c.attachmentDir, ...c.inboxDirs, ...c.readAllow, ...c.readDeny, ...c.loop.eventDirs,
    ...c.projects.flatMap(p => [p.root, ...p.loopRunDirs, ...(p.loop ? [p.loop.batchDir, p.loop.workspace] : [])]), c.model.auth.path, c.feishu.envFile].filter(Boolean);
  if (paths.some(p => !isAbsolute(p) || p.includes('\0'))) throw new Error('配置中的目录必须使用绝对路径');
  if (!c.feishu.userId || !['fake', 'real'].includes(c.feishu.mode)) throw new Error('必须配置本人飞书 ID 和渠道模式');
  if (c.feishu.mode === 'fake' && !localUrl(c.feishu.url)) throw new Error('假飞书只允许本地 HTTP 地址');
  if (c.watchdog.local.mode === 'fake' && !localUrl(c.watchdog.local.url)) throw new Error('通知替身只允许本地 HTTP 地址');
  if (!['pi', 'env', 'none'].includes(c.model.auth.type)) throw new Error('模型凭证来源不支持');
  if (c.model.auth.type === 'none' && !localUrl(c.model.url)) throw new Error('无凭证模式只允许本地模型替身');
  const modelUrl = parseUrl(c.model.url);
  if (modelUrl.username || modelUrl.password) throw new Error('模型地址不能包含凭证');
  const numbers = [c.windowTokens, c.checkpointKeep, c.maxToolRounds, ...Object.values(c.queue), ...Object.values(c.intake).filter((x): x is number => typeof x === 'number'),
    ...Object.values(c.concurrency), c.model.timeoutMs, c.model.maxOutputTokens, c.feishu.pollMs, c.feishu.timeoutMs, c.loop.timeoutMs, c.loop.actionTimeoutMs,
    c.pi.timeoutMs, c.pi.pollMs, c.pi.startupMs, c.pi.maxTurns,
    ...Object.values(c.watchdog).filter((x): x is number => typeof x === 'number')];
  if (numbers.some(n => !Number.isSafeInteger(n) || n <= 0) || c.windowTokens < 32 || c.queue.stopMs > 30000 || c.concurrency.router !== 1) throw new Error('时限/上限须为正整数；Router 并发固定 1，停止最长 30 秒');
  if (!Number.isSafeInteger(c.model.dailyTokenLimit) || c.model.dailyTokenLimit < 0) throw new Error('每日模型用量上限不合法');
  c.dataDir = await canonical(c.dataDir); c.attachmentDir = await canonical(c.attachmentDir);
  c.projects = await Promise.all(c.projects.map(async p => {
    const project = { ...p, root: await canonical(p.root), loopRunDirs: await Promise.all(p.loopRunDirs.map(canonical)) };
    if (p.loop) {
      project.loop = { ...p.loop, batchDir: await canonical(p.loop.batchDir), workspace: await canonical(p.loop.workspace) };
      if (!inside(project.root, project.loop.batchDir) || project.root === project.loop.batchDir || inside(project.root, project.loop.workspace) || inside(project.loop.workspace, project.root)) throw new Error('Loop 批次目录须在项目内，开发空间须独立');
      if (!p.loop.workspaceName || !p.loop.allow?.length || !Array.isArray(p.loop.deny) || [...p.loop.allow, ...p.loop.deny].some(x => typeof x !== 'string' || !x || isAbsolute(x) || x.split(/[\\/]/).includes('..')) || p.loop.allow.some(x => !/^code(?:\/|$)/.test(x))) throw new Error('Loop scope 必须由配置限定在 code/，不能含越界路径');
    }
    if (p.pi) {
      if (!Array.isArray(p.pi.writeDirs) || !p.pi.skills || typeof p.pi.skills !== 'object' || [...p.pi.writeDirs, ...Object.values(p.pi.skills)].some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('Pi 写目录和技能路径须由配置明确指定绝对路径');
      project.pi = { writeDirs: await Promise.all(p.pi.writeDirs.map(canonical)), skills: Object.fromEntries(await Promise.all(Object.entries(p.pi.skills).map(async ([key, path]) => [key, await canonical(path)]))) };
      if (project.pi.writeDirs.some(path => !inside(project.root, path) || path === project.root) || Object.values(project.pi.skills).some(path => !inside(project.root, path))) throw new Error('Pi 写目录和技能只能位于授权项目内');
    }
    return project;
  }));
  if (new Set(c.projects.map(p => p.id)).size !== c.projects.length || new Set(c.projects.map(p => p.root)).size !== c.projects.length) throw new Error('授权项目身份不能重复');
  for (const value of Object.values(c.approval)) if (typeof value !== 'boolean') throw new Error('点头开关须为布尔值');
  c.inboxDirs = await Promise.all(c.inboxDirs.map(canonical));
  c.loop.eventDirs = await Promise.all(c.loop.eventDirs.map(canonical));
  if (!c.pi.command || !Array.isArray(c.pi.args) || c.pi.args.some(a => typeof a !== 'string')) throw new Error('Pi 命令配置无效');
  if (c.pi.model && (!c.pi.model.name || c.model.auth.type === 'none' && !localUrl(c.pi.model.url))) throw new Error('无凭证 Pi 只允许本地模型替身');
  const configReal = await canonical(c.configPath);
  if (inside(c.dataDir, c.attachmentDir) || inside(c.attachmentDir, c.dataDir)) throw new Error('附件目录必须独立于数据目录');
  const incoming = await Promise.all([...c.inboxDirs, ...c.loop.eventDirs].map(canonical));
  if (incoming.some(p => inside(p, c.dataDir) || inside(c.dataDir, p) || inside(p, c.attachmentDir) || inside(c.attachmentDir, p))) throw new Error('来源目录不能与数据/附件目录重叠');
  if (inside(c.dataDir, configReal)) throw new Error('配置文件须在数据目录之外（PA 不写配置）');
  return c;
}
