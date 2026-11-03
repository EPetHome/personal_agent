#!/usr/bin/env node
// 只读研判替身；--model 指向构造 JSON 文件，绝不调用模型/工具/真实账号。
import { readFile, appendFile } from 'node:fs/promises';
const args = process.argv.slice(2), file = args[args.indexOf('--model') + 1];
if (!args.includes('--no-tools') || !args.includes('--no-session') || !file) throw new Error('替身只接受禁工具、无会话的调用');
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const setting = JSON.parse(await readFile(file, 'utf8'));
if (setting.capture) await appendFile(setting.capture, JSON.stringify({ args, prompt }) + '\n');
if (setting.delayMs) await new Promise(resolve => setTimeout(resolve, setting.delayMs));
if (setting.fail) process.exit(2);
const answer = setting.answer ?? { suggestion: '不改，记问题单另开批', basis: '依据原问题：旧测试修复应另列，不扩大当前任务范围', redline: false };
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', ...(setting.usage ? { usage: setting.usage } : {}), content: [{ type: 'text', text: JSON.stringify(answer) }] } }));
