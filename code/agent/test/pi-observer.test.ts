import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rename, symlink, link, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scriptModel, type Script } from '../src/stubs/servers.js';

const exec = promisify(execFile), delay = (ms: number) => new Promise<void>(accept => setTimeout(accept, ms));
const observerPath = resolve('scripts/pi-observer.mjs'), preparePath = resolve('scripts/prepare-pi-observer.mjs');
const dynamicImport = (path: string): Promise<any> => import(pathToFileURL(path).href);
async function until(check: () => unknown | Promise<unknown>, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(20); }
  assert.fail('bounded observer condition timed out');
}
async function sdkLocation() {
  const cli = await realpath((await exec('which', ['pi'])).stdout.trim());
  const root = resolve(dirname(cli), '../..');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@earendil-works/pi-coding-agent');
  return { root, cli, version: pkg.version };
}
async function fixture(t: TestContext, options: { script?: Script; fields?: string[]; sources?: any[]; sessionIds?: string[]; enabled?: boolean; keep?: boolean; extensions?: (pi: any) => void; load?: boolean } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pa-observer-')));
  const cwd = join(dir, 'work'), agentDir = join(dir, 'agent'), exportRoot = join(dir, 'export'), sessions = join(dir, 'sessions');
  for (const path of [cwd, agentDir, exportRoot, sessions]) await mkdir(path, { mode: 0o700 });
  const configPath = join(dir, 'observer.json'), loaderPath = join(dir, 'observer-loader.mjs');
  const config = { version: 1, enabled: options.enabled ?? true, sourceId: 'synthetic-pi', exportRoot,
    sources: options.sources ?? [{ cwd, sessionIds: options.sessionIds ?? ['*'] }], fields: options.fields ?? ['runtime'], referencePaths: [join(cwd, 'result.txt')] };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(loaderPath, `import observer from ${JSON.stringify(pathToFileURL(observerPath).href)}; export default pi => observer(pi, {configPath:${JSON.stringify(configPath)}});`, { mode: 0o600 });
  const location = await sdkLocation(), sdk = await dynamicImport(join(location.root, 'dist/index.js'));
  const model = await scriptModel(options.script ?? { flow: [{ text: 'SYNTHETIC_RESULT_NOT_EXPORTED' }] });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'absent-auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'model-cache.json'), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('observer-fixture', { baseUrl: `${model.url}/v1`, api: 'openai-completions', apiKey: 'SYNTHETIC_NOT_A_CREDENTIAL',
    models: [{ id: 'local', name: 'local', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] });
  const notices: string[] = [], events: string[] = [], errors: any[] = [];
  let confirm = async () => true;
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultTools: ['read', 'bash', 'edit', 'write'] });
  settingsManager.setExtensionPaths(options.load !== false ? [loaderPath] : []);
  const factory = async ({ cwd: targetCwd, sessionManager, sessionStartEvent }: any) => {
    const services = await sdk.createAgentSessionServices({ cwd: targetCwd, agentDir, settingsManager, modelRuntime,
      resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: 'Synthetic local fixture. No accounts.',
        extensionFactories: [options.extensions ?? (() => {})] } });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    return { ...await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: modelRuntime.getModel('observer-fixture', 'local'), thinkingLevel: 'off' }), services, diagnostics: services.diagnostics };
  };
  const runtime = await sdk.createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: sdk.SessionManager.create(cwd, sessions) });
  const bind = async () => {
    const s = runtime.session;
    await s.bindExtensions({ mode: 'rpc', onError: (error: any) => errors.push(error), uiContext: {
      notify: (text: string) => notices.push(text), confirm: (..._args: any[]) => confirm(), select: async () => undefined, input: async () => undefined,
      editor: async () => undefined, custom: async () => undefined, setStatus: () => {}, setWidget: () => {}, setTitle: () => {},
      setEditorText: () => {}, getEditorText: () => '', getToolsExpanded: () => false, setToolsExpanded: () => {},
    } });
    s.subscribe((event: any) => events.push(event.type));
  };
  runtime.setRebindSession(bind); await bind();
  const records = async (): Promise<any[]> => {
    const names = await readdir(exportRoot).catch(() => [] as string[]);
    return Promise.all(names.filter(n => /^(session|execution)-[a-f0-9]{64}\.json$/.test(n)).map(async n => JSON.parse(await readFile(join(exportRoot, n), 'utf8'))));
  };
  t.after(async () => { await runtime.dispose(); await model.close(); await delay(80); if (!options.keep) await rm(dir, { recursive: true, force: true }); });
  return { dir, cwd, agentDir, exportRoot, sessions, configPath, loaderPath, config, sdk, runtime, model, modelRuntime, settingsManager, records, notices, events, errors, location,
    setConfirm(fn: () => Promise<boolean>) { confirm = fn; }, setLoad(value: boolean) { settingsManager.setExtensionPaths(value ? [loaderPath] : []); },
    sessionRecord: async () => (await records()).find(r => r.kind === 'session' && r.sessionId === runtime.session.sessionId && r.state !== 'closed'),
  };
}

