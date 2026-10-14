// operator_transfer (repatriated SentinelX transfer_file, spec D1, AC-1, AC-2): a real hub relays
// files between two real operator agents on loopback TLS, each with its own host tree and policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { HUB_PRINCIPALS, PRINCIPAL_IDS } from '../bridge/ops.mjs';
import { createTransferSourceTools, TRANSFER_CHUNK_BYTES } from '../bridge/operator-transfer-source.mjs';
import { createTransfers } from '../bridge/operator-transfer.mjs';
import { detachBinary } from '../bridge/operator-binary.mjs';
import { makeHost } from './helpers/operator-fixture.mjs';
import { journalLines, twoHostStack, until } from './helpers/operator-live.mjs';

const OWNER = HUB_PRINCIPALS[PRINCIPAL_IDS.owner];
const CHAT = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
const OTHER = makePrincipal('oidc:other-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
const READER = HUB_PRINCIPALS[PRINCIPAL_IDS.readonly];
const WS = 'ws_AAAAAAAAAAAAAAAA';
const sha = buf => createHash('sha256').update(buf).digest('hex');
const transfer = (hub, args, principal = OWNER) => hub.requestOperator(undefined, 'operator_transfer', { args, principal });

test('AC-1: a 5 MiB binary goes vps to mac, mac to vps and within one host, byte for byte', async t => {
  const { hub, hosts, audit } = await twoHostStack(t);
  const data = randomBytes(5 * 1024 * 1024 + 123);
  writeFileSync(hosts.vps.p('srv/rw/blob.bin'), data);
  const there = await transfer(hub, { src_host: 'vps', src_path: hosts.vps.p('srv/rw/blob.bin'), dst_host: 'mac', dst_path: hosts.mac.p('srv/rw/blob.bin') });
  assert.equal(there.ok, true, JSON.stringify(there));
  assert.equal(there.status, 'done');
  assert.equal(there.sha256, sha(data));
  assert.equal(there.sha256_verified_at_destination, true);
  assert.equal(there.chunks, Math.ceil(data.length / TRANSFER_CHUNK_BYTES));
  assert.equal(sha(readFileSync(hosts.mac.p('srv/rw/blob.bin'))), sha(data));
  const back = await transfer(hub, { src_host: 'mac', src_path: hosts.mac.p('srv/rw/blob.bin'), dst_host: 'vps', dst_path: hosts.vps.p('srv/rw/back.bin') });
  assert.equal(back.status, 'done', JSON.stringify(back));
  assert.equal(sha(readFileSync(hosts.vps.p('srv/rw/back.bin'))), sha(data));
  // Within one host, and an empty file.
  writeFileSync(hosts.mac.p('srv/rw/empty'), '');
  const local = await transfer(hub, { src_host: 'mac', src_path: hosts.mac.p('srv/rw/empty'), dst_host: 'mac', dst_path: hosts.mac.p('srv/rw/empty-copy') });
  assert.equal(local.status, 'done', JSON.stringify(local));
  assert.equal(readFileSync(hosts.mac.p('srv/rw/empty-copy')).length, 0);
  // Both hosts journal the transfer: chunk reads on the source, chunk writes on the destination.
  const vpsOps = journalLines(hosts.vps).map(l => l.op);
  const macOps = journalLines(hosts.mac).map(l => l.op);
  assert.ok(vpsOps.includes('operator_transfer_source') && vpsOps.includes('operator_read_chunk'));
  assert.ok(macOps.includes('operator_upload_init') && macOps.includes('operator_upload_chunk') && macOps.includes('operator_upload_complete'));
  assert.ok(journalLines(hosts.vps).filter(l => l.op === 'operator_read_chunk').every(l => l.principal === OWNER.id));
  assert.ok(audit.some(e => e.event === 'operator_transfer' && e.outcome === 'ok' && e.sha256 === sha(data)));
});

test('AC-2: secret, outside the roots, existing destination, overwrite with backup, too large', async t => {
  const { hub, hosts } = await twoHostStack(t);
  writeFileSync(hosts.vps.p('srv/rw/a.txt'), 'first\n');
  writeFileSync(hosts.mac.p('srv/rw/a.txt'), 'already here\n');
  const go = (src, dst, extra = {}) => transfer(hub, { src_host: 'vps', src_path: src, dst_host: 'mac', dst_path: dst, ...extra });
  const secret = await go(hosts.vps.p('srv/app/.env'), hosts.mac.p('srv/rw/env'));
  assert.deepEqual([secret.error, secret.side], ['path_secret', 'source']);
  assert.equal((await go(hosts.vps.p('home/op/innocent'), hosts.mac.p('srv/rw/k'))).error, 'path_secret', 'a symlink into .ssh');
  assert.equal((await go(hosts.vps.p('outside/plain.txt'), hosts.mac.p('srv/rw/p'))).error, 'path_not_allowed');
  const dstOut = await go(hosts.vps.p('srv/rw/a.txt'), hosts.mac.p('srv/app/a.txt'));
  assert.deepEqual([dstOut.error, dstOut.side], ['path_not_allowed', 'destination']);
  assert.equal((await go(hosts.vps.p('srv/rw/a.txt'), hosts.mac.p('srv/rw/.env'))).error, 'path_secret', 'never writes a secret path');
  assert.equal((await go(hosts.vps.p('srv/rw/a.txt'), hosts.mac.p('srv/rw/a.txt'))).error, 'exists');
  assert.equal(readFileSync(hosts.mac.p('srv/rw/a.txt'), 'utf8'), 'already here\n');
  const replaced = await go(hosts.vps.p('srv/rw/a.txt'), hosts.mac.p('srv/rw/a.txt'), { overwrite: true });
  assert.equal(replaced.status, 'done', JSON.stringify(replaced));
  assert.ok(replaced.backup && readFileSync(replaced.backup, 'utf8') === 'already here\n', 'the replaced file is kept');
  assert.equal(readFileSync(hosts.mac.p('srv/rw/a.txt'), 'utf8'), 'first\n');
  // Above 512 MiB (a sparse file): refused at the source before any byte moves.
  writeFileSync(hosts.vps.p('srv/rw/huge'), '');
  truncateSync(hosts.vps.p('srv/rw/huge'), 512 * 1024 * 1024 + 1);
  const huge = await go(hosts.vps.p('srv/rw/huge'), hosts.mac.p('srv/rw/huge'));
  assert.deepEqual([huge.error, huge.side], ['too_large', 'source']);
  assert.equal(existsSync(hosts.mac.p('srv/rw/huge')), false);
  // A directory is not a file.
  assert.equal((await go(hosts.vps.p('srv/app'), hosts.mac.p('srv/rw/dir'))).error, 'not_a_file');
  // Bad arguments and the read-only principal.
  assert.equal((await transfer(hub, { src_host: 'lab', src_path: '/x', dst_host: 'mac', dst_path: '/y' })).error, 'invalid_arguments');
  assert.equal((await transfer(hub, { src_host: 'vps', src_path: '/x', dst_host: 'mac', dst_path: '/y' }, READER)).error, 'forbidden');
});

test('AC-2: a ChatGPT conversation writes the destination under its lock, explicit or implicit; another conversation\'s lock and a frozen hub refuse', async t => {
  const { hub, hosts } = await twoHostStack(t);
  writeFileSync(hosts.vps.p('srv/rw/r.txt'), 'remote\n');
  const args = { src_host: 'vps', src_path: hosts.vps.p('srv/rw/r.txt'), dst_host: 'mac', dst_path: hosts.mac.p('srv/rw/r.txt') };
  const session = 'c'.repeat(32);
  const call = (op, a) => hub.requestOperator(op === 'operator_transfer' ? undefined : a.host, op, { args: a, principal: CHAT, clientSession: session });
  // Repatriation D-R14: without workspace or lock, the destination writes use the conversation's
  // workspace and an implicit lock held for each write, released after it.
  const implicit = await call('operator_transfer', { ...args, dst_path: hosts.mac.p('srv/rw/r0.txt') });
  assert.equal(implicit.status, 'done', JSON.stringify(implicit));
  assert.equal(readFileSync(hosts.mac.p('srv/rw/r0.txt'), 'utf8'), 'remote\n');
  assert.equal(hub.operatorLocks.size, 0);
  assert.equal((await call('operator_lock', { host: 'mac', workspace_id: WS, kind: 'path', target: hosts.mac.p('srv/rw') })).ok, true);
  const done = await call('operator_transfer', { ...args, workspace_id: WS });
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(readFileSync(hosts.mac.p('srv/rw/r.txt'), 'utf8'), 'remote\n');
  // Another conversation is refused on the locked destination.
  const other = await hub.requestOperator(undefined, 'operator_transfer', { args: { ...args, dst_path: hosts.mac.p('srv/rw/r2.txt'), workspace_id: 'ws_BBBBBBBBBBBBBBBB' },
    principal: OTHER, clientSession: 'd'.repeat(32) });
  assert.equal(other.error, 'locked_by_other_session');
  hub.setOperatorFrozen(true, 'test');
  assert.equal((await call('operator_transfer', { ...args, workspace_id: WS, overwrite: true })).error, 'frozen');
  hub.setOperatorFrozen(false, 'test');
});

test('a long transfer answers running with a transfer_id; status follows it; only its principal sees it; two at most', async t => {
  const { hub, hosts } = await twoHostStack(t, { operator: { transferLimits: { lanes: 1, running: 1, waitMs: 0, keepMs: 60_000, kept: 10, busyRetries: 5, busyDelayMs: 10 } } });
  writeFileSync(hosts.vps.p('srv/rw/slow.bin'), randomBytes(2 * 1024 * 1024));
  const started = await transfer(hub, { src_host: 'vps', src_path: hosts.vps.p('srv/rw/slow.bin'), dst_host: 'mac', dst_path: hosts.mac.p('srv/rw/slow.bin') });
  assert.equal(started.ok, true);
  assert.equal(started.status, 'running');
  assert.match(started.transfer_id, /^tr_/);
  const busy = await transfer(hub, { src_host: 'vps', src_path: hosts.vps.p('srv/rw/slow.bin'), dst_host: 'mac', dst_path: hosts.mac.p('srv/rw/other.bin') });
  assert.equal(busy.error, 'transfer_busy');
  const status = args => hub.requestOperator(undefined, 'operator_transfer_status', { args, principal: OWNER });
  await until(async () => (await status({ transfer_id: started.transfer_id })).status === 'done');
  const done = await status({ transfer_id: started.transfer_id });
  assert.equal(done.sha256, sha(readFileSync(hosts.vps.p('srv/rw/slow.bin'))));
  assert.equal(sha(readFileSync(hosts.mac.p('srv/rw/slow.bin'))), done.sha256);
  assert.equal((await hub.requestOperator(undefined, 'operator_transfer_status', { args: { transfer_id: started.transfer_id }, principal: CHAT })).error,
    'unknown_transfer');
  assert.equal((await status({ transfer_id: 'tr_AAAAAAAAAAAAAAAAAAAA' })).error, 'unknown_transfer');
  assert.equal((await status({ transfer_id: 'nope' })).error, 'invalid_arguments');
});

test('source side: canonical path, digest, chunks; a file changed since the digest is refused', async t => {
  const host = makeHost(t);
  const tools = createTransferSourceTools(host.policy, { projects: async () => [] });
  const data = randomBytes(TRANSFER_CHUNK_BYTES + 10);
  writeFileSync(host.p('srv/rw/s.bin'), data);
  const src = await tools.operator_transfer_source({ host: 'vps', path: host.p('srv/rw/s.bin') });
  assert.deepEqual([src.ok, src.size, src.sha256, src.chunks], [true, data.length, sha(data), 2]);
  const second = await tools.operator_read_chunk({ host: 'vps', path: src.path, index: 1, size: src.size, mtime_ms: src.mtime_ms });
  assert.deepEqual(Buffer.from(second.content_base64, 'base64'), data.subarray(TRANSFER_CHUNK_BYTES));
  assert.equal((await tools.operator_read_chunk({ host: 'vps', path: src.path, index: 2, size: src.size, mtime_ms: src.mtime_ms })).error, 'invalid_arguments');
  utimesSync(host.p('srv/rw/s.bin'), new Date(), new Date(Date.now() + 5000));
  assert.equal((await tools.operator_read_chunk({ host: 'vps', path: src.path, index: 0, size: src.size, mtime_ms: src.mtime_ms })).error, 'source_changed');
  assert.equal((await tools.operator_transfer_source({ host: 'vps', path: host.p('srv/app/.env') })).error, 'path_secret');
  assert.equal((await tools.operator_read_chunk({ host: 'vps', path: host.p('srv/app/.env'), index: 0, size: 1, mtime_ms: 0 })).error, 'path_secret');
});

test('binary payloads skip the text redactor, unchanged; anything not base64 is redacted like text', () => {
  // A base64 run that happens to look like an AWS key id.
  const chunk = `AAAA/AKIAIOSFODNN7EXAMPLE/${'Q'.repeat(40)}==`;
  const { rest, attach } = detachBinary({ ok: true, content_base64: chunk, media: [{ mime: 'image/png', base64: chunk }] });
  assert.equal(rest.content_base64, undefined);
  assert.equal(rest.media[0].base64, '');
  const back = attach({ ...rest, extra: 1 });
  assert.equal(back.content_base64, chunk);
  assert.equal(back.media[0].base64, chunk);
  const odd = detachBinary({ ok: true, content_base64: 'not base64 at all!' });
  assert.equal(odd.rest.content_base64, 'not base64 at all!');
  assert.deepEqual(detachBinary({ ok: false, error: 'x' }).rest, { ok: false, error: 'x' });
});

test('the orchestrator alone: a destination refusal stops every lane; pending_approval carries the approval id', async () => {
  const writes = [];
  const transfers = createTransfers({
    readSource: async (host, op, args) => (op === 'operator_transfer_source'
      ? { ok: true, path: args.path, size: 3 * TRANSFER_CHUNK_BYTES, mtime_ms: 1, sha256: 'a'.repeat(64) }
      : { ok: true, index: args.index, bytes: TRANSFER_CHUNK_BYTES, content_base64: 'AAAA' }),
    writeDest: async (host, op, args) => {
      writes.push(op);
      if (op === 'operator_upload_init') return { ok: true, upload_id: 'up_AAAAAAAAAAAAAAAAAAAA' };
      if (op === 'operator_upload_chunk' && args.index === 1) return { ok: false, error: 'disk_full' };
      return { ok: true };
    }
  });
  const out = await transfers.start({ src_host: 'vps', src_path: '/a', dst_host: 'mac', dst_path: '/b' }, { principal: OWNER });
  assert.deepEqual([out.ok, out.error, out.side, out.status], [false, 'disk_full', 'destination', 'failed']);
  assert.equal(writes.includes('operator_upload_complete'), false, 'nothing is placed');
  const asking = createTransfers({ readSource: async () => ({ ok: true, path: '/a', size: 1, mtime_ms: 1, sha256: 'b'.repeat(64) }),
    writeDest: async () => ({ ok: false, error: 'pending_approval', approval_id: 'ap_AAAAAAAAAAAAAAAAAAAA', expires_at: 'soon' }) });
  const pending = await asking.start({ src_host: 'vps', src_path: '/a', dst_host: 'mac', dst_path: '/b' }, { principal: OWNER });
  assert.deepEqual([pending.error, pending.approval_id], ['pending_approval', 'ap_AAAAAAAAAAAAAAAAAAAA']);
});
