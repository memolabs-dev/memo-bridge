// Media fixtures for operator_read_media: a minimal multi-page PDF with text (valid xref), a PNG of
// any size (flat or noise), a 1x1 GIF and WebP headers.
import { crc32, deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
// RGB PNG, flat grey or random noise (noise does not compress: the file is about w*h*3 bytes).
export function makePng(width, height, { noise = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = width * 3 + 1;
  const raw = noise ? randomBytes(row * height) : Buffer.alloc(row * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * row] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: noise ? 0 : 6 })), chunk('IEND', Buffer.alloc(0))]);
}
export const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
// A WebP (VP8X) header for 640x480: enough for type and size detection.
export function webpHeader(width = 640, height = 480) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16); b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
}

// Minimal multi-page PDF with text, valid xref.
export function makePdf(pages) {
  const objs = [];
  const add = s => { objs.push(s); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const parentId = pages.length * 2 + 2 + 1; // computed after
  const kids = [];
  const contents = pages.map(t => `BT /F1 24 Tf 72 700 Td (${t}) Tj ET`);
  const pagesObjIndex = 1 + pages.length * 2 + 1;
  for (const c of contents) {
    const cid = add(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
    const pid = add(`<< /Type /Page /Parent ${pagesObjIndex} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${cid} 0 R >>`);
    kids.push(pid);
  }
  const pagesId = add(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  if (pagesId !== pagesObjIndex) throw new Error('index');
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