test('A4 native SDK: startup, actual UI wait, agent_end continuation, settlement, independent rounds, reload/resume/fork/quit', async t => {
  let endReached = false, releaseEnd!: () => void, continued = false;
  const endGate = new Promise<void>(accept => { releaseEnd = accept; });
  const f = await fixture(t, { keep: process.env.PA_OBSERVER_KEEP_FIXTURE === '1', script: { flow: [
    { tools: [{ name: 'fixture_wait', arguments: {} }] }, { text: 'SYNTHETIC_END_ONE' }, { text: 'SYNTHETIC_CONTINUATION' }, { text: 'SYNTHETIC_SECOND_WORK' },
  ] }, extensions: pi => {
    pi.registerTool({ name: 'fixture_wait', label: 'wait', description: 'synthetic interaction', parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: async (_id: any, _args: any, _signal: any, _update: any, ctx: any) => ({ content: [{ type: 'text', text: String(await ctx.ui.confirm('PRIVATE_PROMPT_TITLE', 'PRIVATE_PROMPT_BODY')) }], details: undefined }) });
    pi.on('agent_end', async () => { if (!continued) { continued = true; pi.sendUserMessage('SYNTHETIC_AUTOMATIC_CONTINUATION', { deliverAs: 'followUp' }); endReached = true; await endGate; } });
  } });
  let releaseUI!: (value: boolean) => void;
  f.setConfirm(() => new Promise<boolean>(accept => { releaseUI = accept; }));
  await until(async () => (await f.sessionRecord())?.state === 'idle');
  const originalId = f.runtime.session.sessionId, originalFile = f.runtime.session.sessionFile;
  const tools = f.runtime.session.getActiveToolNames().slice().sort(), model = f.runtime.session.model;
  const configBefore = await readFile(f.configPath);
  const prompt = f.runtime.session.prompt('SYNTHETIC_RAW_INPUT_NEVER_EXPORT');
  t.after(() => { releaseUI?.(true); releaseEnd(); });
  await until(async () => (await f.sessionRecord())?.state === 'waiting' && (await f.records()).some(r => r.kind === 'execution' && r.state === 'waiting'));
  let executions = (await f.records()).filter(r => r.kind === 'execution');
  assert.equal(executions.length, 1); assert.match(executions[0].executionId, /^input-/);
  assert.equal(executions[0].state, 'waiting'); const executionId = executions[0].executionId;
  releaseUI(true); await until(() => endReached);
  await until(async () => (await f.sessionRecord())?.state === 'running');
  assert.equal((await f.records()).some(r => r.state === 'settled' || r.outcome === 'completed'), false, 'agent_end cannot claim settlement');
  releaseEnd(); await prompt;
  await until(async () => (await f.sessionRecord())?.state === 'settled' && (await f.records()).some(r => r.kind === 'execution' && r.outcome === 'completed'));
  executions = (await f.records()).filter(r => r.kind === 'execution');
  assert.equal(executions.length, 1, 'automatic continuation is not a new business task');
  assert.equal(executions[0].executionId, executionId); assert.equal(executions[0].outcome, 'completed');
  assert.equal(executions[0].subject, undefined); assert.equal(executions[0].result, undefined);
  const first = structuredClone(executions[0]);
  await f.runtime.session.prompt('UNRELATED_SECOND_WORK');
  await until(async () => (await f.records()).filter(r => r.kind === 'execution').length === 2);
  assert.deepEqual((await f.records()).find(r => r.executionId === first.executionId), first, 'sibling execution is not overwritten');
  assert.deepEqual(f.runtime.session.getActiveToolNames().slice().sort(), tools); assert.equal(f.runtime.session.model, model);
  assert.deepEqual(await readFile(f.configPath), configBefore);
  const text = JSON.stringify(await f.records());
  for (const forbidden of ['SYNTHETIC_RAW_INPUT', 'PRIVATE_PROMPT', 'SYNTHETIC_RESULT', 'SYNTHETIC_END', 'SYNTHETIC_AUTOMATIC', 'reasoning', 'toolResult']) assert.equal(text.includes(forbidden), false);
  const beforeReload = (await f.sessionRecord()).instanceId;
  // Official idle reload recreates the extension, not the session or the work.
  await f.runtime.session.reload();
  await until(async () => (await f.records()).some(r => r.kind === 'session' && r.sessionId === originalId && r.instanceId !== beforeReload && r.state === 'unknown'));
  assert.equal(f.runtime.session.sessionId, originalId); assert.equal(f.runtime.session.sessionFile, originalFile);
  assert.ok((await f.records()).some(r => r.kind === 'session' && r.instanceId === beforeReload && r.state === 'closed'));
  await f.runtime.newSession();
  const secondId = f.runtime.session.sessionId; assert.notEqual(secondId, originalId);
  await until(async () => (await f.sessionRecord())?.state === 'idle');
  await f.runtime.switchSession(originalFile);
  assert.equal(f.runtime.session.sessionId, originalId);
  await until(async () => (await f.records()).filter(r => r.kind === 'session' && r.sessionId === originalId).length === 3);
  const user = f.runtime.session.sessionManager.getBranch().find((entry: any) => entry.type === 'message' && entry.message.role === 'user');
  await f.runtime.fork(user.id, { position: 'at' });
  assert.notEqual(f.runtime.session.sessionId, originalId);
  await until(async () => (await f.sessionRecord())?.state === 'unknown');
  const forkId = f.runtime.session.sessionId;
  assert.equal((await f.sessionRecord()).subject, undefined, 'no title-based parent/task inference');
  await f.runtime.dispose();
  await until(async () => (await f.records()).some(r => r.kind === 'session' && r.sessionId === forkId && r.state === 'closed'));
  assert.deepEqual(f.errors, []); t.diagnostic(`installed package ${f.location.version}; actual SDK events, rpc UI binding, no real credentials`);
  if (process.env.PA_OBSERVER_KEEP_FIXTURE === '1') t.diagnostic(`A7 actual producer evidence: ${JSON.stringify({ root: f.dir, exportRoot: f.exportRoot, config: f.configPath, sourceId: f.config.sourceId, cwd: f.cwd })}`);
});

