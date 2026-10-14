// operator_transfer, relayed by the hub (repatriated SentinelX transfer_file, spec D1).
//
// Design: the simplest one that fits the wire as it is. The hub reads the source in 64 KiB chunks
// through two internal agent ops (bridge/operator-transfer-source.mjs) and writes them on the
// destination through the existing operator_upload_init / _chunk / _complete. A 64 KiB chunk is
// 87 KiB of base64: under the 128 KiB request cap (MAX_REQUEST_BYTES) and the 1 MiB result cap,
// and the 16 KiB frame limit is met by the protocol's own `part` frames. No new frame type, no
// protocol version, no new write path on the hosts. Consequences:
//  - the destination keeps every rule of an upload: write roots, secret denylist, use_dev_flow,
//    the caller's workspace and operator lock on the destination path, the hub freeze, approval
//    mode, backup on overwrite, atomic rename, and the SHA-256 check at the destination (against
//    the digest the source agent computed);
//  - the source keeps the read rules of its host (read roots, denylist, O_NOFOLLOW) and refuses a
//    file that changed during the transfer (source_changed);
//  - both hosts and the hub journal every call, with the caller's principal.
// Four lanes run in parallel (an agent serves at most 8 requests at once); at most two transfers
// run per hub. The call waits up to waitMs; a longer transfer keeps running here and answers
// {status:'running', transfer_id}: operator_transfer_status reads it. State lives in this process:
// a hub restart loses it (unknown_transfer) and places nothing (the staged upload expires).
import { randomBytes } from 'node:crypto';
import { TRANSFER_CHUNK_BYTES, TRANSFER_MAX_BYTES } from './operator-transfer-source.mjs';
import { TRANSFER_ID_RE } from '../server/tools/operator-repatriated.mjs';

export const TRANSFER_LIMITS = Object.freeze({ lanes: 4, running: 2, waitMs: 20_000, keepMs: 60 * 60_000, kept: 50,
  busyRetries: 40, busyDelayMs: 100 });
