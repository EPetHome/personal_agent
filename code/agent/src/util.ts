import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const inside = (root: string, path: string) => { const d = relative(root, path); return d === '' || d !== '..' && !d.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(d); };
export async function canonical(path: string): Promise<string> {
  path = resolve(path);
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}
export async function atomicJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
export function parseJson<T = unknown>(text: string): T {
  try { return JSON.parse(text) as T; } catch { throw new Error('JSON 格式无效（未复述原文）'); }
}
export function parseUrl(value: string): URL {
  try { return new URL(value); } catch { throw new Error('URL 格式无效（未复述地址）'); }
}
export async function jsonFile<T>(path: string): Promise<T> { return parseJson<T>(await readFile(path, 'utf8')); }
export function localUrl(value: string): boolean { const url = parseUrl(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); }
export async function post(url: string, value: unknown, timeoutMs = 10000, signal?: AbortSignal) {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(value), headers: { 'content-type': 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`Channel HTTP ${r.status}`);
  return r.json() as Promise<{ id: string }>;
}
// UTF-8 bytes are a conservative upper bound on byte-BPE tokens, not chars/4.
// No extra tokenizer dependency; never under-budget Chinese, emoji or code.
export const tokenBudget = (text: string) => Buffer.byteLength(text, 'utf8') + 8;
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export function safeName(name: string) { return basename(name).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 120) || 'attachment'; }