test('A4 explicit content publication: field grants and exact execution/ref versions, never automatic transcript extraction', async t => {
  const f = await fixture(t, { fields: ['runtime', 'subject', 'result'] });
  await f.runtime.session.prompt('INPUT_WITHOUT_EXPORT_PERMISSION');
  await until(async () => (await f.records()).some(r => r.kind === 'execution' && r.state === 'settled'));
  const execution = (await f.records()).find(r => r.kind === 'execution');
  const good = { executionId: execution.executionId, subject: { title: '构造目标', goal: '只发布此目标' }, result: { summary: '来源报告，业务未验', refs: [{ path: join(f.cwd, 'result.txt'), sha256: 'a'.repeat(64) }] } };
  await f.runtime.session.prompt(`/pa-observer-publish ${JSON.stringify(good)}`);
  await until(async () => (await f.records()).some(r => r.result?.summary === good.result.summary));
  const published = (await f.records()).find(r => r.kind === 'execution');
  const bad = [
    { ...good, executionId: 'wrong-round' }, { ...good, transcript: 'NO_TRANSCRIPT' },
    { ...good, result: { summary: 'NO_OUTSIDE_REF', refs: [{ path: join(f.dir, 'outside.txt'), sha256: 'a'.repeat(64) }] } },
    { ...good, result: { summary: 'NO_SECRET_REF', refs: [{ path: join(f.cwd, '.env'), sha256: 'a'.repeat(64) }] } },
    { ...good, subject: { title: 'password=NEVER_EXPORT', goal: 'NO_SECRET' } }, { ...good, subject: { title: 'x'.repeat(257), goal: 'NO_TOO_BIG' } },
    { ...good, result: { summary: 'NO_BAD_HASH', refs: [{ path: join(f.cwd, 'result.txt'), sha256: 'not-a-hash' }] } },
  ];
  for (const value of bad) await f.runtime.session.prompt(`/pa-observer-publish ${JSON.stringify(value)}`);
  await f.runtime.session.prompt('/pa-observer-status');
  assert.deepEqual((await f.records()).find(r => r.kind === 'execution'), published);
  assert.equal(JSON.stringify(await f.records()).includes('INPUT_WITHOUT_EXPORT_PERMISSION'), false);
  assert.equal(JSON.stringify(await f.records()).includes('NO_'), false);
  // The reference need not exist: producer reports an explicitly selected version, consumer rechecks it.
  await assert.rejects(stat(join(f.cwd, 'result.txt')), { code: 'ENOENT' });
});

