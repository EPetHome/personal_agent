import { execFile } from 'node:child_process';
import { delimiter, dirname } from 'node:path';

/** Node 目录始终优先；不传继承值时仅含 Node 和固定系统目录，供 plist 使用。 */
export function componentPath(inheritedPath = ''): string {
  const system = process.platform === 'win32' ? [] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set([dirname(process.execPath), ...inheritedPath.split(delimiter).filter(Boolean), ...system])].join(delimiter);
}

export type FailureCategory = 'timeout' | 'exit' | 'spawn' | 'output_limit' | 'cancelled' | 'parse' | 'invalid_answer' | 'unknown';
/** 只携带受控类别/说明，绝不保存命令、stdout、stderr 或原始异常。 */
export class ComponentFailure extends Error {
  category: FailureCategory;
  constructor(category: FailureCategory, detail: string) { super(detail); this.category = category; }
}
export function safeFailure(error: unknown): { category: FailureCategory; detail: string } {
  return error instanceof ComponentFailure ? { category: error.category, detail: error.message }
    : { category: 'unknown', detail: '判断器调用异常（未保存原始错误）' };
}

/** 不经 shell；调用者决定如何降级，外部 stderr（可能带敏感数据）不进入记录。 */
export function runCommand(executable: string, args: string[], timeoutMs: number, input?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: componentPath(process.env.PATH) };
    delete env.FEISHU_APP_ID; delete env.FEISHU_APP_SECRET;
    const child = execFile(executable, args, { env, encoding: 'utf8', timeout: timeoutMs, signal, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (!error) { resolve(stdout); return; }
      const code = error.code;
      if (error.name === 'AbortError') reject(new ComponentFailure('cancelled', '本轮时限到达，已取消调用'));
      else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new ComponentFailure('output_limit', '命令输出超过大小上限'));
      else if (error.killed) reject(new ComponentFailure('timeout', '命令调用超时'));
      else if (typeof code === 'number') reject(new ComponentFailure('exit', `命令退出码 ${code}`));
      else reject(new ComponentFailure('spawn', '命令无法启动或被信号终止'));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
