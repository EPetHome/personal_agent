import { SafeError } from './errors.js';

export const IMAGE_FORMATS = ['PNG', 'JPEG', 'GIF', 'WebP'];
/** Identify bytes, never an upstream MIME or filename. Reject truncated envelopes. */
export function imageType(data: Buffer): { mime: string; extension: string } {
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0) {
    let p = 8, pixels = false;
    while (p + 12 <= data.length) {
      const size = data.readUInt32BE(p), end = p + 12 + size;
      if (end > data.length) break;
      let crc = 0xffffffff;
      for (const byte of data.subarray(p + 4, end - 4)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
      if (((crc ^ 0xffffffff) >>> 0) !== data.readUInt32BE(end - 4)) break;
      const chunk = data.toString('ascii', p + 4, p + 8);
      if (chunk === 'IDAT') pixels = true;
      if (chunk === 'IEND' && size === 0 && pixels && end === data.length) return { mime: 'image/png', extension: '.png' };
      p = end;
    }
  }
  if (data.length > 12 && data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data.at(-1) === 0xd9) {
    let p = 2, dimensions = false;
    while (p + 4 < data.length) {
      if (data[p++] !== 0xff) break;
      while (data[p] === 0xff) p++;
      if (p + 3 >= data.length) break;
      const marker = data[p++]!;
      if (marker === 0xda && dimensions) return { mime: 'image/jpeg', extension: '.jpg' };
      const size = data.readUInt16BE(p);
      if (size < 2 || p + size > data.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8 && data.readUInt16BE(p + 3) > 0 && data.readUInt16BE(p + 5) > 0) dimensions = true;
      p += size;
    }
  }
  if (data.length >= 14 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6)) && data.readUInt16LE(6) && data.readUInt16LE(8) && data.at(-1) === 0x3b) return { mime: 'image/gif', extension: '.gif' };
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16))) return { mime: 'image/webp', extension: '.webp' };
  throw new SafeError('unsupported_image', '未识别为完整的受支持图片（PNG/JPEG/GIF/WebP）；未作为图片发送给模型。');
}
