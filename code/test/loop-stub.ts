#!/usr/bin/env node
// 仅构造验收用；所有路径显式传入，不接真实 loop/账号。
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLoopEvent } from '../src/core/loop-intake.ts';
import { executeStub } from './stub-execution.ts';

const [dir, action, inbox] = process.argv.slice(2);
if (!dir || !action) throw new Error('用法：node code/test/loop-stub.ts <临时替身目录> <emit|status|send|push|merge|stop|start|set> [临时收件目录]；stdin JSON');
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || '{}');
await mkdir(dir, { recursive: true, mode: 0o700 });
const rows = async (name: string): Promise<any[]> => (await readFile(join(dir, name), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; })).split('\n').filter(Boolean).map(line => JSON.parse(line));
const append = (name: string, value: unknown) => appendFile(join(dir, name), JSON.stringify(value) + '\n', { mode: 0o600 });
const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8').catch(() => '{}'));
if (settings.delayMs) await new Promise(resolve => setTimeout(resolve, settings.delayMs));
if (action === 'emit') {
  if (!inbox) throw new Error('emit 须指定临时 inboxDir');
  const event = parseLoopEvent(input); await mkdir(join(inbox, 'loop'), { recursive: true });
  await appendFile(join(inbox, 'loop', `${event.batch}.jsonl`), JSON.stringify(event) + '\n');
  await append('events.jsonl', event); console.log(JSON.stringify({ emitted: event.id }));
} else if (action === 'set') {
  await writeFile(join(dir, 'settings.json'), JSON.stringify(input)); console.log('{}');
} else if (action === 'status') {
  await append('queries.jsonl', input);
  if (settings.statusError) process.exit(2);
  const events = (await rows('events.jsonl')).filter(event => event.batch === input.batch && (!input.project || event.project === input.project));
  const last = events.at(-1), stages = new Map<string, unknown>();
  for (const event of events) stages.set(event.stage, { name: event.stage, state: event.state, reason: event.reason });
  console.log(JSON.stringify(settings.status ?? { schema: 1, batch: input.batch, updatedAt: last?.at ?? new Date().toISOString(),
    lastActivityAt: last?.at, stages: [...stages.values()], branch: last?.detail.branch, commit: last?.detail.commit, candidateRef: settings.candidateRef, pushTarget: settings.pushTarget }));
} else if (action === 'send') {
  await append('attempts.jsonl', input);
  const previous = (await rows('receipts.jsonl')).find(row => row.requestId === input.requestId);
  if (previous) console.log(JSON.stringify(previous));
  else {
    const receipt = { requestId: input.requestId, status: settings.receipt ?? 'consumed', ...(settings.reason ? { reason: settings.reason } : {}) };
    if (receipt.status !== 'failed') await append('received.jsonl', input);
    await append('receipts.jsonl', receipt);
    if (settings.dropReceipt) process.exit(3);
    console.log(JSON.stringify(receipt));
  }
} else if (action === 'start') {
  await append('attempts.jsonl', { ...input, action });
  const previous = (await rows('receipts.jsonl')).find(row => row.requestId === input.requestId);
  if (previous) console.log(JSON.stringify(previous));
  else {
    if (!input.definition?.result || !input.definition?.done || !['develop', 'review_only', 'acceptance_only'].includes(input.recipe)
      || !['suggest', 'auto'].includes(input.mode)) throw new Error('开批次请求缺少配方和完整定义');
    await append('starts.jsonl', input);
    const receipt = { requestId: input.requestId, status: settings.receipt ?? 'consumed', reason: settings.reason };
    if (receipt.status !== 'failed') await append('received.jsonl', input);
    await append('receipts.jsonl', receipt);
    if (settings.dropReceipt) process.exit(3);
    console.log(JSON.stringify(receipt));
  }
} else if (['push', 'merge', 'stop'].includes(action)) {
  await append('attempts.jsonl', { ...input, action });
  const previous = (await rows('receipts.jsonl')).find(row => row.requestId === input.requestId);
  if (previous) console.log(JSON.stringify(previous));
  else {
    // 即使调用者伪造JSON的action，也只能执行命令行固定的这一种动作。
    const request = { ...input, action };
    const result = settings.receipt && settings.receipt !== 'consumed' && settings.receipt !== 'delivered'
      ? { requestId: input.requestId, status: settings.receipt, reason: settings.reason ?? '构造回执' }
      : await executeStub(dir, request, settings);
    await append('executions.jsonl', request);
    if (result.status !== 'failed') await append('received.jsonl', request);
    const receipt = settings.omitExecutionResult ? { requestId: input.requestId, status: 'consumed' } : result;
    await append('receipts.jsonl', receipt);
    if (settings.dropReceipt) process.exit(3);
    console.log(JSON.stringify(receipt));
  }
} else throw new Error('替身只开放 emit/status/send/push/merge/stop/start/set；start只记录请求，不开真实批次');
