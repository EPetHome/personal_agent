import { deflateSync, deflateRawSync } from 'node:zlib';
// Constructed 1x1 pixels; no user image or document contents.
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
export const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJVAA//Z';
export function zip(entries: Record<string, string | Buffer>, compressed = false) {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [path, value] of Object.entries(entries)) {
    const name = Buffer.from(path), data = Buffer.from(value), packed = compressed ? deflateRawSync(data) : data;
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt16LE(compressed ? 8 : 0, 8); l.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 14); l.writeUInt32LE(packed.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    local.push(l, name, packed);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(compressed ? 8 : 0, 10); c.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42); central.push(c, name);
    offset += l.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export const DOCX = zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>BODY-构造段落</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>CELL-A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CELL-B</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>TAIL-顺序</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
});
export const XLSX = zip({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fixture" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>XLSX-NOT-TEXT</t></is></c></row></sheetData></worksheet>',
});
/** Minimal real PDF: ordered text pages, or a page with a raster-only image. */
export function pdfFixture(scan = false, pages = 2) {
  const objects: Buffer[] = [], add = (value: string | Buffer) => { objects.push(Buffer.from(value)); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add(''); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const ids: number[] = [];
  for (let n = 1; n <= pages; n++) {
    const pageId = objects.length + 1, contentId = pageId + 1, imageId = contentId + 1; ids.push(pageId);
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> ${scan ? `/XObject << /Im1 ${imageId} 0 R >>` : ''} >> /Contents ${contentId} 0 R >>`);
    const content = scan ? 'q 100 0 0 100 0 0 cm /Im1 Do Q' : `BT /F1 12 Tf 20 260 Td (PAGE-${n}-FIRST) Tj 0 -20 Td (PAGE-${n}-SECOND) Tj ET`;
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    if (scan) { const pixel = deflateSync(Buffer.from([0x55])); add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixel.length} >>\nstream\n`), pixel, Buffer.from('\nendstream')])); }
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${ids.length} /Kids [${ids.map(n => `${n} 0 R`).join(' ')}] >>`);
  let bytes = Buffer.from('%PDF-1.7\n'), offsets = [0];
  for (const [n, object] of objects.entries()) { offsets.push(bytes.length); bytes = Buffer.concat([bytes, Buffer.from(`${n + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); }
  const xref = bytes.length;
  return Buffer.concat([bytes, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
}
