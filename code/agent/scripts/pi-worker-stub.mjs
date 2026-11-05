#!/usr/bin/env node
// Local Pi process substitute. Never contacts a provider or a real service.
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
  console.log(`用法：PA_PI_JOB_DIR=<本次派工目录> node scripts/pi-worker-stub.mjs --control <构造JSON> --calls <调用JSONL> --tools <工具列表> [Pi传入的其他参数]
参数：--control 指定 delayMs/status/summary/question/evidence/hang/child；--calls 记录 start/end；--tools 只用于报告本次工具清单；--help/-h 只显示帮助。
常驻：通常等待 delayMs（默认150ms）后写构造结果并退出；hang=true 时常驻；child=true 会另起同组构造子进程。
停止：由 PA 监督器按本次记录的进程身份停止；前台可 Ctrl-C / SIGTERM，child 模式还须结束同组构造子进程。
帮助立即以退出码 0 结束，不读取派工/控制文件，不建目录、不起子进程、不写文件。`);
  process.exit(0);
}
const value = name => process.argv[process.argv.indexOf(name) + 1];
const dir = process.env.PA_PI_JOB_DIR;
if (!dir || !process.argv.includes('--control') || !process.argv.includes('--calls')) throw new Error('isolated stub configuration required');
const policy = JSON.parse(await readFile(join(dir, 'policy.json'), 'utf8'));
const control = JSON.parse(await readFile(value('--control'), 'utf8'));
const calls = value('--calls'), record = data => appendFile(calls, JSON.stringify({ at: Date.now(), operation: policy.operation, pid: process.pid, ...data }) + '\n');
const tools = value('--tools').split(',');
await writeFile(join(dir, 'ready.json'), JSON.stringify({ operation: policy.operation, token: policy.token, pid: process.pid, tools }));
await record({ event: 'start', tools, inheritedSecrets: Object.keys(process.env).filter(k => /^(?:AUTOREVIEW_|FEISHU_|OPENAI_|ANTHROPIC_|PI_SESSION)/.test(k)) });
if (control.child) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)'], { stdio: 'ignore' }); child.unref(); await record({ event: 'child', child: child.pid });
}
if (control.hang) await new Promise(() => { setInterval(() => {}, 60000); });
await new Promise(accept => setTimeout(accept, control.delayMs ?? 150));
const answer = { status: control.status ?? 'done', summary: control.summary ?? '构造 Pi 结果', ...(control.question ? { question: control.question } : {}), evidence: control.evidence ?? [] };
await writeFile(join(dir, 'agent-result.json'), JSON.stringify({ operation: policy.operation, token: policy.token, final: JSON.stringify(answer), failed: false }));
await record({ event: 'end' });