test('A4 unapproved source/fields, disconnected old sessions and export failure do not block original Pi work', async t => {
  const denied = await fixture(t, { sessionIds: ['not-this-session'] });
  // A valid grant for another session does not authorize this one.
  await denied.runtime.session.prompt('UNA​​UTHORIZED_SOURCE_CONTENT');
  assert.deepEqual(await denied.records(), []); assert.ok(denied.runtime.session.getLastAssistantText());
  const f = await fixture(t);
  await f.runtime.session.prompt('NORMAL_WORK');
  await until(async () => (await f.records()).some(r => r.kind === 'execution' && r.state === 'settled'));
  const execution = (await f.records()).find(r => r.kind === 'execution');
  await f.runtime.session.prompt(`/pa-observer-publish ${JSON.stringify({ executionId: execution.executionId, subject: { title: 'NOT_GRANTED', goal: 'MUST_NOT_EXPORT' } })}`);
  await f.runtime.session.prompt('/pa-observer-status');
  assert.equal(JSON.stringify(await f.records()).includes('NOT_GRANTED'), false);
  // A genuine export-root link substitution must not write through it or alter the model/run.
  const outside = join(f.dir, 'outside'); await mkdir(outside, { mode: 0o700 });
  await rename(f.exportRoot, join(f.dir, 'retired-export')); await symlink(outside, f.exportRoot);
  await f.runtime.session.prompt('WORK_CONTINUES_WITH_BROKEN_EXPORT');
  await f.runtime.session.prompt('/pa-observer-status');
  assert.deepEqual(await readdir(outside), []); assert.equal(f.runtime.session.isStreaming, false);
  assert.ok(f.runtime.session.getLastAssistantText()); assert.deepEqual(f.errors, []);
  const old = await fixture(t, { load: false });
  await old.runtime.session.prompt('OLD_SESSION_WITHOUT_OBSERVER');
  assert.deepEqual(await old.records(), []);
  // Only load while idle, then verify the same session ID; no replay/re-dispatch of old work.
  const oldId = old.runtime.session.sessionId, requests = old.model.requests.length;
  old.setLoad(true); await old.runtime.session.reload();
  await until(async () => (await old.sessionRecord())?.state === 'unknown');
  assert.equal(old.runtime.session.sessionId, oldId); assert.equal(old.model.requests.length, requests);
  assert.equal(JSON.stringify(await old.records()).includes('OLD_SESSION_WITHOUT_OBSERVER'), false);
});

test('A4 real 30s lease refresh is bounded; observer-off and grant revocation leave Pi alive', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  await until(async () => (await f.sessionRecord())?.state === 'idle');
  const first = await f.sessionRecord();
  await until(async () => (await f.sessionRecord())?.revision > first.revision, 33000);
  const second = await f.sessionRecord();
  assert.equal(second.observedAt, first.observedAt); assert.ok(Date.parse(second.heartbeatAt) > Date.parse(first.heartbeatAt));
  assert.equal((await readdir(f.exportRoot)).length, 1, 'refresh replaces the same record, no heartbeat history');
  await f.runtime.session.prompt('/pa-observer-off'); await f.runtime.session.prompt('/pa-observer-status');
  const stopped = await f.records(); assert.equal(stopped[0].state, 'unknown');
  await f.runtime.session.prompt('AFTER_OBSERVATION_OFF');
  assert.ok(f.runtime.session.getLastAssistantText()); assert.deepEqual(await f.records(), stopped);
  const revoked = await fixture(t);
  await until(async () => !!await revoked.sessionRecord());
  const before = await revoked.records();
  await writeFile(revoked.configPath, JSON.stringify({ ...revoked.config, enabled: false }));
  await revoked.runtime.session.prompt('AFTER_REVOKE'); await revoked.runtime.session.prompt('/pa-observer-status');
  assert.deepEqual(await revoked.records(), before); assert.ok(revoked.runtime.session.getLastAssistantText());
});

test('producer filesystem/config guard rejects links, hardlinks, oversized records and broad/unknown fields', async t => {
  const f = await fixture(t, { load: false }), producer = await dynamicImport(observerPath);
  const alias = join(f.dir, 'alias.json'); await symlink(f.configPath, alias);
  await assert.rejects(producer.readPrivate(alias));
  const hard = join(f.dir, 'hard.json'); await link(f.configPath, hard);
  await assert.rejects(producer.readPrivate(hard)); await assert.rejects(producer.readPrivate(f.configPath));
  const big = join(f.dir, 'big.json'); await writeFile(big, 'x'.repeat(65537), { mode: 0o600 });
  await assert.rejects(producer.readPrivate(big));
  const wide = join(f.dir, 'wide.json'); await writeFile(wide, '{}', { mode: 0o644 });
  await assert.rejects(producer.readPrivate(wide));
  for (const value of [{ ...f.config, fields: ['runtime', 'transcript'] }, { ...f.config, sources: [{ cwd: f.cwd, sessionIds: ['*', 'one'] }] },
    { ...f.config, cwd: '/' }, { ...f.config, fields: ['subject'] }, { ...f.config, referencePaths: [join(f.cwd, '.env')] }]) await assert.rejects(producer.validateConfig(value));
  const sample = { kind: 'session', sourceId: '../outside', sessionId: '/tmp/escape', instanceId: '../other', executionId: null };
  assert.match(producer.recordName(sample), /^session-[a-f0-9]{64}\.json$/);
  await chmod(f.exportRoot, 0o755); await assert.rejects(producer.validateConfig(f.config));
});

