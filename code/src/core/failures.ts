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
};
export function safeProcessingFailure(error: unknown): { category: string; reason: string } {
  let category: string;
  if (error instanceof OperationFailure && reasons[error.category]) category = error.category;
  else {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    category = code === 'ENOSPC' || code === 'EDQUOT' ? 'storage_full'
      : code === 'EACCES' || code === 'EPERM' ? 'storage_permission'
        : code === 'EROFS' ? 'storage_readonly'
          : code && ['EIO', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENFILE'].includes(code) ? 'storage_io' : 'unexpected';
  }
  return { category, reason: reasons[category]! };
}
