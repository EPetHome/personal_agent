import { execFile } from 'node:child_process';
import { delimiter, dirname } from 'node:path';

/** Node 目录始终优先；不传继承值时仅含 Node 和固定系统目录，供 plist 使用。 */
export function componentPath(inheritedPath = ''): string {
  const system = process.platform === 'win32' ? [] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set([dirname(process.execPath), ...inheritedPath.split(delimiter).filter(Boolean), ...system])].join(delimiter);
}

/** 不经 shell；调用者决定如何降级，外部 stderr（可能带敏感数据）不进入记录。 */
export function runCommand(executable: string, args: string[], timeoutMs: number, input?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: componentPath(process.env.PATH) };
    delete env.FEISHU_APP_ID; delete env.FEISHU_APP_SECRET;
    const child = execFile(executable, args, { env, encoding: 'utf8', timeout: timeoutMs, signal, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('组件命令失败或超时'));
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