test('offline preparation: dry-run, exact apply/backup, permission preservation, disable, digest-guarded/idempotent restore', async t => {
  const f = await fixture(t, { load: false });
  const settings = join(f.dir, 'settings.json'), loader = join(f.dir, 'prepared.mjs'), backup = join(f.dir, 'backup');
  const original = JSON.stringify({ extensions: ['/synthetic/permission.ts'], yoloMode: true, deny: ['secret/*'], defaultTools: ['read', 'edit', 'write', 'bash'], defaultProvider: 'unchanged' });
  await writeFile(settings, original, { mode: 0o644 });
  const run = async (args: string[], ok = true) => {
    if (!ok) { await assert.rejects(exec(process.execPath, [preparePath, ...args], { timeout: 6000 })); return; }
    return JSON.parse((await exec(process.execPath, [preparePath, ...args], { timeout: 6000 })).stdout);
  };
  const args = ['--config', f.configPath, '--loader', loader, '--settings', settings];
  assert.equal((await run(args)).mode, 'preflight');
  assert.equal(await readFile(settings, 'utf8'), original); await assert.rejects(stat(loader), { code: 'ENOENT' }); await assert.rejects(stat(backup), { code: 'ENOENT' });
  const applied = await run([...args, '--apply', '--backup', backup]); assert.equal(applied.loaded, false);
  const changed = JSON.parse(await readFile(settings, 'utf8'));
  assert.deepEqual(changed, { ...JSON.parse(original), extensions: ['/synthetic/permission.ts', loader] });
  assert.equal((await stat(settings)).mode & 0o777, 0o644);
  assert.equal((await stat(backup)).mode & 0o777, 0o700); assert.equal((await stat(join(backup, 'manifest.json'))).mode & 0o777, 0o600);
  assert.equal((await run([...args, '--apply', '--backup', join(f.dir, 'second-backup')])).changes.length, 0, 'repeat apply does not duplicate the loader');
  const after = await readFile(settings, 'utf8');
  assert.equal((await run(['--restore', backup])).mode, 'restore-preflight'); assert.equal(await readFile(settings, 'utf8'), after);
  await writeFile(settings, after + ' ');
  await run(['--restore', backup, '--apply'], false); assert.equal(await readFile(settings, 'utf8'), after + ' '); assert.ok(await stat(loader));
  await writeFile(settings, after); await chmod(settings, 0o600);
  await run(['--restore', backup, '--apply'], false); assert.ok(await stat(loader));
  await chmod(settings, 0o644); await run(['--restore', backup, '--apply']); await run(['--restore', backup, '--apply']);
  assert.equal(await readFile(settings, 'utf8'), original); await assert.rejects(stat(loader), { code: 'ENOENT' });
  await run([...args, '--apply', '--backup', join(f.dir, 'enabled-backup')]);
  const disabledBackup = join(f.dir, 'disabled-backup');
  await run([...args, '--disable', '--apply', '--backup', disabledBackup]);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).enabled, false);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')).extensions, ['/synthetic/permission.ts']);
  await run(['--restore', disabledBackup, '--apply']); assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).enabled, true);
  // Actually load the generated module in an idle constructed Pi, without changing its session ID.
  await writeFile(f.loaderPath, await readFile(loader)); const beforeId = f.runtime.session.sessionId;
  f.setLoad(true); await f.runtime.session.reload();
  await until(async () => !!await f.sessionRecord()); assert.equal(f.runtime.session.sessionId, beforeId);
});

