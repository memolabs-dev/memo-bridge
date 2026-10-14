// Hash-chained host audit journal (Phase 6, TODO-P6-06, spec D7).
//
// One JSON line per operator call, each carrying the hash of the line before it:
//   {seq, at, prev, source, request_id, ref, op, tier, principal, args_sha256, args, approval,
//    outcome, code, ms, output_sha256, hash}
// source is "agent" or "root-helper" (Lot 2): who reported the line.
// hash = SHA-256 of the canonical JSON of the line without `hash` (prev included), so changing,
// removing or inserting a line breaks the chain at that line. The first line's prev is 64 zeros.
// Arguments are kept only redacted (operator-output.mjs) and cut to 256 characters per string;
// the output is kept as its SHA-256 only.
//
// Who writes the file. Spec D7 wants a log the agent user cannot rewrite. On lab the root helper
// (bridge/operator-root-helper.mjs, Lot 2) owns /var/log/memo-operator/audit.jsonl (root, 0600)
// and appends on the agent's behalf: the agent sends the fields over the helper's socket
// (helperAuditChain below) and can add lines, never change or remove one. On the Mac (no root,
// spec non-goals) the agent appends to its own file, which the owner's account can rewrite;
// operator_audit_verify still reports an edit that does not recompute the whole tail, and the
// hub anchors the head every 15 min (bridge/hub.mjs), so a rewrite of anchored lines shows.
import { appendFileSync, closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { canonicalJson } from './operator-signing.mjs';
import { redactDeep, sha256Hex } from './operator-output.mjs';

export const GENESIS = '0'.repeat(64);
const MAX_ARG_CHARS = 256;
const MAX_AUDIT_READ_BYTES = 64 * 1024 * 1024;

export const lineHash = line => sha256Hex(canonicalJson(Object.fromEntries(Object.entries(line).filter(([k]) => k !== 'hash'))));

// Arguments as the journal keeps them: redacted, each string cut, content-like keys hashed.
export function journalArgs(args) {
  const { value } = redactDeep(args ?? {});
  const cut = v => {
    if (typeof v === 'string') return v.length > MAX_ARG_CHARS ? `${v.slice(0, MAX_ARG_CHARS)}...[${v.length} chars]` : v;
    if (Array.isArray(v)) return v.slice(0, 32).map(cut);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 32).map(([k, item]) => [k, cut(item)]));
    return v;
  };
  return cut(value);
}

// Default file sink: append-only, created 0600. read() returns the whole text (bounded).
export function fileAuditStore(path) {
  return Object.freeze({
    append(text) { appendFileSync(path, text, { mode: 0o600, flag: 'a' }); },
    read() {
      let fd;
      try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch (error) {
        if (error?.code === 'ENOENT') return '';
        throw error;
      }
      try {
        const size = Math.min(fstatSync(fd).size, MAX_AUDIT_READ_BYTES);
        const buf = Buffer.alloc(size);
        let at = 0;
        while (at < size) { const n = readSync(fd, buf, at, size - at, at); if (n === 0) break; at += n; }
        return buf.subarray(0, at).toString('utf8');
      } finally { closeSync(fd); }
    }
  });
}

// In-memory sink (tests, and the hub's view of a chain).
export function memoryAuditStore(initial = '') {
  let text = initial;
  return { append(chunk) { text += chunk; }, read() { return text; }, set(value) { text = value; } };
}

// Recompute a chain. Returns {ok, lines, head, first_broken_line?, reason?}; line numbers are
// 1-based. A trailing partial line (a crash mid-append) is reported as broken, not skipped.
export function verifyChain(text) {
  const raw = text === '' ? [] : text.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  let prev = GENESIS;
  for (let i = 0; i < raw.length; i++) {
    let line;
    try { line = JSON.parse(raw[i]); } catch { return { ok: false, lines: raw.length, head: prev, first_broken_line: i + 1, reason: 'unparsable' }; }
    if (!line || typeof line !== 'object' || Array.isArray(line)) return { ok: false, lines: raw.length, head: prev, first_broken_line: i + 1, reason: 'unparsable' };
    if (line.seq !== i + 1) return { ok: false, lines: raw.length, head: prev, first_broken_line: i + 1, reason: 'sequence' };
    if (line.prev !== prev) return { ok: false, lines: raw.length, head: prev, first_broken_line: i + 1, reason: 'prev_mismatch' };
    if (line.hash !== lineHash(line)) return { ok: false, lines: raw.length, head: prev, first_broken_line: i + 1, reason: 'hash_mismatch' };
    prev = line.hash;
  }
  return { ok: true, lines: raw.length, head: prev };
}

// The agent's journal. store: {append(text), read()}. On creation the existing chain is read
// once to find its head; a broken chain is not repaired: new lines continue from the last good
// head and operator_audit_verify keeps reporting the break.
export function createAuditChain({ store, now = Date.now } = {}) {
  if (typeof store?.append !== 'function' || typeof store?.read !== 'function') throw new Error('audit store required');
  const existing = verifyChain(store.read());
  let prev = existing.head;
  let seq = existing.ok ? existing.lines : existing.first_broken_line - 1;
  // A broken chain: the next seq continues after every line present, so the break stays visible.
  if (!existing.ok) seq = existing.lines;
  return Object.freeze({
    get head() { return prev; },
    get seq() { return seq; },
    // fields: {request_id, ref, op, tier, principal, args, args_sha256, outcome, code, ms, output}
    append(fields) {
      const line = {
        seq: seq + 1, at: new Date(now()).toISOString(), prev, source: fields.source ?? 'agent',
        request_id: fields.request_id ?? null, ref: fields.ref ?? null, op: fields.op, tier: fields.tier ?? null,
        principal: fields.principal ?? null, args_sha256: fields.args_sha256 ?? null, args: journalArgs(fields.args),
        approval: fields.approval ?? null,
        outcome: fields.outcome, code: fields.code ?? null, ms: fields.ms ?? null,
        output_sha256: fields.output === undefined ? null : sha256Hex(fields.output)
      };
      line.hash = lineHash(line);
      store.append(`${JSON.stringify(line)}\n`);
      seq = line.seq; prev = line.hash;
      return { seq: line.seq, hash: line.hash };
    },
    verify() { return verifyChain(store.read()); },
    // For anchoring (bridge/hub.mjs): the current head and the hash of line `since`.
    headInfo(since) { return headInfoOf(store.read(), since); }
  });
}

export function headInfoOf(text, since) {
  const v = verifyChain(text);
  let at = null;
  if (Number.isInteger(since) && since > 0) {
    const line = text.split('\n')[since - 1];
    try { at = { seq: since, hash: JSON.parse(line).hash ?? null }; } catch { at = { seq: since, hash: null }; }
  }
  return { chain_ok: v.ok, seq: v.lines, head: v.head, at, ...(v.ok ? {} : { first_broken_line: v.first_broken_line }) };
}

// The agent's view of a chain the root helper owns: every call goes over the helper's socket
// (client: bridge/operator-root-helper.mjs createRootHelperClient). Async.
export function helperAuditChain(client) {
  return Object.freeze({
    async append(fields) {
      const out = await client.request({ type: 'audit_append', fields });
      if (!out?.ok) throw new Error('audit_unavailable');
      return out;
    },
    async verify() {
      const out = await client.request({ type: 'audit_verify' });
      if (!out?.ok) throw new Error('audit_unavailable');
      return out.verify;
    },
    async headInfo(since) {
      const out = await client.request({ type: 'audit_head', since_seq: since ?? null });
      if (!out?.ok) throw new Error('audit_unavailable');
      return out.head;
    }
  });
}
