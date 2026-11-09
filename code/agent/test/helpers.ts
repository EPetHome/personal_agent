import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { fakeFeishu, scriptModel, type Script } from '../src/stubs/servers.js';
import { sleep, parseJson, canonical, hash } from '../src/util.js';
import type { Input, ObservationSource } from '../src/types.js';
import type { PiObservationRecord } from '../src/pi-observation.js';
import type { Store } from '../src/store.js';

export async function until(test: () => boolean | Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await sleep(20); }
  assert.fail(`condition did not become true within ${timeout}ms`);
}
export async function settleLaunchers(dataDir: string) {
  const dir = join(dataDir, 'worker-launches');
  const files = await readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
  for (const file of files.filter(f => /^[a-f0-9]{48}\.launch\.json$/.test(f))) {
    const receipt = join(dir, file.replace('.launch.json', '.receipt.json'));
    await until(async () => { try { return parseJson<{ state?: string }>(await readFile(receipt, 'utf8')).state === 'exited'; } catch { return false; } }, 8000);
  }
}
export function ownerInput(store: Store, id: string, text: string): Input {
  const input: Input = { id, text, source: 'feishu', who: 'owner', chatType: 'p2p', messageId: `message-${id}`, at: new Date().toISOString(), attachments: [] };
  store.enqueue(input); return input;
}
export const instructionArgs = (input: Input) => ({ instructionInput: input.id, instruction: input.text });
export async function observationFixture(watch = false, script: Script = { flow: [{ text: '静默记录构造来源' }] }) {
  const f = await fixture(script, { intake: { watch, fallbackMs: 60_000 } });
  const path = join(f.root, 'pi-export'); await mkdir(path);
  const source: ObservationSource = { id: 'selected-pi', enabled: true, exportRoot: await canonical(path), cwds: [f.config.projects[0]!.root], ownerUid: process.getuid!(), project: 'p', allowSubject: true, allowResult: true };
  f.config.piObservation = { sources: [source] };
  const record = (changes: Partial<PiObservationRecord> = {}): PiObservationRecord => ({ version: 1, kind: 'execution', sourceId: source.id, sessionId: 'original-session', instanceId: 'instance-1', executionId: 'input-1', revision: 1, observedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), cwd: source.cwds[0]!, state: 'running', ...changes });
  const emit = async (r = record()) => {
    const file = join(source.exportRoot, `${r.kind}-${hash(JSON.stringify([r.sourceId, r.sessionId, r.instanceId, r.executionId]))}.json`);
    const temp = `${file}.tmp`; await writeFile(temp, JSON.stringify(r)); const { rename } = await import('node:fs/promises'); await rename(temp, file); return file;
  };
  return { ...f, source, record, emit };
}
export const replyScript: Script = { requireReasoning: true, flow: [{ tools: [{ name: 'reply', arguments: { text: '收到：{{text}}' } }] }, { text: 'done' }] };
export async function fixture(script: Script = replyScript, override: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pa-v2-test-'));
  const [feishu, model] = await Promise.all([fakeFeishu(), scriptModel(script)]);
  const project = join(root, 'project'), inbox = join(root, 'inbox'), events = join(root, 'events'), run = join(root, 'loop-run');
  for (const p of [project, inbox, events, run]) await mkdir(p);
  const configPath = join(root, 'config.json'), snapshot = join(root, 'loop.json');
  await writeFile(snapshot, JSON.stringify({ v: 1, at: new Date().toISOString(), batches: [1, 2, 3].map(n => ({ project, batch: { name: `batch-${n}`, file: join(project, `batch-${n}.json`), recipe: 'develop' }, state: 'running', stages: [], evidence: {} })) }));
  const raw = { dataDir: join(root, 'data'), attachmentDir: join(root, 'attachments'), inboxDirs: [inbox], projects: [{ id: 'p', root: project, loopRunDirs: [run] }],
    model: { url: `${model.url}/v1`, name: 'script-model', auth: { type: 'none' }, timeoutMs: 4000 },
    feishu: { mode: 'fake', userId: 'owner', url: feishu.url, pollMs: 25, timeoutMs: 500 },
    loop: { command: process.execPath, args: [resolve('scripts/loop-stub.mjs'), '--state', snapshot], eventDirs: [events] },
    intake: { watch: true, fallbackMs: 150 }, watchdog: { local: { mode: 'fake', url: feishu.url } }, ...override };
  await writeFile(configPath, JSON.stringify(raw));
  const config = await loadConfig(configPath);
  let app: App | undefined;
  const inject = async (value: unknown) => { await fetch(`${feishu.url}/inject`, { method: 'POST', body: JSON.stringify(value) }); };
  return { root, project, inbox, events, run, configPath, config, raw, feishu, model, inject,
    async start() { app = await App.create(config); await app.start(); return app; },
    async stop() { await app?.stop(); app = undefined; },
    async close() {
      await app?.stop();
      try { await settleLaunchers(config.dataDir); }
      finally { await Promise.all([feishu.close(), model.close()]); }
      await rm(root, { recursive: true, force: true });
    },
  };
}