test('review R1.1: tree navigation to custom B, user A and unobserved nodes never corrupts sibling identities/results', async t => {
  const f = await fixture(t, { fields: ['runtime', 'result'] });
  const flush = () => f.runtime.session.prompt('/pa-observer-status');
  const publish = async (executionId: string, summary: string) => {
    await f.runtime.session.prompt(`/pa-observer-publish ${JSON.stringify({ executionId, result: { summary, refs: [] } })}`); await flush();
  };
  await f.runtime.session.prompt('FIRST_ORIGINAL_INPUT'); await flush();
  const aId = (await f.records()).find(r => r.kind === 'execution').executionId;
  const aNode = f.runtime.session.sessionManager.getBranch().find((entry: any) => entry.type === 'message' && entry.message.role === 'assistant').id;
  await publish(aId, 'A-original-result');
  await f.runtime.session.sendCustomMessage({ customType: 'synthetic-trigger', content: 'CUSTOM_NOT_AN_OLD_USER_INPUT', display: false }, { triggerTurn: true }); await flush();
  const bId = (await f.records()).find(r => r.executionId?.startsWith('unlinked-')).executionId;
  const bNode = f.runtime.session.sessionManager.getLeafId();
  await publish(bId, 'B-original-result');
  await f.runtime.session.prompt('THIRD_INDEPENDENT_WORK'); await flush();
  const before = (await f.records()).filter(r => r.kind === 'execution');
  assert.equal(before.length, 3);
  const a = before.find(r => r.executionId === aId), b = before.find(r => r.executionId === bId), c = before.find(r => ![aId, bId].includes(r.executionId));
  const sessionId = f.runtime.session.sessionId;
  // Navigate FROM another work to B's actual assistant leaf, not just back to A.
  await f.runtime.session.navigateTree(bNode, { summarize: false }); await flush();
  assert.ok(f.notices.at(-1)?.includes(bId), 'status must select custom B, not its user ancestor A');
  assert.equal(f.runtime.session.sessionId, sessionId);
  assert.deepEqual((await f.records()).find(r => r.executionId === aId), a);
  assert.deepEqual((await f.records()).find(r => r.executionId === c.executionId), c);
  const selectedB = (await f.records()).find(r => r.executionId === bId);
  assert.equal(selectedB.state, 'unknown'); assert.ok(selectedB.revision > b.revision);
  await publish(bId, 'B-after-navigation');
  assert.equal((await f.records()).find(r => r.executionId === bId).result.summary, 'B-after-navigation');
  assert.deepEqual((await f.records()).find(r => r.executionId === aId), a);
  await f.runtime.session.navigateTree(aNode, { summarize: false }); await flush();
  assert.ok(f.notices.at(-1)?.includes(aId));
  const savedB = (await f.records()).find(r => r.executionId === bId);
  await publish(aId, 'A-after-navigation');
  assert.deepEqual((await f.records()).find(r => r.executionId === bId), savedB);
  // An unobserved metadata entry has no proven execution, even with A as an ancestor.
  // Pi navigates custom_message/user targets to their parent; use a custom entry so
  // the native navigation really selects the unknown node itself.
  const unknownNode = f.runtime.session.sessionManager.appendCustomEntry('not-executed', { synthetic: true });
  await f.runtime.session.navigateTree(bNode, { summarize: false }); await flush();
  const known = (await f.records()).filter(r => r.kind === 'execution');
  await f.runtime.session.navigateTree(unknownNode, { summarize: false }); await flush();
  assert.ok(f.notices.at(-1)?.includes('无当前回合'));
  await publish(aId, 'MUST_NOT_LAND_ON_ANCESTOR');
  assert.deepEqual((await f.records()).filter(r => r.kind === 'execution'), known, 'unknown navigation/publish leaves every execution unchanged');
});

test('review R1.1: automatic-continuation assistant nodes retain the original execution on tree navigation', async t => {
  let continued = false;
  const f = await fixture(t, { fields: ['runtime', 'result'], script: { flow: [{ text: 'FIRST' }, { text: 'AUTOMATIC_CONTINUATION' }, { text: 'OTHER_WORK' }] }, extensions: pi => {
    pi.on('agent_end', () => { if (!continued) { continued = true; pi.sendUserMessage('AUTOMATIC_FOLLOWUP', { deliverAs: 'followUp' }); } });
  } });
  await f.runtime.session.prompt('ORIGINAL_WORK'); await f.runtime.session.prompt('/pa-observer-status');
  const aId = (await f.records()).find(r => r.kind === 'execution').executionId;
  const nodes = f.runtime.session.sessionManager.getBranch().filter((entry: any) => entry.type === 'message' && entry.message.role === 'assistant').map((entry: any) => entry.id);
  assert.equal(nodes.length, 2);
  await f.runtime.session.prompt('INDEPENDENT_WORK'); await f.runtime.session.prompt('/pa-observer-status');
  const sibling = (await f.records()).find(r => r.kind === 'execution' && r.executionId !== aId);
  for (const node of nodes.toReversed()) {
    await f.runtime.session.navigateTree(node, { summarize: false }); await f.runtime.session.prompt('/pa-observer-status');
    assert.ok(f.notices.at(-1)?.includes(aId), 'continuation must not be rebound from the nearest follow-up user entry');
    await f.runtime.session.prompt(`/pa-observer-publish ${JSON.stringify({ executionId: aId, result: { summary: `result-for-${node}`, refs: [] } })}`);
    await f.runtime.session.prompt('/pa-observer-status');
    assert.equal((await f.records()).find(r => r.executionId === aId).result.summary, `result-for-${node}`);
    assert.deepEqual((await f.records()).find(r => r.executionId === sibling.executionId), sibling);
    assert.equal((await f.records()).filter(r => r.kind === 'execution').length, 2);
  }
});

