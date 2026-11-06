import { Worker } from 'node:worker_threads';
import { extname } from 'node:path';
import { SafeError } from './errors.js';

export const READ_CAPABILITY = { formats: ['UTF-8 纯文本', 'DOCX 正文/表格', 'PDF 文本层（按页）'],
  unsupported: ['OCR/扫描件', '解密', '旧 DOC', 'XLSX', '普通 ZIP', 'Office 编辑'],
  maxSourceBytes: 20 * 1024 * 1024, maxTextBytes: 2 * 1024 * 1024, maxChunkBytes: 64000, maxPages: 100, parseTimeoutMs: 10000 };
export interface Extracted { text: string; format: string; pages?: number; textPages?: number }
function formatOf(data: Buffer, path: string) {
  const ext = extname(path).toLowerCase();
  if (data.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (data.readUInt32LE(0) === 0x04034b50) return 'docx';
  if (data.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
    if (data.includes(Buffer.from('EncryptedPackage', 'utf16le')) && data.includes(Buffer.from('EncryptionInfo', 'utf16le'))) throw new SafeError('protected_document', '加密的 Office 容器，未提取正文；不提供解密。');
    throw new SafeError('unsupported_format', '不支持该 Office 二进制格式（例如旧 DOC）；改后缀不会获得 DOCX 支持。');
  }
  if (ext === '.docx' || ext === '.pdf') throw new SafeError('parse_failed', '文档内容损坏或与格式不符，未提取正文。');
  return 'text';
}
export async function extract(data: Buffer, path: string, signal?: AbortSignal): Promise<Extracted> {
  signal?.throwIfAborted();
  const format = data.length >= 8 ? formatOf(data, path) : ['.pdf', '.docx'].includes(extname(path).toLowerCase()) ? 'invalid' : 'text';
  if (format === 'invalid') throw new SafeError('parse_failed', '文档损坏，未提取正文。');
  if (format === 'text') {
    if (data.length > READ_CAPABILITY.maxTextBytes) throw new SafeError('resource_limit', '纯文本超过读取资源上限，未返回内容。');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new SafeError('unsupported_format', '不支持该格式；不是有效的 UTF-8 纯文本，未返回原始二进制字节。'); }
    if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new SafeError('unsupported_format', '不支持该二进制格式，未作为正文读取。');
    return { text, format: 'text' };
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-worker.js', import.meta.url), { workerData: { data, format },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true });
    // Parser diagnostics may contain document contents. Never forward stdout/stderr.
    worker.stdout?.resume(); worker.stderr?.resume();
    let finished = false;
    const end = (error?: unknown, value?: Extracted) => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate(); error ? reject(error) : resolve(value!);
    };
    const abort = () => end(signal?.reason ?? new Error('cancelled'));
    const timer = setTimeout(() => end(new SafeError('resource_limit', '文档解析超过时间上限，未提取正文。')), READ_CAPABILITY.parseTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: { value?: Extracted; category?: string }) => {
      const errors: Record<string, string> = { protected_document: '文件受保护或加密，未提取正文；不提供解密。',
        resource_limit: '文档超过页数、解压或正文资源上限，未提取正文。',
        no_text: '没有可提取的文本层（可能是扫描件）；当前不支持 OCR，未提取正文。',
        unsupported_format: '不支持该格式（例如 XLSX/普通 ZIP），未提取正文。', parse_failed: '文档损坏或解析失败，未提取正文。' };
      if (message.value) end(undefined, message.value);
      else { const category = message.category && errors[message.category] ? message.category : 'parse_failed'; end(new SafeError(category, errors[category]!)); }
    });
    worker.once('error', () => end(new SafeError('parse_failed', '文档解析失败或资源不足，未提取正文。')));
    worker.once('exit', () => end(new SafeError('parse_failed', '文档解析中断，未提取正文。')));
  });
}
export function textChunk(text: string, offset: number, length: number) {
  const data = Buffer.from(text), start = Math.max(0, Math.floor(offset));
  let end = Math.min(data.length, start + Math.min(READ_CAPABILITY.maxChunkBytes, Math.max(1, Math.floor(length))));
  let begin = Math.min(start, data.length);
  while (begin < data.length && (data[begin]! & 0xc0) === 0x80) begin++;
  while (end > begin && end < data.length && (data[end]! & 0xc0) === 0x80) end--;
  if (end <= begin && begin < data.length) {
    end = begin + 1;
    while (end < data.length && (data[end]! & 0xc0) === 0x80) end++;
  }
  return { content: data.subarray(begin, end).toString('utf8'), offset: begin, nextOffset: end, totalTextBytes: data.length, truncated: end < data.length };
}
