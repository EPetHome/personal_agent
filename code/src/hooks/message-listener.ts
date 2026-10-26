import { emitPush } from './protocol.ts';
import type { HookPayload, HookTool } from './protocol.ts';

// 短生命周期入口。即使上游没有关闭 stdin，也不会一直挡住宿主。
const timer = setTimeout(() => process.exit(0), 500);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 1024 * 1024) process.exit(0);
});
process.stdin.on('end', () => {
  try {
    const args = process.argv.slice(2);
    const tool = args[args.indexOf('--tool') + 1] as HookTool;
    const inbox = args[args.indexOf('--inbox') + 1];
    const name = args[args.indexOf('--event') + 1];
    if (['cc', 'codex'].includes(tool) && inbox) {
      const payload = JSON.parse(input) as HookPayload;
      if (name && args.includes('--event')) payload.hook_event_name = name;
      emitPush(tool, payload, inbox);
    }
  } catch { /* 输入损坏也成功退出，不写错误。 */ }
  clearTimeout(timer);
  process.exit(0);
});