test('A4 original automatic tools and explicit deny stay unchanged with the observer loaded', async t => {
  let allowed = 0, denied = 0;
  const f = await fixture(t, { script: { flow: [
    { tools: [{ name: 'original_auto', arguments: {} }] }, { tools: [{ name: 'original_denied', arguments: {} }] }, { text: 'ORIGINAL_AUTO_DONE' },
  ] }, extensions: pi => {
    for (const name of ['original_auto', 'original_denied']) pi.registerTool({ name, label: name, description: 'synthetic original permission boundary',
      parameters: { type: 'object', properties: {}, additionalProperties: true }, execute: async () => {
        if (name === 'original_auto') allowed++; else denied++;
        return { content: [{ type: 'text', text: 'PRIVATE_TOOL_FULLTEXT' }], details: undefined };
      } });
    pi.on('tool_call', (event: any) => { if (event.toolName === 'original_denied') return { block: true, reason: 'ORIGINAL_EXPLICIT_DENY' }; });
  } });
  const tools = f.runtime.session.getActiveToolNames().slice().sort();
  f.setConfirm(async () => assert.fail('observer must not add per-tool confirmation'));
  await f.runtime.session.prompt('RUN_AUTOMATIC_WITH_EXISTING_DENY');
  await f.runtime.session.prompt('/pa-observer-status');
  assert.equal(allowed, 1); assert.equal(denied, 0); assert.equal(f.runtime.session.getLastAssistantText(), 'ORIGINAL_AUTO_DONE');
  assert.deepEqual(f.runtime.session.getActiveToolNames().slice().sort(), tools);
  assert.equal(JSON.stringify(await f.records()).includes('PRIVATE_TOOL'), false); assert.equal(JSON.stringify(await f.records()).includes('ORIGINAL_EXPLICIT_DENY'), false);
});

test('A4 native aborted/error runs are runtime outcomes only; off during a blocking original tool does not stop it', async t => {
  const aborted = await fixture(t, { script: { flow: [{ hang: true }] } });
  const active = aborted.runtime.session.prompt('SYNTHETIC_ABORTED_INPUT');
  await until(async () => aborted.model.requests.length === 1 && (await aborted.records()).some(r => r.kind === 'execution' && r.state === 'running'));
  await aborted.runtime.session.abort(); await active;
  await until(async () => (await aborted.records()).some(r => r.kind === 'execution' && r.state === 'settled' && r.outcome === 'aborted'));
  const failed = await fixture(t, { script: { flow: [{ status: 400 }] } });
  await failed.runtime.session.prompt('SYNTHETIC_ERROR_INPUT');
  await until(async () => (await failed.records()).some(r => r.kind === 'execution' && r.state === 'settled' && r.outcome === 'error'));
  let release!: (value: boolean) => void;
  const busy = await fixture(t, { script: { flow: [{ tools: [{ name: 'busy_fixture', arguments: {} }] }, { text: 'ORIGINAL_WORK_FINISHED' }] }, extensions: pi => {
    pi.registerTool({ name: 'busy_fixture', label: 'busy', description: 'synthetic original blocking tool', parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: async (_id: any, _args: any, _signal: any, _update: any, ctx: any) => ({ content: [{ type: 'text', text: String(await ctx.ui.confirm('busy', 'synthetic')) }], details: undefined }) });
  } });
  busy.setConfirm(() => new Promise<boolean>(accept => { release = accept; }));
  const work = busy.runtime.session.prompt('BUSY_ORIGINAL_WORK'); t.after(() => release?.(true));
  await until(async () => (await busy.records()).some(r => r.state === 'waiting'));
  await busy.runtime.session.prompt('/pa-observer-off'); await busy.runtime.session.prompt('/pa-observer-status');
  const stopped = await busy.records(); assert.equal(busy.runtime.session.isStreaming, true);
  release(true); await work;
  assert.equal(busy.runtime.session.getLastAssistantText(), 'ORIGINAL_WORK_FINISHED'); assert.deepEqual(await busy.records(), stopped);
});

