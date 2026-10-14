// operator_read_media (repatriated SentinelX read_media, spec D2, AC-3): type by content, image
// bytes as MCP image content, PDF pages rendered with their text, bounds and refusals. The real
// PDFKit and sips paths run on macOS only; the poppler path runs everywhere with a fake runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, truncateSync } from 'node:fs';
import { MEDIA_BUDGET_BYTES, MEDIA_LIMITS, createMediaTool, imageSize, sniffMedia } from '../bridge/operator-media.mjs';
import { operatorContent, splitMedia } from '../bridge/operator-content.mjs';
import { finalizeResult } from '../bridge/operator-output.mjs';
import { detachBinary } from '../bridge/operator-binary.mjs';
import { HUB_PRINCIPALS, PRINCIPAL_IDS } from '../bridge/ops.mjs';
import { makeHost } from './helpers/operator-fixture.mjs';
import { GIF_1X1, makePdf, makePng, webpHeader } from './helpers/media-fixture.mjs';
import { twoHostStack } from './helpers/operator-live.mjs';

const mac = process.platform === 'darwin';
const tool = (host, extra = {}) => createMediaTool(host.policy, { projects: async () => [], ...extra });
const OWNER = HUB_PRINCIPALS[PRINCIPAL_IDS.owner];

test('type and size come from the content, not the name', () => {
  const png = makePng(37, 21);
  assert.deepEqual(sniffMedia(png), { kind: 'image', mime: 'image/png' });
  assert.deepEqual(imageSize(png, 'image/png'), { width: 37, height: 21 });
  assert.deepEqual(sniffMedia(GIF_1X1), { kind: 'image', mime: 'image/gif' });
  assert.deepEqual(imageSize(GIF_1X1, 'image/gif'), { width: 1, height: 1 });
  assert.deepEqual(sniffMedia(webpHeader()), { kind: 'image', mime: 'image/webp' });
  assert.deepEqual(imageSize(webpHeader(640, 480), 'image/webp'), { width: 640, height: 480 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(sniffMedia(jpeg), { kind: 'image', mime: 'image/jpeg' });
  assert.deepEqual(imageSize(jpeg, 'image/jpeg'), { width: 400, height: 300 });
  assert.deepEqual(sniffMedia(makePdf(['x'])), { kind: 'pdf', mime: 'application/pdf' });
  assert.equal(sniffMedia(Buffer.from('plain text, named .png')), null);
});

test('AC-3: a small image comes back as is, with its MIME type; a secret path, a text file and bad arguments are refused', async t => {
  const host = makeHost(t);
  const png = makePng(64, 48);
  writeFileSync(host.p('srv/app/shot.png'), png);
  writeFileSync(host.p('srv/app/anim.gif'), GIF_1X1);
  writeFileSync(host.p('srv/app/fake.png'), 'not an image');
  const op = tool(host, { platform: 'linux' });
  const out = await op.operator_read_media({ path: host.p('srv/app/shot.png') });
  assert.deepEqual([out.ok, out.kind, out.mime, out.width, out.height], [true, 'image', 'image/png', 64, 48]);
  assert.deepEqual(Buffer.from(out.media[0].base64, 'base64'), png);
  assert.equal((await op.operator_read_media({ path: host.p('srv/app/anim.gif') })).media[0].mime, 'image/gif');
  assert.equal((await op.operator_read_media({ path: host.p('srv/app/fake.png') })).error, 'unsupported_media');
  assert.equal((await op.operator_read_media({ path: host.p('srv/app/.env') })).error, 'path_secret');
  assert.equal((await op.operator_read_media({ path: host.p('home/op/innocent') })).error, 'path_secret');
  assert.equal((await op.operator_read_media({ path: host.p('outside/plain.txt') })).error, 'path_not_allowed');
  assert.equal((await op.operator_read_media({ path: host.p('srv/app') })).error, 'not_a_file');
  assert.equal((await op.operator_read_media({ path: host.p('srv/app/shot.png'), dpi: 300 })).error, 'invalid_arguments');
  assert.equal((await op.operator_read_media({ path: host.p('srv/app/shot.png'), pages: '1-9' })).error, 'too_many_pages');
  assert.equal((await op.operator_read_media({ path: host.p('srv/app/shot.png'), pages: '3-1' })).error, 'invalid_arguments');
  // Over the file bounds: refused before anything is converted.
  writeFileSync(host.p('srv/app/huge.png'), makePng(2, 2));
  truncateSync(host.p('srv/app/huge.png'), MEDIA_LIMITS.imageFileBytes + 1);
  assert.equal((await op.operator_read_media({ path: host.p('srv/app/huge.png') })).error, 'too_large');
  writeFileSync(host.p('srv/app/huge.pdf'), makePdf(['x']));
  truncateSync(host.p('srv/app/huge.pdf'), MEDIA_LIMITS.pdfFileBytes + 1);
  assert.equal((await op.operator_read_media({ path: host.p('srv/app/huge.pdf') })).error, 'too_large');
});

test('an image above the budget: refused where no resizer exists; downscaled with sips on the Mac', async t => {
  const host = makeHost(t);
  writeFileSync(host.p('srv/app/big.png'), makePng(700, 400, { noise: true }));
  const linux = await tool(host, { platform: 'linux' }).operator_read_media({ path: host.p('srv/app/big.png') });
  assert.equal(linux.error, 'too_large');
  // The resize runs on a private copy, never on the original path.
  const calls = [];
  const fake = tool(host, { platform: 'darwin', run: async argv => { calls.push(argv); return { code: null, stdout: '', stderr: '' }; } });
  assert.equal((await fake.operator_read_media({ path: host.p('srv/app/big.png') })).error, 'resizer_unavailable');
  assert.equal(calls[0][0], 'sips');
  assert.equal(calls[0].includes(host.p('srv/app/big.png')), false);
  if (!mac) return;
  const out = await tool(host, { platform: 'darwin' }).operator_read_media({ path: host.p('srv/app/big.png') });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.deepEqual([out.width, out.height, out.media[0].mime], [700, 400, 'image/jpeg']);
  assert.ok(Buffer.from(out.media[0].base64, 'base64').length <= MEDIA_BUDGET_BYTES);
  assert.equal(out.resized.mime, 'image/jpeg');
});

test('PDF on lab: pdfinfo, pdftotext and pdftoppm with fixed argv on a private copy; missing tools say so', async t => {
  const host = makeHost(t);
  writeFileSync(host.p('srv/app/doc.pdf'), makePdf(['one', 'two', 'three']));
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    if (argv[0] === 'pdfinfo') return { code: 0, stdout: 'Title: x\nPages:          3\n', stderr: '' };
    if (argv[0] === 'pdftotext') return { code: 0, stdout: `text of page ${argv[2]}`, stderr: '' };
    if (argv[0] === 'pdftoppm') { writeFileSync(`${argv.at(-1)}.png`, makePng(20, 30)); return { code: 0, stdout: '', stderr: '' }; }
    return { code: 1, stdout: '', stderr: '' };
  };
  const out = await tool(host, { platform: 'linux', run }).operator_read_media({ path: host.p('srv/app/doc.pdf'), pages: '2-3', dpi: 72 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([out.kind, out.pages_total, out.pages, out.next_page], ['pdf', 3, [2, 3], null]);
  assert.deepEqual(out.untrusted_content.text.map(p => p.text), ['text of page 2', 'text of page 3']);
  assert.ok(out.media.every(m => m.mime === 'image/png' && m.dpi === 72));
  const ppm = calls.find(c => c[0] === 'pdftoppm');
  assert.deepEqual(ppm.slice(0, 9), ['pdftoppm', '-f', '2', '-l', '2', '-r', '72', '-png', '-singlefile']);
  assert.equal(calls.some(c => c.includes(host.p('srv/app/doc.pdf'))), false, 'only the private copy is opened');
  // Page 1 default, next_page when more pages follow, past the end.
  const first = await tool(host, { platform: 'linux', run }).operator_read_media({ path: host.p('srv/app/doc.pdf') });
  assert.deepEqual([first.pages, first.next_page], [[1], 2]);
  assert.equal((await tool(host, { platform: 'linux', run }).operator_read_media({ path: host.p('srv/app/doc.pdf'), pages: '7' })).error, 'page_out_of_range');
  const none = await tool(host, { platform: 'linux', run: async () => ({ code: null, stdout: '', stderr: '' }) })
    .operator_read_media({ path: host.p('srv/app/doc.pdf') });
  assert.equal(none.error, 'pdf_tools_unavailable');
  assert.match(none.detail, /poppler-utils/);
});

test('PDF pages over the budget come back with next_page; the page text is kept', async t => {
  const host = makeHost(t);
  writeFileSync(host.p('srv/app/doc.pdf'), makePdf(['a', 'b', 'c']));
  const big = makePng(400, 400, { noise: true }); // about 480 KiB: one fits the budget, two do not
  const run = async argv => {
    if (argv[0] === 'pdfinfo') return { code: 0, stdout: 'Pages: 3\n', stderr: '' };
    if (argv[0] === 'pdftotext') return { code: 0, stdout: 'page text', stderr: '' };
    writeFileSync(`${argv.at(-1)}.png`, big); return { code: 0, stdout: '', stderr: '' };
  };
  const out = await tool(host, { platform: 'linux', run }).operator_read_media({ path: host.p('srv/app/doc.pdf'), pages: '1-3' });
  assert.deepEqual([out.pages, out.next_page], [[1], 2]);
  assert.equal(out.untrusted_content.text.length, 1);
});

test('PDF on the Mac: PDFKit renders the pages and extracts their text', { skip: !mac && 'macOS only' }, async t => {
  const host = makeHost(t);
  writeFileSync(host.p('srv/app/doc.pdf'), makePdf(['Hello page one', 'Second page here']));
  const out = await tool(host, { platform: 'darwin' }).operator_read_media({ path: host.p('srv/app/doc.pdf'), pages: '1-2', dpi: 72 });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.deepEqual([out.pages_total, out.pages, out.next_page], [2, [1, 2], null]);
  assert.match(out.untrusted_content.text[0].text, /Hello page one/);
  assert.match(out.untrusted_content.text[1].text, /Second page here/);
  assert.deepEqual([out.media[0].width, out.media[0].height], [612, 792]);
  writeFileSync(host.p('srv/app/broken.pdf'), '%PDF-1.4\nnot really a pdf');
  assert.equal((await tool(host, { platform: 'darwin' }).operator_read_media({ path: host.p('srv/app/broken.pdf') })).error, 'pdf_unreadable');
});

test('MCP content: one text part with the metadata, then one image part per image; the redactor never touches the bytes', () => {
  const png = makePng(8, 8).toString('base64');
  const data = { ok: true, kind: 'pdf', media: [{ mime: 'image/png', base64: png, page: 1 }, { mime: 'text/html', base64: 'AAAA' }] };
  const { content } = operatorContent(data);
  assert.equal(content.length, 2);
  assert.deepEqual(content[1], { type: 'image', data: png, mimeType: 'image/png' });
  const text = JSON.parse(content[0].text);
  assert.deepEqual(text.media, [{ mime: 'image/png', page: 1, image_part: 1 }, { mime: 'text/html' }]);
  assert.equal(splitMedia({ ok: false, error: 'x' }).images.length, 0);
  // Through the agent's output path: detached, redacted, bounded, attached back unchanged.
  const { rest, attach } = detachBinary(data);
  const out = attach(finalizeResult(rest).data);
  assert.equal(out.media[0].base64, png);
});

test('live: read_media through the hub returns the image; snapshot and help answer too', async t => {
  const { hub, hosts } = await twoHostStack(t);
  const png = makePng(16, 16);
  writeFileSync(hosts.mac.p('srv/app/s.png'), png);
  const out = await hub.requestOperator('mac', 'operator_read_media', { args: { host: 'mac', path: hosts.mac.p('srv/app/s.png') }, principal: OWNER });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.host, 'mac');
  assert.deepEqual(Buffer.from(out.media[0].base64, 'base64'), png);
  const content = operatorContent(out).content;
  assert.deepEqual(content.map(c => c.type), ['text', 'image']);
  // An image above the agent's 128 KiB text bound crosses the agent, the wire and the hub intact.
  const big = makePng(250, 250, { noise: true });
  assert.ok(big.length > 160 * 1024 && big.length < MEDIA_BUDGET_BYTES);
  writeFileSync(hosts.mac.p('srv/app/big.png'), big);
  const whole = await hub.requestOperator('mac', 'operator_read_media', { args: { host: 'mac', path: hosts.mac.p('srv/app/big.png') }, principal: OWNER });
  assert.equal(whole._truncation, undefined);
  assert.deepEqual(Buffer.from(whole.media[0].base64, 'base64'), big);
  const snap = await hub.requestOperator('vps', 'operator_snapshot', { args: { host: 'vps', path: hosts.vps.p('srv') }, principal: OWNER });
  assert.equal(snap.ok, true, JSON.stringify(snap));
  const help = await hub.requestOperator(undefined, 'operator_help', { args: {}, principal: OWNER });
  assert.ok(help.ok && help.playbooks.length >= 8);
  assert.equal((await hub.requestOperator(undefined, 'operator_help', { args: {}, principal: HUB_PRINCIPALS[PRINCIPAL_IDS.readonly] })).error, 'forbidden');
});

test('remote surface: operator_read_media answers a text part then an MCP image part, through the SDK handler', async () => {
  const { createMcpHandler } = await import('@modelcontextprotocol/server');
  const { createRemoteServerFactory } = await import('../bridge/remote-surface.mjs');
  const SUB = '4b9f6c3e-1a2d-4e5f-8a7b-9c0d1e2f3a4b';
  const CLIENT = 'https://chatgpt.com/connector/oauth/abc/client.json';
  const png = makePng(4, 4).toString('base64');
  const dispatch = async (host, op) => (op === 'operator_read_media'
    ? { ok: true, host: 'mac', kind: 'image', mime: 'image/png', media: [{ mime: 'image/png', base64: png, width: 4, height: 4 }] }
    : { ok: true });
  const factory = createRemoteServerFactory({ config: { owner_sub: SUB, allowed_client_ids: [CLIENT], ceiling: ['coordinator:read', 'operator:read'] }, dispatch });
  const handler = createMcpHandler(factory, { legacy: 'stateless' });
  const authInfo = { token: 'x', clientId: CLIENT, scopes: ['coordinator:read', 'operator:read'], extra: { sub: SUB } };
  const response = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'operator_read_media', arguments: { host: 'mac', path: '/x.png' } } }) }),
  { authInfo });
  const raw = await response.text();
  const body = JSON.parse(/^(event|data):/m.test(raw) ? raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('') : raw);
  const content = body.result.content;
  assert.deepEqual(content.map(c => c.type), ['text', 'image']);
  assert.deepEqual([content[1].mimeType, content[1].data], ['image/png', png]);
  assert.equal(content[0].text.includes(png), false, 'the bytes are not repeated in the text part');
  assert.equal(JSON.parse(content[0].text).media[0].image_part, 1);
});