const HOSTS = Object.freeze(['mac', 'vps']);
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// readSource(host, op, args, principal)  a signed internal op to the source agent
// writeDest(host, op, args, ctx)         the hub's own operator path (locks, freeze, approval, journal)
// frozen()                               the hub freeze flag
export function createTransfers({ readSource, writeDest, frozen = () => false, record = () => {}, now = Date.now,
  newId = () => `tr_${randomBytes(16).toString('base64url')}`, limits = TRANSFER_LIMITS } = {}) {
  const transfers = new Map();
  const sweep = () => {
    const t = now();
    for (const [id, tr] of transfers) if (tr.state !== 'running' && t - tr.ended > limits.keepMs) transfers.delete(id);
    while (transfers.size > limits.kept) {
      const oldest = [...transfers.values()].find(tr => tr.state !== 'running');
      if (!oldest) break;
      transfers.delete(oldest.id);
    }
  };
  const running = () => [...transfers.values()].filter(tr => tr.state === 'running').length;

  // An agent call, retried while the agent answers agent_busy (its in-flight limit).
  async function retrying(fn) {
    for (let i = 0; ; i++) {
      const out = await fn();
      if (out?.error !== 'agent_busy' || i >= limits.busyRetries) return out;
      await sleep(limits.busyDelayMs);
    }
  }

  function view(tr) {
    const base = { transfer_id: tr.id, status: tr.state, src: { host: tr.src_host, path: tr.src_path }, dst: { host: tr.dst_host, path: tr.dst_path },
      size: tr.size, bytes_done: tr.bytes, chunks_done: tr.chunksDone, chunks: tr.chunks, started_at: new Date(tr.started).toISOString() };
    if (tr.state === 'done') return { ok: true, ...tr.result };
    if (tr.state === 'failed') return { ...tr.error, transfer_id: tr.id, status: 'failed', side: tr.side, bytes_done: tr.bytes };
    return { ok: true, ...base, detail: 'still copying: read the outcome with operator_transfer_status' };
  }

  async function run(tr, ctx) {
    const { principal } = ctx;
    const stop = (side, out) => {
      if (tr.state !== 'running') return;
      const code = typeof out?.error === 'string' ? out.error : 'internal_error';
      tr.state = 'failed'; tr.side = side; tr.ended = now();
      tr.error = { ok: false, error: code, ...(out?.detail ? { detail: out.detail } : {}), ...(out?.approval_id ? { approval_id: out.approval_id,
        expires_at: out.expires_at } : {}), ...(out?.holder ? { holder: out.holder } : {}), ...(out?.max_bytes ? { max_bytes: out.max_bytes } : {}) };
      record('operator_transfer', { transfer_id: tr.id, principal: principal.id, outcome: 'refused', side, code, bytes: tr.bytes });
    };
    try {
      const src = await retrying(() => readSource(tr.src_host, 'operator_transfer_source', { host: tr.src_host, path: tr.src_path }, principal));
      if (src?.ok !== true) return stop('source', src);
      if (!Number.isInteger(src.size) || src.size > TRANSFER_MAX_BYTES || !/^[0-9a-f]{64}$/.test(src.sha256 ?? '')) {
        return stop('source', fail(src.size > TRANSFER_MAX_BYTES ? 'too_large' : 'invalid_agent_response'));
      }
      Object.assign(tr, { size: src.size, chunks: Math.ceil(src.size / TRANSFER_CHUNK_BYTES), src_canonical: src.path });
      const ws = tr.workspace_id !== undefined ? { workspace_id: tr.workspace_id } : {};
      const init = await retrying(() => writeDest(tr.dst_host, 'operator_upload_init', { host: tr.dst_host, path: tr.dst_path, size: src.size,
        ...(tr.overwrite ? { overwrite: true } : {}), ...ws }, ctx));
      if (init?.ok !== true) return stop('destination', init);
      let next = 0;
      const lane = async () => {
        while (tr.state === 'running') {
          const index = next++;
          if (index >= tr.chunks) return;
          const chunk = await retrying(() => readSource(tr.src_host, 'operator_read_chunk', { host: tr.src_host, path: src.path, index, size: src.size,
            mtime_ms: src.mtime_ms }, principal));
          if (chunk?.ok !== true || typeof chunk.content_base64 !== 'string') return stop('source', chunk?.ok === true ? fail('invalid_agent_response') : chunk);
          const wrote = await retrying(() => writeDest(tr.dst_host, 'operator_upload_chunk', { host: tr.dst_host, upload_id: init.upload_id, index,
            content_base64: chunk.content_base64, ...ws }, ctx));
          if (wrote?.ok !== true) return stop('destination', wrote);
          tr.bytes += chunk.bytes; tr.chunksDone++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(limits.lanes, Math.max(1, tr.chunks)) }, lane));
      if (tr.state !== 'running') return;
      const done = await retrying(() => writeDest(tr.dst_host, 'operator_upload_complete', { host: tr.dst_host, upload_id: init.upload_id,
        sha256: src.sha256, ...ws }, ctx));
      if (done?.ok !== true) return stop('destination', done);
      tr.state = 'done'; tr.ended = now();
      tr.result = { transfer_id: tr.id, status: 'done', src: { host: tr.src_host, path: src.path }, dst: { host: tr.dst_host, path: done.path ?? tr.dst_path },
        size: src.size, sha256: src.sha256, sha256_verified_at_destination: true, backup: done.backup ?? null, chunks: tr.chunks,
        ms: tr.ended - tr.started };
      record('operator_transfer', { transfer_id: tr.id, principal: principal.id, outcome: 'ok', src_host: tr.src_host, dst_host: tr.dst_host,
        bytes: src.size, sha256: src.sha256, ms: tr.ended - tr.started });
    } catch {
      stop('hub', fail('internal_error'));
    }
  }

  return {
    // args: the operator_transfer arguments (schema-checked by the MCP layer; checked again here).
    async start(args, ctx) {
      sweep();
      if (!HOSTS.includes(args?.src_host) || !HOSTS.includes(args?.dst_host) || typeof args.src_path !== 'string' || typeof args.dst_path !== 'string' ||
        !args.src_path || !args.dst_path || args.src_path.length > 4096 || args.dst_path.length > 4096 ||
        (args.overwrite !== undefined && typeof args.overwrite !== 'boolean')) return fail('invalid_arguments');
      if (frozen()) return fail('frozen');
      if (running() >= limits.running) return fail('transfer_busy', { detail: `at most ${limits.running} transfers at once: wait for one to finish` });
      const tr = { id: newId(), principal: ctx.principal.id, state: 'running', src_host: args.src_host, src_path: args.src_path,
        dst_host: args.dst_host, dst_path: args.dst_path, overwrite: args.overwrite === true, workspace_id: args.workspace_id,
        size: null, chunks: null, bytes: 0, chunksDone: 0, started: now(), ended: null };
      transfers.set(tr.id, tr);
      record('operator_transfer_started', { transfer_id: tr.id, principal: ctx.principal.id, src_host: tr.src_host, dst_host: tr.dst_host });
      const finished = run(tr, ctx);
      let timer;
      await Promise.race([finished, new Promise(resolve => { timer = setTimeout(resolve, limits.waitMs); })]);
      clearTimeout(timer);
      return view(tr);
    },
    status(args, ctx) {
      sweep();
      if (!TRANSFER_ID_RE.test(args?.transfer_id ?? '')) return fail('invalid_arguments');
      const tr = transfers.get(args.transfer_id);
      // Another principal's transfer is unknown to this one.
      if (!tr || tr.principal !== ctx.principal.id) return fail('unknown_transfer', { detail: 'unknown here, or lost with a hub restart (nothing was placed)' });
      return view(tr);
    },
    get running() { return running(); }
  };
}
