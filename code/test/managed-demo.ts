#!/usr/bin/env node
// 离线体验：只新建显式临时目录；3张构造卡，不启动常驻，不接账号，不动真实仓库。
import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../src/core/config.ts';
import { runCommand } from '../src/core/process.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';
import { processManagedLoop } from '../src/core/managed-loop.ts';
import { readLedger } from '../src/core/ledger.ts';

const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw new Error('用法：node code/test/managed-demo.ts <尚不存在的绝对临时目录>');
try { await lstat(destination); throw new Error('目标已存在，拒绝覆盖；请换一个新的临时目录'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await mkdir(destination, { recursive: true, mode: 0o700 });
const root = await realpath(destination), project = join(root, 'synthetic-project'), inbox = join(root, 'inbox'), worker = join(root, 'worker');
await mkdir(project); await mkdir(inbox); await mkdir(worker);
const piWorker = join(root, 'pi-worker'); await mkdir(piWorker);
await writeFile(join(project, 'modules.md'), 'alpha、beta、gamma（构造模块清单）\n');
await writeFile(join(project, 'recording.wav'), 'synthetic recording, not real audio\n');
await writeFile(join(project, '任务.md'), '构造任务：只给演示模块补测试，原门禁通过即到位；不改其他模块。\n');
await writeFile(join(project, 'gate.log'), 'not ok 1 - synthetic test\nAssertionError: synthetic failure\n');
const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic Demo', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Demo', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (args: string[]) => runCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], 5000, undefined, undefined, project, gitEnv);
await git(['init', '-b', 'main']); await git(['add', '.']); await git(['commit', '-m', 'synthetic demo base']);
await git(['checkout', '-b', 'feat/synthetic-demo']);
await writeFile(join(project, 'demo.txt'), '构造批次改动\n'); await git(['add', '.']); await git(['commit', '-m', 'synthetic batch']);
const commit = (await git(['rev-parse', 'HEAD'])).trim(), remote = join(root, 'test-remote.git');
await git(['init', '--bare', remote]); await git(['remote', 'add', 'test', remote]);
await writeFile(join(worker, 'settings.json'), JSON.stringify({ allowExecution: true, projects: [project], pushTarget: { remote: 'test', visibility: 'public' }, stopCommit: commit }));
const notifier = join(root, 'notify-stub');
await writeFile(notifier, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(root, 'notifications.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');\n`); await chmod(notifier, 0o700);
const config = await validateConfig({ sources: { loop: null }, inboxDir: inbox, dataDir: join(root, 'data'), commands: { cc: '/must-not-run' },
  feishu: { mode: 'fake', receiverId: 'ou_test', timeoutMs: 1000 }, heartbeat: { executable: notifier },
  worker: { executable: process.execPath, args: [resolve(import.meta.dirname, 'loop-stub.ts'), worker], timeoutMs: 10000 },
  piWorker: { executable: process.execPath, args: [resolve(import.meta.dirname, 'pi-worker-stub.ts'), piWorker], timeoutMs: 1200000 },
  dispatch: { projects: [{ name: '测试项目', path: project, workspace: project }], skills: { transcribe: 'transcribe', summary: 'summary', wiki: 'wiki' } } });
const channel = feishuChannel(config, undefined, { managed: true });
const cases = [
  { batch: '演示-需要你决定', state: 'needs_decision', reason: '需要决定', detail: { question: '门禁里一条旧测试时序不稳，要不要顺手改？', options: ['改', '不改'] }, suggestion: '不改，记问题单另开批', basis: '依据任务.md：本批只补演示模块测试，不顺手扩大范围' },
  { batch: '演示-暂停', state: 'paused', reason: '磁盘不足', detail: { log: join(project, 'gate.log') }, suggestion: '继续，先修复刚才失败的测试，再运行原门禁', basis: '依据gate.log：AssertionError与not ok；不是磁盘不足' },
  { batch: '演示-做完', state: 'completed', reason: '开发完成', detail: { branch: 'feat/synthetic-demo', commit, gate: 'passed', review: 'passed', acceptance: { result: 'partial', manual: ['三种卡片的文案是否符合你的意思'], failed: [], partial: [] } }, suggestion: '先看人工项；要推送或合入，请分别点明确按钮（测试远端模拟公开）', basis: '依据只读Git核实与loop报告；技术结果不代替业务验收' },
];
for (const item of cases) {
  const modelFile = join(root, `${item.state}-model.json`);
  await writeFile(modelFile, JSON.stringify({ answer: { suggestion: item.suggestion, basis: item.basis, redline: false } }));
  config.judge = { executable: resolve(import.meta.dirname, 'pi-stub.ts'), model: modelFile, timeoutMs: 5000 };
  const event = { schema: 1, id: randomUUID(), seq: 1, at: '2026-11-02T10:00:00Z', project, batch: item.batch, stage: '乙', state: item.state,
    reason: { category: 'unknown', text: item.reason }, evidence: item.state === 'paused' ? [join(project, 'gate.log')] : [], detail: { prompt: join(project, '任务.md'), ...item.detail } };
  await runCommand(process.execPath, [resolve(import.meta.dirname, 'loop-stub.ts'), worker, 'emit', inbox], 5000, JSON.stringify(event));
  await processManagedLoop(config, '2026-11-02T10:00:00Z', { channels: [channel] });
  await processManagedLoop(config, '2026-11-02T10:03:00Z', { channels: [channel] });
}
await writeFile(join(root, 'config.json'), JSON.stringify(config, null, 2));
const cards = Object.values((await readLedger(config.dataDir)).tables.cards);
await writeFile(join(config.dataDir, 'cards.txt'), cards.map(card => `${card.title}\n事实：${card.fact}\n问题：${card.question || '无'}\n原选项：${card.options.join(' / ') || '无'}\n建议：${card.suggestion}\n依据：${card.basis}\n`).join('\n---\n\n'));
console.log(`纯构造离线体验，未启动常驻、未发真实消息。\n配置：${join(root, 'config.json')}\n三种卡文案：${join(config.dataDir, 'cards.txt')}\n完整假飞书卡：${join(config.dataDir, 'feishu-sent.jsonl')}`);