for (const mode of ['queued', 'idle', 'broken', 'stalled']) test(`review R1.2: dispose then immediate process.exit, ${mode} observer I/O`, async t => {
  const f = await fixture(t, { load: false });
  const home = join(f.dir, 'exit-home'), agent = join(home, 'agent'); await mkdir(agent, { recursive: true, mode: 0o700 });
  const script = `
    import { open, rename, mkdir, symlink } from 'node:fs/promises';
    import { readdirSync, readFileSync } from 'node:fs';
    import * as sdk from ${JSON.stringify(pathToFileURL(join(f.location.root, 'dist/index.js')).href)};
    const cwd = ${JSON.stringify(f.cwd)}, agentDir = ${JSON.stringify(agent)}, root = ${JSON.stringify(f.exportRoot)}, mode = ${JSON.stringify(mode)};
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultTools: [] });
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: agentDir + '/absent-auth.json', modelsPath: null, modelsStorePath: agentDir + '/model-cache.json', allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerProvider('observer-fixture', { baseUrl: ${JSON.stringify(`${f.model.url}/v1`)}, api: 'openai-completions', apiKey: 'SYNTHETIC_LOCAL_ONLY', models: [{ id: 'local', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000 }] });
    const factory = async ({ sessionManager, sessionStartEvent }) => {
      const services = await sdk.createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime, resourceLoaderOptions: {
        noExtensions: true, additionalExtensionPaths: [${JSON.stringify(f.loaderPath)}], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      } });
      if (services.resourceLoader.getExtensions().errors.length) process.exit(2);
      return { ...await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: [], model: modelRuntime.getModel('observer-fixture', 'local') }), services, diagnostics: services.diagnostics };
    };
    const runtime = await sdk.createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(cwd) });
    await runtime.session.bindExtensions({});
    const sessionId = runtime.session.sessionId;
    if (mode !== 'queued') await runtime.session.prompt('/pa-observer-status');
    if (mode === 'broken') {
      await rename(root, root + '-retired'); await mkdir(root + '-outside', { mode: 0o700 }); await symlink(root + '-outside', root);
    }
    if (mode === 'stalled') {
      // Fault injection only in this constructed child: hang real exporter fsync forever.
      const probe = await open(cwd + '/sync-probe', 'w'); const prototype = Object.getPrototypeOf(probe); await probe.close();
      prototype.sync = () => new Promise(() => {});
    }
    const start = Date.now();
    await runtime.dispose();
    // No await, polling or live parent runtime after dispose: the TUI immediately exits too.
    const records = readdirSync(root).filter(n => /^session-[a-f0-9]{64}\\.json$/.test(n)).map(n => JSON.parse(readFileSync(root + '/' + n, 'utf8')));
    process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - start, sessionId, statesAtExit: records.map(r => r.state) }));
    process.exit(0);
  `;
  const child = exec(process.execPath, ['--input-type=module', '-e', script], { cwd: f.cwd, timeout: 8000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: f.dir, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1' } });
  child.child.stdin?.end();
  const result = JSON.parse((await child).stdout);
  assert.ok(result.elapsedMs < 3000, 'observer failure must not block the original process exit');
  if (mode === 'queued' || mode === 'idle') {
    assert.deepEqual(result.statesAtExit, ['closed'], 'closed must already be durable when dispose returns');
    assert.equal((await f.records()).find(r => r.sessionId === result.sessionId).state, 'closed');
  } else if (mode === 'broken') {
    assert.deepEqual(result.statesAtExit, []); assert.deepEqual(await readdir(f.exportRoot), [], 'never follow the replaced export root');
  } else {
    assert.ok(result.elapsedMs >= 900, 'the stalled write must exercise the shutdown deadline');
    assert.deepEqual(result.statesAtExit, ['idle'], 'timeout leaves the last reliable record rather than claiming closed');
    assert.equal((await f.records()).find(r => r.sessionId === result.sessionId).state, 'idle');
  }
  assert.equal(f.model.requests.length, 0, 'shutdown never reruns any model or business work');
});

for (const mode of ['print', 'json']) test(`A4 native CLI ${mode}: actual file extension + flag in isolated HOME, only local model`, async t => {
  const f = await fixture(t, { load: false });
  const home = join(f.dir, `home-${mode}`), agent = join(home, 'agent'); await mkdir(agent, { recursive: true, mode: 0o700 });
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultTools: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false }));
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'observer-fixture': {
    baseUrl: `${f.model.url}/v1`, api: 'openai-completions', apiKey: 'SYNTHETIC_LOCAL_ONLY',
    models: [{ id: 'local', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000 }],
  } } }));
  const sessionId = `synthetic-cli-${mode}`;
  const args = [f.location.cli, '--offline', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-mcp', '--no-approve',
    '--session-dir', f.sessions, '--session-id', sessionId, '--provider', 'observer-fixture', '--model', 'local', '--thinking', 'off',
    '-e', observerPath, '--pa-observer-config', f.configPath, ...(mode === 'json' ? ['--mode', 'json'] : ['--print']), 'CLI_INPUT_NEVER_EXPORT'];
  const child = exec(process.execPath, args, { cwd: f.cwd, timeout: 12000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: f.dir, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', CI: '1', TERM: 'dumb' } });
  child.child.stdin?.end(); // Pi reads redirected stdin before starting the explicit prompt.
  const result = await child;
  assert.match(result.stdout, /SYNTHETIC_RESULT_NOT_EXPORTED/);
  await until(async () => (await f.records()).some(r => r.kind === 'session' && r.sessionId === sessionId && r.state === 'closed'));
  const records = (await f.records()).filter(r => r.sessionId === sessionId);
  assert.ok(records.some(r => r.kind === 'execution' && r.state === 'settled' && r.outcome === 'completed'));
  assert.equal(JSON.stringify(records).includes('CLI_INPUT'), false); assert.equal(JSON.stringify(records).includes('SYNTHETIC_RESULT'), false);
  for (const record of records) {
    assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 65536);
    assert.ok(record.revision > 0); assert.ok(record.observedAt); assert.ok(record.heartbeatAt);
    assert.deepEqual(Object.keys(record).sort(), ['version', 'kind', 'sourceId', 'sessionId', 'instanceId', 'executionId', 'revision', 'observedAt', 'heartbeatAt', 'cwd', 'state', ...(record.kind === 'execution' ? ['outcome'] : [])].sort());
  }
});
