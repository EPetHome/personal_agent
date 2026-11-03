#!/usr/bin/env node
// 用安装版Pi解析真实命令参数，只有模型响应隔离；没有读取/写入/自由shell执行器。
import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
const { parseArgs } = await import(pathToFileURL(process.env.PA_TEST_PI_ARGS).href);
const argv = process.argv.slice(2), args = parseArgs(argv);
for (const key of ['noTools', 'noSession', 'noExtensions', 'noContextFiles', 'noSkills', 'noPromptTemplates', 'noMcp', 'noThemes', 'offline']) if (args[key] !== true) throw new Error(`隔离边界缺少${key}`);
if (args.projectTrustOverride !== false) throw new Error('不能信任材料项目');
if (args.version) { console.log(JSON.parse(await readFile(resolve(dirname(process.env.PA_TEST_PI_ARGS), '../../package.json'), 'utf8')).version); process.exit(0); }
if (args.mode !== 'json' || !args.print || args.tools?.length || args.extensions?.length) throw new Error('不是禁工具单次JSON路径');
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const settings = JSON.parse(await readFile(args.model, 'utf8'));
if (settings.capture) await appendFile(settings.capture, JSON.stringify({ argv, prompt, parsedNoTools: args.noTools, parsedNoMcp: args.noMcp }) + '\n');
const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
const id = payload.requestId ?? payload.request?.requestId;
let answer = settings.kind === 'query' ? { requestId: id, status: 'consumed', facts: [{ text: '构造事实：组件有一个导出', basis: `${settings.basis}:1` }], writeAttempt: { path: settings.outside, content: '不得执行' } }
  : settings.kind === 'path' ? { content: '构造摘要', path: settings.outside } : { content: '构造材料产物，未知项明确列出' };
const message = settings.kind === 'tool' ? { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'forbidden', name: 'write', arguments: { path: settings.outside, content: '不得执行' } }] }
  : { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(answer) }] };
console.log(JSON.stringify({ type: 'message_end', message }));
console.log(JSON.stringify({ type: 'agent_settled', aborted: false }));
