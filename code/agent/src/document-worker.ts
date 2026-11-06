import { parentPort, workerData } from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { READ_CAPABILITY, type Extracted } from './documents.js';

class ParseError extends Error { constructor(readonly category: string) { super(category); } }
const limit = () => { throw new ParseError('resource_limit'); };
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Only bounded, selected ZIP members are inflated; no filesystem extraction. */
function docx(data: Buffer): Extracted {
  let end = -1;
  for (let p = data.length - 22; p >= Math.max(0, data.length - 65557); p--) if (data.readUInt32LE(p) === 0x06054b50 && p + 22 + data.readUInt16LE(p + 20) === data.length) { end = p; break; }
  if (end < 0) throw new ParseError('parse_failed');
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), central = data.readUInt32LE(end + 16);
  if (count > 512 || count === 0xffff || central + size > end) limit();
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) throw new ParseError('unsupported_format');
  let p = central, total = 0;
  const members = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > central + size || data.readUInt32LE(p) !== 0x02014b50) throw new ParseError('parse_failed');
    const flags = data.readUInt16LE(p + 8), method = data.readUInt16LE(p + 10), crc = data.readUInt32LE(p + 16), compressed = data.readUInt32LE(p + 20), original = data.readUInt32LE(p + 24);
    const nameLength = data.readUInt16LE(p + 28), extra = data.readUInt16LE(p + 30), comment = data.readUInt16LE(p + 32), local = data.readUInt32LE(p + 42);
    if (p + 46 + nameLength + extra + comment > central + size) throw new ParseError('parse_failed');
    const name = data.toString('utf8', p + 46, p + 46 + nameLength); p += 46 + nameLength + extra + comment;
    total += original;
    if (total > 32 * 1024 * 1024 || original > 8 * 1024 * 1024 || compressed > READ_CAPABILITY.maxSourceBytes) limit();
    if (flags & 1) throw new ParseError('protected_document');
    if (!['[Content_Types].xml', 'word/document.xml', 'word/settings.xml'].includes(name)) continue;
    if (members.has(name) || local + 30 > central || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method) throw new ParseError('parse_failed');
    const localNameLength = data.readUInt16LE(local + 26), start = local + 30 + localNameLength + data.readUInt16LE(local + 28);
    if (data.toString('utf8', local + 30, local + 30 + localNameLength) !== name || start + compressed > central) throw new ParseError('parse_failed');
    const packed = data.subarray(start, start + compressed);
    let value: Buffer;
    try { value = method === 0 ? packed : method === 8 ? inflateRawSync(packed, { maxOutputLength: 8 * 1024 * 1024 }) : Buffer.alloc(0); }
    catch { throw new ParseError('parse_failed'); }
    if (value.length !== original || crc32(value) !== crc) throw new ParseError('parse_failed');
    members.set(name, value);
  }
  if (!members.get('[Content_Types].xml')?.includes(Buffer.from('wordprocessingml.document.main+xml')) || !members.has('word/document.xml')) throw new ParseError('unsupported_format');
  let text = '', inText = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new ParseError('unsupported_format'); });
  parser.on('opentag', tag => {
    if (!['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'].includes(tag.uri)) return;
    if (tag.local === 't') inText++;
    if (tag.local === 'tab') text += '\t';
    if (['br', 'cr'].includes(tag.local)) text += '\n';
  });
  parser.on('text', value => { if (inText) { text += value; if (Buffer.byteLength(text) > READ_CAPABILITY.maxTextBytes) limit(); } });
  parser.on('closetag', tag => {
    if (!['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'].includes(tag.uri)) return;
    if (tag.local === 't') inText--;
    if (tag.local === 'tc') text += '\t';
    if (['p', 'tr'].includes(tag.local)) text += '\n';
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(members.get('word/document.xml')!)).close();
  if (!text.trim()) throw new ParseError('no_text');
  if (Buffer.byteLength(text) > READ_CAPABILITY.maxTextBytes) limit();
  return { text, format: 'docx' };
}
async function pdf(data: Buffer): Promise<Extracted> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true, verbosity: 0 });
  try {
    const document = await task.promise;
    if (document.numPages > READ_CAPABILITY.maxPages) limit();
    let text = '', textPages = 0;
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n), content = await page.getTextContent();
      let part = '';
      for (const item of content.items) if ('str' in item) part += item.str + (item.hasEOL ? '\n' : ' ');
      if (part.trim()) textPages++;
      text += `\n[第 ${n} 页]\n${part}`;
      if (Buffer.byteLength(text) > READ_CAPABILITY.maxTextBytes) limit();
      page.cleanup();
    }
    if (!textPages) throw new ParseError('no_text');
    return { text, format: 'pdf', pages: document.numPages, textPages };
  } catch (error) {
    if ((error as Error)?.name === 'PasswordException') throw new ParseError('protected_document');
    throw error;
  } finally { await task.destroy(); }
}
try {
  const data = Buffer.from(workerData.data);
  if (data.length > READ_CAPABILITY.maxSourceBytes) limit();
  const value = workerData.format === 'pdf' ? await pdf(data) : docx(data);
  parentPort!.postMessage({ value });
} catch (error) { parentPort!.postMessage({ category: error instanceof ParseError ? error.category : 'parse_failed' }); }
