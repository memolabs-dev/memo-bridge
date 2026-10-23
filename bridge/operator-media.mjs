// operator_read_media (T0, repatriated SentinelX read_media, spec D2): images and PDF pages a
// ChatGPT conversation can look at.
//
//  - the type comes from the file's magic bytes, never its name: png, jpeg, gif, webp, pdf;
//  - the file is read once through a descriptor opened with O_NOFOLLOW (after the read roots and
//    the secret denylist), then only that copy is converted, in a private temporary directory:
//    a path swapped after the check is never what gets rendered;
//  - images under the byte budget travel as they are; larger ones are downscaled with sips on the
//    Mac (fixed argv); elsewhere they are refused (too_large) unless a resizer exists;
//  - PDF pages are rendered and their text extracted: on the Mac by PDFKit through
//    `osascript -l JavaScript` (a fixed script in this file, the copy's path as an argument), on
//    lab by pdftoppm and pdftotext (poppler-utils) when installed, else pdf_tools_unavailable;
//  - bounds: image file 20 MiB, PDF file 50 MiB, 5 pages per call, dpi 36 to 150, images of one
//    result at most MEDIA_BUDGET_BYTES (pages that do not fit come back as next_page), 8 KiB of
//    text per page.
// The image bytes travel in `media` ([{mime, base64, ...}]); the agent passes that field through
// without the text redactor (it would corrupt them) and the hub and the remote surface turn it
// into MCP image content next to a text part. OpenAI support (community forum, 2026-04-22) says a
// ChatGPT connector does not guarantee that an image block becomes model-visible input, so the
// text part always carries the metadata and, for PDFs, the extracted text.
import { constants as fsConstants } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDenylist, resolveOperatorPath } from './operator-paths.mjs';
import { SAFE_ENV, runArgv } from './operator-tools.mjs';
import { untrusted } from './operator-output.mjs';

export const MEDIA_LIMITS = Object.freeze({ imageFileBytes: 20 * 1024 * 1024, pdfFileBytes: 50 * 1024 * 1024, pagesPerCall: 5,
  dpiMin: 36, dpiMax: 150, dpiDefault: 100, textPerPage: 8 * 1024, timeoutMs: 30_000, resizeSteps: [1600, 1200, 800] });
// Raw image bytes in one result: base64 makes it about 750 KiB, under the 1 MiB wire result cap
// with room for the text part.
export const MEDIA_BUDGET_BYTES = 560 * 1024;
export const PAGES_RE = /^(\d{1,4})(?:-(\d{1,4}))?$/;

// PDFKit through JavaScript for Automation (macOS). Modes:
//   text <pdf> <first> <last>            -> {pages, text:[...]}
//   render <pdf> <page> <dpi> <out.png>  -> {pages, width, height}
const PDFKIT_SCRIPT = [
  "ObjC.import('PDFKit'); ObjC.import('AppKit');",
  'function run(argv) {',
  '  var mode = argv[0];',
  '  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[1]));',
  "  if (!doc || doc.isNil()) return JSON.stringify({error: 'unreadable'});",
  "  if (doc.isLocked) return JSON.stringify({error: 'encrypted'});",
  '  var n = Number(doc.pageCount);',
  "  if (mode === 'text') {",
  '    var first = Number(argv[2]), last = Math.min(Number(argv[3]), n), out = [];',
  '    for (var i = first; i <= last; i++) { var s = doc.pageAtIndex(i - 1).string; out.push(s && !s.isNil() ? ObjC.unwrap(s) : \'\'); }',
  '    return JSON.stringify({pages: n, text: out});',
  '  }',
  "  if (mode === 'render') {",
  '    var p = Number(argv[2]), dpi = Number(argv[3]);',
  "    if (p < 1 || p > n) return JSON.stringify({error: 'page_out_of_range', pages: n});",
  '    var page = doc.pageAtIndex(p - 1), box = page.boundsForBox($.kPDFDisplayBoxMediaBox);',
  '    var w = Math.max(1, Math.round(box.size.width * dpi / 72)), h = Math.max(1, Math.round(box.size.height * dpi / 72));',
  '    var img = page.thumbnailOfSizeForBox($.NSMakeSize(w, h), $.kPDFDisplayBoxMediaBox);',
  '    var rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);',
  '    var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());',
  "    if (!png.writeToFileAtomically(argv[4], true)) return JSON.stringify({error: 'render_failed'});",
  '    return JSON.stringify({pages: n, width: w, height: h});',
  '  }',
  "  return JSON.stringify({error: 'mode'});",
  '}'
].join('\n');

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// {kind, mime} from the first bytes, or null.
export function sniffMedia(head) {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png' };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return { kind: 'image', mime: 'image/gif' };
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { kind: 'image', mime: 'image/webp' };
  }
  if (head.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return { kind: 'pdf', mime: 'application/pdf' };
  return null;
}

