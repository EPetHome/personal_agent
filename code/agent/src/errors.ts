/** Only explicitly constructed, safe descriptions cross the model/log boundary. */
export class SafeError extends Error {
  constructor(readonly category: string, message: string) { super(message); }
}
export function failure(error: unknown) {
  if (error instanceof SafeError) return { ok: false as const, category: error.category, error: error.message };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const known: Record<string, [string, string]> = {
    ENOENT: ['not_found', '授权范围内路径不存在。'],
    EISDIR: ['is_directory', '这是目录，请使用列目录工具。'],
    ENOTDIR: ['not_directory', '这不是目录。'],
    EACCES: ['read_failed', '系统拒绝访问，未读取成功。'],
    EPERM: ['read_failed', '系统拒绝访问，未读取成功。'],
  };
  const value = code && known[code];
  return value ? { ok: false as const, category: value[0]!, error: value[1]! }
    : { ok: false as const, category: 'unknown', error: '未知异常，未能核实原因；没有自动重试。' };
}
export function cancelled(signal?: AbortSignal) { signal?.throwIfAborted(); }
