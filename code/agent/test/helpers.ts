import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { fakeFeishu, scriptModel, type Script } from '../src/stubs/servers.js';
import { sleep } from '../src/util.js';

export async function until(test: () => boolean | Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await sleep(20); }
  assert.fail(`condition did not become true within ${timeout}ms`);
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
    async close() { await app?.stop(); await Promise.all([feishu.close(), model.close()]); await rm(root, { recursive: true, force: true }); },
  };
}
