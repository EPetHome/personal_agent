#!/usr/bin/env node
// 一次派一次交的Pi查询/skill替身。目录必须显式传入；不运行真实skill或模型。
import { appendFile, mkdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
const [dir, action] = process.argv.slice(2);
if (!dir || !['query', 'skill'].includes(action ?? '')) throw new Error('用法：node pi-worker-stub.ts <临时目录> <query|skill>；stdin JSON');
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw); await mkdir(dir, { recursive: true, mode: 0o700 });
const append = (name: string, value: unknown) => appendFile(join(dir, name), JSON.stringify(value) + '\n', { mode: 0o600 });
const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8').catch(() => '{}'));
await append('attempts.jsonl', { action, ...input });
const receipts = (await readFile(join(dir, 'receipts.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const previous = receipts.find(row => row.requestId === input.requestId);
if (previous) console.log(JSON.stringify(previous));
else {
  if (action === 'query' && (!input.sheet?.goal || !input.sheet.questions?.length || !input.sheet.arrival || input.sheet.budget?.maxRounds !== 1
    || input.sheet.budget?.timeoutMs > 1200000 || input.sheet.boundary?.write?.length || input.constraints?.readOnly !== true || input.constraints?.tools?.length)) throw new Error('查询缺少完整的只读单轮提问单');
  if (action === 'skill' && (!input.skills?.length || !input.definition?.boundaries)) throw new Error('skill派工缺少映射/范围');
  await append('received.jsonl', { action, ...input });
  if (settings.waitFor) while (!await access(settings.waitFor).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 20));
  if (settings.delayMs) await new Promise(resolve => setTimeout(resolve, settings.delayMs));
  const receipt = settings.rawReceipt ?? { requestId: input.requestId, status: settings.status ?? 'consumed',
    ...(action === 'query' ? { facts: settings.facts ?? [{ text: '构造项目里找到了 alpha、beta、gamma 三个模块', basis: `${input.project}/modules.md:1` }],
      questions: settings.questions ?? ['要先补哪个模块的测试？'] } : { result: settings.result ?? '构造转写和摘要已交回（没有真实转写录音）' }) };
  await append('receipts.jsonl', receipt);
  if (settings.dropReceipt) process.exit(3);
  console.log(JSON.stringify(receipt));
}
