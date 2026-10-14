// The source side of operator_transfer (spec D1), on the host agent. Two internal ops, never
// tools: the hub sends them, signed for the caller's principal, while it relays a transfer
// (bridge/operator-transfer.mjs). The destination side is the existing operator_upload_* tools.
//
//  operator_transfer_source {host, path}
//    the path inside the read roots and outside the secret denylist, a regular file opened with
//    O_NOFOLLOW, at most 512 MiB: its canonical path, size, mtime and SHA-256, computed here;
//  operator_read_chunk {host, path, index, size, mtime_ms}
//    64 KiB at index * 64 KiB, base64, after the same checks; refused with source_changed when the
//    file's size or mtime differ from the digest the hub holds (the destination's SHA-256 check
//    would catch it anyway, this stops early).
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod/v4';
import { createDenylist, catalogProjects, resolveOperatorPath } from './operator-paths.mjs';
import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from '../server/tools/operator-tools.mjs';

export const TRANSFER_CHUNK_BYTES = UPLOAD_CHUNK_BYTES;
export const TRANSFER_MAX_BYTES = UPLOAD_MAX_BYTES;
const host = z.enum(['mac', 'vps']);
const path = z.string().min(1).max(4096);
export const TRANSFER_SOURCE_SCHEMAS = Object.freeze({
  operator_transfer_source: z.object({ host, path }),
  operator_read_chunk: z.object({ host, path, index: z.number().int().min(0).max(TRANSFER_MAX_BYTES / TRANSFER_CHUNK_BYTES),
    size: z.number().int().min(0).max(TRANSFER_MAX_BYTES), mtime_ms: z.number().min(0) })
});

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

export function createTransferSourceTools(policy, { projects = catalogProjects(policy.repositories) } = {}) {
  const denylist = createDenylist(policy);
  const resolve = raw => resolveOperatorPath(policy, raw, { access: 'r', denylist, projects });
  async function opened(raw) {
    const at = await resolve(raw);
    if (!at.ok) return at;
    let fh;
    try { fh = await open(at.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0)); } catch (error) {
      return fail(error?.code === 'EACCES' ? 'permission_denied' : error?.code === 'ELOOP' ? 'path_changed' : 'unreadable');
    }
    const info = await fh.stat();
    if (!info.isFile()) { await fh.close(); return fail('not_a_file'); }
    return { ok: true, fh, info, path: at.path };
  }
  return {
    async operator_transfer_source({ path: raw }) {
      const src = await opened(raw);
      if (!src.ok) return src;
      try {
        if (src.info.size > TRANSFER_MAX_BYTES) return fail('too_large', { bytes: src.info.size, max_bytes: TRANSFER_MAX_BYTES });
        const hash = createHash('sha256');
        const buf = Buffer.alloc(1024 * 1024);
        for (let at = 0; at < src.info.size;) {
          const { bytesRead } = await src.fh.read(buf, 0, Math.min(buf.length, src.info.size - at), at);
          if (!bytesRead) break;
          hash.update(buf.subarray(0, bytesRead));
          at += bytesRead;
        }
        const after = await src.fh.stat();
        if (after.size !== src.info.size || after.mtimeMs !== src.info.mtimeMs) return fail('source_changed');
        return { ok: true, host: policy.host, path: src.path, size: src.info.size, mtime_ms: src.info.mtimeMs, sha256: hash.digest('hex'),
          chunk_bytes: TRANSFER_CHUNK_BYTES, chunks: Math.ceil(src.info.size / TRANSFER_CHUNK_BYTES) };
      } finally { await src.fh.close(); }
    },
    async operator_read_chunk({ path: raw, index, size, mtime_ms: mtimeMs }) {
      const src = await opened(raw);
      if (!src.ok) return src;
      try {
        if (src.path !== raw) return fail('path_changed');
        if (src.info.size !== size || src.info.mtimeMs !== mtimeMs) return fail('source_changed');
        const offset = index * TRANSFER_CHUNK_BYTES;
        const want = Math.min(TRANSFER_CHUNK_BYTES, size - offset);
        if (want <= 0) return fail('invalid_arguments', { detail: 'index past the end' });
        const buf = Buffer.alloc(want);
        let got = 0;
        while (got < want) { const { bytesRead } = await src.fh.read(buf, got, want - got, offset + got); if (!bytesRead) break; got += bytesRead; }
        if (got !== want) return fail('source_changed');
        return { ok: true, host: policy.host, index, bytes: got, content_base64: buf.toString('base64') };
      } finally { await src.fh.close(); }
    }
  };
}
