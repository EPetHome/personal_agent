import { createHash } from 'node:crypto';
import { readSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { JsonObject } from './utils.ts';
import type { SessionIdentity, SourceComponent } from './types.ts';

/** 每次遍历从同一只读 fd 的 0 位开始；内存仅含当前行，不连接整份原件。 */
export class SourceReader {
  fingerprint = '';
  error: Error | undefined;
  identity: SessionIdentity | null = null;
  lastRecordAt: string | undefined;
  readonly sessionIds = new Set<string>();
  hasCoreRows = false;
  private complete = false;
  private jsonChecked = false;
  private headers = new Map<string, string>();
  private handle: FileHandle;
  private component: SourceComponent;
  constructor(handle: FileHandle, component: SourceComponent) { this.handle = handle; this.component = component; }

  lines(): Iterable<string> { return { [Symbol.iterator]: () => this.readLines() }; }
  rows(): Iterable<JsonObject> { return { [Symbol.iterator]: () => this.readRows() }; }
  /** 早退/抛错后仍校验完整 JSONL；文本只补齐指纹，不保留剩余正文。 */
  finish(): void {
    if (this.component.extension === '.jsonl') {
      if (!this.jsonChecked) for (const _ of this.readRows()) { /* 逐行校验并丢弃正文 */ }
    } else if (!this.complete) for (const _ of this.readLines()) { /* Markdown 不按 JSON 校验 */ }
  }

  private *readLines(): Generator<string> {
    this.complete = false;
    this.jsonChecked = false;
    const digest = createHash('sha256');
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    const fragments: string[] = [];
    while (true) {
      const bytes = readSync(this.handle.fd, buffer, 0, buffer.length, position);
      if (!bytes) break;
      position += bytes;
      digest.update(buffer.subarray(0, bytes));
      const chunk = decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      let end: number;
      while ((end = chunk.indexOf('\n', start)) !== -1) {
        fragments.push(chunk.slice(start, end));
        const line = fragments.join('');
        fragments.length = 0;
        start = end + 1;
        this.observeHeader(line);
        yield line;
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
    }
    const tail = decoder.end();
    if (tail) fragments.push(tail);
    if (fragments.length) {
      const line = fragments.join('');
      this.observeHeader(line);
      yield line;
    }
    this.fingerprint = digest.digest('hex');
    this.complete = true;
  }
  private observeHeader(line: string): void {
    if (this.component.extension !== '.md') return;
    const key = line.match(/^- (项目|开发会话)[：:]/)?.[1];
    if (key && !this.headers.has(key)) {
      this.headers.set(key, line);
      this.identity = this.component.identify?.([...this.headers.values()].join('\n')) ?? null;
    }
  }
  private *readRows(): Generator<JsonObject> {
    let lineNumber = 0;
    for (const line of this.readLines()) {
      lineNumber++;
      if (!line.trim()) continue;
      let row: JsonObject;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        row = value as JsonObject;
      } catch {
        this.error ??= new Error(`第 ${lineNumber} 行无法解析为 JSON`);
        continue; // 不把损坏前缀当正常结果：调用方在完整遍历后检查 error。
      }
      if (typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp))) {
        const at = new Date(row.timestamp).toISOString();
        if (!this.lastRecordAt || at > this.lastRecordAt) this.lastRecordAt = at;
      }
      if (this.component.isCoreRow?.(row)) this.hasCoreRows = true;
      const identity = this.component.identifyRow?.(row) ?? null;
      const sessionId = this.component.sessionIdOf?.(row) ?? identity?.sessionId;
      if (sessionId) this.sessionIds.add(sessionId);
      this.identity ??= identity;
      yield row;
    }
    this.jsonChecked = true;
  }
}
