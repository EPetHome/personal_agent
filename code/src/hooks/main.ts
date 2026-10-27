import { installListener, uninstallListener } from './install.ts';
import type { InstallOptions } from './install.ts';
import type { HookTool } from './protocol.ts';
import { errorMessage } from '../core/utils.ts';

async function main() {
  const args = process.argv.slice(2);
  const action = args.shift();
  if (action === '--help' || action === '-h') {
    console.log('用法：node code/src/hooks/main.ts <install|uninstall> --tool <cc|codex|pi> --home <目标主目录> [--inbox <绝对推送目录>] [--command <插件管理可执行文件>] [--node <Node可执行文件>]\ninstall 必须提供 --inbox；所有目标都显式指定，不默认使用真实主目录。');
    return;
  }
  if (!['install', 'uninstall'].includes(action ?? '')) throw new Error('操作应为 install 或 uninstall，详见 --help');
  const values = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!;
    const value = args.shift();
    if (!['--tool', '--home', '--inbox', '--command', '--node'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('安装参数缺失、重复或无效');
    values.set(key, value);
  }
  const options: InstallOptions = { tool: values.get('--tool') as HookTool, home: values.get('--home') ?? '',
    inboxDir: values.get('--inbox'), command: values.get('--command'), node: values.get('--node') };
  if (action === 'install') {
    const backup = await installListener(options);
    console.log(`已安装 message-listener；配置备份：${backup}`);
  } else { await uninstallListener(options); console.log('已卸载 message-listener，只移除本程序条目，保留你的其他设置。'); }
}
main().catch(error => { console.error(`错误：${errorMessage(error)}`); process.exitCode = 1; });
