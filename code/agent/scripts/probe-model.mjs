// Explicitly authorized compatibility probe only. Never prints credentials or response bodies.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
  console.log(`用法：node scripts/probe-model.mjs [--help|-h]
参数：PA_PROBE_URL 可覆盖模型地址；模型固定 deepseek-v4.1-flash。普通运行会读取 ~/.pi/agent/auth.json 的 opencode-go 凭据，必须另获真实调用授权。
常驻：否，最多4次真实 API 请求，三轮工具兼容探测后退出；每次请求上限60秒，会产生费用，不能为看帮助而普通运行。
停止：Ctrl-C / SIGTERM。
帮助立即以退出码 0 结束，不读凭据、不联网、不建目录、不写文件。`);
  process.exit(0);
}
const endpoint = process.env.PA_PROBE_URL ?? 'https://opencode.ai/inference/go/openai/v1';
const model = 'deepseek-v4.1-flash';
const auth = JSON.parse(await readFile(join(homedir(), '.pi/agent/auth.json'), 'utf8'));
const key = auth['opencode-go']?.key;
if (typeof key !== 'string' || !key) throw new Error('opencode-go API key unavailable');
const messages = [{ role: 'system', content: 'Compatibility test using invented data. Call probe_step exactly once when tools are available. After all steps, say OK. Do not use external information.' }, { role: 'user', content: 'Test three consecutive tool rounds.' }];
const session = randomUUID();
const tools = [{ type: 'function', function: { name: 'probe_step', description: 'A synthetic no-op tool.', parameters: { type: 'object', properties: { step: { type: 'integer' } }, required: ['step'] } } }];
for (let round = 1; round <= 4; round++) {
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-opencode-session': session },
    body: JSON.stringify({ model, messages, stream: false, max_tokens: 2048, ...(round <= 3 ? { tools, tool_choice: { type: 'function', function: { name: 'probe_step' } } } : {}) }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const reason = String(error.error?.message ?? error.message ?? 'unknown').replaceAll(key, '[REDACTED]').slice(0, 600);
    throw new Error(`Compatibility probe failed: HTTP ${response.status}; round ${round}; ${reason}`);
  }
  const body = await response.json();
  const message = body.choices?.[0]?.message;
  if (!message || (round <= 3 && !message.tool_calls?.length)) throw new Error(`Missing tool call at round ${round}`);
  messages.push(message); // Retains reasoning_content verbatim, including empty values.
  console.log(JSON.stringify({ round, status: response.status, toolCalls: message.tool_calls?.length ?? 0, reasoningContentPresent: Object.hasOwn(message, 'reasoning_content'), usage: body.usage }));
  for (const call of message.tool_calls ?? []) messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ synthetic: true, completed: round }) });
}
console.log('PASS: three consecutive tool rounds and final response; 4 real API requests total.');