// Width and height from the header, or nulls. PNG IHDR, GIF screen, JPEG SOFn, WebP VP8/VP8L/VP8X.
export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/jpeg') {
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (mime === 'image/webp') {
      const chunk = buf.subarray(12, 16).toString('latin1');
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  } catch { /* short or odd header */ }
  return { width: null, height: null };
}

export function createMediaTool(policy, { run = runArgv, platform = process.platform } = {}) {
  const denylist = createDenylist(policy);
  const resolve = raw => resolveOperatorPath(policy, raw, { access: 'r', denylist });
  const exec = argv => run(argv, { timeoutMs: MEDIA_LIMITS.timeoutMs, maxBytes: 4 * 1024 * 1024, env: SAFE_ENV });
  const parseJson = text => { try { return JSON.parse(text.trim().split('\n').pop()); } catch { return null; } };

  // Read the whole file through one O_NOFOLLOW descriptor, at most `max` bytes.
  async function readOnce(path, max) {
    let fh;
    try { fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0)); } catch (error) {
      return fail(error?.code === 'EACCES' ? 'permission_denied' : error?.code === 'ELOOP' ? 'path_changed' : 'unreadable');
    }
    try {
      const info = await fh.stat();
      if (!info.isFile()) return fail('not_a_file');
      if (info.size > max) return fail('too_large', { bytes: info.size, max_bytes: max });
      const buf = Buffer.alloc(info.size);
      let got = 0;
      while (got < info.size) { const { bytesRead } = await fh.read(buf, got, info.size - got, got); if (!bytesRead) break; got += bytesRead; }
      return { ok: true, buf: buf.subarray(0, got), mtime: info.mtime.toISOString() };
    } finally { await fh.close(); }
  }

  async function image(at, buf, mime, base) {
    const dims = imageSize(buf, mime);
    if (buf.length <= MEDIA_BUDGET_BYTES) {
      return { ...base, kind: 'image', mime, ...dims, media: [{ mime, base64: buf.toString('base64'), ...dims }] };
    }
    if (platform !== 'darwin') {
      return fail('too_large', { bytes: buf.length, budget_bytes: MEDIA_BUDGET_BYTES, detail: 'no image resizer on this host: operator_transfer it to the Mac' });
    }
    const dir = await mkdtemp(join(tmpdir(), 'memo-media-'));
    try {
      const src = join(dir, 'source');
      await writeFile(src, buf, { mode: 0o600 });
      for (const px of MEDIA_LIMITS.resizeSteps) {
        const out = join(dir, `out-${px}.jpg`);
        const r = await exec(['sips', '-Z', String(px), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', src, '--out', out]);
        if (r.code === null) return fail('resizer_unavailable');
        if (r.code !== 0) return fail('resize_failed', { exit_code: r.code });
        const small = await readFile(out);
        if (small.length <= MEDIA_BUDGET_BYTES) {
          const size = imageSize(small, 'image/jpeg');
          return { ...base, kind: 'image', mime, ...dims, resized: { max_px: px, mime: 'image/jpeg', bytes: small.length },
            media: [{ mime: 'image/jpeg', base64: small.toString('base64'), ...size }] };
        }
      }
      return fail('too_large', { bytes: buf.length, budget_bytes: MEDIA_BUDGET_BYTES });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  async function pdf(at, buf, base, { first, last, dpi }) {
    const dir = await mkdtemp(join(tmpdir(), 'memo-media-'));
    try {
      const src = join(dir, 'source.pdf');
      await writeFile(src, buf, { mode: 0o600 });
      const mac = platform === 'darwin';
      let total; let texts;
      if (mac) {
        const r = await exec(['osascript', '-l', 'JavaScript', '-e', PDFKIT_SCRIPT, 'text', src, String(first), String(last)]);
        if (r.code === null) return fail('pdf_tools_unavailable');
        const out = parseJson(r.stdout);
        if (!out || out.error) return fail(out?.error === 'encrypted' ? 'pdf_encrypted' : 'pdf_unreadable');
        total = Number(out.pages); texts = out.text;
      } else {
        const info = await exec(['pdfinfo', src]);
        if (info.code === null) return fail('pdf_tools_unavailable', { detail: 'install poppler-utils on this host (pdfinfo, pdftotext, pdftoppm)' });
        if (info.code !== 0) return fail(/Incorrect password|encrypted/i.test(info.stderr) ? 'pdf_encrypted' : 'pdf_unreadable');
        total = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1] ?? 0);
        texts = [];
        for (let p = first; p <= Math.min(last, total); p++) {
          const t = await exec(['pdftotext', '-f', String(p), '-l', String(p), '-layout', '-enc', 'UTF-8', src, '-']);
          texts.push(t.code === 0 ? t.stdout : '');
        }
      }
      if (!Number.isInteger(total) || total < 1) return fail('pdf_unreadable');
      if (first > total) return fail('page_out_of_range', { pages_total: total });
      const lastPage = Math.min(last, total);
      const media = []; const text = []; let used = 0; let nextPage = null;
      for (let p = first; p <= lastPage; p++) {
        const raw = String(texts[p - first] ?? '');
        text.push({ page: p, text: raw.length > MEDIA_LIMITS.textPerPage ? `${raw.slice(0, MEDIA_LIMITS.textPerPage)}\n[... page text cut ...]` : raw });
        let png = null; let omitted = null;
        for (const scale of [1, 0.6]) {
          const d = Math.max(MEDIA_LIMITS.dpiMin, Math.round(dpi * scale));
          const out = join(dir, `page-${p}-${d}`);
          const r = mac
            ? await exec(['osascript', '-l', 'JavaScript', '-e', PDFKIT_SCRIPT, 'render', src, String(p), String(d), `${out}.png`])
            : await exec(['pdftoppm', '-f', String(p), '-l', String(p), '-r', String(d), '-png', '-singlefile', src, out]);
          if (r.code !== 0) { omitted = 'render_failed'; break; }
          const bytes = await readFile(`${out}.png`).catch(() => null);
          if (!bytes) { omitted = 'render_failed'; break; }
          if (bytes.length <= MEDIA_BUDGET_BYTES - used) { png = { bytes, dpi: d }; break; }
          omitted = 'over_budget';
        }
        if (png) {
          used += png.bytes.length;
          media.push({ mime: 'image/png', base64: png.bytes.toString('base64'), page: p, dpi: png.dpi, ...imageSize(png.bytes, 'image/png') });
        } else if (omitted === 'over_budget' && media.length) {
          // The rest of the range comes with the next call; the text of this page is kept.
          nextPage = p; text.pop();
          break;
        } else {
          text[text.length - 1].image_omitted = omitted;
        }
      }
      if (nextPage === null && lastPage < total) nextPage = lastPage + 1;
      return { ...base, kind: 'pdf', mime: 'application/pdf', pages_total: total, pages: media.map(m => m.page), next_page: nextPage,
        media, ...untrusted({ text }) };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  return {
    async operator_read_media({ path, pages, dpi = MEDIA_LIMITS.dpiDefault }) {
      if (!Number.isInteger(dpi) || dpi < MEDIA_LIMITS.dpiMin || dpi > MEDIA_LIMITS.dpiMax) return fail('invalid_arguments', { detail: 'dpi 36 to 150' });
      let first = 1; let last = 1;
      if (pages !== undefined) {
        const m = PAGES_RE.exec(pages);
        if (!m) return fail('invalid_arguments', { detail: 'pages: "3" or "2-4"' });
        first = Number(m[1]); last = Number(m[2] ?? m[1]);
        if (first < 1 || last < first) return fail('invalid_arguments', { detail: 'pages' });
        if (last - first + 1 > MEDIA_LIMITS.pagesPerCall) return fail('too_many_pages', { max_pages: MEDIA_LIMITS.pagesPerCall });
      }
      const at = await resolve(path);
      if (!at.ok) return at;
      const read = await readOnce(at.path, MEDIA_LIMITS.pdfFileBytes);
      if (!read.ok) return read;
      const type = sniffMedia(read.buf.subarray(0, 1024));
      if (!type) return fail('unsupported_media', { detail: 'png, jpeg, gif, webp or pdf (by content)' });
      const base = { ok: true, host: policy.host, path: at.path, bytes: read.buf.length, mtime: read.mtime };
      if (type.kind === 'image') {
        if (read.buf.length > MEDIA_LIMITS.imageFileBytes) return fail('too_large', { bytes: read.buf.length, max_bytes: MEDIA_LIMITS.imageFileBytes });
        return image(at, read.buf, type.mime, base);
      }
      return pdf(at, read.buf, base, { first, last, dpi });
    }
  };
}
