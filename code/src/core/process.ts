import { execFile } from 'node:child_process';

/** 不经 shell；调用者决定如何降级，外部 stderr（可能带敏感数据）不进入记录。 */
export function runCommand(executable: string, args: string[], timeoutMs: number, input?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { encoding: 'utf8', timeout: timeoutMs, signal, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('组件命令失败或超时'));
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
