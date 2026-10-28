import { ComponentFailure } from './process.ts';

export interface SafeFailure { category: string; reason: string }

/** 只携带程序定义的类别；渠道不得持久化或回传未知错误原文。 */
export class OperationFailure extends Error {
  readonly category: string;
  constructor(category: string, message: string) { super(message); this.category = category; }
}

const reasons: Record<string, string> = {
  notice_not_found: '找不到这条提醒，请打开最新卡片再试。',
  invalid_feedback: '反馈请用「正确 / 误报 / 漏了」；正确和误报须关联一条提醒。',
  lock_busy: '记录文件正被其他操作占用，这次操作尚未确认完成；请检查本机服务。',
  lock_timeout: '等待记录文件超时，这次操作尚未确认完成；请检查本机服务。',
  data_corrupt: '记录文件不完整或已损坏，请先备份，再恢复记录。',
  unsafe_file: '记录文件不是安全的普通文件，已保留现场，请检查本机数据目录。',
  storage_full: '本机存储空间不足，请清理空间后检查记录。',
  storage_permission: '没有权限读写本机记录，请检查数据目录权限。',
  storage_readonly: '本机记录所在磁盘只读，请检查磁盘状态。',
  storage_io: '本机读写记录出错，请检查磁盘和数据目录。',
  unexpected: '处理时遇到未识别的问题，已保留收件和失败记录，请检查本机服务。',
  channel_pending: '渠道尚未确认成功投递。',
  channel_timeout: '渠道发送超时。',
  channel_connection: '渠道连接失败，请检查网络、DNS 或代理。',
  channel_rejected: '渠道拒收，请检查应用权限、收件人或卡片格式。',
  channel_credentials: '渠道凭证不正确或缺失，请检查本机配置。',
  channel_permission: '渠道权限不足，请检查应用发布与权限。',
  channel_configuration: '渠道配置不可用，请检查本机配置。',
  channel_process: '本机通知命令未能成功执行。',
  channel_unknown: '渠道发送失败，现有信息无法细分原因。',
  legacy_unknown: '旧版未记录发送失败原因。',
  delivery_history_unknown: '历史发送失败次数尚未恢复，已暂停发送；请检查归档和本机服务。',
};
export function safeProcessingFailure(error: unknown): SafeFailure {
  let category: string;
  if (error instanceof OperationFailure && Object.hasOwn(reasons, error.category)) category = error.category;
  else {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    category = code === 'ENOSPC' || code === 'EDQUOT' ? 'storage_full'
      : code === 'EACCES' || code === 'EPERM' ? 'storage_permission'
        : code === 'EROFS' ? 'storage_readonly'
          : code && ['EIO', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENFILE'].includes(code) ? 'storage_io' : 'unexpected';
  }
  return { category, reason: reasons[category]! };
}
export function isSafeFailure(value: unknown): value is SafeFailure {
  if (!value || typeof value !== 'object') return false;
  const failure = value as SafeFailure;
  return typeof failure.category === 'string' && Object.hasOwn(reasons, failure.category) && failure.reason === reasons[failure.category];
}
/** 只从受控异常和结构化状态识别；返回值绝不复制错误、响应或卡片正文。 */
export function safeDeliveryFailure(error: unknown): SafeFailure {
  const processing = safeProcessingFailure(error);
  if (processing.category !== 'unexpected') return processing;
  const failure = (category: string) => safeProcessingFailure(new OperationFailure(category, ''));
  if (error instanceof ComponentFailure) return failure(error.category === 'timeout' ? 'channel_timeout' : 'channel_process');
  const data = error as { code?: string; name?: string; status?: number; response?: { status?: number } } | null;
  const code = data?.code ?? '', status = data?.response?.status ?? data?.status;
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)
    || ['TimeoutError', 'AbortError'].includes(data?.name ?? '')) return failure('channel_timeout');
  if (/^(?:EAI_AGAIN|E[A-Z]*(?:CONN|NET|HOST)[A-Z]*|ENOTFOUND|UND_ERR_SOCKET)$/.test(code)) return failure('channel_connection');
  if (status === 401) return failure('channel_credentials');
  if (status === 403) return failure('channel_permission');
  if (status && status >= 400) return failure('channel_rejected');
  // 某些 SDK 只给超时 message；只在内存识别固定模式，仍不返回任何原文。
  const message = typeof error === 'string' ? error : (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && /\b(?:timeout|timed out)\b|(?:发送|投递|连接|请求).{0,8}超时/i.test(message)) return failure('channel_timeout');
  return failure('channel_unknown');
}
